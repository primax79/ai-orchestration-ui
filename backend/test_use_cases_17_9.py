"""Tests for ai-orchestration 17.9 use-case API deliverables:
- GET /api/use-cases and /api/use-cases/{id} (stage, approval, legacy status)
- POST /api/tasks/{id}/use-cases/preview and /apply (link/unlink, expect_plan_hash, broadcasts)
- GET /api/use-cases/queue (revalidation queue)
- POST /api/use-cases/{id}/validate (force: true, 409 mapping for not-ready)
- POST /api/tasks/transition (owner_approved: true, 409 mapping for use_case_failing)
- POST /api/use-cases/campaign (pass through new fields)
"""
from __future__ import annotations

import json
import os
import pathlib
import pytest
from starlette.testclient import TestClient

os.environ.setdefault("AI_ORCH_ALLOWED_HOSTS", "testserver,localhost,127.0.0.1,localhost:8780,127.0.0.1:8780")
if not os.environ.get("AI_ORCH_BIN"):
    candidate_bin = pathlib.Path("/Users/Alfredo/.local/bin/ai-orch")
    if candidate_bin.is_file():
        os.environ["AI_ORCH_BIN"] = str(candidate_bin)

from server import app, get_or_create_token, run_ai_orch, state  # noqa: E402

client = TestClient(app)


def _setup_workspace_with_task(tmp_path: pathlib.Path, task_state: str = "open") -> tuple[pathlib.Path, pathlib.Path]:
    ws = tmp_path / "test_ws"
    ws.mkdir(parents=True, exist_ok=True)
    tdir = ws / "tasks"
    tdir.mkdir(parents=True, exist_ok=True)
    (tdir / "00-INDEX.md").write_text("# Tasks Index\n", encoding="utf-8")
    init_dir = tdir / "01-sample"
    init_dir.mkdir(parents=True, exist_ok=True)
    (init_dir / "plan.md").write_text(
        f"""# 01 - Sample Initiative

## Tasks

### 01.1 - First task
- **Status:** `{task_state}`
- **Priority:** P2
- **Size:** M
- **Depends on:** -

Context for 01.1
""",
        encoding="utf-8",
    )
    return ws, tdir


