"""Unit tests for ai-orchestration-ui backend/server.py including frontend static bundle serving."""
from __future__ import annotations

import pathlib
import pytest
from starlette.testclient import TestClient

from server import app, state

client = TestClient(app)


def test_serve_frontend_index():
    res = client.get("/")
    assert res.status_code == 200
    assert "AI Orchestration Control Plane" in res.text


def test_get_workspace():
    res = client.get("/api/workspace")
    assert res.status_code == 200
    data = res.json()
    assert "workspace_path" in data
    assert "has_tasks_dir" in data


def test_list_tasks():
    res = client.get("/api/tasks")
    assert res.status_code == 200
    data = res.json()
    assert "emergent_tasks" in data or "initiatives" in data
    assert data.get("ok") is True


def test_env_status():
    res = client.get("/api/env/status")
    assert res.status_code == 200
    data = res.json()
    assert "clis" in data
    assert "environments" in data
    assert "kilo" in data["clis"]
    assert "claude" in data["clis"]
    assert "codex" in data["clis"]


def test_config_show():
    res = client.get("/api/config/show")
    assert res.status_code == 200
    data = res.json()
    assert "config" in data
    assert "routing" in data["config"]


def test_render_agents_md():
    res = client.get("/api/config/render-agents-md")
    assert res.status_code == 200
    data = res.json()
    assert "rendered_block" in data
    assert "<!-- BEGIN ai-orchestration -->" in data["rendered_block"]
