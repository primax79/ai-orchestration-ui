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
        "## Steps\n1. Step 1\n\n"
        "## Verification\nSample verification\n",
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

        # 6. Poll show until succeeded
        run_record = None
        for _ in range(30):
            time.sleep(0.5)
            res_show = client.get(f"/api/runs/{run_id}", headers=headers)
            assert res_show.status_code == 200
            show_data = res_show.json()
            assert show_data.get("ok") is True
            run_record = show_data.get("run", {})
            if run_record.get("status") == "succeeded":
                break

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

        # Wait briefly for process to spawn
        time.sleep(1.0)

        # Cancel
        res_cancel = client.post(f"/api/runs/{run_id}/cancel", headers=headers)
        assert res_cancel.status_code == 200
        cancel_data = res_cancel.json()
        assert cancel_data.get("ok") is True
        assert cancel_data.get("status") == "cancelled"

        # Verify show returns cancelled
        res_show = client.get(f"/api/runs/{run_id}", headers=headers)
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
    monkeypatch.setenv("AI_ORCH_WATCH_INTERVAL", "0.5")

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

                # Touch run.json (metadata only)
                time.sleep(0.1)
                run_file.write_text(json.dumps({"run_id": "20261017-123456-T001-kilo-1234", "status": "running"}), encoding="utf-8")

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
    monkeypatch.setenv("AI_ORCH_WATCH_INTERVAL", "0.5")

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

                    time.sleep(0.1)
                    note_file.write_text("modified note content", encoding="utf-8")

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