def test_use_cases_list_and_get_preserves_stage_approval_and_status(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws, tdir = _setup_workspace_with_task(tmp_path)
    monkeypatch.setattr(state, "workspace", ws)

    # 1. Create a use case
    create_body = {
        "id": "UC001",
        "title": "Search Products",
        "actor": "Shopper",
        "approval": "proposed",
        "priority": "P1",
        "verification_command": "echo OK",
        "description": "Search products by keyword",
    }
    res_create = client.post("/api/use-cases", json=create_body, headers=headers)
    assert res_create.status_code == 200
    assert res_create.json()["ok"] is True
    assert res_create.json()["id"] == "UC001"

    # 2. GET /api/use-cases
    res_list = client.get("/api/use-cases", headers=headers)
    assert res_list.status_code == 200
    data_list = res_list.json()
    assert data_list["ok"] is True
    assert len(data_list["use_cases"]) >= 1
    uc_entry = next(u for u in data_list["use_cases"] if u["id"] == "UC001")
    assert uc_entry["stage"] == "draft"
    assert uc_entry["approval"] == "proposed"
    # Legacy status must match stage for backward compatibility
    assert uc_entry["status"] == "draft"
    assert "linked_tasks" in uc_entry

    # 3. GET /api/use-cases/{id} and /api/use-cases/{uc_id}
    res_get1 = client.get("/api/use-cases/UC001", headers=headers)
    assert res_get1.status_code == 200
    uc_detail1 = res_get1.json()["use_case"]
    assert uc_detail1["title"] == "Search Products"
    assert uc_detail1["stage"] == "draft"
    assert uc_detail1["approval"] == "proposed"
    assert uc_detail1["status"] == "draft"
    assert "linked_tasks" in uc_detail1

    # 4. GET /api/use-cases/{id} 404 for unknown
    res_404 = client.get("/api/use-cases/UC999", headers=headers)
    assert res_404.status_code == 404


def test_task_use_cases_preview_and_apply(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws, tdir = _setup_workspace_with_task(tmp_path)
    monkeypatch.setattr(state, "workspace", ws)

    # Sync index initially
    client.post("/api/tasks/sync-index", headers=headers)

    # Create two use cases
    client.post(
        "/api/use-cases",
        json={"id": "UC001", "title": "First UC", "approval": "approved", "verification_command": "echo OK"},
        headers=headers,
    )
    client.post(
        "/api/use-cases",
        json={"id": "UC002", "title": "Second UC", "approval": "proposed", "verification_command": "echo OK"},
        headers=headers,
    )

    # Validation checks on preview/apply
    # Bad task id
    res_bad_id = client.post("/api/tasks/invalid..id/use-cases/preview", json={"use_cases": ["UC001"], "action": "link"}, headers=headers)
    assert res_bad_id.status_code == 400

    # Bad action
    res_bad_action = client.post("/api/tasks/01.1/use-cases/preview", json={"use_cases": ["UC001"], "action": "fly"}, headers=headers)
    assert res_bad_action.status_code == 400

    # Missing use_cases
    res_no_ucs = client.post("/api/tasks/01.1/use-cases/preview", json={"use_cases": [], "action": "link"}, headers=headers)
    assert res_no_ucs.status_code == 400

    # 1. Preview link
    res_prev = client.post(
        "/api/tasks/01.1/use-cases/preview",
        json={"use_cases": ["UC001", "UC002"], "action": "link"},
        headers=headers,
    )
    assert res_prev.status_code == 200
    prev_data = res_prev.json()
    assert prev_data["ok"] is True
    assert prev_data["applied"] is False
    assert prev_data["dry_run"] is True
    plan_hash = prev_data["plan_hash"]
    assert plan_hash

    # 2. Apply link without expect_plan_hash -> 400
    res_apply_no_hash = client.post(
        "/api/tasks/01.1/use-cases/apply",
        json={"use_cases": ["UC001", "UC002"], "action": "link"},
        headers=headers,
    )
    assert res_apply_no_hash.status_code == 400
    assert "expect_plan_hash is required" in res_apply_no_hash.json()["error"]

    # 3. Apply link with invalid hash -> 409
    res_apply_bad_hash = client.post(
        "/api/tasks/01.1/use-cases/apply",
        json={"use_cases": ["UC001", "UC002"], "action": "link", "expect_plan_hash": "deadbeef1234"},
        headers=headers,
    )
    assert res_apply_bad_hash.status_code == 409

    # Track broadcasts
    broadcasts: list[dict] = []
    orig_broadcast = state.broadcast

    async def fake_broadcast(msg):
        broadcasts.append(msg)
        await orig_broadcast(msg)

    monkeypatch.setattr(state, "broadcast", fake_broadcast)

    # 4. Apply link with valid plan_hash -> 200
    res_apply = client.post(
        "/api/tasks/01.1/use-cases/apply",
        json={"use_cases": ["UC001", "UC002"], "action": "link", "expect_plan_hash": plan_hash},
        headers=headers,
    )
    assert res_apply.status_code == 200
    assert res_apply.json()["ok"] is True
    assert res_apply.json()["applied"] is True

    # Verify broadcasts after apply: use_cases_changed and tasks_updated
    b_types = [b.get("type") for b in broadcasts]
    assert "use_cases_changed" in b_types
    assert "tasks_updated" in b_types

    # Verify use case detail reflects linked tasks
    res_uc1 = client.get("/api/use-cases/UC001", headers=headers)
    assert "01.1" in res_uc1.json()["use_case"]["linked_tasks"]

    # 5. Preview unlink
    res_prev_unlink = client.post(
        "/api/tasks/01.1/use-cases/preview",
        json={"use_cases": ["UC002"], "action": "unlink"},
        headers=headers,
    )
    assert res_prev_unlink.status_code == 200
    unlink_hash = res_prev_unlink.json()["plan_hash"]

    # 6. Apply unlink
    res_apply_unlink = client.post(
        "/api/tasks/01.1/use-cases/apply",
        json={"use_cases": ["UC002"], "action": "unlink", "expect_plan_hash": unlink_hash},
        headers=headers,
    )
    assert res_apply_unlink.status_code == 200
    assert res_apply_unlink.json()["applied"] is True

    # UC002 unlinked, UC001 still linked
    res_uc2 = client.get("/api/use-cases/UC002", headers=headers)
    assert "01.1" not in res_uc2.json()["use_case"]["linked_tasks"]
    res_uc1_after = client.get("/api/use-cases/UC001", headers=headers)
    assert "01.1" in res_uc1_after.json()["use_case"]["linked_tasks"]


def test_use_cases_queue_and_revalidation_lifecycle(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws, tdir = _setup_workspace_with_task(tmp_path)
    monkeypatch.setattr(state, "workspace", ws)

    client.post("/api/tasks/sync-index", headers=headers)

    # Queue initially empty
    res_q0 = client.get("/api/use-cases/queue", headers=headers)
    assert res_q0.status_code == 200
    assert res_q0.json()["ok"] is True
    assert res_q0.json()["count"] == 0
    assert res_q0.json()["queue"] == []

    # Create approved use case UC001
    client.post(
        "/api/use-cases",
        json={"id": "UC001", "title": "Core flow", "approval": "approved", "verification_command": "echo OK"},
        headers=headers,
    )

    # Link 01.1 to UC001
    res_prev = client.post(
        "/api/tasks/01.1/use-cases/preview",
        json={"use_cases": ["UC001"], "action": "link"},
        headers=headers,
    )
    plan_hash = res_prev.json()["plan_hash"]
    client.post(
        "/api/tasks/01.1/use-cases/apply",
        json={"use_cases": ["UC001"], "action": "link", "expect_plan_hash": plan_hash},
        headers=headers,
    )

    # Validate UC001 with force once so it was verified
    res_v0 = client.post("/api/use-cases/UC001/validate", json={"actor": "test-runner", "force": True}, headers=headers)
    assert res_v0.status_code == 200

    # Transition 01.1: open -> in progress -> delivered
    tr1 = client.post("/api/tasks/transition", json={"task_id": "01.1", "new_state": "in progress"}, headers=headers)
    assert tr1.status_code == 200
    tr2 = client.post("/api/tasks/transition", json={"task_id": "01.1", "new_state": "delivered"}, headers=headers)
    assert tr2.status_code == 200

    # Inspect queue: UC001 must now be in revalidation pending queue
    res_q1 = client.get("/api/use-cases/queue", headers=headers)
    assert res_q1.status_code == 200
    q1_data = res_q1.json()
    assert q1_data["ok"] is True
    assert q1_data["count"] >= 1
    item = next(it for it in q1_data["queue"] if it["id"] == "UC001")
    assert item["revalidation"] == "pending"
    assert item["triggering_task"] == "01.1"
    assert "date" in item


def test_validate_use_case_force_and_not_ready_409(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws, tdir = _setup_workspace_with_task(tmp_path)
    monkeypatch.setattr(state, "workspace", ws)

    client.post(
        "/api/use-cases",
        json={"id": "UC001", "title": "Checkout flow", "approval": "proposed", "verification_command": "echo PASS"},
        headers=headers,
    )

    # 1. Validate without force on not-ready use case -> 409
    res_not_ready = client.post("/api/use-cases/UC001/validate", json={"actor": "tester"}, headers=headers)
    assert res_not_ready.status_code == 409
    err_body = res_not_ready.json()
    assert "not ready" in err_body.get("error", "").lower()

    # 2. Validate with force: true -> 200
    res_forced = client.post("/api/use-cases/UC001/validate", json={"actor": "tester", "force": True}, headers=headers)
    assert res_forced.status_code == 200
    assert res_forced.json()["verdict"] == "pass"


def test_task_transition_use_case_failing_guard_and_owner_approved(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws, tdir = _setup_workspace_with_task(tmp_path)
    monkeypatch.setattr(state, "workspace", ws)

    client.post("/api/tasks/sync-index", headers=headers)

    # Create approved use case with failing probe
    client.post(
        "/api/use-cases",
        json={"id": "UC001", "title": "Auth flow", "approval": "approved", "verification_command": "exit 1"},
        headers=headers,
    )

    # Link 01.1 to UC001
    prev = client.post("/api/tasks/01.1/use-cases/preview", json={"use_cases": ["UC001"], "action": "link"}, headers=headers)
    plan_hash = prev.json()["plan_hash"]
    client.post("/api/tasks/01.1/use-cases/apply", json={"use_cases": ["UC001"], "action": "link", "expect_plan_hash": plan_hash}, headers=headers)

    # Record failure on UC001
    val_fail = client.post("/api/use-cases/UC001/validate", json={"force": True}, headers=headers)
    assert val_fail.status_code == 200

    # Walk 01.1 to delivered
    client.post("/api/tasks/transition", json={"task_id": "01.1", "new_state": "in progress"}, headers=headers)
    client.post("/api/tasks/transition", json={"task_id": "01.1", "new_state": "delivered"}, headers=headers)

    # Transition to done without owner_approved -> refusal 409 with reason use_case_failing and use_case_ids
    res_refusal = client.post(
        "/api/tasks/transition",
        json={"task_id": "01.1", "new_state": "done", "verifier": "claude"},
        headers=headers,
    )
    assert res_refusal.status_code == 409
    ref_body = res_refusal.json()
    assert ref_body.get("reason") == "use_case_failing"
    assert "UC001" in ref_body.get("use_case_ids", [])
    assert "UC001" in ref_body.get("use_cases", [])

    # Transition to done WITH owner_approved: true -> 200 overrides guard!
    res_override = client.post(
        "/api/tasks/transition",
        json={"task_id": "01.1", "new_state": "done", "owner_approved": True},
        headers=headers,
    )
    assert res_override.status_code == 200
    assert res_override.json()["ok"] is True
    assert res_override.json()["new_state"] == "done"


def test_campaign_endpoint_passes_through_fields(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws, tdir = _setup_workspace_with_task(tmp_path)
    monkeypatch.setattr(state, "workspace", ws)

    client.post(
        "/api/use-cases",
        json={"id": "UC001", "title": "Reporting", "approval": "proposed", "verification_command": "echo OK"},
        headers=headers,
    )

    res_camp = client.post("/api/use-cases/campaign", json={}, headers=headers)
    assert res_camp.status_code == 200
    camp = res_camp.json()
    assert camp["ok"] is True
    assert "readiness_score" in camp
    assert "not_ready" in camp
    assert "untested" in camp
    assert "out_of_scope" in camp or "in_scope" in camp
