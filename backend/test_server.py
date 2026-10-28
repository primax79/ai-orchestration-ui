"""Unit tests for ai-orchestration-ui backend/server.py."""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import subprocess
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


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _isolated_test_environment(monkeypatch, tmp_path):
    cfg_dir = tmp_path / "_isolated_config"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    ws_dir = tmp_path / "_isolated_workspace"
    ws_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("AI_ORCH_CONFIG_DIR", str(cfg_dir))
    monkeypatch.delenv("AI_ORCHESTRATION_CONFIG", raising=False)
    old_ws = state.workspace
    state.workspace = ws_dir
    try:
        yield
    finally:
        state.workspace = old_ws


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
    assert "img-src 'self' data: blob:" in csp
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

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = pathlib.Path(tmp_dir)
        started_file = tmp_path / "cli_started"
        release_file = tmp_path / "cli_release"

        stub_path = tmp_path / "stub_slow.py"
        stub_path.write_text(
            "import os, pathlib, sys, time\n"
            f"started = pathlib.Path({str(started_file)!r})\n"
            f"release_path = pathlib.Path({str(release_file)!r})\n"
            "if '--kind' in sys.argv:\n"
            "    started.touch()\n"
            "    deadline = time.monotonic() + 15.0\n"
            "    while not release_path.exists() and time.monotonic() < deadline:\n"
            "        time.sleep(0.01)\n"
            'print(\'{"tasks": [], "initiatives": [], "stats": {"total": 0}}\')\n',
            encoding="utf-8",
        )

        with tempfile.TemporaryDirectory() as tmp_ws:
            ws_path = pathlib.Path(tmp_ws)
            (ws_path / "tasks").mkdir()
            old_ws = state.workspace
            state.workspace = ws_path
            monkeypatch.setenv("AI_ORCH_BIN", str(stub_path))

            try:
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as async_client:
                    # Launch slow CLI request
                    slow_task = asyncio.create_task(
                        async_client.get("/api/tasks?kind=initiative", headers={"X-AI-Orch-Token": token})
                    )
                    # Poll until slow CLI process is running
                    deadline = time.monotonic() + 10.0
                    while not started_file.exists() and time.monotonic() < deadline:
                        await asyncio.sleep(0.01)
                    assert started_file.is_file(), "Slow CLI process did not start within 10s"

                    # Concurrently launch fast workspace request while slow CLI is still running
                    start_time = time.monotonic()
                    fast_res = await async_client.get("/api/workspace", headers={"X-AI-Orch-Token": token})
                    elapsed = time.monotonic() - start_time

                    assert fast_res.status_code == 200
                    # Fast request must complete while slow_task is still running (non-blocking)
                    assert not slow_task.done(), "Fast request was blocked until slow CLI completed"
                    assert elapsed < 10.0

                    # Release slow CLI process
                    release_file.touch()

                    # Await slow task completion
                    slow_res = await slow_task
                    assert slow_res.status_code == 200
            finally:
                state.workspace = old_ws


def test_watcher_broadcasts_on_file_change(monkeypatch):
    token = get_or_create_token()
    monkeypatch.setenv("AI_ORCH_WATCH_POLLING", "1")
    monkeypatch.setenv("AI_ORCH_WATCH_INTERVAL", "0.05")

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

                    # Touch file in tasks with distinct mtime
                    initial_file.write_text("modified task content", encoding="utf-8")
                    new_mtime = initial_file.stat().st_mtime + 2.0
                    os.utime(initial_file, (new_mtime, new_mtime))

                    # Wait for changed broadcast
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

    async def fake_wait_for(coro, timeout):
        comm_task = asyncio.create_task(coro)
        try:
            # Poll up to 10s for child and grandchild PIDs to be recorded before timing out
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                if child_pid_file.is_file() and grandchild_pid_file.is_file():
                    c = child_pid_file.read_text(encoding="utf-8").strip()
                    g = grandchild_pid_file.read_text(encoding="utf-8").strip()
                    if c and g:
                        break
                await asyncio.sleep(0.01)
            else:
                raise TimeoutError("Child and grandchild PIDs were not written within 10s")
            raise asyncio.TimeoutError()
        finally:
            comm_task.cancel()
            try:
                await comm_task
            except (asyncio.CancelledError, Exception):
                pass

    monkeypatch.setattr("server.asyncio.wait_for", fake_wait_for)

    # Execute run_ai_orch with 1s timeout
    code, res = await run_ai_orch([], timeout=1.0)
    assert code == 504
    assert isinstance(res, dict)
    assert "CLI command timed out" in res.get("error", "")

    assert child_pid_file.is_file()
    assert grandchild_pid_file.is_file()

    child_pid = int(child_pid_file.read_text(encoding="utf-8").strip())
    grandchild_pid = int(grandchild_pid_file.read_text(encoding="utf-8").strip())

    # Wait for OS process cleanup (generous timeout >= 10s)
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
            await asyncio.sleep(0.02)
        except (ProcessLookupError, OSError):
            break

    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        try:
            os.kill(grandchild_pid, 0)
            await asyncio.sleep(0.02)
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
    deadline = time.monotonic() + 10.0
    child_pid = grandchild_pid = None
    while time.monotonic() < deadline:
        if child_pid_file.is_file() and grandchild_pid_file.is_file():
            c_text = child_pid_file.read_text(encoding="utf-8").strip()
            g_text = grandchild_pid_file.read_text(encoding="utf-8").strip()
            if c_text and g_text:
                try:
                    child_pid = int(c_text)
                    grandchild_pid = int(g_text)
                    break
                except ValueError:
                    pass
        await asyncio.sleep(0.02)

    assert child_pid is not None and grandchild_pid is not None, "PIDs not captured within 10s"

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
            await asyncio.sleep(0.02)
        except (ProcessLookupError, OSError):
            break

    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        try:
            os.kill(grandchild_pid, 0)
            await asyncio.sleep(0.02)
        except (ProcessLookupError, OSError):
            break

    with pytest.raises(ProcessLookupError):
        os.kill(child_pid, 0)

    with pytest.raises(ProcessLookupError):
        os.kill(grandchild_pid, 0)


