#!/usr/bin/env bash
# start.sh — Launch the AI Orchestration Web UI on http://localhost:8780
set -euo pipefail

WORKSPACE="$(cd "${1:-$PWD}" && pwd -P)"
export AI_ORCH_WORKSPACE="${WORKSPACE}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PORT="${PORT:-8780}"
HOST="${HOST:-127.0.0.1}"

if [[ -z "${PYTHON_EXE:-}" ]]; then
  if [[ -f "${SCRIPT_DIR}/.venv/bin/python" ]]; then
    PYTHON_EXE="${SCRIPT_DIR}/.venv/bin/python"
  elif [[ -f "${SCRIPT_DIR}/../kilo-mcp/.venv/bin/python" ]]; then
    PYTHON_EXE="${SCRIPT_DIR}/../kilo-mcp/.venv/bin/python"
  else
    PYTHON_EXE="python3"
  fi
fi

echo "==> Using Python interpreter: ${PYTHON_EXE}"

# websockets is mandatory: without it uvicorn silently answers /ws upgrades with HTTP 200
if ! "${PYTHON_EXE}" -c "import starlette, uvicorn, websockets" 2>/dev/null; then
  echo "error: ${PYTHON_EXE} lacks the backend dependencies (starlette, uvicorn, websockets)." >&2
  echo "       Create the UI venv: python3 -m venv ${SCRIPT_DIR}/.venv && ${SCRIPT_DIR}/.venv/bin/pip install -r ${SCRIPT_DIR}/backend/requirements.txt" >&2
  exit 1
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
