"""Tests for Task 16.9a: multi-project backend.

Tests:
1. Scratch workspace like ~/works/d4science-python-library:
   - No root tasks/
   - Four projects each with tasks/00-INDEX.md
   - One git-ignored scratch copy that must NOT be discovered
   - 400 project-required when project param omitted on existing endpoints
   - 404 unknown-project on nonexistent project
   - Success when project param specified
   - Aggregate endpoints /api/workspace/tasks, /questions, /inbox, /runs
   - Aggregate filters (project, state, kind, label, text) and paging
2. Registered workspace:
   - _workspace coordination project + registered subprojects
   - Coordinates link on _workspace task resolved to target task live state
3. Single project backward compatibility:
   - Single plain project folder (today's behavior)
   - Works without project parameter
4. Path traversal / outside root error (400)
5. WebSocket watcher broadcast includes project field per project tree
6. Real read-only test against /Users/Alfredo/works/d4science-python-library
"""

import json
import os
import pathlib
import re
import subprocess
import tempfile
import time
import pytest
from starlette.testclient import TestClient

# Set test environment defaults before importing server
os.environ.setdefault("AI_ORCH_ALLOWED_HOSTS", "testserver,localhost,127.0.0.1,localhost:8780,127.0.0.1:8780")
if not os.environ.get("AI_ORCH_BIN"):
    candidate_bin = pathlib.Path("/Users/Alfredo/works/ai-coding-tools/ai-orchestration/bin/ai-orch")
    if candidate_bin.is_file():
        os.environ["AI_ORCH_BIN"] = str(candidate_bin)

try:
    from backend.server import app, state, get_or_create_token
    from backend.projects import ProjectResolver, UnknownProjectError, ProjectRequiredError, OutsideWorkspaceError
except ImportError:
    from server import app, state, get_or_create_token
    from projects import ProjectResolver, UnknownProjectError, ProjectRequiredError, OutsideWorkspaceError


@pytest.fixture
def auth_headers():
    token = get_or_create_token()
    return {"X-AI-Orch-Token": token}


def _create_minimal_task_tree(
    tasks_dir: pathlib.Path,
    init_id: str,
    init_slug: str,
    task_id: str,
    task_title: str,
    state: str = "open",
    kind: str = "initiative_task",
    labels: list[str] | None = None,
    coordinates: list[str] | None = None,
):
    tasks_dir.mkdir(parents=True, exist_ok=True)
    init_dir = tasks_dir / f"{init_id}-{init_slug}"
    init_dir.mkdir(parents=True, exist_ok=True)

    labels_str = f" · **Labels:** {', '.join(labels)}" if labels else ""
    coords_line = f"\n- **Coordinates:** {', '.join(coordinates)}" if coordinates else ""

    plan_content = f"""# Initiative {init_id}: {init_slug}

<!-- metadata:
- id: {init_id}
- title: {init_slug}
- state: in_progress
-->

### {task_id} - {task_title}

- **Status:** `{state}` · **Short:** {task_title} · **Kind:** {kind}{labels_str}{coords_line}

Task description.
"""
    (init_dir / "plan.md").write_text(plan_content, encoding="utf-8")

    index_content = f"""# Task Index

## Active Initiatives

- [{init_id}: {init_slug}]({init_id}-{init_slug}/plan.md)
"""
    (tasks_dir / "00-INDEX.md").write_text(index_content, encoding="utf-8")


def _create_emergent_task(
    tasks_dir: pathlib.Path,
    task_id: str,
    title: str,
    category: str = "architecture",
    state: str = "open",
    coordinates: list[str] | None = None,
    short: str | None = None,
):
    tasks_dir.mkdir(parents=True, exist_ok=True)
    cat_dir = tasks_dir / category
    cat_dir.mkdir(parents=True, exist_ok=True)
    slug = title.lower().replace(" ", "-")
    coords_line = f"- coordinates: {', '.join(coordinates)}\n" if coordinates else ""
    short_line = f"- short: {short}\n" if short else ""
    content = f"""# {task_id} {title}

- id: {task_id}
- title: {title}
- category: {category}
- priority: P2
- state: {state}
{short_line}{coords_line}- handoff: -

## Goal
{title} goal.

## Steps
Step 1.

## Verification
Verification.
"""
    (cat_dir / f"{task_id}-{slug}.md").write_text(content, encoding="utf-8")
    index_file = tasks_dir / "00-INDEX.md"
    entry = f"- [{task_id}: {title}]({category}/{task_id}-{slug}.md)\n"
    if index_file.is_file():
        text = index_file.read_text(encoding="utf-8")
        if "## Emergent Tasks" not in text:
            text += f"\n## Emergent Tasks\n\n{entry}"
        else:
            text += entry
        index_file.write_text(text, encoding="utf-8")
    else:
        index_file.write_text(f"# Task Index\n\n## Emergent Tasks\n\n{entry}", encoding="utf-8")


