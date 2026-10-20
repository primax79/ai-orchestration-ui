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
import time
from typing import Any
import pytest

from backend.broker.server import (
    acquire_broker_lock,
    create_broker_server,
    get_ai_orch_bin,
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

    # 11. questions.ask
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

    # 13. questions.answer
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
    assert_no_nulls(data_qans)

    # 14. inbox.add_note
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
