"""backend/test_broker_tools.py — Comprehensive tests for v1 broker MCP tools.

Tests:
1. Every tool happy path through the MCP layer (whoami, workspaces.list, projects.list,
   tasks.list, tasks.show, tasks.next, tasks.graph, tasks.new, tasks.transition, tasks.set,
   questions.list, questions.ask, questions.answer, inbox.add_note, orchestrator.status).
2. Recursive no-null check across all tool results.
3. Paging and 256 KiB cap on large lists.
4. broker-owns-writes: plain CLI write blocked while broker lock held, broker write succeeds.
5. Idempotent retry returns identical result.
6. Stale expect_hash refused.
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import subprocess
import sys
import time
from typing import Any
import pytest

from backend.broker.server import (
    acquire_broker_lock,
    create_broker_server,
    get_ai_orch_bin,
    normalize_cli_error,
    strip_none,
)
from backend.test_broker import ShimClient, _cleanup_broker_process


def assert_no_nulls(data: Any, path: str = "$") -> None:
    """Recursively assert that data contains no null (None) values."""
    if data is None:
        raise AssertionError(f"Found None/null at {path}")
    if isinstance(data, dict):
        for k, v in data.items():
            assert_no_nulls(v, f"{path}.{k}")
    elif isinstance(data, list):
        for idx, item in enumerate(data):
            assert_no_nulls(item, f"{path}[{idx}]")


@pytest.fixture
def test_env(tmp_path):
    """Set up an isolated configuration dir, git workspace, registered workspace, and project."""
    cfg_dir = tmp_path / "config"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    ws_dir = tmp_path / "workspace"
    ws_dir.mkdir(parents=True, exist_ok=True)

    # Initialize git in workspace
    subprocess.run(["git", "init"], cwd=str(ws_dir), capture_output=True, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=str(ws_dir), capture_output=True, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=str(ws_dir), capture_output=True, check=True)

    # Workspace top-level tasks
    ws_tasks = ws_dir / "tasks"
    ws_tasks.mkdir(parents=True, exist_ok=True)
    (ws_tasks / "00-INDEX.md").write_text("# Tasks (Workspace)\n", encoding="utf-8")

    # Project pkg-a
    pkg_dir = ws_dir / "packages" / "pkg-a"
    pkg_tasks = pkg_dir / "tasks"
    pkg_tasks.mkdir(parents=True, exist_ok=True)
    (pkg_tasks / "00-INDEX.md").write_text("# Tasks (Pkg A)\n", encoding="utf-8")

    # Create initial task T001 in pkg-a
    t001_dir = pkg_tasks / "feature"
    t001_dir.mkdir(parents=True, exist_ok=True)
    t001_file = t001_dir / "T001-setup-core.md"
    t001_file.write_text(
        """# T001 Setup core feature

- id: T001
- title: Setup core feature
- category: feature
- priority: P2
- priority-reason: Initial core setup
- next-up: yes
- state: open
- executor: kilo
- depends-on: -
- decider: -
- sources: -
- paths: -
- handoff: Read README
- short: Setup core

## Goal

Initial core setup goal description.

## Steps

- [ ] Step 1.
- [ ] Step 2.

## Verification

