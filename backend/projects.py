"""Project resolution, identity, caching, and tree discovery for multi-project workspaces.

Implements §1 and §2 of tasks/specs/ui-multi-project.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import logging
import os
import pathlib
import re
import sqlite3
import subprocess
from typing import Any, Callable

logger = logging.getLogger("orchestration_projects")

EXCLUDE_DIR_NAMES = {
    "node_modules",
    "build",
    "dist",
    "target",
    "venv",
    ".venv",
    "scratch",
    "fixtures",
    "references",
}


@dataclass
class ProjectInfo:
    id: str  # Slug identifier (e.g. "iam", "_workspace")
    path: str  # Relative path to workspace root (e.g. ".", "d4science-python-iam")
    kind: str  # "project" | "_workspace" | "sub_workspace"
    root: pathlib.Path  # Absolute path to project root
    tasks_dir: pathlib.Path  # Absolute path to tasks directory
    uuid: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "path": self.path,
            "kind": self.kind,
            "uuid": self.uuid,
        }


class UnknownProjectError(Exception):
    """Raised when a requested project ID is not found."""


class ProjectRequiredError(Exception):
    """Raised when an operation requires an explicit project ID in a multi-project workspace."""


class OutsideWorkspaceError(Exception):
    """Raised when a project root or path escapes the bound workspace root."""


def sanitize_slug(name: str) -> str:
    """Derive a valid slug matching ^[a-z0-9][a-z0-9-]{1,47}$."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not slug:
        slug = "workspace"
    elif len(slug) == 1:
        slug = f"{slug}-1"
    if not re.match(r"^[a-z0-9]", slug):
        slug = f"ws-{slug}"
    if len(slug) > 48:
        slug = slug[:48].rstrip("-")
    if len(slug) < 2:
        slug = f"{slug}0"
    return slug


def _git_repo_root(path: pathlib.Path) -> pathlib.Path | None:
    """Nearest enclosing git repository root of path (the folder itself included), or None."""
    for cand in [path, *path.parents]:
        if (cand / ".git").exists():
            return cand
    return None


def is_git_ignored(path: pathlib.Path, ws_path: pathlib.Path) -> bool:
    """Check whether path is ignored by git, asked of the repository that owns it."""
    try:
        if (path / ".git").exists():
            return False
        repo = _git_repo_root(path)
        if repo is None:
            return False
        rel = path.relative_to(repo)
        proc = subprocess.run(
            ["git", "check-ignore", "-q", str(rel)],
            cwd=str(repo),
            capture_output=True,
            check=False,
        )
        return proc.returncode == 0
    except Exception:
        return False


def compute_tree_hash(tasks_dir: pathlib.Path) -> str:
    """Compute a fast deterministic hash of the tasks directory contents for cache invalidation."""
    if not tasks_dir.is_dir():
        return ""
    h = hashlib.sha256()
    entries: list[tuple[str, int, int]] = []
    try:
        for root, dirs, files in os.walk(str(tasks_dir)):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for f in files:
                if f.endswith(".md") or f.endswith(".json"):
                    fp = pathlib.Path(root) / f
                    try:
                        st = fp.stat()
                        entries.append((str(fp.relative_to(tasks_dir)), st.st_mtime_ns, st.st_size))
                    except OSError:
                        pass
        entries.sort()
        for rel, mtime, size in entries:
            h.update(f"{rel}:{mtime}:{size}\n".encode("utf-8"))
    except Exception:
        pass
    return h.hexdigest()


CANONICAL_COUNT_STATES: tuple[str, ...] = (
    "open",
    "in progress",
    "waiting",
    "blocked",
    "paused",
    "bounced",
    "delivered",
    "verified",
    "done",
    "dropped",
)


def canonicalize_task_state(raw_state: str | None) -> str:
    if not raw_state:
        return "open"
    s = str(raw_state).strip().lower()
    s = re.sub(r"\s*\(\d{4}-\d{2}-\d{2}\)$", "", s).strip("`").strip()
    s_norm = s.replace("_", " ").replace("-", " ")
    if s_norm in ("open", "todo", "draft"):
        return "open"
    if s_norm in ("in progress", "doing", "started"):
        return "in progress"
    if s_norm in ("waiting", "wait"):
        return "waiting"
    if s_norm in ("blocked", "block"):
        return "blocked"
    if s_norm in ("paused", "pause"):
        return "paused"
    if s_norm in ("bounced", "bounce"):
        return "bounced"
    if s_norm in ("delivered", "deliver"):
        return "delivered"
    if s_norm in ("verified", "verify"):
        return "verified"
    if s_norm in ("done", "done with a caveat", "completed", "closed"):
        return "done"
    if s_norm in ("dropped", "drop", "abandoned", "cancelled"):
        return "dropped"
    return s_norm


