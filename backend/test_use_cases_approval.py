"""Tests for use-case approval endpoints (POST /api/use-cases/approval/preview and /apply):
- Refusal without selection -> 400 Bad Request
- Invalid action -> 400 Bad Request
- Preview approve, apply without expect_plan_hash -> 400 Bad Request
- Apply with mismatching expect_plan_hash -> 409 Conflict
- Apply approve with valid expect_plan_hash -> 200, sets approval: approved, approved-by: owner, approved date
- Broadcasts use_cases_changed after apply
- Deprecate and re-propose actions
- Stage, approval, and all selection filters
- GET /api/use-cases with approval filter
"""
from __future__ import annotations

import os
import pathlib
import pytest
from starlette.testclient import TestClient

os.environ.setdefault("AI_ORCH_ALLOWED_HOSTS", "testserver,localhost,127.0.0.1,localhost:8780,127.0.0.1:8780")
if not os.environ.get("AI_ORCH_BIN"):
    candidate_bin = pathlib.Path("/Users/Alfredo/.local/bin/ai-orch")
    if candidate_bin.is_file():
        os.environ["AI_ORCH_BIN"] = str(candidate_bin)

from server import app, get_or_create_token, state  # noqa: E402

client = TestClient(app)


def _setup_workspace(tmp_path: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
    ws = tmp_path / "test_ws"
    ws.mkdir(parents=True, exist_ok=True)
    tdir = ws / "tasks"
    tdir.mkdir(parents=True, exist_ok=True)
    (tdir / "00-INDEX.md").write_text("# Tasks Index\n", encoding="utf-8")
    return ws, tdir


def test_use_case_approval_refusal_without_selection(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws, tdir = _setup_workspace(tmp_path)
    monkeypatch.setattr(state, "workspace", ws)

    # 1. Preview approve with no selection -> 400 Refusing to approve without selection
    res_prev = client.post("/api/use-cases/approval/preview", json={"action": "approve"}, headers=headers)
    assert res_prev.status_code == 400
    prev_body = res_prev.json()
    assert prev_body["ok"] is False
    assert "without selection" in prev_body["error"].lower()

    # 2. Preview deprecate with no selection -> 400
    res_dep = client.post("/api/use-cases/approval/preview", json={"action": "deprecate"}, headers=headers)
    assert res_dep.status_code == 400
    assert "without selection" in res_dep.json()["error"].lower()

    # 3. Preview propose with no selection -> 400
    res_prop = client.post("/api/use-cases/approval/preview", json={"action": "propose"}, headers=headers)
    assert res_prop.status_code == 400
    assert "without selection" in res_prop.json()["error"].lower()

    # 4. Invalid action -> 400
    res_bad = client.post("/api/use-cases/approval/preview", json={"action": "invalid_action", "all": True}, headers=headers)
    assert res_bad.status_code == 400
    assert "action must be" in res_bad.json()["error"]


def test_use_case_approval_preview_and_apply(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws, tdir = _setup_workspace(tmp_path)
    monkeypatch.setattr(state, "workspace", ws)

    # Create a proposed use case
    res_create = client.post(
        "/api/use-cases",
        json={"id": "UC001", "title": "Checkout flow", "approval": "proposed", "actor": "Shopper"},
        headers=headers,
    )
    assert res_create.status_code == 200

    # 1. Preview approve UC001
    res_prev = client.post(
        "/api/use-cases/approval/preview",
        json={"action": "approve", "ids": ["UC001"]},
        headers=headers,
    )
    assert res_prev.status_code == 200
    prev_data = res_prev.json()
    assert prev_data["ok"] is True
    assert prev_data["applied"] is False
    assert prev_data["dry_run"] is True
    assert prev_data["action"] == "approve"
    assert prev_data["target_approval"] == "approved"
    assert prev_data["by"] == "owner"
    assert prev_data["matched_count"] == 1
    assert prev_data["changed_count"] == 1
    plan_hash = prev_data["plan_hash"]
    assert plan_hash

    uc_item = prev_data["use_cases"][0]
    assert uc_item["id"] == "UC001"
    assert uc_item["from"] == "proposed"
    assert uc_item["to"] == "approved"
    assert uc_item["changed"] is True

    # 2. Apply without expect_plan_hash -> 400
    res_apply_no_hash = client.post(
        "/api/use-cases/approval/apply",
        json={"action": "approve", "ids": ["UC001"]},
        headers=headers,
    )
    assert res_apply_no_hash.status_code == 400
    assert "expect_plan_hash is required" in res_apply_no_hash.json()["error"]

    # 3. Apply with wrong plan_hash -> 409
    res_apply_bad_hash = client.post(
        "/api/use-cases/approval/apply",
        json={"action": "approve", "ids": ["UC001"], "expect_plan_hash": "deadbeef1234"},
        headers=headers,
    )
    assert res_apply_bad_hash.status_code == 409

    # Track broadcast
    broadcasts: list[dict] = []
    orig_broadcast = state.broadcast

    async def fake_broadcast(msg):
        broadcasts.append(msg)
        await orig_broadcast(msg)

    monkeypatch.setattr(state, "broadcast", fake_broadcast)

    # 4. Apply approve with valid expect_plan_hash -> 200
    res_apply = client.post(
        "/api/use-cases/approval/apply",
        json={"action": "approve", "ids": ["UC001"], "expect_plan_hash": plan_hash},
        headers=headers,
    )
    assert res_apply.status_code == 200
    apply_data = res_apply.json()
    assert apply_data["ok"] is True
    assert apply_data["applied"] is True
    assert apply_data["action"] == "approve"

    # Verify broadcast
    b_types = [b.get("type") for b in broadcasts]
    assert "use_cases_changed" in b_types

    # Verify use case detail
    res_get = client.get("/api/use-cases/UC001", headers=headers)
    assert res_get.status_code == 200
    uc_detail = res_get.json()["use_case"]
    assert uc_detail["approval"] == "approved"
    assert uc_detail.get("approved_by") == "owner"
    assert uc_detail.get("approved") is not None


def test_use_case_approval_deprecate_and_propose(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws, tdir = _setup_workspace(tmp_path)
    monkeypatch.setattr(state, "workspace", ws)

    # Create use case
    client.post(
        "/api/use-cases",
        json={"id": "UC002", "title": "Legacy auth", "approval": "proposed"},
        headers=headers,
    )

    # Approve first
    p1 = client.post("/api/use-cases/approval/preview", json={"action": "approve", "ids": ["UC002"]}, headers=headers).json()
    client.post("/api/use-cases/approval/apply", json={"action": "approve", "ids": ["UC002"], "expect_plan_hash": p1["plan_hash"]}, headers=headers)

    uc_app = client.get("/api/use-cases/UC002", headers=headers).json()["use_case"]
    assert uc_app["approval"] == "approved"
    assert uc_app["approved_by"] == "owner"

    # 1. Deprecate
    p2 = client.post("/api/use-cases/approval/preview", json={"action": "deprecate", "ids": ["UC002"], "reason": "superseded"}, headers=headers).json()
    assert p2["action"] == "deprecate"
    assert p2["target_approval"] == "deprecated"
    assert p2["reason"] == "superseded"

    res_dep = client.post(
        "/api/use-cases/approval/apply",
        json={"action": "deprecate", "ids": ["UC002"], "expect_plan_hash": p2["plan_hash"], "reason": "superseded"},
        headers=headers,
    )
    assert res_dep.status_code == 200

    uc_dep = client.get("/api/use-cases/UC002", headers=headers).json()["use_case"]
    assert uc_dep["approval"] == "deprecated"
    assert uc_dep.get("approved_by") is None
    assert uc_dep.get("approved") is None

    # 2. Back to proposed (propose)
    p3 = client.post("/api/use-cases/approval/preview", json={"action": "propose", "ids": ["UC002"]}, headers=headers).json()
    assert p3["action"] == "propose"
    assert p3["target_approval"] == "proposed"

    res_prop = client.post(
        "/api/use-cases/approval/apply",
        json={"action": "propose", "ids": ["UC002"], "expect_plan_hash": p3["plan_hash"]},
        headers=headers,
    )
    assert res_prop.status_code == 200

    uc_prop = client.get("/api/use-cases/UC002", headers=headers).json()["use_case"]
    assert uc_prop["approval"] == "proposed"


def test_use_case_approval_filters_and_list_filter(monkeypatch, tmp_path):
    token = get_or_create_token()
    headers = {"X-AI-Orch-Token": token}
    ws, tdir = _setup_workspace(tmp_path)
    monkeypatch.setattr(state, "workspace", ws)

    # Create two use cases in proposed
    client.post("/api/use-cases", json={"id": "UC001", "title": "First", "approval": "proposed"}, headers=headers)
    client.post("/api/use-cases", json={"id": "UC002", "title": "Second", "approval": "proposed"}, headers=headers)

    # Approve all shown via approval: "proposed" filter
    prev = client.post(
        "/api/use-cases/approval/preview",
        json={"action": "approve", "approval": "proposed"},
        headers=headers,
    ).json()
    assert prev["ok"] is True
    assert prev["matched_count"] == 2
    assert prev["changed_count"] == 2

    # Apply
    apply_res = client.post(
        "/api/use-cases/approval/apply",
        json={"action": "approve", "approval": "proposed", "expect_plan_hash": prev["plan_hash"]},
        headers=headers,
    )
    assert apply_res.status_code == 200

    # Test GET /api/use-cases?approval=approved filter
    res_list_approved = client.get("/api/use-cases?approval=approved", headers=headers)
    assert res_list_approved.status_code == 200
    data = res_list_approved.json()
    assert data["total"] == 2
    assert all(u["approval"] == "approved" for u in data["use_cases"])

    # Test GET /api/use-cases?approval=deprecated -> 0
    res_list_dep = client.get("/api/use-cases?approval=deprecated", headers=headers)
    assert res_list_dep.status_code == 200
    assert res_list_dep.json()["total"] == 0