def test_scratch_workspace_discovery_and_exclusions(auth_headers):
    """Test scratch workspace like d4science-python-library: 4 projects, 1 git-ignored scratch copy."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        ws_path = pathlib.Path(tmp_dir).resolve()

        # Initialize git repo in ws_path so git check-ignore functions properly
        subprocess.run(["git", "init", "-q"], cwd=str(ws_path), check=True)
        (ws_path / ".gitignore").write_text("scratch-copy/\n", encoding="utf-8")
        subprocess.run(["git", "add", ".gitignore"], cwd=str(ws_path), check=True)
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-q", "-m", "init"], cwd=str(ws_path), check=True)

        # Create four project subdirectories with tasks/00-INDEX.md
        # 1. proj-a: backend task in todo
        _create_minimal_task_tree(
            ws_path / "proj-a" / "tasks",
            "01", "alpha", "01.1", "Alpha Backend Task",
            state="todo", kind="initiative_task", labels=["backend"]
        )
        # 2. proj-b: frontend task in in_progress
        _create_minimal_task_tree(
            ws_path / "proj-b" / "tasks",
            "02", "beta", "02.1", "Beta Frontend Task",
            state="in progress", kind="initiative_task", labels=["frontend"]
        )
        # 3. proj-c: backend task in delivered
        _create_minimal_task_tree(
            ws_path / "proj-c" / "tasks",
            "03", "gamma", "03.1", "Gamma Backend Task",
            state="delivered", kind="initiative_task", labels=["backend"]
        )
        # 4. proj-d: qa task in done
        _create_minimal_task_tree(
            ws_path / "proj-d" / "tasks",
            "04", "delta", "04.1", "Delta QA Task",
            state="done", kind="initiative_task", labels=["qa"]
        )

        # Create a git-ignored scratch-copy project that MUST NOT be discovered
        _create_minimal_task_tree(
            ws_path / "scratch-copy" / "tasks",
            "99", "ignored", "99.1", "Ignored Task",
            state="todo"
        )

        old_ws = state.workspace
        state.workspace = ws_path
        try:
            client = TestClient(app)

            # 1. GET /api/workspace
            res_ws = client.get("/api/workspace", headers=auth_headers)
            assert res_ws.status_code == 200, res_ws.text
            ws_data = res_ws.json()
            assert ws_data["mode"] == "discovered"
            assert ws_data["discovered"] is True
            assert ws_data["registered"] is False

            project_ids = [p["id"] for p in ws_data["projects"]]
            assert "scratch-copy" not in project_ids, "git-ignored scratch-copy must NOT be discovered"
            assert set(project_ids) == {"proj-a", "proj-b", "proj-c", "proj-d"}

            # 2. Existing endpoints without ?project parameter return 400 project-required
            res_no_proj = client.get("/api/tasks", headers=auth_headers)
            assert res_no_proj.status_code == 400
            assert res_no_proj.json() == {"error": "project-required"}

            res_q_no_proj = client.get("/api/questions", headers=auth_headers)
            assert res_q_no_proj.status_code == 400
            assert res_q_no_proj.json() == {"error": "project-required"}

            res_inbox_no_proj = client.get("/api/inbox", headers=auth_headers)
            assert res_inbox_no_proj.status_code == 400
            assert res_inbox_no_proj.json() == {"error": "project-required"}

            res_runs_no_proj = client.get("/api/runs", headers=auth_headers)
            assert res_runs_no_proj.status_code == 400
            assert res_runs_no_proj.json() == {"error": "project-required"}

            # 3. Unknown project parameter returns 404 unknown-project
            res_unknown = client.get("/api/tasks?project=nonexistent", headers=auth_headers)
            assert res_unknown.status_code == 404
            assert res_unknown.json() == {"error": "unknown-project"}

            # 4. Existing endpoints with ?project parameter succeed
            res_proj_a = client.get("/api/tasks?project=proj-a", headers=auth_headers)
            assert res_proj_a.status_code == 200
            data_a = res_proj_a.json()
            assert any(t["id"] == "01.1" for t in data_a.get("all_tasks", []))

            # 5. New Aggregate endpoint: GET /api/workspace/tasks
            res_agg = client.get("/api/workspace/tasks?per_page=500", headers=auth_headers)
            assert res_agg.status_code == 200
            agg_data = res_agg.json()
            assert agg_data["ok"] is True
            assert agg_data["total"] == 4
            tasks = agg_data["tasks"]
            assert len(tasks) == 4

            # Verify qualified_id and project fields
            q_ids = {t["qualified_id"] for t in tasks}
            assert q_ids == {"proj-a/01.1", "proj-b/02.1", "proj-c/03.1", "proj-d/04.1"}
            for t in tasks:
                assert t["project"] in ("proj-a", "proj-b", "proj-c", "proj-d")
                assert "short_title" in t
                assert "state" in t
                assert "priority" in t
                assert "kind" in t

            # 6. Filters on GET /api/workspace/tasks
            # Filter by project
            res_f_proj = client.get("/api/workspace/tasks?project=proj-a", headers=auth_headers)
            assert res_f_proj.status_code == 200
            assert len(res_f_proj.json()["tasks"]) == 1
            assert res_f_proj.json()["tasks"][0]["project"] == "proj-a"

            # Filter by multiple projects
            res_f_multi = client.get("/api/workspace/tasks?project=proj-a,proj-b", headers=auth_headers)
            assert res_f_multi.status_code == 200
            assert len(res_f_multi.json()["tasks"]) == 2

            # Filter by state
            res_f_state = client.get("/api/workspace/tasks?state=in_progress", headers=auth_headers)
            assert res_f_state.status_code == 200
            assert len(res_f_state.json()["tasks"]) == 1
            assert res_f_state.json()["tasks"][0]["qualified_id"] == "proj-b/02.1"

            # Filter by label
            res_f_label = client.get("/api/workspace/tasks?label=backend", headers=auth_headers)
            assert res_f_label.status_code == 200
            assert len(res_f_label.json()["tasks"]) == 2

            # Filter by text
            res_f_text = client.get("/api/workspace/tasks?text=Delta", headers=auth_headers)
            assert res_f_text.status_code == 200
            assert len(res_f_text.json()["tasks"]) == 1
            assert res_f_text.json()["tasks"][0]["id"] == "04.1"

            # 7. Pagination
            res_page1 = client.get("/api/workspace/tasks?page=1&per_page=2", headers=auth_headers)
            assert res_page1.status_code == 200
            assert len(res_page1.json()["tasks"]) == 2
            assert res_page1.json()["total"] == 4
            assert res_page1.json()["page"] == 1

            res_page2 = client.get("/api/workspace/tasks?page=2&per_page=2", headers=auth_headers)
            assert res_page2.status_code == 200
            assert len(res_page2.json()["tasks"]) == 2
            assert res_page2.json()["page"] == 2

            # 8. Aggregate questions, inbox, runs
            res_agg_q = client.get("/api/workspace/questions", headers=auth_headers)
            assert res_agg_q.status_code == 200
            assert "questions" in res_agg_q.json()

            res_agg_inbox = client.get("/api/workspace/inbox", headers=auth_headers)
            assert res_agg_inbox.status_code == 200
            assert "notes" in res_agg_inbox.json()

            res_agg_runs = client.get("/api/workspace/runs", headers=auth_headers)
            assert res_agg_runs.status_code == 200
            assert "runs" in res_agg_runs.json()

        finally:
            state.workspace = old_ws


def test_registered_workspace_and_coordinates_link(auth_headers, monkeypatch):
    """Test registered workspace with _workspace coordination task coordinates resolved to live project state."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        ws_path = pathlib.Path(tmp_dir).resolve()
        config_dir = ws_path / ".config_test"
        broker_dir = config_dir / "broker"
        broker_dir.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("AI_ORCH_CONFIG_DIR", str(config_dir))

        # Setup registered workspace SQLite DB
        import sqlite3
        db_path = broker_dir / "registry.sqlite"
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE workspaces (
                uuid TEXT PRIMARY KEY,
                slug TEXT UNIQUE NOT NULL,
                canonical_path TEXT NOT NULL,
                device INTEGER,
                inode INTEGER,
                registered_at TEXT NOT NULL,
                last_seen TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE projects (
                uuid TEXT PRIMARY KEY,
                slug TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                workspace_uuid TEXT NOT NULL
            )
        """)
        ws_uuid = "11111111-1111-1111-1111-111111111111"
        conn.execute(
            "INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
            (ws_uuid, "registered-ws", str(ws_path), 0, 0),
        )
        conn.execute(
            "INSERT INTO projects VALUES (?, ?, ?, ?)",
            ("22222222-2222-2222-2222-222222222222", "proj-x", "proj-x", ws_uuid),
        )
        conn.commit()
        conn.close()

        # 1. Target project proj-x has task 01.1 in state 'delivered'
        _create_minimal_task_tree(
            ws_path / "proj-x" / "tasks",
            "01", "alpha", "01.1", "Target Alpha Task",
            state="delivered", kind="initiative_task"
        )

        # 2. _workspace coordination tree at root has coordination task 00.1 pointing to proj-x/01.1
        _create_minimal_task_tree(
            ws_path / "tasks",
            "00", "coordination", "00.1", "Coordination Task",
            state="todo", kind="initiative_task",
            coordinates=["proj-x/01.1"]
        )

        old_ws = state.workspace
        state.workspace = ws_path
        reg_headers = {"X-AI-Orch-Token": get_or_create_token()}
        try:
            client = TestClient(app)

            # GET /api/workspace
            res_ws = client.get("/api/workspace", headers=reg_headers)
            assert res_ws.status_code == 200
            ws_data = res_ws.json()
            assert ws_data["mode"] == "registered"
            assert ws_data["registered"] is True

            p_ids = [p["id"] for p in ws_data["projects"]]
            assert "_workspace" in p_ids
            assert "proj-x" in p_ids

            # GET /api/workspace/tasks -> verify coordinates resolution
            res_tasks = client.get("/api/workspace/tasks", headers=reg_headers)
            assert res_tasks.status_code == 200
            all_tasks = res_tasks.json()["tasks"]

            coord_task = next(t for t in all_tasks if t["qualified_id"] == "_workspace/00.1")
            assert len(coord_task["coordinates"]) == 1
            coord = coord_task["coordinates"][0]
            assert coord["project"] == "proj-x"
            assert coord["id"] == "01.1"
            assert coord["state"] == "delivered", "Target task's live state must be resolved!"

        finally:
            state.workspace = old_ws


def test_single_project_backward_compatibility(auth_headers):
    """Test single plain project folder: exactly today's behaviour, fully backward compatible."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        ws_path = pathlib.Path(tmp_dir).resolve()
        _create_minimal_task_tree(
            ws_path / "tasks",
            "01", "my-app", "01.1", "Main Task",
            state="in_progress"
        )

        old_ws = state.workspace
        state.workspace = ws_path
        try:
            client = TestClient(app)

            # GET /api/workspace
            res_ws = client.get("/api/workspace", headers=auth_headers)
            assert res_ws.status_code == 200
            ws_data = res_ws.json()
            assert ws_data["mode"] == "single"
            assert ws_data["workspace_path"] == str(ws_path)

            # Existing endpoint without ?project succeeds
            res_tasks = client.get("/api/tasks", headers=auth_headers)
            assert res_tasks.status_code == 200
            tasks_data = res_tasks.json()
            assert any(t["id"] == "01.1" for t in tasks_data.get("all_tasks", []))

            # Queries with _workspace or folder slug also succeed
            res_ws_slug = client.get("/api/tasks?project=_workspace", headers=auth_headers)
            assert res_ws_slug.status_code == 200

            # Invalid project still returns 404 unknown-project
            res_inv = client.get("/api/tasks?project=random-bad-id", headers=auth_headers)
            assert res_inv.status_code == 404
            assert res_inv.json() == {"error": "unknown-project"}

        finally:
            state.workspace = old_ws


def test_outside_workspace_root_security(auth_headers):
    """Path traversal or escaping workspace root is rejected with 400 or 404."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        ws_path = pathlib.Path(tmp_dir).resolve()
        tasks_dir = ws_path / "tasks"
        tasks_dir.mkdir(parents=True)
        (tasks_dir / "00-INDEX.md").write_text("# Index\n", encoding="utf-8")

        old_ws = state.workspace
        state.workspace = ws_path
        try:
            client = TestClient(app)
            # Query param with path traversal
            res = client.get("/api/tasks?project=../../etc", headers=auth_headers)
            assert res.status_code in (400, 404)
        finally:
            state.workspace = old_ws


def test_watcher_broadcasts_project_field(auth_headers, monkeypatch):
    """File watcher broadcasts include the project field per project tree."""
    monkeypatch.setenv("AI_ORCH_WATCH_POLLING", "1")
    monkeypatch.setenv("AI_ORCH_WATCH_INTERVAL", "0.05")

    with tempfile.TemporaryDirectory() as tmp_dir:
        ws_path = pathlib.Path(tmp_dir).resolve()
        proj_a_tasks = ws_path / "proj-a" / "tasks"
        proj_b_tasks = ws_path / "proj-b" / "tasks"
        _create_minimal_task_tree(proj_a_tasks, "01", "a", "01.1", "Task A")
        _create_minimal_task_tree(proj_b_tasks, "02", "b", "02.1", "Task B")

        target_file = proj_a_tasks / "01-a" / "plan.md"

        old_ws = state.workspace
        state.workspace = ws_path
        token = get_or_create_token()

        try:
            with TestClient(app) as test_client:
                with test_client.websocket_connect(f"/ws?token={token}") as ws:
                    init_msg = ws.receive_json()
                    assert init_msg.get("type") == "connected"

                    # Touch file in proj-a
                    time.sleep(0.1)
                    target_file.write_text(target_file.read_text(encoding="utf-8") + "\n# Extra\n", encoding="utf-8")
                    new_mtime = target_file.stat().st_mtime + 2.0
                    os.utime(target_file, (new_mtime, new_mtime))

                    broadcast_msg = ws.receive_json()
                    assert broadcast_msg.get("type") == "changed"
                    assert broadcast_msg.get("project") == "proj-a"
                    assert "tasks" in broadcast_msg.get("areas", [])
        finally:
            state.workspace = old_ws


def test_scratch_registered_workspace_canonical_counts_and_coordinates(monkeypatch):
    """Regression test for 16.9a:
    1. Per-project counts must come from the engine and be keyed ONLY by canonical states (+ total).
    2. Coordinates in _workspace tasks must resolve against target projects live task lists.
    Uses scratch registered workspace with isolated AI_ORCHESTRATION_CONFIG.
    """
    with tempfile.TemporaryDirectory() as tmp_dir:
        ws_path = pathlib.Path(tmp_dir).resolve()
        cfg_dir = ws_path / ".config" / "ai-orchestration"
        broker_dir = cfg_dir / "broker"
        broker_dir.mkdir(parents=True, exist_ok=True)

        # Isolated AI_ORCHESTRATION_CONFIG pointing to orchestration.toml
        toml_path = cfg_dir / "orchestration.toml"
        toml_path.write_text("# Scratch orchestration config\n", encoding="utf-8")
        monkeypatch.setenv("AI_ORCHESTRATION_CONFIG", str(toml_path))

        # Setup SQLite registry
        import sqlite3
        db_path = broker_dir / "registry.sqlite"
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE workspaces (
                uuid TEXT PRIMARY KEY,
                slug TEXT UNIQUE NOT NULL,
                canonical_path TEXT NOT NULL,
                device INTEGER,
                inode INTEGER,
                registered_at TEXT NOT NULL,
                last_seen TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE projects (
                uuid TEXT PRIMARY KEY,
                slug TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                workspace_uuid TEXT NOT NULL
            )
        """)
        ws_uuid = "12345678-1234-5678-1234-567812345678"
        conn.execute(
            "INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
            (ws_uuid, "scratch-ws", str(ws_path), 0, 0),
        )
        conn.execute(
            "INSERT INTO projects VALUES (?, ?, ?, ?)",
            ("11111111-1111-1111-1111-111111111111", "_workspace", ".", ws_uuid),
        )
        conn.execute(
            "INSERT INTO projects VALUES (?, ?, ?, ?)",
            ("22222222-2222-2222-2222-222222222222", "proj-a", "proj-a", ws_uuid),
        )
        conn.execute(
            "INSERT INTO projects VALUES (?, ?, ?, ?)",
            ("33333333-3333-3333-3333-333333333333", "proj-b", "proj-b", ws_uuid),
        )
        conn.commit()
        conn.close()

        # Project A tasks: multiple states (open, in progress, blocked, done, done with a caveat)
        _create_minimal_task_tree(
            ws_path / "proj-a" / "tasks",
            "01", "alpha", "01.1", "Task Alpha",
            state="in_progress", kind="initiative_task"
        )
        _create_minimal_task_tree(
            ws_path / "proj-a" / "tasks",
            "02", "beta", "02.1", "Task Beta",
            state="done", kind="initiative_task"
        )
        _create_emergent_task(
            ws_path / "proj-a" / "tasks",
            "T010", "Emergent Blocked", category="architecture",
            state="blocked", short="emergent blocked"
        )
        _create_emergent_task(
            ws_path / "proj-a" / "tasks",
            "T011", "Emergent Done Caveat", category="architecture",
            state="done with a caveat", short="emergent caveat"
        )

        # Project B tasks:
        _create_minimal_task_tree(
            ws_path / "proj-b" / "tasks",
            "01", "gamma", "01.1", "Task Gamma Delivered",
            state="delivered", kind="initiative_task"
        )

        # Workspace tasks:
        # 1. Emergent task T002 coordinating proj-a/T010 and proj-b/01.1
        _create_emergent_task(
            ws_path / "tasks",
            "T002", "Coordination Emergent", category="coordination",
            state="open", short="coord emergent",
            coordinates=["proj-a/T010", "proj-b/01.1"]
        )
        # 2. Initiative task 00.1 coordinating proj-a/01.1
        _create_minimal_task_tree(
            ws_path / "tasks",
            "00", "coordination", "00.1", "Coordination Initiative",
            state="open", kind="initiative_task",
            coordinates=["proj-a/01.1"]
        )

        old_ws = state.workspace
        state.workspace = ws_path
        reg_headers = {"X-AI-Orch-Token": get_or_create_token()}
        try:
            client = TestClient(app)

            # 1. Test GET /api/workspace
            res_ws = client.get("/api/workspace", headers=reg_headers)
            assert res_ws.status_code == 200
            ws_data = res_ws.json()
            assert ws_data["mode"] == "registered"

            projects_map = {p["id"]: p for p in ws_data["projects"]}
            assert "_workspace" in projects_map
            assert "proj-a" in projects_map
            assert "proj-b" in projects_map

            expected_keys = {
                "open", "in progress", "waiting", "blocked", "paused",
                "bounced", "delivered", "verified", "done", "dropped", "total"
            }

            # Check proj-a counts
            counts_a = projects_map["proj-a"]["counts"]
            assert set(counts_a.keys()) == expected_keys
            assert counts_a["in progress"] == 1
            assert counts_a["blocked"] == 1
            # done(1) + done with a caveat(1) = 2
            assert counts_a["done"] == 2
            assert counts_a["total"] == 4

            # Check proj-b counts
            counts_b = projects_map["proj-b"]["counts"]
            assert set(counts_b.keys()) == expected_keys
            assert counts_b["delivered"] == 1
            assert counts_b["total"] == 1

            # Check _workspace counts
            counts_ws = projects_map["_workspace"]["counts"]
            assert set(counts_ws.keys()) == expected_keys
            assert counts_ws["open"] == 2
            assert counts_ws["total"] == 2

            # 2. Test GET /api/workspace/tasks (coordinates resolution)
            res_tasks = client.get("/api/workspace/tasks", headers=reg_headers)
            assert res_tasks.status_code == 200
            tasks_list = res_tasks.json()["tasks"]

            t_emergent = next(t for t in tasks_list if t["qualified_id"] == "_workspace/T002")
            assert len(t_emergent["coordinates"]) == 2
            c_a = next(c for c in t_emergent["coordinates"] if c["project"] == "proj-a")
            assert c_a["id"] == "T010"
            assert c_a["state"] == "blocked"
            assert c_a["short_title"] == "emergent blocked"

            c_b = next(c for c in t_emergent["coordinates"] if c["project"] == "proj-b")
            assert c_b["id"] == "01.1"
            assert c_b["state"] == "delivered"
            assert c_b["short_title"] == "Task Gamma Delivered"

            t_init = next(t for t in tasks_list if t["qualified_id"] == "_workspace/00.1")
            assert len(t_init["coordinates"]) == 1
            c_init = t_init["coordinates"][0]
            assert c_init["project"] == "proj-a"
            assert c_init["id"] == "01.1"
            assert c_init["state"] == "in progress"
            assert c_init["short_title"] == "Task Alpha"

        finally:
            state.workspace = old_ws


