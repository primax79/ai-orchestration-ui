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
        "## Steps\n1. Step 1\n\n"
        "## Verification\nSample verification\n"
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

    # Endpoints with bad token -> 401
    bad_headers = {"X-AI-Orch-Token": "bad-token"}
    assert client.get("/api/questions", headers=bad_headers).status_code == 401
    assert client.get("/api/questions/Q001", headers=bad_headers).status_code == 401
    assert client.post("/api/questions", headers=bad_headers, json={}).status_code == 401
    assert client.post("/api/questions/Q001/answer", headers=bad_headers, json={"choice": "A"}).status_code == 401
    assert client.post("/api/questions/Q001/withdraw", headers=bad_headers, json={"reason": "foo"}).status_code == 401


def test_watcher_broadcasts_on_question_file_change(monkeypatch):
    token = get_or_create_token()
    monkeypatch.setenv("AI_ORCH_WATCH_POLLING", "1")
    monkeypatch.setenv("AI_ORCH_WATCH_INTERVAL", "0.5")

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

                    # Touch question file
                    time.sleep(0.1)
                    q_file.write_text("modified question content", encoding="utf-8")

                    # Wait for changed broadcast within 2 seconds
                    broadcast_msg = ws.receive_json()
                    assert broadcast_msg.get("type") == "changed"
                    areas = broadcast_msg.get("areas", [])
                    assert "questions" in areas
                    assert "tasks" in areas
        finally:
            state.workspace = old_ws
