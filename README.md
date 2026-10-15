# ai-orchestration-ui

**Web UI & VS Code Webview Control Plane for [`ai-orchestration`](../ai-orchestration/).**

`ai-orchestration-ui` provides a zero-friction visual interface for managing task backlogs, installing skills/MCPs across assistants, inspecting environment drift, and configuring the project orchestrator and role profiles.

It is built as a **decoupled, embeddable architecture**:
- **In Web Mode:** A lightweight local Python backend (`backend/server.py`) powered by Starlette/Uvicorn serves the API and static bundle over `http://localhost:8765`, with WebSocket live updates whenever `tasks/` or config files change on disk.
- **In VS Code Extension Mode:** The exact same bundled frontend (`frontend/dist/`) embeds directly inside a VS Code Webview panel, communicating seamlessly via `vscode.postMessage` without rewriting a single React component (`frontend/src/api.ts`).

---

## The Four Macro-Responsibilities

```mermaid
flowchart TB
    UI["AI Orchestration UI (Web & VS Code Webview)"]
    M1["1. Task Backlog Manager<br/>• Progress Overview KPIs & Next Up Focus<br/>• Interactive Kanban Board by State<br/>• Task & Spec Editor with Validation Guards<br/>• 1-Click Handoff Prompt Copy"]
    M2["2. Skill & MCP Installer<br/>• Deploy ai-orchestration & kilo-mcp<br/>• Install across Kilo, Claude, and Codex<br/>• Provision .venv & Register MCPs"]
    M3["3. Environment Health Doctor<br/>• CLI readiness (Kilo, Claude, Codex)<br/>• Real-time Skill Drift Hash Matrix<br/>• Conflict Detection & Warning Banners"]
    M4["4. Orchestrator Configurator<br/>• Visual Editor for orchestration.toml<br/>• Cognitive Role-to-Model Matrix (4 profiles)<br/>• Live AGENTS.md Preview & 1-Click Apply"]

    CLI["CLI Engine (bin/ai-orch --json)"]

    UI --> M1 & M2 & M3 & M4
    M1 & M2 & M3 & M4 --> CLI
```

1. **Macro-Task 1 — Task Backlog & Pipeline Manager:**
   - **Progress Overview:** Live KPI counters (`open`, `in progress`, `waiting/blocked`, `delivered`, `verified`, `done`), planned initiatives breakdown, and `Next up` focus queue.
   - **Interactive Kanban Board:** Columns mapped to the formal state machine.
   - **Task Detail & Spec Editor:** Modal editor for priority (`P0`–`P3`), assignee/executor (`self`, `kilo`, `claude`, `codex`), cognitive profile, verification mode (`independent-session`, `cross-agent`, `panel`, `owner`), and action buttons (`Start`, `Mark Delivered`, `Approve Verified`, `Bounce with Feedback`, `Close Done`).
2. **Macro-Task 2 — Skill & MCP Installer:**
   - Deploy skills from `ai-orchestration` (8 core skills) and `kilo-mcp` (5 bound skills + agent) across Kilo Code, Claude Code, and Codex CLI (both `global` and `project` scope), with automatic removal of obsolete pre-rename directories.
   - Provision Python `.venv` and register `kilo-mcp` and `codex-mcp` in assistant configs.
3. **Macro-Task 3 — Environment Health & Drift Doctor:**
   - Diagnostic table showing CLI binary versions (`kilo`, `claude`, `codex`) and source repo availability.
   - Interactive matrix of installed skills per assistant with color-coded drift tags (`up-to-date`, `modified-or-outdated`, `unmanaged`) and conflict warning banners.
4. **Macro-Task 4 — Project Orchestrator Configurator:**
   - Visual editor for `orchestration.toml`: Primary Orchestrator, Default Executor (with visual badge for Single-Framework Native vs. Multi-Framework MCP), and Default Verification Policy.
   - Cognitive Profile Matrix: configure models for `deep-reasoning`, `orchestration`, `bulk-execution`, and `exploration` across Kilo, Claude, and Codex.
   - Live preview of the generated `AGENTS.md` block and one-click apply button.

---

## Quickstart (Web UI Mode)

```bash
# 1. Build frontend assets (Vite + React)
cd frontend && npm install && npm run build && cd ..

# 2. Launch the backend server (starts on http://localhost:8765)
./start.sh
```

Open `http://localhost:8765` in your browser.

---

## Tech Stack & Architecture

- **Backend:** Python 3.11+ / Starlette + Uvicorn (zero heavy dependencies), consuming `ai-orchestration/bin/ai-orch --json`.
- **Frontend:** React 18, TypeScript, Vite, Lucide Icons, pure responsive CSS.
- **State Synchronization:** WebSocket (`/ws`) provides instant live updates when files in `tasks/` or `orchestration.toml` are modified by CLI agents or git commands.
- **VS Code Compatibility:** `frontend/src/api.ts` detects `window.acquireVsCodeApi()` and seamlessly routes requests through `vscode.postMessage` when running in the extension.

## License

[MIT](LICENSE)