- [ ] Test passing.
""",
        encoding="utf-8",
    )

    # Initial commit in git so status is clean
    subprocess.run(["git", "add", "."], cwd=str(ws_dir), capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "Initial commit"], cwd=str(ws_dir), capture_output=True, check=True)

    bin_path = get_ai_orch_bin()
    assert bin_path.is_file(), f"ai-orch bin not found at {bin_path}"

    # Register workspace
    p_prev = subprocess.run(
        [str(bin_path), "workspace", "register", str(ws_dir), "--id", "test-ws", "--title", "Test Workspace", "--config-dir", str(cfg_dir), "--json"],
        capture_output=True,
        text=True,
        check=True,
    )
    plan_hash = json.loads(p_prev.stdout)["plan_hash"]
    subprocess.run(
        [str(bin_path), "workspace", "register", str(ws_dir), "--id", "test-ws", "--title", "Test Workspace", "--apply", "--expect-hash", plan_hash, "--config-dir", str(cfg_dir), "--json"],
        capture_output=True,
        text=True,
        check=True,
    )

    # Discover projects
    p_disc = subprocess.run(
        [str(bin_path), "projects", "discover", "test-ws", "--config-dir", str(cfg_dir), "--json"],
        capture_output=True,
        text=True,
        check=True,
    )
    disc_hash = json.loads(p_disc.stdout)["plan_hash"]
    subprocess.run(
        [str(bin_path), "projects", "discover", "test-ws", "--apply", "--expect-hash", disc_hash, "--config-dir", str(cfg_dir), "--json"],
        capture_output=True,
        text=True,
        check=True,
    )

    old_env = os.environ.get("AI_ORCHESTRATION_CONFIG")
    os.environ["AI_ORCHESTRATION_CONFIG"] = str(cfg_dir)

    yield {
        "config_dir": cfg_dir,
        "ws_dir": ws_dir,
        "pkg_tasks": pkg_tasks,
        "bin_path": bin_path,
    }

    if old_env is not None:
        os.environ["AI_ORCHESTRATION_CONFIG"] = old_env
    else:
        os.environ.pop("AI_ORCHESTRATION_CONFIG", None)


@pytest.mark.asyncio
async def test_every_tool_happy_path(test_env):
    """1. Test every tool happy path through the MCP layer and verify no null fields."""
    cfg_dir = test_env["config_dir"]
    server = create_broker_server(cfg_dir)

    # 1. whoami
    res = await server.call_tool("whoami", {})
    assert not res.is_error
    data = json.loads(res.content[0].text)
    assert data["ok"] is True
    assert "broker" in data
    assert "pid" in data["broker"]
    assert data["broker"]["version"] == "0.1.0"
    assert "unread_mail" in data
    assert_no_nulls(data)

    # 2. workspaces.list
    res = await server.call_tool("workspaces.list", {})
    assert not res.is_error
    data = json.loads(res.content[0].text)
    assert data["ok"] is True
    assert len(data["items"]) >= 1
    ws = next((w for w in data["items"] if w["slug"] == "test-ws"), None)
    assert ws is not None
    assert ws["title"] == "Test Workspace"
    assert ws["orchestrator"] in ("missing", "stopped", "running", "paused")
    assert ws["unread_mail"] == 0
    assert_no_nulls(data)

    # 3. projects.list
    res = await server.call_tool("projects.list", {"workspace": "test-ws"})
    assert not res.is_error
    data = json.loads(res.content[0].text)
    assert data["ok"] is True
    slugs = {p["slug"] for p in data["items"]}
    assert "pkg-a" in slugs
    assert "_workspace" in slugs
    assert_no_nulls(data)

    # 4. tasks.list
    res = await server.call_tool("tasks.list", {"workspace": "test-ws", "project": "pkg-a"})
    assert not res.is_error
    data = json.loads(res.content[0].text)
    assert data["ok"] is True
    assert len(data["items"]) >= 1
    t001 = next((t for t in data["items"] if t["id"] == "T001"), None)
    assert t001 is not None
    assert t001["short_title"] == "Setup core"
    assert t001["state"] == "open"
    assert t001["priority"] == "P2"
    assert "hash" in t001
    assert_no_nulls(data)

    # 5. tasks.show
    res = await server.call_tool("tasks.show", {"workspace": "test-ws", "project": "pkg-a", "id": "T001"})
    assert not res.is_error
    data = json.loads(res.content[0].text)
    assert data["ok"] is True
    task = data["task"]
    assert task["id"] == "T001"
    assert task["short_title"] == "Setup core"
    assert "Initial core setup goal description" in task["goal"]
    assert "Step 1" in task["steps"]
    assert "Test passing" in task["verification"]
    assert "hash" in task
    assert "path" in task
    assert_no_nulls(data)

    # 6. tasks.next
    res = await server.call_tool("tasks.next", {"workspace": "test-ws", "project": "pkg-a"})
    assert not res.is_error
    data = json.loads(res.content[0].text)
    assert data["ok"] is True
    assert len(data["items"]) >= 1
    assert data["items"][0]["id"] == "T001"
    assert_no_nulls(data)

    # 6b. tasks.next without project (workspace level)
    res_next_ws = await server.call_tool("tasks.next", {"workspace": "test-ws"})
    assert not res_next_ws.is_error
    data_next_ws = json.loads(res_next_ws.content[0].text)
    assert data_next_ws["ok"] is True
    assert len(data_next_ws["items"]) >= 1
    assert_no_nulls(data_next_ws)

    # 7. tasks.graph
    res = await server.call_tool("tasks.graph", {"workspace": "test-ws", "project": "pkg-a"})
    assert not res.is_error
    data = json.loads(res.content[0].text)
    assert data["ok"] is True
    assert "nodes" in data
    assert "edges" in data
    assert "ready" in data
    assert any(n["id"] == "T001" for n in data["nodes"])
    assert_no_nulls(data)

    # 8. tasks.new (preview)
    res_prev = await server.call_tool(
        "tasks.new",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "title": "Add analytics",
            "short": "Add analytics",
            "goal": "Track events",
            "category": "feature",
            "preview": True,
        },
    )
    assert not res_prev.is_error
    data_prev = json.loads(res_prev.content[0].text)
    assert data_prev["ok"] is True
    assert data_prev.get("preview") is True
    assert_no_nulls(data_prev)

    # 8. tasks.new (actual)
    res_new = await server.call_tool(
        "tasks.new",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "title": "Add analytics",
            "short": "Add analytics",
            "goal": "Track events",
            "category": "feature",
        },
    )
    assert not res_new.is_error
    data_new = json.loads(res_new.content[0].text)
    assert data_new["ok"] is True
    assert data_new["id"] == "T002"
    assert "hash" in data_new
    assert "path" in data_new
    assert_no_nulls(data_new)

    # 9. tasks.transition (preview)
    res_tr_prev = await server.call_tool(
        "tasks.transition",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "id": "T001",
            "to": "in progress",
            "preview": True,
        },
    )
    assert not res_tr_prev.is_error
    data_tr_prev = json.loads(res_tr_prev.content[0].text)
    assert data_tr_prev["ok"] is True
    assert data_tr_prev["from"] == "open"
    assert data_tr_prev["to"] == "in progress"
    assert_no_nulls(data_tr_prev)

    # 9. tasks.transition (actual)
    res_tr = await server.call_tool(
        "tasks.transition",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "id": "T001",
            "to": "in progress",
            "note": "Starting work",
        },
    )
    assert not res_tr.is_error
    data_tr = json.loads(res_tr.content[0].text)
    assert data_tr["ok"] is True
    assert data_tr["id"] == "T001"
    assert data_tr["from"] == "open"
    assert data_tr["to"] == "in progress"
    assert "hash" in data_tr
    assert_no_nulls(data_tr)

    # 10. tasks.set (priority)
    res_set = await server.call_tool(
        "tasks.set",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "id": "T001",
            "field": "priority",
            "value": "P1",
        },
    )
    assert not res_set.is_error
    data_set = json.loads(res_set.content[0].text)
    assert data_set["ok"] is True
    assert data_set["id"] == "T001"
    assert data_set["field"] == "priority"
    assert data_set["value"] == "P1"
    assert "hash" in data_set
    assert_no_nulls(data_set)

    # 11. questions.ask (preview)
    res_qask_prev = await server.call_tool(
        "questions.ask",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "question": "Which cache to use?",
            "short": "Cache choice",
            "context": "Redis vs Memcached",
            "options": [{"label": "A", "consequences": "Redis"}],
            "preview": True,
        },
    )
    assert not res_qask_prev.is_error
    data_qask_prev = json.loads(res_qask_prev.content[0].text)
    assert data_qask_prev["ok"] is True
    assert data_qask_prev.get("preview") is True
    assert_no_nulls(data_qask_prev)

    # 11. questions.ask (actual)
    res_qask = await server.call_tool(
        "questions.ask",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "question": "Which db should we use?",
            "short": "Db choice",
            "context": "Evaluating Postgres vs SQLite",
            "options": [
                {"label": "A", "consequences": "Postgres: robust"},
                {"label": "B", "consequences": "SQLite: embedded"},
            ],
            "recommended": "B",
        },
    )
    assert not res_qask.is_error
    data_qask = json.loads(res_qask.content[0].text)
    assert data_qask["ok"] is True
    assert data_qask["id"] == "Q001"
    assert "hash" in data_qask
    assert_no_nulls(data_qask)

    # 12. questions.list
    res_ql = await server.call_tool("questions.list", {"workspace": "test-ws", "project": "pkg-a"})
    assert not res_ql.is_error
    data_ql = json.loads(res_ql.content[0].text)
    assert data_ql["ok"] is True
    assert len(data_ql["items"]) >= 1
    q001 = next((q for q in data_ql["items"] if q["id"] == "Q001"), None)
    assert q001 is not None
    assert q001["short_title"] == "Db choice"
    assert q001["status"] == "open"
    assert_no_nulls(data_ql)

    # 12b. questions.list without project (workspace level)
    res_ql_ws = await server.call_tool("questions.list", {"workspace": "test-ws"})
    assert not res_ql_ws.is_error
    data_ql_ws = json.loads(res_ql_ws.content[0].text)
    assert data_ql_ws["ok"] is True
    assert any(q["id"] == "Q001" for q in data_ql_ws["items"])
    assert_no_nulls(data_ql_ws)

    # 13. questions.answer (preview)
    res_qans_prev = await server.call_tool(
        "questions.answer",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "id": "Q001",
            "choice": "B",
            "preview": True,
        },
    )
    assert not res_qans_prev.is_error
    data_qans_prev = json.loads(res_qans_prev.content[0].text)
    assert data_qans_prev["ok"] is True
    assert data_qans_prev.get("preview") is True
    assert_no_nulls(data_qans_prev)

    # 13. questions.answer (actual)
    res_qans = await server.call_tool(
        "questions.answer",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "id": "Q001",
            "choice": "B",
            "text": "Selected SQLite for simplicity",
        },
    )
    assert not res_qans.is_error
    data_qans = json.loads(res_qans.content[0].text)
    assert data_qans["ok"] is True
    assert data_qans["id"] == "Q001"
    assert isinstance(data_qans["unblocked"], list)
    assert "hash" in data_qans
    assert_no_nulls(data_qans)

    # 14. inbox.add_note (preview)
    res_inbox_prev = await server.call_tool(
        "inbox.add_note",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "title": "Preview note",
            "body": "Preview body",
            "preview": True,
        },
    )
    assert not res_inbox_prev.is_error
    data_inbox_prev = json.loads(res_inbox_prev.content[0].text)
    assert data_inbox_prev["ok"] is True
    assert data_inbox_prev.get("preview") is True
    assert_no_nulls(data_inbox_prev)

    # 14. inbox.add_note (actual)
    res_inbox = await server.call_tool(
        "inbox.add_note",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "title": "Idea: WebSocket push",
            "body": "Explore WebSocket push for notifications.",
            "kind": "idea",
        },
    )
    assert not res_inbox.is_error
    data_inbox = json.loads(res_inbox.content[0].text)
    assert data_inbox["ok"] is True
    assert data_inbox["id"].startswith("N")
    assert "path" in data_inbox
    assert "hash" in data_inbox
    assert_no_nulls(data_inbox)

    # 15. orchestrator.status
    res_orch = await server.call_tool("orchestrator.status", {"workspace": "test-ws"})
    assert not res_orch.is_error
    data_orch = json.loads(res_orch.content[0].text)
    assert data_orch["ok"] is True
    assert data_orch["state"] in ("missing", "stopped", "running", "paused")
    assert "queue_length" in data_orch
    assert "worker" in data_orch
    assert data_orch["unread_mail"] == 0
    assert_no_nulls(data_orch)

    # 15b. orchestrator.status with worker heartbeat file
    orch_dir = test_env["ws_dir"] / ".ai-orchestration" / "orchestrator"
    orch_dir.mkdir(parents=True, exist_ok=True)
    (orch_dir / "worker.json").write_text(
        json.dumps({"alive": True, "heartbeat_at": "2026-10-20T12:00:00Z"}),
        encoding="utf-8",
    )
    res_orch_live = await server.call_tool("orchestrator.status", {"workspace": "test-ws"})
    assert not res_orch_live.is_error
    data_orch_live = json.loads(res_orch_live.content[0].text)
    assert data_orch_live["ok"] is True
    assert data_orch_live["worker"]["alive"] is True
    assert data_orch_live["worker"]["heartbeat_at"] == "2026-10-20T12:00:00Z"
    assert_no_nulls(data_orch_live)


@pytest.mark.asyncio
async def test_paging_and_256kib_cap(test_env):
    """2. Paging and the 256 KiB cap on large list responses."""
    cfg_dir = test_env["config_dir"]
    pkg_tasks = test_env["pkg_tasks"]
    server = create_broker_server(cfg_dir)

    # Quickly create 25 task files in pkg-a directly
    cat_dir = pkg_tasks / "feature"
    for i in range(10, 35):
        t_file = cat_dir / f"T{i:03d}-task-{i}.md"
        t_file.write_text(
            f"""# T{i:03d} Task {i}