def count_tasks_by_canonical_state(tasks: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {st: 0 for st in CANONICAL_COUNT_STATES}
    counts["total"] = 0
    for t in tasks:
        raw_st = t.get("canonical_state") or t.get("state")
        cst = canonicalize_task_state(raw_st)
        if cst in counts:
            counts[cst] += 1
        counts["total"] += 1
    return counts


def fast_count_project_tasks(tasks_dir: pathlib.Path) -> dict[str, int]:
    counts: dict[str, int] = {st: 0 for st in CANONICAL_COUNT_STATES}
    counts["total"] = 0
    return counts


def fast_count_questions(tasks_dir: pathlib.Path) -> int:
    q_dir = tasks_dir / "questions"
    if not q_dir.is_dir():
        return 0
    count = 0
    try:
        for root, dirs, files in os.walk(str(q_dir)):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("answered", "withdrawn")]
            for f in files:
                if f.endswith(".md"):
                    count += 1
    except Exception:
        pass
    return count


def fast_count_inbox(tasks_dir: pathlib.Path) -> int:
    inbox_dir = tasks_dir / "_inbox"
    if not inbox_dir.is_dir():
        return 0
    count = 0
    try:
        for root, dirs, files in os.walk(str(inbox_dir)):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("resolved", "discarded")]
            for f in files:
                if f.endswith(".md"):
                    count += 1
    except Exception:
        pass
    return count


