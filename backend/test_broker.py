"""Unit tests for the AI Orchestration Broker and stdio shim (Task 16.1 spike)."""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import time

import pytest

from backend.broker.server import (
    acquire_broker_lock,
    create_broker_server,
    get_broker_config_dir,
    get_or_create_token,
    serve_async,
)
import backend.broker.server as broker_server
from backend.broker.shim import ensure_broker, read_broker_json


@pytest.fixture
def tmp_config_dir(tmp_path, monkeypatch):
    cfg_dir = tmp_path / "config"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("AI_ORCHESTRATION_CONFIG", str(cfg_dir))
    return cfg_dir


class ShimClient:
    def __init__(self, config_dir: pathlib.Path):
        ui_root = pathlib.Path(__file__).resolve().parent.parent
        venv_python = ui_root / ".venv" / "bin" / "python"
        py_exe = str(venv_python) if venv_python.is_file() else sys.executable
        env = os.environ.copy()
        env["AI_ORCHESTRATION_CONFIG"] = str(config_dir)
        self.proc = subprocess.Popen(
            [py_exe, str(ui_root / "backend" / "broker" / "shim.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(ui_root),
            env=env,
        )

    def send(self, req: dict) -> dict:
        line = json.dumps(req) + "\n"
        self.proc.stdin.write(line.encode("utf-8"))
        self.proc.stdin.flush()
        resp_line = self.proc.stdout.readline().decode("utf-8").strip()
        assert resp_line, "Received empty response from shim"
        return json.loads(resp_line)

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()


def _cleanup_broker_process(config_dir: pathlib.Path):
    info = read_broker_json(config_dir)
    if info and "pid" in info:
        try:
            os.kill(int(info["pid"]), signal.SIGTERM)
            time.sleep(0.1)
        except OSError:
            pass


def test_broker_singleton(tmp_config_dir):
    """1. Broker singleton: second serve exits with a clear message."""
    ui_root = pathlib.Path(__file__).resolve().parent.parent
    venv_python = ui_root / ".venv" / "bin" / "python"
    py_exe = str(venv_python) if venv_python.is_file() else sys.executable
    env = os.environ.copy()
    env["AI_ORCHESTRATION_CONFIG"] = str(tmp_config_dir)

    proc1 = subprocess.Popen(
        [py_exe, "-m", "backend.broker", "serve"],
        cwd=str(ui_root),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        # Wait for broker 1 to become ready
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            info = read_broker_json(tmp_config_dir)
            if info and "pid" in info:
                break
            time.sleep(0.05)

        info = read_broker_json(tmp_config_dir)
        assert info is not None, "Broker 1 failed to write broker.json"
        assert info["pid"] == proc1.pid

        # Attempt to start a second broker with the same config dir
        proc2 = subprocess.Popen(
            [py_exe, "-m", "backend.broker", "serve"],
            cwd=str(ui_root),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        stdout2, stderr2 = proc2.communicate(timeout=5.0)

        assert proc2.returncode != 0, "Second broker serve must exit with non-zero code"
        err_msg = (stderr2.decode("utf-8") + stdout2.decode("utf-8")).lower()
        assert "already running" in err_msg or "locked" in err_msg, (
            f"Expected 'already running' or 'locked' message in: {err_msg}"
        )
    finally:
        proc1.terminate()
        try:
            proc1.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            proc1.kill()
            proc1.wait()


def test_shim_initialize_answered_before_broker_up(tmp_config_dir):
    """2. Shim initialize answered before the broker is up."""
    # Ensure no broker is running
    assert not (tmp_config_dir / "broker.json").exists()

    shim = ShimClient(tmp_config_dir)
    try:
        init_req = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "test-client", "version": "1.0"},
            },
        }
        res = shim.send(init_req)
        assert res.get("id") == 1
        assert "result" in res
        result = res["result"]
        assert result.get("protocolVersion") == "2024-11-05"
        assert result.get("serverInfo", {}).get("name") == "ai-orchestration-broker-shim"
        assert "capabilities" in result
        assert "tools" in result["capabilities"]
    finally:
        shim.close()
        _cleanup_broker_process(tmp_config_dir)


def test_two_shims_concurrent_start_one_broker(tmp_config_dir):
    """3. Two shims started concurrently -> exactly one broker process."""
    shim1 = ShimClient(tmp_config_dir)
    shim2 = ShimClient(tmp_config_dir)
    try:
        # Initialize both shims
        init_req1 = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}
        init_req2 = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}
        res1 = shim1.send(init_req1)
        res2 = shim2.send(init_req2)
        assert res1.get("id") == 1
        assert res2.get("id") == 1

        # Send tools/list to both concurrently
        def call_shim(s: ShimClient, req_id: int):
            return s.send({"jsonrpc": "2.0", "id": req_id, "method": "tools/list", "params": {}})

        with ThreadPoolExecutor(max_workers=2) as executor:
            fut1 = executor.submit(call_shim, shim1, 2)
            fut2 = executor.submit(call_shim, shim2, 2)
            t_res1 = fut1.result(timeout=10.0)
            t_res2 = fut2.result(timeout=10.0)

        assert "result" in t_res1
        assert "result" in t_res2
        tool_names1 = [t["name"] for t in t_res1["result"].get("tools", [])]
        tool_names2 = [t["name"] for t in t_res2["result"].get("tools", [])]
        assert "whoami" in tool_names1
        assert "whoami" in tool_names2

        # Check whoami on both shims to verify same broker PID
        w_res1 = shim1.send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "whoami", "arguments": {}}})
        w_res2 = shim2.send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "whoami", "arguments": {}}})

        text1 = w_res1["result"]["content"][0]["text"]
        text2 = w_res2["result"]["content"][0]["text"]
        data1 = json.loads(text1)
        data2 = json.loads(text2)

        assert data1["pid"] == data2["pid"], f"Expected same broker PID, got {data1['pid']} and {data2['pid']}"

        # Verify only one broker.json exists with that PID
        binfo = read_broker_json(tmp_config_dir)
        assert binfo is not None
        assert binfo["pid"] == data1["pid"]
    finally:
        shim1.close()
        shim2.close()
        _cleanup_broker_process(tmp_config_dir)