def test_live_workspace_read_only(auth_headers):
    """Opt-in, read-only check against a real multi-project workspace.

    Set AI_ORCH_LIVE_WORKSPACE to its root (e.g. ~/works/d4science-python-library).
    Live data changes, so only invariants are asserted, never fixed counts.
    """
    raw = os.environ.get("AI_ORCH_LIVE_WORKSPACE", "").strip()
    if not raw:
        pytest.skip("AI_ORCH_LIVE_WORKSPACE not set")
    real_path = pathlib.Path(raw).expanduser().resolve()
    if not real_path.is_dir():
        pytest.skip(f"{real_path} not found")

    old_ws = state.workspace
    state.workspace = real_path
    try:
        client = TestClient(app)

        res_ws = client.get("/api/workspace", headers=auth_headers)
        assert res_ws.status_code == 200, res_ws.text
        projects = res_ws.json()["projects"]
        assert len(projects) > 1

        expected_canonical_states = {
            "open", "in progress", "waiting", "blocked", "paused",
            "bounced", "delivered", "verified", "done", "dropped", "total"
        }
        for p in projects:
            counts = p["counts"]
            assert set(counts.keys()) == expected_canonical_states
            assert sum(v for k, v in counts.items() if k != "total") == counts["total"]

        t0 = time.perf_counter()
        res_tasks_cold = client.get("/api/workspace/tasks?per_page=500", headers=auth_headers)
        assert res_tasks_cold.status_code == 200
        print(f"[live] /api/workspace/tasks cold: {(time.perf_counter() - t0) * 1000:.2f} ms")
        body = res_tasks_cold.json()
        tasks = body.get("items") or body.get("tasks") or []
        assert len(tasks) == body["total"]

        # Every project's total matches the aggregate, and every coordinate
        # resolves to the live state of the task it points to.
        for p in projects:
            assert p["counts"]["total"] == sum(1 for t in tasks if t["project"] == p["id"])
        states = {(t["project"], t["id"]): t["state"] for t in tasks if "id" in t}
        for t in tasks:
            for c in t.get("coordinates") or []:
                if (c["project"], c["id"]) in states:
                    assert c["state"] == states[(c["project"], c["id"])]

        t1 = time.perf_counter()
        res_tasks_warm = client.get("/api/workspace/tasks?per_page=500", headers=auth_headers)
        t_warm = time.perf_counter() - t1
        assert res_tasks_warm.status_code == 200
        assert t_warm < 2.0, f"Warm cache duration {t_warm}s exceeded 2.0s limit"
    finally:
        state.workspace = old_ws


