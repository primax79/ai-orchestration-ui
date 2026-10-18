"""backend/broker/shim.py — stdio MCP shim for ai-orchestration broker.

Implements Task 16.1 spike:
1. Speaks MCP over stdio to the client.
2. Answers `initialize` immediately with static capabilities.
3. Then ensures a broker: reads broker.json; if absent/stale takes broker.launch.lock (non-blocking),
   starts `broker serve` detached, others poll readiness (50 ms backoff, timeout).
4. Forwards subsequent requests to the broker over streamable HTTP with x-ai-orch-token and relays responses.
5. If the broker dies mid-session, the next request triggers a relaunch and one retry.
"""
from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import pathlib
import socket
import subprocess
import sys
import time
from typing import Any

if __package__ is None or __package__ == "":
    repo_root = pathlib.Path(__file__).resolve().parent.parent.parent
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
import httpx2

logger = logging.getLogger("ai-orchestration.shim")
if not logger.handlers:
    h = logging.StreamHandler(sys.stderr)
    h.setFormatter(logging.Formatter("%(asctime)s [shim] %(levelname)s %(message)s"))
    logger.addHandler(h)
logger.setLevel(logging.INFO)


def get_config_dir() -> pathlib.Path:
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


def is_broker_alive(info: dict[str, Any]) -> bool:
    pid = info.get("pid")
    port = info.get("port")
    if not pid or not port:
        return False
    # 1. Process check
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError):
        return False
    # 2. Port connectivity check
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.3):
            return True
    except OSError:
        return False


def read_broker_json(config_dir: pathlib.Path) -> dict[str, Any] | None:
    broker_json = config_dir / "broker.json"
    if not broker_json.is_file():
        return None
    try:
        data = json.loads(broker_json.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "port" in data and "pid" in data:
            return data
    except Exception:
        pass
    return None


async def ensure_broker(config_dir: pathlib.Path, timeout: float = 10.0) -> dict[str, Any]:
    info = read_broker_json(config_dir)
    if info and is_broker_alive(info):
        token_file = pathlib.Path(info.get("token_file", str(config_dir / "ui-token")))
        if token_file.is_file():
            token = token_file.read_text(encoding="utf-8").strip()
            if token:
                info["token"] = token
                return info

    config_dir.mkdir(parents=True, exist_ok=True)
    launch_lock_path = config_dir / "broker.launch.lock"
    launch_fd = os.open(str(launch_lock_path), os.O_CREAT | os.O_RDWR, 0o600)
    got_launch_lock = False
    try:
        fcntl.flock(launch_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        got_launch_lock = True
    except (BlockingIOError, OSError):
        got_launch_lock = False

    if got_launch_lock:
        try:
            # Re-check under launch lock (double-checked pattern)
            info = read_broker_json(config_dir)
            if not (info and is_broker_alive(info)):
                ui_root = pathlib.Path(__file__).resolve().parent.parent.parent
                venv_python = ui_root / ".venv" / "bin" / "python"
                py_exe = str(venv_python) if venv_python.is_file() else sys.executable
                cmd = [py_exe, "-m", "backend.broker", "serve"]
                subprocess.Popen(
                    cmd,
                    cwd=str(ui_root),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                    env=os.environ.copy(),
                )
        except Exception as exc:
            logger.warning("Failed to start detached broker: %s", exc)

    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            info = read_broker_json(config_dir)
            if info and is_broker_alive(info):
                token_file = pathlib.Path(info.get("token_file", str(config_dir / "ui-token")))
                if token_file.is_file():
                    token = token_file.read_text(encoding="utf-8").strip()
                    if token:
                        info["token"] = token
                        return info
            await asyncio.sleep(0.05)
        raise TimeoutError(f"Broker failed to become ready within {timeout}s")
    finally:
        if got_launch_lock:
            try:
                fcntl.flock(launch_fd, fcntl.LOCK_UN)
            except OSError:
                pass
        try:
            os.close(launch_fd)
        except OSError:
            pass


async def _call_broker_api(url: str, token: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
    headers = {"x-ai-orch-token": token}
    async with httpx2.AsyncClient(headers=headers, timeout=130.0) as client:
        async with streamable_http_client(url, http_client=client) as (r, w):
            async with ClientSession(r, w) as session:
                await session.initialize()
                if method == "tools/list":
                    res = await session.list_tools()
                    return res.model_dump(by_alias=True, mode="json")
                elif method == "tools/call":
                    tool_name = params.get("name", "")
                    tool_args = params.get("arguments", {})
                    res = await session.call_tool(tool_name, tool_args)
                    return res.model_dump(by_alias=True, mode="json")
                elif method == "prompts/list":
                    res = await session.list_prompts()
                    return res.model_dump(by_alias=True, mode="json")
                elif method == "resources/list":
                    res = await session.list_resources()
                    return res.model_dump(by_alias=True, mode="json")
                elif method == "ping":
                    await session.send_ping()
                    return {}
                else:
                    raise ValueError(f"Method not found: {method}")


async def dispatch_request(method: str, params: dict[str, Any], config_dir: pathlib.Path) -> dict[str, Any]:
    for attempt in range(2):
        try:
            info = await ensure_broker(config_dir)
            url = f"http://127.0.0.1:{info['port']}/mcp"
            token = info["token"]
            return await _call_broker_api(url, token, method, params)
        except Exception as exc:
            if attempt == 0:
                logger.warning("Broker dispatch failed on attempt 0 (%s), relaunching and retrying...", exc)
                await asyncio.sleep(0.1)
                continue
            raise


def write_jsonrpc_response(payload: dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    sys.stdout.write(line)
    sys.stdout.flush()


async def main() -> None:
    config_dir = get_config_dir()

    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        stripped = line.strip()
        if not stripped:
            continue

        try:
            req = json.loads(stripped)
        except Exception:
            continue

        if not isinstance(req, dict):
            continue

        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}

        # 1. Answer initialize immediately with static capabilities
        if method == "initialize":
            init_response = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": params.get("protocolVersion", "2024-11-05"),
                    "capabilities": {
                        "tools": {"listChanged": False}
                    },
                    "serverInfo": {
                        "name": "ai-orchestration-broker-shim",
                        "version": "0.1.0"
                    }
                }
            }
            write_jsonrpc_response(init_response)
            continue

        # 2. Initialized notification from client
        if method == "notifications/initialized":
            continue

        # 3. Notification (no id)
        if req_id is None:
            continue

        # 4. Standard requests
        try:
            result = await dispatch_request(method, params, config_dir)
            write_jsonrpc_response({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": result,
            })
        except Exception as exc:
            err_code = -32601 if "Method not found" in str(exc) else -32603
            write_jsonrpc_response({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": err_code,
                    "message": str(exc),
                }
            })


if __name__ == "__main__":
    asyncio.run(main())