def test_task_transition_leaves_index_identical_and_reports_in_sync(monkeypatch, tmp_path):
    token = get_or_create_token()
    fixture_src = pathlib.Path("/Users/Alfredo/works/ai-coding-tools/ai-orchestration/plugins/architect-side/skills/task-pipeline/scripts/fixtures/index-regression")
    import shutil
    tasks_dir = tmp_path / "tasks"
    shutil.copytree(fixture_src, tasks_dir)

    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        index_file = tasks_dir / "00-INDEX.md"
        initial_index_bytes = index_file.read_bytes()

        # 1. Successful transition: does NOT run sync-index --apply, leaves 00-INDEX.md byte-identical
        res = client.post(
            "/api/tasks/transition",
            headers={"X-AI-Orch-Token": token},
            json={"task_id": "T012", "new_state": "in progress"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data.get("ok") is True
        assert data.get("new_state") == "in progress"
        assert "index_in_sync" in data
        assert data["index_in_sync"] is False

        # Verify index was not updated on disk
        assert index_file.read_bytes() == initial_index_bytes

        # 2. Stale task hash refusal -> 409 with CLI error body
        res_stale = client.post(
            "/api/tasks/transition",
            headers={"X-AI-Orch-Token": token},
            json={"task_id": "T012", "new_state": "open", "expect_task_hash": "badhash123"},
        )
        assert res_stale.status_code == 409
        stale_data = res_stale.json()
        assert stale_data.get("ok") is False
        assert stale_data.get("error") == "stale-task"
        assert stale_data.get("expected") == "badhash123"
        assert "actual" in stale_data

        # Index still unmodified
        assert index_file.read_bytes() == initial_index_bytes
    finally:
        state.workspace = old_ws


def test_sync_index_preview_and_apply_roundtrip(monkeypatch, tmp_path):
    fixture_src = pathlib.Path("/Users/Alfredo/works/ai-coding-tools/ai-orchestration/plugins/architect-side/skills/task-pipeline/scripts/fixtures/index-regression")
    import shutil
    tasks_dir = tmp_path / "tasks"
    shutil.copytree(fixture_src, tasks_dir)

    bin_path = os.environ.get("AI_ORCH_BIN", "/Users/Alfredo/works/ai-coding-tools/ai-orchestration/bin/ai-orch")
    import subprocess
    p1 = subprocess.run([bin_path, "tasks", "sync-index", "--tasks-dir", str(tasks_dir), "--adopt", "--json"], capture_output=True, text=True)
    import json
    h = json.loads(p1.stdout)["hash"]
    subprocess.run([bin_path, "tasks", "sync-index", "--tasks-dir", str(tasks_dir), "--adopt", "--apply", "--expect-hash", h, "--json"], capture_output=True, text=True)

    token = get_or_create_token()
    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # First transition T012 to 'in progress' so index is out of sync
        client.post(
            "/api/tasks/transition",
            headers={"X-AI-Orch-Token": token},
            json={"task_id": "T012", "new_state": "in progress"},
        )

        # 1. Preview sync-index
        prev_res = client.get(
            "/api/tasks/sync-index/preview",
            headers={"X-AI-Orch-Token": token},
        )
        assert prev_res.status_code == 200
        prev_data = prev_res.json()
        assert "diff" in prev_data
        assert "hash" in prev_data
        assert "in_sync" in prev_data
        assert prev_data["in_sync"] is False
        assert prev_data["diff"] != ""
        current_hash = prev_data["hash"]

        # 2. Apply without expect_hash -> 400
        bad_apply = client.post(
            "/api/tasks/sync-index",
            headers={"X-AI-Orch-Token": token},
            json={},
        )
        assert bad_apply.status_code == 400
        assert "expect_hash is required" in bad_apply.json().get("error", "")

        # 3. Apply with stale/mismatched hash -> 409
        stale_apply = client.post(
            "/api/tasks/sync-index",
            headers={"X-AI-Orch-Token": token},
            json={"expect_hash": "deadbeef" * 8},
        )
        assert stale_apply.status_code == 409
        assert "hash mismatch" in stale_apply.json().get("error", "").lower()

        # 4. Apply with correct hash -> 200
        ok_apply = client.post(
            "/api/tasks/sync-index",
            headers={"X-AI-Orch-Token": token},
            json={"expect_hash": current_hash},
        )
        assert ok_apply.status_code == 200
        assert ok_apply.json().get("applied") is True

        # 5. Subsequent preview shows in_sync = True
        post_prev = client.get(
            "/api/tasks/sync-index/preview",
            headers={"X-AI-Orch-Token": token},
        )
        assert post_prev.status_code == 200
        assert post_prev.json().get("in_sync") is True
    finally:
        state.workspace = old_ws


def test_install_skills_preview_and_apply_in_fake_home(monkeypatch, tmp_path):
    fake_home = tmp_path / "fake_home"
    fake_home.mkdir()
    fake_config = tmp_path / "fake_config"
    fake_config.mkdir()

    monkeypatch.setenv("AI_ORCH_HOME", str(fake_home))
    monkeypatch.setenv("AI_ORCH_CONFIG_DIR", str(fake_config))
    token = get_or_create_token()

    # 1. Missing expect_plan_hash on apply -> 400
    res_no_hash = client.post(
        "/api/env/install-skills",
        headers={"X-AI-Orch-Token": token},
        json={"assistants": ["kilo"], "scope": "global"},
    )
    assert res_no_hash.status_code == 400
    assert "expect_plan_hash is required" in res_no_hash.json().get("error", "")

    # 2. Preview install-skills -> 200 with plan and plan_hash
    res_prev = client.post(
        "/api/env/install-skills/preview",
        headers={"X-AI-Orch-Token": token},
        json={"assistants": ["kilo"], "scope": "global", "repo": "ai-orchestration"},
    )
    assert res_prev.status_code == 200
    prev_data = res_prev.json()
    assert prev_data.get("ok") is True
    assert "plan" in prev_data
    assert "plan_hash" in prev_data
    plan_hash = prev_data["plan_hash"]

    # Nothing installed yet
    assert not (fake_home / ".kilo" / "skills" / "orchestration-workflow").exists()

    # 3. Apply with stale expect_plan_hash -> 409
    res_stale = client.post(
        "/api/env/install-skills",
        headers={"X-AI-Orch-Token": token},
        json={"assistants": ["kilo"], "scope": "global", "repo": "ai-orchestration", "expect_plan_hash": "badhash123"},
    )
    assert res_stale.status_code == 409
    assert "plan hash mismatch" in res_stale.json().get("error", "").lower()

    # 4. Apply with matching plan_hash -> 200
    res_apply = client.post(
        "/api/env/install-skills",
        headers={"X-AI-Orch-Token": token},
        json={"assistants": ["kilo"], "scope": "global", "repo": "ai-orchestration", "expect_plan_hash": plan_hash},
    )
    assert res_apply.status_code == 200
    apply_data = res_apply.json()
    assert apply_data.get("ok") is True
    assert (fake_home / ".kilo" / "skills" / "orchestration-workflow").exists()


def test_env_mutating_commands_missing_and_stale_plan_hash(monkeypatch, tmp_path):
    fake_home = tmp_path / "fake_home"
    fake_home.mkdir()
    fake_config = tmp_path / "fake_config"
    fake_config.mkdir()

    monkeypatch.setenv("AI_ORCH_HOME", str(fake_home))
    monkeypatch.setenv("AI_ORCH_CONFIG_DIR", str(fake_config))
    token = get_or_create_token()

    # All mutating env endpoints reject missing expect_plan_hash with 400
    for endpoint, payload in [
        ("/api/env/remove-skill", {"skill": "foo", "assistant": "kilo"}),
        ("/api/env/resolve-conflicts", {}),
        ("/api/env/register-mcp", {"server": "kilo-mcp"}),
        ("/api/env/fetch-repos", {}),
    ]:
        res = client.post(endpoint, headers={"X-AI-Orch-Token": token}, json=payload)
        assert res.status_code == 400
        assert "expect_plan_hash is required" in res.json().get("error", "")

    # Preview and stale hash on resolve-conflicts
    res_prev = client.post(
        "/api/env/resolve-conflicts/preview",
        headers={"X-AI-Orch-Token": token},
        json={},
    )
    assert res_prev.status_code == 200
    assert "plan_hash" in res_prev.json()

    res_stale = client.post(
        "/api/env/resolve-conflicts",
        headers={"X-AI-Orch-Token": token},
        json={"expect_plan_hash": "deadbeef" * 8},
    )
    assert res_stale.status_code == 409


def test_config_set_routing_preview_and_apply(monkeypatch, tmp_path):
    fake_config = tmp_path / "fake_config"
    fake_config.mkdir()
    monkeypatch.setenv("AI_ORCH_CONFIG_DIR", str(fake_config))
    token = get_or_create_token()

    # 1. Preview set-routing
    res_prev = client.post(
        "/api/config/set-routing/preview",
        headers={"X-AI-Orch-Token": token},
        json={"scope": "global", "orchestrator": "kilo"},
    )
    assert res_prev.status_code == 200
    prev_data = res_prev.json()
    assert "diff" in prev_data
    assert "hash" in prev_data
    target_hash = prev_data["hash"]

    # 2. Apply without expect_hash -> 400
    res_no_hash = client.post(
        "/api/config/set-routing",
        headers={"X-AI-Orch-Token": token},
        json={"scope": "global", "orchestrator": "kilo"},
    )
    assert res_no_hash.status_code == 400
    assert "expect_hash is required" in res_no_hash.json().get("error", "")

    # 3. Apply with stale expect_hash -> 409
    res_stale = client.post(
        "/api/config/set-routing",
        headers={"X-AI-Orch-Token": token},
        json={"scope": "global", "orchestrator": "kilo", "expect_hash": "badhash123"},
    )
    assert res_stale.status_code == 409
    assert "hash mismatch" in res_stale.json().get("error", "").lower()

    # 4. Apply with valid hash -> 200
    res_ok = client.post(
        "/api/config/set-routing",
        headers={"X-AI-Orch-Token": token},
        json={"scope": "global", "orchestrator": "kilo", "expect_hash": target_hash},
    )
    assert res_ok.status_code == 200
    assert res_ok.json().get("ok") is True


def test_config_set_profile_preview_and_apply(monkeypatch, tmp_path):
    fake_config = tmp_path / "fake_config"
    fake_config.mkdir()
    monkeypatch.setenv("AI_ORCH_CONFIG_DIR", str(fake_config))
    token = get_or_create_token()

    # 1. Preview set-profile
    res_prev = client.post(
        "/api/config/set-profile/preview",
        headers={"X-AI-Orch-Token": token},
        json={"tool": "kilo", "profile": "deep-reasoning", "model": "google/gemini-4-argon", "scope": "global"},
    )
    assert res_prev.status_code == 200
    prev_data = res_prev.json()
    assert "diff" in prev_data
    assert "hash" in prev_data
    target_hash = prev_data["hash"]

    # 2. Apply without expect_hash -> 400
    res_no_hash = client.post(
        "/api/config/set-profile",
        headers={"X-AI-Orch-Token": token},
        json={"tool": "kilo", "profile": "deep-reasoning", "model": "google/gemini-4-argon", "scope": "global"},
    )
    assert res_no_hash.status_code == 400
    assert "expect_hash is required" in res_no_hash.json().get("error", "")

    # 3. Apply with stale expect_hash -> 409
    res_stale = client.post(
        "/api/config/set-profile",
        headers={"X-AI-Orch-Token": token},
        json={"tool": "kilo", "profile": "deep-reasoning", "model": "google/gemini-4-argon", "scope": "global", "expect_hash": "badhash123"},
    )
    assert res_stale.status_code == 409
    assert "hash mismatch" in res_stale.json().get("error", "").lower()

    # 4. Apply with valid hash -> 200
    res_ok = client.post(
        "/api/config/set-profile",
        headers={"X-AI-Orch-Token": token},
        json={"tool": "kilo", "profile": "deep-reasoning", "model": "google/gemini-4-argon", "scope": "global", "expect_hash": target_hash},
    )
    assert res_ok.status_code == 200
    assert res_ok.json().get("ok") is True


def test_render_agents_md_preview_and_apply(monkeypatch, tmp_path):
    fake_config = tmp_path / "fake_config"
    fake_config.mkdir()
    monkeypatch.setenv("AI_ORCH_CONFIG_DIR", str(fake_config))
    token = get_or_create_token()

    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # 1. Preview render-agents-md
        res_prev = client.get(
            "/api/config/render-agents-md/preview",
            headers={"X-AI-Orch-Token": token},
        )
        assert res_prev.status_code == 200
        prev_data = res_prev.json()
        assert "diff" in prev_data
        assert "hash" in prev_data
        assert "warnings" in prev_data
        initial_hash = prev_data["hash"]

        # 2. Apply without expect_hash -> 400
        res_no_hash = client.post(
            "/api/config/render-agents-md/apply",
            headers={"X-AI-Orch-Token": token},
            json={},
        )
        assert res_no_hash.status_code == 400
        assert "expect_hash is required" in res_no_hash.json().get("error", "")

        # 3. Apply with stale expect_hash -> 409
        res_stale = client.post(
            "/api/config/render-agents-md/apply",
            headers={"X-AI-Orch-Token": token},
            json={"expect_hash": "badhash123"},
        )
        assert res_stale.status_code == 409
        assert "hash mismatch" in res_stale.json().get("error", "").lower()

        # 4. Apply without allow_global_routing on workspace without project config -> 409 refusal
        res_refusal = client.post(
            "/api/config/render-agents-md/apply",
            headers={"X-AI-Orch-Token": token},
            json={"expect_hash": initial_hash},
        )
        assert res_refusal.status_code == 409
        assert "no project config" in res_refusal.json().get("error", "").lower()

        # 5. Apply with allow_global_routing = True -> 200
        res_ok = client.post(
            "/api/config/render-agents-md/apply",
            headers={"X-AI-Orch-Token": token},
            json={"expect_hash": initial_hash, "allow_global_routing": True},
        )
        assert res_ok.status_code == 200
        assert res_ok.json().get("ok") is True
        assert (tmp_path / "AGENTS.md").is_file()
    finally:
        state.workspace = old_ws


def _create_sample_task(workspace: pathlib.Path, task_id: str = "T001", state_str: str = "in progress") -> pathlib.Path:
    tasks_dir = workspace / "tasks"
    cat_dir = tasks_dir / "features"
    cat_dir.mkdir(parents=True, exist_ok=True)
    task_file = cat_dir / f"{task_id}-sample-task.md"
    task_content = (
        f"# {task_id} Sample Task\n\n"
        f"- id: {task_id}\n"
        f"- state: {state_str}\n"
        "- priority: P1\n"
        "- assignee: self\n"
        "- profile: bulk-execution\n"
        "- verifier: -\n"
        "- decider: -\n"
        "- plan-hash: -\n\n"
        "## Goal\nSample goal\n\n"
        "## Steps\n- [ ] Implement concrete sample feature\n\n"
        "## Verification\n- [ ] Run pytest and verify exit code 0\n"
    )
    task_file.write_text(task_content, encoding="utf-8")
    return task_file


def test_questions_ask_list_answer_restore_roundtrip(monkeypatch, tmp_path):
    token = get_or_create_token()
    task_file = _create_sample_task(tmp_path, task_id="T001", state_str="in progress")

    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # 1. Ask a question blocking T001
        ask_payload = {
            "question": "Which architecture pattern should we adopt?",
            "context": "Context paragraph 1: overview.\nContext paragraph 2: trade-offs.",
            "options": [
                {"label": "A", "title": "Pattern Alpha", "consequence": "Fast and modular"},
                {"label": "B", "title": "Pattern Beta", "consequence": "Simpler but monolith"}
            ],
            "recommended": "A",
            "open_answer": True,
            "blocks": ["T001"],
            "decider": "owner"
        }
        res_ask = client.post(
            "/api/questions",
            headers={"X-AI-Orch-Token": token},
            json=ask_payload,
        )
        assert res_ask.status_code == 200
        ask_data = res_ask.json()
        assert ask_data.get("ok") is True
        q_id = ask_data.get("id")
        assert q_id == "Q001"

        # Verify task file state transitioned to 'waiting' and decider set to Q001
        content_after_ask = task_file.read_text(encoding="utf-8")
        assert "- state: waiting" in content_after_ask
        assert "- decider: Q001" in content_after_ask

        # 2. List questions shows the newly asked question
        res_list = client.get(
            "/api/questions",
            headers={"X-AI-Orch-Token": token},
        )
        assert res_list.status_code == 200
        list_data = res_list.json()
        assert list_data.get("ok") is True
        questions = list_data.get("questions", [])
        assert len(questions) == 1
        assert questions[0]["id"] == "Q001"
        assert questions[0]["status"] == "open"
        assert "T001" in questions[0]["blocks"]

        # Filter by status and blocks
        res_filtered = client.get(
            "/api/questions?status=open&blocks=T001",
            headers={"X-AI-Orch-Token": token},
        )
        assert res_filtered.status_code == 200
        assert len(res_filtered.json().get("questions", [])) == 1

        res_none = client.get(
            "/api/questions?status=answered",
            headers={"X-AI-Orch-Token": token},
        )
        assert res_none.status_code == 200
        assert len(res_none.json().get("questions", [])) == 0

        # 3. Get single question by ID
        res_show = client.get(
            f"/api/questions/{q_id}",
            headers={"X-AI-Orch-Token": token},
        )
        assert res_show.status_code == 200
        show_data = res_show.json()
        assert show_data.get("ok") is True
        assert show_data["question"]["id"] == "Q001"
        assert show_data["question"]["recommended"] == "A"
        assert show_data["question"]["open_answer"] == "yes"

        # 4. Answer question with multi-line text
        multi_line_text = (
            "Line 1: Proceed with Pattern Alpha.\n"
            "Line 2: Ensure proper interfaces are defined.\n"
            "Line 3: Verified by engineering."
        )
        res_ans = client.post(
            f"/api/questions/{q_id}/answer",
            headers={"X-AI-Orch-Token": token},
            json={"choice": "A", "text": multi_line_text, "by": "owner"},
        )
        assert res_ans.status_code == 200
        ans_data = res_ans.json()
        assert ans_data.get("ok") is True
        assert ans_data.get("choice") == "A"
        assert "T001" in ans_data.get("unblocked_tasks", [])

        # 5. Verify task file restored to 'in progress' and decider restored to '-'
        content_after_ans = task_file.read_text(encoding="utf-8")
        assert "- state: in progress" in content_after_ans
        assert "- decider: -" in content_after_ans

        # Verify question status is now 'answered'
        res_show_after = client.get(
            f"/api/questions/{q_id}",
            headers={"X-AI-Orch-Token": token},
        )
        assert res_show_after.status_code == 200
        assert res_show_after.json()["question"]["status"] == "answered"
    finally:
        state.workspace = old_ws


def test_questions_invalid_answer_unknown_choice(monkeypatch, tmp_path):
    token = get_or_create_token()
    _create_sample_task(tmp_path, task_id="T001", state_str="in progress")

    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # Ask question
        res_ask = client.post(
            "/api/questions",
            headers={"X-AI-Orch-Token": token},
            json={
                "question": "Choice test question?",
                "context": "Context for choice test.",
                "options": [
                    {"label": "A", "title": "Option A", "consequence": "Cons A"},
                    {"label": "B", "title": "Option B", "consequence": "Cons B"}
                ],
                "blocks": ["T001"],
            },
        )
        assert res_ask.status_code == 200
        q_id = res_ask.json()["id"]

        # 1. Unknown choice -> 400 with message
        res_bad_choice = client.post(
            f"/api/questions/{q_id}/answer",
            headers={"X-AI-Orch-Token": token},
            json={"choice": "Z"},
        )
        assert res_bad_choice.status_code == 400
        assert "invalid choice" in res_bad_choice.json().get("error", "").lower()

        # 2. Missing choice field -> 400
        res_no_choice = client.post(
            f"/api/questions/{q_id}/answer",
            headers={"X-AI-Orch-Token": token},
            json={},
        )
        assert res_no_choice.status_code == 400
        assert "choice is required" in res_no_choice.json().get("error", "")

        # 3. Answer text exceeding 32 KB limit -> 400
        huge_text = "x" * (33 * 1024)
        res_huge = client.post(
            f"/api/questions/{q_id}/answer",
            headers={"X-AI-Orch-Token": token},
            json={"choice": "A", "text": huge_text},
        )
        assert res_huge.status_code == 400
        assert "exceeds 32 kb" in res_huge.json().get("error", "").lower()
    finally:
        state.workspace = old_ws


def test_questions_withdraw_requires_reason(monkeypatch, tmp_path):
    token = get_or_create_token()
    task_file = _create_sample_task(tmp_path, task_id="T001", state_str="in progress")

    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # Ask question
        res_ask = client.post(
            "/api/questions",
            headers={"X-AI-Orch-Token": token},
            json={
                "question": "Withdraw test question?",
                "context": "Context for withdraw test.",
                "options": [
                    {"label": "A", "title": "Option A", "consequence": "Cons A"},
                    {"label": "B", "title": "Option B", "consequence": "Cons B"}
                ],
                "blocks": ["T001"],
            },
        )
        assert res_ask.status_code == 200
        q_id = res_ask.json()["id"]
        assert "- state: waiting" in task_file.read_text(encoding="utf-8")

        # 1. Withdraw without reason -> 400
        res_no_reason = client.post(
            f"/api/questions/{q_id}/withdraw",
            headers={"X-AI-Orch-Token": token},
            json={},
        )
        assert res_no_reason.status_code == 400
        assert "reason is required" in res_no_reason.json().get("error", "")

        # 2. Withdraw with whitespace reason -> 400
        res_blank_reason = client.post(
            f"/api/questions/{q_id}/withdraw",
            headers={"X-AI-Orch-Token": token},
            json={"reason": "   "},
        )
        assert res_blank_reason.status_code == 400
        assert "reason is required" in res_blank_reason.json().get("error", "")

        # 3. Withdraw with valid reason -> 200, task restored
        res_ok_withdraw = client.post(
            f"/api/questions/{q_id}/withdraw",
            headers={"X-AI-Orch-Token": token},
            json={"reason": "Requirements changed, question moot.", "by": "owner"},
        )
        assert res_ok_withdraw.status_code == 200
        assert res_ok_withdraw.json().get("ok") is True

        content_after = task_file.read_text(encoding="utf-8")
        assert "- state: in progress" in content_after
        assert "- decider: -" in content_after

        # Question shows as withdrawn
        res_show = client.get(f"/api/questions/{q_id}", headers={"X-AI-Orch-Token": token})
        assert res_show.status_code == 200
        assert res_show.json()["question"]["status"] == "withdrawn"
    finally:
        state.workspace = old_ws


def test_questions_bad_id_format():
    token = get_or_create_token()

    # Bad ID format checks: must match ^Q\d{3,}$
    for bad_id in ["invalid", "Q1", "Q12", "T001", "q001", "Q001-slug"]:
        res_get = client.get(f"/api/questions/{bad_id}", headers={"X-AI-Orch-Token": token})
        assert res_get.status_code == 400
        assert "Invalid question ID" in res_get.json().get("error", "")

        res_ans = client.post(f"/api/questions/{bad_id}/answer", headers={"X-AI-Orch-Token": token}, json={"choice": "A"})
        assert res_ans.status_code == 400
        assert "Invalid question ID" in res_ans.json().get("error", "")

        res_with = client.post(f"/api/questions/{bad_id}/withdraw", headers={"X-AI-Orch-Token": token}, json={"reason": "foo"})
        assert res_with.status_code == 400
        assert "Invalid question ID" in res_with.json().get("error", "")

    # Non-existent valid question ID -> 404
    res_not_found = client.get("/api/questions/Q999", headers={"X-AI-Orch-Token": token})
    assert res_not_found.status_code == 404


def test_questions_auth_enforced():
    # Endpoints without token -> 401
    assert client.get("/api/questions").status_code == 401
    assert client.get("/api/questions/Q001").status_code == 401
    assert client.post("/api/questions", json={}).status_code == 401
    assert client.post("/api/questions/Q001/answer", json={"choice": "A"}).status_code == 401
    assert client.post("/api/questions/Q001/withdraw", json={"reason": "foo"}).status_code == 401
    assert client.post("/api/questions/Q001/answer-and-resume/preview", json={"choice": "A"}).status_code == 401
    assert client.post("/api/questions/Q001/answer-and-resume", json={"choice": "A"}).status_code == 401

    # Endpoints with bad token -> 401
    bad_headers = {"X-AI-Orch-Token": "bad-token"}
    assert client.get("/api/questions", headers=bad_headers).status_code == 401
    assert client.get("/api/questions/Q001", headers=bad_headers).status_code == 401
    assert client.post("/api/questions", headers=bad_headers, json={}).status_code == 401
    assert client.post("/api/questions/Q001/answer", headers=bad_headers, json={"choice": "A"}).status_code == 401
    assert client.post("/api/questions/Q001/withdraw", headers=bad_headers, json={"reason": "foo"}).status_code == 401
    assert client.post("/api/questions/Q001/answer-and-resume/preview", headers=bad_headers, json={"choice": "A"}).status_code == 401
    assert client.post("/api/questions/Q001/answer-and-resume", headers=bad_headers, json={"choice": "A"}).status_code == 401


def test_questions_answer_and_resume_flow(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws = _setup_runs_workspace(tmp_path, monkeypatch)

    old_ws = state.workspace
    state.workspace = ws
    try:
        run_id = "20261018-120000-T001-kilo-abcd"
        run_dir = ws / ".ai-orchestration" / "runs" / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        run_record = {
            "run_id": run_id,
            "task_id": "T001",
            "mode": "execute",
            "tool": "kilo",
            "profile": "bulk-execution",
            "model": "google/gemini-3.8-flash",
            "status": "succeeded",
            "session_id": "session-stub-1",
            "cwd": str(ws),
            "isolation": "none",
            "plan_hash": "testhash12345",
            "questions": ["Q001"],
        }
        (run_dir / "run.json").write_text(json.dumps(run_record, indent=2), encoding="utf-8")

        # 1. Ask a question with origin-run
        ask_payload = {
            "question": "Which architecture pattern should we adopt?",
            "context": "Context paragraph.",
            "options": [
                {"label": "A", "title": "Pattern Alpha", "consequence": "Fast and modular"},
                {"label": "B", "title": "Pattern Beta", "consequence": "Simpler"}
            ],
            "recommended": "A",
            "open_answer": True,
            "blocks": ["T001"],
            "decider": "owner",
            "origin_run": run_id,
        }
        res_ask = client.post("/api/questions", headers=headers, json=ask_payload)
        assert res_ask.status_code == 200
        q_id = res_ask.json()["id"]

        # 2. Preview answer and resume
        res_prev = client.post(
            f"/api/questions/{q_id}/answer-and-resume/preview",
            headers=headers,
            json={"choice": "A", "text": "Proceed with Alpha."},
        )
        assert res_prev.status_code == 200
        prev_data = res_prev.json()
        assert prev_data["ok"] is True
        assert prev_data["continuable"] is True
        assert prev_data["run_id"] == run_id
        assert prev_data["plan_hash"] == "testhash12345"
        assert "Pattern Alpha" in prev_data["prompt"]
        assert "Proceed with Alpha." in prev_data["prompt"]

        # 3. Apply: missing expect_plan_hash -> 400
        res_apply_nohash = client.post(
            f"/api/questions/{q_id}/answer-and-resume",
            headers=headers,
            json={"choice": "A"},
        )
        assert res_apply_nohash.status_code == 400

        # 4. Apply: stale/mismatched expect_plan_hash -> 409
        res_apply_stale = client.post(
            f"/api/questions/{q_id}/answer-and-resume",
            headers=headers,
            json={"choice": "A", "expect_plan_hash": "wronghash"},
        )
        assert res_apply_stale.status_code == 409

        # 5. Apply: matching expect_plan_hash -> 200
        res_apply = client.post(
            f"/api/questions/{q_id}/answer-and-resume",
            headers=headers,
            json={"choice": "A", "text": "Proceed with Alpha.", "expect_plan_hash": "testhash12345"},
        )
        assert res_apply.status_code == 200
        apply_data = res_apply.json()
        assert apply_data["ok"] is True
        assert apply_data["resumed"] is True
        assert apply_data["continued_from"] == run_id

        # Check question is now answered
        res_q = client.get(f"/api/questions/{q_id}", headers=headers)
        assert res_q.status_code == 200
        assert res_q.json()["question"]["status"] == "answered"
    finally:
        state.workspace = old_ws


def test_questions_answer_and_resume_non_continuable(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws = _setup_runs_workspace(tmp_path, monkeypatch)

    old_ws = state.workspace
    state.workspace = ws
    try:
        # Ask question with no origin-run
        ask_payload = {
            "question": "Choose a color scheme?",
            "context": "Context paragraph.",
            "options": [
                {"label": "A", "title": "Dark", "consequence": "Saves battery"},
                {"label": "B", "title": "Light", "consequence": "Readable in sun"}
            ],
            "recommended": "A",
            "blocks": ["T001"],
            "decider": "owner",
        }
        res_ask = client.post("/api/questions", headers=headers, json=ask_payload)
        assert res_ask.status_code == 200
        q_id = res_ask.json()["id"]

        # Preview: continuable is False
        res_prev = client.post(
            f"/api/questions/{q_id}/answer-and-resume/preview",
            headers=headers,
            json={"choice": "A"},
        )
        assert res_prev.status_code == 200
        prev_data = res_prev.json()
        assert prev_data["ok"] is True
        assert prev_data["continuable"] is False
        assert "no origin-run" in prev_data["reason"].lower()

        # Apply: answers question, does not require expect_plan_hash, returns resumed: False
        res_apply = client.post(
            f"/api/questions/{q_id}/answer-and-resume",
            headers=headers,
            json={"choice": "A"},
        )
        assert res_apply.status_code == 200
        apply_data = res_apply.json()
        assert apply_data["ok"] is True
        assert apply_data["resumed"] is False
        assert "no origin-run" in apply_data["reason"].lower()

        # Check question is now answered
        res_q = client.get(f"/api/questions/{q_id}", headers=headers)
        assert res_q.status_code == 200
        assert res_q.json()["question"]["status"] == "answered"
    finally:
        state.workspace = old_ws


def test_watcher_broadcasts_on_question_file_change(monkeypatch):
    token = get_or_create_token()
    monkeypatch.setenv("AI_ORCH_WATCH_POLLING", "1")
    monkeypatch.setenv("AI_ORCH_WATCH_INTERVAL", "0.05")

    with tempfile.TemporaryDirectory() as tmp_ws:
        ws_path = pathlib.Path(tmp_ws)
        questions_dir = ws_path / "tasks" / "questions"
        questions_dir.mkdir(parents=True)
        q_file = questions_dir / "Q001-test.md"
        q_file.write_text("initial question content", encoding="utf-8")

        old_ws = state.workspace
        state.workspace = ws_path

        try:
            with TestClient(app) as test_client:
                with test_client.websocket_connect(f"/ws?token={token}") as ws:
                    init_msg = ws.receive_json()
                    assert init_msg.get("type") == "connected"

                    # Touch question file with distinct mtime
                    q_file.write_text("modified question content", encoding="utf-8")
                    new_mtime = q_file.stat().st_mtime + 2.0
                    os.utime(q_file, (new_mtime, new_mtime))

                    # Wait for changed broadcast
                    broadcast_msg = ws.receive_json()
                    assert broadcast_msg.get("type") == "changed"
                    areas = broadcast_msg.get("areas", [])
                    assert "questions" in areas
                    assert "tasks" in areas
        finally:
            state.workspace = old_ws


def _setup_runs_workspace(tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch, stub_args: list[str] | None = None) -> pathlib.Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    subprocess.run(["git", "init", "-b", "main"], cwd=str(ws), check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "TestUser"], cwd=str(ws), check=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=str(ws), check=True)

    t_dir = ws / "tasks" / "features"
    t_dir.mkdir(parents=True)
    task_file = t_dir / "T001-sample-task.md"
    task_file.write_text(
        "# T001 Sample Task\n\n"
        "- id: T001\n"
        "- state: open\n"
        "- priority: P1\n"
        "- assignee: kilo\n"
        "- profile: bulk-execution\n"
        "- verifier: -\n"
        "- decider: -\n"
        "- plan-hash: -\n\n"
        "## Goal\nSample goal\n\n"
        "## Steps\n- [ ] Implement concrete sample feature\n\n"
        "## Verification\n- [ ] Run pytest and verify exit code 0\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "add", "."], cwd=str(ws), check=True)
    subprocess.run(["git", "commit", "-m", "Initial commit"], cwd=str(ws), check=True, capture_output=True)

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    kilo_sym = bin_dir / "kilo"
    if not kilo_sym.exists():
        kilo_sym.symlink_to(sys.executable)
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ.get('PATH', '')}")

    if stub_args is None:
        stub_args = ["--commit", "--final-report", "--session-id", "s1"]

    stub_agent_path = "/Users/Alfredo/works/ai-coding-tools/ai-orchestration/scripts/fixtures/runs/stub_agent.py"
    args_json = json.dumps([sys.executable, stub_agent_path, *stub_args])

    cfg = tmp_path / "global_orchestration.toml"
    cfg.write_text(
        f'[routing]\n'
        f'default_orchestrator = "kilo"\n'
        f'default_executor = "kilo"\n'
        f'default_profile = "bulk-execution"\n'
        f'verification_mode = "cross-agent"\n\n'
        f'[tools.kilo]\n'
        f'enabled = true\n\n'
        f'[tools.kilo.profiles.bulk-execution]\n'
        f'model = "google/gemini-3.8-flash"\n'
        f'variant = "medium"\n\n'
        f'[tools.kilo.headless]\n'
        f'argv = {args_json}\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("AI_ORCH_GLOBAL_CONFIG", str(cfg))
    return ws


def test_runs_options_preview_start_show_logs_delivered_cleanup(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws = _setup_runs_workspace(tmp_path, monkeypatch)

    old_ws = state.workspace
    state.workspace = ws
    try:
        # 1. Options
        res_opt = client.get("/api/runs/options?task=T001", headers=headers)
        assert res_opt.status_code == 200
        opt_data = res_opt.json()
        assert opt_data.get("ok") is True
        assert "tools" in opt_data
        assert opt_data["tools"]["kilo"]["available"] is True
        assert "execute" in opt_data.get("allowed_modes", [])

        # Missing task param on options -> 400
        res_opt_bad = client.get("/api/runs/options", headers=headers)
        assert res_opt_bad.status_code == 400

        # 2. Preview
        preview_payload = {"task": "T001", "mode": "execute", "tool": "kilo"}
        res_prev = client.post("/api/runs/preview", headers=headers, json=preview_payload)
        assert res_prev.status_code == 200
        prev_data = res_prev.json()
        assert prev_data.get("ok") is True
        assert "plan_hash" in prev_data
        assert "prompt" in prev_data
        assert "argv_display" in prev_data
        plan_hash = prev_data["plan_hash"]

        # Missing task on preview -> 400
        res_prev_bad = client.post("/api/runs/preview", headers=headers, json={})
        assert res_prev_bad.status_code == 400

        # 3. Start: missing plan_hash -> 400
        res_start_nohash = client.post("/api/runs", headers=headers, json={"task": "T001", "mode": "execute", "tool": "kilo"})
        assert res_start_nohash.status_code == 400
        assert "expect_plan_hash is required" in res_start_nohash.json().get("error", "")

        # 4. Start: stale plan_hash -> 409
        res_start_stale = client.post(
            "/api/runs",
            headers=headers,
            json={"task": "T001", "mode": "execute", "tool": "kilo", "expect_plan_hash": "deadbeef" * 8},
        )
        assert res_start_stale.status_code == 409
        assert "plan hash mismatch" in res_start_stale.json().get("error", "").lower()

        # 5. Start: success with matching plan_hash -> 200
        res_start = client.post(
            "/api/runs",
            headers=headers,
            json={"task": "T001", "mode": "execute", "tool": "kilo", "expect_plan_hash": plan_hash},
        )
        assert res_start.status_code == 200
        start_data = res_start.json()
        assert start_data.get("ok") is True
        run_id = start_data["run_id"]
        assert start_data.get("status") == "starting"

        # 6. Poll show until succeeded (generous timeout up to 30s)
        run_record = None
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            res_show = client.get(f"/api/runs/{run_id}", headers=headers)
            assert res_show.status_code == 200
            show_data = res_show.json()
            assert show_data.get("ok") is True
            run_record = show_data.get("run", {})
            if run_record.get("status") == "succeeded":
                break
            time.sleep(0.1)

        assert run_record is not None
        assert run_record.get("status") == "succeeded"
        assert run_record.get("final_commit") is not None
        assert run_record.get("final_report") is not None

        # 7. List runs
        res_list = client.get("/api/runs?task=T001", headers=headers)
        assert res_list.status_code == 200
        list_data = res_list.json()
        assert list_data.get("ok") is True
        assert any(r["run_id"] == run_id for r in list_data.get("runs", []))

        # 8. Logs incremental
        res_logs = client.get(f"/api/runs/{run_id}/logs", headers=headers)
        assert res_logs.status_code == 200
        logs_data = res_logs.json()
        assert logs_data.get("ok") is True
        assert len(logs_data.get("events", [])) > 0
        next_offset = logs_data.get("next_offset")
        assert next_offset > 0

        # Incremental logs starting from next_offset -> empty
        res_inc = client.get(f"/api/runs/{run_id}/logs?since_offset={next_offset}", headers=headers)
        assert res_inc.status_code == 200
        inc_data = res_inc.json()
        assert inc_data.get("ok") is True
        assert len(inc_data.get("events", [])) == 0

        # 9. Mark-delivered
        res_del = client.post(f"/api/runs/{run_id}/mark-delivered", headers=headers, json={})
        assert res_del.status_code == 200
        del_data = res_del.json()
        assert del_data.get("ok") is True
        assert del_data.get("state") == "delivered"

        # 10. Cleanup
        res_clean = client.post(f"/api/runs/{run_id}/cleanup", headers=headers, json={"discard": True})
        assert res_clean.status_code == 200
        clean_data = res_clean.json()
        assert clean_data.get("ok") is True
        assert clean_data.get("cleaned") is True
    finally:
        state.workspace = old_ws


def test_runs_cancel_long_sleeping_stub(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws = _setup_runs_workspace(tmp_path, monkeypatch, stub_args=["--sleep", "30"])

    old_ws = state.workspace
    state.workspace = ws
    try:
        # Preview
        res_prev = client.post(
            "/api/runs/preview",
            headers=headers,
            json={"task": "T001", "mode": "execute", "tool": "kilo"},
        )
        assert res_prev.status_code == 200
        plan_hash = res_prev.json()["plan_hash"]

        # Start
        res_start = client.post(
            "/api/runs",
            headers=headers,
            json={"task": "T001", "mode": "execute", "tool": "kilo", "expect_plan_hash": plan_hash},
        )
        assert res_start.status_code == 200
        run_id = res_start.json()["run_id"]

        # Poll until process is spawned and running (up to 15s)
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            res_show = client.get(f"/api/runs/{run_id}", headers=headers)
            if res_show.status_code == 200 and res_show.json().get("run", {}).get("status") == "running":
                break
            time.sleep(0.05)

        # Cancel
        res_cancel = client.post(f"/api/runs/{run_id}/cancel", headers=headers)
        assert res_cancel.status_code == 200
        cancel_data = res_cancel.json()
        assert cancel_data.get("ok") is True
        assert cancel_data.get("status") == "cancelled"

        # Verify show returns cancelled (poll up to 15s)
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            res_show = client.get(f"/api/runs/{run_id}", headers=headers)
            if res_show.status_code == 200 and res_show.json().get("run", {}).get("status") == "cancelled":
                break
            time.sleep(0.05)
        assert res_show.status_code == 200
        assert res_show.json()["run"]["status"] == "cancelled"
    finally:
        state.workspace = old_ws


def test_runs_bad_id_format(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}

    for bad_id in ["invalid", "T001", "bad-run-id", "20261017-123456-T001-unknown-1234", "1234-56-T1-kilo-1234"]:
        assert client.get(f"/api/runs/{bad_id}", headers=headers).status_code == 400
        assert client.post(f"/api/runs/{bad_id}/continue", headers=headers, json={}).status_code == 400
        assert client.get(f"/api/runs/{bad_id}/logs", headers=headers).status_code == 400
        assert client.post(f"/api/runs/{bad_id}/cancel", headers=headers).status_code == 400
        assert client.post(f"/api/runs/{bad_id}/mark-delivered", headers=headers, json={}).status_code == 400
        assert client.post(f"/api/runs/{bad_id}/apply-verdict", headers=headers, json={}).status_code == 400
        assert client.post(f"/api/runs/{bad_id}/cleanup", headers=headers, json={}).status_code == 400

    # Valid run_id format but not found -> 404
    non_existent = "20261017-123456-T999-kilo-abcd"
    assert client.get(f"/api/runs/{non_existent}", headers=headers).status_code == 404
    assert client.get(f"/api/runs/{non_existent}/logs", headers=headers).status_code == 404


def test_runs_watcher_broadcast(monkeypatch, tmp_path):
    token = get_or_create_token()
    monkeypatch.setenv("AI_ORCH_WATCH_POLLING", "1")
    monkeypatch.setenv("AI_ORCH_WATCH_INTERVAL", "0.05")

    runs_dir = tmp_path / ".ai-orchestration" / "runs" / "20261017-123456-T001-kilo-1234"
    runs_dir.mkdir(parents=True)
    run_file = runs_dir / "run.json"
    run_file.write_text(json.dumps({"run_id": "20261017-123456-T001-kilo-1234", "status": "starting"}), encoding="utf-8")

    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        with TestClient(app) as test_client:
            with test_client.websocket_connect(f"/ws?token={token}") as ws:
                init_msg = ws.receive_json()
                assert init_msg.get("type") == "connected"

                # Touch run.json with distinct mtime
                run_file.write_text(json.dumps({"run_id": "20261017-123456-T001-kilo-1234", "status": "running"}), encoding="utf-8")
                new_mtime = run_file.stat().st_mtime + 2.0
                os.utime(run_file, (new_mtime, new_mtime))

                # Wait for broadcast
                broadcast_msg = ws.receive_json()
                assert broadcast_msg.get("type") == "changed"
                assert "runs" in broadcast_msg.get("areas", [])
    finally:
        state.workspace = old_ws


def test_runs_auth_enforced():
    # Endpoints without token -> 401
    assert client.get("/api/runs").status_code == 401
    assert client.get("/api/runs/options?task=T001").status_code == 401
    assert client.post("/api/runs/preview", json={}).status_code == 401
    assert client.post("/api/runs", json={}).status_code == 401
    assert client.get("/api/runs/20261017-123456-T001-kilo-1234").status_code == 401
    assert client.post("/api/runs/20261017-123456-T001-kilo-1234/continue", json={}).status_code == 401
    assert client.get("/api/runs/20261017-123456-T001-kilo-1234/logs").status_code == 401
    assert client.post("/api/runs/20261017-123456-T001-kilo-1234/cancel").status_code == 401
    assert client.post("/api/runs/20261017-123456-T001-kilo-1234/mark-delivered", json={}).status_code == 401
    assert client.post("/api/runs/20261017-123456-T001-kilo-1234/apply-verdict", json={}).status_code == 401
    assert client.post("/api/runs/20261017-123456-T001-kilo-1234/cleanup", json={}).status_code == 401


def make_test_png(width: int = 2, height: int = 2) -> bytes:
    import struct
    import zlib

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = b"\x00\xff\x00\x00\x00\xff\x00\x00\x00\xff\x00\x00\x00\xff"
    idat = zlib.compress(raw)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def test_inbox_auth_enforced():
    # Endpoints without token -> 401
    assert client.get("/api/inbox").status_code == 401
    assert client.post("/api/inbox", json={}).status_code == 401
    assert client.get("/api/inbox/N001").status_code == 401
    assert client.post("/api/inbox/N001", json={}).status_code == 401
    assert client.post("/api/inbox/N001/attachments").status_code == 401
    assert client.get("/api/inbox/N001/attachments/01-test.png").status_code == 401
    assert client.delete("/api/inbox/N001/attachments/01-test.png").status_code == 401
    assert client.post("/api/inbox/N001/resolve", json={}).status_code == 401
    assert client.post("/api/inbox/N001/discard", json={}).status_code == 401
    assert client.post("/api/inbox/N001/reopen").status_code == 401
    assert client.post("/api/inbox/N001/to-task", json={}).status_code == 401

    # Endpoints with bad token -> 401
    bad_headers = {"X-AI-Orch-Token": "bad-token"}
    assert client.get("/api/inbox", headers=bad_headers).status_code == 401
    assert client.post("/api/inbox", headers=bad_headers, json={}).status_code == 401
    assert client.get("/api/inbox/N001", headers=bad_headers).status_code == 401
    assert client.post("/api/inbox/N001", headers=bad_headers, json={}).status_code == 401
    assert client.post("/api/inbox/N001/attachments", headers=bad_headers).status_code == 401
    assert client.get("/api/inbox/N001/attachments/01-test.png", headers=bad_headers).status_code == 401
    assert client.delete("/api/inbox/N001/attachments/01-test.png", headers=bad_headers).status_code == 401
    assert client.post("/api/inbox/N001/resolve", headers=bad_headers, json={}).status_code == 401
    assert client.post("/api/inbox/N001/discard", headers=bad_headers, json={}).status_code == 401
    assert client.post("/api/inbox/N001/reopen", headers=bad_headers).status_code == 401
    assert client.post("/api/inbox/N001/to-task", headers=bad_headers, json={}).status_code == 401


def test_inbox_crud_attachments_resolve_totask_flow(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}

    tasks_dir = tmp_path / "tasks"
    tasks_dir.mkdir()

    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # 1. Initial list -> empty
        res_list0 = client.get("/api/inbox", headers=headers)
        assert res_list0.status_code == 200
        assert res_list0.json()["notes"] == []

        # 2. Add note
        add_payload = {
            "title": "Bug in parser",
            "kind": "bug",
            "about": "backend/server.py",
            "body": "# Parsing bug\nDetails of the issue.",
            "status": "draft",
        }
        res_add = client.post("/api/inbox", headers=headers, json=add_payload)
        assert res_add.status_code == 200
        add_data = res_add.json()
        assert add_data["ok"] is True
        note_id = add_data["id"]
        assert note_id == "N001"
        initial_hash = add_data["bundle_sha256"]

        # 3. List notes -> 1 note
        res_list = client.get("/api/inbox", headers=headers)
        assert res_list.status_code == 200
        notes = res_list.json()["notes"]
        assert len(notes) == 1
        assert notes[0]["id"] == "N001"
        assert notes[0]["status"] == "draft"

        # List with status filter
        res_draft = client.get("/api/inbox?status=draft", headers=headers)
        assert len(res_draft.json()["notes"]) == 1
        res_ready = client.get("/api/inbox?status=ready", headers=headers)
        assert len(res_ready.json()["notes"]) == 0

        # 4. Get note detail
        res_show = client.get(f"/api/inbox/{note_id}", headers=headers)
        assert res_show.status_code == 200
        note_data = res_show.json()["note"]
        assert note_data["id"] == "N001"
        assert note_data["title"] == "Bug in parser"
        assert note_data["body"] == "# Parsing bug\nDetails of the issue."

        # 5. Edit note with stale expect_hash -> 409
        res_stale = client.post(
            f"/api/inbox/{note_id}",
            headers=headers,
            json={"title": "Updated", "expect_hash": "deadbeef" * 8},
        )
        assert res_stale.status_code == 409
        assert "stale" in res_stale.json().get("error", "").lower()

        # 6. Edit note with matching expect_hash -> 200
        res_edit = client.post(
            f"/api/inbox/{note_id}",
            headers=headers,
            json={"title": "Bug in parser (verified)", "status": "ready", "expect_hash": initial_hash},
        )
        assert res_edit.status_code == 200
        edit_data = res_edit.json()
        assert edit_data["status"] == "ready"
        updated_hash = edit_data["bundle_sha256"]
        assert updated_hash != initial_hash

        # 7. Upload real 2x2 PNG
        png_data = make_test_png(2, 2)
        res_upload = client.post(
            f"/api/inbox/{note_id}/attachments",
            headers=headers,
            files={"file": ("screenshot.png", png_data, "image/png")},
        )
        assert res_upload.status_code == 200
        att_data = res_upload.json()
        assert att_data["ok"] is True
        att_filename = att_data["attachment"]
        assert att_filename.endswith(".png")
        assert "markdown" in att_data

        # 8. Serve attachment back -> image/png, nosniff, cache-control
        res_att = client.get(f"/api/inbox/{note_id}/attachments/{att_filename}", headers=headers)
        assert res_att.status_code == 200
        assert res_att.content == png_data
        assert res_att.headers["content-type"] == "image/png"
        assert res_att.headers["x-content-type-options"] == "nosniff"
        assert "private" in res_att.headers["cache-control"]
        assert "max-age=60" in res_att.headers["cache-control"]

        # 9. Upload text file named fake.png -> refused with 415
        fake_png_data = b"This is plain text pretending to be a png."
        res_fake = client.post(
            f"/api/inbox/{note_id}/attachments",
            headers=headers,
            files={"file": ("fake.png", fake_png_data, "image/png")},
        )
        assert res_fake.status_code in (415, 400)

        # 10. Upload 11 MB file -> 413 without writing
        big_data = b"P" * (11 * 1024 * 1024)
        res_big = client.post(
            f"/api/inbox/{note_id}/attachments",
            headers=headers,
            files={"file": ("big.png", big_data, "image/png")},
        )
        assert res_big.status_code == 413
        # Ensure big file was not written to note's attachments dir
        note_folder = pathlib.Path(client.get(f"/api/inbox/{note_id}", headers=headers).json()["note"]["folder_path"])
        att_files = list((note_folder / "attachments").glob("*"))
        assert len(att_files) == 1
        assert att_files[0].name == att_filename

        # 11. Traversal names -> 400 or 404
        for bad_name in ["..%2F..%2Fetc", "a/b", ".hidden"]:
            res_trav_get = client.get(f"/api/inbox/{note_id}/attachments/{bad_name}", headers=headers)
            assert res_trav_get.status_code in (400, 404)
            res_trav_del = client.delete(f"/api/inbox/{note_id}/attachments/{bad_name}", headers=headers)
            assert res_trav_del.status_code in (400, 404)

        # 12. Resolve note -> moves folder to analyzed/
        res_res = client.post(
            f"/api/inbox/{note_id}/resolve",
            headers=headers,
            json={"produced": "T001", "by": "owner"},
        )
        assert res_res.status_code == 200
        res_data = res_res.json()
        assert res_data["status"] == "processed"
        assert res_data["produced"] == "T001"

        # Served URL STILL works through the new location in analyzed/
        res_att_after = client.get(f"/api/inbox/{note_id}/attachments/{att_filename}", headers=headers)
        assert res_att_after.status_code == 200
        assert res_att_after.content == png_data
        assert res_att_after.headers["content-type"] == "image/png"

        # 13. Reopen note -> moves back to to-analyze/ as ready
        res_reop = client.post(f"/api/inbox/{note_id}/reopen", headers=headers)
        assert res_reop.status_code == 200
        assert res_reop.json()["status"] == "ready"

        # 14. Convert to task (to-task)
        (tasks_dir / "features").mkdir(parents=True, exist_ok=True)
        res_totask = client.post(
            f"/api/inbox/{note_id}/to-task",
            headers=headers,
            json={"category": "features", "title": "Implement parser bugfix", "priority": "P1"},
        )
        assert res_totask.status_code == 200
        task_data = res_totask.json()
        assert task_data["ok"] is True
        created_task_id = task_data["id"]
        assert created_task_id == "T001"

        # Verify created task is valid
        res_val = client.get("/api/tasks/validate", headers=headers)
        assert res_val.status_code == 200
        assert res_val.json()["ok"] is True
        assert len(res_val.json().get("errors", [])) == 0

        # 15. Discard note -> status discarded in analyzed/
        res_disc = client.post(
            f"/api/inbox/{note_id}/discard",
            headers=headers,
            json={"reason": "Completed and task created"},
        )
        assert res_disc.status_code == 200
        assert res_disc.json()["status"] == "discarded"

        # Served attachment still works even after discard
        res_att_disc = client.get(f"/api/inbox/{note_id}/attachments/{att_filename}", headers=headers)
        assert res_att_disc.status_code == 200
        assert res_att_disc.content == png_data
    finally:
        state.workspace = old_ws


def test_inbox_bad_ids_and_input_validation(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    tasks_dir = tmp_path / "tasks"
    tasks_dir.mkdir()

    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # Invalid ID formats
        for bad_id in ["invalid", "N1", "N12", "T001", "n001", "N001-slug"]:
            assert client.get(f"/api/inbox/{bad_id}", headers=headers).status_code == 400
            assert client.post(f"/api/inbox/{bad_id}", headers=headers, json={"title": "foo"}).status_code == 400
            assert client.post(f"/api/inbox/{bad_id}/attachments", headers=headers).status_code == 400
            assert client.get(f"/api/inbox/{bad_id}/attachments/01-test.png", headers=headers).status_code == 400
            assert client.delete(f"/api/inbox/{bad_id}/attachments/01-test.png", headers=headers).status_code == 400
            assert client.post(f"/api/inbox/{bad_id}/resolve", headers=headers, json={"produced": "T1"}).status_code == 400
            assert client.post(f"/api/inbox/{bad_id}/discard", headers=headers, json={"reason": "foo"}).status_code == 400
            assert client.post(f"/api/inbox/{bad_id}/reopen", headers=headers).status_code == 400
            assert client.post(f"/api/inbox/{bad_id}/to-task", headers=headers, json={"category": "c", "title": "t"}).status_code == 400

        # Valid ID format but not found -> 404
        assert client.get("/api/inbox/N999", headers=headers).status_code == 404
        assert client.post("/api/inbox/N999", headers=headers, json={"title": "foo"}).status_code == 404
        assert client.get("/api/inbox/N999/attachments/01-test.png", headers=headers).status_code == 404
        assert client.delete("/api/inbox/N999/attachments/01-test.png", headers=headers).status_code == 404
        assert client.post("/api/inbox/N999/resolve", headers=headers, json={"produced": "T1"}).status_code == 404
        assert client.post("/api/inbox/N999/discard", headers=headers, json={"reason": "foo"}).status_code == 404
        assert client.post("/api/inbox/N999/reopen", headers=headers).status_code == 404
        assert client.post("/api/inbox/N999/to-task", headers=headers, json={"category": "c", "title": "t"}).status_code == 404

        # Add note missing title -> 400
        res_no_title = client.post("/api/inbox", headers=headers, json={})
        assert res_no_title.status_code == 400

        # Create a note for testing detach & other validations
        res_add = client.post("/api/inbox", headers=headers, json={"title": "Note for validation"})
        assert res_add.status_code == 200
        note_id = res_add.json()["id"]

        # Discard missing reason -> 400
        assert client.post(f"/api/inbox/{note_id}/discard", headers=headers, json={}).status_code == 400
        assert client.post(f"/api/inbox/{note_id}/discard", headers=headers, json={"reason": "  "}).status_code == 400

        # Resolve missing produced -> 400
        assert client.post(f"/api/inbox/{note_id}/resolve", headers=headers, json={}).status_code == 400

        # To-task missing category/title -> 400
        assert client.post(f"/api/inbox/{note_id}/to-task", headers=headers, json={"title": "foo"}).status_code == 400
        assert client.post(f"/api/inbox/{note_id}/to-task", headers=headers, json={"category": "cat"}).status_code == 400

        # Attach image, then detach
        png_data = make_test_png(2, 2)
        res_up = client.post(
            f"/api/inbox/{note_id}/attachments",
            headers=headers,
            files={"file": ("to_detach.png", png_data, "image/png")},
        )
        assert res_up.status_code == 200
        att_name = res_up.json()["attachment"]

        res_det = client.delete(f"/api/inbox/{note_id}/attachments/{att_name}", headers=headers)
        assert res_det.status_code == 200
        assert res_det.json()["detached"] == att_name

        # Detach non-existent attachment -> 404
        res_det_missing = client.delete(f"/api/inbox/{note_id}/attachments/notfound.png", headers=headers)
        assert res_det_missing.status_code == 404
    finally:
        state.workspace = old_ws


def test_inbox_watcher_broadcasts_on_inbox_change(monkeypatch):
    token = get_or_create_token()
    monkeypatch.setenv("AI_ORCH_WATCH_POLLING", "1")
    monkeypatch.setenv("AI_ORCH_WATCH_INTERVAL", "0.05")

    with tempfile.TemporaryDirectory() as tmp_ws:
        ws_path = pathlib.Path(tmp_ws)
        inbox_dir = ws_path / "tasks" / "_inbox" / "to-analyze" / "20261017-000000-sample-note"
        inbox_dir.mkdir(parents=True)
        note_file = inbox_dir / "note.md"
        note_file.write_text("initial note content", encoding="utf-8")

        old_ws = state.workspace
        state.workspace = ws_path

        try:
            with TestClient(app) as test_client:
                with test_client.websocket_connect(f"/ws?token={token}") as ws:
                    init_msg = ws.receive_json()
                    assert init_msg.get("type") == "connected"

                    note_file.write_text("modified note content", encoding="utf-8")
                    new_mtime = note_file.stat().st_mtime + 2.0
                    os.utime(note_file, (new_mtime, new_mtime))

                    broadcast_msg = ws.receive_json()
                    assert broadcast_msg.get("type") == "changed"
                    areas = broadcast_msg.get("areas", [])
                    assert "inbox" in areas
                    assert "tasks" not in areas
        finally:
            state.workspace = old_ws


def test_global_config_override_reaches_config_commands(monkeypatch):
    """AI_ORCH_GLOBAL_CONFIG must be forwarded to config/render commands, not only to runs."""
    import asyncio
    import server

    captured = {}

    async def fake_exec(*cmd, **kwargs):
        captured["cmd"] = list(cmd)
        raise FileNotFoundError("stop here")

    monkeypatch.setenv("AI_ORCH_GLOBAL_CONFIG", "/tmp/scratch-global.toml")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    for args in (["config", "set-routing", "--orchestrator", "claude", "--diff"], ["render-agents-md", "--diff"]):
        try:
            asyncio.run(server.run_ai_orch(args))
        except Exception:
            pass
        assert "--global-config" in captured["cmd"], args
        assert captured["cmd"][captured["cmd"].index("--global-config") + 1] == "/tmp/scratch-global.toml"


def test_task_detail_for_plan_tasks(monkeypatch, tmp_path):
    tasks = tmp_path / "tasks"
    (tasks / "05-sample").mkdir(parents=True)
    (tasks / "05-sample" / "plan.md").write_text(
        "# 05 - Sample\n\n## Tasks\n\n### 05.1 - First\n\n- **Status:** `open`\n- **Goal:** one\n\n"
        "### 05.2 - Second\n- **Status:** `done`\n\n## Log\n\n- entry\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(state, "workspace", tmp_path)
    headers = {"X-AI-Orch-Token": get_or_create_token()}

    res = client.get("/api/tasks/05.1", headers=headers)
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["relative_path"] == "tasks/05-sample/plan.md"
    assert data["content"].startswith("### 05.1 - First") and "05.2" not in data["content"]

    res = client.get("/api/tasks/05.2", headers=headers)
    assert "## Log" not in res.json()["content"]

    res = client.get("/api/tasks/INIT-05", headers=headers)
    assert res.status_code == 200 and "## Log" in res.json()["content"]

    assert client.get("/api/tasks/05.9", headers=headers).status_code == 404
    assert client.get("/api/tasks/T0*", headers=headers).status_code == 400


def test_cli_guard_shares_identical_reads_and_caps_concurrency(monkeypatch):
    import server as srv

    running = 0
    peak = 0
    calls = 0

    async def fake_process(args, timeout=None):
        nonlocal running, peak, calls
        calls += 1
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.05)
        running -= 1
        return 0, {"ok": True, "args": args}

    monkeypatch.setattr(srv, "_run_ai_orch_process", fake_process)

    async def scenario():
        reads = [srv.run_ai_orch(["run", "list", "--json"]) for _ in range(10)]
        writes = [srv.run_ai_orch(["tasks", "transition", f"T{i:03d}", "done"]) for i in range(10)]
        return await asyncio.gather(*reads, *writes)

    results = asyncio.run(scenario())
    assert all(code == 0 for code, _ in results)
    assert calls == 11  # one shared read + ten writes
    assert peak <= srv.MAX_CLI_PROCESSES
    assert srv._inflight_reads == {}


def test_use_cases_api_endpoints(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws = tmp_path / "sample_ws"
    ws.mkdir()
    tasks_dir = ws / "tasks"
    tasks_dir.mkdir()
    (tasks_dir / "00-INDEX.md").write_text("# Tasks Index\n", encoding="utf-8")
    monkeypatch.setattr(state, "workspace", ws)

    # 1. Create a use case
    create_body = {
        "id": "UC001",
        "title": "Search Cars by Budget",
        "actor": "Buyer",
        "status": "active",
        "priority": "P1",
        "verification_command": "echo 'CAR_DATA'",
        "description": "Filter by price",
    }
    res_post = client.post("/api/use-cases", json=create_body, headers=headers)
    assert res_post.status_code == 200
    assert res_post.json()["ok"] is True
    assert res_post.json()["id"] == "UC001"

    # 2. List use cases
    res_list = client.get("/api/use-cases", headers=headers)
    assert res_list.status_code == 200
    list_data = res_list.json()
    assert list_data["ok"] is True
    assert list_data["total"] == 1
    assert list_data["use_cases"][0]["id"] == "UC001"

    # 3. Get use case detail
    res_get = client.get("/api/use-cases/UC001", headers=headers)
    assert res_get.status_code == 200
    assert res_get.json()["use_case"]["title"] == "Search Cars by Budget"

    # 4. Validate use case (without force returns 409 not ready; with force returns 200)
    res_not_ready = client.post("/api/use-cases/UC001/validate", json={"actor": "test-runner"}, headers=headers)
    assert res_not_ready.status_code == 409
    assert "not ready" in res_not_ready.json().get("error", "").lower()

    res_val = client.post("/api/use-cases/UC001/validate", json={"actor": "test-runner", "force": True}, headers=headers)
    assert res_val.status_code == 200
    assert res_val.json()["verdict"] == "pass"

    # 5. Run validation campaign
    res_camp = client.post("/api/use-cases/campaign", json={}, headers=headers)
    assert res_camp.status_code == 200
    camp_data = res_camp.json()
    assert "not_ready" in camp_data
    assert "readiness_score" in camp_data


def test_runs_triage_endpoints_options_preview_start_and_validation(monkeypatch, tmp_path):
    import server as srv

    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path

    recorded_cmds: list[list[str]] = []

    async def fake_run_ai_orch(cmd, timeout=None):
        recorded_cmds.append(cmd)
        if cmd[0:2] == ["run", "options"]:
            return 0, {"ok": True, "mode": "triage", "allowed_modes": ["triage"]}
        if cmd[0:2] == ["run", "preview"]:
            return 0, {"ok": True, "plan_hash": "testhash1234", "argv_display": ["ai-orch", "run", "start"]}
        if cmd[0:2] == ["run", "start"]:
            return 0, {"ok": True, "run_id": "20261017-150000-N001-kilo-abcd", "status": "starting"}
        if cmd[0:2] == ["run", "list"]:
            return 0, {"ok": True, "runs": []}
        return 0, {"ok": True}

    monkeypatch.setattr(srv, "run_ai_orch", fake_run_ai_orch)

    try:
        # 1. Options: missing both task and note -> 400
        res = client.get("/api/runs/options", headers=headers)
        assert res.status_code == 400
        assert "task or note" in res.json().get("error", "")

        # Options: invalid note ID format -> 400
        res = client.get("/api/runs/options?note=invalid", headers=headers)
        assert res.status_code == 400
        assert "Invalid note ID" in res.json().get("error", "")

        # Options: valid note N001 -> 200, passes --note N001
        res = client.get("/api/runs/options?note=N001", headers=headers)
        assert res.status_code == 200
        assert recorded_cmds[-1][0:4] == ["run", "options", "--note", "N001"]

        # Options: task still works -> 200, passes --task T001
        res = client.get("/api/runs/options?task=T001", headers=headers)
        assert res.status_code == 200
        assert recorded_cmds[-1][0:4] == ["run", "options", "--task", "T001"]

        # 2. Preview: missing both task and note -> 400
        res = client.post("/api/runs/preview", headers=headers, json={"mode": "triage"})
        assert res.status_code == 400
        assert "task or note is required" in res.json().get("error", "")

        # Preview: invalid note -> 400
        res = client.post("/api/runs/preview", headers=headers, json={"note": "bad", "mode": "triage"})
        assert res.status_code == 400
        assert "Invalid note ID" in res.json().get("error", "")

        # Preview: valid note -> 200, passes --note N001
        res = client.post("/api/runs/preview", headers=headers, json={"note": "N001", "mode": "triage"})
        assert res.status_code == 200
        assert "--note" in recorded_cmds[-1]
        assert "N001" in recorded_cmds[-1]

        # Preview: task still works
        res = client.post("/api/runs/preview", headers=headers, json={"task": "T001", "mode": "execute"})
        assert res.status_code == 200
        assert "--task" in recorded_cmds[-1]
        assert "T001" in recorded_cmds[-1]

        # 3. Start: missing both task and note -> 400
        res = client.post("/api/runs", headers=headers, json={"expect_plan_hash": "testhash1234"})
        assert res.status_code == 400

        # Start: invalid note -> 400
        res = client.post("/api/runs", headers=headers, json={"note": "invalid", "expect_plan_hash": "testhash1234"})
        assert res.status_code == 400

        # Start: valid note -> 200, passes --note N001
        res = client.post("/api/runs", headers=headers, json={"note": "N001", "expect_plan_hash": "testhash1234", "mode": "triage"})
        assert res.status_code == 200
        assert "--note" in recorded_cmds[-1]
        assert "N001" in recorded_cmds[-1]

        # 4. List: note filter
        res = client.get("/api/runs?note=bad", headers=headers)
        assert res.status_code == 400

        res = client.get("/api/runs?note=N001", headers=headers)
        assert res.status_code == 200
        assert "--note" in recorded_cmds[-1]
        assert "N001" in recorded_cmds[-1]

    finally:
        state.workspace = old_ws


def test_runs_triage_proposal_endpoint(monkeypatch, tmp_path):
    import server as srv

    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path

    valid_run_id = "20261017-150000-N001-kilo-abcd"
    run_dir = tmp_path / ".ai-orchestration" / "runs" / valid_run_id
    run_dir.mkdir(parents=True)

    proposal_data = {
        "tasks": [
            {
                "title": "Proposed task 1",
                "category": "feature",
                "priority": "P2",
                "priority_reason": "important",
                "goal": "Do something",
                "steps": ["Step 1"],
                "verification": "Check it",
            }
        ],
        "updates": [],
        "spec": None,
        "questions": [],
    }
    (run_dir / "triage-proposal.json").write_text(json.dumps(proposal_data), encoding="utf-8")

    show_mode = "triage"
    show_status = "succeeded"
    show_prop_status = "pending"
    show_prop_err = None

    async def fake_run_ai_orch(cmd, timeout=None):
        if cmd[0:2] == ["run", "show"]:
            if cmd[2] == "nonexistent-id":
                return 1, {"error": "Run not found", "reason": "not-found"}
            return 0, {
                "ok": True,
                "run": {
                    "run_id": cmd[2],
                    "mode": show_mode,
                    "status": show_status,
                    "proposal_status": show_prop_status,
                    "proposal_error": show_prop_err,
                },
            }
        return 0, {"ok": True}

    monkeypatch.setattr(srv, "run_ai_orch", fake_run_ai_orch)

    try:
        # Auth check
        res = client.get(f"/api/runs/{valid_run_id}/triage-proposal")
        assert res.status_code == 401

        # Invalid run ID format
        res = client.get("/api/runs/bad-id/triage-proposal", headers=headers)
        assert res.status_code == 400

        # Run not found -> 404
        bad_run = "20261017-150000-none-kilo-0000"
        async def fake_not_found(cmd, timeout=None):
            return 1, {"error": "Run not found", "reason": "not-found"}
        monkeypatch.setattr(srv, "run_ai_orch", fake_not_found)
        res = client.get(f"/api/runs/{bad_run}/triage-proposal", headers=headers)
        assert res.status_code == 404
        monkeypatch.setattr(srv, "run_ai_orch", fake_run_ai_orch)

        # Non-triage run -> 400
        show_mode = "execute"
        res = client.get(f"/api/runs/{valid_run_id}/triage-proposal", headers=headers)
        assert res.status_code == 400
        assert "not a triage run" in res.json().get("error", "")

        # Valid triage run with pending proposal
        show_mode = "triage"
        show_prop_status = "pending"
        res = client.get(f"/api/runs/{valid_run_id}/triage-proposal", headers=headers)
        assert res.status_code == 200
        data = res.json()
        assert data.get("ok") is True
        assert data.get("proposal_status") == "pending"
        assert data.get("proposal") == proposal_data

        # Valid triage run with invalid proposal
        show_prop_status = "invalid"
        show_prop_err = "Syntax error in ```ai-orch-triage block"
        (run_dir / "triage-proposal.json").unlink()
        res = client.get(f"/api/runs/{valid_run_id}/triage-proposal", headers=headers)
        assert res.status_code == 200
        data = res.json()
        assert data.get("proposal_status") == "invalid"
        assert data.get("proposal_error") == show_prop_err
        assert data.get("proposal") is None

    finally:
        state.workspace = old_ws


def test_runs_accept_triage_endpoint_and_broadcast(monkeypatch, tmp_path):
    import server as srv

    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path

    valid_run_id = "20261017-150000-N001-kilo-abcd"
    last_cmd: list[str] = []
    cli_return_code = 0
    cli_return_data: dict = {
        "ok": True,
        "run_id": valid_run_id,
        "note_id": "N001",
        "proposal_status": "accepted",
        "tasks_created": ["T010", "T011"],
    }

    async def fake_run_ai_orch(cmd, timeout=None):
        nonlocal last_cmd
        last_cmd = cmd
        return cli_return_code, cli_return_data

    monkeypatch.setattr(srv, "run_ai_orch", fake_run_ai_orch)

    try:
        # Auth check
        res = client.post(f"/api/runs/{valid_run_id}/accept-triage", json={})
        assert res.status_code == 401

        # Bad run ID
        res = client.post("/api/runs/bad-id/accept-triage", headers=headers, json={})
        assert res.status_code == 400

        # Success case with only and expect_note_hash
        broadcasts: list[dict] = []
        orig_broadcast = state.broadcast

        async def capture_broadcast(msg):
            broadcasts.append(msg)
            await orig_broadcast(msg)

        monkeypatch.setattr(state, "broadcast", capture_broadcast)

        res = client.post(
            f"/api/runs/{valid_run_id}/accept-triage",
            headers=headers,
            json={"only": [0, 1], "expect_note_hash": "notehash123"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data.get("ok") is True
        assert data.get("proposal_status") == "accepted"
        assert data.get("tasks_created") == ["T010", "T011"]

        # Check command args passed to CLI
        assert last_cmd[0:3] == ["run", "accept-triage", valid_run_id]
        assert "--only" in last_cmd
        assert last_cmd[last_cmd.index("--only") + 1] == "0,1"
        assert "--expect-note-hash" in last_cmd
        assert last_cmd[last_cmd.index("--expect-note-hash") + 1] == "notehash123"

        # Check broadcast
        assert any(b.get("type") == "changed" and set(b.get("areas", [])) == {"inbox", "tasks"} for b in broadcasts)

        # Conflict error (e.g. note changed, stale-note-hash) -> 409
        cli_return_code = 1
        cli_return_data = {
            "error": "Inbox note 'N001' hash mismatch",
            "reason": "stale-note-hash",
        }
        res = client.post(
            f"/api/runs/{valid_run_id}/accept-triage",
            headers=headers,
            json={"expect_note_hash": "oldhash"},
        )
        assert res.status_code == 409

        # Run not found -> 404
        cli_return_code = 1
        cli_return_data = {
            "error": "Run not found",
            "reason": "run-not-found",
        }
        res = client.post(
            f"/api/runs/{valid_run_id}/accept-triage",
            headers=headers,
            json={},
        )
        assert res.status_code == 404

        # Proposal not pending -> 400
        cli_return_code = 1
        cli_return_data = {
            "error": "Proposal already accepted",
            "reason": "proposal-not-pending",
        }
        res = client.post(
            f"/api/runs/{valid_run_id}/accept-triage",
            headers=headers,
            json={},
        )
        assert res.status_code == 400

    finally:
        state.workspace = old_ws


def test_runs_accept_triage_with_edits(monkeypatch, tmp_path):
    import server as srv

    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path

    valid_run_id = "20261017-150000-N001-kilo-abcd"
    last_cmd: list[str] = []
    cli_return_code = 0
    cli_return_data: dict = {
        "ok": True,
        "run_id": valid_run_id,
        "note_id": "N001",
        "proposal_status": "accepted",
        "tasks_created": ["T010"],
    }
    captured_edits_content = None
    captured_edits_file_path = None

    async def fake_run_ai_orch(cmd, timeout=None):
        nonlocal last_cmd, captured_edits_content, captured_edits_file_path
        last_cmd = list(cmd)
        if "--edits-file" in cmd:
            captured_edits_file_path = cmd[cmd.index("--edits-file") + 1]
            p = pathlib.Path(captured_edits_file_path)
            if p.is_file():
                captured_edits_content = p.read_text(encoding="utf-8")
        return cli_return_code, cli_return_data

    monkeypatch.setattr(srv, "run_ai_orch", fake_run_ai_orch)

    try:
        # 1. No edits -> unchanged behavior, --edits-file not passed
        res = client.post(
            f"/api/runs/{valid_run_id}/accept-triage",
            headers=headers,
            json={"only": [0]},
        )
        assert res.status_code == 200
        assert "--edits-file" not in last_cmd
        assert last_cmd[0:3] == ["run", "accept-triage", valid_run_id]

        # 2. Unknown field refused with 400
        res = client.post(
            f"/api/runs/{valid_run_id}/accept-triage",
            headers=headers,
            json={
                "only": [0],
                "edits": {
                    "0": {
                        "title": "Valid title",
                        "unknown_field": "bogus",
                    }
                },
            },
        )
        assert res.status_code == 400
        assert "Unknown field 'unknown_field'" in res.json().get("error", "")

        # 3. Invalid edits types and indices
        res = client.post(
            f"/api/runs/{valid_run_id}/accept-triage",
            headers=headers,
            json={"edits": "not-an-object"},
        )
        assert res.status_code == 400

        res = client.post(
            f"/api/runs/{valid_run_id}/accept-triage",
            headers=headers,
            json={"edits": {"-1": {"title": "negative index"}}},
        )
        assert res.status_code == 400

        res = client.post(
            f"/api/runs/{valid_run_id}/accept-triage",
            headers=headers,
            json={"edits": {"abc": {"title": "non-int index"}}},
        )
        assert res.status_code == 400

        res = client.post(
            f"/api/runs/{valid_run_id}/accept-triage",
            headers=headers,
            json={"edits": {"0": "not-a-dict"}},
        )
        assert res.status_code == 400

        # 4. Valid edits forwarded and written to temp file in workspace/.ai-orchestration/tmp/
        expected_edits = {
            "0": {
                "title": "Edited Task Title",
                "category": "cli",
                "priority": "P1",
                "priority_reason": "Urgent bug",
                "goal": "Refactor CLI runner",
                "steps": ["Step 1", "Step 2"],
                "verification": "pytest backend",
            }
        }
        res = client.post(
            f"/api/runs/{valid_run_id}/accept-triage",
            headers=headers,
            json={"only": [0], "edits": expected_edits},
        )
        assert res.status_code == 200
        assert "--edits-file" in last_cmd
        edits_path_arg = last_cmd[last_cmd.index("--edits-file") + 1]
        assert str(state.workspace / ".ai-orchestration" / "tmp") in edits_path_arg
        assert captured_edits_content is not None
        assert json.loads(captured_edits_content) == expected_edits
        # Assert temp file is deleted after the call in finally
        assert not pathlib.Path(edits_path_arg).exists()

        # 5. Engine errors mapped to 400
        cli_return_code = 1
        cli_return_data = {
            "ok": False,
            "reason": "invalid-edits-file",
            "error": "Failed to parse edits file JSON",
        }
        res = client.post(
            f"/api/runs/{valid_run_id}/accept-triage",
            headers=headers,
            json={"edits": {"0": {"title": "T"}}},
        )
        assert res.status_code == 400
        assert res.json().get("error") == "Failed to parse edits file JSON"

        cli_return_data = {
            "ok": False,
            "reason": "invalid-edit",
            "error": "Invalid priority 'P9' in edits for task index 0",
        }
        res = client.post(
            f"/api/runs/{valid_run_id}/accept-triage",
            headers=headers,
            json={"edits": {"0": {"title": "T"}}},
        )
        assert res.status_code == 400
        assert "Invalid priority" in res.json().get("error", "")

    finally:
        state.workspace = old_ws


def make_test_pdf() -> bytes:
    return b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"


def test_task_attachments_auth_enforced():
    # Endpoints without token -> 401
    assert client.post("/api/tasks/T001/attachments").status_code == 401
    assert client.get("/api/tasks/T001/attachments/01-test.png").status_code == 401
    assert client.delete("/api/tasks/T001/attachments/01-test.png").status_code == 401

    # Endpoints with bad token -> 401
    bad_headers = {"X-AI-Orch-Token": "bad-token"}
    assert client.post("/api/tasks/T001/attachments", headers=bad_headers).status_code == 401
    assert client.get("/api/tasks/T001/attachments/01-test.png", headers=bad_headers).status_code == 401
    assert client.delete("/api/tasks/T001/attachments/01-test.png", headers=bad_headers).status_code == 401


def test_task_attachments_plan_and_bad_ids_refused():
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}

    # Plan tasks (NN.T, NN.N, INIT-NN) must be refused with 400 "plan tasks take no attachments"
    for plan_id in ["01.1", "08.T1", "NN.T", "INIT-01", "09.8", "01"]:
        res_post = client.post(f"/api/tasks/{plan_id}/attachments", headers=headers)
        assert res_post.status_code == 400
        assert "plan tasks" in res_post.json().get("error", "").lower()

        res_get = client.get(f"/api/tasks/{plan_id}/attachments/01-test.png", headers=headers)
        assert res_get.status_code == 400
        assert "plan tasks" in res_get.json().get("error", "").lower()

        res_del = client.delete(f"/api/tasks/{plan_id}/attachments/01-test.png", headers=headers)
        assert res_del.status_code == 400
        assert "plan tasks" in res_del.json().get("error", "").lower()

    # Invalid ID formats must be 400
    for bad_id in ["invalid_id", "T1", "T12", "t001", "T-001"]:
        assert client.post(f"/api/tasks/{bad_id}/attachments", headers=headers).status_code == 400
        assert client.get(f"/api/tasks/{bad_id}/attachments/01-test.png", headers=headers).status_code == 400
        assert client.delete(f"/api/tasks/{bad_id}/attachments/01-test.png", headers=headers).status_code == 400


def test_task_attachments_crud_flow_and_classes(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}

    ws = tmp_path / "ws"
    ws.mkdir()
    tasks_dir = ws / "tasks"
    tasks_dir.mkdir()
    (tasks_dir / "00-INDEX.md").write_text("# Tasks Index\n", encoding="utf-8")

    old_ws = state.workspace
    state.workspace = ws
    try:
        # Create an emergent task
        res_new = client.post(
            "/api/inbox",
            headers=headers,
            json={"title": "Seed note", "status": "ready"},
        )
        note_id = res_new.json()["id"]
        res_totask = client.post(
            f"/api/inbox/{note_id}/to-task",
            headers=headers,
            json={"category": "feature", "title": "Implement task attachments"},
        )
        assert res_totask.status_code == 200
        task_id = res_totask.json()["id"]
        assert task_id.startswith("T")

        # 1. Non-existent task -> 404
        assert client.post(f"/api/tasks/T999/attachments", headers=headers, files={"file": ("test.png", make_test_png(), "image/png")}).status_code == 404
        assert client.get(f"/api/tasks/T999/attachments/01-test.png", headers=headers).status_code == 404
        assert client.delete(f"/api/tasks/T999/attachments/01-test.png", headers=headers).status_code == 404

        # 2. Traversal names -> 400
        for bad_name in ["..%2F..%2Fetc", "a/b", ".hidden"]:
            assert client.get(f"/api/tasks/{task_id}/attachments/{bad_name}", headers=headers).status_code in (400, 404)
            assert client.delete(f"/api/tasks/{task_id}/attachments/{bad_name}", headers=headers).status_code in (400, 404)

        # 3. Upload & Serve Image (PNG) -> inline, sniffed image Content-Type, nosniff, CSP
        png_data = make_test_png(4, 4)
        res_img = client.post(
            f"/api/tasks/{task_id}/attachments",
            headers=headers,
            files={"file": ("screen.png", png_data, "image/png")},
        )
        assert res_img.status_code == 200
        img_json = res_img.json()
        assert img_json["ok"] is True
        assert img_json["class"] == "image"
        img_name = img_json["attachment"]
        current_hash = img_json["bundle_sha256"]

        res_get_img = client.get(f"/api/tasks/{task_id}/attachments/{img_name}", headers=headers)
        assert res_get_img.status_code == 200
        assert res_get_img.content == png_data
        assert res_get_img.headers["content-type"].startswith("image/png")
        assert res_get_img.headers["x-content-type-options"] == "nosniff"
        assert res_get_img.headers["content-security-policy"] == CSP_HEADER
        assert "content-disposition" not in res_get_img.headers

        # 4. Upload & Serve Text (.log) -> inline, text/plain; charset=utf-8, nosniff, CSP
        log_data = b"2026-10-17 12:00:00 [INFO] test log output\n"
        res_txt = client.post(
            f"/api/tasks/{task_id}/attachments",
            headers=headers,
            files={"file": ("server.log", log_data, "text/plain")},
        )
        assert res_txt.status_code == 200
        txt_json = res_txt.json()
        assert txt_json["ok"] is True
        assert txt_json["class"] == "text"
        txt_name = txt_json["attachment"]
        current_hash = txt_json["bundle_sha256"]

        res_get_txt = client.get(f"/api/tasks/{task_id}/attachments/{txt_name}", headers=headers)
        assert res_get_txt.status_code == 200
        assert res_get_txt.content == log_data
        assert res_get_txt.headers["content-type"] == "text/plain; charset=utf-8"
        assert res_get_txt.headers["x-content-type-options"] == "nosniff"
        assert res_get_txt.headers["content-security-policy"] == CSP_HEADER
        assert "content-disposition" not in res_get_txt.headers

        # 5. Upload & Serve PDF (.pdf) -> application/pdf, Content-Disposition: attachment, nosniff, CSP
        pdf_data = make_test_pdf()
        res_pdf = client.post(
            f"/api/tasks/{task_id}/attachments",
            headers=headers,
            files={"file": ("report.pdf", pdf_data, "application/pdf")},
        )
        assert res_pdf.status_code == 200
        pdf_json = res_pdf.json()
        assert pdf_json["ok"] is True
        assert pdf_json["class"] == "pdf"
        pdf_name = pdf_json["attachment"]
        current_hash = pdf_json["bundle_sha256"]

        res_get_pdf = client.get(f"/api/tasks/{task_id}/attachments/{pdf_name}", headers=headers)
        assert res_get_pdf.status_code == 200
        assert res_get_pdf.content == pdf_data
        assert res_get_pdf.headers["content-type"] == "application/pdf"
        assert res_get_pdf.headers["x-content-type-options"] == "nosniff"
        assert res_get_pdf.headers["content-security-policy"] == CSP_HEADER
        assert res_get_pdf.headers["content-disposition"] == f'attachment; filename="{pdf_name}"'

        # 6. Upload with stale expect_task_hash -> 409
        res_stale = client.post(
            f"/api/tasks/{task_id}/attachments",
            headers=headers,
            data={"expect_task_hash": "stalehash123"},
            files={"file": ("another.log", b"log text", "text/plain")},
        )
        assert res_stale.status_code == 409

        # 7. Upload binary junk -> refused (415)
        res_junk = client.post(
            f"/api/tasks/{task_id}/attachments",
            headers=headers,
            files={"file": ("junk.bin", b"\x00\x01\x02\x03\xff", "application/octet-stream")},
        )
        assert res_junk.status_code in (415, 400)

        # 8. Upload oversized file (>10MB) -> 413
        big_data = b"X" * (11 * 1024 * 1024)
        res_big = client.post(
            f"/api/tasks/{task_id}/attachments",
            headers=headers,
            files={"file": ("huge.log", big_data, "text/plain")},
        )
        assert res_big.status_code == 413

        # 9. Delete with stale expect_task_hash -> 409
        res_del_stale = client.delete(
            f"/api/tasks/{task_id}/attachments/{txt_name}?expect_task_hash=badhash",
            headers=headers,
        )
        assert res_del_stale.status_code == 409

        # 10. Delete attachment with valid/no hash -> 200
        res_del = client.delete(f"/api/tasks/{task_id}/attachments/{txt_name}", headers=headers)
        assert res_del.status_code == 200
        assert res_del.json()["ok"] is True
        assert res_del.json()["detached"] == txt_name

        # Subsequent GET -> 404
        assert client.get(f"/api/tasks/{task_id}/attachments/{txt_name}", headers=headers).status_code == 404

        # Delete non-existent attachment -> 404
        assert client.delete(f"/api/tasks/{task_id}/attachments/notfound.log", headers=headers).status_code == 404
    finally:
        state.workspace = old_ws


def test_inbox_per_class_serving_and_junk_refusal(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}

    ws = tmp_path / "ws_inbox"
    ws.mkdir()
    tasks_dir = ws / "tasks"
    tasks_dir.mkdir()
    (tasks_dir / "00-INDEX.md").write_text("# Tasks Index\n", encoding="utf-8")

    old_ws = state.workspace
    state.workspace = ws
    try:
        # Create inbox note
        res_note = client.post(
            "/api/inbox",
            headers=headers,
            json={"title": "Note for class serving", "status": "ready"},
        )
        assert res_note.status_code == 200
        note_id = res_note.json()["id"]

        # 1. Upload .log file (plain text) -> accepted (200), class "text"
        log_bytes = b"2026-10-17 12:00:00 app log test\n"
        res_log = client.post(
            f"/api/inbox/{note_id}/attachments",
            headers=headers,
            files={"file": ("app.log", log_bytes, "text/plain")},
        )
        assert res_log.status_code == 200
        log_name = res_log.json()["attachment"]
        assert res_log.json()["class"] == "text"

        # Serve .log -> inline, text/plain; charset=utf-8, nosniff, CSP
        res_get_log = client.get(f"/api/inbox/{note_id}/attachments/{log_name}", headers=headers)
        assert res_get_log.status_code == 200
        assert res_get_log.content == log_bytes
        assert res_get_log.headers["content-type"] == "text/plain; charset=utf-8"
        assert res_get_log.headers["x-content-type-options"] == "nosniff"
        assert res_get_log.headers["content-security-policy"] == CSP_HEADER
        assert "content-disposition" not in res_get_log.headers

        # 2. Upload .pdf file -> accepted (200), class "pdf"
        pdf_bytes = make_test_pdf()
        res_pdf = client.post(
            f"/api/inbox/{note_id}/attachments",
            headers=headers,
            files={"file": ("doc.pdf", pdf_bytes, "application/pdf")},
        )
        assert res_pdf.status_code == 200
        pdf_name = res_pdf.json()["attachment"]
        assert res_pdf.json()["class"] == "pdf"

        # Serve .pdf -> application/pdf, Content-Disposition: attachment, nosniff, CSP
        res_get_pdf = client.get(f"/api/inbox/{note_id}/attachments/{pdf_name}", headers=headers)
        assert res_get_pdf.status_code == 200
        assert res_get_pdf.content == pdf_bytes
        assert res_get_pdf.headers["content-type"] == "application/pdf"
        assert res_get_pdf.headers["x-content-type-options"] == "nosniff"
        assert res_get_pdf.headers["content-security-policy"] == CSP_HEADER
        assert res_get_pdf.headers["content-disposition"] == f'attachment; filename="{pdf_name}"'

        # 3. Upload binary junk -> refused with 415 or 400
        junk_bytes = b"\x00\x01\x02\x03junk"
        res_junk = client.post(
            f"/api/inbox/{note_id}/attachments",
            headers=headers,
            files={"file": ("junk.bin", junk_bytes, "application/octet-stream")},
        )
        assert res_junk.status_code in (415, 400)

        # 4. Upload binary junk disguised as .log (has NUL byte) -> refused
        bad_log_bytes = b"text before null\x00text after"
        res_bad_log = client.post(
            f"/api/inbox/{note_id}/attachments",
            headers=headers,
            files={"file": ("bad.log", bad_log_bytes, "text/plain")},
        )
        assert res_bad_log.status_code in (415, 400)
    finally:
        state.workspace = old_ws


def test_attachment_writes_broadcast_websocket(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}

    ws = tmp_path / "ws_broadcast"
    ws.mkdir()
    tasks_dir = ws / "tasks"
    tasks_dir.mkdir()
    (tasks_dir / "00-INDEX.md").write_text("# Tasks Index\n", encoding="utf-8")

    old_ws = state.workspace
    state.workspace = ws
    try:
        # Create a task and a note
        res_note = client.post("/api/inbox", headers=headers, json={"title": "WS note", "status": "ready"})
        note_id = res_note.json()["id"]

        res_totask = client.post(
            f"/api/inbox/{note_id}/to-task",
            headers=headers,
            json={"category": "feature", "title": "WS task"},
        )
        task_id = res_totask.json()["id"]

        with client.websocket_connect(f"/ws?token={token}") as sock:
            init_msg = sock.receive_json()
            assert init_msg.get("type") == "connected"

            # 1. Task attach broadcast
            log_data = b"task log data\n"
            res_up_task = client.post(
                f"/api/tasks/{task_id}/attachments",
                headers=headers,
                files={"file": ("test.log", log_data, "text/plain")},
            )
            assert res_up_task.status_code == 200
            task_att_name = res_up_task.json()["attachment"]

            msg_task_attach = sock.receive_json()
            assert msg_task_attach.get("type") == "changed"
            assert msg_task_attach.get("areas") == ["tasks"]

            # 2. Task detach broadcast
            res_del_task = client.delete(
                f"/api/tasks/{task_id}/attachments/{task_att_name}",
                headers=headers,
            )
            assert res_del_task.status_code == 200

            msg_task_detach = sock.receive_json()
            assert msg_task_detach.get("type") == "changed"
            assert msg_task_detach.get("areas") == ["tasks"]

            # 3. Inbox attach broadcast
            res_up_note = client.post(
                f"/api/inbox/{note_id}/attachments",
                headers=headers,
                files={"file": ("note.log", log_data, "text/plain")},
            )
            assert res_up_note.status_code == 200
            note_att_name = res_up_note.json()["attachment"]

            # Receives inbox_updated and changed
            msgs = [sock.receive_json(), sock.receive_json()]
            changed_msg = next((m for m in msgs if m.get("type") == "changed"), None)
            assert changed_msg is not None
            assert changed_msg.get("areas") == ["inbox"]

            # 4. Inbox detach broadcast
            res_del_note = client.delete(
                f"/api/inbox/{note_id}/attachments/{note_att_name}",
                headers=headers,
            )
            assert res_del_note.status_code == 200

            msgs_del = [sock.receive_json(), sock.receive_json()]
            changed_del = next((m for m in msgs_del if m.get("type") == "changed"), None)
            assert changed_del is not None
            assert changed_del.get("areas") == ["inbox"]
    finally:
        state.workspace = old_ws


def test_timeline_graph_and_edit_endpoints(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}

    ws = tmp_path / "graph_ws"
    ws.mkdir()
    tasks_dir = ws / "tasks"
    tasks_dir.mkdir()
    (tasks_dir / "00-INDEX.md").write_text("# Tasks Index\n", encoding="utf-8")
    (tasks_dir / "01-test").mkdir()
    (tasks_dir / "01-test" / "plan.md").write_text(
        "# 01 - Test Initiative\n\n"
        "## Tasks\n\n"
        "### 01.1 - Root Task\n"
        "- **Status:** `open`\n"
        "- **Priority:** P2\n"
        "- **Size:** M\n"
        "- **Depends on:** -\n\n"
        "### 01.2 - Child Task\n"
        "- **Status:** `open`\n"
        "- **Priority:** P2\n"
        "- **Size:** S\n"
        "- **Depends on:** 01.1\n\n"
        "### 01.3 - Independent Task\n"
        "- **Status:** `open`\n"
        "- **Priority:** P1\n"
        "- **Size:** L\n"
        "- **Depends on:** -\n",
        encoding="utf-8",
    )

    old_ws = state.workspace
    state.workspace = ws
    try:
        # 1. GET /api/tasks/graph - unauth
        res_unauth = client.get("/api/tasks/graph")
        assert res_unauth.status_code == 401

        # 2. GET /api/tasks/graph - auth
        res_graph = client.get("/api/tasks/graph", headers=headers)
        assert res_graph.status_code == 200
        gdata = res_graph.json()
        assert gdata.get("ok") is True
        assert len(gdata.get("nodes", [])) == 3
        assert gdata["columns"]["01.1"] == 0
        assert gdata["columns"]["01.2"] == 1
        assert "01.1" in gdata["ready_queue"]
        assert "01.3" in gdata["ready_queue"]
        assert "01.2" not in gdata["ready_queue"]

        # 3. ID Validation
        res_bad_id = client.post("/api/tasks/invalid_id/priority/preview", headers=headers, json={"priority": "P0"})
        assert res_bad_id.status_code == 400
        assert "Invalid task id" in res_bad_id.json().get("error", "")

        # 4. Priority validation & mutations
        res_bad_prio = client.post("/api/tasks/01.1/priority/preview", headers=headers, json={"priority": "P9"})
        assert res_bad_prio.status_code == 400
        assert "Invalid priority" in res_bad_prio.json().get("error", "")

        res_prio_prev = client.post("/api/tasks/01.1/priority/preview", headers=headers, json={"priority": "P0"})
        assert res_prio_prev.status_code == 200
        prev_pdata = res_prio_prev.json()
        assert prev_pdata.get("dry_run") is True
        assert "diff" in prev_pdata
        task_hash = prev_pdata.get("task_hash")
        assert task_hash is not None

        # Apply priority without hash -> 400
        res_apply_nohash = client.post("/api/tasks/01.1/priority", headers=headers, json={"priority": "P0"})
        assert res_apply_nohash.status_code == 400
        assert "expect_task_hash is required" in res_apply_nohash.json().get("error", "")

        # Apply priority with stale hash -> 409
        res_apply_stale = client.post("/api/tasks/01.1/priority", headers=headers, json={"priority": "P0", "expect_task_hash": "deadbeef" * 8})
        assert res_apply_stale.status_code == 409

        # Apply priority with correct hash -> 200 and broadcast
        with client.websocket_connect(f"/ws?token={token}") as sock:
            init_msg = sock.receive_json()
            assert init_msg.get("type") == "connected"

            res_apply_ok = client.post("/api/tasks/01.1/priority", headers=headers, json={"priority": "P0", "expect_task_hash": task_hash})
            assert res_apply_ok.status_code == 200

            ws_msg = sock.receive_json()
            assert ws_msg.get("type") == "changed"
            assert ws_msg.get("areas") == ["tasks"]

        # 5. Size validation & mutations
        res_bad_size = client.post("/api/tasks/01.1/size/preview", headers=headers, json={"size": "HUGE"})
        assert res_bad_size.status_code == 400
        assert "Invalid size" in res_bad_size.json().get("error", "")

        res_size_prev = client.post("/api/tasks/01.1/size/preview", headers=headers, json={"size": "L"})
        assert res_size_prev.status_code == 200
        prev_sdata = res_size_prev.json()
        assert prev_sdata.get("dry_run") is True
        size_hash = prev_sdata.get("task_hash")

        res_size_stale = client.post("/api/tasks/01.1/size", headers=headers, json={"size": "L", "expect_task_hash": "wronghash"})
        assert res_size_stale.status_code == 409

        res_size_ok = client.post("/api/tasks/01.1/size", headers=headers, json={"size": "L", "expect_task_hash": size_hash})
        assert res_size_ok.status_code == 200

        # 6. Deps validation & mutations
        res_empty_deps = client.post("/api/tasks/01.1/deps/preview", headers=headers, json={})
        assert res_empty_deps.status_code == 400

        res_bad_dep_id = client.post("/api/tasks/01.1/deps/preview", headers=headers, json={"add": ["bad id"]})
        assert res_bad_dep_id.status_code == 400

        # Cycle refusal: 01.1 adding 01.2 creates cycle (01.2 already depends on 01.1)
        res_cycle = client.post("/api/tasks/01.1/deps/preview", headers=headers, json={"add": ["01.2"]})
        assert res_cycle.status_code == 400
        assert "Cycle detected" in res_cycle.json().get("error", "")

        # Valid dep addition: 01.3 depends on 01.2
        res_dep_prev = client.post("/api/tasks/01.3/deps/preview", headers=headers, json={"add": ["01.2"]})
        assert res_dep_prev.status_code == 200
        dep_data = res_dep_prev.json()
        assert dep_data.get("dry_run") is True
        dep_hash = dep_data.get("task_hash")

        res_dep_stale = client.post("/api/tasks/01.3/deps", headers=headers, json={"add": ["01.2"], "expect_task_hash": "stalehash"})
        assert res_dep_stale.status_code == 409

        res_dep_ok = client.post("/api/tasks/01.3/deps", headers=headers, json={"add": ["01.2"], "expect_task_hash": dep_hash})
        assert res_dep_ok.status_code == 200

        # Remove dependency: 01.3 remove 01.2
        res_dep_rem_prev = client.post("/api/tasks/01.3/deps/preview", headers=headers, json={"remove": ["01.2"]})
        assert res_dep_rem_prev.status_code == 200
        rem_hash = res_dep_rem_prev.json().get("task_hash")
        res_dep_rem_ok = client.post("/api/tasks/01.3/deps", headers=headers, json={"remove": ["01.2"], "expect_task_hash": rem_hash})
        assert res_dep_rem_ok.status_code == 200
    finally:
        state.workspace = old_ws


def test_task_structure_endpoints(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}

    ws = tmp_path / "workspace"
    ws.mkdir()
    tasks_dir = ws / "tasks"
    tasks_dir.mkdir()
    (tasks_dir / "00-INDEX.md").write_text("# Tasks Index\n", encoding="utf-8")
    (tasks_dir / "01-test").mkdir()
    (tasks_dir / "01-test" / "plan.md").write_text(
        "# 01 - Test Initiative\n\n"
        "## Tasks\n\n"
        "### 01.1 - Root Task\n\n"
        "- **Status:** `open` · **Priority:** P2 · **Size:** M\n"
        "- **Goal:** Root task goal\n\n"
        "### 01.2 - Child Task\n\n"
        "- **Status:** `open` · **Priority:** P2 · **Size:** S\n"
        "- **Goal:** Child task goal\n",
        encoding="utf-8",
    )

    old_ws = state.workspace
    state.workspace = ws
    try:
        # 1. Unauthenticated checks
        assert client.post("/api/tasks/01/child/preview").status_code == 401
        assert client.post("/api/tasks/01/child").status_code == 401
        assert client.post("/api/tasks/01.1/expand/preview").status_code == 401
        assert client.post("/api/tasks/01.1/expand").status_code == 401
        assert client.post("/api/tasks/01.1/collapse/preview").status_code == 401
        assert client.post("/api/tasks/01.1/collapse").status_code == 401
        assert client.post("/api/tasks/01.1/reopen/preview").status_code == 401
        assert client.post("/api/tasks/01.1/reopen").status_code == 401

        # 2. Validation checks
        assert client.post("/api/tasks/invalid-id!/child/preview", headers=headers, json={"title": "foo"}).status_code == 400
        assert client.post("/api/tasks/01/child/preview", headers=headers, json={"title": ""}).status_code == 400
        assert client.post("/api/tasks/01/child", headers=headers, json={"title": "foo"}).status_code == 400
        assert client.post("/api/tasks/01.1/reopen/preview", headers=headers, json={"reason": ""}).status_code == 400

        # 3. Child add preview on initiative 01
        res_child_prev = client.post("/api/tasks/01/child/preview", headers=headers, json={"title": "New Third Task"})
        assert res_child_prev.status_code == 200
        prev_data = res_child_prev.json()
        assert prev_data.get("ok") is True
        assert prev_data.get("dry_run") is True
        assert prev_data.get("allocated_id") == "01.3"
        plan_hash = prev_data.get("plan_hash")
        assert plan_hash

        # 4. Stale plan hash on child add apply
        res_stale = client.post("/api/tasks/01/child", headers=headers, json={"title": "New Third Task", "expect_plan_hash": "deadbeef" * 8})
        assert res_stale.status_code == 409

        # 5. Successful child add apply
        res_apply = client.post("/api/tasks/01/child", headers=headers, json={"title": "New Third Task", "expect_plan_hash": plan_hash})
        assert res_apply.status_code == 200
        apply_data = res_apply.json()
        assert apply_data.get("ok") is True
        assert apply_data.get("allocated_id") == "01.3"

        # Check detail endpoint retrieves new child 01.3
        res_detail = client.get("/api/tasks/01.3", headers=headers)
        assert res_detail.status_code == 200
        assert "New Third Task" in res_detail.json().get("content", "")

        # 6. Expand preview and apply on 01.2
        res_exp_prev = client.post("/api/tasks/01.2/expand/preview", headers=headers)
        assert res_exp_prev.status_code == 200
        exp_hash = res_exp_prev.json().get("plan_hash")
        assert exp_hash

        res_exp_stale = client.post("/api/tasks/01.2/expand", headers=headers, json={"expect_plan_hash": "badhash"})
        assert res_exp_stale.status_code == 409

        res_exp_ok = client.post("/api/tasks/01.2/expand", headers=headers, json={"expect_plan_hash": exp_hash})
        assert res_exp_ok.status_code == 200

        # 7. Container transition refused with 400
        res_trans_container = client.post("/api/tasks/transition", headers=headers, json={"task_id": "01", "new_state": "done"})
        assert res_trans_container.status_code == 400
        assert "derived state" in res_trans_container.json().get("error", "")

        # 8. Child add on a folder emergent task creates T###.1
        fld_dir = tasks_dir / "methodology" / "T040-sample-folder"
        fld_dir.mkdir(parents=True)
        (fld_dir / "README.md").write_text(
            "# T040 Sample Folder Task\n\n"
            "- id: T040\n"
            "- title: Sample Folder Task\n"
            "- category: methodology\n"
            "- priority: P1\n"
            "- state: open\n"
            "- goal: Folder goal\n",
            encoding="utf-8",
        )
        res_fld_prev = client.post("/api/tasks/T040/child/preview", headers=headers, json={"title": "First Subtask"})
        assert res_fld_prev.status_code == 200
        fld_prev_data = res_fld_prev.json()
        assert fld_prev_data.get("ok") is True
        assert fld_prev_data.get("allocated_id") == "T040.1"
        fld_hash = fld_prev_data.get("plan_hash")

        res_fld_apply = client.post("/api/tasks/T040/child", headers=headers, json={"title": "First Subtask", "expect_plan_hash": fld_hash})
        assert res_fld_apply.status_code == 200
        assert res_fld_apply.json().get("allocated_id") == "T040.1"

        # Verify detail of T040.1
        res_sub_detail = client.get("/api/tasks/T040.1", headers=headers)
        assert res_sub_detail.status_code == 200
        assert "First Subtask" in res_sub_detail.json().get("content", "")

    finally:
        state.workspace = old_ws


def test_microtask_kind_labels_promote_endpoints(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}

    ws = tmp_path / "micro_ws"
    ws.mkdir()
    tasks_dir = ws / "tasks"
    tasks_dir.mkdir()
    (tasks_dir / "00-INDEX.md").write_text("# Tasks Index\n", encoding="utf-8")
    (tasks_dir / "01-test").mkdir()
    (tasks_dir / "01-test" / "plan.md").write_text(
        "# 01 - Test Initiative\n\n"
        "## Tasks\n\n"
        "### 01.1 - Root Task\n\n"
        "- **Status:** `open` · **Priority:** P2 · **Size:** M\n"
        "- **Goal:** Root task goal\n\n"
        "### 01.2 - Child Task\n\n"
        "- **Status:** `open` · **Priority:** P2 · **Size:** S\n"
        "- **Goal:** Child task goal\n",
        encoding="utf-8",
    )

    old_ws = state.workspace
    state.workspace = ws
    try:
        # 1. Unauthenticated checks
        assert client.get("/api/tasks/labels").status_code == 401
        assert client.post("/api/tasks/micro").status_code == 401
        assert client.post("/api/tasks/01.1/kind/preview").status_code == 401
        assert client.post("/api/tasks/01.1/kind").status_code == 401
        assert client.post("/api/tasks/01.1/labels/preview").status_code == 401
        assert client.post("/api/tasks/01.1/labels").status_code == 401
        assert client.post("/api/tasks/T001/promote/preview").status_code == 401
        assert client.post("/api/tasks/T001/promote").status_code == 401
        assert client.post("/api/inbox/N001/to-microtask").status_code == 401

        # 2. Initial labels list
        res_lbls = client.get("/api/tasks/labels", headers=headers)
        assert res_lbls.status_code == 200
        assert res_lbls.json().get("labels") == []

        # 3. Microtask creation validation
        res_bad_title = client.post("/api/tasks/micro", headers=headers, json={"title": ""})
        assert res_bad_title.status_code == 400

        res_bad_kind = client.post("/api/tasks/micro", headers=headers, json={"title": "Test", "kind": "invalid"})
        assert res_bad_kind.status_code == 400

        res_bad_prio = client.post("/api/tasks/micro", headers=headers, json={"title": "Test", "priority": "P9"})
        assert res_bad_prio.status_code == 400

        # Successful microtask creation with WebSocket broadcast verification
        with client.websocket_connect(f"/ws?token={token}") as sock:
            init_msg = sock.receive_json()
            assert init_msg.get("type") == "connected"

            res_create = client.post(
                "/api/tasks/micro",
                headers=headers,
                json={
                    "title": "Fix navbar overflow",
                    "kind": "bug",
                    "priority": "P1",
                    "labels": ["ui", "regression"],
                    "what": "Fix the horizontal scroll on small screens.",
                },
            )
            assert res_create.status_code == 201
            cdata = res_create.json()
            assert cdata.get("ok") is True
            micro_id = cdata.get("id")
            assert micro_id is not None
            assert micro_id.startswith("T")

            ws_msg1 = sock.receive_json()
            assert ws_msg1.get("type") == "changed"
            assert ws_msg1.get("areas") == ["tasks"]

            ws_msg2 = sock.receive_json()
            assert ws_msg2.get("type") == "task_created"
            assert ws_msg2.get("task_id") == micro_id

        # 4. Check labels list reflects the new microtask labels
        res_lbls2 = client.get("/api/tasks/labels", headers=headers)
        assert res_lbls2.status_code == 200
        lbl_names = [item["label"] for item in res_lbls2.json().get("labels", [])]
        assert "ui" in lbl_names
        assert "regression" in lbl_names

        # 5. Query parameters on tasks list and graph
        res_filter_kind = client.get("/api/tasks?kind=bug", headers=headers)
        assert res_filter_kind.status_code == 200

        res_filter_label = client.get("/api/tasks/graph?label=ui", headers=headers)
        assert res_filter_label.status_code == 200
        gdata = res_filter_label.json()
        assert gdata.get("ok") is True
        assert any(n["id"] == micro_id for n in gdata.get("nodes", []))

        # 6. Kind mutation preview & apply
        res_bad_k = client.post(f"/api/tasks/{micro_id}/kind/preview", headers=headers, json={"kind": "unknown"})
        assert res_bad_k.status_code == 400

        res_kind_prev = client.post(f"/api/tasks/{micro_id}/kind/preview", headers=headers, json={"kind": "fix"})
        assert res_kind_prev.status_code == 200
        kprev = res_kind_prev.json()
        assert kprev.get("dry_run") is True
        task_hash = kprev.get("task_hash") or kprev.get("hash")
        assert task_hash

        res_k_stale = client.post(f"/api/tasks/{micro_id}/kind", headers=headers, json={"kind": "fix", "expect_task_hash": "deadbeef" * 8})
        assert res_k_stale.status_code == 409

        res_k_ok = client.post(f"/api/tasks/{micro_id}/kind", headers=headers, json={"kind": "fix", "expect_task_hash": task_hash})
        assert res_k_ok.status_code == 200

        # 7. Labels mutation preview & apply
        res_bad_lbl = client.post(f"/api/tasks/{micro_id}/labels/preview", headers=headers, json={"add": ["INVALID LABEL!"]})
        assert res_bad_lbl.status_code == 400

        res_lbl_prev = client.post(f"/api/tasks/{micro_id}/labels/preview", headers=headers, json={"add": ["frontend"]})
        assert res_lbl_prev.status_code == 200
        lprev = res_lbl_prev.json()
        assert lprev.get("dry_run") is True
        l_hash = lprev.get("task_hash") or lprev.get("hash")
        assert l_hash

        res_lbl_stale = client.post(f"/api/tasks/{micro_id}/labels", headers=headers, json={"add": ["frontend"], "expect_task_hash": "badhash"})
        assert res_lbl_stale.status_code == 409

        res_lbl_ok = client.post(f"/api/tasks/{micro_id}/labels", headers=headers, json={"add": ["frontend"], "expect_task_hash": l_hash})
        assert res_lbl_ok.status_code == 200

        # 8. Promote preview and apply
        res_prom_404 = client.post("/api/tasks/T999/promote/preview", headers=headers, json={"category": "bugfix"})
        assert res_prom_404.status_code == 404

        res_prom_prev = client.post(f"/api/tasks/{micro_id}/promote/preview", headers=headers, json={"category": "bugfix"})
        assert res_prom_prev.status_code == 200
        pprev = res_prom_prev.json()
        assert pprev.get("dry_run") is True
        assert pprev.get("category") == "bugfix"
        p_hash = pprev.get("hash")
        assert p_hash

        res_prom_stale = client.post(f"/api/tasks/{micro_id}/promote", headers=headers, json={"category": "bugfix", "expect_task_hash": "wrong"})
        assert res_prom_stale.status_code == 409

        res_prom_ok = client.post(f"/api/tasks/{micro_id}/promote", headers=headers, json={"category": "bugfix", "expect_task_hash": p_hash})
        assert res_prom_ok.status_code == 200
        pdata = res_prom_ok.json()
        assert pdata.get("ok") is True
        assert pdata.get("category") == "bugfix"

        # Check detail endpoint retrieves promoted full task
        res_prom_detail = client.get(f"/api/tasks/{micro_id}", headers=headers)
        assert res_prom_detail.status_code == 200
        content = res_prom_detail.json().get("content", "")
        assert "## Goal" in content
        assert "## Steps" in content
        assert "## Verification" in content

        # 9. Convert bug note to microtask
        inbox_add = client.post(
            "/api/inbox",
            headers=headers,
            json={
                "title": "Button click missing feedback",
                "kind": "bug",
                "about": "frontend",
                "body": "User clicks the button and nothing shows up.",
            },
        )
        assert inbox_add.status_code == 200
        note_id = inbox_add.json().get("id")
        assert note_id

        res_conv = client.post(f"/api/inbox/{note_id}/to-microtask", headers=headers)
        assert res_conv.status_code == 200
        conv_data = res_conv.json()
        assert conv_data.get("ok") is True
        created_micro_id = conv_data.get("id")
        assert created_micro_id.startswith("T")

        # Note should now be resolved
        res_note = client.get(f"/api/inbox/{note_id}", headers=headers)
        assert res_note.status_code == 200
        assert res_note.json()["note"]["status"] == "processed"
        assert res_note.json()["note"]["produced"] == created_micro_id

    finally:
        state.workspace = old_ws


def test_events_and_stats_endpoints(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # Initial empty events
        res = client.get("/api/events", headers=headers)
        assert res.status_code == 200
        data = res.json()
        assert data.get("ok") is True
        assert data.get("events") == []

        res_stats = client.get("/api/events/stats", headers=headers)
        assert res_stats.status_code == 200
        sdata = res_stats.json()
        assert sdata.get("ok") is True
        assert sdata.get("total_events") == 0

        # Emit an event using ai-orch events emit
        bin_path = os.environ.get("AI_ORCH_BIN")
        subprocess.run(
            [sys.executable, bin_path, "events", "emit", "test.event", "--subject", "TEST-01", "--payload", '{"foo":"bar"}', "--workspace", str(tmp_path), "--json"],
            check=True,
            capture_output=True,
        )

        res_after = client.get("/api/events", headers=headers)
        assert res_after.status_code == 200
        data_after = res_after.json()
        assert data_after.get("ok") is True
        assert len(data_after.get("events", [])) == 1
        ev = data_after["events"][0]
        assert ev["type"] == "test.event"
        assert ev["subject"] == "TEST-01"

        # Paged by since cursor
        res_paged = client.get(f"/api/events?since={ev['seq']}", headers=headers)
        assert res_paged.status_code == 200
        assert res_paged.json().get("events") == []

        # Filter by type
        res_type = client.get("/api/events?type=test.event", headers=headers)
        assert res_type.status_code == 200
        assert len(res_type.json().get("events", [])) == 1

        res_type_miss = client.get("/api/events?type=other.type", headers=headers)
        assert res_type_miss.status_code == 200
        assert len(res_type_miss.json().get("events", [])) == 0
    finally:
        state.workspace = old_ws


def test_sessions_endpoints(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # Initial empty
        res = client.get("/api/sessions", headers=headers)
        assert res.status_code == 200
        assert res.json().get("sessions") == []

        # Register a session via CLI
        bin_path = os.environ.get("AI_ORCH_BIN")
        proc = subprocess.run(
            [sys.executable, bin_path, "sessions", "register", "--role", "orchestrator", "--tool", "claude", "--kind", "headless", "--session-id", "sess-test-123", "--workspace", str(tmp_path), "--json"],
            check=True,
            capture_output=True,
            text=True,
        )
        reg_data = json.loads(proc.stdout)
        sid = reg_data.get("session_id")
        assert sid == "sess-test-123"

        # List sessions
        res_ls = client.get("/api/sessions", headers=headers)
        assert res_ls.status_code == 200
        sessions = res_ls.json().get("sessions", [])
        assert len(sessions) >= 1
        assert sessions[0]["session_id"] == sid
        assert sessions[0]["role"] == "orchestrator"

        # Get session detail
        res_show = client.get(f"/api/sessions/{sid}", headers=headers)
        assert res_show.status_code == 200
        show_data = res_show.json()
        assert (show_data.get("session_id") or show_data.get("session", {}).get("session_id")) == sid

        # Get role holder
        res_role = client.get("/api/sessions/role/orchestrator", headers=headers)
        assert res_role.status_code == 200
        role_data = res_role.json()
        assert (role_data.get("session_id") or role_data.get("role", {}).get("session_id")) == sid

        # 404 for unknown session
        res_404 = client.get("/api/sessions/unknown-session-xyz", headers=headers)
        assert res_404.status_code == 404
    finally:
        state.workspace = old_ws


def test_triggers_and_proposed_actions_endpoints(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # Triggers list
        res_trig = client.get("/api/triggers", headers=headers)
        assert res_trig.status_code == 200
        assert res_trig.json().get("ok") is True

        # Triggers status
        res_st = client.get("/api/triggers/status", headers=headers)
        assert res_st.status_code == 200
        assert res_st.json().get("ok") is True

        # Triggers history
        res_hist = client.get("/api/triggers/history", headers=headers)
        assert res_hist.status_code == 200
        assert res_hist.json().get("ok") is True

        # Triggers run-once
        res_run = client.post("/api/triggers/run-once", headers=headers, json={"dry_run": True})
        assert res_run.status_code == 200
        assert res_run.json().get("ok") is True

        # Proposed actions: list empty
        res_props = client.get("/api/triggers/proposed-actions", headers=headers)
        assert res_props.status_code == 200
        assert res_props.json().get("proposed_actions") == []

        # Write a proposed action file
        prop_dir = tmp_path / ".ai-orchestration" / "proposed_actions"
        prop_dir.mkdir(parents=True, exist_ok=True)
        act_file = prop_dir / "act-001.json"
        act_file.write_text(json.dumps({
            "action_id": "act-001",
            "action_hash": "hash123",
            "type": "start-run",
            "rule": "verify-on-delivery",
            "created_at": "2026-10-18T00:00:00Z",
            "status": "pending_confirmation",
        }), encoding="utf-8")

        res_props2 = client.get("/api/triggers/proposed-actions", headers=headers)
        assert res_props2.status_code == 200
        props = res_props2.json().get("proposed_actions", [])
        assert len(props) == 1
        assert props[0]["action_id"] == "act-001"

        # Confirm validations
        # Missing expect_hash -> 400
        res_conf_no_hash = client.post("/api/triggers/proposed-actions/act-001/confirm", headers=headers, json={})
        assert res_conf_no_hash.status_code == 400
        assert res_conf_no_hash.json().get("error") == "missing_expect_hash"

        # Invalid action_id with invalid characters -> 400
        res_conf_bad_id = client.post("/api/triggers/proposed-actions/bad$id/confirm", headers=headers, json={"expect_hash": "h"})
        assert res_conf_bad_id.status_code == 400
        assert res_conf_bad_id.json().get("error") == "invalid_action_id"

        # Non-existent proposal -> 404
        res_conf_404 = client.post("/api/triggers/proposed-actions/act-nonexistent/confirm", headers=headers, json={"expect_hash": "h"})
        assert res_conf_404.status_code == 404

        # Hash mismatch -> 409
        res_conf_mismatch = client.post("/api/triggers/proposed-actions/act-001/confirm", headers=headers, json={"expect_hash": "wronghash"})
        assert res_conf_mismatch.status_code == 409
        assert res_conf_mismatch.json().get("error") == "hash_mismatch"

        # Reject validations
        # Missing reason -> 400
        res_rej_no_reason = client.post("/api/triggers/proposed-actions/act-001/reject", headers=headers, json={})
        assert res_rej_no_reason.status_code == 400
        assert res_rej_no_reason.json().get("error") == "missing_reason"

        # Reason too long -> 400
        res_rej_too_long = client.post("/api/triggers/proposed-actions/act-001/reject", headers=headers, json={"reason": "x" * 1001})
        assert res_rej_too_long.status_code == 400
        assert res_rej_too_long.json().get("error") == "reason_too_long"

        # Successful reject
        res_rej = client.post("/api/triggers/proposed-actions/act-001/reject", headers=headers, json={"reason": "Not needed right now"})
        assert res_rej.status_code == 200
        assert res_rej.json().get("ok") is True

        # Now not pending -> 409
        res_conf_not_pending = client.post("/api/triggers/proposed-actions/act-001/confirm", headers=headers, json={"expect_hash": "hash123"})
        assert res_conf_not_pending.status_code == 409
        assert res_conf_not_pending.json().get("error") == "not_pending"

        # Triggers toggle preview and apply
        cfg_file = tmp_path / ".ai-orchestration.local.toml"
        cfg_file.write_text("[triggers]\nenabled = true\n\n[[triggers]]\nname = \"rule-1\"\non = \"task.transitioned\"\naction = \"notify\"\nenabled = true\n", encoding="utf-8")

        res_prev = client.post("/api/triggers/toggle/preview", headers=headers, json={"rule_name": "rule-1", "enabled": False})
        assert res_prev.status_code == 200
        pdata = res_prev.json()
        assert pdata.get("ok") is True
        assert pdata.get("changed") is True
        assert "enabled = false" in pdata.get("diff", "")
        h = pdata.get("hash")
        assert h

        res_apply = client.post("/api/triggers/toggle", headers=headers, json={"rule_name": "rule-1", "enabled": False, "expect_hash": h})
        assert res_apply.status_code == 200
        assert res_apply.json().get("applied") is True

        # Verify config was updated
        assert "enabled = false" in cfg_file.read_text(encoding="utf-8")
    finally:
        state.workspace = old_ws


def test_questions_awaiting_application_and_apply(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path

    fixture_src = pathlib.Path("/Users/Alfredo/works/ai-coding-tools/ai-orchestration/plugins/architect-side/skills/task-pipeline/scripts/fixtures/index-regression")
    import shutil
    tasks_dir = tmp_path / "tasks"
    shutil.copytree(fixture_src, tasks_dir)

    try:
        # Ask question via API
        res_ask = client.post(
            "/api/questions",
            headers=headers,
            json={
                "question": "Which db engine?",
                "context": "Need db for service",
                "blocks": "T012",
                "options": [{"id": "A", "label": "Postgres"}, {"id": "B", "label": "SQLite"}],
            },
        )
        assert res_ask.status_code == 200
        qid = res_ask.json()["id"]

        # Answer question
        res_ans = client.post(
            f"/api/questions/{qid}/answer",
            headers=headers,
            json={"choice": "Postgres", "text": "Use Postgres", "by": "owner"},
        )
        assert res_ans.status_code == 200

        # Now it is awaiting application!
        res_awaiting = client.get("/api/questions/awaiting-application", headers=headers)
        assert res_awaiting.status_code == 200
        adata = res_awaiting.json()
        assert adata.get("ok") is True
        assert any(q["id"] == qid for q in adata.get("questions", []))

        # Apply the decision
        res_apply = client.post(
            f"/api/questions/{qid}/apply",
            headers=headers,
            json={"by": "owner", "ref": "T012", "note": "Configured Postgres"},
        )
        assert res_apply.status_code == 200
        assert res_apply.json().get("ok") is True

        # Now no longer awaiting application
        res_after = client.get("/api/questions/awaiting-application", headers=headers)
        assert res_after.status_code == 200
        assert not any(q["id"] == qid for q in res_after.json().get("questions", []))

        # Check ledger file
        ledger = tasks_dir / "questions" / "applied.jsonl"
        assert ledger.is_file()
        assert qid in ledger.read_text(encoding="utf-8")
    finally:
        state.workspace = old_ws


def test_queue_and_notifications_endpoints(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # 1. Queue
        q_dir = tmp_path / ".ai-orchestration" / "orchestrator" / "queue"
        q_dir.mkdir(parents=True, exist_ok=True)
        turn_file = q_dir / "000001.json"
        turn_file.write_text(json.dumps({
            "turn_seq": 1,
            "turn_id": "000001",
            "role": "orchestrator",
            "created_at": "2026-10-18T00:00:00Z",
            "state": "queued",
            "type": "event_batch",
            "policy": "reduced_capability",
        }), encoding="utf-8")

        res_q = client.get("/api/orchestrator/queue", headers=headers)
        assert res_q.status_code == 200
        qdata = res_q.json()
        assert qdata.get("ok") is True
        assert len(qdata.get("queue", [])) == 1
        assert qdata["queue"][0]["turn_id"] == "000001"

        # 2. Notifications
        notif_dir = tmp_path / ".ai-orchestration" / "notifications"
        notif_dir.mkdir(parents=True, exist_ok=True)
        n_file = notif_dir / "notif-001.json"
        n_file.write_text(json.dumps({
            "id": "notif-001",
            "rule": "notify-question",
            "event_seq": 10,
            "event_type": "question.asked",
            "subject": "Q001",
            "created_at": "2026-10-18T00:00:00Z",
            "read": False,
        }), encoding="utf-8")

        res_n = client.get("/api/notifications", headers=headers)
        assert res_n.status_code == 200
        ndata = res_n.json()
        assert ndata.get("ok") is True
        assert ndata.get("unread_count") == 1
        assert len(ndata.get("notifications", [])) == 1

        # Mark read
        res_read = client.post("/api/notifications/notif-001/read", headers=headers)
        assert res_read.status_code == 200

        res_n_after = client.get("/api/notifications", headers=headers)
        assert res_n_after.status_code == 200
        assert res_n_after.json().get("unread_count") == 0
    finally:
        state.workspace = old_ws


def test_websocket_events_and_replay(tmp_path):
    token = get_or_create_token()
    old_ws = state.workspace
    state.workspace = tmp_path
    bin_path = os.environ.get("AI_ORCH_BIN")

    # Emit an initial event
    subprocess.run(
        [sys.executable, bin_path, "events", "emit", "init.event", "--subject", "INIT", "--workspace", str(tmp_path), "--json"],
        check=True,
        capture_output=True,
    )

    try:
        with client.websocket_connect(f"/ws?token={token}") as ws:
            connected_msg = ws.receive_json()
            assert connected_msg.get("type") == "connected"

            # Request replay since 0
            ws.send_text(json.dumps({"type": "replay", "since": 0}))
            replay_msg = ws.receive_json()
            assert replay_msg.get("type") == "event"
            assert replay_msg.get("event", {}).get("type") == "init.event"
    finally:
        state.workspace = old_ws


def test_orchestrator_status_endpoint(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        res = client.get("/api/orchestrator/status", headers=headers)
        assert res.status_code == 200
        data = res.json()
        assert data.get("ok") is True
        assert data.get("role") == "orchestrator"
        assert data.get("generation") is None or data.get("generation") >= 1
        assert "tool" in data
        assert "queue" in data
        assert "rotate_after_tokens" in data
    finally:
        state.workspace = old_ws


def test_orchestrator_chat_and_queue_endpoint(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # Empty message should fail with 400
        res_empty = client.post("/api/orchestrator/chat", headers=headers, json={"message": "   "})
        assert res_empty.status_code == 400
        assert "message is required" in res_empty.json().get("error", "")

        # Valid chat message
        res_chat = client.post("/api/orchestrator/chat", headers=headers, json={"message": "Hello orchestrator!"})
        assert res_chat.status_code == 200
        chat_data = res_chat.json()
        assert chat_data.get("status") == "enqueued"
        turn_id = chat_data.get("turn_id")
        assert turn_id is not None

        # Queue check
        res_q = client.get("/api/orchestrator/queue", headers=headers)
        assert res_q.status_code == 200
        q_data = res_q.json()
        assert q_data.get("ok") is True
        assert any(item.get("turn_id") == turn_id for item in q_data.get("queue", []))
    finally:
        state.workspace = old_ws


def test_orchestrator_conversation_and_turn_detail(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # Enqueue one turn
        res_chat = client.post("/api/orchestrator/chat", headers=headers, json={"message": "First question"})
        assert res_chat.status_code == 200
        turn1_id = res_chat.json().get("turn_id")

        # Manually write an archived turn with assistant output
        turns_dir = tmp_path / ".ai-orchestration" / "orchestrator" / "turns" / "000099"
        turns_dir.mkdir(parents=True, exist_ok=True)
        turn_json = turns_dir / "turn.json"
        turn_json.write_text(json.dumps({
            "turn_id": "000099",
            "turn_seq": 99,
            "role": "orchestrator",
            "state": "done",
            "type": "owner_chat",
            "message": "Past question",
            "prompt_text": "Past prompt",
            "assistant_messages": ["Hello back! Here is my plan."],
            "usage": {"input_tokens": 120, "output_tokens": 45, "estimated_context_tokens": 500},
            "created_at": "2099-01-01T00:00:00Z",
            "ended_at": "2026-10-18T01:00:05Z",
            "duration_seconds": 5.0,
        }), encoding="utf-8")

        # Read conversation
        res_conv = client.get("/api/orchestrator/conversation", headers=headers)
        assert res_conv.status_code == 200
        conv_data = res_conv.json()
        assert conv_data.get("ok") is True
        turns = conv_data.get("turns", [])
        assert len(turns) >= 2
        # Verify ordering: turn1 should precede turn 99
        ids = [t.get("turn_id") for t in turns]
        assert turn1_id in ids
        assert "000099" in ids
        assert ids.index(turn1_id) < ids.index("000099")

        # Check turn detail
        res_detail = client.get("/api/orchestrator/turns/000099", headers=headers)
        assert res_detail.status_code == 200
        detail_data = res_detail.json()
        assert detail_data.get("ok") is True
        assert detail_data.get("turn", {}).get("output") == "Hello back! Here is my plan."

        # Non-existent turn detail
        res_not_found = client.get("/api/orchestrator/turns/999999", headers=headers)
        assert res_not_found.status_code == 404
    finally:
        state.workspace = old_ws


def test_orchestrator_controls(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # Pause orchestrator
        res_pause = client.post("/api/orchestrator/pause", headers=headers)
        assert res_pause.status_code == 200
        assert res_pause.json().get("status") == "paused"

        # Check status shows paused
        res_st_paused = client.get("/api/orchestrator/status", headers=headers)
        assert res_st_paused.status_code == 200
        assert res_st_paused.json().get("status") == "paused"

        # Resume orchestrator
        res_resume = client.post("/api/orchestrator/resume", headers=headers)
        assert res_resume.status_code == 200
        assert res_resume.json().get("status") in ("active", "resumed")

        # Check status shows active
        res_st_active = client.get("/api/orchestrator/status", headers=headers)
        assert res_st_active.status_code == 200
        assert res_st_active.json().get("status") == "active"

        # Enqueue a turn to cancel
        res_chat = client.post("/api/orchestrator/chat", headers=headers, json={"message": "To be cancelled"})
        turn_id = res_chat.json().get("turn_id")

        # Cancel turn
        res_cancel = client.post("/api/orchestrator/cancel", headers=headers, json={"turn_id": turn_id})
        assert res_cancel.status_code == 200
        assert res_cancel.json().get("state") == "cancelled" or res_cancel.json().get("status") == "cancelled"

        # Rotate orchestrator (with no_handoff to avoid running external CLI)
        res_rotate = client.post("/api/orchestrator/rotate", headers=headers, json={"reason": "test_rotation", "no_handoff": True})
        assert res_rotate.status_code == 200
        assert res_rotate.json().get("generation") == 2
    finally:
        state.workspace = old_ws


def test_orchestrator_reassign_endpoints(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # Missing tool -> 400
        res_bad = client.post("/api/orchestrator/reassign/preview", headers=headers, json={})
        assert res_bad.status_code == 400
        assert "tool is required" in res_bad.json().get("error", "")

        # Valid preview
        res_prev = client.post("/api/orchestrator/reassign/preview", headers=headers, json={
            "tool": "kilo",
            "model": "google/gemini-4-argon",
            "scope": "project",
        })
        assert res_prev.status_code == 200
        data_prev = res_prev.json()
        assert data_prev.get("ok") is True
        assert data_prev.get("dry_run") is True
        assert "plan" in data_prev
        assert "plan_hash" in data_prev
        plan_hash = data_prev["plan_hash"]

        # Apply without expect_hash -> 400
        res_no_hash = client.post("/api/orchestrator/reassign", headers=headers, json={
            "tool": "kilo",
        })
        assert res_no_hash.status_code == 400

        # Apply with wrong expect_hash -> hash mismatch error
        res_wrong_hash = client.post("/api/orchestrator/reassign", headers=headers, json={
            "tool": "kilo",
            "expect_hash": "deadbeef" * 8,
            "no_handoff": True,
        })
        assert res_wrong_hash.status_code in (409, 400, 500)

        # Apply with correct plan_hash (and no_handoff to avoid external CLI calls)
        res_apply = client.post("/api/orchestrator/reassign", headers=headers, json={
            "tool": "kilo",
            "model": "google/gemini-4-argon",
            "expect_hash": plan_hash,
            "no_handoff": True,
        })
        assert res_apply.status_code == 200
        data_apply = res_apply.json()
        assert data_apply.get("ok") is True
        assert data_apply.get("status") == "reassigned"
        assert data_apply.get("tool") == "kilo"
        assert data_apply.get("generation") >= 2
    finally:
        state.workspace = old_ws


def test_setup_endpoints(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        # Preview plan via GET
        res_get_plan = client.get("/api/setup/plan", headers=headers)
        assert res_get_plan.status_code == 200
        data_plan = res_get_plan.json()
        assert data_plan.get("ok") is True
        assert data_plan.get("applied") is False
        assert "detection" in data_plan
        assert "routing" in data_plan
        assert "plan_hash" in data_plan

        # Preview plan via POST with custom options
        res_post_plan = client.post("/api/setup/preview", headers=headers, json={
            "scope": "project-local",
            "orchestrator": "claude",
            "executor": "kilo",
            "verification_mode": "cross-agent",
        })
        assert res_post_plan.status_code == 200
        custom_plan = res_post_plan.json()
        assert custom_plan.get("ok") is True
        plan_hash = custom_plan.get("plan_hash")
        assert plan_hash

        # Apply setup without expect_hash -> 400
        res_no_hash = client.post("/api/setup/apply", headers=headers, json={})
        assert res_no_hash.status_code == 400

        # Apply setup with expect_hash
        res_apply = client.post("/api/setup/apply", headers=headers, json={
            "scope": "project-local",
            "orchestrator": "claude",
            "executor": "kilo",
            "verification_mode": "cross-agent",
            "expect_hash": plan_hash,
        })
        assert res_apply.status_code == 200
        data_apply = res_apply.json()
        assert data_apply.get("ok") is True
        assert data_apply.get("applied") is True

        # Check file was written in scratch workspace
        target_file = tmp_path / ".ai-orchestration.local.toml"
        assert target_file.is_file()
        content = target_file.read_text(encoding="utf-8")
        assert 'default_orchestrator = "claude"' in content
        assert 'default_executor = "kilo"' in content
    finally:
        state.workspace = old_ws


def test_orchestrator_handoff_ordering(tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    old_ws = state.workspace
    state.workspace = tmp_path
    try:
        t_dir = tmp_path / ".ai-orchestration" / "orchestrator" / "turns"

        # Turn 1: 000001 created at 10:00:00Z
        turn1_dir = t_dir / "000001"
        turn1_dir.mkdir(parents=True, exist_ok=True)
        (turn1_dir / "turn.json").write_text(json.dumps({
            "turn_id": "000001",
            "turn_seq": 1,
            "type": "owner_chat",
            "state": "done",
            "created_at": "2026-10-18T10:00:00Z",
            "assistant_messages": ["Turn 1 reply"],
        }), encoding="utf-8")

        # Turn 2: 000002 created at 10:05:00Z
        turn2_dir = t_dir / "000002"
        turn2_dir.mkdir(parents=True, exist_ok=True)
        (turn2_dir / "turn.json").write_text(json.dumps({
            "turn_id": "000002",
            "turn_seq": 2,
            "type": "owner_chat",
            "state": "done",
            "created_at": "2026-10-18T10:05:00Z",
            "assistant_messages": ["Turn 2 reply"],
        }), encoding="utf-8")

        # Handoff turn: handoff-gen002-abc123 created after Turn 2 (at 10:10:00Z via ended_at / created_at)
        handoff_dir = t_dir / "handoff-gen002-abc123"
        handoff_dir.mkdir(parents=True, exist_ok=True)
        (handoff_dir / "turn.json").write_text(json.dumps({
            "turn_id": "handoff-gen002-abc123",
            "type": "handoff",
            "state": "done",
            "ended_at": "2026-10-18T10:10:00Z",
            "assistant_messages": ["Handoff completed"],
        }), encoding="utf-8")

        # Ascending order: Turn 1, then Turn 2, then Handoff (strictly chronological)
        res_asc = client.get("/api/orchestrator/conversation?order=asc", headers=headers)
        assert res_asc.status_code == 200
        turns_asc = res_asc.json().get("turns", [])
        asc_ids = [t["turn_id"] for t in turns_asc]
        assert asc_ids == ["000001", "000002", "handoff-gen002-abc123"]

        # Descending order: Handoff, then Turn 2, then Turn 1
        res_desc = client.get("/api/orchestrator/conversation?order=desc", headers=headers)
        assert res_desc.status_code == 200
        turns_desc = res_desc.json().get("turns", [])
        desc_ids = [t["turn_id"] for t in turns_desc]
        assert desc_ids == ["handoff-gen002-abc123", "000002", "000001"]
    finally:
        state.workspace = old_ws


def test_set_short_title_endpoint_and_creation_flags(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}

    ws = tmp_path / "workspace"
    tasks_dir = ws / "tasks"
    tasks_dir.mkdir(parents=True)
    old_ws = state.workspace
    state.workspace = ws

    log_file = tmp_path / "cli_calls.json"
    stub_script = tmp_path / "stub_ai_orch.py"
    stub_script.write_text(f"""import sys, json, os

call = sys.argv[1:]
with open({repr(str(log_file))}, "a") as f:
    f.write(json.dumps(call) + "\\n")

if len(call) >= 2 and call[0] == "tasks" and call[1] == "set-short":
    task_id = call[2]
    words = call[3]
    if "--dry-run" in call:
        print(json.dumps({{"ok": True, "task_id": task_id, "short_title": words, "dry_run": True, "plan_hash": "mockplan123", "diff": "mock diff"}}))
        sys.exit(0)
    elif "--expect-plan-hash" in call:
        idx = call.index("--expect-plan-hash")
        h = call[idx + 1]
        if h == "badhash":
            print(json.dumps({{"error": "plan hash mismatch", "ok": False}}))
            sys.exit(1)
        print(json.dumps({{"ok": True, "task_id": task_id, "short_title": words, "plan_hash": h}}))
        sys.exit(0)
    else:
        print(json.dumps({{"error": "missing expect-plan-hash", "ok": False}}))
        sys.exit(1)

if len(call) >= 2 and call[0] == "tasks" and call[1] == "micro":
    print(json.dumps({{"ok": True, "id": "T999", "category": "micro"}}))
    sys.exit(0)

if len(call) >= 3 and call[0] == "tasks" and call[1] == "child" and call[2] == "add":
    print(json.dumps({{"ok": True, "allocated_id": "01.4", "plan_hash": "hash014"}}))
    sys.exit(0)

if len(call) >= 2 and call[0] == "questions" and call[1] == "ask":
    print(json.dumps({{"ok": True, "id": "Q099"}}))
    sys.exit(0)

print(json.dumps({{"error": f"unknown command: {{call}}"}}))
sys.exit(2)
""")
    stub_script.chmod(0o755)
    stub_bin = tmp_path / "ai-orch"
    stub_bin.write_text(f"#!/bin/sh\nexec {sys.executable} {stub_script} \"$@\"\n")
    stub_bin.chmod(0o755)

    monkeypatch.setenv("AI_ORCH_BIN", str(stub_bin))

    try:
        # 1. Invalid task ID
        res_bad_id = client.post("/api/tasks/invalid!!/short", headers=headers, json={"short_title": "some title"})
        assert res_bad_id.status_code == 400

        # 2. Preview via /preview route
        res_prev = client.post("/api/tasks/T007/short/preview", headers=headers, json={"short_title": "Fix auth tokens"})
        assert res_prev.status_code == 200
        prev_data = res_prev.json()
        assert prev_data.get("ok") is True
        assert prev_data.get("dry_run") is True
        assert prev_data.get("short_title") == "Fix auth tokens"
        assert prev_data.get("plan_hash") == "mockplan123"

        # 3. Preview via dry_run in body of /api/tasks/{id}/short
        res_prev_body = client.post("/api/tasks/T007/short", headers=headers, json={"short_title": "Fix auth tokens", "dry_run": True})
        assert res_prev_body.status_code == 200
        assert res_prev_body.json().get("dry_run") is True

        # 4. Apply without expect_plan_hash -> 400
        res_apply_nohash = client.post("/api/tasks/T007/short", headers=headers, json={"short_title": "Fix auth tokens"})
        assert res_apply_nohash.status_code == 400
        assert "expect_plan_hash is required" in res_apply_nohash.json().get("error", "")

        # 5. Apply with stale hash -> CLI error mapped
        res_stale = client.post("/api/tasks/T007/short", headers=headers, json={"short_title": "Fix auth tokens", "expect_plan_hash": "badhash"})
        assert res_stale.status_code != 200

        # 6. Apply with correct hash -> 200 and websocket broadcast
        with client.websocket_connect(f"/ws?token={token}") as sock:
            init_msg = sock.receive_json()
            assert init_msg.get("type") == "connected"

            res_apply_ok = client.post("/api/tasks/T007/short", headers=headers, json={"short_title": "Fix auth tokens", "expect_plan_hash": "mockplan123"})
            assert res_apply_ok.status_code == 200
            assert res_apply_ok.json().get("short_title") == "Fix auth tokens"

            ws_msg = sock.receive_json()
            assert ws_msg.get("type") == "changed"
            assert ws_msg.get("areas") == ["tasks"]

        # 7. Creation commands accept --short
        res_micro = client.post("/api/tasks/micro", headers=headers, json={"title": "Test micro", "short_title": "quick fix"})
        assert res_micro.status_code == 201

        res_child = client.post("/api/tasks/T001/child", headers=headers, json={"title": "Test child", "short_title": "sub child", "expect_plan_hash": "mockhash"})
        assert res_child.status_code == 200

        res_q = client.post("/api/questions", headers=headers, json={"question": "Which db?", "short_title": "DB choice"})
        assert res_q.status_code == 200

        calls = [json.loads(line) for line in log_file.read_text().splitlines() if line.strip()]
        micro_call = [c for c in calls if c[0] == "tasks" and c[1] == "micro"][-1]
        assert "--short" in micro_call
        assert micro_call[micro_call.index("--short") + 1] == "quick fix"

        child_call = [c for c in calls if c[0] == "tasks" and c[1] == "child"][-1]
        assert "--short" in child_call
        assert child_call[child_call.index("--short") + 1] == "sub child"

        q_call = [c for c in calls if c[0] == "questions" and c[1] == "ask"][-1]
        assert "--short" in q_call
        assert q_call[q_call.index("--short") + 1] == "DB choice"
    finally:
        state.workspace = old_ws


def test_validate_close_preview_and_apply(monkeypatch, tmp_path):
    fake_config = tmp_path / "config"
    fake_config.mkdir()
    monkeypatch.setenv("AI_ORCH_CONFIG_DIR", str(fake_config))

    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}

    ws = tmp_path / "workspace"
    ws.mkdir()
    tasks_dir = ws / "tasks"
    tasks_dir.mkdir()
    (tasks_dir / "00-INDEX.md").write_text("# Tasks Index\n", encoding="utf-8")

    bin_path = os.environ.get("AI_ORCH_BIN", "/Users/Alfredo/works/ai-coding-tools/ai-orchestration/bin/ai-orch")

    # Create 3 tasks: T001 (delivered), T002 (verified), T003 (open)
    for title in ("First task", "Second task", "Third task"):
        r = subprocess.run(
            [
                bin_path, "tasks", "new",
                "--title", title,
                "--goal", f"Goal for {title}",
                "--priority-reason", "Test fixture",
                "--step", "Implement feature",
                "--verification", "Run tests",
                "--category", "ui",
                "--priority", "P2",
                "--tasks-dir", str(tasks_dir),
                "--json",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        assert json.loads(r.stdout).get("ok") is True

    subprocess.run([bin_path, "tasks", "transition", "T001", "in progress", "--tasks-dir", str(tasks_dir), "--json"], check=True, capture_output=True)
    subprocess.run([bin_path, "tasks", "transition", "T001", "delivered", "--verify-by", "owner", "--tasks-dir", str(tasks_dir), "--json"], check=True, capture_output=True)

    subprocess.run([bin_path, "tasks", "transition", "T002", "in progress", "--tasks-dir", str(tasks_dir), "--json"], check=True, capture_output=True)
    subprocess.run([bin_path, "tasks", "transition", "T002", "delivered", "--tasks-dir", str(tasks_dir), "--json"], check=True, capture_output=True)
    subprocess.run([bin_path, "tasks", "transition", "T002", "verified", "--verifier", "owner", "--tasks-dir", str(tasks_dir), "--json"], check=True, capture_output=True)

    old_ws = state.workspace
    state.workspace = ws
    try:
        # 1. Unauthenticated requests rejected
        assert client.post("/api/tasks/validate-close/preview", json={"task_ids": ["T001"]}).status_code == 401
        assert client.post("/api/tasks/validate-close/apply", json={"task_ids": ["T001"]}).status_code == 401

        # 2. Empty or invalid task_ids rejected with 400
        assert client.post("/api/tasks/validate-close/preview", headers=headers, json={"task_ids": []}).status_code == 400
        assert client.post("/api/tasks/validate-close/preview", headers=headers, json={"task_ids": ["BAD!!"]}).status_code == 400

        # 3. Non-existent task rejected with 404
        assert client.post("/api/tasks/validate-close/preview", headers=headers, json={"task_ids": ["T999"]}).status_code == 404

        # 4. Task not in delivered/verified rejected with 400
        res_open = client.post("/api/tasks/validate-close/preview", headers=headers, json={"task_ids": ["T001", "T003"]})
        assert res_open.status_code == 400
        assert "T003" in res_open.json().get("error", "")

        # 5. Preview for T001 (delivered) and T002 (verified) succeeds without writing
        res_prev = client.post(
            "/api/tasks/validate-close/preview",
            headers=headers,
            json={"task_ids": ["T001", "T002"], "note": "Validated by owner in UI"},
        )
        assert res_prev.status_code == 200
        prev_data = res_prev.json()
        assert prev_data.get("ok") is True
        assert prev_data.get("dry_run") is True
        assert prev_data.get("count") == 2
        assert prev_data.get("verifier") == "owner"
        assert prev_data.get("note") == "Validated by owner in UI"
        plan_hash = prev_data.get("plan_hash")
        assert plan_hash
        tasks_preview = prev_data.get("tasks", [])
        assert len(tasks_preview) == 2
        assert tasks_preview[0]["id"] == "T001"
        assert tasks_preview[0]["state"] == "delivered"
        assert tasks_preview[0]["verify_by"] == "owner"
        assert tasks_preview[0]["path"] == ["delivered", "verified", "done"]
        assert tasks_preview[1]["id"] == "T002"
        assert tasks_preview[1]["state"] == "verified"
        assert tasks_preview[1]["path"] == ["verified", "done"]

        # Verify preview did not mutate task states on disk
        show_t1_before = json.loads(
            subprocess.run([bin_path, "tasks", "show", "T001", "--tasks-dir", str(tasks_dir), "--json"], capture_output=True, text=True, check=True).stdout
        )
        assert show_t1_before["task"]["canonical_state"] == "delivered"

        # 6. Apply with mismatched expect_plan_hash -> 409
        res_stale = client.post(
            "/api/tasks/validate-close/apply",
            headers=headers,
            json={"task_ids": ["T001", "T002"], "note": "Validated by owner in UI", "expect_plan_hash": "deadbeef" * 8},
        )
        assert res_stale.status_code == 409
        assert "stale-plan" in res_stale.json().get("error", "")

        # 7. Apply with matching expect_plan_hash -> 200, transitions both to done with verifier owner and note
        with client.websocket_connect(f"/ws?token={token}") as sock:
            init_msg = sock.receive_json()
            assert init_msg.get("type") == "connected"

            res_apply = client.post(
                "/api/tasks/validate-close/apply",
                headers=headers,
                json={"task_ids": ["T001", "T002"], "note": "Validated by owner in UI", "expect_plan_hash": plan_hash},
            )
            assert res_apply.status_code == 200
            apply_data = res_apply.json()
            assert apply_data.get("ok") is True
            assert apply_data.get("applied") is True
            assert apply_data.get("count") == 2
            assert apply_data.get("verifier") == "owner"
            assert apply_data.get("task_ids") == ["T001", "T002"]

            # WebSocket events broadcast
            ws_events = [sock.receive_json() for _ in range(4)]
            event_types = [e.get("type") for e in ws_events]
            assert "task_transitioned" in event_types
            assert "changed" in event_types
            assert "tasks_changed" in event_types

        # Verify on disk that both T001 and T002 are now in done with verifier=owner and Log entry
        for tid in ("T001", "T002"):
            show_after = json.loads(
                subprocess.run([bin_path, "tasks", "show", tid, "--tasks-dir", str(tasks_dir), "--json"], capture_output=True, text=True, check=True).stdout
            )["task"]
            assert show_after["state"] == "done"
            assert show_after["canonical_state"] == "done"
            assert show_after["in_done"] is True
            file_text = pathlib.Path(show_after["file_path"]).read_text(encoding="utf-8")
            assert "- state: done" in file_text
            assert "- verifier: owner" in file_text
            assert "Validated by owner in UI" in file_text

        # 8. Re-applying on already closed tasks with old expect_plan_hash -> 409
        res_reapply = client.post(
            "/api/tasks/validate-close/apply",
            headers=headers,
            json={"task_ids": ["T001"], "expect_plan_hash": plan_hash},
        )
        assert res_reapply.status_code == 409
    finally:
        state.workspace = old_ws





