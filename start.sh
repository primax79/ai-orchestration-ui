#!/usr/bin/env bash
# start.sh — Launch the AI Orchestration Web UI on http://localhost:8780
set -euo pipefail

WORKSPACE="$(cd "${1:-$PWD}" && pwd -P)"
export AI_ORCH_WORKSPACE="${WORKSPACE}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PORT="${PORT:-8780}"
HOST="${HOST:-127.0.0.1}"

if [[ -z "${PYTHON_EXE:-}" ]]; then
  if [[ -f "${SCRIPT_DIR}/../kilo-mcp/.venv/bin/python" ]]; then
    PYTHON_EXE="${SCRIPT_DIR}/../kilo-mcp/.venv/bin/python"
  elif [[ -f "${SCRIPT_DIR}/../../../../../kilo-mcp/.venv/bin/python" ]]; then
    PYTHON_EXE="${SCRIPT_DIR}/../../../../../kilo-mcp/.venv/bin/python"
  elif command -v python3 >/dev/null 2>&1 && python3 -c "import uvicorn" >/dev/null 2>&1; then
    PYTHON_EXE="python3"
  else
    PYTHON_EXE="python3"
  fi
fi

if [[ ! -d "${SCRIPT_DIR}/frontend/dist" ]]; then
  echo "==> Building frontend assets with Vite..."
  (cd "${SCRIPT_DIR}/frontend" && npm run build)
fi

echo "=========================================================="
echo "  AI Orchestration Control Plane (Web UI)"
echo "  http://${HOST}:${PORT}"
echo "  Active Workspace: ${WORKSPACE}"
echo "=========================================================="

cd "${SCRIPT_DIR}/backend"
PYTHONPATH=. exec "${PYTHON_EXE}" -m uvicorn server:app --host "${HOST}" --port "${PORT}"
