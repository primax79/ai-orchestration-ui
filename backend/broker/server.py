"""backend/broker/server.py — Orchestration broker MCP server over streamable HTTP.

Implements Task 16.5:
1. Singleton instance via broker.lock (using scripts/orchestration_broker_lock.py)
   in the config dir (respecting AI_ORCHESTRATION_CONFIG or ~/.config/ai-orchestration).
2. Writes broker.json {pid, port, started_at, token_file} only after holding the lock.
3. Streamable HTTP MCP server on 127.0.0.1 (random free port or user-specified), requiring
   the x-ai-orch-token header.
4. Tools per spec §3b:
   - whoami
   - workspaces.list
   - projects.list
   - tasks.list (compact rows)
   - tasks.show
   - tasks.next
   - tasks.graph
   - tasks.new
   - tasks.transition
   - tasks.set
   - questions.list
   - questions.ask
   - questions.answer
   - inbox.add_note
   - orchestrator.status
   Plus compatibility aliases (tasks_list, debug_sleep).
5. All reads and writes go through the engine CLI (bin/ai-orch ... --json) with AI_ORCH_BROKER_CHILD=1.
6. Results: single text Content item with JSON object, ok: bool, no null fields anywhere, paged
   and capped at 256 KiB.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import fcntl
import hashlib
import hmac
import json
import logging
import os
import pathlib
import re
import secrets
import socket
import sys
import time
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send
import uvicorn

logger = logging.getLogger("ai-orchestration.broker")

# Module-level test hook (spec §5 / task 16.1):
# When set, append a one-line human-readable notice to the text content of tool results.
unread_notice: str | None = None
_broker_started_at: str | None = None


def _apply_notice(text: str) -> str:
    global unread_notice
    if unread_notice:
        notice_line = str(unread_notice).strip()
        if not text.endswith("\n"):
            text += "\n"
        text += f"\n{notice_line}"
    return text


def strip_none(obj: Any) -> Any:
    """Recursively drop keys and values that are None so no null fields exist in output."""
    if isinstance(obj, dict):
        return {k: strip_none(v) for k, v in obj.items() if v is not None}
    elif isinstance(obj, list):
        return [strip_none(x) for x in obj if x is not None]
    return obj


def make_tool_result(data: dict[str, Any], is_error: bool = False) -> CallToolResult:
    cleaned = strip_none(data)
    json_str = json.dumps(cleaned, indent=2)
    text = _apply_notice(json_str)
    return CallToolResult(content=[TextContent(type="text", text=text)], is_error=is_error)


def make_error_result(error_code: str, message: str) -> CallToolResult:
    kebab = error_code.strip().replace("_", "-")
    return make_tool_result({"ok": False, "error": kebab, "message": message}, is_error=True)


def paginate_items(
    items: list[dict[str, Any]],
    cursor: str | None = None,
    limit: int | None = None,
    max_bytes: int = 256 * 1024,
    base_dict: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], str | None, bool]:
    """Page a list of items and enforce the 256 KiB response cap."""
    effective_limit = 50
    if limit is not None:
        try:
            effective_limit = max(1, min(int(limit), 200))
        except (ValueError, TypeError):
            effective_limit = 50

    offset = 0
    if cursor is not None:
        try:
            offset = max(0, int(cursor))
        except (ValueError, TypeError):
            offset = 0

    sliced = items[offset : offset + effective_limit]
    has_more = (offset + effective_limit) < len(items)
    next_cursor = str(offset + len(sliced)) if has_more else None
    truncated = False

    base = dict(base_dict or {})
    base["ok"] = True
    base["items"] = sliced
    if next_cursor is not None:
        base["next_cursor"] = next_cursor

    dumped = json.dumps(strip_none(base), indent=2)
    if len(dumped.encode("utf-8")) > max_bytes:
        truncated = True
        while len(sliced) > 1 and len(dumped.encode("utf-8")) > max_bytes:
            sliced = sliced[:-1]
            base["items"] = sliced
            base["truncated"] = True
            base["next_cursor"] = str(offset + len(sliced))
            dumped = json.dumps(strip_none(base), indent=2)
        next_cursor = str(offset + len(sliced))

    return sliced, next_cursor, truncated


def get_broker_config_dir() -> pathlib.Path:
    raw = os.environ.get("AI_ORCHESTRATION_CONFIG")
    if raw and raw.strip():
        p = pathlib.Path(raw).expanduser().resolve()
        if p.is_file() or p.suffix.lower() == ".toml":
            return p.parent
        return p
    raw_dir = os.environ.get("AI_ORCH_CONFIG_DIR")
    if raw_dir and raw_dir.strip():
        return pathlib.Path(raw_dir).expanduser().resolve()
    raw_home = os.environ.get("AI_ORCH_HOME")
    if raw_home and raw_home.strip():
        return (pathlib.Path(raw_home).expanduser() / ".config" / "ai-orchestration").resolve()
    return (pathlib.Path.home() / ".config" / "ai-orchestration").resolve()


def get_or_create_token(config_dir: pathlib.Path | None = None) -> str:
    if config_dir is None:
        config_dir = get_broker_config_dir()
    token_file = config_dir / "ui-token"
    if token_file.is_file():
        try:
            token = token_file.read_text(encoding="utf-8").strip()
            if token:
                return token
        except Exception:
            pass

    config_dir.mkdir(parents=True, exist_ok=True)
    raw_token = secrets.token_urlsafe(32)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(str(token_file), flags, 0o600)
    try:
        with open(fd, "w", encoding="utf-8") as f:
            f.write(raw_token)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    try:
        token_file.chmod(0o600)
    except Exception:
        pass
    return raw_token


def get_ai_orch_bin() -> pathlib.Path:
    if "AI_ORCH_BIN" in os.environ and os.environ["AI_ORCH_BIN"].strip():
        return pathlib.Path(os.environ["AI_ORCH_BIN"]).expanduser().resolve()
    broker_root = pathlib.Path(__file__).resolve().parent
    ui_root = broker_root.parent.parent
    sibling = ui_root.parent / "ai-orchestration" / "bin" / "ai-orch"
    if sibling.is_file():
        return sibling
    for parent in ui_root.parents:
        cand = parent / "ai-orchestration" / "bin" / "ai-orch"
        if cand.is_file():
            return cand
    return sibling


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def acquire_broker_lock(config_dir: pathlib.Path) -> Any:
    # Try scripts/orchestration_broker_lock.py first
    try:
        bin_path = get_ai_orch_bin()
        scripts_dir = bin_path.parent.parent / "scripts"
        if scripts_dir.is_dir() and str(scripts_dir) not in sys.path:
            sys.path.insert(0, str(scripts_dir))
        import orchestration_broker_lock
        handle = orchestration_broker_lock.acquire_broker_lock(config_dir)
        if handle is None:
            sys.stderr.write("Broker is already running (locked by another process)\n")
            sys.stderr.flush()
            sys.exit(1)
        return handle
    except Exception:
        pass

    # Direct fallback
    config_dir.mkdir(parents=True, exist_ok=True)
    lock_file = config_dir / "broker.lock"
    fd = os.open(str(lock_file), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (BlockingIOError, OSError):
        try:
            os.close(fd)
        except OSError:
            pass
        sys.stderr.write("Broker is already running (locked by another process)\n")
        sys.stderr.flush()
        sys.exit(1)
    return fd


def write_broker_json(config_dir: pathlib.Path, port: int, token_file: pathlib.Path) -> None:
    data = {
        "pid": os.getpid(),
        "port": port,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "token_file": str(token_file.resolve()),
    }
    target = config_dir / "broker.json"
    tmp = config_dir / f"broker.json.tmp.{os.getpid()}"
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(target)


async def run_ai_orch_cli(
    args: list[str],
    config_dir: pathlib.Path,
    cwd: pathlib.Path | None = None,
) -> tuple[int, dict[str, Any] | None, str, str]:
    """Execute an ai-orch CLI child process with AI_ORCH_BROKER_CHILD=1."""
    bin_path = get_ai_orch_bin()
    if not bin_path.is_file():
        return 1, None, "", f"ai-orch CLI not found at {bin_path}"

    cmd = [str(bin_path), *args]
    env = os.environ.copy()
    env["AI_ORCHESTRATION_CONFIG"] = str(config_dir)
    env["AI_ORCH_BROKER_CHILD"] = "1"

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(cwd) if cwd else None,
        env=env,
        start_new_session=True,
    )
    stdout_b, stderr_b = await proc.communicate()
    stdout_str = stdout_b.decode("utf-8", errors="replace").strip()
    stderr_str = stderr_b.decode("utf-8", errors="replace").strip()

    data = None
    if stdout_str:
        try:
            data = json.loads(stdout_str)
        except Exception:
            pass

    return proc.returncode, data, stdout_str, stderr_str


async def resolve_workspace_info(
    workspace: str,
    config_dir: pathlib.Path,
) -> tuple[pathlib.Path | None, dict[str, Any] | None, str | None]:
    rc, data, stdout, stderr = await run_ai_orch_cli(["workspace", "show", workspace, "--json"], config_dir)
    if rc == 0 and data and data.get("ok") and "workspace" in data:
        ws_info = data["workspace"]
        ws_path = pathlib.Path(ws_info["canonical_path"]).resolve()
        return ws_path, ws_info, None

    rc_l, data_l, _, _ = await run_ai_orch_cli(["workspace", "list", "--json"], config_dir)
    if rc_l == 0 and data_l and data_l.get("ok"):
        ws_list = data_l.get("items", [])
        for item in ws_list:
            if (
                item.get("slug") == workspace
                or item.get("uuid") == workspace
                or item.get("canonical_path") == str(pathlib.Path(workspace).resolve())
            ):
                ws_path = pathlib.Path(item["canonical_path"]).resolve()
                return ws_path, item, None

    err_msg = (data.get("error") if data else None) or stderr or stdout or f"Workspace '{workspace}' not found"
    return None, None, str(err_msg)


async def resolve_project_tasks_dir(
    workspace: str,
    project: str,
    config_dir: pathlib.Path,
) -> tuple[pathlib.Path | None, str | None]:
    ws_path, ws_info, err = await resolve_workspace_info(workspace, config_dir)
    if err or not ws_path:
        return None, err or f"Workspace '{workspace}' not found"

    if project == "_workspace":
        tasks_dir = ws_path / "tasks"
        if not tasks_dir.is_dir():
            return None, f"Tasks directory not found at {tasks_dir}"
        if not (tasks_dir / "00-INDEX.md").is_file():
            return None, f"Tasks directory {tasks_dir} does not contain 00-INDEX.md"
        return tasks_dir, None

    rc, data, stdout, stderr = await run_ai_orch_cli(["projects", "list", workspace, "--json"], config_dir)
    if rc != 0 or not data or not data.get("ok"):
        return None, (data.get("error") if data else None) or stderr or stdout or f"Failed to list projects for workspace '{workspace}'"

    items = data.get("items", [])
    matching = [it for it in items if it.get("slug") == project or it.get("uuid") == project]
    if not matching:
        return None, f"Project '{project}' not found in workspace '{workspace}'"

    proj_item = matching[0]
    rel_path = proj_item.get("path", ".")
    if rel_path == ".":
        tasks_dir = ws_path / "tasks"
    else:
        tasks_dir = (ws_path / rel_path / "tasks").resolve()

    if not tasks_dir.is_dir():
        return None, f"Tasks directory not found at {tasks_dir}"
    if not (tasks_dir / "00-INDEX.md").is_file():
        return None, f"Tasks directory {tasks_dir} does not contain 00-INDEX.md"
    return tasks_dir, None


class BrokerTokenAuthMiddleware:
    def __init__(self, app: ASGIApp, token: str):
        self.app = app
        self.token = token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path == "/health":
                response = JSONResponse({"status": "ok", "pid": os.getpid()})
                await response(scope, receive, send)
                return

            headers = dict(scope.get("headers", []))
            token_hdr = headers.get(b"x-ai-orch-token", b"").decode("latin1")
            auth_hdr = headers.get(b"authorization", b"").decode("latin1")
            bearer_token = ""
            if auth_hdr.lower().startswith("bearer "):
                bearer_token = auth_hdr[7:].strip()

            candidate = token_hdr or bearer_token
            if not candidate or not hmac.compare_digest(candidate, self.token):
                response = JSONResponse({"error": "unauthorized"}, status_code=401)
                await response(scope, receive, send)
                return

        await self.app(scope, receive, send)


def create_broker_server(config_dir: pathlib.Path) -> MCPServer:
    server = MCPServer(
        "ai-orchestration-broker",
        version="0.1.0",
        instructions="ai-orchestration broker MCP server",
    )

    # 1. whoami
    async def _handle_whoami() -> CallToolResult:
        global _broker_started_at
        started = _broker_started_at or datetime.now(timezone.utc).isoformat()
        data = {
            "ok": True,
            "broker": {
                "pid": os.getpid(),
                "version": "0.1.0",
                "started_at": started,
            },
            "unread_mail": 0,
            # Spike compatibility fields
            "pid": os.getpid(),
            "version": "0.1.0",
            "config_dir": str(config_dir),
        }
        return make_tool_result(data)

    server.tool(name="whoami")(_handle_whoami)

    # 2. workspaces.list
    async def _handle_workspaces_list(
        cursor: str | None = None,
        limit: int | None = None,
    ) -> CallToolResult:
        rc, data, stdout, stderr = await run_ai_orch_cli(["workspace", "list", "--json"], config_dir)
        if rc != 0 or not data or not data.get("ok"):
            err_msg = (data.get("error") if data else None) or stderr or stdout or "Failed to list workspaces"
            return make_error_result("workspace-list-failed", err_msg)

        items_raw = data.get("items", [])
        formatted_items: list[dict[str, Any]] = []

        for ws in items_raw:
            cpath = ws.get("canonical_path") or ws.get("path") or ""
            orch_state = "missing"
            if cpath:
                rco, odata, _, _ = await run_ai_orch_cli(["orchestrator", "status", "--workspace", cpath, "--json"], config_dir)
                if rco == 0 and odata and "status" in odata:
                    orch_state = odata.get("status") or "missing"

            formatted_items.append({
                "uuid": ws.get("uuid"),
                "slug": ws.get("slug"),
                "title": ws.get("title") or ws.get("slug"),
                "path": cpath,
                "orchestrator": orch_state,
                "unread_mail": 0,
            })

        paged_items, next_cursor, truncated = paginate_items(
            formatted_items,
            cursor=cursor,
            limit=limit,
        )

        resp: dict[str, Any] = {"ok": True, "items": paged_items}
        if next_cursor:
            resp["next_cursor"] = next_cursor
        if truncated:
            resp["truncated"] = True
        return make_tool_result(resp)

    server.tool(name="workspaces.list")(_handle_workspaces_list)

    # 3. projects.list
    async def _handle_projects_list(
        workspace: str,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> CallToolResult:
        rc, data, stdout, stderr = await run_ai_orch_cli(["projects", "list", workspace, "--json"], config_dir)
        if rc != 0 or not data or not data.get("ok"):
            err_msg = (data.get("error") if data else None) or stderr or stdout or f"Failed to list projects for workspace '{workspace}'"
            return make_error_result("projects-list-failed", err_msg)

        items = data.get("items", [])
        out_items = [
            {
                "uuid": p.get("uuid"),
                "slug": p.get("slug"),
                "path": p.get("path"),
                "kind": p.get("kind", "project"),
            }
            for p in items
        ]
        paged_items, next_cursor, truncated = paginate_items(
            out_items,
            cursor=cursor,
            limit=limit,
        )
        resp: dict[str, Any] = {"ok": True, "items": paged_items}
        if next_cursor:
            resp["next_cursor"] = next_cursor
        if truncated:
            resp["truncated"] = True
        return make_tool_result(resp)

    server.tool(name="projects.list")(_handle_projects_list)

    # 4. tasks.list
    async def _handle_tasks_list(
        workspace: str | None = None,
        project: str | None = None,
        state: list[str] | str | None = None,
        kind: str | None = None,
        label: str | None = None,
        text: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
        project_path: str | None = None,
    ) -> CallToolResult:
        if project_path and not workspace:
            p = pathlib.Path(project_path).resolve()
            if not p.exists():
                return make_error_result("path-not-found", f"Project path does not exist: {project_path}")
            if not p.is_dir():
                return make_error_result("not-a-directory", f"Project path is not a directory: {project_path}")
            tasks_dir = p / "tasks"
            if not tasks_dir.is_dir():
                return make_error_result("tasks-dir-not-found", f"Path {project_path} does not contain a tasks/ directory")
            if not (tasks_dir / "00-INDEX.md").is_file():
                return make_error_result("index-not-found", f"Path {project_path}/tasks does not contain 00-INDEX.md")
            rc, data, stdout, stderr = await run_ai_orch_cli(["tasks", "list", "--tasks-dir", str(tasks_dir), "--json"], config_dir)
            if rc != 0 or not data:
                return make_error_result("tasks-list-failed", stderr or stdout or "tasks list failed")
            return CallToolResult(content=[TextContent(type="text", text=_apply_notice(stdout))], is_error=False)
        else:
            if not workspace:
                return make_error_result("missing-argument", "Argument 'workspace' is required")
            if not project:
                return make_error_result("missing-argument", "Argument 'project' is required")
            tasks_dir, err = await resolve_project_tasks_dir(workspace, project, config_dir)
            if err or not tasks_dir:
                return make_error_result("project-not-found" if "Project" in (err or "") else "workspace-not-found", err or "Tasks dir resolution failed")

        rc, data, stdout, stderr = await run_ai_orch_cli(["tasks", "list", "--tasks-dir", str(tasks_dir), "--json"], config_dir)
        if rc != 0 or not data or not data.get("ok"):
            return make_error_result("tasks-list-failed", (data.get("error") if data else None) or stderr or stdout or "tasks list failed")

        tree = data.get("tree", {})
        raw_items: list[dict[str, Any]] = []

        state_filter: set[str] | None = None
        if state:
            if isinstance(state, list):
                state_filter = {s.strip().lower() for s in state if s.strip()}
            else:
                state_filter = {s.strip().lower() for s in str(state).split(",") if s.strip()}

        for tid, node in tree.items():
            node_state = (node.get("canonical_state") or node.get("state") or "").strip().lower()
            node_kind = (node.get("kind") or "").strip().lower()
            node_title = (node.get("title") or "")
            node_short = (node.get("short_title") or node.get("short") or "")

            if state_filter is not None and node_state not in state_filter:
                continue
            if kind and node_kind != kind.strip().lower():
                continue
            if label:
                node_labels = [str(l).strip().lower() for l in node.get("labels", [])]
                if label.strip().lower() not in node_labels:
                    continue
            if text:
                q = text.strip().lower()
                if q not in tid.lower() and q not in node_title.lower() and q not in node_short.lower():
                    continue

            row: dict[str, Any] = {
                "id": tid,
                "short_title": node.get("short_title") or node.get("short") or node_title,
                "title": node_title,
                "state": node.get("canonical_state") or node.get("state", "open"),
                "priority": node.get("priority", "P2"),
                "kind": node.get("kind", "task"),
                "depends_on": list(node.get("depends_on", [])),
                "hash": node.get("task_hash") or node.get("bundle_sha256") or "",
            }
            if node.get("size"):
                row["size"] = node["size"]
            if node.get("parent"):
                row["parent"] = node["parent"]

            raw_items.append(row)

        paged_items, next_cursor, truncated = paginate_items(
            raw_items,
            cursor=cursor,
            limit=limit,
        )

        resp: dict[str, Any] = {
            "ok": True,
            "items": paged_items,
        }
        if next_cursor:
            resp["next_cursor"] = next_cursor
        if truncated:
            resp["truncated"] = True

        return make_tool_result(resp)

    server.tool(name="tasks.list")(_handle_tasks_list)
    server.tool(name="tasks_list")(_handle_tasks_list)

    # 5. tasks.show
    async def _handle_tasks_show(workspace: str, project: str, id: str) -> CallToolResult:
        tasks_dir, err = await resolve_project_tasks_dir(workspace, project, config_dir)
        if err or not tasks_dir:
            return make_error_result("project-not-found" if "Project" in (err or "") else "workspace-not-found", err or "Tasks dir resolution failed")

        rc, data, stdout, stderr = await run_ai_orch_cli(["tasks", "list", "--tasks-dir", str(tasks_dir), "--json"], config_dir)
        if rc != 0 or not data or not data.get("ok"):
            return make_error_result("tasks-list-failed", (data.get("error") if data else None) or stderr or stdout or "tasks list failed")

        tree = data.get("tree", {})
        if id not in tree:
            return make_error_result("task-not-found", f"Task '{id}' not found in project '{project}'")

        node = tree[id]
        file_path = pathlib.Path(node.get("file_path", ""))

        goal_text = ""
        steps_text = ""
        verification_text = ""
        header_dict: dict[str, Any] = {}

        if file_path.is_file():
            content = file_path.read_text(encoding="utf-8")
            pat_sec = re.compile(r"^##\s+([^\n]+)\n(.*?)(?=^## |\Z)", re.MULTILINE | re.DOTALL)
            for m in pat_sec.finditer(content):
                sec_heading = m.group(1).strip().lower()
                sec_body = m.group(2).strip()
                if sec_heading == "goal":
                    goal_text = sec_body
                elif sec_heading == "steps":
                    steps_text = sec_body
                elif sec_heading == "verification":
                    verification_text = sec_body

            header_pat = re.compile(r"^-\s*([^:]+):\s*(.*)$")
            for line in content.splitlines():
                if line.startswith("#"):
                    continue
                if line.startswith("##"):
                    break
                hm = header_pat.match(line.strip())
                if hm:
                    k, v = hm.group(1).strip().lower(), hm.group(2).strip()
                    header_dict[k] = v

        if not header_dict:
            raw_fields = node.get("fields", {})
            for fk, fv in raw_fields.items():
                if isinstance(fv, dict) and "value" in fv:
                    header_dict[fk] = fv["value"]
                else:
                    header_dict[fk] = fv

        if not goal_text and "goal" in header_dict:
            goal_text = str(header_dict["goal"])

        task_payload = {
            "id": id,
            "short_title": node.get("short_title") or node.get("short") or node.get("title", ""),
            "title": node.get("title", ""),
            "state": node.get("canonical_state") or node.get("state", "open"),
            "header": header_dict,
            "goal": goal_text,
            "steps": steps_text,
            "verification": verification_text,
            "children": list(node.get("children", [])),
            "attachments": list(node.get("attachments", [])),
            "hash": node.get("task_hash") or node.get("bundle_sha256") or "",
            "path": node.get("rel_path") or str(file_path),
        }

        return make_tool_result({"ok": True, "task": task_payload})

    server.tool(name="tasks.show")(_handle_tasks_show)

    # 6. tasks.next
    async def _handle_tasks_next(
        workspace: str,
        project: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> CallToolResult:
        tasks_dirs: list[pathlib.Path] = []
        if project:
            td, err = await resolve_project_tasks_dir(workspace, project, config_dir)
            if err or not td:
                return make_error_result("project-not-found" if "Project" in (err or "") else "workspace-not-found", err or "Tasks dir resolution failed")
            tasks_dirs.append(td)
        else:
            rc, data, _, _ = await run_ai_orch_cli(["projects", "list", workspace, "--json"], config_dir)
            ws_path, _, ws_err = await resolve_workspace_info(workspace, config_dir)
            if ws_err or not ws_path:
                return make_error_result("workspace-not-found", ws_err or "Workspace not found")
            if rc == 0 and data and data.get("ok"):
                for pr in data.get("items", []):
                    p_path = pr.get("path", ".")
                    cand = (ws_path / p_path / "tasks").resolve() if p_path != "." else (ws_path / "tasks")
                    if cand.is_dir() and (cand / "00-INDEX.md").is_file():
                        tasks_dirs.append(cand)
            if not tasks_dirs:
                cand = ws_path / "tasks"
                if cand.is_dir() and (cand / "00-INDEX.md").is_file():
                    tasks_dirs.append(cand)

        raw_items: list[dict[str, Any]] = []
        for td in tasks_dirs:
            rc, data, _, _ = await run_ai_orch_cli(["tasks", "next", "--tasks-dir", str(td), "--json"], config_dir)
            if rc == 0 and data and data.get("ok"):
                ready_tasks = data.get("tasks", [])
                for t in ready_tasks:
                    row: dict[str, Any] = {
                        "id": t["id"],
                        "short_title": t.get("short_title") or t.get("short") or t.get("title", ""),
                        "title": t.get("title", ""),
                        "state": t.get("canonical_state") or t.get("state", "open"),
                        "priority": t.get("priority", "P2"),
                        "kind": t.get("kind", "task"),
                        "depends_on": list(t.get("depends_on", [])),
                        "hash": t.get("task_hash") or t.get("bundle_sha256") or t.get("hash", ""),
                    }
                    if t.get("size"):
                        row["size"] = t["size"]
                    if t.get("parent"):
                        row["parent"] = t["parent"]
                    raw_items.append(row)

        paged_items, next_cursor, truncated = paginate_items(
            raw_items,
            cursor=cursor,
            limit=limit,
        )
        resp: dict[str, Any] = {"ok": True, "items": paged_items}
        if next_cursor:
            resp["next_cursor"] = next_cursor
        if truncated:
            resp["truncated"] = True
        return make_tool_result(resp)

    server.tool(name="tasks.next")(_handle_tasks_next)

    # 7. tasks.graph
    async def _handle_tasks_graph(workspace: str, project: str) -> CallToolResult:
        tasks_dir, err = await resolve_project_tasks_dir(workspace, project, config_dir)
        if err or not tasks_dir:
            return make_error_result("project-not-found" if "Project" in (err or "") else "workspace-not-found", err or "Tasks dir resolution failed")

        rc, data, stdout, stderr = await run_ai_orch_cli(["tasks", "graph", "--tasks-dir", str(tasks_dir), "--json"], config_dir)
        if rc != 0 or not data or not data.get("ok"):
            return make_error_result("tasks-graph-failed", (data.get("error") if data else None) or stderr or stdout or "tasks graph failed")

        nodes = [
            {
                "id": n["id"],
                "short_title": n.get("short_title") or n.get("short") or n.get("title", ""),
                "state": n.get("canonical_state") or n.get("state", "open"),
                "column": n.get("column"),
            }
            for n in data.get("nodes", [])
        ]
        edges = [[e["from"], e["to"]] for e in data.get("edges", [])]
        ready = data.get("ready_queue", [])

        return make_tool_result({
            "ok": True,
            "nodes": nodes,
            "edges": edges,
            "ready": ready,
        })

    server.tool(name="tasks.graph")(_handle_tasks_graph)

    # 8. tasks.new
    async def _handle_tasks_new(
        workspace: str,
        project: str,
        title: str,
        short: str,
        goal: str,
        category: str | None = None,
        priority: str | None = None,
        priority_reason: str | None = None,
        kind: str | None = None,
        parent: str | None = None,
        idempotency_key: str | None = None,
        expect_hash: str | None = None,
        preview: bool = False,
    ) -> CallToolResult:
        tasks_dir, err = await resolve_project_tasks_dir(workspace, project, config_dir)
        if err or not tasks_dir:
            return make_error_result("project-not-found" if "Project" in (err or "") else "workspace-not-found", err or "Tasks dir resolution failed")

        cat = category or "feature"
        prio = priority or "P2"
        p_reason = priority_reason or f"Task: {title}"

        if preview:
            return make_tool_result({
                "ok": True,
                "preview": True,
                "action": "create_task",
                "title": title,
                "short": short,
                "goal": goal,
                "category": cat,
                "priority": prio,
                "parent": parent,
            })

        cli_args = [
            "tasks", "new",
            "--tasks-dir", str(tasks_dir),
            "--title", title,
            "--short", short,
            "--goal", goal,
            "--category", cat,
            "--priority", prio,
            "--priority-reason", p_reason,
            "--json",
        ]
        if parent:
            cli_args.extend(["--parent", parent])
        if idempotency_key:
            cli_args.extend(["--idempotency-key", idempotency_key])

        rc, data, stdout, stderr = await run_ai_orch_cli(cli_args, config_dir)
        if rc != 0 or not data or not data.get("ok"):
            err_code = (data.get("error") if data else None) or "tasks-new-failed"
            err_msg = (data.get("message") if data else None) or stderr or stdout or "tasks new failed"
            return make_error_result(err_code, err_msg)

        t_id = data["id"]
        rel_path = data.get("rel_path") or data.get("file_path", "")

        rc_l, data_l, _, _ = await run_ai_orch_cli(["tasks", "list", "--tasks-dir", str(tasks_dir), "--json"], config_dir)
        t_hash = ""
        if rc_l == 0 and data_l and "tree" in data_l:
            t_hash = data_l["tree"].get(t_id, {}).get("task_hash", "")
        if not t_hash:
            target_file = tasks_dir / rel_path
            if target_file.is_file():
                t_hash = hashlib.sha256(target_file.read_bytes()).hexdigest()

        return make_tool_result({
            "ok": True,
            "id": t_id,
            "hash": t_hash,
            "path": rel_path,
        })

    server.tool(name="tasks.new")(_handle_tasks_new)

    # 9. tasks.transition
    async def _handle_tasks_transition(
        workspace: str,
        project: str,
        id: str,
        to: str,
        note: str | None = None,
        idempotency_key: str | None = None,
        expect_hash: str | None = None,
        preview: bool = False,
    ) -> CallToolResult:
        tasks_dir, err = await resolve_project_tasks_dir(workspace, project, config_dir)
        if err or not tasks_dir:
            return make_error_result("project-not-found" if "Project" in (err or "") else "workspace-not-found", err or "Tasks dir resolution failed")

        rc_l, data_l, _, _ = await run_ai_orch_cli(["tasks", "list", "--tasks-dir", str(tasks_dir), "--json"], config_dir)
        current_state = "open"
        current_hash = ""
        if rc_l == 0 and data_l and "tree" in data_l and id in data_l["tree"]:
            current_state = data_l["tree"][id].get("canonical_state") or data_l["tree"][id].get("state", "open")
            current_hash = data_l["tree"][id].get("task_hash") or data_l["tree"][id].get("bundle_sha256", "")

        if expect_hash and current_hash and expect_hash != current_hash:
            return make_error_result("task-hash-mismatch", f"Task hash '{current_hash}' does not match expect_hash '{expect_hash}'")

        if preview:
            return make_tool_result({
                "ok": True,
                "preview": True,
                "id": id,
                "from": current_state,
                "to": to,
            })

        cli_args = [
            "tasks", "transition",
            id, to,
            "--tasks-dir", str(tasks_dir),
            "--json",
        ]
        if note:
            cli_args.extend(["--reason", note])
        if expect_hash:
            cli_args.extend(["--expect-task-hash", expect_hash])
        if idempotency_key:
            cli_args.extend(["--idempotency-key", idempotency_key])

        rc, data, stdout, stderr = await run_ai_orch_cli(cli_args, config_dir)
        if rc != 0 or not data or not data.get("ok"):
            err_code = (data.get("error") if data else None) or "transition-failed"
            err_msg = (data.get("message") if data else None) or stderr or stdout or "Transition failed"
            return make_error_result(err_code, err_msg)

        res_hash = data.get("bundle_sha256") or data.get("task_hash", "")
        if not res_hash:
            rc_l2, data_l2, _, _ = await run_ai_orch_cli(["tasks", "list", "--tasks-dir", str(tasks_dir), "--json"], config_dir)
            if rc_l2 == 0 and data_l2 and "tree" in data_l2 and id in data_l2["tree"]:
                res_hash = data_l2["tree"][id].get("task_hash") or data_l2["tree"][id].get("bundle_sha256", "")

        return make_tool_result({
            "ok": True,
            "id": id,
            "from": data.get("old_state") or current_state,
            "to": data.get("new_state") or to,
            "hash": res_hash,
        })

    server.tool(name="tasks.transition")(_handle_tasks_transition)

    # 10. tasks.set
    async def _handle_tasks_set(
        workspace: str,
        project: str,
        id: str,
        field: str,
        value: Any,
        idempotency_key: str | None = None,
        expect_hash: str | None = None,
        preview: bool = False,
    ) -> CallToolResult:
        tasks_dir, err = await resolve_project_tasks_dir(workspace, project, config_dir)
        if err or not tasks_dir:
            return make_error_result("project-not-found" if "Project" in (err or "") else "workspace-not-found", err or "Tasks dir resolution failed")

        valid_fields = {"priority", "size", "deps", "kind", "labels", "short"}
        field_clean = field.strip().lower()
        if field_clean not in valid_fields:
            return make_error_result("invalid-field", f"Field '{field}' is invalid; must be one of {', '.join(sorted(valid_fields))}")

        cli_subcmd = f"set-{field_clean}"
        cli_args = ["tasks", cli_subcmd, id]

        if field_clean in ("priority", "size", "kind", "short"):
            cli_args.append(str(value))
        elif field_clean == "deps":
            if isinstance(value, list):
                cli_args.extend(["--to", *[str(x) for x in value]])
            else:
                cli_args.extend(["--to", *[x.strip() for x in str(value).split(",") if x.strip()]])
        elif field_clean == "labels":
            if isinstance(value, list):
                cli_args.extend(["--to", *[str(x) for x in value]])
            else:
                cli_args.extend(["--to", *[x.strip() for x in str(value).split(",") if x.strip()]])

        cli_args.extend(["--tasks-dir", str(tasks_dir), "--json"])
        if expect_hash:
            cli_args.extend(["--expect-task-hash", expect_hash])
        if idempotency_key:
            cli_args.extend(["--idempotency-key", idempotency_key])
        if preview:
            cli_args.append("--dry-run")

        rc, data, stdout, stderr = await run_ai_orch_cli(cli_args, config_dir)
        if rc != 0 or not data or not data.get("ok"):
            err_code = (data.get("error") if data else None) or f"{cli_subcmd}-failed"
            err_msg = (data.get("message") if data else None) or stderr or stdout or f"Command {cli_subcmd} failed"
            return make_error_result(err_code, err_msg)

        resp: dict[str, Any] = {
            "ok": True,
            "id": id,
            "field": field_clean,
            "value": value,
            "hash": data.get("task_hash") or data.get("bundle_sha256") or data.get("hash", ""),
        }
        if preview:
            resp["preview"] = True
            if data.get("diff"):
                resp["diff"] = data["diff"]
        return make_tool_result(resp)

    server.tool(name="tasks.set")(_handle_tasks_set)

    # 11. questions.list
    async def _handle_questions_list(
        workspace: str,
        project: str | None = None,
        status: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> CallToolResult:
        tasks_dirs: list[pathlib.Path] = []
        if project:
            tasks_dir, err = await resolve_project_tasks_dir(workspace, project, config_dir)
            if err or not tasks_dir:
                return make_error_result("project-not-found" if "Project" in (err or "") else "workspace-not-found", err or "Tasks dir resolution failed")
            tasks_dirs.append(tasks_dir)
        else:
            rc, data, _, _ = await run_ai_orch_cli(["projects", "list", workspace, "--json"], config_dir)
            ws_path, _, ws_err = await resolve_workspace_info(workspace, config_dir)
            if ws_err or not ws_path:
                return make_error_result("workspace-not-found", ws_err or "Workspace not found")
            if rc == 0 and data and data.get("ok"):
                for pr in data.get("items", []):
                    p_path = pr.get("path", ".")
                    cand = (ws_path / p_path / "tasks").resolve() if p_path != "." else (ws_path / "tasks")
                    if cand.is_dir() and (cand / "00-INDEX.md").is_file():
                        tasks_dirs.append(cand)
            if not tasks_dirs:
                cand = ws_path / "tasks"
                if cand.is_dir() and (cand / "00-INDEX.md").is_file():
                    tasks_dirs.append(cand)

        raw_items: list[dict[str, Any]] = []
        seen_ids: set[str] = set()

        for td in tasks_dirs:
            cli_args = ["questions", "list", "--tasks-dir", str(td), "--json"]
            if status:
                cli_args.extend(["--status", status])

            rc, data, stdout, stderr = await run_ai_orch_cli(cli_args, config_dir)
            if rc != 0 or not data or not data.get("ok"):
                if project:
                    return make_error_result("questions-list-failed", (data.get("error") if data else None) or stderr or stdout or "questions list failed")
                continue

            raw_questions = data.get("questions", [])
            for q in raw_questions:
                qid = q["id"]
                if qid in seen_ids:
                    continue
                seen_ids.add(qid)
                blocks_list: list[str] = []
                if q.get("blocks_parsed"):
                    blocks_list = [b[0] for b in q["blocks_parsed"] if b and b[0]]
                elif q.get("blocks") and q.get("blocks") != "-":
                    blocks_list = [b.split()[0].strip() for b in q["blocks"].split(",") if b.strip()]

                raw_items.append({
                    "id": qid,
                    "short_title": q.get("short_title") or q.get("short") or q.get("title") or qid,
                    "question": q["question"],
                    "status": q.get("status", "open"),
                    "blocks": blocks_list,
                    "decider": q.get("decider", "owner"),
                })

        paged_items, next_cursor, truncated = paginate_items(
            raw_items,
            cursor=cursor,
            limit=limit,
        )
        resp: dict[str, Any] = {"ok": True, "items": paged_items}
        if next_cursor:
            resp["next_cursor"] = next_cursor
        if truncated:
            resp["truncated"] = True
        return make_tool_result(resp)

    server.tool(name="questions.list")(_handle_questions_list)

    # 12. questions.ask
    async def _handle_questions_ask(
        workspace: str,
        project: str,
        question: str,
        short: str,
        context: str,
        options: list[dict[str, str]],
        recommended: str | None = None,
        blocks: list[str] | str | None = None,
        idempotency_key: str | None = None,
        expect_hash: str | None = None,
        preview: bool = False,
    ) -> CallToolResult:
        tasks_dir, err = await resolve_project_tasks_dir(workspace, project, config_dir)
        if err or not tasks_dir:
            return make_error_result("project-not-found" if "Project" in (err or "") else "workspace-not-found", err or "Tasks dir resolution failed")

        if preview:
            return make_tool_result({
                "ok": True,
                "preview": True,
                "action": "ask_question",
                "question": question,
                "short": short,
            })

        cli_args = [
            "questions", "ask",
            "--tasks-dir", str(tasks_dir),
            "--question", question,
            "--short", short,
            "--context", context,
            "--json",
        ]
        for opt in options:
            lbl = opt.get("label", "A")
            cq = opt.get("consequences") or opt.get("title") or ""
            cli_args.extend(["--option", f"{lbl}={cq}"])
        blocks_str = "-"
        if blocks:
            if isinstance(blocks, list):
                blocks_str = ", ".join(blocks) if blocks else "-"
            else:
                blocks_str = str(blocks).strip() or "-"
        cli_args.extend(["--blocks", blocks_str])
        if recommended:
            cli_args.extend(["--recommended", recommended])
        else:
            cli_args.extend(["--recommended", "-"])
        if idempotency_key:
            cli_args.extend(["--idempotency-key", idempotency_key])

        rc, data, stdout, stderr = await run_ai_orch_cli(cli_args, config_dir)
        if rc != 0 or not data or not data.get("ok"):
            err_code = (data.get("error") if data else None) or "questions-ask-failed"
            err_msg = (data.get("message") if data else None) or stderr or stdout or "questions ask failed"
            return make_error_result(err_code, err_msg)

        q_id = data["id"]
        file_path = data.get("file_path") or (tasks_dir / data.get("rel_path", ""))
        q_hash = ""
        if pathlib.Path(file_path).is_file():
            q_hash = hashlib.sha256(pathlib.Path(file_path).read_bytes()).hexdigest()

        return make_tool_result({
            "ok": True,
            "id": q_id,
            "hash": q_hash,
        })

    server.tool(name="questions.ask")(_handle_questions_ask)

    # 13. questions.answer
    async def _handle_questions_answer(
        workspace: str,
        project: str,
        id: str,
        choice: str,
        text: str | None = None,
        idempotency_key: str | None = None,
        expect_hash: str | None = None,
        preview: bool = False,
    ) -> CallToolResult:
        tasks_dir, err = await resolve_project_tasks_dir(workspace, project, config_dir)
        if err or not tasks_dir:
            return make_error_result("project-not-found" if "Project" in (err or "") else "workspace-not-found", err or "Tasks dir resolution failed")

        q_file = None
        q_dir = tasks_dir / "questions"
        if q_dir.is_dir():
            for f in q_dir.glob(f"{id}*.md"):
                q_file = f
                break

        current_hash = ""
        if q_file and q_file.is_file():
            current_hash = hashlib.sha256(q_file.read_bytes()).hexdigest()

        if expect_hash and current_hash and expect_hash != current_hash:
            return make_error_result("question-hash-mismatch", f"Question hash '{current_hash}' does not match expect_hash '{expect_hash}'")

        if preview:
            return make_tool_result({
                "ok": True,
                "preview": True,
                "id": id,
                "choice": choice,
            })

        cli_args = [
            "questions", "answer",
            id,
            "--choice", choice,
            "--tasks-dir", str(tasks_dir),
            "--json",
        ]
        if text:
            cli_args.extend(["--text", text])
        if idempotency_key:
            cli_args.extend(["--idempotency-key", idempotency_key])

        rc, data, stdout, stderr = await run_ai_orch_cli(cli_args, config_dir)
        if rc != 0 or not data or not data.get("ok"):
            err_code = (data.get("error") if data else None) or "questions-answer-failed"
            err_msg = (data.get("message") if data else None) or stderr or stdout or "questions answer failed"
            return make_error_result(err_code, err_msg)

        new_hash = ""
        if q_file and q_file.is_file():
            new_hash = hashlib.sha256(q_file.read_bytes()).hexdigest()

        resp: dict[str, Any] = {
            "ok": True,
            "id": id,
            "unblocked": data.get("unblocked_tasks", []),
        }
        if new_hash:
            resp["hash"] = new_hash
        return make_tool_result(resp)

    server.tool(name="questions.answer")(_handle_questions_answer)

    # 14. inbox.add_note
    async def _handle_inbox_add_note(
        workspace: str,
        project: str,
        title: str,
        body: str,
        kind: str | None = None,
        idempotency_key: str | None = None,
        expect_hash: str | None = None,
        preview: bool = False,
    ) -> CallToolResult:
        tasks_dir, err = await resolve_project_tasks_dir(workspace, project, config_dir)
        if err or not tasks_dir:
            return make_error_result("project-not-found" if "Project" in (err or "") else "workspace-not-found", err or "Tasks dir resolution failed")

        if preview:
            return make_tool_result({
                "ok": True,
                "preview": True,
                "title": title,
                "kind": kind or "note",
            })

        cli_args = [
            "inbox", "add",
            "--tasks-dir", str(tasks_dir),
            "--title", title,
            "--body", body,
            "--json",
        ]
        if kind:
            cli_args.extend(["--kind", kind])
        if idempotency_key:
            cli_args.extend(["--idempotency-key", idempotency_key])

        rc, data, stdout, stderr = await run_ai_orch_cli(cli_args, config_dir)
        if rc != 0 or not data or not data.get("ok"):
            err_code = (data.get("error") if data else None) or "inbox-add-failed"
            err_msg = (data.get("message") if data else None) or stderr or stdout or "inbox add failed"
            return make_error_result(err_code, err_msg)

        rel_path = data.get("rel_path") or data.get("file_path", "")
        note_hash = ""
        target_file = tasks_dir / rel_path
        if target_file.is_file():
            note_hash = hashlib.sha256(target_file.read_bytes()).hexdigest()

        resp: dict[str, Any] = {
            "ok": True,
            "id": data["id"],
            "path": rel_path,
        }
        if note_hash:
            resp["hash"] = note_hash
        return make_tool_result(resp)

    server.tool(name="inbox.add_note")(_handle_inbox_add_note)

    # 15. orchestrator.status
    async def _handle_orchestrator_status(workspace: str) -> CallToolResult:
        ws_path, _, err = await resolve_workspace_info(workspace, config_dir)
        if err or not ws_path:
            return make_error_result("workspace-not-found", err or "Workspace not found")

        rc, data, stdout, stderr = await run_ai_orch_cli(["orchestrator", "status", "--workspace", str(ws_path), "--json"], config_dir)
        if rc != 0 or not data:
            return make_tool_result({
                "ok": True,
                "state": "missing",
                "queue_length": 0,
                "worker": {"alive": False},
                "unread_mail": 0,
            })

        state_val = data.get("status") or "missing"
        tool_val = data.get("tool")
        model_val = data.get("model")
        generation_val = data.get("generation")
        queue_len = data.get("queue", {}).get("queued", 0)

        worker_dict: dict[str, Any] = {"alive": False}
        worker_file = ws_path / ".ai-orchestration" / "orchestrator" / "worker.json"
        if worker_file.is_file():
            try:
                w_data = json.loads(worker_file.read_text(encoding="utf-8"))
                if "alive" in w_data:
                    worker_dict["alive"] = bool(w_data["alive"])
                if "heartbeat_at" in w_data and w_data["heartbeat_at"]:
                    worker_dict["heartbeat_at"] = w_data["heartbeat_at"]
            except Exception:
                pass

        resp: dict[str, Any] = {
            "ok": True,
            "state": state_val,
            "queue_length": queue_len,
            "worker": worker_dict,
            "unread_mail": 0,
        }
        if tool_val:
            resp["tool"] = tool_val
        if model_val:
            resp["model"] = model_val
        if generation_val is not None:
            resp["generation"] = generation_val

        return make_tool_result(resp)

    server.tool(name="orchestrator.status")(_handle_orchestrator_status)

    # Spike compat tools
    async def _handle_debug_sleep(seconds: int = 1) -> CallToolResult:
        if seconds < 0 or seconds > 120:
            return make_error_result("invalid-argument", f"seconds must be between 0 and 120, got {seconds}")
        await asyncio.sleep(seconds)
        return CallToolResult(content=[TextContent(type="text", text=_apply_notice(f"Slept for {seconds} seconds"))], is_error=False)

    server.tool(name="debug_sleep")(_handle_debug_sleep)
    server.tool(name="debug.sleep")(_handle_debug_sleep)

    return server


async def serve_async(
    port: int | None = None,
    host: str = "127.0.0.1",
    config_dir: pathlib.Path | None = None,
) -> None:
    global _broker_started_at
    if config_dir is None:
        config_dir = get_broker_config_dir()
    lock_handle = acquire_broker_lock(config_dir)

    if port is None or port == 0:
        port = find_free_port()

    _broker_started_at = datetime.now(timezone.utc).isoformat()
    token = get_or_create_token(config_dir)
    token_file = config_dir / "ui-token"
    write_broker_json(config_dir, port, token_file)

    server = create_broker_server(config_dir)
    sec = TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
        allowed_hosts=["*"],
        allowed_origins=["*"],
    )
    starlette_app = server.streamable_http_app(
        transport_security=sec,
        streamable_http_path="/mcp",
    )
    app = BrokerTokenAuthMiddleware(starlette_app, token)

    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level="info",
    )
    uv_server = uvicorn.Server(config)

    def cleanup() -> None:
        try:
            target = config_dir / "broker.json"
            if target.is_file():
                content = json.loads(target.read_text(encoding="utf-8"))
                if content.get("pid") == os.getpid():
                    target.unlink(missing_ok=True)
        except Exception:
            pass
        if hasattr(lock_handle, "release"):
            try:
                lock_handle.release()
            except Exception:
                pass
        elif isinstance(lock_handle, int):
            try:
                fcntl.flock(lock_handle, fcntl.LOCK_UN)
                os.close(lock_handle)
            except OSError:
                pass

    try:
        await uv_server.serve()
    finally:
        cleanup()


def serve(
    port: int | None = None,
    host: str = "127.0.0.1",
    config_dir: pathlib.Path | None = None,
) -> None:
    asyncio.run(serve_async(port=port, host=host, config_dir=config_dir))
