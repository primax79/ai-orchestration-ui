"""Unit tests for ai-orchestration-ui backend/server.py."""
from __future__ import annotations

import asyncio
import os
import pathlib
import sys
import tempfile
import time

import httpx
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

# Set test environment defaults before importing server
os.environ.setdefault("AI_ORCH_ALLOWED_HOSTS", "testserver,localhost,127.0.0.1,localhost:8780,127.0.0.1:8780")
if not os.environ.get("AI_ORCH_BIN"):
    candidate_bin = pathlib.Path("/Users/Alfredo/works/ai-coding-tools/ai-orchestration/bin/ai-orch")
    if candidate_bin.is_file():
        os.environ["AI_ORCH_BIN"] = str(candidate_bin)

from server import CSP_HEADER, app, get_initial_workspace, get_or_create_token, run_ai_orch, state  # noqa: E402

client = TestClient(app)


def test_token_persistence_and_permissions(monkeypatch, tmp_path):
    config_dir = tmp_path / "config"
    monkeypatch.setenv("AI_ORCH_CONFIG_DIR", str(config_dir))

    tok1 = get_or_create_token()
    token_file = config_dir / "ui-token"
    assert token_file.is_file()
    assert (token_file.stat().st_mode & 0o777) == 0o600
    assert len(tok1) >= 32

    # Re-reading reuses the same token
    tok2 = get_or_create_token()
    assert tok1 == tok2


def test_serve_frontend_index_and_meta_token():
    token = get_or_create_token()
    res = client.get("/")
    assert res.status_code == 200
    assert res.headers.get("cache-control") == "no-store"
    assert res.headers.get("content-security-policy") == CSP_HEADER
    assert f'<meta name="ai-orch-token" content="{token}">' in res.text

    # /index.html
    res_index = client.get("/index.html")
    assert res_index.status_code == 200
    assert res_index.headers.get("cache-control") == "no-store"
    assert res_index.headers.get("content-security-policy") == CSP_HEADER
    assert f'<meta name="ai-orch-token" content="{token}">' in res_index.text

    # SPA route fallback
    res_spa = client.get("/some/spa/route")
    assert res_spa.status_code == 200
    assert res_spa.headers.get("cache-control") == "no-store"
    assert res_spa.headers.get("content-security-policy") == CSP_HEADER
    assert f'<meta name="ai-orch-token" content="{token}">' in res_spa.text

    # Assert individual CSP directives
    csp = res.headers["content-security-policy"]
    assert "default-src 'self'" in csp
    assert "script-src 'self'" in csp
    assert "style-src 'self' 'unsafe-inline'" in csp
    assert "connect-src 'self' ws://127.0.0.1:* ws://localhost:*" in csp
    assert "object-src 'none'" in csp
    assert "base-uri 'none'" in csp
    assert "frame-ancestors 'none'" in csp
    # Script-src must never allow 'unsafe-inline'
    script_part = [part for part in csp.split(";") if "script-src" in part][0]
    assert "'unsafe-inline'" not in script_part


def test_api_auth_token():
    token = get_or_create_token()

    # Without token -> 401
    res_no_tok = client.get("/api/workspace")
    assert res_no_tok.status_code == 401
    assert res_no_tok.json() == {"error": "unauthorized"}

    # Wrong token -> 401
    res_wrong_tok = client.get("/api/workspace", headers={"X-AI-Orch-Token": "bad-token-xyz"})
    assert res_wrong_tok.status_code == 401
    assert res_wrong_tok.json() == {"error": "unauthorized"}

    # Right token -> 200
    res_ok = client.get("/api/workspace", headers={"X-AI-Orch-Token": token})
    assert res_ok.status_code == 200
    data = res_ok.json()
    assert "workspace_path" in data
    assert "has_tasks_dir" in data


def test_bad_host_rejected():
    token = get_or_create_token()

    # Bad host on API endpoint -> 400
    res_bad = client.get("/api/workspace", headers={"Host": "evil.com", "X-AI-Orch-Token": token})
    assert res_bad.status_code == 400

    # Bad host on frontend endpoint -> 400
    res_bad_fe = client.get("/", headers={"Host": "evil.com"})
    assert res_bad_fe.status_code == 400