def test_web_ui_multi_project_contract():
    """Verify frontend multi-project scoping contract:
    1. No module-level mutable setCurrentProject / getCurrentProject / setFallbackProject in api.ts.
    2. ProjectContext, useProject, and useProjectContext are exported from api.ts.
    3. PROJECT_PALETTE assigns distinct palette entries across 5 sibling projects.
    4. App.tsx loadWorkspace / connectWebSocket effect does not re-run on project selection changes.
    """
    frontend_src = pathlib.Path(__file__).resolve().parent.parent / "frontend" / "src"
    api_ts = (frontend_src / "api.ts").read_text(encoding="utf-8")
    app_tsx = (frontend_src / "App.tsx").read_text(encoding="utf-8")
    badges_tsx = (frontend_src / "components" / "ProjectBadges.tsx").read_text(encoding="utf-8")

    # 1. No module-level mutable currentProjectId / fallbackProjectId
    assert "let currentProjectId" not in api_ts
    assert "let fallbackProjectId" not in api_ts
    assert "export function setCurrentProject" not in api_ts
    assert "export function getCurrentProject" not in api_ts
    assert "export function setFallbackProject" not in api_ts

    # Verify no component imports setCurrentProject
    for ts_file in frontend_src.rglob("*.ts*"):
        content = ts_file.read_text(encoding="utf-8")
        assert "setCurrentProject" not in content, f"Found setCurrentProject in {ts_file}"
        assert "getCurrentProject" not in content, f"Found getCurrentProject in {ts_file}"

    # 2. Explicit React Context & hooks exported
    assert "export const ProjectContext" in api_ts
    assert "export function useProject(" in api_ts
    assert "export function useProjectContext(" in api_ts
    assert "<ProjectContext.Provider" in app_tsx

    # 3. Distinct curated palette in ProjectBadges.tsx
    assert "export const PROJECT_PALETTE" in badges_tsx
    assert "export function registerProjectColorOrder" in badges_tsx
    assert len(re.findall(r"\{\s*bg:\s*'rgba\(", badges_tsx)) >= 8

    # 4. App.tsx WS & workspace mount effect is decoupled from selectedProject
    assert "[loadWorkspace, triggerDebouncedReload]" in app_tsx