- id: T{i:03d}
- title: Task {i}
- category: feature
- priority: P2
- priority-reason: Paging test
- next-up: no
- state: open
- executor: kilo
- depends-on: -
- decider: -
- sources: -
- paths: -
- handoff: Read README
- short: Task {i}

## Goal

Goal for task {i}.

## Steps

- [ ] Step 1.

## Verification

- [ ] Verify.
""",
            encoding="utf-8",
        )

    # 1. Paging test: page 1 with limit 5
    res_p1 = await server.call_tool("tasks.list", {"workspace": "test-ws", "project": "pkg-a", "limit": 5})
    data_p1 = json.loads(res_p1.content[0].text)
    assert data_p1["ok"] is True
    assert len(data_p1["items"]) == 5
    assert "next_cursor" in data_p1
    assert data_p1["next_cursor"] == "5"
    assert_no_nulls(data_p1)

    # Page 2 with cursor "5"
    res_p2 = await server.call_tool("tasks.list", {"workspace": "test-ws", "project": "pkg-a", "cursor": "5", "limit": 5})
    data_p2 = json.loads(res_p2.content[0].text)
    assert data_p2["ok"] is True
    assert len(data_p2["items"]) == 5
    assert data_p2["next_cursor"] == "10"
    assert data_p2["items"][0]["id"] != data_p1["items"][0]["id"]
    assert_no_nulls(data_p2)

    # projects.list paging
    res_pr_p1 = await server.call_tool("projects.list", {"workspace": "test-ws", "limit": 1})
    data_pr_p1 = json.loads(res_pr_p1.content[0].text)
    assert data_pr_p1["ok"] is True
    assert len(data_pr_p1["items"]) == 1
    assert data_pr_p1.get("next_cursor") == "1"
    assert_no_nulls(data_pr_p1)

    res_pr_p2 = await server.call_tool("projects.list", {"workspace": "test-ws", "cursor": "1", "limit": 1})
    data_pr_p2 = json.loads(res_pr_p2.content[0].text)
    assert data_pr_p2["ok"] is True
    assert len(data_pr_p2["items"]) == 1
    assert data_pr_p2["items"][0]["slug"] != data_pr_p1["items"][0]["slug"]
    assert_no_nulls(data_pr_p2)

    # 2. 256 KiB cap test: simulate a massive payload
    large_items = [
        {"id": f"BIG{i:03d}", "short_title": f"Big {i}", "title": "Large item " * 200, "state": "open", "priority": "P1", "kind": "task", "depends_on": [], "hash": "h" * 64}
        for i in range(150)
    ]
    from backend.broker.server import paginate_items
    paged, next_c, trunc = paginate_items(large_items, limit=150, max_bytes=256 * 1024)
    dumped = json.dumps({"ok": True, "items": paged, "next_cursor": next_c, "truncated": trunc})
    assert len(dumped.encode("utf-8")) <= 256 * 1024
    assert trunc is True
    assert next_c is not None
    assert len(paged) < 150


def test_broker_owns_writes_guard(test_env):
    """3. broker-owns-writes respected: plain CLI write while broker runs is refused (code 75); broker write succeeds."""
    cfg_dir = test_env["config_dir"]
    bin_path = test_env["bin_path"]
    pkg_tasks = test_env["pkg_tasks"]

    # 1. Acquire the broker lock to simulate a running broker
    handle = acquire_broker_lock(cfg_dir)
    assert handle is not None

    try:
        # Plain CLI write WITHOUT AI_ORCH_BROKER_CHILD
        env_plain = os.environ.copy()
        env_plain["AI_ORCHESTRATION_CONFIG"] = str(cfg_dir)
        env_plain.pop("AI_ORCH_BROKER_CHILD", None)

        cmd_plain = [
            str(bin_path),
            "tasks", "new",
            "--tasks-dir", str(pkg_tasks),
            "--title", "Outside broker attempt",
            "--category", "feature",
            "--goal", "Should fail",
            "--priority-reason", "Testing guard",
            "--json",
        ]
        p_plain = subprocess.run(cmd_plain, env=env_plain, capture_output=True, text=True)
        assert p_plain.returncode == 75
        data_plain = json.loads(p_plain.stdout)
        assert data_plain["ok"] is False
        assert data_plain["error"] == "broker-owns-writes"

        # Broker write WITH AI_ORCH_BROKER_CHILD=1 succeeds
        env_broker = os.environ.copy()
        env_broker["AI_ORCHESTRATION_CONFIG"] = str(cfg_dir)
        env_broker["AI_ORCH_BROKER_CHILD"] = "1"

        p_broker = subprocess.run(cmd_plain, env=env_broker, capture_output=True, text=True)
        assert p_broker.returncode == 0
        data_broker = json.loads(p_broker.stdout)
        assert data_broker["ok"] is True
        assert "id" in data_broker
    finally:
        if hasattr(handle, "release"):
            handle.release()
        elif isinstance(handle, int):
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_UN)
            os.close(handle)


@pytest.mark.asyncio
async def test_idempotent_retry_returns_same_result(test_env):
    """4. Idempotent retry with the same idempotency_key returns the exact same result."""
    cfg_dir = test_env["config_dir"]
    server = create_broker_server(cfg_dir)

    key = "idemp_test_key_abc_12345"

    res1 = await server.call_tool(
        "tasks.new",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "title": "Idempotent task",
            "short": "Idemp task",
            "goal": "Test idempotency",
            "category": "feature",
            "idempotency_key": key,
        },
    )
    assert not res1.is_error
    data1 = json.loads(res1.content[0].text)
    assert data1["ok"] is True
    t_id1 = data1["id"]

    # Retry with identical arguments and key
    res2 = await server.call_tool(
        "tasks.new",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "title": "Idempotent task",
            "short": "Idemp task",
            "goal": "Test idempotency",
            "category": "feature",
            "idempotency_key": key,
        },
    )
    assert not res2.is_error
    data2 = json.loads(res2.content[0].text)
    assert data2["ok"] is True
    assert data2["id"] == t_id1


@pytest.mark.asyncio
async def test_stale_expect_hash_refused(test_env):
    """5. Stale expect_hash is refused with a hash mismatch error."""
    cfg_dir = test_env["config_dir"]
    server = create_broker_server(cfg_dir)

    # 1. Get task current hash
    res_show = await server.call_tool("tasks.show", {"workspace": "test-ws", "project": "pkg-a", "id": "T001"})
    data_show = json.loads(res_show.content[0].text)
    orig_hash = data_show["task"]["hash"]
    assert orig_hash

    # 2. Mutate task to change its hash
    res_set = await server.call_tool(
        "tasks.set",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "id": "T001",
            "field": "priority",
            "value": "P0",
        },
    )
    assert not res_set.is_error
    data_set = json.loads(res_set.content[0].text)
    new_hash = data_set["hash"]
    assert new_hash != orig_hash

    # 3. Attempt mutation passing the stale orig_hash
    res_stale = await server.call_tool(
        "tasks.set",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "id": "T001",
            "field": "priority",
            "value": "P2",
            "expect_hash": orig_hash,
        },
    )
    assert res_stale.is_error
    data_stale = json.loads(res_stale.content[0].text)
    assert data_stale["ok"] is False
    assert "mismatch" in data_stale["error"].lower() or "mismatch" in data_stale["message"].lower()
    assert_no_nulls(data_stale)


@pytest.mark.asyncio
async def test_tasks_list_filtering(test_env):
    """Filter tasks.list by state, kind, label, text."""
    cfg_dir = test_env["config_dir"]
    server = create_broker_server(cfg_dir)

    # 1. State filter
    res_open = await server.call_tool("tasks.list", {"workspace": "test-ws", "project": "pkg-a", "state": "open"})
    data_open = json.loads(res_open.content[0].text)
    assert data_open["ok"] is True
    assert all(t["state"] == "open" for t in data_open["items"])
    assert_no_nulls(data_open)

    # 2. Kind filter
    res_kind = await server.call_tool("tasks.list", {"workspace": "test-ws", "project": "pkg-a", "kind": "feature"})
    data_kind = json.loads(res_kind.content[0].text)
    assert data_kind["ok"] is True
    assert all(t["kind"] == "feature" for t in data_kind["items"])
    assert_no_nulls(data_kind)

    # 3. Text filter
    res_text = await server.call_tool("tasks.list", {"workspace": "test-ws", "project": "pkg-a", "text": "setup"})
    data_text = json.loads(res_text.content[0].text)
    assert data_text["ok"] is True
    assert any("setup" in t["title"].lower() or "setup" in t["short_title"].lower() for t in data_text["items"])
    assert_no_nulls(data_text)


@pytest.mark.asyncio
async def test_tasks_set_all_fields_and_preview(test_env):
    """Test tasks.set for all fields (size, short, kind, labels, deps), preview mode, and invalid field."""
    cfg_dir = test_env["config_dir"]
    server = create_broker_server(cfg_dir)

    # 1. Size
    res_sz = await server.call_tool("tasks.set", {"workspace": "test-ws", "project": "pkg-a", "id": "T001", "field": "size", "value": "M"})
    assert not res_sz.is_error
    data_sz = json.loads(res_sz.content[0].text)
    assert data_sz["ok"] is True
    assert data_sz["field"] == "size"
    assert data_sz["value"] == "M"
    assert_no_nulls(data_sz)

    # 2. Short
    res_sh = await server.call_tool("tasks.set", {"workspace": "test-ws", "project": "pkg-a", "id": "T001", "field": "short", "value": "Setup Fast"})
    assert not res_sh.is_error
    data_sh = json.loads(res_sh.content[0].text)
    assert data_sh["ok"] is True
    assert data_sh["field"] == "short"
    assert data_sh["value"] == "Setup Fast"
    assert_no_nulls(data_sh)

    # 3. Kind
    res_kd = await server.call_tool("tasks.set", {"workspace": "test-ws", "project": "pkg-a", "id": "T001", "field": "kind", "value": "chore"})
    assert not res_kd.is_error
    data_kd = json.loads(res_kd.content[0].text)
    assert data_kd["ok"] is True
    assert data_kd["field"] == "kind"
    assert data_kd["value"] == "chore"
    assert_no_nulls(data_kd)

    # 4. Labels
    res_lb = await server.call_tool("tasks.set", {"workspace": "test-ws", "project": "pkg-a", "id": "T001", "field": "labels", "value": ["core", "urgent"]})
    assert not res_lb.is_error
    data_lb = json.loads(res_lb.content[0].text)
    assert data_lb["ok"] is True
    assert data_lb["field"] == "labels"
    assert_no_nulls(data_lb)

    # 5. Preview mode
    res_prev = await server.call_tool("tasks.set", {"workspace": "test-ws", "project": "pkg-a", "id": "T001", "field": "priority", "value": "P0", "preview": True})
    assert not res_prev.is_error
    data_prev = json.loads(res_prev.content[0].text)
    assert data_prev["ok"] is True
    assert data_prev.get("preview") is True
    assert_no_nulls(data_prev)

    # 6. Invalid field rejected
    res_inv = await server.call_tool("tasks.set", {"workspace": "test-ws", "project": "pkg-a", "id": "T001", "field": "nonexistent_field", "value": "x"})
    assert res_inv.is_error
    data_inv = json.loads(res_inv.content[0].text)
    assert data_inv["ok"] is False
    assert data_inv["error"] == "invalid-field"
    assert_no_nulls(data_inv)


@pytest.mark.asyncio
async def test_transition_and_question_stale_expect_hash(test_env):
    """Test stale expect_hash on tasks.transition, tasks.set, and questions.answer."""
    cfg_dir = test_env["config_dir"]
    server = create_broker_server(cfg_dir)

    # 1. tasks.transition with stale hash (actual)
    res_tr = await server.call_tool(
        "tasks.transition",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "id": "T001",
            "to": "in progress",
            "expect_hash": "stale_hash_deadbeef_1234",
        },
    )
    assert res_tr.is_error
    data_tr = json.loads(res_tr.content[0].text)
    assert data_tr["ok"] is False
    assert data_tr["error"] == "hash-mismatch"
    assert data_tr["message"] and not data_tr["message"].startswith("{")
    assert_no_nulls(data_tr)

    # 2. tasks.transition with stale hash (preview)
    res_tr_prev = await server.call_tool(
        "tasks.transition",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "id": "T001",
            "to": "in progress",
            "expect_hash": "stale_hash_deadbeef_1234",
            "preview": True,
        },
    )
    assert res_tr_prev.is_error
    data_tr_prev = json.loads(res_tr_prev.content[0].text)
    assert data_tr_prev["ok"] is False
    assert data_tr_prev["error"] == "hash-mismatch"
    assert data_tr_prev["message"] and not data_tr_prev["message"].startswith("{")
    assert_no_nulls(data_tr_prev)

    # 3. questions.answer with stale hash
    res_q_ask = await server.call_tool(
        "questions.ask",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "question": "Which framework?",
            "short": "Framework choice",
            "context": "React vs Vue",
            "options": [
                {"label": "A", "consequences": "React"},
                {"label": "B", "consequences": "Vue"},
            ],
        },
    )
    assert not res_q_ask.is_error
    data_q_ask = json.loads(res_q_ask.content[0].text)
    q_id = data_q_ask["id"]

    res_q_ans_stale = await server.call_tool(
        "questions.answer",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "id": q_id,
            "choice": "A",
            "expect_hash": "stale_question_hash_9999",
        },
    )
    assert res_q_ans_stale.is_error
    data_q_ans_stale = json.loads(res_q_ans_stale.content[0].text)
    assert data_q_ans_stale["ok"] is False
    assert data_q_ans_stale["error"] == "hash-mismatch"
    assert data_q_ans_stale["message"] and not data_q_ans_stale["message"].startswith("{")
    assert_no_nulls(data_q_ans_stale)

    # 4. tasks.set with stale hash (actual)
    res_set = await server.call_tool(
        "tasks.set",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "id": "T001",
            "field": "priority",
            "value": "P1",
            "expect_hash": "stale_hash_deadbeef_1234",
        },
    )
    assert res_set.is_error
    data_set = json.loads(res_set.content[0].text)
    assert data_set["ok"] is False
    assert data_set["error"] == "hash-mismatch"
    assert data_set["message"] and not data_set["message"].startswith("{")
    assert_no_nulls(data_set)

    # 5. tasks.set with stale hash (preview)
    res_set_prev = await server.call_tool(
        "tasks.set",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "id": "T001",
            "field": "priority",
            "value": "P1",
            "expect_hash": "stale_hash_deadbeef_1234",
            "preview": True,
        },
    )
    assert res_set_prev.is_error
    data_set_prev = json.loads(res_set_prev.content[0].text)
    assert data_set_prev["ok"] is False
    assert data_set_prev["error"] == "hash-mismatch"
    assert data_set_prev["message"] and not data_set_prev["message"].startswith("{")
    assert_no_nulls(data_set_prev)


@pytest.mark.asyncio
async def test_idempotent_retry_inbox(test_env):
    """Test idempotent retry on inbox.add_note."""
    cfg_dir = test_env["config_dir"]
    server = create_broker_server(cfg_dir)

    key = "idemp_inbox_key_98765"
    res1 = await server.call_tool(
        "inbox.add_note",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "title": "Idempotent inbox note",
            "body": "Body text",
            "idempotency_key": key,
        },
    )
    assert not res1.is_error
    data1 = json.loads(res1.content[0].text)
    assert data1["ok"] is True
    n_id1 = data1["id"]

    res2 = await server.call_tool(
        "inbox.add_note",
        {
            "workspace": "test-ws",
            "project": "pkg-a",
            "title": "Idempotent inbox note",
            "body": "Body text",
            "idempotency_key": key,
        },
    )
    assert not res2.is_error
    data2 = json.loads(res2.content[0].text)
    assert data2["ok"] is True
    assert data2["id"] == n_id1


@pytest.mark.asyncio
async def test_error_handling_and_no_nulls(test_env):
    """Test error returns for invalid or missing workspace/project/tasks and ensure no nulls."""
    cfg_dir = test_env["config_dir"]
    server = create_broker_server(cfg_dir)

    # Missing workspace
    res = await server.call_tool("projects.list", {"workspace": "nonexistent-ws"})
    assert res.is_error
    data = json.loads(res.content[0].text)
    assert data["ok"] is False
    assert "error" in data
    assert "message" in data
    assert_no_nulls(data)

    # Nonexistent task in tasks.show
    res_task = await server.call_tool("tasks.show", {"workspace": "test-ws", "project": "pkg-a", "id": "T999"})
    assert res_task.is_error
    data_task = json.loads(res_task.content[0].text)
    assert data_task["ok"] is False
    assert data_task["error"] == "task-not-found"
    assert_no_nulls(data_task)


@pytest.mark.asyncio
@pytest.mark.parametrize("subcmd", [["shim", "--local"], ["local"]])
async def test_broker_local_stdio_mode(test_env, subcmd):
    """Test python -m backend.broker shim --local and local speaking MCP over stdio with no lock/broker.json."""
    cfg_dir = test_env["config_dir"]
    ui_root = pathlib.Path(__file__).resolve().parent.parent
    venv_python = ui_root / ".venv" / "bin" / "python"
    py_exe = str(venv_python) if venv_python.is_file() else sys.executable

    env = os.environ.copy()
    env["AI_ORCHESTRATION_CONFIG"] = str(cfg_dir)

    proc = subprocess.Popen(
        [py_exe, "-m", "backend.broker", *subcmd],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(ui_root),
        env=env,
    )

    try:
        def rpc_call(req: dict[str, Any]) -> dict[str, Any]:
            line = json.dumps(req) + "\n"
            proc.stdin.write(line.encode("utf-8"))
            proc.stdin.flush()
            resp_line = proc.stdout.readline().decode("utf-8").strip()
            assert resp_line, "Empty response from stdio MCP server"
            return json.loads(resp_line)

        # 1. initialize
        init_res = rpc_call({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "test-client", "version": "1.0.0"},
            },
        })
        assert init_res.get("result", {}).get("serverInfo", {}).get("name") == "ai-orchestration-broker"

        # 2. notifications/initialized
        proc.stdin.write((json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n").encode("utf-8"))
        proc.stdin.flush()

        # 3. tools/list
        tools_res = rpc_call({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {},
        })
        tool_names = [t["name"] for t in tools_res.get("result", {}).get("tools", [])]
        assert "whoami" in tool_names
        assert "tasks.list" in tool_names

        # 4. tools/call whoami
        whoami_res = rpc_call({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "whoami",
                "arguments": {},
            },
        })
        content_whoami = json.loads(whoami_res["result"]["content"][0]["text"])
        assert content_whoami["ok"] is True
        assert "broker" in content_whoami

        # 5. tools/call tasks.list
        tasks_res = rpc_call({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "tasks.list",
                "arguments": {
                    "workspace": "test-ws",
                    "project": "pkg-a",
                },
            },
        })
        content_tasks = json.loads(tasks_res["result"]["content"][0]["text"])
        assert content_tasks["ok"] is True
        assert any(t["id"] == "T001" for t in content_tasks["items"])

        # In-process local mode MUST NOT create broker.json or broker.lock
        assert not (cfg_dir / "broker.json").exists(), "broker.json should not exist in --local mode"
        assert not (cfg_dir / "broker.lock").exists(), "broker.lock should not exist in --local mode"

    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


@pytest.mark.asyncio
async def test_project_field_and_workspace_distinction(test_env):
    """Test project field on tasks.next, questions.list, and tasks.list items,
    plus workspace-level _workspace distinction and cross-project same-id questions.
    """
    cfg_dir = test_env["config_dir"]
    ws_dir = test_env["ws_dir"]
    bin_path = get_ai_orch_bin()

    # 1. Setup second project pkg-b
    pkg_b_dir = ws_dir / "packages" / "pkg-b"
    pkg_b_tasks = pkg_b_dir / "tasks"
    pkg_b_tasks.mkdir(parents=True, exist_ok=True)
    (pkg_b_tasks / "00-INDEX.md").write_text("# Tasks (Pkg B)\n\n## Tasks\n- [T002: Second project task](feature/T002-feature-b.md)\n\n## Questions\n- [Q001: Choice in B](questions/Q001-choice-b.md)\n", encoding="utf-8")
    t002_dir = pkg_b_tasks / "feature"
    t002_dir.mkdir(parents=True, exist_ok=True)
    (t002_dir / "T002-feature-b.md").write_text(
        """# T002 Second project task