def test_tools_callable_through_shim(tmp_config_dir):
    """4. Tools callable through the shim (drive the shim with raw JSON-RPC over its stdin/stdout)."""
    shim = ShimClient(tmp_config_dir)
    try:
        shim.send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}})

        # 4a. tools/list
        res_list = shim.send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tools = res_list["result"]["tools"]
        names = {t["name"] for t in tools}
        assert "whoami" in names
        assert "tasks_list" in names
        assert "debug_sleep" in names

        # 4b. whoami tool call
        res_whoami = shim.send({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "whoami", "arguments": {}},
        })
        assert not res_whoami["result"].get("isError")
        whoami_data = json.loads(res_whoami["result"]["content"][0]["text"])
        assert "pid" in whoami_data
        assert whoami_data["version"] == "0.1.0"
        assert str(tmp_config_dir) in whoami_data["config_dir"]

        # 4c. debug_sleep tool call
        t0 = time.monotonic()
        res_sleep = shim.send({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "debug_sleep", "arguments": {"seconds": 1}},
        })
        t1 = time.monotonic()
        assert not res_sleep["result"].get("isError")
        assert "Slept for 1 seconds" in res_sleep["result"]["content"][0]["text"]
        assert t1 - t0 >= 0.8

        # 4d. tasks_list tool call with real project path
        orch_dir = pathlib.Path(__file__).resolve().parent.parent.parent.parent / "ai-orchestration"
        if (orch_dir / "tasks" / "00-INDEX.md").is_file():
            res_tasks = shim.send({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {"name": "tasks_list", "arguments": {"project_path": str(orch_dir)}},
            })
            assert not res_tasks["result"].get("isError")
            tasks_text = res_tasks["result"]["content"][0]["text"]
            assert "tasks" in json.loads(tasks_text) or "initiatives" in json.loads(tasks_text)
    finally:
        shim.close()
        _cleanup_broker_process(tmp_config_dir)


def test_broker_killed_between_calls_relaunches(tmp_config_dir):
    """5. Broker killed between calls -> shim relaunches and the call succeeds."""
    shim = ShimClient(tmp_config_dir)
    try:
        shim.send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}})

        # Initial call to start broker
        res1 = shim.send({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "whoami", "arguments": {}},
        })
        assert not res1["result"].get("isError")
        data1 = json.loads(res1["result"]["content"][0]["text"])
        pid1 = data1["pid"]

        # Kill the broker process violently
        os.kill(pid1, signal.SIGKILL)
        time.sleep(0.3)

        # Ensure port 1 is no longer responding
        port1 = read_broker_json(tmp_config_dir)["port"]
        with pytest.raises(OSError):
            socket.create_connection(("127.0.0.1", port1), timeout=0.2)

        # Next call through the SAME shim should trigger relaunch and succeed
        res2 = shim.send({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "whoami", "arguments": {}},
        })
        assert not res2["result"].get("isError")
        data2 = json.loads(res2["result"]["content"][0]["text"])
        pid2 = data2["pid"]

        assert pid2 != pid1, f"Expected a new broker process, but got same PID {pid2}"
    finally:
        shim.close()
        _cleanup_broker_process(tmp_config_dir)


def test_tasks_list_refuses_path_without_tasks(tmp_config_dir, tmp_path):
    """6. tasks_list refuses a path without tasks/."""
    server = create_broker_server(tmp_config_dir)

    # 6a. Non-existent path
    non_existent = tmp_path / "does_not_exist"
    res1 = asyncio.run(server.call_tool("tasks_list", {"project_path": str(non_existent)}))
    assert res1.is_error
    assert "does not exist" in res1.content[0].text

    # 6b. Directory without tasks/
    empty_dir = tmp_path / "empty_repo"
    empty_dir.mkdir()
    res2 = asyncio.run(server.call_tool("tasks_list", {"project_path": str(empty_dir)}))
    assert res2.is_error
    assert "does not contain a tasks/ directory" in res2.content[0].text

    # 6c. Directory with tasks/ but no 00-INDEX.md
    no_index_dir = tmp_path / "no_index_repo"
    (no_index_dir / "tasks").mkdir(parents=True)
    res3 = asyncio.run(server.call_tool("tasks_list", {"project_path": str(no_index_dir)}))
    assert res3.is_error
    assert "does not contain 00-INDEX.md" in res3.content[0].text


def test_unread_notice_appears_in_text_content(tmp_config_dir):
    """7. The notice appears in text content when hook is set."""
    server = create_broker_server(tmp_config_dir)

    # Without hook
    broker_server.unread_notice = None
    res_clean = asyncio.run(server.call_tool("whoami", {}))
    assert not res_clean.is_error
    assert "Notice:" not in res_clean.content[0].text

    # With hook set
    broker_server.unread_notice = "Notice: You have 1 unread message in your mailbox."
    try:
        res_notice = asyncio.run(server.call_tool("whoami", {}))
        assert not res_notice.is_error
        text = res_notice.content[0].text
        assert "Notice: You have 1 unread message in your mailbox." in text

        # Verify debug_sleep also includes notice
        res_sleep = asyncio.run(server.call_tool("debug_sleep", {"seconds": 0}))
        assert "Notice: You have 1 unread message in your mailbox." in res_sleep.content[0].text
    finally:
        broker_server.unread_notice = None