def test_ws_auth():
    token = get_or_create_token()

    # WS without token -> handshake rejected with code 4401
    with pytest.raises(WebSocketDisconnect) as exc_info_no_tok:
        with client.websocket_connect("/ws") as sock:
            sock.receive_json()
    assert exc_info_no_tok.value.code == 4401

    # WS with wrong token -> handshake rejected with code 4401
    with pytest.raises(WebSocketDisconnect) as exc_info_bad_tok:
        with client.websocket_connect("/ws?token=invalid") as sock:
            sock.receive_json()
    assert exc_info_bad_tok.value.code == 4401

    # WS with right token -> connected
    with client.websocket_connect(f"/ws?token={token}") as sock:
        msg = sock.receive_json()
        assert msg.get("type") == "connected"
        assert "workspace" in msg


@pytest.mark.anyio
async def test_slow_cli_non_blocking(monkeypatch):
    token = get_or_create_token()

    # Create a stub script that sleeps 3 seconds then returns valid JSON
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(
            "import sys, time\n"
            "time.sleep(3)\n"
            'print(\'{"tasks": [], "initiatives": [], "stats": {"total": 0}}\')\n'
        )
        stub_path = f.name

    try:
        # Create a workspace with a tasks/ directory so api_list_tasks executes CLI
        with tempfile.TemporaryDirectory() as tmp_ws:
            ws_path = pathlib.Path(tmp_ws)
            (ws_path / "tasks").mkdir()
            old_ws = state.workspace
            state.workspace = ws_path
            monkeypatch.setenv("AI_ORCH_BIN", stub_path)

            try:
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as async_client:
                    # Launch slow CLI request
                    slow_task = asyncio.create_task(
                        async_client.get("/api/tasks", headers={"X-AI-Orch-Token": token})
                    )
                    # Yield to event loop to allow slow CLI process to spawn
                    await asyncio.sleep(0.2)

                    # Concurrently launch fast workspace request
                    start_time = time.monotonic()
                    fast_res = await async_client.get("/api/workspace", headers={"X-AI-Orch-Token": token})
                    elapsed = time.monotonic() - start_time

                    assert fast_res.status_code == 200
                    # Fast request must complete quickly, not blocked by the 3s stub
                    assert elapsed < 1.5

                    # Await slow task completion
                    slow_res = await slow_task
                    assert slow_res.status_code == 200
            finally:
                state.workspace = old_ws
    finally:
        try:
            os.remove(stub_path)
        except OSError:
            pass


def test_watcher_broadcasts_on_file_change(monkeypatch):
    token = get_or_create_token()
    monkeypatch.setenv("AI_ORCH_WATCH_POLLING", "1")
    monkeypatch.setenv("AI_ORCH_WATCH_INTERVAL", "0.5")

    with tempfile.TemporaryDirectory() as tmp_ws:
        ws_path = pathlib.Path(tmp_ws)
        tasks_dir = ws_path / "tasks"
        tasks_dir.mkdir()
        initial_file = tasks_dir / "T001.md"
        initial_file.write_text("initial task content", encoding="utf-8")

        old_ws = state.workspace
        state.workspace = ws_path

        try:
            # Use TestClient context manager to activate lifespan (startup/shutdown of watcher)
            with TestClient(app) as test_client:
                with test_client.websocket_connect(f"/ws?token={token}") as ws:
                    init_msg = ws.receive_json()
                    assert init_msg.get("type") == "connected"

                    # Touch file in tasks
                    time.sleep(0.1)
                    initial_file.write_text("modified task content", encoding="utf-8")

                    # Wait for changed broadcast within 2 seconds
                    broadcast_msg = ws.receive_json()
                    assert broadcast_msg.get("type") == "changed"
                    assert "tasks" in broadcast_msg.get("areas", [])
        finally:
            state.workspace = old_ws


def test_ai_orch_workspace_honoured(monkeypatch):
    token = get_or_create_token()
    with tempfile.TemporaryDirectory() as tmp_ws:
        ws_path = pathlib.Path(tmp_ws).resolve()
        monkeypatch.setenv("AI_ORCH_WORKSPACE", str(ws_path))

        assert get_initial_workspace() == ws_path

        old_ws = state.workspace
        state.workspace = ws_path
        try:
            res = client.get("/api/workspace", headers={"X-AI-Orch-Token": token})
            assert res.status_code == 200
            data = res.json()
            assert data["workspace_path"] == str(ws_path)
        finally:
            state.workspace = old_ws