- id: T002
- title: Second project task
- category: feature
- priority: P2
- priority-reason: Core task for pkg-b
- next-up: yes
- state: open
- executor: kilo
- depends-on: -
- decider: -
- sources: -
- paths: -
- handoff: Read README
- short: Feature B

## Goal
Goal B.

## Steps
- [ ] Step 1.

## Verification
- [ ] Verify B.
""",
        encoding="utf-8",
    )

    # Question Q001 in pkg-b
    q_b_dir = pkg_b_tasks / "questions"
    q_b_dir.mkdir(parents=True, exist_ok=True)
    (q_b_dir / "Q001-choice-b.md").write_text(
        """# Q001 Choice in B

- id: Q001
- question: Which database for B?
- status: open
- blocks: -
- decider: owner
- asked-by: owner
- asked: 2026-10-21
- origin-run: -
- open-answer: yes
- recommended: -
- short: Choice B

## Context
DB options.

## Options
- **A** — PostgreSQL
- **B** — SQLite

## Answer
- choice: -
- text: -
- answered-by: -
- answered: -
""",
        encoding="utf-8",
    )

    # 2. Setup Question Q001 in pkg-a
    pkg_a_tasks = ws_dir / "packages" / "pkg-a" / "tasks"
    q_a_dir = pkg_a_tasks / "questions"
    q_a_dir.mkdir(parents=True, exist_ok=True)
    (q_a_dir / "Q001-choice-a.md").write_text(
        """# Q001 Choice in A