def test_common_view_carries_conditional_tasks(auth_headers):
    """The aggregate keeps T030/T031 condition data, so the common view can show the conditional badge."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        ws_path = pathlib.Path(tmp_dir).resolve()
        subprocess.run(["git", "init", "-q"], cwd=str(ws_path), check=True)
        _create_minimal_task_tree(
            ws_path / "proj-a" / "tasks", "01", "alpha", "01.1", "Alpha Task", state="open"
        )
        tasks_dir = ws_path / "proj-b" / "tasks"
        _create_minimal_task_tree(tasks_dir, "02", "beta", "02.1", "Beta Task", state="open")
        asked = time.strftime("%Y-%m-%d", time.localtime(time.time() - 9 * 86400))
        (tasks_dir / "questions").mkdir(parents=True, exist_ok=True)
        (tasks_dir / "questions" / "Q001-pending-choice.md").write_text(
            "# Q001 Pending choice\n\n"
            "- id: Q001\n- question: Which option?\n- status: open\n- blocks: -\n- decider: owner\n"
            f"- asked-by: owner\n- asked: {asked}\n- origin-run: -\n- open-answer: yes\n- recommended: -\n"
            "- short: Pending choice\n\n"
            "## Context\nC.\n\n## Options\n- **A** — a: x\n- **B** — b: y\n\n"
            "## Answer\n- choice: -\n- text: -\n- answered-by: -\n- answered: -\n",
            encoding="utf-8",
        )
        cat_dir = tasks_dir / "general"
        cat_dir.mkdir(parents=True, exist_ok=True)
        (cat_dir / "T001-finished-work.md").write_text(
            "# T001 Finished work\n\n"
            "- id: T001\n- title: Finished work\n- category: general\n- priority: P2\n"
            "- priority-reason: test\n- next-up: no\n- state: done\n- executor: self\n- depends-on: -\n"
            "- decider: -\n- sources: -\n- paths: -\n- handoff: -\n- conditions: Q001\n- short: Finished\n\n"
            "## Goal\nG.\n\n## Steps\n1. S.\n\n## Verification\nV.\n",
            encoding="utf-8",
        )
        with (tasks_dir / "00-INDEX.md").open("a", encoding="utf-8") as fh:
            fh.write("\n## Emergent Tasks\n\n- [T001: Finished work](general/T001-finished-work.md)\n")

        old_ws = state.workspace
        state.workspace = ws_path
        try:
            client = TestClient(app)
            res = client.get("/api/workspace/tasks?per_page=500", headers=auth_headers)
            assert res.status_code == 200, res.text
            body = res.json()
            items = body.get("items") or body.get("tasks") or []
            t1 = next(t for t in items if t["qualified_id"] == "proj-b/T001")
            assert t1["conditional"] is True
            assert t1["conditions"][0]["id"] == "Q001"
            assert t1["conditions"][0]["decider"] == "owner"
            assert t1["conditions"][0]["age_days"] == 9
            other = next(t for t in items if t["qualified_id"] == "proj-a/01.1")
            assert "conditional" not in other

            # The per-project count does not depend on which tasks the view loaded
            ws = client.get("/api/workspace", headers=auth_headers).json()
            by_id = {p["id"]: p for p in ws["projects"]}
            assert by_id["proj-b"]["conditional"] == 1
            assert by_id["proj-a"]["conditional"] == 0
        finally:
            state.workspace = old_ws
