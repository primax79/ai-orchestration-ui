"""backend/broker/server.py — Minimal MCP broker over streamable HTTP with token auth.

Implements Task 16.1 spike:
1. Singleton instance via broker.lock (fcntl.flock LOCK_EX|LOCK_NB) in the config dir
   (respecting AI_ORCHESTRATION_CONFIG or ~/.config/ai-orchestration).
2. Writes broker.json {pid, port, started_at, token_file} only after holding the lock.
3. Streamable HTTP MCP server on 127.0.0.1 (random free port or user-specified), requiring
   the x-ai-orch-token header.
4. Tools: whoami, tasks_list(project_path), debug_sleep(seconds).
5. Module-level unread_notice test hook.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import fcntl
import hmac
import json
import logging
import os
import pathlib
import secrets
import socket
import sys
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send
import uvicorn

logger = logging.getLogger("ai-orchestration.broker")

# Module-level test hook (spec §5 / task 16.1):
# When set, append a one-line human-readable notice to the text content of tool results.
unread_notice: str | None = None


def _apply_notice(text: str) -> str:
    global unread_notice
    if unread_notice:
        notice_line = str(unread_notice).strip()
        if not text.endswith("\n"):
            text += "\n"
        text += f"\n{notice_line}"
    return text


def get_broker_config_dir() -> pathlib.Path:
    raw = os.environ.get("AI_ORCHESTRATION_CONFIG")
    if raw and raw.strip():
        p = pathlib.Path(raw).expanduser().resolve()
        if p.is_file() or p.suffix.lower() == ".toml":
            return p.parent
        return p
    raw_dir = os.environ.get("AI_ORCH_CONFIG_DIR")
    if raw_dir and raw_dir.strip():
        return pathlib.Path(raw_dir).expanduser().resolve()
    raw_home = os.environ.get("AI_ORCH_HOME")
    if raw_home and raw_home.strip():
        return (pathlib.Path(raw_home).expanduser() / ".config" / "ai-orchestration").resolve()
    return (pathlib.Path.home() / ".config" / "ai-orchestration").resolve()


def get_or_create_token(config_dir: pathlib.Path | None = None) -> str:
    if config_dir is None:
        config_dir = get_broker_config_dir()
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


def get_ai_orch_bin() -> pathlib.Path:
    if "AI_ORCH_BIN" in os.environ and os.environ["AI_ORCH_BIN"].strip():
        return pathlib.Path(os.environ["AI_ORCH_BIN"]).expanduser().resolve()
    # Find relative to current file or parents
    broker_root = pathlib.Path(__file__).resolve().parent
    ui_root = broker_root.parent.parent
    sibling = ui_root.parent / "ai-orchestration" / "bin" / "ai-orch"
    if sibling.is_file():
        return sibling
    for parent in ui_root.parents:
        cand = parent / "ai-orchestration" / "bin" / "ai-orch"
        if cand.is_file():
            return cand
    return sibling


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def acquire_broker_lock(config_dir: pathlib.Path) -> int:
    config_dir.mkdir(parents=True, exist_ok=True)
    lock_file = config_dir / "broker.lock"
    fd = os.open(str(lock_file), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (BlockingIOError, OSError):
        try:
            os.close(fd)
        except OSError:
            pass
        sys.stderr.write("Broker is already running (locked by another process)\n")
        sys.stderr.flush()
        sys.exit(1)
    return fd


def write_broker_json(config_dir: pathlib.Path, port: int, token_file: pathlib.Path) -> None:
    data = {
        "pid": os.getpid(),
        "port": port,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "token_file": str(token_file.resolve()),
    }
    target = config_dir / "broker.json"
    tmp = config_dir / f"broker.json.tmp.{os.getpid()}"
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(target)


class BrokerTokenAuthMiddleware:
    def __init__(self, app: ASGIApp, token: str):
        self.app = app
        self.token = token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path == "/health":
                response = JSONResponse({"status": "ok", "pid": os.getpid()})
                await response(scope, receive, send)
                return

            headers = dict(scope.get("headers", []))
            token_hdr = headers.get(b"x-ai-orch-token", b"").decode("latin1")
            auth_hdr = headers.get(b"authorization", b"").decode("latin1")
            bearer_token = ""
            if auth_hdr.lower().startswith("bearer "):
                bearer_token = auth_hdr[7:].strip()

            candidate = token_hdr or bearer_token
            if not candidate or not hmac.compare_digest(candidate, self.token):
                response = JSONResponse({"error": "unauthorized"}, status_code=401)
                await response(scope, receive, send)
                return

        await self.app(scope, receive, send)


def create_broker_server(config_dir: pathlib.Path) -> MCPServer:
    server = MCPServer(
        "ai-orchestration-broker",
        version="0.1.0",
        instructions="ai-orchestration broker MCP server",
    )

    async def _handle_whoami() -> CallToolResult:
        data = {
            "pid": os.getpid(),
            "version": "0.1.0",
            "config_dir": str(config_dir),
            "bound_client": None,
        }
        text = _apply_notice(json.dumps(data, indent=2))
        return CallToolResult(content=[TextContent(type="text", text=text)], is_error=False)

    server.tool(name="whoami")(_handle_whoami)

    async def _handle_tasks_list(project_path: str) -> CallToolResult:
        p = pathlib.Path(project_path).resolve()
        if not p.exists():
            return CallToolResult(
                content=[TextContent(type="text", text=_apply_notice(f"Error: Project path does not exist: {project_path}"))],
                is_error=True,
            )
        if not p.is_dir():
            return CallToolResult(
                content=[TextContent(type="text", text=_apply_notice(f"Error: Project path is not a directory: {project_path}"))],
                is_error=True,
            )
        tasks_dir = p / "tasks"
        if not tasks_dir.is_dir():
            return CallToolResult(
                content=[TextContent(type="text", text=_apply_notice(f"Error: Path {project_path} does not contain a tasks/ directory"))],
                is_error=True,
            )
        index_file = tasks_dir / "00-INDEX.md"
        if not index_file.is_file():
            return CallToolResult(
                content=[TextContent(type="text", text=_apply_notice(f"Error: Path {project_path}/tasks does not contain 00-INDEX.md"))],
                is_error=True,
            )

        bin_path = get_ai_orch_bin()
        if not bin_path.is_file():
            return CallToolResult(
                content=[TextContent(type="text", text=_apply_notice(f"Error: ai-orch CLI not found at {bin_path}"))],
                is_error=True,
            )

        cmd = [str(bin_path), "tasks", "list", "--tasks-dir", str(tasks_dir), "--json"]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            stdout_b, stderr_b = await proc.communicate()
            stdout_text = stdout_b.decode("utf-8", errors="replace").strip()
            stderr_text = stderr_b.decode("utf-8", errors="replace").strip()
            if proc.returncode != 0:
                err_text = stderr_text or stdout_text or f"CLI exited with {proc.returncode}"
                return CallToolResult(
                    content=[TextContent(type="text", text=_apply_notice(f"Error: {err_text}"))],
                    is_error=True,
                )
            return CallToolResult(
                content=[TextContent(type="text", text=_apply_notice(stdout_text))],
                is_error=False,
            )
        except Exception as exc:
            return CallToolResult(
                content=[TextContent(type="text", text=_apply_notice(f"Error executing tasks list: {exc}"))],
                is_error=True,
            )

    server.tool(name="tasks_list")(_handle_tasks_list)
    server.tool(name="tasks.list")(_handle_tasks_list)

    async def _handle_debug_sleep(seconds: int = 1) -> CallToolResult:
        if seconds < 0 or seconds > 120:
            return CallToolResult(
                content=[TextContent(type="text", text=_apply_notice(f"Error: seconds must be between 0 and 120, got {seconds}"))],
                is_error=True,
            )
        await asyncio.sleep(seconds)
        return CallToolResult(
            content=[TextContent(type="text", text=_apply_notice(f"Slept for {seconds} seconds"))],
            is_error=False,
        )

    server.tool(name="debug_sleep")(_handle_debug_sleep)
    server.tool(name="debug.sleep")(_handle_debug_sleep)

    return server


async def serve_async(
    port: int | None = None,
    host: str = "127.0.0.1",
    config_dir: pathlib.Path | None = None,
) -> None:
    if config_dir is None:
        config_dir = get_broker_config_dir()
    lock_fd = acquire_broker_lock(config_dir)

    if port is None or port == 0:
        port = find_free_port()

    token = get_or_create_token(config_dir)
    token_file = config_dir / "ui-token"
    write_broker_json(config_dir, port, token_file)

    server = create_broker_server(config_dir)
    sec = TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
        allowed_hosts=["*"],
        allowed_origins=["*"],
    )
    starlette_app = server.streamable_http_app(
        transport_security=sec,
        streamable_http_path="/mcp",
    )
    app = BrokerTokenAuthMiddleware(starlette_app, token)

    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level="info",
    )
    uv_server = uvicorn.Server(config)

    def cleanup() -> None:
        try:
            target = config_dir / "broker.json"
            if target.is_file():
                content = json.loads(target.read_text(encoding="utf-8"))
                if content.get("pid") == os.getpid():
                    target.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(lock_fd)
        except OSError:
            pass

    try:
        await uv_server.serve()
    finally:
        cleanup()


def serve(
    port: int | None = None,
    host: str = "127.0.0.1",
    config_dir: pathlib.Path | None = None,
) -> None:
    asyncio.run(serve_async(port=port, host=host, config_dir=config_dir))
