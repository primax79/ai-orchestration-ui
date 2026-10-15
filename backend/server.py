#!/usr/bin/env python3
"""server.py — Local HTTP & WebSocket Backend for the AI Orchestration Control Plane.

Exposes REST & WebSocket APIs over `ai-orchestration`'s deterministic CLI (`bin/ai-orch`),
enabling the Web UI and VS Code Extension Webview to:
  1. Manage the task backlog (overview, Kanban, task editor, state transitions, index sync)
  2. Install skills & MCP servers across Kilo, Claude, and Codex
  3. Inspect environment health and skill drift across assistants
  4. Configure orchestration.toml and sync AGENTS.md

Zero proprietary database: the repository's `tasks/` and config files remain the single source of truth.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import subprocess
import sys
from typing import Any

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

UI_ROOT = pathlib.Path(__file__).resolve().parent.parent
AI_ORCH_BIN = UI_ROOT.parent / "ai-orchestration" / "bin" / "ai-orch"
DEFAULT_WORKSPACE = UI_ROOT.parent


class OrchestrationState:
    def __init__(self, workspace: pathlib.Path):
        self.workspace = workspace.resolve()
        self.active_websockets: set[WebSocket] = set()
        self.watcher_task: asyncio.Task | None = None

    def set_workspace(self, new_ws: pathlib.Path) -> None:
        self.workspace = new_ws.resolve()

    async def broadcast(self, message: dict[str, Any]) -> None:
        stale = set()
        for ws in self.active_websockets:
            try:
                await ws.send_json(message)
            except Exception:
                stale.add(ws)
        self.active_websockets.difference_update(stale)


state = OrchestrationState(DEFAULT_WORKSPACE)


def run_ai_orch(args: list[str]) -> tuple[int, dict[str, Any] | str]:
    """Execute `./bin/ai-orch <args...>` and return (exit_code, parsed_json_or_text)."""
    if not AI_ORCH_BIN.is_file():
        return 1, f"ai-orch CLI not found at {AI_ORCH_BIN}"
    cmd = [sys.executable, str(AI_ORCH_BIN), *args]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    out = proc.stdout.strip()
    err = proc.stderr.strip()
    try:
        parsed = json.loads(out) if out else {}
        return proc.returncode, parsed
    except Exception:
        return proc.returncode, out or err


# ---------------------------------------------------------------------------
# REST Endpoints: Workspace
# ---------------------------------------------------------------------------

async def api_get_workspace(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    has_tasks = tasks_dir.is_dir()
    return JSONResponse({
        "workspace_path": str(state.workspace),
        "workspace_name": state.workspace.name,
        "has_tasks_dir": has_tasks,
        "tasks_path": str(tasks_dir) if has_tasks else None,
    })


async def api_switch_workspace(request: Request) -> JSONResponse:
    body = await request.json()
    new_path = pathlib.Path(body.get("workspace_path", "")).expanduser().resolve()
    if not new_path.is_dir():
        return JSONResponse({"error": f"Directory not found: {new_path}"}, status_code=400)
    state.set_workspace(new_path)
    await state.broadcast({"type": "workspace_switched", "workspace": str(new_path)})
    return JSONResponse({"ok": True, "workspace_path": str(new_path)})


# ---------------------------------------------------------------------------
# REST Endpoints: Macro 1 — Backlog & Tasks
# ---------------------------------------------------------------------------

async def api_list_tasks(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    if not tasks_dir.is_dir():
        return JSONResponse({"tasks": [], "initiatives": [], "stats": {"total": 0}, "message": "No tasks/ directory in current workspace"})
    code, data = run_ai_orch(["tasks", "list", "--tasks-dir", str(tasks_dir), "--json"])
    if code != 0:
        return JSONResponse({"error": data}, status_code=500)
    return JSONResponse(data)


async def api_validate_tasks(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    code, data = run_ai_orch(["tasks", "validate", "--tasks-dir", str(tasks_dir), "--json"])
    return JSONResponse(data, status_code=200 if code == 0 else 400)


async def api_transition_task(request: Request) -> JSONResponse:
    body = await request.json()
    task_id = body.get("task_id")
    new_state = body.get("new_state")
    if not task_id or not new_state:
        return JSONResponse({"error": "task_id and new_state are required"}, status_code=400)

    cmd = ["tasks", "transition", str(task_id), str(new_state), "--tasks-dir", str(state.workspace / "tasks"), "--json"]
    if body.get("actor"):
        cmd.extend(["--actor", str(body["actor"])])
    if body.get("verifier"):
        cmd.extend(["--verifier", str(body["verifier"])])
    if body.get("reason"):
        cmd.extend(["--reason", str(body["reason"])])

    code, data = run_ai_orch(cmd)
    if code == 0:
        # Auto-sync 00-INDEX.md after successful transition
        run_ai_orch(["tasks", "sync-index", "--tasks-dir", str(state.workspace / "tasks"), "--apply", "--json"])
        await state.broadcast({"type": "task_transitioned", "task_id": task_id, "new_state": new_state})
    return JSONResponse(data, status_code=200 if code == 0 else 400)


async def api_sync_index(request: Request) -> JSONResponse:
    tasks_dir = state.workspace / "tasks"
    code, data = run_ai_orch(["tasks", "sync-index", "--tasks-dir", str(tasks_dir), "--apply", "--json"])
    if code == 0:
        await state.broadcast({"type": "index_synced"})
    return JSONResponse(data, status_code=200 if code == 0 else 500)


async def api_get_task_detail(request: Request) -> JSONResponse:
    task_id = request.path_params["task_id"]
    tasks_dir = state.workspace / "tasks"

    # Search in active and done directories
    candidates = list(tasks_dir.glob(f"*/{task_id}-*.md")) + list(tasks_dir.glob(f"*/{task_id}/README.md"))
    candidates += list(tasks_dir.glob(f"done/*/{task_id}-*.md")) + list(tasks_dir.glob(f"done/*/{task_id}/README.md"))

    if not candidates:
        return JSONResponse({"error": f"Task {task_id} file not found"}, status_code=404)

    target_file = candidates[0]
    content = target_file.read_text(encoding="utf-8")

    progress_file = target_file.parent / "PROGRESS.md" if target_file.name == "README.md" else None
    progress_content = progress_file.read_text(encoding="utf-8") if progress_file and progress_file.is_file() else None

    return JSONResponse({
        "task_id": task_id,
        "file_path": str(target_file),
        "relative_path": str(target_file.relative_to(state.workspace)),
        "is_folder_bundle": target_file.name == "README.md",
        "content": content,
        "progress_content": progress_content,
    })


# ---------------------------------------------------------------------------
# REST Endpoints: Macro 2 & 3 — Environment Doctor & Skills Installer
# ---------------------------------------------------------------------------

async def api_env_status(request: Request) -> JSONResponse:
    code, data = run_ai_orch(["env", "status", "--workspace", str(state.workspace), "--json"])
    if code != 0:
        return JSONResponse({"error": data}, status_code=500)
    return JSONResponse(data)


async def api_install_skills(request: Request) -> JSONResponse:
    body = await request.json()
    assistants = body.get("assistants", ["all"])
    scope = body.get("scope", "global")
    repo = body.get("repo", "ai-orchestration")
    link = body.get("link", False)

    cmd = ["env", "install-skills", "--scope", scope, "--repo", repo, "--workspace", str(state.workspace), "--json"]
    cmd.extend(["--assistants", *assistants])
    if link:
        cmd.append("--link")

    code, data = run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "skills_installed", "repo": repo, "scope": scope})
    return JSONResponse(data, status_code=200 if code == 0 else 500)


async def api_register_mcp(request: Request) -> JSONResponse:
    body = await request.json()
    server = body.get("server", "kilo-mcp")
    assistants = body.get("assistants", ["claude", "codex"])
    scope = body.get("scope", "global")
    provision_venv = body.get("provision_venv", False)

    cmd = ["env", "register-mcp", server, "--scope", scope, "--workspace", str(state.workspace), "--json"]
    cmd.extend(["--assistants", *assistants])
    if provision_venv:
        cmd.append("--provision-venv")

    code, data = run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "mcp_registered", "server": server})
    return JSONResponse(data, status_code=200 if code == 0 else 500)


# ---------------------------------------------------------------------------
# REST Endpoints: Macro 4 — Orchestrator Configuration & AGENTS.md
# ---------------------------------------------------------------------------

async def api_config_show(request: Request) -> JSONResponse:
    code, data = run_ai_orch(["config", "show", "--workspace", str(state.workspace), "--json"])
    if code != 0:
        return JSONResponse({"error": data}, status_code=500)
    return JSONResponse(data)


async def api_config_set_profile(request: Request) -> JSONResponse:
    body = await request.json()
    tool = body.get("tool")
    profile = body.get("profile")
    model = body.get("model")
    if not tool or not profile or not model:
        return JSONResponse({"error": "tool, profile, and model are required"}, status_code=400)

    cmd = ["config", "set-profile", tool, profile, "--model", model, "--json"]
    if body.get("variant"):
        cmd.extend(["--variant", str(body["variant"])])
    if body.get("effort"):
        cmd.extend(["--effort", str(body["effort"])])
    if body.get("basis"):
        cmd.extend(["--basis", str(body["basis"])])
    if body.get("scope"):
        cmd.extend(["--scope", str(body["scope"])])
    if body.get("scope") == "project":
        cmd.extend(["--workspace", str(state.workspace)])

    code, data = run_ai_orch(cmd)
    if code == 0:
        await state.broadcast({"type": "config_updated"})
    return JSONResponse(data, status_code=200 if code == 0 else 500)


async def api_render_agents_md(request: Request) -> JSONResponse:
    code, data = run_ai_orch(["render-agents-md", "--workspace", str(state.workspace), "--json"])
    return JSONResponse(data)


async def api_apply_agents_md(request: Request) -> JSONResponse:
    code, data = run_ai_orch(["render-agents-md", "--workspace", str(state.workspace), "--apply", "--json"])
    if code == 0:
        await state.broadcast({"type": "agents_md_applied"})
    return JSONResponse(data, status_code=200 if code == 0 else 500)


# ---------------------------------------------------------------------------
# WebSocket Endpoint: Live File & State Updates
# ---------------------------------------------------------------------------

async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    state.active_websockets.add(websocket)
    try:
        await websocket.send_json({"type": "connected", "workspace": str(state.workspace)})
        while True:
            # Keepalive / ping-pong
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except (WebSocketDisconnect, Exception):
        state.active_websockets.discard(websocket)


# ---------------------------------------------------------------------------
# Application Scaffolding
# ---------------------------------------------------------------------------

routes = [
    Route("/api/workspace", api_get_workspace, methods=["GET"]),
    Route("/api/workspace/switch", api_switch_workspace, methods=["POST"]),
    Route("/api/tasks", api_list_tasks, methods=["GET"]),
    Route("/api/tasks/validate", api_validate_tasks, methods=["GET"]),
    Route("/api/tasks/transition", api_transition_task, methods=["POST"]),
    Route("/api/tasks/sync-index", api_sync_index, methods=["POST"]),
    Route("/api/tasks/{task_id}", api_get_task_detail, methods=["GET"]),
    Route("/api/env/status", api_env_status, methods=["GET"]),
    Route("/api/env/install-skills", api_install_skills, methods=["POST"]),
    Route("/api/env/register-mcp", api_register_mcp, methods=["POST"]),
    Route("/api/config/show", api_config_show, methods=["GET"]),
    Route("/api/config/set-profile", api_config_set_profile, methods=["POST"]),
    Route("/api/config/render-agents-md", api_render_agents_md, methods=["GET"]),
    Route("/api/config/render-agents-md/apply", api_apply_agents_md, methods=["POST"]),
    WebSocketRoute("/ws", ws_endpoint),
]

# Static UI mount if built
dist_dir = UI_ROOT / "frontend" / "dist"
if dist_dir.is_dir():
    routes.append(Mount("/", app=StaticFiles(directory=str(dist_dir), html=True), name="static"))

app = Starlette(
    routes=routes,
    middleware=[
        Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    ],
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765, help="Port to listen on (default: 8765)")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--workspace", default=str(DEFAULT_WORKSPACE), help="Initial workspace path")
    args = parser.parse_args()

    state.set_workspace(pathlib.Path(args.workspace))
    import uvicorn
    print(f"==> AI Orchestration Server listening on http://{args.host}:{args.port}")
    print(f"==> Active Workspace: {state.workspace}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