def test_env_status_with_token():
    token = get_or_create_token()
    res = client.get("/api/env/status", headers={"X-AI-Orch-Token": token})
    assert res.status_code == 200
    data = res.json()
    assert "clis" in data
    assert "environments" in data


def test_config_show_with_token():
    token = get_or_create_token()
    res = client.get("/api/config/show", headers={"X-AI-Orch-Token": token})
    assert res.status_code == 200
    data = res.json()
    assert "config" in data
    assert "routing" in data["config"]


def test_render_agents_md_with_token():
    token = get_or_create_token()
    res = client.get("/api/config/render-agents-md", headers={"X-AI-Orch-Token": token})
    assert res.status_code == 200
    data = res.json()
    assert "rendered_block" in data
    assert "<!-- BEGIN ai-orchestration -->" in data["rendered_block"]


@pytest.mark.anyio
async def test_process_group_cleanup_grandchild(monkeypatch, tmp_path):
    child_pid_file = tmp_path / "child.pid"
    grandchild_pid_file = tmp_path / "grandchild.pid"

    # Stub CLI script that writes its PID, spawns a grandchild writing its PID, then sleeps
    stub_script = tmp_path / "stub_grandchild.sh"
    stub_script.write_text(
        f"#!/bin/sh\n"
        f"echo $$ > '{child_pid_file}'\n"
        f"sleep 30 &\n"
        f"echo $! > '{grandchild_pid_file}'\n"
        f"sleep 30\n",
        encoding="utf-8",
    )
    stub_script.chmod(0o755)

    monkeypatch.setenv("AI_ORCH_BIN", str(stub_script))

    # Execute run_ai_orch with 1s timeout
    code, res = await run_ai_orch([], timeout=1.0)
    assert code == 504
    assert isinstance(res, dict)
    assert "CLI command timed out" in res.get("error", "")

    assert child_pid_file.is_file()
    assert grandchild_pid_file.is_file()

    child_pid = int(child_pid_file.read_text(encoding="utf-8").strip())
    grandchild_pid = int(grandchild_pid_file.read_text(encoding="utf-8").strip())

    # Wait briefly for OS process cleanup
    for _ in range(20):
        try:
            os.kill(child_pid, 0)
            time.sleep(0.05)
        except (ProcessLookupError, OSError):
            break

    for _ in range(20):
        try:
            os.kill(grandchild_pid, 0)
            time.sleep(0.05)
        except (ProcessLookupError, OSError):
            break

    # After the 504, both the child and grandchild PIDs are gone (os.kill(pid, 0) raises)
    with pytest.raises(ProcessLookupError):
        os.kill(child_pid, 0)

    with pytest.raises(ProcessLookupError):
        os.kill(grandchild_pid, 0)


@pytest.mark.anyio
async def test_process_group_cleanup_on_cancellation(monkeypatch, tmp_path):
    child_pid_file = tmp_path / "child.pid"
    grandchild_pid_file = tmp_path / "grandchild.pid"

    stub_script = tmp_path / "stub_cancel.sh"
    stub_script.write_text(
        f"#!/bin/sh\n"
        f"echo $$ > '{child_pid_file}'\n"
        f"sleep 30 &\n"
        f"echo $! > '{grandchild_pid_file}'\n"
        f"sleep 30\n",
        encoding="utf-8",
    )
    stub_script.chmod(0o755)

    monkeypatch.setenv("AI_ORCH_BIN", str(stub_script))

    task = asyncio.create_task(run_ai_orch([], timeout=30.0))
    for _ in range(20):
        if child_pid_file.is_file() and grandchild_pid_file.is_file():
            break
        await asyncio.sleep(0.05)

    child_pid = int(child_pid_file.read_text(encoding="utf-8").strip())
    grandchild_pid = int(grandchild_pid_file.read_text(encoding="utf-8").strip())

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    for _ in range(20):
        try:
            os.kill(child_pid, 0)
            time.sleep(0.05)
        except (ProcessLookupError, OSError):
            break

    for _ in range(20):
        try:
            os.kill(grandchild_pid, 0)
            time.sleep(0.05)
        except (ProcessLookupError, OSError):
            break

    with pytest.raises(ProcessLookupError):
        os.kill(child_pid, 0)

    with pytest.raises(ProcessLookupError):
        os.kill(grandchild_pid, 0)