- id: Q001
- question: Which framework for A?
- status: open
- blocks: -
- decider: owner
- asked-by: owner
- asked: 2026-10-21
- origin-run: -
- open-answer: yes
- recommended: -
- short: Choice A

## Context
Framework options.

## Options
- **A** — React
- **B** — Vue

## Answer
- choice: -
- text: -
- answered-by: -
- answered: -
""",
        encoding="utf-8",
    )
    # Update pkg-a 00-INDEX.md to list Q001
    pkg_a_idx = pkg_a_tasks / "00-INDEX.md"
    pkg_a_idx.write_text(pkg_a_idx.read_text(encoding="utf-8") + "\n## Questions\n- [Q001: Choice in A](questions/Q001-choice-a.md)\n", encoding="utf-8")

    # 3. Setup workspace-level coordination task in ws_dir / "tasks"
    ws_tasks = ws_dir / "tasks"
    ws_coord_dir = ws_tasks / "coordination"
    ws_coord_dir.mkdir(parents=True, exist_ok=True)
    (ws_coord_dir / "T099-workspace-coordination.md").write_text(
        """# T099 Workspace coordination

- id: T099
- title: Workspace coordination
- category: coordination
- priority: P1
- priority-reason: High-level workspace coordination
- next-up: yes
- state: open
- executor: kilo
- depends-on: -
- decider: -
- sources: -
- paths: -
- handoff: -
- short: Coord task

