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
import hmac
import json
import os
import pathlib
import re
import secrets
import signal
import sys
from typing import Any, AsyncGenerator
from urllib.parse import parse_qs

from starlette.applications import Starlette
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


async def run_ai_orch(args: list[str], timeout: float | None = None) -> tuple[int, dict[str, Any] | str]:
    """Execute `./bin/ai-orch <args...>` asynchronously and return (exit_code, parsed_json_or_text)."""
    bin_path = get_ai_orch_bin()
    if not bin_path.is_file():
        return 1, f"ai-orch CLI not found at {bin_path}"

    cmd_args = list(args)
    if cmd_args and cmd_args[0] == "env":
        home = get_ai_orch_home()
        if home and "--home" not in cmd_args:
            cmd_args = ["env", "--home", str(home), *cmd_args[1:]]

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
        if data.get("error") == "stale-task":
            return 409
        err_val = data.get("error") or data.get("message") or ""
        err_str = str(err_val).lower()
    elif isinstance(data, str):
        err_str = data.lower()

    if (
        "hash mismatch" in err_str
        or "plan hash mismatch" in err_str
        or "stale" in err_str
        or "refusing to apply" in err_str
        or "workspace has no project config" in err_str
        or "no project config" in err_str
    ):
        return 409

    if (
        "required" in err_str
        or "invalid" in err_str
        or "unknown" in err_str
        or "unrecognized" in err_str
        or "not found" in err_str
        or "validation" in err_str
        or "illegal transition" in err_str
        or "cannot transition" in err_str
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
    "img-src 'self' data:; "
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
            for p in tasks_dir.rglob("*.md"):
                try:
                    if p.is_file():
                        mtimes[f"tasks:{p}"] = p.stat().st_mtime
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
                    elif k.startswith("tasks:"):
                        changed_areas.add("tasks")

            if changed_areas:
                await asyncio.sleep(0.3)
                debounce_snapshot = snapshot_watched_files(state.workspace, get_config_dir())
                for k in set(debounce_snapshot.keys()) | set(current_snapshot.keys()):
                    if debounce_snapshot.get(k) != current_snapshot.get(k):
                        if k.startswith("config:"):
                            changed_areas.add("config")
                        elif k.startswith("tasks:"):
                            changed_areas.add("tasks")
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
            elif p.suffix == ".md" and "tasks" in p.parts:
                areas.add("tasks")
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
    code, data = await run_ai_orch(["tasks", "list", "--tasks-dir", str(tasks_dir), "--json"])
    if code != 0:
        return JSONResponse({"error": data} if not isinstance(data, dict) else data, status_code=504 if code == 504 else 500)
    return JSONResponse(data)


async def api_validate_tasks(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    code, data = await run_ai_orch(["tasks", "validate", "--tasks-dir", str(tasks_dir), "--json"])
    status_code = 504 if code == 504 else (200 if code == 0 else 400)
    return JSONResponse(data if isinstance(data, dict) else {"error": data}, status_code=status_code)


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


async def api_get_task_detail(request: Request) -> JSONResponse:
    task_id = request.path_params["task_id"]
    tasks_dir = state.workspace / "tasks"

    candidates = list(tasks_dir.glob(f"*/{task_id}-*.md")) + list(tasks_dir.glob(f"*/{task_id}/README.md"))
    candidates += list(tasks_dir.glob(f"done/*/{task_id}-*.md")) + list(tasks_dir.glob(f"done/*/{task_id}/README.md"))

    if not candidates:
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
    Route("/api/tasks/validate", api_validate_tasks, methods=["GET"]),
    Route("/api/tasks/transition", api_transition_task, methods=["POST"]),
    Route("/api/tasks/sync-index/preview", api_preview_sync_index, methods=["GET"]),
    Route("/api/tasks/sync-index", api_sync_index, methods=["POST"]),
    Route("/api/tasks/{task_id}", api_get_task_detail, methods=["GET"]),
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