class ProjectResolver:
    def __init__(self, workspace: pathlib.Path, config_dir: pathlib.Path | None = None, ai_orch_bin: pathlib.Path | None = None):
        self.workspace = workspace.resolve()
        self.config_dir = config_dir
        self.ai_orch_bin = ai_orch_bin

        # Cache of parsed projects: (ws_path, mtime) -> (mode, projects, sub_workspaces)
        self._cached_ws_path: pathlib.Path | None = None
        self._cached_mode: str = "single"
        self._cached_projects: list[ProjectInfo] = []
        self._cached_sub_workspaces: list[dict[str, Any]] = []

        # Tree hash caches for aggregate data
        self._tasks_cache: dict[tuple[str, str], list[dict[str, Any]]] = {}
        self._counts_cache: dict[tuple[str, str], dict[str, int]] = {}

    async def load_project_tasks(self, proj: ProjectInfo, run_ai_orch_fn: Callable) -> list[dict[str, Any]]:
        th = compute_tree_hash(proj.tasks_dir)
        cache_key = (str(proj.tasks_dir), th)
        if cache_key in self._tasks_cache:
            return self._tasks_cache[cache_key]

        if not proj.tasks_dir.is_dir():
            self._tasks_cache[cache_key] = []
            return []

        cmd = ["tasks", "list", "--tasks-dir", str(proj.tasks_dir), "--json"]
        code, data = await run_ai_orch_fn(cmd)
        tasks: list[dict[str, Any]] = []
        if code == 0 and isinstance(data, dict):
            tasks = data.get("all_tasks") or data.get("tasks") or []
            # Merge coordinates from emergent_tasks or tree if not present on all_tasks items
            emergent_map = {
                et["id"]: et.get("coordinates")
                for et in (data.get("emergent_tasks") or [])
                if isinstance(et, dict) and et.get("id") and et.get("coordinates")
            }
            tree_map = {
                nid: n.get("coordinates")
                for nid, n in (data.get("tree") or {}).items()
                if isinstance(n, dict) and n.get("coordinates")
            }
            for t in tasks:
                tid = t.get("id")
                if not t.get("coordinates"):
                    if tid in emergent_map and emergent_map[tid]:
                        t["coordinates"] = emergent_map[tid]
                    elif tid in tree_map and tree_map[tid]:
                        t["coordinates"] = tree_map[tid]
        self._tasks_cache[cache_key] = tasks
        return tasks

    async def get_project_counts(self, proj: ProjectInfo, run_ai_orch_fn: Callable) -> dict[str, int]:
        th = compute_tree_hash(proj.tasks_dir)
        cache_key = (str(proj.tasks_dir), th)
        if cache_key in self._counts_cache:
            return self._counts_cache[cache_key]

        tasks = await self.load_project_tasks(proj, run_ai_orch_fn)
        counts = count_tasks_by_canonical_state(tasks)
        self._counts_cache[cache_key] = counts
        return counts

    async def count_open_questions(self, proj: ProjectInfo, run_ai_orch_fn: Callable) -> int:
        if not proj.tasks_dir.is_dir():
            return 0
        cmd = ["questions", "list", "--tasks-dir", str(proj.tasks_dir), "--status", "open", "--json"]
        code, data = await run_ai_orch_fn(cmd)
        if code == 0 and isinstance(data, dict):
            qs = data.get("questions") or data.get("items") or []
            return len(qs)
        return 0

    async def count_open_inbox(self, proj: ProjectInfo, run_ai_orch_fn: Callable) -> int:
        if not proj.tasks_dir.is_dir():
            return 0
        cmd = ["inbox", "list", "--tasks-dir", str(proj.tasks_dir), "--status", "open", "--json"]
        code, data = await run_ai_orch_fn(cmd)
        if code == 0 and isinstance(data, dict):
            notes = data.get("notes") or data.get("items") or []
            return len(notes)
        return 0

    def update_workspace(self, workspace: pathlib.Path, config_dir: pathlib.Path | None = None, ai_orch_bin: pathlib.Path | None = None) -> None:
        new_ws = workspace.resolve()
        if new_ws != self.workspace:
            self.workspace = new_ws
            self.invalidate()
        if config_dir is not None:
            self.config_dir = config_dir
        if ai_orch_bin is not None:
            self.ai_orch_bin = ai_orch_bin

    def invalidate(self) -> None:
        self._cached_ws_path = None
        self._cached_projects = []
        self._cached_sub_workspaces = []

    def get_workspace_info(self) -> tuple[str, list[ProjectInfo], list[dict[str, Any]]]:
        if self._cached_ws_path == self.workspace and self._cached_projects:
            return self._cached_mode, list(self._cached_projects), list(self._cached_sub_workspaces)

        mode, projects, sub_workspaces = self._resolve_workspace()
        self._cached_ws_path = self.workspace
        self._cached_mode = mode
        self._cached_projects = projects
        self._cached_sub_workspaces = sub_workspaces
        return mode, list(projects), list(sub_workspaces)

    def get_projects(self) -> list[ProjectInfo]:
        _, projects, _ = self.get_workspace_info()
        return projects

    def get_mode(self) -> str:
        mode, _, _ = self.get_workspace_info()
        return mode

    def resolve_project(self, project_id: str | None = None) -> ProjectInfo:
        """Resolve project_id to ProjectInfo.

        Without project_id: returns the single project if there is exactly one, else raises ProjectRequiredError.
        With project_id: returns matching project or raises UnknownProjectError.
        Validates that project root is inside workspace root.
        """
        _, projects, _ = self.get_workspace_info()

        if project_id is None or not project_id.strip():
            if len(projects) == 1:
                proj = projects[0]
                self._verify_inside_workspace(proj)
                return proj
            raise ProjectRequiredError("project-required")

        req_id = project_id.strip()

        # If single project, allow matching by slug, _workspace, or folder name
        if len(projects) == 1:
            p = projects[0]
            allowed_aliases = {p.id, "_workspace", self.workspace.name, sanitize_slug(self.workspace.name), "."}
            if req_id in allowed_aliases:
                self._verify_inside_workspace(p)
                return p

        for p in projects:
            if p.id == req_id:
                self._verify_inside_workspace(p)
                return p

        raise UnknownProjectError("unknown-project")

    def _verify_inside_workspace(self, proj: ProjectInfo) -> None:
        try:
            proj.root.resolve().relative_to(self.workspace.resolve())
        except ValueError:
            raise OutsideWorkspaceError("outside-workspace-root")

    def project_root(self, project_id: str | None = None) -> pathlib.Path:
        return self.resolve_project(project_id).root

    def tasks_dir(self, project_id: str | None = None) -> pathlib.Path:
        return self.resolve_project(project_id).tasks_dir

    def _resolve_workspace(self) -> tuple[str, list[ProjectInfo], list[dict[str, Any]]]:
        ws_path = self.workspace

        # Step 1: Registered workspace
        reg_result = self._try_registered_workspace(ws_path)
        if reg_result is not None:
            return reg_result

        # Step 2: Read-only discovery
        disc_result = self._try_discovered_workspace(ws_path)
        if disc_result is not None:
            return disc_result

        # Step 3: Single plain project folder (backward compatible)
        return self._single_plain_project(ws_path)

    def _try_registered_workspace(self, ws_path: pathlib.Path) -> tuple[str, list[ProjectInfo], list[dict[str, Any]]] | None:
        """Try resolving workspace via registered SQLite DB or ai-orch CLI."""
        # Check SQLite DB first (instant, robust)
        db_path = self._get_db_path()
        if db_path.is_file():
            try:
                conn = sqlite3.connect(db_path, timeout=1.0)
                conn.row_factory = sqlite3.Row
                try:
                    cpath_str = str(ws_path.resolve())
                    row = conn.execute(
                        "SELECT * FROM workspaces WHERE canonical_path = ?", (cpath_str,)
                    ).fetchone()
                    if row:
                        ws_uuid = row["uuid"]
                        # Fetch explicit projects
                        proj_rows = conn.execute(
                            "SELECT uuid, slug, rel_path FROM projects WHERE workspace_uuid = ? ORDER BY slug ASC",
                            (ws_uuid,),
                        ).fetchall()

                        # Sub-workspaces (other registered workspaces inside ws_path)
                        other_ws = conn.execute(
                            "SELECT uuid, slug, canonical_path FROM workspaces WHERE uuid != ?", (ws_uuid,)
                        ).fetchall()
                        sub_workspaces: list[dict[str, Any]] = []
                        inner_paths: list[pathlib.Path] = []
                        for ow in other_ws:
                            ow_p = pathlib.Path(ow["canonical_path"]).resolve()
                            if ws_path in ow_p.parents:
                                sub_workspaces.append({
                                    "uuid": ow["uuid"],
                                    "slug": ow["slug"],
                                    "path": str(ow_p.relative_to(ws_path)),
                                    "kind": "sub_workspace",
                                })
                                inner_paths.append(ow_p)

                        projects: list[ProjectInfo] = []
                        has_workspace_slug = False
                        for pr in proj_rows:
                            slug = pr["slug"]
                            if slug == "_workspace":
                                has_workspace_slug = True
                                kind = "_workspace"
                            else:
                                kind = "project"
                            rel_p = pr["rel_path"] or "."
                            p_root = (ws_path / rel_p).resolve()
                            projects.append(ProjectInfo(
                                id=slug,
                                path=rel_p,
                                kind=kind,
                                root=p_root,
                                tasks_dir=p_root / "tasks",
                                uuid=pr["uuid"],
                            ))

                        # Plus _workspace if <root>/tasks/00-INDEX.md exists (or <root>/tasks exists)
                        if not has_workspace_slug and ((ws_path / "tasks" / "00-INDEX.md").is_file() or (ws_path / "tasks").is_dir()):
                            projects.insert(0, ProjectInfo(
                                id="_workspace",
                                path=".",
                                kind="_workspace",
                                root=ws_path,
                                tasks_dir=ws_path / "tasks",
                            ))

                        # If sub_workspaces exist, add them as read-only projects
                        for sw in sub_workspaces:
                            sw_p = (ws_path / sw["path"]).resolve()
                            projects.append(ProjectInfo(
                                id=sw["slug"],
                                path=sw["path"],
                                kind="sub_workspace",
                                root=sw_p,
                                tasks_dir=sw_p / "tasks",
                                uuid=sw["uuid"],
                            ))

                        return "registered", projects, sub_workspaces
                finally:
                    conn.close()
            except Exception as e:
                logger.debug("SQLite registry lookup failed: %s", e)

        # Fallback to CLI if SQLite check didn't match
        if self.ai_orch_bin and self.ai_orch_bin.is_file():
            try:
                cmd = [str(self.ai_orch_bin), "projects", "list", str(ws_path), "--json"]
                if self.config_dir:
                    cmd.extend(["--config-dir", str(self.config_dir)])
                proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
                if proc.returncode == 0:
                    data = json.loads(proc.stdout)
                    if data.get("ok"):
                        items = data.get("items", [])
                        projects = []
                        sub_workspaces = []
                        has_workspace_slug = False
                        for item in items:
                            kind = item.get("kind", "project")
                            slug = item.get("slug")
                            rel_p = item.get("path") or "."
                            p_root = (ws_path / rel_p).resolve()
                            if kind == "sub_workspace":
                                sub_workspaces.append({
                                    "uuid": item.get("uuid"),
                                    "slug": slug,
                                    "path": rel_p,
                                    "kind": "sub_workspace",
                                })
                            else:
                                if slug == "_workspace":
                                    has_workspace_slug = True
                                projects.append(ProjectInfo(
                                    id=slug,
                                    path=rel_p,
                                    kind=kind,
                                    root=p_root,
                                    tasks_dir=p_root / "tasks",
                                    uuid=item.get("uuid"),
                                ))

                        if not has_workspace_slug and ((ws_path / "tasks" / "00-INDEX.md").is_file() or (ws_path / "tasks").is_dir()):
                            projects.insert(0, ProjectInfo(
                                id="_workspace",
                                path=".",
                                kind="_workspace",
                                root=ws_path,
                                tasks_dir=ws_path / "tasks",
                            ))
                        return "registered", projects, sub_workspaces
            except Exception as e:
                logger.debug("CLI projects list failed: %s", e)

        return None

    def _try_discovered_workspace(self, ws_path: pathlib.Path) -> tuple[str, list[ProjectInfo], list[dict[str, Any]]] | None:
        """Discover candidate folders with tasks/00-INDEX.md or tasks/ directory respecting exclusions."""
        candidate_folders: list[pathlib.Path] = []

        # Root tasks candidate
        root_has_tasks = (ws_path / "tasks" / "00-INDEX.md").is_file() or (ws_path / "tasks").is_dir()
        if root_has_tasks:
            candidate_folders.append(ws_path)

        for root, dirs, _ in os.walk(str(ws_path)):
            # Prune hidden dirs and excluded dirs in-place
            dirs[:] = [
                d for d in dirs
                if not d.startswith(".") and d not in EXCLUDE_DIR_NAMES
            ]

            for d in list(dirs):
                folder_p = (pathlib.Path(root) / d).resolve()

                # Skip kilo worktree or similar
                if any(part in (".kilo", "worktrees") for part in folder_p.parts):
                    dirs.remove(d)
                    continue

                if is_git_ignored(folder_p, ws_path):
                    dirs.remove(d)
                    continue

                if (folder_p / "tasks" / "00-INDEX.md").is_file() or (folder_p / "tasks").is_dir():
                    candidate_folders.append(folder_p)

        # Inner folders (excluding ws_path itself)
        inner_candidates = [f for f in candidate_folders if f != ws_path]

        # If there are inner candidate projects, this is discovered multi-project mode
        if inner_candidates:
            used_slugs: set[str] = set()
            projects: list[ProjectInfo] = []

            # Deterministic sorting: root first if present, then sorted by path
            sorted_candidates = sorted(candidate_folders, key=lambda p: (0 if p == ws_path else 1, str(p)))

            for folder in sorted_candidates:
                if folder == ws_path:
                    p_id = "_workspace"
                    rel_p = "."
                    kind = "_workspace"
                else:
                    rel_p = str(folder.relative_to(ws_path))
                    raw_slug = sanitize_slug(folder.name)
                    p_id = raw_slug
                    suffix = 2
                    while p_id in used_slugs:
                        p_id = f"{raw_slug}-{suffix}"
                        suffix += 1
                    kind = "project"

                used_slugs.add(p_id)
                projects.append(ProjectInfo(
                    id=p_id,
                    path=rel_p,
                    kind=kind,
                    root=folder,
                    tasks_dir=folder / "tasks",
                ))

            return "discovered", projects, []

        return None

    def _single_plain_project(self, ws_path: pathlib.Path) -> tuple[str, list[ProjectInfo], list[dict[str, Any]]]:
        """Single plain project folder (Case 3, fully backward compatible)."""
        slug = sanitize_slug(ws_path.name)
        proj = ProjectInfo(
            id=slug,
            path=".",
            kind="project",
            root=ws_path,
            tasks_dir=ws_path / "tasks",
        )
        return "single", [proj], []

    def _get_db_path(self) -> pathlib.Path:
        if self.config_dir:
            return self.config_dir / "broker" / "registry.sqlite"
        if "AI_ORCHESTRATION_CONFIG" in os.environ and os.environ["AI_ORCHESTRATION_CONFIG"].strip():
            p = pathlib.Path(os.environ["AI_ORCHESTRATION_CONFIG"]).expanduser().resolve()
            cfg_dir = p.parent if (p.is_file() or p.suffix == ".toml") else p
            return cfg_dir / "broker" / "registry.sqlite"
        if "AI_ORCH_CONFIG_DIR" in os.environ and os.environ["AI_ORCH_CONFIG_DIR"].strip():
            return pathlib.Path(os.environ["AI_ORCH_CONFIG_DIR"]).expanduser().resolve() / "broker" / "registry.sqlite"
        if "AI_ORCH_HOME" in os.environ and os.environ["AI_ORCH_HOME"].strip():
            return (pathlib.Path(os.environ["AI_ORCH_HOME"]).expanduser() / ".config" / "ai-orchestration" / "broker" / "registry.sqlite").resolve()
        return pathlib.Path.home() / ".config" / "ai-orchestration" / "broker" / "registry.sqlite"
