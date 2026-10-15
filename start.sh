#!/usr/bin/env bash
# start.sh — Launch the AI Orchestration Web UI on http://localhost:8765
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PORT="${PORT:-8765}"
HOST="${HOST:-127.0.0.1}"
WORKSPACE="${1:-$(pwd)}"

PYTHON_EXE="${SCRIPT_DIR}/../kilo-mcp/.venv/bin/python"
if [[ ! -f "${PYTHON_EXE}" ]]; then
  PYTHON_EXE="python3"
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