## Goal
Workspace coordination goal.

## Steps
- [ ] Coordinate.

## Verification
- [ ] Done.
""",
        encoding="utf-8",
    )
    (ws_tasks / "00-INDEX.md").write_text("# Tasks (Workspace)\n\n## Tasks\n- [T099: Workspace coordination](coordination/T099-workspace-coordination.md)\n", encoding="utf-8")

    # Git commit all new files
    subprocess.run(["git", "add", "."], cwd=str(ws_dir), capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "Add pkg-b and coordination tasks"], cwd=str(ws_dir), capture_output=True, check=True)

    # Re-run projects discover so pkg-b is registered in config
    p_disc = subprocess.run(
        [str(bin_path), "projects", "discover", "test-ws", "--config-dir", str(cfg_dir), "--json"],
        capture_output=True,
        text=True,
        check=True,
    )
    disc_hash = json.loads(p_disc.stdout)["plan_hash"]
    subprocess.run(
        [str(bin_path), "projects", "discover", "test-ws", "--apply", "--expect-hash", disc_hash, "--config-dir", str(cfg_dir), "--json"],
        capture_output=True,
        text=True,
        check=True,
    )

    server = create_broker_server(cfg_dir)

    # A. tasks.list with project: every item must carry "project": "pkg-a"
    res_tl = await server.call_tool("tasks.list", {"workspace": "test-ws", "project": "pkg-a"})
    assert not res_tl.is_error
    data_tl = json.loads(res_tl.content[0].text)
    assert data_tl["ok"] is True
    assert len(data_tl["items"]) > 0
    for item in data_tl["items"]:
        assert item.get("project") == "pkg-a"

    # B. tasks.next per-project: every item must carry "project": "pkg-a"
    res_tn_a = await server.call_tool("tasks.next", {"workspace": "test-ws", "project": "pkg-a"})
    assert not res_tn_a.is_error
    data_tn_a = json.loads(res_tn_a.content[0].text)
    assert data_tn_a["ok"] is True
    assert len(data_tn_a["items"]) > 0
    for item in data_tn_a["items"]:
        assert item.get("project") == "pkg-a"

    # C. tasks.next workspace-wide: carries project, scope ("workspace" vs "project")
    res_tn_ws = await server.call_tool("tasks.next", {"workspace": "test-ws"})
    assert not res_tn_ws.is_error
    data_tn_ws = json.loads(res_tn_ws.content[0].text)
    assert data_tn_ws["ok"] is True
    items_ws = data_tn_ws["items"]
    assert len(items_ws) >= 2
    for item in items_ws:
        assert "project" in item
        assert "scope" in item
        if item["project"] == "_workspace":
            assert item["scope"] == "workspace"
        else:
            assert item["scope"] == "project"

    assert any(it["id"] == "T099" and it["project"] == "_workspace" and it["scope"] == "workspace" for it in items_ws)
    assert any(it["id"] == "T001" and it["project"] == "pkg-a" and it["scope"] == "project" for it in items_ws)
    assert any(it["id"] == "T002" and it["project"] == "pkg-b" and it["scope"] == "project" for it in items_ws)

    # D. questions.list per-project: every item carries "project": "pkg-a"
    res_ql_a = await server.call_tool("questions.list", {"workspace": "test-ws", "project": "pkg-a"})
    assert not res_ql_a.is_error
    data_ql_a = json.loads(res_ql_a.content[0].text)
    assert data_ql_a["ok"] is True
    assert len(data_ql_a["items"]) == 1
    assert data_ql_a["items"][0]["id"] == "Q001"
    assert data_ql_a["items"][0]["project"] == "pkg-a"

    # E. questions.list workspace-wide: does NOT drop same-id questions (Q001) across projects
    res_ql_ws = await server.call_tool("questions.list", {"workspace": "test-ws"})
    assert not res_ql_ws.is_error
    data_ql_ws = json.loads(res_ql_ws.content[0].text)
    assert data_ql_ws["ok"] is True
    q_items = data_ql_ws["items"]
    # Both Q001 from pkg-a and Q001 from pkg-b MUST be present!
    q_tuples = [(it["project"], it["id"]) for it in q_items]
    assert ("pkg-a", "Q001") in q_tuples
    assert ("pkg-b", "Q001") in q_tuples
    for item in q_items:
        assert "project" in item


def test_normalize_cli_error_unit():
    """Unit test for normalize_cli_error helper."""
    # 1. Exact kebab-case mapping for hash-mismatch
    code, msg = normalize_cli_error({"error": "task-hash-mismatch", "message": "Hash failed"}, "", "", "fail", "failed")
    assert code == "hash-mismatch"
    assert msg == "Hash failed"

    # 2. Human sentence in data['error']
    code, msg = normalize_cli_error({"error": "Task hash mismatch: expected a, got b"}, "", "", "fail", "failed")
    assert code == "hash-mismatch"
    assert msg == "Task hash mismatch: expected a, got b"

    # 3. question-hash-mismatch
    code, msg = normalize_cli_error({"error": "question-hash-mismatch"}, "", "", "fail", "failed")
    assert code == "hash-mismatch"
    assert msg == "Question hash mismatch"

    # 4. not found
    code, msg = normalize_cli_error({"error": "Task not found: T999"}, "", "", "fail", "failed")
    assert code == "not-found"
    assert msg == "Task not found: T999"

    # 5. broker-owns-writes
    code, msg = normalize_cli_error({"error": "broker-owns-writes active"}, "", "", "fail", "failed")
    assert code == "broker-owns-writes"

    # 6. lock timeout
    code, msg = normalize_cli_error({"error": "Timed out waiting for lock timeout"}, "", "", "fail", "failed")
    assert code == "lock-timeout"

    # 7. invalid transition vs invalid argument
    code, msg = normalize_cli_error({"error": "Cannot transition from open to done"}, "", "", "transition-failed", "failed")
    assert code == "invalid-transition"
    code, msg = normalize_cli_error({"error": "Invalid choice: X"}, "", "", "questions-answer-failed", "failed")
    assert code == "invalid-argument"

    # 8. Never fall back to raw JSON stdout
    code, msg = normalize_cli_error(None, '{"ok": false, "raw": "json"}', "", "cli-failed", "Command failed")
    assert not msg.startswith("{")
    assert msg == "Command failed"
    assert code == "cli-failed"


