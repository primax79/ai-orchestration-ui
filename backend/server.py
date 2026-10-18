#!/usr/bin/env python3
"""server.py — Local HTTP & WebSocket Backend for the AI Orchestration Control Plane.

Exposes REST & WebSocket APIs over `ai-orchestration`'s deterministic CLI (`bin/ai-orch`),
enabling the Web UI and VS Code Extension Webview to:
  1. Manage the task backlog (overview, Kanban, task editor, state transitions, index sync)
  2. Install skills & MCP servers across Kilo, Claude, and Codex
  3. Inspect environment health and skill drift across assistants
  4. Configure orchestration.toml and sync AGENTS.md

Zero proprietary database: the repository's `tasks/` and config files remain the single source of truth.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import signal
import sys
import tempfile
from typing import Any, AsyncGenerator
from urllib.parse import parse_qs

from starlette.applications import Starlette
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocket, WebSocketDisconnect

UI_ROOT = pathlib.Path(__file__).resolve().parent.parent


def get_ai_orch_bin() -> pathlib.Path:
    if "AI_ORCH_BIN" in os.environ and os.environ["AI_ORCH_BIN"].strip():
        return pathlib.Path(os.environ["AI_ORCH_BIN"]).expanduser().resolve()
    sibling = UI_ROOT.parent / "ai-orchestration" / "bin" / "ai-orch"
    if sibling.is_file():
        return sibling
    for parent in UI_ROOT.parents:
        cand = parent / "ai-orchestration" / "bin" / "ai-orch"
        if cand.is_file():
            return cand
    return sibling


def get_config_dir() -> pathlib.Path:
    if "AI_ORCH_CONFIG_DIR" in os.environ and os.environ["AI_ORCH_CONFIG_DIR"].strip():
        return pathlib.Path(os.environ["AI_ORCH_CONFIG_DIR"]).expanduser().resolve()
    if "AI_ORCH_HOME" in os.environ and os.environ["AI_ORCH_HOME"].strip():
        return (pathlib.Path(os.environ["AI_ORCH_HOME"]).expanduser() / ".config" / "ai-orchestration").resolve()
    return pathlib.Path.home() / ".config" / "ai-orchestration"


def get_ai_orch_home() -> pathlib.Path | None:
    if "AI_ORCH_HOME" in os.environ and os.environ["AI_ORCH_HOME"].strip():
        return pathlib.Path(os.environ["AI_ORCH_HOME"]).expanduser().resolve()
    return None


def get_initial_workspace() -> pathlib.Path:
    if "AI_ORCH_WORKSPACE" in os.environ and os.environ["AI_ORCH_WORKSPACE"].strip():
        return pathlib.Path(os.environ["AI_ORCH_WORKSPACE"]).expanduser().resolve()
    return pathlib.Path.cwd().resolve()


def get_or_create_token() -> str:
    config_dir = get_config_dir()
    token_file = config_dir / "ui-token"
    if token_file.is_file():
        try:
            token = token_file.read_text(encoding="utf-8").strip()
            if token:
                return token
        except Exception:
            pass

    config_dir.mkdir(parents=True, exist_ok=True)
    raw_token = secrets.token_urlsafe(32)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(str(token_file), flags, 0o600)
    try:
        with open(fd, "w", encoding="utf-8") as f:
            f.write(raw_token)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    try:
        token_file.chmod(0o600)
    except Exception:
        pass
    return raw_token


def is_host_allowed(host_header: str | None, scope: Scope) -> bool:
    if not host_header:
        return False
    host = host_header.strip().lower()

    env_allowed = os.environ.get("AI_ORCH_ALLOWED_HOSTS")
    if env_allowed is not None:
        allowed = {h.strip().lower() for h in env_allowed.split(",") if h.strip()}
        return host in allowed

    server_port = None
    server_info = scope.get("server")
    if server_info and len(server_info) > 1 and server_info[1]:
        server_port = str(server_info[1])

    port = os.environ.get("PORT") or server_port or "8780"
    allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
    if server_port and server_port != port:
        allowed.add(f"127.0.0.1:{server_port}")
        allowed.add(f"localhost:{server_port}")

    return host in allowed


class AuthAndHostMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = dict(scope.get("headers", []))
            host_header = headers.get(b"host", b"").decode("latin1")
            if not is_host_allowed(host_header, scope):
                response = Response("Invalid Host header", status_code=400)
                await response(scope, receive, send)
                return

            path = scope.get("path", "")
            if path == "/api" or path.startswith("/api/"):
                expected_token = get_or_create_token()
                token_hdr = headers.get(b"x-ai-orch-token", b"").decode("latin1")
                if not token_hdr or not hmac.compare_digest(token_hdr, expected_token):
                    response = JSONResponse({"error": "unauthorized"}, status_code=401)
                    await response(scope, receive, send)
                    return

            await self.app(scope, receive, send)

        elif scope["type"] == "websocket":
            headers = dict(scope.get("headers", []))
            host_header = headers.get(b"host", b"").decode("latin1")
            if not is_host_allowed(host_header, scope):
                await send({"type": "websocket.close", "code": 4400, "reason": "Invalid Host header"})
                return

            qs = parse_qs(scope.get("query_string", b"").decode("latin1"))
            token = qs.get("token", [""])[0]
            expected_token = get_or_create_token()
            if not token or not hmac.compare_digest(token, expected_token):
                await send({"type": "websocket.close", "code": 4401, "reason": "unauthorized"})
                return

            await self.app(scope, receive, send)
        else:
            await self.app(scope, receive, send)


class OrchestrationState:
    def __init__(self, workspace: pathlib.Path):
        self.workspace = workspace.resolve()
        self.active_websockets: set[WebSocket] = set()
        self.watcher_task: asyncio.Task | None = None

    async def broadcast(self, message: dict[str, Any]) -> None:
        stale = set()
        for ws in list(self.active_websockets):
            try:
                await ws.send_json(message)
            except Exception:
                stale.add(ws)
        self.active_websockets.difference_update(stale)


state = OrchestrationState(get_initial_workspace())


async def _cleanup_process_group(proc: asyncio.subprocess.Process) -> None:
    """Terminate the process group of proc (SIGTERM, then SIGKILL after 5s), drain pipes, and await completion."""
    pgid = proc.pid
    try:
        if hasattr(os, "killpg"):
            os.killpg(pgid, signal.SIGTERM)
        else:
            proc.terminate()
    except (ProcessLookupError, OSError):
        pass

    try:
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except (asyncio.TimeoutError, TimeoutError):
        try:
            if hasattr(os, "killpg"):
                os.killpg(pgid, signal.SIGKILL)
            else:
                proc.kill()
        except (ProcessLookupError, OSError):
            pass
        try:
            await proc.wait()
        except Exception:
            pass

    # Always drain/close pipes and await proc.wait() so no zombie remains
    if proc.stdout:
        try:
            while not proc.stdout.at_eof():
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
        except Exception:
            pass

    if proc.stderr:
        try:
            while not proc.stderr.at_eof():
                chunk = await proc.stderr.read(65536)
                if not chunk:
                    break
        except Exception:
            pass

    if proc._transport and not proc._transport.is_closing():
        try:
            proc._transport.close()
        except Exception:
            pass

    try:
        await proc.wait()
    except Exception:
        pass


# Guards against CLI process bursts (several panels polling the same list): identical
# read-only calls already in flight share one process, and at most MAX_CLI_PROCESSES run.
MAX_CLI_PROCESSES = 4
_READ_ONLY_PREFIXES = {
    ("tasks", "list"), ("tasks", "validate"), ("tasks", "graph"), ("questions", "list"), ("questions", "show"),
    ("inbox", "list"), ("inbox", "show"), ("config", "show"), ("env", "status"),
    ("run", "list"), ("run", "show"), ("run", "logs"), ("run", "options"),
    ("use-cases", "list"), ("use-cases", "show"),
}
# Per event loop: asyncio primitives cannot be shared across loops (tests run several).
_cli_semaphores: dict[int, asyncio.Semaphore] = {}
_inflight_reads: dict[tuple[Any, ...], asyncio.Future] = {}


def _is_read_only(args: list[str]) -> bool:
    if any(a in ("--check", "--dry-run", "--diff") for a in args):
        return True
    return tuple(args[:2]) in _READ_ONLY_PREFIXES


async def run_ai_orch(args: list[str], timeout: float | None = None) -> tuple[int, dict[str, Any] | str]:
    """Run the CLI with the process guards; see _run_ai_orch_process for the execution."""
    loop_id = id(asyncio.get_running_loop())
    sem = _cli_semaphores.get(loop_id)
    if sem is None:
        sem = _cli_semaphores[loop_id] = asyncio.Semaphore(MAX_CLI_PROCESSES)

    async def run_limited() -> tuple[int, dict[str, Any] | str]:
        async with sem:
            return await _run_ai_orch_process(args, timeout)

    if not _is_read_only(args):
        return await run_limited()
    key = (loop_id, *args, f"timeout={timeout}")
    existing = _inflight_reads.get(key)
    if existing is not None:
        return await asyncio.shield(existing)
    fut: asyncio.Future = asyncio.ensure_future(run_limited())
    _inflight_reads[key] = fut
    try:
        return await asyncio.shield(fut)
    finally:
        if _inflight_reads.get(key) is fut and fut.done():
            _inflight_reads.pop(key, None)
        else:
            fut.add_done_callback(lambda _f, k=key: _inflight_reads.pop(k, None) if _inflight_reads.get(k) is _f else None)


async def _run_ai_orch_process(args: list[str], timeout: float | None = None) -> tuple[int, dict[str, Any] | str]:
    """Execute `./bin/ai-orch <args...>` asynchronously and return (exit_code, parsed_json_or_text)."""
    bin_path = get_ai_orch_bin()
    if not bin_path.is_file():
        return 1, f"ai-orch CLI not found at {bin_path}"

    cmd_args = list(args)
    if cmd_args and cmd_args[0] == "env":
        home = get_ai_orch_home()
        if home and "--home" not in cmd_args:
            cmd_args = ["env", "--home", str(home), *cmd_args[1:]]
    elif cmd_args and cmd_args[0] in ("run", "config", "render-agents-md"):
        # Every command that reads or writes the global config must honour the override,
        # otherwise a scratch/test server would edit the real ~/.config/ai-orchestration file.
        global_cfg = os.environ.get("AI_ORCH_GLOBAL_CONFIG", "").strip()
        if global_cfg and "--global-config" not in cmd_args:
            if cmd_args[0] == "run":
                cmd_args = ["run", "--global-config", global_cfg, *cmd_args[1:]]
            else:
                cmd_args = [*cmd_args, "--global-config", global_cfg]

    if os.access(bin_path, os.X_OK):
        cmd = [str(bin_path), *cmd_args]
    else:
        cmd = [sys.executable, str(bin_path), *cmd_args]

    if timeout is None:
        if any(action in cmd_args for action in ("install-skills", "register-mcp")):
            timeout = 600.0
        else:
            timeout = 60.0

    env = dict(os.environ)
    if "AI_ORCHESTRATION_CONFIG" not in env:
        env["AI_ORCHESTRATION_CONFIG"] = str(get_config_dir() / "orchestration.toml")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
            env=env,
        )
    except Exception as exc:
        return 1, f"Failed to execute CLI command: {exc}"

    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except (asyncio.TimeoutError, TimeoutError):
        await _cleanup_process_group(proc)
        return 504, {"error": f"CLI command timed out after {timeout} seconds"}
    except asyncio.CancelledError:
        await asyncio.shield(_cleanup_process_group(proc))
        raise

    out = stdout_bytes.decode("utf-8", errors="replace").strip()
    err = stderr_bytes.decode("utf-8", errors="replace").strip()
    try:
        parsed = json.loads(out) if out else {}
        return proc.returncode, parsed
    except Exception:
        return proc.returncode, out or err


def map_cli_status(code: int, data: Any, default_error_status: int = 500) -> int:
    """Map CLI exit codes and output errors to HTTP status codes."""
    if code == 0:
        return 200
    if code == 504:
        return 504

    err_str = ""
    if isinstance(data, dict):
        reason = str(data.get("reason") or "").lower()
        err_val = f"{data.get('error', '')} {data.get('message', '')}".lower()
        if data.get("error") in (
            "stale-task",
            "stale-task-hash",
            "lock-timeout",
            "stale-note",
            "plan-hash-mismatch",
            "task-hash-mismatch",
        ) or reason in (
            "stale-task",
            "stale-task-hash",
            "stale-note",
            "stale-note-hash",
            "note-hash-mismatch",
            "lock-timeout",
            "plan-hash-mismatch",
            "task-hash-mismatch",
            "task-bundle-hash-drift",
            "target-branch-head-drift",
            "target-head-drift",
            "same-task-active",
            "active-chain-run",
        ):
            return 409
        if data.get("error") in (
            "invalid-image-type",
            "invalid-pdf-type",
            "invalid-text-type",
            "invalid-attachment-type",
        ) or reason in (
            "invalid-image-type",
            "invalid-pdf-type",
            "invalid-text-type",
            "invalid-attachment-type",
        ):
            return 415
        if data.get("error") == "size-limit-exceeded" or reason == "size-limit-exceeded":
            return 413
        err_str = f"{reason} {err_val}"
    elif isinstance(data, str):
        err_str = data.lower()

    if (
        "hash mismatch" in err_str
        or "plan hash mismatch" in err_str
        or "stale" in err_str
        or "stale-note" in err_str
        or "stale-task-hash" in err_str
        or "lock-timeout" in err_str
        or "task-write lock" in err_str
        or "timed out waiting for task-write lock" in err_str
        or "refusing to apply" in err_str
        or "workspace has no project config" in err_str
        or "no project config" in err_str
        or "drift" in err_str
        or "has changed" in err_str
        or "same-task-active" in err_str
        or "already has an active run" in err_str
        or "active-chain-run" in err_str
        or "references the same worktree" in err_str
    ):
        return 409

    if (
        "invalid-image-type" in err_str
        or "invalid-pdf-type" in err_str
        or "invalid-text-type" in err_str
        or "invalid-attachment-type" in err_str
        or "magic bytes do not match" in err_str
        or "unsupported attachment type" in err_str
    ):
        return 415

    if "size-limit-exceeded" in err_str:
        return 413

    if (
        "required" in err_str
        or "invalid" in err_str
        or "unknown" in err_str
        or "unrecognized" in err_str
        or "not found" in err_str
        or "validation" in err_str
        or "illegal transition" in err_str
        or "cannot transition" in err_str
        or "waiting invariant" in err_str
        or "must end with" in err_str
        or "exceeds 160" in err_str
        or "single line" in err_str
        or "cannot cancel run in terminal state" in err_str
        or "cannot clean up run" in err_str
        or "proposal" in err_str
        or "not-triage-run" in err_str
        or "cycle" in err_str
        or "run-not-terminal" in err_str
        or "plan tasks do not support attachments" in err_str
        or "plan-task-attachments-unsupported" in err_str
        or "attachment-limit-reached" in err_str
        or "derived state" in err_str
    ):
        return 400

    return default_error_status


# ---------------------------------------------------------------------------
# Static Serving & SPA Fallback with Meta Tag Injection and CSP
# ---------------------------------------------------------------------------

dist_dir = UI_ROOT / "frontend" / "dist"

CSP_HEADER = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "connect-src 'self' ws://127.0.0.1:* ws://localhost:*; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "frame-ancestors 'none'"
)


async def serve_index(request: Request) -> Response:
    dist_index = dist_dir / "index.html"
    raw_index = UI_ROOT / "frontend" / "index.html"
    index_path = dist_index if dist_index.is_file() else raw_index
    if not index_path.is_file():
        return Response("index.html not found", status_code=404)

    content = index_path.read_text(encoding="utf-8")
    token = get_or_create_token()
    meta_tag = f'<meta name="ai-orch-token" content="{token}">'

    content = re.sub(r'<meta\s+name=["\']ai-orch-token["\'][^>]*>', '', content)
    if "<head>" in content:
        content = content.replace("<head>", f"<head>\n    {meta_tag}", 1)
    elif "<HEAD>" in content:
        content = content.replace("<HEAD>", f"<HEAD>\n    {meta_tag}", 1)
    else:
        content = f"{meta_tag}\n{content}"

    return HTMLResponse(
        content,
        headers={
            "Cache-Control": "no-store",
            "Content-Security-Policy": CSP_HEADER,
        },
    )


class SPAStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: Scope) -> Response:
        full_path = scope.get("path", "")
        if full_path.startswith("/api/") or full_path == "/api":
            return JSONResponse({"error": "Not Found"}, status_code=404)
        if path in ("", "index.html"):
            return await serve_index(Request(scope))
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code == 404:
                return await serve_index(Request(scope))
            raise


# ---------------------------------------------------------------------------
# Watcher Background Task
# ---------------------------------------------------------------------------

def snapshot_watched_files(workspace: pathlib.Path, config_dir: pathlib.Path) -> dict[str, float]:
    mtimes: dict[str, float] = {}

    global_cfg = config_dir / "orchestration.toml"
    try:
        if global_cfg.is_file():
            mtimes[f"config:{global_cfg}"] = global_cfg.stat().st_mtime
    except OSError:
        pass

    local_cfg = workspace / ".ai-orchestration.local.toml"
    try:
        if local_cfg.is_file():
            mtimes[f"config:{local_cfg}"] = local_cfg.stat().st_mtime
    except OSError:
        pass

    tasks_dir = workspace / "tasks"
    if tasks_dir.is_dir():
        try:
            mtimes[f"tasks:{tasks_dir}"] = tasks_dir.stat().st_mtime
            questions_dir = tasks_dir / "questions"
            if questions_dir.is_dir():
                mtimes[f"questions:{questions_dir}"] = questions_dir.stat().st_mtime
            inbox_dir = tasks_dir / "_inbox"
            if inbox_dir.is_dir():
                mtimes[f"inbox:{inbox_dir}"] = inbox_dir.stat().st_mtime
                for p in inbox_dir.rglob("*"):
                    try:
                        mtimes[f"inbox:{p}"] = p.stat().st_mtime
                    except OSError:
                        pass
            for p in tasks_dir.rglob("*.md"):
                try:
                    if p.is_file():
                        if "questions" in p.parts:
                            mtimes[f"questions:{p}"] = p.stat().st_mtime
                        elif "_inbox" in p.parts:
                            pass
                        else:
                            mtimes[f"tasks:{p}"] = p.stat().st_mtime
                except OSError:
                    pass
        except OSError:
            pass

    runs_dir = workspace / ".ai-orchestration" / "runs"
    if runs_dir.is_dir():
        try:
            mtimes[f"runs:{runs_dir}"] = runs_dir.stat().st_mtime
            for p in runs_dir.iterdir():
                try:
                    if p.is_dir():
                        run_json = p / "run.json"
                        if run_json.is_file():
                            mtimes[f"runs:{run_json}"] = run_json.stat().st_mtime
                except OSError:
                    pass
        except OSError:
            pass

    return mtimes


async def _polling_watcher_loop() -> None:
    poll_interval = float(os.environ.get("AI_ORCH_WATCH_INTERVAL", "1.0"))
    last_snapshot = snapshot_watched_files(state.workspace, get_config_dir())

    while True:
        try:
            await asyncio.sleep(poll_interval)
            current_snapshot = snapshot_watched_files(state.workspace, get_config_dir())

            changed_areas: set[str] = set()
            all_keys = set(last_snapshot.keys()) | set(current_snapshot.keys())
            for k in all_keys:
                if last_snapshot.get(k) != current_snapshot.get(k):
                    if k.startswith("config:"):
                        changed_areas.add("config")
                    elif k.startswith("questions:"):
                        changed_areas.add("questions")
                        changed_areas.add("tasks")
                    elif k.startswith("inbox:"):
                        changed_areas.add("inbox")
                    elif k.startswith("tasks:"):
                        changed_areas.add("tasks")
                    elif k.startswith("runs:"):
                        changed_areas.add("runs")

            if changed_areas:
                await asyncio.sleep(0.3)
                debounce_snapshot = snapshot_watched_files(state.workspace, get_config_dir())
                for k in set(debounce_snapshot.keys()) | set(current_snapshot.keys()):
                    if debounce_snapshot.get(k) != current_snapshot.get(k):
                        if k.startswith("config:"):
                            changed_areas.add("config")
                        elif k.startswith("questions:"):
                            changed_areas.add("questions")
                            changed_areas.add("tasks")
                        elif k.startswith("inbox:"):
                            changed_areas.add("inbox")
                        elif k.startswith("tasks:"):
                            changed_areas.add("tasks")
                        elif k.startswith("runs:"):
                            changed_areas.add("runs")
                last_snapshot = debounce_snapshot
                await state.broadcast({"type": "changed", "areas": sorted(list(changed_areas))})
            else:
                last_snapshot = current_snapshot
        except asyncio.CancelledError:
            break
        except Exception:
            await asyncio.sleep(1.0)


async def _watchfiles_watcher_loop() -> None:
    import watchfiles

    config_dir = get_config_dir()
    watch_dirs = [state.workspace]
    if config_dir != state.workspace and config_dir.exists():
        watch_dirs.append(config_dir)

    async for changes in watchfiles.awatch(*[str(d) for d in watch_dirs], debounce=300):
        areas: set[str] = set()
        for _, path_str in changes:
            p = pathlib.Path(path_str)
            if p.name in ("orchestration.toml", ".ai-orchestration.local.toml"):
                areas.add("config")
            elif "tasks" in p.parts:
                if "questions" in p.parts:
                    areas.add("questions")
                    areas.add("tasks")
                elif "_inbox" in p.parts:
                    areas.add("inbox")
                elif p.suffix == ".md" or p == (state.workspace / "tasks"):
                    areas.add("tasks")
            elif ".ai-orchestration" in p.parts and "runs" in p.parts and (p.name == "run.json" or p.name == "runs"):
                areas.add("runs")
        if areas:
            await state.broadcast({"type": "changed", "areas": sorted(list(areas))})


async def watcher_loop() -> None:
    use_polling = os.environ.get("AI_ORCH_WATCH_POLLING") == "1"
    if not use_polling:
        try:
            import watchfiles  # noqa: F401
            await _watchfiles_watcher_loop()
            return
        except ImportError:
            pass
        except Exception:
            pass
    await _polling_watcher_loop()


@asynccontextmanager
async def lifespan(app: Starlette) -> AsyncGenerator[None, None]:
    state.watcher_task = asyncio.create_task(watcher_loop())
    try:
        yield
    finally:
        if state.watcher_task:
            state.watcher_task.cancel()
            try:
                await state.watcher_task
            except asyncio.CancelledError:
                pass
            state.watcher_task = None


# ---------------------------------------------------------------------------
# REST Endpoints: Workspace
# ---------------------------------------------------------------------------

async def api_get_workspace(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    has_tasks = tasks_dir.is_dir()
    return JSONResponse({
        "workspace_path": str(state.workspace),
        "workspace_name": state.workspace.name,
        "has_tasks_dir": has_tasks,
        "tasks_path": str(tasks_dir) if has_tasks else None,
    })


# ---------------------------------------------------------------------------
# REST Endpoints: Macro 1 — Backlog & Tasks
# ---------------------------------------------------------------------------

async def api_list_tasks(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    if not tasks_dir.is_dir():
        return JSONResponse({"tasks": [], "initiatives": [], "stats": {"total": 0}, "message": "No tasks/ directory in current workspace"})
    cmd = ["tasks", "list", "--tasks-dir", str(tasks_dir), "--json"]
    for k in request.query_params.getlist("kind"):
        for sub_k in k.split(","):
            if sub_k.strip():
                cmd.extend(["--kind", sub_k.strip()])
    for l in request.query_params.getlist("label"):
        for sub_l in l.split(","):
            if sub_l.strip():
                cmd.extend(["--label", sub_l.strip()])
    code, data = await run_ai_orch(cmd)
    if code != 0:
        return JSONResponse({"error": data} if not isinstance(data, dict) else data, status_code=504 if code == 504 else 500)
    return JSONResponse(data)


async def api_validate_tasks(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    code, data = await run_ai_orch(["tasks", "validate", "--tasks-dir", str(tasks_dir), "--json"])
    status_code = 504 if code == 504 else (200 if code == 0 else 400)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


TASK_MUTATION_ID_RE = re.compile(r"^(T\d{3,}(\.\d+)*|\d{2,}(\.\d+)*)$")
VALID_PRIORITIES = {"P0", "P1", "P2", "P3"}
VALID_SIZES = {"XS", "S", "M", "L", "XL"}
VALID_KINDS = {"bug", "chore", "docs", "feature", "fix", "investigation"}
LABEL_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
MICRO_ID_RE = re.compile(r"^T\d{3,}$")


def _extract_dep_ids(val: Any) -> list[str]:
    if not val:
        return []
    if isinstance(val, list):
        items = []
        for x in val:
            if isinstance(x, str):
                items.extend([p.strip() for p in re.split(r"[\s,]+", x.strip()) if p.strip()])
            elif x is not None:
                items.append(str(x).strip())
        return items
    if isinstance(val, str):
        return [p.strip() for p in re.split(r"[\s,]+", val.strip()) if p.strip()]
    return []


async def _resolve_current_task_hash(tasks_dir: pathlib.Path, task_id: str) -> str | None:
    probe_code, probe_data = await run_ai_orch([
        "tasks", "set-priority", task_id, "P2",
        "--tasks-dir", str(tasks_dir),
        "--dry-run",
        "--expect-task-hash", "__probe_hash__",
        "--json",
    ])
    err_text = ""
    if isinstance(probe_data, dict):
        err_text = str(probe_data.get("error") or "")
    elif isinstance(probe_data, str):
        err_text = probe_data
    m = re.search(r"actual\s+([0-9a-fA-F]{64})", err_text)
    if m:
        return m.group(1)
    return None


async def api_get_tasks_graph(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    if not tasks_dir.is_dir():
        return JSONResponse({"ok": True, "nodes": [], "nodes_by_id": {}, "edges": [], "columns": {}, "ready_queue": [], "heaviest_chain": [], "totals": {}}, status_code=200)
    cmd = ["tasks", "graph", "--tasks-dir", str(tasks_dir), "--json"]
    for k in request.query_params.getlist("kind"):
        for sub_k in k.split(","):
            if sub_k.strip():
                cmd.extend(["--kind", sub_k.strip()])
    for l in request.query_params.getlist("label"):
        for sub_l in l.split(","):
            if sub_l.strip():
                cmd.extend(["--label", sub_l.strip()])
    code, data = await run_ai_orch(cmd)
    if code == 504:
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=504)
    if code == 0 and isinstance(data, dict):
        return JSONResponse(data, status_code=200)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def _handle_set_priority(request: Request, is_preview: bool = False) -> JSONResponse:
    task_id = request.path_params.get("id") or request.path_params.get("task_id", "")
    if not TASK_MUTATION_ID_RE.match(task_id):
        return JSONResponse({"error": f"Invalid task id {task_id!r}"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    priority = str(body.get("priority") or "").strip().upper()
    if not priority:
        return JSONResponse({"error": "priority is required"}, status_code=400)
    if priority not in VALID_PRIORITIES:
        return JSONResponse({"error": f"Invalid priority {priority!r}, expected one of {', '.join(sorted(VALID_PRIORITIES))}"}, status_code=400)

    expect_task_hash = (
        body.get("expect_task_hash")
        or body.get("expect_hash")
        or request.query_params.get("expect_task_hash")
        or request.query_params.get("expect_hash")
        or request.headers.get("x-expect-task-hash")
    )
    if not is_preview and not expect_task_hash:
        return JSONResponse({"error": "expect_task_hash is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["tasks", "set-priority", task_id, priority, "--tasks-dir", str(tasks_dir), "--json"]
    if is_preview:
        cmd.append("--dry-run")
    if body.get("reason"):
        cmd.extend(["--reason", str(body["reason"])])
    if expect_task_hash:
        cmd.extend(["--expect-task-hash", str(expect_task_hash)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        if not is_preview:
            await state.broadcast({"type": "changed", "areas": ["tasks"]})
        else:
            if isinstance(data, dict):
                current_hash = expect_task_hash or await _resolve_current_task_hash(tasks_dir, task_id)
                if current_hash:
                    data["hash"] = current_hash
                    data["task_hash"] = current_hash
                    data["base_task_hash"] = current_hash
        return JSONResponse(data if isinstance(data, dict) else {"ok": True}, status_code=200)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_set_priority(request: Request) -> JSONResponse:
    return await _handle_set_priority(request, is_preview=True)


async def api_set_priority(request: Request) -> JSONResponse:
    return await _handle_set_priority(request, is_preview=False)


async def _handle_set_size(request: Request, is_preview: bool = False) -> JSONResponse:
    task_id = request.path_params.get("id") or request.path_params.get("task_id", "")
    if not TASK_MUTATION_ID_RE.match(task_id):
        return JSONResponse({"error": f"Invalid task id {task_id!r}"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    size = str(body.get("size") or "").strip().upper()
    if not size:
        return JSONResponse({"error": "size is required"}, status_code=400)
    if size not in VALID_SIZES:
        return JSONResponse({"error": f"Invalid size {size!r}, expected one of {', '.join(sorted(VALID_SIZES))}"}, status_code=400)

    expect_task_hash = (
        body.get("expect_task_hash")
        or body.get("expect_hash")
        or request.query_params.get("expect_task_hash")
        or request.query_params.get("expect_hash")
        or request.headers.get("x-expect-task-hash")
    )
    if not is_preview and not expect_task_hash:
        return JSONResponse({"error": "expect_task_hash is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["tasks", "set-size", task_id, size, "--tasks-dir", str(tasks_dir), "--json"]
    if is_preview:
        cmd.append("--dry-run")
    if expect_task_hash:
        cmd.extend(["--expect-task-hash", str(expect_task_hash)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        if not is_preview:
            await state.broadcast({"type": "changed", "areas": ["tasks"]})
        else:
            if isinstance(data, dict):
                current_hash = expect_task_hash or await _resolve_current_task_hash(tasks_dir, task_id)
                if current_hash:
                    data["hash"] = current_hash
                    data["task_hash"] = current_hash
                    data["base_task_hash"] = current_hash
        return JSONResponse(data if isinstance(data, dict) else {"ok": True}, status_code=200)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_set_size(request: Request) -> JSONResponse:
    return await _handle_set_size(request, is_preview=True)


async def api_set_size(request: Request) -> JSONResponse:
    return await _handle_set_size(request, is_preview=False)


async def _handle_set_deps(request: Request, is_preview: bool = False) -> JSONResponse:
    task_id = request.path_params.get("id") or request.path_params.get("task_id", "")
    if not TASK_MUTATION_ID_RE.match(task_id):
        return JSONResponse({"error": f"Invalid task id {task_id!r}"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    add_ids = _extract_dep_ids(body.get("add"))
    remove_ids = _extract_dep_ids(body.get("remove"))
    to_specified = body.get("to") is not None or body.get("deps") is not None
    to_ids = _extract_dep_ids(body.get("to") if body.get("to") is not None else body.get("deps"))

    if not add_ids and not remove_ids and not to_specified:
        return JSONResponse({"error": "at least one of add, remove, or to/deps is required"}, status_code=400)

    for did in add_ids + remove_ids + to_ids:
        if not TASK_MUTATION_ID_RE.match(did):
            return JSONResponse({"error": f"Invalid dependency id {did!r}"}, status_code=400)

    expect_task_hash = (
        body.get("expect_task_hash")
        or body.get("expect_hash")
        or request.query_params.get("expect_task_hash")
        or request.query_params.get("expect_hash")
        or request.headers.get("x-expect-task-hash")
    )
    if not is_preview and not expect_task_hash:
        return JSONResponse({"error": "expect_task_hash is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["tasks", "set-deps", task_id, "--tasks-dir", str(tasks_dir), "--json"]
    if add_ids:
        cmd.extend(["--add", *add_ids])
    if remove_ids:
        cmd.extend(["--remove", *remove_ids])
    if to_specified:
        cmd.extend(["--to", *to_ids])
    if is_preview:
        cmd.append("--dry-run")
    if expect_task_hash:
        cmd.extend(["--expect-task-hash", str(expect_task_hash)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        if not is_preview:
            await state.broadcast({"type": "changed", "areas": ["tasks"]})
        else:
            if isinstance(data, dict):
                current_hash = expect_task_hash or await _resolve_current_task_hash(tasks_dir, task_id)
                if current_hash:
                    data["hash"] = current_hash
                    data["task_hash"] = current_hash
                    data["base_task_hash"] = current_hash
        return JSONResponse(data if isinstance(data, dict) else {"ok": True}, status_code=200)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_set_deps(request: Request) -> JSONResponse:
    return await _handle_set_deps(request, is_preview=True)


async def api_set_deps(request: Request) -> JSONResponse:
    return await _handle_set_deps(request, is_preview=False)


# ---------------------------------------------------------------------------
# REST Endpoints: Kind & Labels (10.5)
# ---------------------------------------------------------------------------

async def _handle_set_kind(request: Request, is_preview: bool = False) -> JSONResponse:
    task_id = request.path_params.get("id") or request.path_params.get("task_id", "")
    if not TASK_MUTATION_ID_RE.match(task_id):
        return JSONResponse({"error": f"Invalid task id {task_id!r}"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    kind = str(body.get("kind") or "").strip().lower()
    if not kind:
        return JSONResponse({"error": "kind is required"}, status_code=400)
    if kind not in VALID_KINDS:
        return JSONResponse({"error": f"Invalid kind {kind!r}, expected one of {', '.join(sorted(VALID_KINDS))}"}, status_code=400)

    expect_task_hash = (
        body.get("expect_task_hash")
        or body.get("expect_hash")
        or request.query_params.get("expect_task_hash")
        or request.query_params.get("expect_hash")
        or request.headers.get("x-expect-task-hash")
    )
    if not is_preview and not expect_task_hash:
        return JSONResponse({"error": "expect_task_hash is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["tasks", "set-kind", task_id, kind, "--tasks-dir", str(tasks_dir), "--json"]
    if is_preview:
        cmd.append("--dry-run")
    if expect_task_hash:
        cmd.extend(["--expect-task-hash", str(expect_task_hash)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        if not is_preview:
            await state.broadcast({"type": "changed", "areas": ["tasks"]})
        else:
            if isinstance(data, dict):
                current_hash = expect_task_hash or await _resolve_current_task_hash(tasks_dir, task_id)
                if current_hash:
                    data["hash"] = current_hash
                    data["task_hash"] = current_hash
                    data["base_task_hash"] = current_hash
        return JSONResponse(data if isinstance(data, dict) else {"ok": True}, status_code=200)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_set_kind(request: Request) -> JSONResponse:
    return await _handle_set_kind(request, is_preview=True)


async def api_set_kind(request: Request) -> JSONResponse:
    return await _handle_set_kind(request, is_preview=False)


def _extract_labels(val: Any) -> list[str]:
    if not val:
        return []
    if isinstance(val, list):
        items = []
        for x in val:
            if isinstance(x, str):
                items.extend([p.strip().lower() for p in re.split(r"[\s,]+", x.strip()) if p.strip()])
            elif x is not None:
                items.append(str(x).strip().lower())
        return items
    if isinstance(val, str):
        return [p.strip().lower() for p in re.split(r"[\s,]+", val.strip()) if p.strip()]
    return []


async def _handle_set_labels(request: Request, is_preview: bool = False) -> JSONResponse:
    task_id = request.path_params.get("id") or request.path_params.get("task_id", "")
    if not TASK_MUTATION_ID_RE.match(task_id):
        return JSONResponse({"error": f"Invalid task id {task_id!r}"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    add_labels = _extract_labels(body.get("add"))
    remove_labels = _extract_labels(body.get("remove"))
    to_specified = body.get("to") is not None or body.get("labels") is not None
    to_labels = _extract_labels(body.get("to") if body.get("to") is not None else body.get("labels"))

    if not add_labels and not remove_labels and not to_specified:
        return JSONResponse({"error": "at least one of add, remove, or to/labels is required"}, status_code=400)

    for lbl in add_labels + remove_labels + to_labels:
        if not LABEL_RE.match(lbl):
            return JSONResponse({"error": f"Invalid label format {lbl!r}, must match ^[a-z0-9][a-z0-9-]{{0,23}}$"}, status_code=400)

    expect_task_hash = (
        body.get("expect_task_hash")
        or body.get("expect_hash")
        or request.query_params.get("expect_task_hash")
        or request.query_params.get("expect_hash")
        or request.headers.get("x-expect-task-hash")
    )
    if not is_preview and not expect_task_hash:
        return JSONResponse({"error": "expect_task_hash is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["tasks", "set-labels", task_id, "--tasks-dir", str(tasks_dir), "--json"]
    if add_labels:
        cmd.extend(["--add", *add_labels])
    if remove_labels:
        cmd.extend(["--remove", *remove_labels])
    if to_specified:
        cmd.extend(["--to", *to_labels])
    if is_preview:
        cmd.append("--dry-run")
    if expect_task_hash:
        cmd.extend(["--expect-task-hash", str(expect_task_hash)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        if not is_preview:
            await state.broadcast({"type": "changed", "areas": ["tasks"]})
        else:
            if isinstance(data, dict):
                current_hash = expect_task_hash or await _resolve_current_task_hash(tasks_dir, task_id)
                if current_hash:
                    data["hash"] = current_hash
                    data["task_hash"] = current_hash
                    data["base_task_hash"] = current_hash
        return JSONResponse(data if isinstance(data, dict) else {"ok": True}, status_code=200)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_set_labels(request: Request) -> JSONResponse:
    return await _handle_set_labels(request, is_preview=True)


async def api_set_labels(request: Request) -> JSONResponse:
    return await _handle_set_labels(request, is_preview=False)


async def api_list_labels(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    if not tasks_dir.is_dir():
        return JSONResponse({"ok": True, "tasks_dir": str(tasks_dir), "labels": [], "counts": {}}, status_code=200)
    code, data = await run_ai_orch(["tasks", "labels", "--tasks-dir", str(tasks_dir), "--json"])
    if code == 504:
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=504)
    if code == 0 and isinstance(data, dict):
        return JSONResponse(data, status_code=200)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


# ---------------------------------------------------------------------------
# REST Endpoints: Microtasks & Promote (10.5)
# ---------------------------------------------------------------------------

async def api_create_microtask(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}

    title = str(body.get("title") or "").strip()
    if not title:
        return JSONResponse({"error": "title is required"}, status_code=400)

    kind = str(body.get("kind") or "chore").strip().lower()
    if kind not in VALID_KINDS:
        return JSONResponse({"error": f"Invalid kind {kind!r}, expected one of {', '.join(sorted(VALID_KINDS))}"}, status_code=400)

    priority = str(body.get("priority") or "P2").strip().upper()
    if priority not in VALID_PRIORITIES:
        return JSONResponse({"error": f"Invalid priority {priority!r}, expected one of {', '.join(sorted(VALID_PRIORITIES))}"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = [
        "tasks", "micro",
        "--title", title,
        "--kind", kind,
        "--priority", priority,
        "--tasks-dir", str(tasks_dir),
        "--json",
    ]
    if body.get("paths"):
        cmd.extend(["--paths", str(body["paths"])])
    if body.get("depends_on"):
        cmd.extend(["--depends-on", str(body["depends_on"])])
    if body.get("size"):
        sz = str(body["size"]).strip().upper()
        if sz not in VALID_SIZES:
            return JSONResponse({"error": f"Invalid size {sz!r}"}, status_code=400)
        cmd.extend(["--size", sz])
    if body.get("executor"):
        cmd.extend(["--executor", str(body["executor"])])
    if body.get("what"):
        cmd.extend(["--what", str(body["what"])])

    labels = _extract_labels(body.get("labels") or body.get("label"))
    for lbl in labels:
        if not LABEL_RE.match(lbl):
            return JSONResponse({"error": f"Invalid label format {lbl!r}"}, status_code=400)
        cmd.extend(["--label", lbl])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "changed", "areas": ["tasks"]})
        task_id = data.get("id") if isinstance(data, dict) else None
        if task_id:
            await state.broadcast({"type": "task_created", "task_id": task_id})
        return JSONResponse(data if isinstance(data, dict) else {"ok": True}, status_code=201)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def _handle_promote(request: Request, is_preview: bool = False) -> JSONResponse:
    task_id = request.path_params.get("id") or request.path_params.get("task_id", "")
    if not MICRO_ID_RE.match(task_id):
        return JSONResponse({"error": f"Invalid microtask id {task_id!r}"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    category = str(body.get("category") or "maintenance").strip()
    if not category:
        category = "maintenance"

    tasks_dir = state.workspace / "tasks"
    target_file = None
    for pdir in (tasks_dir / "micro", tasks_dir / "done" / "micro"):
        if pdir.is_dir():
            for f in pdir.glob("*.md"):
                if f.name.startswith(f"{task_id}-") and f.name != "README.md":
                    target_file = f
                    break
        if target_file:
            break

    if not target_file:
        return JSONResponse({"error": f"Microtask {task_id} not found in tasks/micro/"}, status_code=404)

    file_bytes = target_file.read_bytes()
    task_hash = hashlib.sha256(file_bytes).hexdigest()

    expect_task_hash = (
        body.get("expect_task_hash")
        or body.get("expect_hash")
        or request.query_params.get("expect_task_hash")
        or request.query_params.get("expect_hash")
        or request.headers.get("x-expect-task-hash")
    )
    if expect_task_hash and expect_task_hash.lower() != task_hash.lower():
        return JSONResponse({"error": f"Task hash mismatch: expected {expect_task_hash}, actual {task_hash}"}, status_code=409)

    if is_preview:
        diff_str = f"--- {target_file.name}\n+++ tasks/{category}/{target_file.name}\n(Promote microtask to full emergent task in category '{category}' with Goal, Steps, and Verification)\n"
        return JSONResponse({
            "ok": True,
            "dry_run": True,
            "id": task_id,
            "task_id": task_id,
            "category": category,
            "summary": f"Promote microtask {task_id} to category '{category}'",
            "diff": diff_str,
            "hash": task_hash,
            "task_hash": task_hash,
            "base_task_hash": task_hash,
        }, status_code=200)

    cmd = ["tasks", "promote", task_id, "--category", category, "--tasks-dir", str(tasks_dir), "--json"]
    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "changed", "areas": ["tasks"]})
        return JSONResponse(data if isinstance(data, dict) else {"ok": True}, status_code=200)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_promote(request: Request) -> JSONResponse:
    return await _handle_promote(request, is_preview=True)


async def api_promote(request: Request) -> JSONResponse:
    return await _handle_promote(request, is_preview=False)


async def api_inbox_to_microtask(request: Request) -> JSONResponse:
    note_id = request.path_params["id"]
    if not NOTE_ID_RE.match(note_id):
        return JSONResponse({"error": f"Invalid note ID {note_id!r}, must match ^N\\d{{3,}}$"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    tasks_dir = state.workspace / "tasks"
    show_code, show_data = await run_ai_orch(["inbox", "show", note_id, "--tasks-dir", str(tasks_dir), "--json"])
    if show_code != 0 or not isinstance(show_data, dict) or not show_data.get("ok"):
        return JSONResponse({"error": f"Note {note_id} not found"}, status_code=404)

    note = show_data.get("note", {})
    title = body.get("title") or note.get("title") or f"Issue from note {note_id}"
    kind = str(body.get("kind") or (note.get("kind") if note.get("kind") in VALID_KINDS else "bug")).strip().lower()
    if kind not in VALID_KINDS:
        kind = "bug"
    priority = str(body.get("priority") or "P2").strip().upper()
    what = body.get("what") or note.get("body") or f"Created from inbox note {note_id}."

    labels = _extract_labels(body.get("labels") or body.get("label"))
    if not labels and note.get("about"):
        for ab in re.split(r"[\s,]+", note["about"]):
            ab_clean = re.sub(r"[^a-z0-9-]", "", ab.strip().lower())
            if ab_clean and LABEL_RE.match(ab_clean) and ab_clean not in labels:
                labels.append(ab_clean)

    cmd = [
        "tasks", "micro",
        "--title", str(title).strip(),
        "--kind", kind,
        "--priority", priority,
        "--tasks-dir", str(tasks_dir),
        "--json",
    ]
    if body.get("paths"):
        cmd.extend(["--paths", str(body["paths"])])
    if body.get("depends_on"):
        cmd.extend(["--depends-on", str(body["depends_on"])])
    if body.get("executor"):
        cmd.extend(["--executor", str(body["executor"])])
    if what:
        cmd.extend(["--what", str(what)])
    for lbl in labels:
        cmd.extend(["--label", lbl])

    code, data = await run_ai_orch(cmd)
    if code != 0:
        status_code = map_cli_status(code, data)
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)

    task_id = data.get("id") if isinstance(data, dict) else None
    if task_id:
        await run_ai_orch(["inbox", "resolve", note_id, "--produced", task_id, "--tasks-dir", str(tasks_dir), "--json"])
        await state.broadcast({"type": "task_created", "task_id": task_id, "from_note": note_id})
        await state.broadcast({"type": "inbox_updated", "note_id": note_id})
        await state.broadcast({"type": "changed", "areas": ["tasks", "inbox"]})

    return JSONResponse(data if isinstance(data, dict) else {"ok": True, "id": task_id}, status_code=200)


# ---------------------------------------------------------------------------
# REST Endpoints: Task Structure Operations (11.3)
# ---------------------------------------------------------------------------

async def _handle_child_add(request: Request, is_preview: bool = False) -> JSONResponse:
    task_id = request.path_params.get("id") or request.path_params.get("task_id", "")
    try:
        body = await request.json()
    except Exception:
        body = {}
    parent_id = task_id or str(body.get("parent") or body.get("parent_id") or "").strip()
    if not parent_id or not TASK_MUTATION_ID_RE.match(parent_id):
        return JSONResponse({"error": f"Invalid parent id {parent_id!r}"}, status_code=400)

    title = str(body.get("title") or "").strip()
    if not title:
        return JSONResponse({"error": "title is required"}, status_code=400)
    kind = str(body.get("kind") or "feature").strip()

    tasks_dir = state.workspace / "tasks"
    cmd = ["tasks", "child", "add", parent_id, "--title", title, "--kind", kind, "--tasks-dir", str(tasks_dir), "--json"]
    if is_preview:
        cmd.append("--dry-run")
    else:
        expect_plan_hash = (
            body.get("expect_plan_hash")
            or body.get("expect_hash")
            or body.get("plan_hash")
            or request.query_params.get("expect_plan_hash")
            or request.query_params.get("expect_hash")
            or request.headers.get("x-expect-plan-hash")
        )
        if not expect_plan_hash:
            return JSONResponse({"error": "expect_plan_hash is required on apply"}, status_code=400)
        cmd.extend(["--expect-plan-hash", str(expect_plan_hash)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        if not is_preview:
            await state.broadcast({"type": "changed", "areas": ["tasks"]})
        else:
            if isinstance(data, dict):
                if "plan_hash" in data and "hash" not in data:
                    data["hash"] = data["plan_hash"]
                if "summary" not in data:
                    alloc_id = data.get("allocated_id", "")
                    data["summary"] = f"Add child task {alloc_id} under {parent_id}" if alloc_id else f"Add child task under {parent_id}"
        return JSONResponse(data if isinstance(data, dict) else {"ok": True}, status_code=200)

    err_msg = str(data.get("error", "") if isinstance(data, dict) else data)
    if "child add under the file/folder leaf" in err_msg:
        cands = list(tasks_dir.glob(f"*/{parent_id}-*/README.md")) + list(tasks_dir.glob(f"*/{parent_id}/README.md"))
        cands += list(tasks_dir.glob(f"done/*/{parent_id}-*/README.md")) + list(tasks_dir.glob(f"done/*/{parent_id}/README.md"))
        if cands:
            readme_file = cands[0]
            text = readme_file.read_text(encoding="utf-8")
            state_m = re.search(r"^-\s+(?:state|status):\s*([a-z ]+)", text, re.MULTILINE | re.IGNORECASE)
            leaf_state = state_m.group(1).strip().lower() if state_m else "open"
            if leaf_state != "open":
                return JSONResponse({"error": f"Cannot add child to in-flight leaf {parent_id!r} in state {leaf_state!r}. Leaf must be in state 'open'."}, status_code=400)

            existing_nums = [int(m.group(1)) for m in re.finditer(rf"^###\s+{re.escape(parent_id)}\.(\d+)\b", text, re.MULTILINE)]
            next_num = max(existing_nums) + 1 if existing_nums else 1
            alloc_id = f"{parent_id}.{next_num}"

            before_hash = hashlib.sha256(readme_file.read_bytes()).hexdigest()
            rel_path = str(readme_file.relative_to(tasks_dir))
            plan = [{"action": "modify", "before_hash": before_hash, "path": rel_path}]
            plan_hash = hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()

            if is_preview:
                return JSONResponse({
                    "ok": True,
                    "dry_run": True,
                    "allocated_id": alloc_id,
                    "plan": plan,
                    "plan_hash": plan_hash,
                    "hash": plan_hash,
                    "summary": f"Add child task {alloc_id} under {parent_id}",
                }, status_code=200)
            else:
                expect_plan_hash = (
                    body.get("expect_plan_hash")
                    or body.get("expect_hash")
                    or body.get("plan_hash")
                    or request.query_params.get("expect_plan_hash")
                    or request.query_params.get("expect_hash")
                    or request.headers.get("x-expect-plan-hash")
                )
                if not expect_plan_hash:
                    return JSONResponse({"error": "expect_plan_hash is required on apply"}, status_code=400)
                if expect_plan_hash != plan_hash:
                    return JSONResponse({"error": f"Plan hash mismatch: expected {expect_plan_hash}, but recomputed {plan_hash}"}, status_code=409)

                lines = text.splitlines()
                filtered_lines = [ln for ln in lines if not re.match(r"^-\s+(?:state|status):\s*", ln, re.IGNORECASE)]
                new_text = "\n".join(filtered_lines)

                child_block = (
                    f"\n### {alloc_id} - {title}\n\n"
                    f"- **Status:** `open` · **Kind:** {kind}\n"
                    f"- **Goal:** {title}\n"
                )
                if "## Subtasks" in new_text:
                    closed_m = re.search(r"^##\s+Closed\b", new_text, re.MULTILINE)
                    if closed_m:
                        new_text = new_text[:closed_m.start()] + child_block + "\n" + new_text[closed_m.start():]
                    else:
                        new_text = new_text.rstrip() + "\n" + child_block
                else:
                    new_text = new_text.rstrip() + f"\n\n## Subtasks\n{child_block}"

                readme_file.write_text(new_text, encoding="utf-8")
                await state.broadcast({"type": "changed", "areas": ["tasks"]})
                return JSONResponse({"ok": True, "allocated_id": alloc_id, "plan_hash": plan_hash}, status_code=200)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_child_add(request: Request) -> JSONResponse:
    return await _handle_child_add(request, is_preview=True)


async def api_child_add(request: Request) -> JSONResponse:
    return await _handle_child_add(request, is_preview=False)


async def _handle_expand(request: Request, is_preview: bool = False) -> JSONResponse:
    node_id = request.path_params.get("id") or request.path_params.get("task_id", "")
    try:
        body = await request.json()
    except Exception:
        body = {}
    node_id = node_id or str(body.get("id") or body.get("node_id") or "").strip()
    if not node_id or not TASK_MUTATION_ID_RE.match(node_id):
        return JSONResponse({"error": f"Invalid node id {node_id!r}"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["tasks", "expand", node_id, "--tasks-dir", str(tasks_dir), "--json"]
    if is_preview:
        cmd.append("--dry-run")
    else:
        expect_plan_hash = (
            body.get("expect_plan_hash")
            or body.get("expect_hash")
            or body.get("plan_hash")
            or request.query_params.get("expect_plan_hash")
            or request.query_params.get("expect_hash")
            or request.headers.get("x-expect-plan-hash")
        )
        if not expect_plan_hash:
            return JSONResponse({"error": "expect_plan_hash is required on apply"}, status_code=400)
        cmd.extend(["--expect-plan-hash", str(expect_plan_hash)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        if not is_preview:
            await state.broadcast({"type": "changed", "areas": ["tasks"]})
        else:
            if isinstance(data, dict):
                if "plan_hash" in data and "hash" not in data:
                    data["hash"] = data["plan_hash"]
                if "summary" not in data:
                    data["summary"] = f"Expand node {node_id} into folder"
        return JSONResponse(data if isinstance(data, dict) else {"ok": True}, status_code=200)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_expand(request: Request) -> JSONResponse:
    return await _handle_expand(request, is_preview=True)


async def api_expand(request: Request) -> JSONResponse:
    return await _handle_expand(request, is_preview=False)


async def _handle_collapse(request: Request, is_preview: bool = False) -> JSONResponse:
    node_id = request.path_params.get("id") or request.path_params.get("task_id", "")
    try:
        body = await request.json()
    except Exception:
        body = {}
    node_id = node_id or str(body.get("id") or body.get("node_id") or "").strip()
    if not node_id or not TASK_MUTATION_ID_RE.match(node_id):
        return JSONResponse({"error": f"Invalid node id {node_id!r}"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["tasks", "collapse", node_id, "--tasks-dir", str(tasks_dir), "--json"]
    if is_preview:
        cmd.append("--dry-run")
    else:
        expect_plan_hash = (
            body.get("expect_plan_hash")
            or body.get("expect_hash")
            or body.get("plan_hash")
            or request.query_params.get("expect_plan_hash")
            or request.query_params.get("expect_hash")
            or request.headers.get("x-expect-plan-hash")
        )
        if not expect_plan_hash:
            return JSONResponse({"error": "expect_plan_hash is required on apply"}, status_code=400)
        cmd.extend(["--expect-plan-hash", str(expect_plan_hash)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        if not is_preview:
            await state.broadcast({"type": "changed", "areas": ["tasks"]})
        else:
            if isinstance(data, dict):
                if "plan_hash" in data and "hash" not in data:
                    data["hash"] = data["plan_hash"]
                if "summary" not in data:
                    data["summary"] = f"Collapse node {node_id} back into block"
        return JSONResponse(data if isinstance(data, dict) else {"ok": True}, status_code=200)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_collapse(request: Request) -> JSONResponse:
    return await _handle_collapse(request, is_preview=True)


async def api_collapse(request: Request) -> JSONResponse:
    return await _handle_collapse(request, is_preview=False)


async def _handle_reopen(request: Request, is_preview: bool = False) -> JSONResponse:
    node_id = request.path_params.get("id") or request.path_params.get("task_id", "")
    try:
        body = await request.json()
    except Exception:
        body = {}
    node_id = node_id or str(body.get("id") or body.get("node_id") or "").strip()
    if not node_id or not TASK_MUTATION_ID_RE.match(node_id):
        return JSONResponse({"error": f"Invalid node id {node_id!r}"}, status_code=400)

    reason = str(body.get("reason") or "").strip()
    if not reason:
        return JSONResponse({"error": "reason is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["tasks", "reopen", node_id, "--reason", reason, "--tasks-dir", str(tasks_dir), "--json"]
    if is_preview:
        cmd.append("--dry-run")
    else:
        expect_plan_hash = (
            body.get("expect_plan_hash")
            or body.get("expect_hash")
            or body.get("plan_hash")
            or request.query_params.get("expect_plan_hash")
            or request.query_params.get("expect_hash")
            or request.headers.get("x-expect-plan-hash")
        )
        if not expect_plan_hash:
            return JSONResponse({"error": "expect_plan_hash is required on apply"}, status_code=400)
        cmd.extend(["--expect-plan-hash", str(expect_plan_hash)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        if not is_preview:
            await state.broadcast({"type": "changed", "areas": ["tasks"]})
        else:
            if isinstance(data, dict):
                if "plan_hash" in data and "hash" not in data:
                    data["hash"] = data["plan_hash"]
                if "summary" not in data:
                    data["summary"] = f"Reopen node {node_id}: {reason}"
        return JSONResponse(data if isinstance(data, dict) else {"ok": True}, status_code=200)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_reopen(request: Request) -> JSONResponse:
    return await _handle_reopen(request, is_preview=True)


async def api_reopen(request: Request) -> JSONResponse:
    return await _handle_reopen(request, is_preview=False)


async def api_transition_task(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    task_id = body.get("task_id")
    new_state = body.get("new_state")
    if not task_id or not new_state:
        return JSONResponse({"error": "task_id and new_state are required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["tasks", "transition", str(task_id), str(new_state), "--tasks-dir", str(tasks_dir), "--json"]
    if body.get("actor"):
        cmd.extend(["--actor", str(body["actor"])])
    if body.get("verifier"):
        cmd.extend(["--verifier", str(body["verifier"])])
    if body.get("reason"):
        cmd.extend(["--reason", str(body["reason"])])
    if body.get("expect_task_hash"):
        cmd.extend(["--expect-task-hash", str(body["expect_task_hash"])])
    if body.get("force_unblock"):
        cmd.append("--force-unblock")

    code, data = await run_ai_orch(cmd)
    if code == 0:
        # Check index in_sync status without modifying index
        check_code, check_data = await run_ai_orch(
            ["tasks", "sync-index", "--tasks-dir", str(tasks_dir), "--check", "--json"]
        )
        in_sync = check_data.get("in_sync", False) if isinstance(check_data, dict) else False
        if isinstance(data, dict):
            data["index_in_sync"] = in_sync

        await state.broadcast({"type": "task_transitioned", "task_id": task_id, "new_state": new_state})
        return JSONResponse(data if isinstance(data, dict) else {"ok": True, "index_in_sync": in_sync}, status_code=200)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_sync_index(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    code, data = await run_ai_orch(["tasks", "sync-index", "--tasks-dir", str(tasks_dir), "--check", "--json"])
    if code == 504:
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=504)
    if isinstance(data, dict) and "in_sync" in data:
        return JSONResponse(data, status_code=200)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_sync_index(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    expect_hash = body.get("expect_hash")
    if not expect_hash:
        return JSONResponse({"error": "expect_hash is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["tasks", "sync-index", "--tasks-dir", str(tasks_dir), "--apply", "--expect-hash", str(expect_hash), "--json"]
    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "index_synced"})
        return JSONResponse(data if isinstance(data, dict) else {"applied": True}, status_code=200)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


TASK_DETAIL_ID_RE = re.compile(r"^(T\d{3,}(\.\d+)*|\d{2,}(\.\d+)*|INIT-\d{2,})$")


def _plan_for_initiative(tasks_dir: pathlib.Path, init_id: str) -> pathlib.Path | None:
    for pattern in (f"{init_id}-*/plan.md", f"done/{init_id}-*/plan.md", f"*/{init_id}-*/plan.md"):
        found = sorted(tasks_dir.glob(pattern))
        if found:
            return found[0]
    return None


def _plan_task_block(plan_text: str, task_id: str) -> str | None:
    """The `### NN.T - title` block of a plan, up to the next heading of level <= 3,
    or matching table row, with fallback to the full plan."""
    lines = plan_text.splitlines()
    head = re.compile(rf"^###\s+{re.escape(task_id)}\s+[\u2014\u2013-]\s+")
    start = next((i for i, ln in enumerate(lines) if head.match(ln)), None)
    if start is not None:
        end = next((j for j in range(start + 1, len(lines)) if re.match(r"^#{1,3}\s", lines[j])), len(lines))
        return "\n".join(lines[start:end]).rstrip() + "\n"

    # Also check table rows (e.g. | **T1** | ... | or | **08.T1** | ... |)
    short_id = task_id.split(".")[-1] if "." in task_id else task_id
    table_re = re.compile(rf"^\|\s*\*\*({re.escape(task_id)}|{re.escape(short_id)})\*\*\s*\|\s*(.+?)\|")
    matching_row = next((ln for ln in lines if table_re.match(ln)), None)
    if matching_row:
        return f"### Task {task_id}\n\n{matching_row.strip()}\n\n---\n\n{plan_text}"
    return None


async def api_get_task_detail(request: Request) -> JSONResponse:
    task_id = request.path_params["task_id"]
    if not TASK_DETAIL_ID_RE.match(task_id):
        return JSONResponse({"error": f"Invalid task id {task_id!r}"}, status_code=400)
    tasks_dir = state.workspace / "tasks"

    # Initiative tasks (NN.T) and synthetic initiative cards (INIT-NN) live in plan.md.
    if not task_id.startswith("T"):
        init_id = task_id[5:] if task_id.startswith("INIT-") else task_id.split(".")[0]
        plan = _plan_for_initiative(tasks_dir, init_id)
        if plan is None:
            return JSONResponse({"error": f"Plan for initiative {init_id} not found"}, status_code=404)
        plan_text = plan.read_text(encoding="utf-8")
        content = plan_text if (task_id.startswith("INIT-") or task_id == init_id) else _plan_task_block(plan_text, task_id)
        if content is None:
            # Check if it was expanded into a folder
            candidates = list(tasks_dir.glob(f"**/{task_id}-*/README.md")) + list(tasks_dir.glob(f"**/{task_id}/README.md"))
            if candidates:
                target_file = candidates[0]
                content = target_file.read_text(encoding="utf-8")
                return JSONResponse({
                    "task_id": task_id,
                    "file_path": str(target_file),
                    "relative_path": str(target_file.relative_to(state.workspace)),
                    "is_folder_bundle": True,
                    "is_plan_task": True,
                    "content": content,
                    "progress_content": None,
                })
            if "." in task_id:
                parts = task_id.split(".")
                for i in range(len(parts) - 1, 0, -1):
                    p_id = ".".join(parts[:i])
                    p_cands = list(tasks_dir.glob(f"**/{p_id}-*/README.md")) + list(tasks_dir.glob(f"**/{p_id}/README.md"))
                    for pc in p_cands:
                        if pc.is_file():
                            p_text = pc.read_text(encoding="utf-8")
                            block = _plan_task_block(p_text, task_id)
                            if block:
                                return JSONResponse({
                                    "task_id": task_id,
                                    "file_path": str(pc),
                                    "relative_path": str(pc.relative_to(state.workspace)),
                                    "is_folder_bundle": False,
                                    "is_plan_task": True,
                                    "content": block,
                                    "progress_content": None,
                                })
            return JSONResponse({"error": f"Task {task_id} not found in {plan.relative_to(state.workspace)}"}, status_code=404)
        return JSONResponse({
            "task_id": task_id,
            "file_path": str(plan),
            "relative_path": str(plan.relative_to(state.workspace)),
            "is_folder_bundle": False,
            "is_plan_task": True,
            "content": content,
            "progress_content": None,
        })

    candidates = list(tasks_dir.glob(f"**/{task_id}-*.md")) + list(tasks_dir.glob(f"**/{task_id}/README.md"))
    candidates += list(tasks_dir.glob(f"done/**/{task_id}-*.md")) + list(tasks_dir.glob(f"done/**/{task_id}/README.md"))

    if not candidates:
        if "." in task_id:
            parts = task_id.split(".")
            for i in range(len(parts) - 1, 0, -1):
                parent_id = ".".join(parts[:i])
                parent_cands = list(tasks_dir.glob(f"**/{parent_id}-*/README.md")) + list(tasks_dir.glob(f"**/{parent_id}/README.md"))
                parent_cands += list(tasks_dir.glob(f"done/**/{parent_id}-*/README.md")) + list(tasks_dir.glob(f"done/**/{parent_id}/README.md"))
                for pc in parent_cands:
                    if pc.is_file():
                        p_text = pc.read_text(encoding="utf-8")
                        block = _plan_task_block(p_text, task_id)
                        if block:
                            return JSONResponse({
                                "task_id": task_id,
                                "file_path": str(pc),
                                "relative_path": str(pc.relative_to(state.workspace)),
                                "is_folder_bundle": False,
                                "content": block,
                                "progress_content": None,
                            })
        return JSONResponse({"error": f"Task {task_id} file not found"}, status_code=404)

    target_file = candidates[0]
    content = target_file.read_text(encoding="utf-8")

    progress_file = target_file.parent / "PROGRESS.md" if target_file.name == "README.md" else None
    progress_content = progress_file.read_text(encoding="utf-8") if progress_file and progress_file.is_file() else None

    return JSONResponse({
        "task_id": task_id,
        "file_path": str(target_file),
        "relative_path": str(target_file.relative_to(state.workspace)),
        "is_folder_bundle": target_file.name == "README.md",
        "content": content,
        "progress_content": progress_content,
    })


# ---------------------------------------------------------------------------
# REST Endpoints: Task Attachments (09.8) & Attachment Classification
# ---------------------------------------------------------------------------

TASK_ATTACHMENT_ID_RE = re.compile(r"^T\d{3,}$")
ATTACHMENT_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,80}$")
MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024  # 10 MB


def validate_task_attachment_id(task_id: str) -> JSONResponse | None:
    if not TASK_ATTACHMENT_ID_RE.match(task_id):
        if "." in task_id or (task_id and task_id[0].isdigit()) or "plan" in task_id.lower() or task_id.startswith("INIT-"):
            return JSONResponse({"error": "plan tasks take no attachments"}, status_code=400)
        return JSONResponse({"error": f"Invalid task ID {task_id!r}, must match ^T\\d{{3,}}$"}, status_code=400)
    return None


def sniff_image_media_type(data: bytes) -> str | None:
    """Sniff media type from magic bytes (png, jpeg, gif, webp only)."""
    if len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(data) >= 6 and (data[:6] == b"GIF87a" or data[:6] == b"GIF89a"):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def classify_attachment_bytes(data: bytes) -> tuple[str, str] | None:
    """Classify attachment bytes into (class_name, media_type).
    Returns None if content is not a supported image, pdf, or utf-8 text without NUL.
    """
    img_type = sniff_image_media_type(data)
    if img_type:
        return ("image", img_type)

    if data.startswith(b"%PDF-"):
        return ("pdf", "application/pdf")

    if b"\x00" not in data[:65536]:
        try:
            data.decode("utf-8")
            return ("text", "text/plain; charset=utf-8")
        except UnicodeDecodeError:
            pass

    return None


def classify_and_serve_attachment(file_bytes: bytes, filename: str) -> Response:
    classification = classify_attachment_bytes(file_bytes)
    if not classification:
        return JSONResponse({"error": "Unsupported attachment format"}, status_code=415)

    att_class, media_type = classification
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": CSP_HEADER,
        "Cache-Control": "private, max-age=60",
    }
    if att_class == "pdf":
        headers["Content-Disposition"] = f'attachment; filename="{filename}"'

    return Response(file_bytes, media_type=media_type, headers=headers)


async def api_upload_task_attachment(request: Request) -> JSONResponse:
    task_id = request.path_params.get("id") or request.path_params.get("task_id", "")
    err_resp = validate_task_attachment_id(task_id)
    if err_resp:
        return err_resp

    content_type = request.headers.get("content-type", "")
    if not content_type.startswith("multipart/form-data"):
        return JSONResponse({"error": "Content-Type must be multipart/form-data"}, status_code=400)

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_ATTACHMENT_SIZE + 512 * 1024:
                return JSONResponse({"error": "Attachment exceeds 10 MB limit"}, status_code=413)
        except ValueError:
            pass

    try:
        form = await request.form()
    except Exception as exc:
        return JSONResponse({"error": f"Invalid multipart form: {exc}"}, status_code=400)

    upload_file = form.get("file")
    if not upload_file or not hasattr(upload_file, "read"):
        return JSONResponse({"error": "file field is required in multipart form"}, status_code=400)

    temp_path: pathlib.Path | None = None
    suffix = pathlib.Path(upload_file.filename).suffix if getattr(upload_file, "filename", None) else ".tmp"
    try:
        with tempfile.NamedTemporaryFile("wb", delete=False, suffix=suffix) as temp_f:
            temp_path = pathlib.Path(temp_f.name)
            total_read = 0
            while True:
                chunk = await upload_file.read(65536)
                if not chunk:
                    break
                total_read += len(chunk)
                if total_read > MAX_ATTACHMENT_SIZE:
                    temp_f.close()
                    temp_path.unlink(missing_ok=True)
                    temp_path = None
                    return JSONResponse({"error": "Attachment exceeds 10 MB limit"}, status_code=413)
                temp_f.write(chunk)

        tasks_dir = state.workspace / "tasks"
        cmd = ["tasks", "attach", task_id, "--file", str(temp_path), "--tasks-dir", str(tasks_dir), "--json"]

        name = form.get("name")
        if name and str(name).strip():
            cmd.extend(["--name", str(name).strip()])
        elif getattr(upload_file, "filename", None):
            stem = pathlib.Path(upload_file.filename).stem
            if stem:
                cmd.extend(["--name", stem])

        expect_task_hash = (
            form.get("expect_task_hash")
            or form.get("expect_hash")
            or request.query_params.get("expect_task_hash")
            or request.query_params.get("expect_hash")
            or request.headers.get("x-expect-task-hash")
        )
        if expect_task_hash:
            cmd.extend(["--expect-task-hash", str(expect_task_hash)])

        code, data = await run_ai_orch(cmd)
        if code == 0:
            await state.broadcast({"type": "changed", "areas": ["tasks"]})
            return JSONResponse(data, status_code=200)

        err_str = ""
        if isinstance(data, dict):
            err_str = f"{data.get('error', '')} {data.get('message', '')} {data.get('reason', '')}".lower()
        elif isinstance(data, str):
            err_str = data.lower()
        if "not found" in err_str or "not-found" in err_str:
            return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)

        status_code = map_cli_status(code, data)
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)
    finally:
        if temp_path:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass


async def api_get_task_attachment(request: Request) -> Response:
    task_id = request.path_params.get("id") or request.path_params.get("task_id", "")
    err_resp = validate_task_attachment_id(task_id)
    if err_resp:
        return err_resp

    name = request.path_params["name"]
    if not ATTACHMENT_NAME_RE.match(name):
        return JSONResponse({"error": f"Invalid attachment name {name!r}"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    code, data = await run_ai_orch(["tasks", "list", "--tasks-dir", str(tasks_dir), "--json"])
    if code != 0 or not isinstance(data, dict):
        return JSONResponse({"error": f"Task {task_id} not found"}, status_code=404)

    task_entry = None
    for t in data.get("emergent_tasks", []):
        if isinstance(t, dict) and t.get("id") == task_id:
            task_entry = t
            break
    if not task_entry:
        for t in data.get("all_tasks", []):
            if isinstance(t, dict) and t.get("id") == task_id:
                task_entry = t
                break
    if not task_entry:
        tree = data.get("tree", {})
        if isinstance(tree, dict) and task_id in tree:
            task_entry = tree[task_id]

    if not task_entry:
        return JSONResponse({"error": f"Task {task_id} not found"}, status_code=404)

    if not task_entry.get("is_folder", False):
        return JSONResponse({"error": f"Task {task_id} has no attachments"}, status_code=404)

    folder_path_str = task_entry.get("task_root")
    if not folder_path_str:
        fp = task_entry.get("file_path")
        if fp:
            folder_path_str = str(pathlib.Path(fp).parent)

    if not folder_path_str:
        return JSONResponse({"error": f"Task {task_id} has no attachments"}, status_code=404)

    folder_path = pathlib.Path(folder_path_str)
    if not folder_path.is_absolute():
        folder_path = (state.workspace / folder_path).resolve()
    else:
        folder_path = folder_path.resolve()

    attachments_dir = (folder_path / "attachments").resolve()
    target_file = (attachments_dir / name).resolve()

    try:
        target_file.relative_to(attachments_dir)
    except ValueError:
        return JSONResponse({"error": "Path traversal detected"}, status_code=400)

    if not target_file.is_file():
        return JSONResponse({"error": f"Attachment {name!r} not found"}, status_code=404)

    file_bytes = target_file.read_bytes()
    return classify_and_serve_attachment(file_bytes, name)


async def api_delete_task_attachment(request: Request) -> JSONResponse:
    task_id = request.path_params.get("id") or request.path_params.get("task_id", "")
    err_resp = validate_task_attachment_id(task_id)
    if err_resp:
        return err_resp

    name = request.path_params["name"]
    if not ATTACHMENT_NAME_RE.match(name):
        return JSONResponse({"error": f"Invalid attachment name {name!r}"}, status_code=400)

    expect_task_hash = (
        request.query_params.get("expect_task_hash")
        or request.query_params.get("expect_hash")
        or request.headers.get("x-expect-task-hash")
    )
    if not expect_task_hash:
        try:
            body = await request.json()
            if isinstance(body, dict):
                expect_task_hash = body.get("expect_task_hash") or body.get("expect_hash")
        except Exception:
            pass

    tasks_dir = state.workspace / "tasks"
    cmd = ["tasks", "detach", task_id, "--name", name, "--tasks-dir", str(tasks_dir), "--json"]
    if expect_task_hash:
        cmd.extend(["--expect-task-hash", str(expect_task_hash)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "changed", "areas": ["tasks"]})
        return JSONResponse(data, status_code=200)

    err_str = ""
    if isinstance(data, dict):
        err_str = f"{data.get('error', '')} {data.get('message', '')} {data.get('reason', '')}".lower()
    elif isinstance(data, str):
        err_str = data.lower()
    if "not found" in err_str or "not-found" in err_str or "no-attachments" in err_str:
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


# ---------------------------------------------------------------------------
# REST Endpoints: Blocking Questions (08.3)
# ---------------------------------------------------------------------------

QUESTION_ID_RE = re.compile(r"^Q\d{3,}$")


async def api_list_questions(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    cmd = ["questions", "list", "--tasks-dir", str(tasks_dir), "--json"]
    status = request.query_params.get("status")
    if status:
        cmd.extend(["--status", status])
    blocks = request.query_params.get("blocks")
    if blocks:
        cmd.extend(["--blocks", blocks])

    code, data = await run_ai_orch(cmd)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_get_question(request: Request) -> JSONResponse:
    question_id = request.path_params["question_id"]
    if not QUESTION_ID_RE.match(question_id):
        return JSONResponse({"error": f"Invalid question ID {question_id!r}, must match ^Q\\d{{3,}}$"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["questions", "show", question_id, "--tasks-dir", str(tasks_dir), "--json"]
    code, data = await run_ai_orch(cmd)
    if code != 0:
        err_str = ""
        if isinstance(data, dict):
            err_str = str(data.get("error") or data.get("message") or "").lower()
        elif isinstance(data, str):
            err_str = data.lower()
        if "not found" in err_str:
            return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)
        status_code = map_cli_status(code, data)
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)
    return JSONResponse(data if isinstance(data, dict) else {"question": data})


async def api_ask_question(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}

    tasks_dir = state.workspace / "tasks"
    cmd = ["questions", "ask", "--tasks-dir", str(tasks_dir), "--json"]

    if body.get("from_task"):
        cmd.extend(["--from-task", str(body["from_task"])])
    if body.get("question"):
        cmd.extend(["--question", str(body["question"])])
    if body.get("recommended"):
        cmd.extend(["--recommended", str(body["recommended"])])
    if body.get("open_answer") is not None:
        oa = body["open_answer"]
        oa_str = "yes" if oa is True else ("no" if oa is False else str(oa))
        cmd.extend(["--open-answer", oa_str])
    if body.get("blocks"):
        blocks = body["blocks"]
        if isinstance(blocks, list):
            cmd.extend(["--blocks", ", ".join(str(b) for b in blocks)])
        else:
            cmd.extend(["--blocks", str(blocks)])
    if body.get("decider"):
        cmd.extend(["--decider", str(body["decider"])])
    if body.get("asked_by"):
        cmd.extend(["--asked-by", str(body["asked_by"])])
    if body.get("origin_run"):
        cmd.extend(["--origin-run", str(body["origin_run"])])

    for opt in body.get("options", []):
        if isinstance(opt, dict):
            label = str(opt.get("label", "")).strip()
            title = str(opt.get("title", "")).strip()
            consequence = opt.get("consequence")
            if consequence and str(consequence).strip():
                opt_arg = f"{label}={title}: {str(consequence).strip()}"
            elif title:
                opt_arg = f"{label}={title}"
            else:
                opt_arg = label
            cmd.extend(["--option", opt_arg])
        elif isinstance(opt, str):
            cmd.extend(["--option", opt])

    temp_ctx_file: str | None = None
    context = body.get("context")
    try:
        if context is not None:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".md") as f:
                f.write(str(context))
                temp_ctx_file = f.name
            cmd.extend(["--context-file", temp_ctx_file])

        code, data = await run_ai_orch(cmd)
    finally:
        if temp_ctx_file:
            try:
                os.remove(temp_ctx_file)
            except OSError:
                pass

    if code == 0:
        q_id = data.get("id") if isinstance(data, dict) else None
        await state.broadcast({"type": "question_asked", "question_id": q_id})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_answer_question(request: Request) -> JSONResponse:
    question_id = request.path_params["question_id"]
    if not QUESTION_ID_RE.match(question_id):
        return JSONResponse({"error": f"Invalid question ID {question_id!r}, must match ^Q\\d{{3,}}$"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    choice = body.get("choice")
    if not choice:
        return JSONResponse({"error": "choice is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["questions", "answer", question_id, "--choice", str(choice), "--tasks-dir", str(tasks_dir), "--json"]

    text = body.get("text")
    if text is not None:
        text_str = str(text)
        if len(text_str.encode("utf-8")) > 32 * 1024:
            return JSONResponse({"error": "Answer text exceeds 32 KB limit"}, status_code=400)
        cmd.extend(["--text", text_str])

    if body.get("by"):
        cmd.extend(["--by", str(body["by"])])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "question_answered", "question_id": question_id, "choice": str(choice)})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_withdraw_question(request: Request) -> JSONResponse:
    question_id = request.path_params["question_id"]
    if not QUESTION_ID_RE.match(question_id):
        return JSONResponse({"error": f"Invalid question ID {question_id!r}, must match ^Q\\d{{3,}}$"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    reason = body.get("reason")
    if not reason or not str(reason).strip():
        return JSONResponse({"error": "reason is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["questions", "withdraw", question_id, "--reason", str(reason).strip(), "--tasks-dir", str(tasks_dir), "--json"]
    if body.get("by"):
        cmd.extend(["--by", str(body["by"])])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "question_withdrawn", "question_id": question_id})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


# ---------------------------------------------------------------------------
# REST Endpoints: Macro 2 & 3 — Environment Doctor & Skills Installer
# ---------------------------------------------------------------------------

async def api_env_status(request: Request) -> JSONResponse:
    code, data = await run_ai_orch(["env", "status", "--workspace", str(state.workspace), "--json"])
    if code != 0:
        return JSONResponse({"error": data} if not isinstance(data, dict) else data, status_code=504 if code == 504 else 500)
    return JSONResponse(data)


async def api_preview_install_skills(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    assistants = body.get("assistants", ["all"])
    scope = body.get("scope", "global")
    repo = body.get("repo", "ai-orchestration")
    link = body.get("link", False)
    plugins = body.get("plugins")
    overwrite = body.get("overwrite")

    cmd = ["env", "install-skills", "--scope", scope, "--repo", repo, "--workspace", str(state.workspace), "--dry-run", "--json"]
    cmd.extend(["--assistants", *assistants])
    if link:
        cmd.append("--link")
    if plugins:
        cmd.extend(["--plugins", *plugins])
    if overwrite:
        cmd.extend(["--overwrite", *overwrite])

    code, data = await run_ai_orch(cmd)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_install_skills(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    expect_plan_hash = body.get("expect_plan_hash")
    if not expect_plan_hash:
        return JSONResponse({"error": "expect_plan_hash is required"}, status_code=400)

    assistants = body.get("assistants", ["all"])
    scope = body.get("scope", "global")
    repo = body.get("repo", "ai-orchestration")
    link = body.get("link", False)
    plugins = body.get("plugins")
    overwrite = body.get("overwrite")

    cmd = [
        "env", "install-skills",
        "--scope", scope,
        "--repo", repo,
        "--workspace", str(state.workspace),
        "--expect-plan-hash", str(expect_plan_hash),
        "--json",
    ]
    cmd.extend(["--assistants", *assistants])
    if link:
        cmd.append("--link")
    if plugins:
        cmd.extend(["--plugins", *plugins])
    if overwrite:
        cmd.extend(["--overwrite", *overwrite])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "skills_installed", "repo": repo, "scope": scope})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_register_mcp(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    server = body.get("server", "kilo-mcp")
    assistants = body.get("assistants", ["claude", "codex"])
    scope = body.get("scope", "global")
    provision_venv = body.get("provision_venv", False)

    cmd = ["env", "register-mcp", server, "--scope", scope, "--workspace", str(state.workspace), "--dry-run", "--json"]
    cmd.extend(["--assistants", *assistants])
    if provision_venv:
        cmd.append("--provision-venv")

    code, data = await run_ai_orch(cmd)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_register_mcp(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    expect_plan_hash = body.get("expect_plan_hash")
    if not expect_plan_hash:
        return JSONResponse({"error": "expect_plan_hash is required"}, status_code=400)

    server = body.get("server", "kilo-mcp")
    assistants = body.get("assistants", ["claude", "codex"])
    scope = body.get("scope", "global")
    provision_venv = body.get("provision_venv", False)

    cmd = [
        "env", "register-mcp", server,
        "--scope", scope,
        "--workspace", str(state.workspace),
        "--expect-plan-hash", str(expect_plan_hash),
        "--json",
    ]
    cmd.extend(["--assistants", *assistants])
    if provision_venv:
        cmd.append("--provision-venv")

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "mcp_registered", "server": server})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_remove_skill(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    skill = body.get("skill")
    assistant = body.get("assistant")
    scope = body.get("scope", "global")
    if not skill or not assistant:
        return JSONResponse({"error": "skill and assistant are required"}, status_code=400)

    cmd = ["env", "remove-skill", str(skill), "--assistant", str(assistant), "--scope", scope, "--workspace", str(state.workspace), "--dry-run", "--json"]
    code, data = await run_ai_orch(cmd)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_remove_skill(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    expect_plan_hash = body.get("expect_plan_hash")
    if not expect_plan_hash:
        return JSONResponse({"error": "expect_plan_hash is required"}, status_code=400)

    skill = body.get("skill")
    assistant = body.get("assistant")
    scope = body.get("scope", "global")
    if not skill or not assistant:
        return JSONResponse({"error": "skill and assistant are required"}, status_code=400)

    cmd = [
        "env", "remove-skill", str(skill),
        "--assistant", str(assistant),
        "--scope", scope,
        "--workspace", str(state.workspace),
        "--expect-plan-hash", str(expect_plan_hash),
        "--json",
    ]
    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "skill_removed", "skill": skill, "assistant": assistant})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_resolve_conflicts(request: Request) -> JSONResponse:
    cmd = ["env", "resolve-conflicts", "--workspace", str(state.workspace), "--dry-run", "--json"]
    code, data = await run_ai_orch(cmd)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_resolve_conflicts(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    expect_plan_hash = body.get("expect_plan_hash")
    if not expect_plan_hash:
        return JSONResponse({"error": "expect_plan_hash is required"}, status_code=400)

    cmd = ["env", "resolve-conflicts", "--workspace", str(state.workspace), "--expect-plan-hash", str(expect_plan_hash), "--json"]
    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "conflicts_resolved"})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_fetch_repos(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    cmd = ["env", "fetch-repos", "--dry-run", "--json"]
    if body.get("repos"):
        cmd.extend(["--repos", *body["repos"]])
    code, data = await run_ai_orch(cmd)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_fetch_repos(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    expect_plan_hash = body.get("expect_plan_hash")
    if not expect_plan_hash:
        return JSONResponse({"error": "expect_plan_hash is required"}, status_code=400)

    cmd = ["env", "fetch-repos", "--expect-plan-hash", str(expect_plan_hash), "--json"]
    if body.get("repos"):
        cmd.extend(["--repos", *body["repos"]])
    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "repos_fetched"})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


# ---------------------------------------------------------------------------
# REST Endpoints: Macro 4 — Orchestrator Configuration & AGENTS.md
# ---------------------------------------------------------------------------

async def api_config_show(request: Request) -> JSONResponse:
    code, data = await run_ai_orch(["config", "show", "--workspace", str(state.workspace), "--json"])
    if code != 0:
        return JSONResponse({"error": data} if not isinstance(data, dict) else data, status_code=504 if code == 504 else 500)
    return JSONResponse(data)


async def api_preview_config_set_profile(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    tool = body.get("tool")
    profile = body.get("profile")
    model = body.get("model")
    if not tool or not profile or not model:
        return JSONResponse({"error": "tool, profile, and model are required"}, status_code=400)

    cmd = ["config", "set-profile", tool, profile, "--model", model, "--diff", "--json"]
    if body.get("variant"):
        cmd.extend(["--variant", str(body["variant"])])
    if body.get("effort"):
        cmd.extend(["--effort", str(body["effort"])])
    if body.get("basis"):
        cmd.extend(["--basis", str(body["basis"])])
    if body.get("scope"):
        cmd.extend(["--scope", str(body["scope"])])
    if body.get("scope") == "project":
        cmd.extend(["--workspace", str(state.workspace)])

    code, data = await run_ai_orch(cmd)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_config_set_profile(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    expect_hash = body.get("expect_hash")
    if not expect_hash:
        return JSONResponse({"error": "expect_hash is required"}, status_code=400)

    tool = body.get("tool")
    profile = body.get("profile")
    model = body.get("model")
    if not tool or not profile or not model:
        return JSONResponse({"error": "tool, profile, and model are required"}, status_code=400)

    cmd = ["config", "set-profile", tool, profile, "--model", model, "--expect-hash", str(expect_hash), "--json"]
    if body.get("variant"):
        cmd.extend(["--variant", str(body["variant"])])
    if body.get("effort"):
        cmd.extend(["--effort", str(body["effort"])])
    if body.get("basis"):
        cmd.extend(["--basis", str(body["basis"])])
    if body.get("scope"):
        cmd.extend(["--scope", str(body["scope"])])
    if body.get("scope") == "project":
        cmd.extend(["--workspace", str(state.workspace)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "config_updated"})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_config_set_routing(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    scope = body.get("scope", "global")
    cmd = ["config", "set-routing", "--scope", scope, "--diff", "--json"]
    if scope == "project":
        cmd.extend(["--workspace", str(state.workspace)])
    if body.get("orchestrator"):
        cmd.extend(["--orchestrator", str(body["orchestrator"])])
    if body.get("executor"):
        cmd.extend(["--executor", str(body["executor"])])
    if body.get("default_profile"):
        cmd.extend(["--default-profile", str(body["default_profile"])])
    if body.get("verification_mode"):
        cmd.extend(["--verification-mode", str(body["verification_mode"])])

    code, data = await run_ai_orch(cmd)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_config_set_routing(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    expect_hash = body.get("expect_hash")
    if not expect_hash:
        return JSONResponse({"error": "expect_hash is required"}, status_code=400)

    scope = body.get("scope", "global")
    cmd = ["config", "set-routing", "--scope", scope, "--expect-hash", str(expect_hash), "--json"]
    if scope == "project":
        cmd.extend(["--workspace", str(state.workspace)])
    if body.get("orchestrator"):
        cmd.extend(["--orchestrator", str(body["orchestrator"])])
    if body.get("executor"):
        cmd.extend(["--executor", str(body["executor"])])
    if body.get("default_profile"):
        cmd.extend(["--default-profile", str(body["default_profile"])])
    if body.get("verification_mode"):
        cmd.extend(["--verification-mode", str(body["verification_mode"])])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "config_updated"})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_render_agents_md(request: Request) -> JSONResponse:
    code, data = await run_ai_orch(["render-agents-md", "--workspace", str(state.workspace), "--json"])
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_preview_agents_md(request: Request) -> JSONResponse:
    code, data = await run_ai_orch(["render-agents-md", "--workspace", str(state.workspace), "--diff", "--json"])
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_apply_agents_md(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    expect_hash = body.get("expect_hash")
    if not expect_hash:
        return JSONResponse({"error": "expect_hash is required"}, status_code=400)

    cmd = [
        "render-agents-md",
        "--workspace", str(state.workspace),
        "--apply",
        "--expect-hash", str(expect_hash),
        "--json",
    ]
    if body.get("allow_global_routing"):
        cmd.append("--allow-global-routing")

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "agents_md_applied"})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


# ---------------------------------------------------------------------------
# REST Endpoints: Agent Runs & Execution (07.6)
# ---------------------------------------------------------------------------

RUN_ID_RE = re.compile(r"^\d{8}-\d{6}-[A-Za-z0-9.]+-(kilo|claude|codex)-[0-9a-f]{4}$")
NOTE_ID_RE = re.compile(r"^N\d{3,}$")


async def api_run_options(request: Request) -> JSONResponse:
    note = request.query_params.get("note")
    task = request.query_params.get("task")
    if not note and not task:
        return JSONResponse({"error": "task or note query parameter is required"}, status_code=400)
    if note:
        if not NOTE_ID_RE.match(note):
            return JSONResponse({"error": f"Invalid note ID {note!r}"}, status_code=400)
        cmd = ["run", "options", "--note", str(note), "--workspace", str(state.workspace), "--json"]
    else:
        cmd = ["run", "options", "--task", str(task), "--workspace", str(state.workspace), "--json"]
    code, data = await run_ai_orch(cmd)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_run_preview(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    task = body.get("task")
    note = body.get("note")
    if not task and not note:
        return JSONResponse({"error": "task or note is required"}, status_code=400)
    if note:
        if not isinstance(note, str) or not NOTE_ID_RE.match(note):
            return JSONResponse({"error": f"Invalid note ID {note!r}"}, status_code=400)
        target_args = ["--note", str(note)]
    else:
        target_args = ["--task", str(task)]

    cmd = ["run", "preview", *target_args, "--workspace", str(state.workspace), "--json"]
    if body.get("mode"):
        cmd.extend(["--mode", str(body["mode"])])
    if body.get("tool"):
        cmd.extend(["--tool", str(body["tool"])])
    if body.get("profile"):
        cmd.extend(["--profile", str(body["profile"])])
    if body.get("model"):
        cmd.extend(["--model", str(body["model"])])
    if body.get("variant"):
        cmd.extend(["--variant", str(body["variant"])])
    if body.get("effort"):
        cmd.extend(["--effort", str(body["effort"])])
    if body.get("isolation"):
        cmd.extend(["--isolation", str(body["isolation"])])
    if body.get("target_run"):
        cmd.extend(["--target-run", str(body["target_run"])])
    if body.get("instructions"):
        cmd.extend(["--instructions", str(body["instructions"])])
    if body.get("allow_same_tool"):
        cmd.append("--allow-same-tool")
    if body.get("allow_dirty_base"):
        cmd.append("--allow-dirty-base")
    if body.get("force"):
        cmd.append("--force")

    code, data = await run_ai_orch(cmd)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_run_start(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    task = body.get("task")
    note = body.get("note")
    if not task and not note:
        return JSONResponse({"error": "task or note is required"}, status_code=400)
    expect_plan_hash = body.get("expect_plan_hash")
    if not expect_plan_hash:
        return JSONResponse({"error": "expect_plan_hash is required"}, status_code=400)

    if note:
        if not isinstance(note, str) or not NOTE_ID_RE.match(note):
            return JSONResponse({"error": f"Invalid note ID {note!r}"}, status_code=400)
        target_args = ["--note", str(note)]
    else:
        target_args = ["--task", str(task)]

    cmd = [
        "run", "start",
        *target_args,
        "--expect-plan-hash", str(expect_plan_hash),
        "--requested-by", "ui",
        "--workspace", str(state.workspace),
        "--json",
    ]
    if body.get("mode"):
        cmd.extend(["--mode", str(body["mode"])])
    if body.get("tool"):
        cmd.extend(["--tool", str(body["tool"])])
    if body.get("profile"):
        cmd.extend(["--profile", str(body["profile"])])
    if body.get("model"):
        cmd.extend(["--model", str(body["model"])])
    if body.get("variant"):
        cmd.extend(["--variant", str(body["variant"])])
    if body.get("effort"):
        cmd.extend(["--effort", str(body["effort"])])
    if body.get("isolation"):
        cmd.extend(["--isolation", str(body["isolation"])])
    if body.get("target_run"):
        cmd.extend(["--target-run", str(body["target_run"])])
    if body.get("instructions"):
        cmd.extend(["--instructions", str(body["instructions"])])
    if body.get("allow_same_tool"):
        cmd.append("--allow-same-tool")
    if body.get("allow_dirty_base"):
        cmd.append("--allow-dirty-base")
    if body.get("force"):
        cmd.append("--force")

    code, data = await run_ai_orch(cmd, timeout=60.0)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_run_continue(request: Request) -> JSONResponse:
    run_id = request.path_params["id"]
    if not RUN_ID_RE.match(run_id):
        return JSONResponse({"error": f"Invalid run ID {run_id!r}"}, status_code=400)
    try:
        body = await request.json()
    except Exception:
        body = {}
    cmd = [
        "run", "start",
        "--continue", run_id,
        "--requested-by", "ui",
        "--workspace", str(state.workspace),
        "--json",
    ]
    if body.get("instructions"):
        cmd.extend(["--instructions", str(body["instructions"])])
    if body.get("expect_plan_hash"):
        cmd.extend(["--expect-plan-hash", str(body["expect_plan_hash"])])

    code, data = await run_ai_orch(cmd, timeout=60.0)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


# ---------------------------------------------------------------------------
# Answer and Resume Run (Task 08.6)
# ---------------------------------------------------------------------------

def _format_continuation_instructions(
    question_id: str,
    question_text: str,
    choice: str,
    free_text: str | None,
    options: list[dict[str, Any]] | None = None,
) -> str:
    chosen_label_title = choice
    if choice == "open":
        chosen_label_title = "Open answer"
    elif options:
        for opt in options:
            if isinstance(opt, dict) and opt.get("label") == choice:
                title = opt.get("title") or opt.get("text") or ""
                if title:
                    chosen_label_title = f"{choice} — {title}"
                else:
                    chosen_label_title = choice
                break

    q_summary = question_text.strip()
    parts = [f"Answer to {question_id} ({q_summary}): {chosen_label_title}."]
    if free_text and str(free_text).strip():
        parts.append(str(free_text).strip())
    return " ".join(parts)


def _check_origin_run_continuable(
    workspace: pathlib.Path,
    origin_run: str | None,
) -> tuple[bool, str | None, dict[str, Any] | None]:
    if not origin_run or origin_run == "-" or not str(origin_run).strip():
        return False, "Question has no origin-run", None
    origin_run = str(origin_run).strip()
    # The id comes from a question file: validate it before building a path from it.
    if not RUN_ID_RE.match(origin_run):
        return False, f"Invalid origin-run id {origin_run!r}", None

    run_dir = workspace / ".ai-orchestration" / "runs" / origin_run
    run_json = run_dir / "run.json"
    if not run_json.is_file():
        return False, f"Origin run '{origin_run}' not found in runs registry", None

    try:
        record = json.loads(run_json.read_text(encoding="utf-8"))
    except Exception as e:
        return False, f"Failed to read run record for '{origin_run}': {e}", None

    status = record.get("status")
    if status not in ("succeeded", "failed", "cancelled", "lost"):
        return False, f"Origin run '{origin_run}' is not terminal (status: {status})", record

    session_id = record.get("session_id")
    if not session_id:
        return False, f"Origin run '{origin_run}' has no session_id; cannot continue", record

    if record.get("mode") == "execute" and record.get("isolation") == "worktree":
        wt_p = pathlib.Path(record.get("worktree_path") or record.get("cwd") or "")
        if not wt_p.is_dir() or record.get("worktree_removed") is True:
            return False, f"Worktree '{wt_p}' for run '{origin_run}' does not exist", record

    return True, None, record


async def api_preview_answer_and_resume(request: Request) -> JSONResponse:
    question_id = request.path_params.get("id") or request.path_params.get("question_id")
    if not question_id or not QUESTION_ID_RE.match(question_id):
        return JSONResponse({"error": f"Invalid question ID {question_id!r}, must match ^Q\\d{{3,}}$"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    choice = body.get("choice")
    if not choice:
        return JSONResponse({"error": "choice is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["questions", "show", question_id, "--tasks-dir", str(tasks_dir), "--json"]
    code, data = await run_ai_orch(cmd)
    if code != 0:
        status_code = map_cli_status(code, data)
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)

    q_data = data.get("question", data) if isinstance(data, dict) else {}
    if q_data.get("status") and q_data.get("status") != "open":
        return JSONResponse({"error": f"Question {question_id} is already {q_data.get('status')}"}, status_code=400)

    origin_run = q_data.get("origin_run") or q_data.get("origin-run")
    is_cont, reason, run_record = _check_origin_run_continuable(state.workspace, origin_run)

    text = body.get("text")
    if not is_cont:
        return JSONResponse({
            "ok": True,
            "continuable": False,
            "can_resume": False,
            "reason": reason,
            "question_id": question_id,
            "origin_run": origin_run if origin_run and origin_run != "-" else None,
        })

    assert run_record is not None
    plan_hash = run_record.get("plan_hash") or ""
    prompt = _format_continuation_instructions(
        question_id=question_id,
        question_text=q_data.get("question", ""),
        choice=str(choice),
        free_text=str(text) if text is not None else None,
        options=q_data.get("options"),
    )

    return JSONResponse({
        "ok": True,
        "continuable": True,
        "can_resume": True,
        "run_id": origin_run,
        "origin_run": origin_run,
        "question_id": question_id,
        "plan_hash": plan_hash,
        "prompt": prompt,
        "instructions": prompt,
    })


async def api_answer_and_resume(request: Request) -> JSONResponse:
    question_id = request.path_params.get("id") or request.path_params.get("question_id")
    if not question_id or not QUESTION_ID_RE.match(question_id):
        return JSONResponse({"error": f"Invalid question ID {question_id!r}, must match ^Q\\d{{3,}}$"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    choice = body.get("choice")
    if not choice:
        return JSONResponse({"error": "choice is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["questions", "show", question_id, "--tasks-dir", str(tasks_dir), "--json"]
    code, data = await run_ai_orch(cmd)
    if code != 0:
        status_code = map_cli_status(code, data)
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)

    q_data = data.get("question", data) if isinstance(data, dict) else {}
    if q_data.get("status") and q_data.get("status") != "open":
        return JSONResponse({"error": f"Question {question_id} is already {q_data.get('status')}"}, status_code=400)

    origin_run = q_data.get("origin_run") or q_data.get("origin-run")
    is_cont, reason, run_record = _check_origin_run_continuable(state.workspace, origin_run)

    text = body.get("text")
    text_str = str(text) if text is not None else None
    if text_str and len(text_str.encode("utf-8")) > 32 * 1024:
        return JSONResponse({"error": "Answer text exceeds 32 KB limit"}, status_code=400)

    if is_cont:
        assert run_record is not None
        plan_hash = run_record.get("plan_hash") or ""
        expect_plan_hash = body.get("expect_plan_hash")
        if not expect_plan_hash:
            return JSONResponse({"error": "expect_plan_hash is required for continuable run"}, status_code=400)
        if expect_plan_hash.strip().lower() != plan_hash.strip().lower():
            return JSONResponse(
                {
                    "error": "plan-hash-mismatch",
                    "detail": f"Plan hash mismatch: expected {expect_plan_hash}, actual {plan_hash}",
                },
                status_code=409,
            )

    # 1. Answer the question
    ans_cmd = [
        "questions", "answer", question_id,
        "--choice", str(choice),
        "--tasks-dir", str(tasks_dir),
        "--json",
    ]
    if text_str:
        ans_cmd.extend(["--text", text_str])
    if body.get("by"):
        ans_cmd.extend(["--by", str(body["by"])])

    ans_code, ans_data = await run_ai_orch(ans_cmd)
    if ans_code != 0:
        status_code = map_cli_status(ans_code, ans_data)
        return JSONResponse(ans_data if isinstance(ans_data, dict) else {"error": ans_data}, status_code=status_code)

    # 2. If continuable, start continuation run
    if is_cont:
        prompt = _format_continuation_instructions(
            question_id=question_id,
            question_text=q_data.get("question", ""),
            choice=str(choice),
            free_text=text_str,
            options=q_data.get("options"),
        )
        continue_cmd = [
            "run", "start",
            "--continue", origin_run,
            "--instructions", prompt,
            "--expect-plan-hash", plan_hash,
            "--requested-by", "ui",
            "--workspace", str(state.workspace),
            "--json",
        ]
        r_code, r_data = await run_ai_orch(continue_cmd, timeout=60.0)

        await state.broadcast({"type": "changed", "areas": ["questions", "tasks", "runs"]})
        await state.broadcast({"type": "question_answered", "question_id": question_id, "choice": str(choice)})

        if r_code == 0:
            return JSONResponse({
                "ok": True,
                "question_id": question_id,
                "choice": choice,
                "resumed": True,
                "run_id": r_data.get("run_id") if isinstance(r_data, dict) else None,
                "continued_from": origin_run,
                "instructions": prompt,
            })
        else:
            return JSONResponse({
                "ok": True,
                "question_id": question_id,
                "choice": choice,
                "resumed": False,
                "reason": f"Run continue failed to start: {r_data.get('error') if isinstance(r_data, dict) else r_data}",
                "continued_from": origin_run,
                "instructions": prompt,
            })
    else:
        await state.broadcast({"type": "changed", "areas": ["questions", "tasks", "runs"]})
        await state.broadcast({"type": "question_answered", "question_id": question_id, "choice": str(choice)})
        return JSONResponse({
            "ok": True,
            "question_id": question_id,
            "choice": choice,
            "resumed": False,
            "reason": reason,
        })


async def api_list_runs(request: Request) -> JSONResponse:
    cmd = ["run", "list", "--workspace", str(state.workspace), "--json"]
    task = request.query_params.get("task")
    if task:
        cmd.extend(["--task", task])
    note = request.query_params.get("note")
    if note:
        if not NOTE_ID_RE.match(note):
            return JSONResponse({"error": f"Invalid note ID {note!r}"}, status_code=400)
        cmd.extend(["--note", note])
    active = request.query_params.get("active")
    if active is not None and active.lower() in ("1", "true", "yes", ""):
        cmd.append("--active")

    code, data = await run_ai_orch(cmd)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_get_run(request: Request) -> JSONResponse:
    run_id = request.path_params["id"]
    if not RUN_ID_RE.match(run_id):
        return JSONResponse({"error": f"Invalid run ID {run_id!r}"}, status_code=400)
    cmd = ["run", "show", run_id, "--workspace", str(state.workspace), "--json"]
    code, data = await run_ai_orch(cmd)
    if code != 0:
        err_str = ""
        if isinstance(data, dict):
            err_str = str(data.get("error") or data.get("reason") or "").lower()
        elif isinstance(data, str):
            err_str = data.lower()
        if "not found" in err_str or "not-found" in err_str:
            return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)
        status_code = map_cli_status(code, data)
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)
    return JSONResponse(data if isinstance(data, dict) else {"run": data})


async def api_get_run_logs(request: Request) -> JSONResponse:
    run_id = request.path_params["id"]
    if not RUN_ID_RE.match(run_id):
        return JSONResponse({"error": f"Invalid run ID {run_id!r}"}, status_code=400)
    cmd = ["run", "logs", run_id, "--workspace", str(state.workspace), "--json"]
    since_offset = request.query_params.get("since_offset")
    if since_offset is not None and since_offset != "":
        cmd.extend(["--since-offset", str(since_offset)])
    tail = request.query_params.get("tail")
    if tail is not None and tail != "":
        cmd.extend(["--tail", str(tail)])

    code, data = await run_ai_orch(cmd)
    if code != 0:
        err_str = ""
        if isinstance(data, dict):
            err_str = str(data.get("error") or data.get("reason") or "").lower()
        elif isinstance(data, str):
            err_str = data.lower()
        if "not found" in err_str or "not-found" in err_str:
            return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)
        status_code = map_cli_status(code, data)
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)
    return JSONResponse(data if isinstance(data, dict) else {"logs": data})


async def api_cancel_run(request: Request) -> JSONResponse:
    run_id = request.path_params["id"]
    if not RUN_ID_RE.match(run_id):
        return JSONResponse({"error": f"Invalid run ID {run_id!r}"}, status_code=400)
    cmd = ["run", "cancel", run_id, "--workspace", str(state.workspace), "--json"]
    code, data = await run_ai_orch(cmd, timeout=60.0)
    if code != 0:
        err_str = ""
        if isinstance(data, dict):
            err_str = str(data.get("error") or data.get("reason") or "").lower()
        elif isinstance(data, str):
            err_str = data.lower()
        if "not found" in err_str or "not-found" in err_str:
            return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)
        status_code = map_cli_status(code, data)
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)
    await state.broadcast({"type": "run_cancelled", "run_id": run_id})
    return JSONResponse(data if isinstance(data, dict) else {"ok": True, "run_id": run_id, "status": "cancelled"})


async def api_mark_delivered_run(request: Request) -> JSONResponse:
    run_id = request.path_params["id"]
    if not RUN_ID_RE.match(run_id):
        return JSONResponse({"error": f"Invalid run ID {run_id!r}"}, status_code=400)
    try:
        body = await request.json()
    except Exception:
        body = {}
    cmd = ["run", "mark-delivered", run_id, "--workspace", str(state.workspace), "--json"]
    expect_hash = body.get("expect_task_hash") or body.get("expect_task_sha256")
    if expect_hash:
        cmd.extend(["--expect-task-hash", str(expect_hash)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "task_delivered", "run_id": run_id})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_apply_verdict_run(request: Request) -> JSONResponse:
    run_id = request.path_params["id"]
    if not RUN_ID_RE.match(run_id):
        return JSONResponse({"error": f"Invalid run ID {run_id!r}"}, status_code=400)
    try:
        body = await request.json()
    except Exception:
        body = {}
    panel_id = body.get("panel_id")
    if panel_id:
        cmd = ["run", "apply-verdict", "--panel", str(panel_id), "--workspace", str(state.workspace), "--json"]
    else:
        cmd = ["run", "apply-verdict", run_id, "--workspace", str(state.workspace), "--json"]

    expect_hash = body.get("expect_task_hash") or body.get("expect_task_sha256")
    if expect_hash:
        cmd.extend(["--expect-task-hash", str(expect_hash)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "verdict_applied", "run_id": run_id})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_cleanup_run(request: Request) -> JSONResponse:
    run_id = request.path_params["id"]
    if not RUN_ID_RE.match(run_id):
        return JSONResponse({"error": f"Invalid run ID {run_id!r}"}, status_code=400)
    try:
        body = await request.json()
    except Exception:
        body = {}
    cmd = ["run", "cleanup", run_id, "--workspace", str(state.workspace), "--json"]
    if body.get("discard"):
        cmd.append("--discard")
    if body.get("dry_run"):
        cmd.append("--dry-run")
    if body.get("expect_plan_hash"):
        cmd.extend(["--expect-plan-hash", str(body["expect_plan_hash"])])
        cmd.extend(["--requested-by", "ui"])

    code, data = await run_ai_orch(cmd)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_get_triage_proposal(request: Request) -> JSONResponse:
    run_id = request.path_params["id"]
    if not RUN_ID_RE.match(run_id):
        return JSONResponse({"error": f"Invalid run ID {run_id!r}"}, status_code=400)
    cmd = ["run", "show", run_id, "--workspace", str(state.workspace), "--json"]
    code, data = await run_ai_orch(cmd)
    if code != 0:
        err_str = ""
        if isinstance(data, dict):
            err_str = str(data.get("error") or data.get("reason") or "").lower()
        elif isinstance(data, str):
            err_str = data.lower()
        if "not found" in err_str or "not-found" in err_str:
            return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)
        status_code = map_cli_status(code, data)
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)

    run_record = (
        data.get("run")
        if (isinstance(data, dict) and isinstance(data.get("run"), dict))
        else (data if isinstance(data, dict) else {})
    )
    if run_record.get("mode") and run_record.get("mode") != "triage":
        return JSONResponse(
            {"error": f"Run '{run_id}' is not a triage run (mode={run_record.get('mode')})"},
            status_code=400,
        )

    proposal_status = run_record.get("proposal_status")
    proposal_error = run_record.get("proposal_error")

    proposal = run_record.get("triage_proposal") or run_record.get("proposal")
    if proposal is None:
        proposal_file = state.workspace / ".ai-orchestration" / "runs" / run_id / "triage-proposal.json"
        if proposal_file.is_file():
            try:
                proposal = json.loads(proposal_file.read_text(encoding="utf-8"))
            except Exception as e:
                if not proposal_error:
                    proposal_error = f"Failed to parse stored proposal JSON: {e}"

    if proposal_status is None and proposal is not None:
        proposal_status = "pending"

    return JSONResponse({
        "ok": True,
        "run_id": run_id,
        "proposal_status": proposal_status,
        "proposal_error": proposal_error,
        "proposal": proposal,
    })


async def api_accept_triage_run(request: Request) -> JSONResponse:
    run_id = request.path_params["id"]
    if not RUN_ID_RE.match(run_id):
        return JSONResponse({"error": f"Invalid run ID {run_id!r}"}, status_code=400)
    try:
        body = await request.json()
    except Exception:
        body = {}
    cmd = ["run", "accept-triage", run_id, "--workspace", str(state.workspace), "--json"]
    only = body.get("only")
    if only is not None:
        if isinstance(only, (list, tuple)):
            cmd.extend(["--only", ",".join(str(x) for x in only)])
        elif isinstance(only, (str, int)):
            cmd.extend(["--only", str(only).strip()])
    expect_note_hash = body.get("expect_note_hash")
    if expect_note_hash:
        cmd.extend(["--expect-note-hash", str(expect_note_hash).strip()])

    code, data = await run_ai_orch(cmd)
    if code != 0:
        err_str = ""
        if isinstance(data, dict):
            err_str = str(data.get("error") or data.get("reason") or "").lower()
        elif isinstance(data, str):
            err_str = data.lower()
        if "not found" in err_str or "not-found" in err_str:
            return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)
        status_code = map_cli_status(code, data)
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)

    await state.broadcast({"type": "changed", "areas": ["inbox", "tasks"]})
    return JSONResponse(data if isinstance(data, dict) else {"ok": True, "run_id": run_id, "proposal_status": "accepted"})


# ---------------------------------------------------------------------------
# REST Endpoints: Inbox Notes & Attachments (09.2)
# ---------------------------------------------------------------------------



async def api_list_inbox_notes(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    cmd = ["inbox", "list", "--tasks-dir", str(tasks_dir), "--json"]
    status = request.query_params.get("status")
    if status:
        cmd.extend(["--status", status])
    code, data = await run_ai_orch(cmd)
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_get_inbox_note(request: Request) -> JSONResponse:
    note_id = request.path_params["id"]
    if not NOTE_ID_RE.match(note_id):
        return JSONResponse({"error": f"Invalid note ID {note_id!r}, must match ^N\\d{{3,}}$"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["inbox", "show", note_id, "--tasks-dir", str(tasks_dir), "--json"]
    code, data = await run_ai_orch(cmd)
    if code != 0:
        err_str = ""
        if isinstance(data, dict):
            err_str = f"{data.get('error', '')} {data.get('message', '')} {data.get('reason', '')}".lower()
        elif isinstance(data, str):
            err_str = data.lower()
        if "not found" in err_str or "not-found" in err_str:
            return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)
        status_code = map_cli_status(code, data)
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)
    return JSONResponse(data if isinstance(data, dict) else {"note": data})


async def api_add_inbox_note(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}

    title = body.get("title")
    if not title or not str(title).strip():
        return JSONResponse({"error": "title is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["inbox", "add", "--title", str(title).strip(), "--tasks-dir", str(tasks_dir), "--json"]

    if body.get("kind"):
        cmd.extend(["--kind", str(body["kind"])])
    if body.get("about"):
        cmd.extend(["--about", str(body["about"])])
    if body.get("author"):
        cmd.extend(["--author", str(body["author"])])
    if body.get("status"):
        cmd.extend(["--status", str(body["status"])])

    temp_body_file: str | None = None
    body_text = body.get("body")
    try:
        if body_text is not None:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".md") as f:
                f.write(str(body_text))
                temp_body_file = f.name
            cmd.extend(["--body-file", temp_body_file])

        code, data = await run_ai_orch(cmd)
    finally:
        if temp_body_file:
            try:
                os.remove(temp_body_file)
            except OSError:
                pass

    if code == 0:
        note_id = data.get("id") if isinstance(data, dict) else None
        await state.broadcast({"type": "inbox_updated", "note_id": note_id})
    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_edit_inbox_note(request: Request) -> JSONResponse:
    note_id = request.path_params["id"]
    if not NOTE_ID_RE.match(note_id):
        return JSONResponse({"error": f"Invalid note ID {note_id!r}, must match ^N\\d{{3,}}$"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    tasks_dir = state.workspace / "tasks"
    cmd = ["inbox", "edit", note_id, "--tasks-dir", str(tasks_dir), "--json"]

    if "title" in body:
        cmd.extend(["--title", str(body["title"])])
    if "kind" in body:
        cmd.extend(["--kind", str(body["kind"])])
    if "about" in body:
        cmd.extend(["--about", str(body["about"])])
    if "author" in body:
        cmd.extend(["--author", str(body["author"])])
    if "status" in body:
        cmd.extend(["--status", str(body["status"])])
    if "expect_hash" in body:
        cmd.extend(["--expect-hash", str(body["expect_hash"])])

    temp_body_file: str | None = None
    body_text = body.get("body")
    try:
        if body_text is not None:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".md") as f:
                f.write(str(body_text))
                temp_body_file = f.name
            cmd.extend(["--body-file", temp_body_file])

        code, data = await run_ai_orch(cmd)
    finally:
        if temp_body_file:
            try:
                os.remove(temp_body_file)
            except OSError:
                pass

    if code == 0:
        await state.broadcast({"type": "inbox_updated", "note_id": note_id})
    else:
        err_str = ""
        if isinstance(data, dict):
            err_str = f"{data.get('error', '')} {data.get('message', '')} {data.get('reason', '')}".lower()
        elif isinstance(data, str):
            err_str = data.lower()
        if "not found" in err_str or "not-found" in err_str:
            return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_upload_inbox_attachment(request: Request) -> JSONResponse:
    note_id = request.path_params["id"]
    if not NOTE_ID_RE.match(note_id):
        return JSONResponse({"error": f"Invalid note ID {note_id!r}, must match ^N\\d{{3,}}$"}, status_code=400)

    content_type = request.headers.get("content-type", "")
    if not content_type.startswith("multipart/form-data"):
        return JSONResponse({"error": "Content-Type must be multipart/form-data"}, status_code=400)

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_ATTACHMENT_SIZE + 512 * 1024:
                return JSONResponse({"error": "Attachment exceeds 10 MB limit"}, status_code=413)
        except ValueError:
            pass

    try:
        form = await request.form()
    except Exception as exc:
        return JSONResponse({"error": f"Invalid multipart form: {exc}"}, status_code=400)

    upload_file = form.get("file")
    if not upload_file or not hasattr(upload_file, "read"):
        return JSONResponse({"error": "file field is required in multipart form"}, status_code=400)

    temp_path: pathlib.Path | None = None
    suffix = pathlib.Path(upload_file.filename).suffix if getattr(upload_file, "filename", None) else ".tmp"
    try:
        with tempfile.NamedTemporaryFile("wb", delete=False, suffix=suffix) as temp_f:
            temp_path = pathlib.Path(temp_f.name)
            total_read = 0
            while True:
                chunk = await upload_file.read(65536)
                if not chunk:
                    break
                total_read += len(chunk)
                if total_read > MAX_ATTACHMENT_SIZE:
                    temp_f.close()
                    temp_path.unlink(missing_ok=True)
                    temp_path = None
                    return JSONResponse({"error": "Attachment exceeds 10 MB limit"}, status_code=413)
                temp_f.write(chunk)

        tasks_dir = state.workspace / "tasks"
        cmd = ["inbox", "attach", note_id, "--file", str(temp_path), "--tasks-dir", str(tasks_dir), "--json"]
        if getattr(upload_file, "filename", None):
            stem = pathlib.Path(upload_file.filename).stem
            if stem:
                cmd.extend(["--name", stem])

        expect_hash = (
            form.get("expect_hash")
            or form.get("expect_note_hash")
            or request.query_params.get("expect_hash")
            or request.headers.get("x-expect-hash")
        )
        if expect_hash:
            cmd.extend(["--expect-hash", str(expect_hash)])

        code, data = await run_ai_orch(cmd)
        if code == 0:
            await state.broadcast({"type": "inbox_updated", "note_id": note_id})
            await state.broadcast({"type": "changed", "areas": ["inbox"]})
            return JSONResponse(data, status_code=200)

        err_str = ""
        if isinstance(data, dict):
            err_str = f"{data.get('error', '')} {data.get('message', '')} {data.get('reason', '')}".lower()
        elif isinstance(data, str):
            err_str = data.lower()
        if "not found" in err_str or "not-found" in err_str:
            return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)

        status_code = map_cli_status(code, data)
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)
    finally:
        if temp_path:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass


async def api_delete_inbox_attachment(request: Request) -> JSONResponse:
    note_id = request.path_params["id"]
    if not NOTE_ID_RE.match(note_id):
        return JSONResponse({"error": f"Invalid note ID {note_id!r}, must match ^N\\d{{3,}}$"}, status_code=400)

    name = request.path_params["name"]
    if not ATTACHMENT_NAME_RE.match(name):
        return JSONResponse({"error": f"Invalid attachment name {name!r}"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["inbox", "detach", note_id, "--name", name, "--tasks-dir", str(tasks_dir), "--json"]
    expect_hash = (
        request.query_params.get("expect_hash")
        or request.query_params.get("expect_note_hash")
        or request.headers.get("x-expect-hash")
    )
    if not expect_hash:
        try:
            body = await request.json()
            if isinstance(body, dict):
                expect_hash = body.get("expect_hash") or body.get("expect_note_hash")
        except Exception:
            pass
    if expect_hash:
        cmd.extend(["--expect-hash", str(expect_hash)])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "inbox_updated", "note_id": note_id})
        await state.broadcast({"type": "changed", "areas": ["inbox"]})
        return JSONResponse(data, status_code=200)

    err_str = ""
    if isinstance(data, dict):
        err_str = f"{data.get('error', '')} {data.get('message', '')} {data.get('reason', '')}".lower()
    elif isinstance(data, str):
        err_str = data.lower()
    if "not found" in err_str or "not-found" in err_str:
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_get_inbox_attachment(request: Request) -> Response:
    note_id = request.path_params["id"]
    if not NOTE_ID_RE.match(note_id):
        return JSONResponse({"error": f"Invalid note ID {note_id!r}, must match ^N\\d{{3,}}$"}, status_code=400)

    name = request.path_params["name"]
    if not ATTACHMENT_NAME_RE.match(name):
        return JSONResponse({"error": f"Invalid attachment name {name!r}"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    code, data = await run_ai_orch(["inbox", "show", note_id, "--tasks-dir", str(tasks_dir), "--json"])
    if code != 0 or not isinstance(data, dict) or not data.get("ok"):
        return JSONResponse({"error": f"Note {note_id} not found"}, status_code=404)

    folder_path_str = data.get("note", {}).get("folder_path")
    if not folder_path_str:
        return JSONResponse({"error": f"Note {note_id} folder not found"}, status_code=404)

    folder_path = pathlib.Path(folder_path_str).resolve()
    attachments_dir = (folder_path / "attachments").resolve()
    target_file = (attachments_dir / name).resolve()

    try:
        target_file.relative_to(attachments_dir)
    except ValueError:
        return JSONResponse({"error": "Path traversal detected"}, status_code=400)

    if not target_file.is_file():
        return JSONResponse({"error": f"Attachment {name!r} not found"}, status_code=404)

    file_bytes = target_file.read_bytes()
    return classify_and_serve_attachment(file_bytes, name)


async def api_resolve_inbox_note(request: Request) -> JSONResponse:
    note_id = request.path_params["id"]
    if not NOTE_ID_RE.match(note_id):
        return JSONResponse({"error": f"Invalid note ID {note_id!r}, must match ^N\\d{{3,}}$"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    produced = body.get("produced")
    if not produced or not str(produced).strip():
        return JSONResponse({"error": "produced is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["inbox", "resolve", note_id, "--produced", str(produced).strip(), "--tasks-dir", str(tasks_dir), "--json"]
    if body.get("by"):
        cmd.extend(["--by", str(body["by"])])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "inbox_updated", "note_id": note_id})
        return JSONResponse(data, status_code=200)

    err_str = ""
    if isinstance(data, dict):
        err_str = f"{data.get('error', '')} {data.get('message', '')} {data.get('reason', '')}".lower()
    elif isinstance(data, str):
        err_str = data.lower()
    if "not found" in err_str or "not-found" in err_str:
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_discard_inbox_note(request: Request) -> JSONResponse:
    note_id = request.path_params["id"]
    if not NOTE_ID_RE.match(note_id):
        return JSONResponse({"error": f"Invalid note ID {note_id!r}, must match ^N\\d{{3,}}$"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    reason = body.get("reason")
    if not reason or not str(reason).strip():
        return JSONResponse({"error": "reason is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["inbox", "discard", note_id, "--reason", str(reason).strip(), "--tasks-dir", str(tasks_dir), "--json"]

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "inbox_updated", "note_id": note_id})
        return JSONResponse(data, status_code=200)

    err_str = ""
    if isinstance(data, dict):
        err_str = f"{data.get('error', '')} {data.get('message', '')} {data.get('reason', '')}".lower()
    elif isinstance(data, str):
        err_str = data.lower()
    if "not found" in err_str or "not-found" in err_str:
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_reopen_inbox_note(request: Request) -> JSONResponse:
    note_id = request.path_params["id"]
    if not NOTE_ID_RE.match(note_id):
        return JSONResponse({"error": f"Invalid note ID {note_id!r}, must match ^N\\d{{3,}}$"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = ["inbox", "reopen", note_id, "--tasks-dir", str(tasks_dir), "--json"]

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "inbox_updated", "note_id": note_id})
        return JSONResponse(data, status_code=200)

    err_str = ""
    if isinstance(data, dict):
        err_str = f"{data.get('error', '')} {data.get('message', '')} {data.get('reason', '')}".lower()
    elif isinstance(data, str):
        err_str = data.lower()
    if "not found" in err_str or "not-found" in err_str:
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


async def api_inbox_to_task(request: Request) -> JSONResponse:
    note_id = request.path_params["id"]
    if not NOTE_ID_RE.match(note_id):
        return JSONResponse({"error": f"Invalid note ID {note_id!r}, must match ^N\\d{{3,}}$"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    category = body.get("category") or body.get("parent")
    if not category or not str(category).strip():
        return JSONResponse({"error": "category is required"}, status_code=400)

    title = body.get("title")
    if not title or not str(title).strip():
        return JSONResponse({"error": "title is required"}, status_code=400)

    tasks_dir = state.workspace / "tasks"
    cmd = [
        "tasks", "new",
        "--from-note", note_id,
        "--category", str(category).strip(),
        "--title", str(title).strip(),
        "--tasks-dir", str(tasks_dir),
        "--json",
    ]
    if body.get("priority"):
        cmd.extend(["--priority", str(body["priority"])])
    if body.get("priority_reason"):
        cmd.extend(["--priority-reason", str(body["priority_reason"])])
    if body.get("executor"):
        cmd.extend(["--executor", str(body["executor"])])
    if body.get("next_up"):
        cmd.extend(["--next-up", str(body["next_up"])])
    if body.get("depends_on"):
        cmd.extend(["--depends-on", str(body["depends_on"])])
    if body.get("decider"):
        cmd.extend(["--decider", str(body["decider"])])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        task_id = data.get("id") if isinstance(data, dict) else None
        await state.broadcast({"type": "task_created", "task_id": task_id, "from_note": note_id})
        await state.broadcast({"type": "inbox_updated", "note_id": note_id})
        return JSONResponse(data, status_code=200)

    err_str = ""
    if isinstance(data, dict):
        err_str = f"{data.get('error', '')} {data.get('message', '')} {data.get('reason', '')}".lower()
    elif isinstance(data, str):
        err_str = data.lower()
    if "not found" in err_str or "not-found" in err_str:
        return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=404)

    status_code = map_cli_status(code, data)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


# ---------------------------------------------------------------------------
# Use Cases & E2E Validation Endpoints (Spec 15)
# ---------------------------------------------------------------------------

async def api_list_use_cases(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    code, data = await run_ai_orch(["use-cases", "list", "--tasks-dir", str(tasks_dir), "--json"])
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=200 if code == 0 else 500)


async def api_get_use_case(request: Request) -> JSONResponse:
    uc_id = request.path_params["uc_id"]
    tasks_dir = state.workspace / "tasks"
    code, data = await run_ai_orch(["use-cases", "show", uc_id, "--tasks-dir", str(tasks_dir), "--json"])
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=200 if code == 0 else 404)


async def api_create_use_case(request: Request) -> JSONResponse:
    body = await request.json()
    tasks_dir = state.workspace / "tasks"
    cmd = [
        "use-cases", "create",
        "--id", str(body.get("id", "")),
        "--title", str(body.get("title", "")),
        "--tasks-dir", str(tasks_dir),
        "--json",
    ]
    for opt_field in ("actor", "status", "priority", "verification_type", "verification_command", "description", "preconditions", "scenario"):
        if body.get(opt_field):
            cmd.extend([f"--{opt_field.replace('_', '-')}", str(body[opt_field])])
    if body.get("linked_tasks"):
        lt_val = ",".join(body["linked_tasks"]) if isinstance(body["linked_tasks"], list) else str(body["linked_tasks"])
        cmd.extend(["--linked-tasks", lt_val])

    code, data = await run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "use_cases_changed", "action": "created", "id": body.get("id")})
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=200 if code == 0 else 400)


async def api_validate_use_case(request: Request) -> JSONResponse:
    uc_id = request.path_params["uc_id"]
    tasks_dir = state.workspace / "tasks"
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    timeout = str(body.get("timeout", 60))
    actor = str(body.get("actor", "automated-probe"))

    cmd = ["use-cases", "validate", uc_id, "--timeout", timeout, "--actor", actor, "--tasks-dir", str(tasks_dir), "--json"]
    code, data = await run_ai_orch(cmd)
    await state.broadcast({"type": "use_cases_changed", "action": "validated", "id": uc_id})
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=200)


async def api_run_campaign(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    cmd = ["use-cases", "campaign", "--tasks-dir", str(tasks_dir), "--json"]
    if body.get("filter_actor"):
        cmd.extend(["--filter-actor", str(body["filter_actor"])])
    code, data = await run_ai_orch(cmd)
    await state.broadcast({"type": "use_cases_changed", "action": "campaign_completed"})
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=200)


# ---------------------------------------------------------------------------
# WebSocket Endpoint: Live File & State Updates
# ---------------------------------------------------------------------------

async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    state.active_websockets.add(websocket)
    try:
        await websocket.send_json({"type": "connected", "workspace": str(state.workspace)})
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except (WebSocketDisconnect, Exception):
        state.active_websockets.discard(websocket)


# ---------------------------------------------------------------------------
# Application Scaffolding
# ---------------------------------------------------------------------------

routes = [
    Route("/", serve_index, methods=["GET"]),
    Route("/index.html", serve_index, methods=["GET"]),
    Route("/api/workspace", api_get_workspace, methods=["GET"]),
    Route("/api/tasks", api_list_tasks, methods=["GET"]),
    Route("/api/tasks/labels", api_list_labels, methods=["GET"]),
    Route("/api/tasks/micro", api_create_microtask, methods=["POST"]),
    Route("/api/tasks/validate", api_validate_tasks, methods=["GET"]),
    Route("/api/tasks/graph", api_get_tasks_graph, methods=["GET"]),
    Route("/api/tasks/{id}/priority/preview", api_preview_set_priority, methods=["POST"]),
    Route("/api/tasks/{id}/priority", api_set_priority, methods=["POST"]),
    Route("/api/tasks/{id}/size/preview", api_preview_set_size, methods=["POST"]),
    Route("/api/tasks/{id}/size", api_set_size, methods=["POST"]),
    Route("/api/tasks/{id}/deps/preview", api_preview_set_deps, methods=["POST"]),
    Route("/api/tasks/{id}/deps", api_set_deps, methods=["POST"]),
    Route("/api/tasks/{id}/kind/preview", api_preview_set_kind, methods=["POST"]),
    Route("/api/tasks/{id}/kind", api_set_kind, methods=["POST"]),
    Route("/api/tasks/{id}/labels/preview", api_preview_set_labels, methods=["POST"]),
    Route("/api/tasks/{id}/labels", api_set_labels, methods=["POST"]),
    Route("/api/tasks/{id}/promote/preview", api_preview_promote, methods=["POST"]),
    Route("/api/tasks/{id}/promote", api_promote, methods=["POST"]),
    Route("/api/tasks/{id}/child/preview", api_preview_child_add, methods=["POST"]),
    Route("/api/tasks/{id}/child", api_child_add, methods=["POST"]),
    Route("/api/tasks/{id}/children/preview", api_preview_child_add, methods=["POST"]),
    Route("/api/tasks/{id}/children", api_child_add, methods=["POST"]),
    Route("/api/tasks/child/preview", api_preview_child_add, methods=["POST"]),
    Route("/api/tasks/child", api_child_add, methods=["POST"]),
    Route("/api/tasks/{id}/expand/preview", api_preview_expand, methods=["POST"]),
    Route("/api/tasks/{id}/expand", api_expand, methods=["POST"]),
    Route("/api/tasks/expand/preview", api_preview_expand, methods=["POST"]),
    Route("/api/tasks/expand", api_expand, methods=["POST"]),
    Route("/api/tasks/{id}/collapse/preview", api_preview_collapse, methods=["POST"]),
    Route("/api/tasks/{id}/collapse", api_collapse, methods=["POST"]),
    Route("/api/tasks/collapse/preview", api_preview_collapse, methods=["POST"]),
    Route("/api/tasks/collapse", api_collapse, methods=["POST"]),
    Route("/api/tasks/{id}/reopen/preview", api_preview_reopen, methods=["POST"]),
    Route("/api/tasks/{id}/reopen", api_reopen, methods=["POST"]),
    Route("/api/tasks/reopen/preview", api_preview_reopen, methods=["POST"]),
    Route("/api/tasks/reopen", api_reopen, methods=["POST"]),
    Route("/api/tasks/transition", api_transition_task, methods=["POST"]),
    Route("/api/tasks/sync-index/preview", api_preview_sync_index, methods=["GET"]),
    Route("/api/tasks/sync-index", api_sync_index, methods=["POST"]),
    Route("/api/tasks/{id}/attachments", api_upload_task_attachment, methods=["POST"]),
    Route("/api/tasks/{id}/attachments/{name:path}", api_get_task_attachment, methods=["GET"]),
    Route("/api/tasks/{id}/attachments/{name:path}", api_delete_task_attachment, methods=["DELETE"]),
    Route("/api/tasks/{task_id}", api_get_task_detail, methods=["GET"]),
    Route("/api/questions", api_list_questions, methods=["GET"]),
    Route("/api/questions", api_ask_question, methods=["POST"]),
    Route("/api/questions/{question_id}", api_get_question, methods=["GET"]),
    Route("/api/questions/{question_id}/answer", api_answer_question, methods=["POST"]),
    Route("/api/questions/{question_id}/withdraw", api_withdraw_question, methods=["POST"]),
    Route("/api/env/status", api_env_status, methods=["GET"]),
    Route("/api/env/install-skills/preview", api_preview_install_skills, methods=["POST"]),
    Route("/api/env/install-skills", api_install_skills, methods=["POST"]),
    Route("/api/env/register-mcp/preview", api_preview_register_mcp, methods=["POST"]),
    Route("/api/env/register-mcp", api_register_mcp, methods=["POST"]),
    Route("/api/env/remove-skill/preview", api_preview_remove_skill, methods=["POST"]),
    Route("/api/env/remove-skill", api_remove_skill, methods=["POST"]),
    Route("/api/env/resolve-conflicts/preview", api_preview_resolve_conflicts, methods=["POST"]),
    Route("/api/env/resolve-conflicts", api_resolve_conflicts, methods=["POST"]),
    Route("/api/env/fetch-repos/preview", api_preview_fetch_repos, methods=["POST"]),
    Route("/api/env/fetch-repos", api_fetch_repos, methods=["POST"]),
    Route("/api/config/show", api_config_show, methods=["GET"]),
    Route("/api/config/set-profile/preview", api_preview_config_set_profile, methods=["POST"]),
    Route("/api/config/set-profile", api_config_set_profile, methods=["POST"]),
    Route("/api/config/set-routing/preview", api_preview_config_set_routing, methods=["POST"]),
    Route("/api/config/set-routing", api_config_set_routing, methods=["POST"]),
    Route("/api/config/render-agents-md", api_render_agents_md, methods=["GET"]),
    Route("/api/config/render-agents-md/preview", api_preview_agents_md, methods=["GET"]),
    Route("/api/config/render-agents-md/apply", api_apply_agents_md, methods=["POST"]),
    Route("/api/runs/options", api_run_options, methods=["GET"]),
    Route("/api/runs/preview", api_run_preview, methods=["POST"]),
    Route("/api/runs", api_list_runs, methods=["GET"]),
    Route("/api/runs", api_run_start, methods=["POST"]),
    Route("/api/runs/{id}", api_get_run, methods=["GET"]),
    Route("/api/runs/{id}/continue", api_run_continue, methods=["POST"]),
    Route("/api/questions/{id}/answer-and-resume/preview", api_preview_answer_and_resume, methods=["POST"]),
    Route("/api/questions/{id}/answer-and-resume", api_answer_and_resume, methods=["POST"]),
    Route("/api/questions/{question_id}/answer-and-resume/preview", api_preview_answer_and_resume, methods=["POST"]),
    Route("/api/questions/{question_id}/answer-and-resume", api_answer_and_resume, methods=["POST"]),
    Route("/api/runs/{id}/logs", api_get_run_logs, methods=["GET"]),
    Route("/api/runs/{id}/triage-proposal", api_get_triage_proposal, methods=["GET"]),
    Route("/api/runs/{id}/accept-triage", api_accept_triage_run, methods=["POST"]),
    Route("/api/runs/{id}/cancel", api_cancel_run, methods=["POST"]),
    Route("/api/runs/{id}/mark-delivered", api_mark_delivered_run, methods=["POST"]),
    Route("/api/runs/{id}/apply-verdict", api_apply_verdict_run, methods=["POST"]),
    Route("/api/runs/{id}/cleanup", api_cleanup_run, methods=["POST"]),
    Route("/api/inbox", api_list_inbox_notes, methods=["GET"]),
    Route("/api/inbox", api_add_inbox_note, methods=["POST"]),
    Route("/api/inbox/{id}", api_get_inbox_note, methods=["GET"]),
    Route("/api/inbox/{id}", api_edit_inbox_note, methods=["POST"]),
    Route("/api/inbox/{id}/attachments", api_upload_inbox_attachment, methods=["POST"]),
    Route("/api/inbox/{id}/attachments/{name:path}", api_get_inbox_attachment, methods=["GET"]),
    Route("/api/inbox/{id}/attachments/{name:path}", api_delete_inbox_attachment, methods=["DELETE"]),
    Route("/api/inbox/{id}/resolve", api_resolve_inbox_note, methods=["POST"]),
    Route("/api/inbox/{id}/discard", api_discard_inbox_note, methods=["POST"]),
    Route("/api/inbox/{id}/reopen", api_reopen_inbox_note, methods=["POST"]),
    Route("/api/inbox/{id}/to-task", api_inbox_to_task, methods=["POST"]),
    Route("/api/inbox/{id}/to-microtask", api_inbox_to_microtask, methods=["POST"]),
    Route("/api/use-cases", api_list_use_cases, methods=["GET"]),
    Route("/api/use-cases", api_create_use_case, methods=["POST"]),
    Route("/api/use-cases/campaign", api_run_campaign, methods=["POST"]),
    Route("/api/use-cases/{uc_id}", api_get_use_case, methods=["GET"]),
    Route("/api/use-cases/{uc_id}/validate", api_validate_use_case, methods=["POST"]),
    WebSocketRoute("/ws", ws_endpoint),
]

if dist_dir.is_dir():
    routes.append(Mount("/", app=SPAStaticFiles(directory=str(dist_dir), html=False), name="static"))
else:
    routes.append(Route("/{path:path}", serve_index, methods=["GET"]))

app = Starlette(
    routes=routes,
    lifespan=lifespan,
    middleware=[
        Middleware(AuthAndHostMiddleware),
    ],
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8780")), help="Port to listen on (default: 8780)")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"), help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--workspace", default=str(state.workspace), help="Initial workspace path")
    args = parser.parse_args()

    state.workspace = pathlib.Path(args.workspace).resolve()
    os.environ["PORT"] = str(args.port)
    os.environ["HOST"] = args.host
    import uvicorn
    print(f"==> AI Orchestration Server listening on http://{args.host}:{args.port}")
    print(f"==> Active Workspace: {state.workspace}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
