#!/usr/bin/env python3
"""Registry-first tmux orchestrator CLI.

This CLI is the deterministic lifecycle layer used by the Matelink
Orchestrator Agent. It creates/reuses tmux run windows, manages worker panes,
writes durable run/agent registries, dispatches Pi CLI workers, and derives
status from registry + DONE files + tmux liveness.

Stdout is reserved for machine-readable JSON. Diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
MEMORY_DIR = Path(".Agent_ChatRoom") / "Orchestrator agent memory"
DEFAULT_SESSION = "mat-orch"
DONE_STATUSES = {"done", "blocked", "failed"}


class OrchError(RuntimeError):
    def __init__(self, message: str, *, code: str = "error", details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_run_id(run_id: str) -> str:
    run_id = run_id.strip()
    if run_id.startswith("RUN-"):
        run_id = run_id[4:]
    if not run_id:
        raise OrchError("run_id must not be empty", code="invalid_run_id")
    if "/" in run_id or "\x00" in run_id:
        raise OrchError(f"invalid run_id: {run_id!r}", code="invalid_run_id")
    return run_id


def run_dir_for(run_id: str) -> Path:
    return MEMORY_DIR / f"RUN-{normalize_run_id(run_id)}"


def json_out(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def warn(message: str) -> None:
    print(message, file=sys.stderr)


def tmux_required() -> None:
    if shutil.which("tmux") is None:
        raise OrchError("tmux is required but was not found on PATH", code="tmux_missing")


def tmux(args: list[str], *, check: bool = True, timeout: int = 10) -> subprocess.CompletedProcess[str]:
    tmux_required()
    proc = subprocess.run(
        ["tmux", *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    if check and proc.returncode != 0:
        raise OrchError(
            f"tmux {' '.join(args)} failed: {proc.stderr.strip() or proc.stdout.strip()}",
            code="tmux_failed",
            details={"args": args, "returncode": proc.returncode, "stderr": proc.stderr.strip()},
        )
    return proc


def tmux_ok(args: list[str]) -> bool:
    return tmux(args, check=False).returncode == 0


def sanitize_tmux_name(value: str) -> str:
    value = re.sub(r"[\r\n:\t]+", "-", value.strip())
    value = re.sub(r"\s+", "-", value)
    return (value or "orch-run")[:80]


def current_tmux_session() -> str | None:
    if not os.environ.get("TMUX"):
        return None
    proc = tmux(["display-message", "-p", "#{session_name}"], check=False)
    if proc.returncode == 0 and proc.stdout.strip():
        return proc.stdout.strip()
    return None


def session_exists(session: str) -> bool:
    return tmux_ok(["has-session", "-t", session])


def window_index_by_name(session: str, window_name: str) -> str | None:
    proc = tmux(["list-windows", "-t", session, "-F", "#{window_index}\t#{window_name}"], check=False)
    if proc.returncode != 0:
        return None
    for line in proc.stdout.splitlines():
        try:
            index, name = line.split("\t", 1)
        except ValueError:
            continue
        if name == window_name:
            return index
    return None


def ensure_run_dirs(run_dir: Path) -> None:
    for child in [run_dir, run_dir / "agents", run_dir / "dispatch", run_dir / "reports"]:
        child.mkdir(parents=True, exist_ok=True)


def read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, dict) else None
    except Exception as exc:  # noqa: BLE001 - convert to CLI diagnostic
        raise OrchError(f"invalid JSON at {path}: {exc}", code="invalid_json", details={"path": str(path)}) from exc


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def pane_alive(target: str | None) -> bool:
    if not target:
        return False
    proc = tmux(["display-message", "-t", target, "-p", "#{pane_id}"], check=False)
    return proc.returncode == 0 and bool(proc.stdout.strip())


def canonical_pane_id(target: str) -> str:
    proc = tmux(["display-message", "-t", target, "-p", "#{pane_id}"], check=False)
    return proc.stdout.strip() if proc.returncode == 0 and proc.stdout.strip() else target


def get_run(run_id: str) -> dict[str, Any]:
    run_id = normalize_run_id(run_id)
    path = run_dir_for(run_id) / "run.json"
    data = read_json(path)
    if not data:
        raise OrchError(f"run not found: {run_id}", code="run_not_found", details={"run_json": str(path)})
    return data


def run_create(args: argparse.Namespace) -> int:
    run_id = normalize_run_id(args.run_id)
    title = args.title or f"orch-{run_id}"
    window_name = sanitize_tmux_name(title)
    run_dir = run_dir_for(run_id)
    ensure_run_dirs(run_dir)

    session = current_tmux_session() or os.environ.get("MAT_ORCH_SESSION", DEFAULT_SESSION)
    cwd = str(Path.cwd())

    if not session_exists(session):
        tmux(["new-session", "-d", "-s", session, "-n", window_name, "-c", cwd])
        index = window_index_by_name(session, window_name) or "0"
    else:
        index = window_index_by_name(session, window_name)
        if index is None:
            proc = tmux(["new-window", "-d", "-t", session, "-n", window_name, "-c", cwd, "-P", "-F", "#{window_index}"])
            index = proc.stdout.strip()

    tmux_target = f"{session}:{index}"
    run_json_path = run_dir / "run.json"
    existing = read_json(run_json_path) or {}
    created_at = existing.get("created_at") if isinstance(existing.get("created_at"), str) else now_iso()
    payload = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "title": title,
        "status": existing.get("status", "active"),
        "tmux_session": session,
        "tmux_target": tmux_target,
        "window_name": window_name,
        "run_dir": str(run_dir),
        "agents_dir": str(run_dir / "agents"),
        "dispatch_dir": str(run_dir / "dispatch"),
        "reports_dir": str(run_dir / "reports"),
        "created_at": created_at,
        "updated_at": now_iso(),
    }
    write_json_atomic(run_json_path, payload)
    json_out({"ok": True, "action": "run.create", "run": payload, "run_json": str(run_json_path)})
    return 0


def agent_registry_path(run_id: str, agent_id: str) -> Path:
    return run_dir_for(run_id) / "agents" / f"{agent_id}.json"


def load_agent(run_id: str, agent_id: str) -> dict[str, Any] | None:
    return read_json(agent_registry_path(run_id, agent_id))


def split_worker_pane(run_target: str, pane_name: str, pct: int) -> str:
    if pct < 10 or pct > 90:
        raise OrchError("--size must be between 10 and 90", code="invalid_size")
    if not pane_alive(run_target):
        raise OrchError(f"run tmux target is not alive: {run_target}", code="run_target_dead")
    width = int(tmux(["display-message", "-t", run_target, "-p", "#{pane_width}"]).stdout.strip())
    height = int(tmux(["display-message", "-t", run_target, "-p", "#{pane_height}"]).stdout.strip())
    split_flag = "-h" if width > height * 2 else "-v"
    size = max(1, (width if split_flag == "-h" else height) * pct // 100)
    proc = tmux(["split-window", split_flag, "-t", run_target, "-l", str(size), "-c", str(Path.cwd()), "-P", "-F", "#{pane_id}"])
    pane_id = proc.stdout.strip()
    tmux(["select-pane", "-t", pane_id, "-T", pane_name], check=False)
    tmux(["select-layout", "-t", pane_id, "tiled"], check=False)
    return pane_id


def write_agent_registry(
    run: dict[str, Any],
    agent_id: str,
    assigned_agent: str,
    pane_id: str,
    status: str,
    dispatch_path: str | None = None,
    done_path: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    run_id = normalize_run_id(str(run["run_id"]))
    path = agent_registry_path(run_id, agent_id)
    existing = read_json(path) or {}
    created_at = existing.get("created_at") if isinstance(existing.get("created_at"), str) else now_iso()
    payload: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "agent_id": agent_id,
        "assigned_agent": assigned_agent,
        "status": status,
        "tmux_target": pane_id,
        "pane_id": pane_id,
        "target": pane_id,
        "dispatch_path": dispatch_path if dispatch_path is not None else existing.get("dispatch_path"),
        "done_path": done_path if done_path is not None else existing.get("done_path"),
        "created_at": created_at,
        "updated_at": now_iso(),
    }
    if extra:
        payload.update(extra)
    write_json_atomic(path, payload)
    return payload


def worker_create(args: argparse.Namespace) -> int:
    run = get_run(args.run_id)
    run_id = normalize_run_id(str(run["run_id"]))
    agent_id = args.agent_id
    assigned_agent = args.assigned_agent or agent_id
    existing = load_agent(run_id, agent_id)
    reused = False
    if existing and pane_alive(str(existing.get("pane_id") or existing.get("target") or existing.get("tmux_target") or "")):
        pane_id = str(existing.get("pane_id") or existing.get("target") or existing.get("tmux_target"))
        reused = True
    else:
        pane_id = split_worker_pane(str(run["tmux_target"]), agent_id, int(args.size))
    dispatch_path = str(default_dispatch_path(run_id, agent_id))
    done_path = str(default_done_path(run_id, agent_id))
    registry = write_agent_registry(run, agent_id, assigned_agent, pane_id, "registered", dispatch_path, done_path)
    json_out({"ok": True, "action": "worker.create", "reused": reused, "run_id": run_id, "agent": registry, "registry_path": str(agent_registry_path(run_id, agent_id))})
    return 0


def default_dispatch_path(run_id: str, agent_id: str) -> Path:
    return run_dir_for(run_id) / "dispatch" / f"{agent_id}.md"


def default_done_path(run_id: str, agent_id: str) -> Path:
    return run_dir_for(run_id) / "reports" / f"{agent_id}.DONE.md"


def ensure_worker(run: dict[str, Any], agent_id: str, assigned_agent: str | None = None, size: int = 40) -> dict[str, Any]:
    run_id = normalize_run_id(str(run["run_id"]))
    entry = load_agent(run_id, agent_id)
    if entry and pane_alive(str(entry.get("pane_id") or entry.get("target") or entry.get("tmux_target") or "")):
        return entry
    pane_id = split_worker_pane(str(run["tmux_target"]), agent_id, size)
    return write_agent_registry(run, agent_id, assigned_agent or agent_id, pane_id, "registered")


def capture(target: str, lines: int = 20) -> str:
    proc = tmux(["capture-pane", "-t", target, "-p", "-S", f"-{lines}"], check=False)
    return proc.stdout if proc.returncode == 0 else ""


def wait_for_pi_ready(target: str, timeout_sec: int = 30) -> bool:
    deadline = time.time() + timeout_sec
    ready = re.compile(r"(0\.0%/|Cursor|Update Available|/agent|Welcome|Pi)", re.IGNORECASE)
    while time.time() < deadline:
        if ready.search(capture(target, 20)):
            return True
        time.sleep(2)
    return False


def send_keys(target: str, value: str, *, literal: bool = False, enter: bool = True) -> None:
    if literal:
        tmux(["send-keys", "-t", target, "-l", value])
        if enter:
            tmux(["send-keys", "-t", target, "Enter"])
    else:
        parts = ["send-keys", "-t", target, value]
        if enter:
            parts.append("Enter")
        tmux(parts)


def worker_dispatch(args: argparse.Namespace) -> int:
    run = get_run(args.run_id)
    run_id = normalize_run_id(str(run["run_id"]))
    agent_id = args.agent_id
    entry = ensure_worker(run, agent_id)
    pane_id = str(entry.get("pane_id") or entry.get("target") or entry.get("tmux_target"))
    assigned_agent = str(entry.get("assigned_agent") or agent_id)
    dispatch_path = str(Path(args.dispatch) if args.dispatch else default_dispatch_path(run_id, agent_id))
    done_path = str(Path(args.done) if args.done else default_done_path(run_id, agent_id))

    # Persist dispatch metadata before mutating the pane, so status tooling has a durable record.
    entry = write_agent_registry(run, agent_id, assigned_agent, pane_id, "dispatching", dispatch_path, done_path)

    send_keys(pane_id, "mpi")
    ready = wait_for_pi_ready(pane_id, timeout_sec=30)
    if not ready:
        warn(f"Pi CLI readiness was not confirmed for {pane_id}; continuing best-effort.")
    send_keys(pane_id, f"/agent {assigned_agent}")
    time.sleep(2)

    instruction = (
        f"请读取 {dispatch_path} 并执行；完成后写入 {done_path} 。"
        "DONE 报告必须包含：run_id、agent_id、status(done|blocked|failed)、summary、"
        "changed_files、tests、findings、next_action、completed_at。"
    )
    send_keys(pane_id, instruction, literal=True)
    entry = write_agent_registry(run, agent_id, assigned_agent, pane_id, "dispatched", dispatch_path, done_path, {"dispatched_at": now_iso(), "pi_ready_confirmed": ready})
    json_out({"ok": True, "action": "worker.dispatch", "run_id": run_id, "agent": entry, "pi_ready_confirmed": ready})
    return 0


def parse_done(done_path: str | None) -> dict[str, Any]:
    if not done_path:
        return {"exists": False, "valid": False, "status": "unknown", "path": None, "error": "missing done_path"}
    path = Path(done_path)
    if not path.exists():
        return {"exists": False, "valid": False, "status": "unknown", "path": str(path)}
    try:
        content = path.read_text(encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        return {"exists": True, "valid": False, "status": "unknown", "path": str(path), "error": str(exc)}
    fields: dict[str, str] = {}
    for line in content.splitlines():
        m = re.match(r"^\s*-\s*([A-Za-z_][\w-]*)\s*:\s*(.*)\s*$", line)
        if m:
            fields[m.group(1).lower().replace("-", "_")] = m.group(2).strip()
    raw_status = fields.get("status", "").lower()
    valid = raw_status in DONE_STATUSES
    return {
        "exists": True,
        "valid": valid,
        "status": raw_status if raw_status else "unknown",
        "path": str(path),
        "fields": fields,
        "error": None if valid else f"invalid or missing status: {raw_status or '<missing>'}",
    }


def derive_agent_state(entry: dict[str, Any]) -> dict[str, Any]:
    target = str(entry.get("pane_id") or entry.get("target") or entry.get("tmux_target") or "")
    alive = pane_alive(target) if target else False
    done = parse_done(str(entry.get("done_path")) if entry.get("done_path") else None)
    if done["exists"] and done["valid"]:
        state = done["status"]
    elif done["exists"] and not done["valid"]:
        state = "unknown"
    elif target and not alive:
        state = "crashed"
    else:
        reg = str(entry.get("status") or "registered")
        state = "registered" if reg == "registered" else "running"
    return {"state": state, "tmux": {"target": target or None, "alive": alive}, "done": done}


def list_agent_entries(run_id: str) -> list[dict[str, Any]]:
    agents_dir = run_dir_for(run_id) / "agents"
    entries: list[dict[str, Any]] = []
    if not agents_dir.exists():
        return entries
    for path in sorted(agents_dir.glob("*.json")):
        data = read_json(path)
        if data:
            data["registry_path"] = str(path)
            entries.append(data)
    return entries


def worker_status(args: argparse.Namespace) -> int:
    run = get_run(args.run_id)
    run_id = normalize_run_id(str(run["run_id"]))
    if args.agent_id:
        entry = load_agent(run_id, args.agent_id)
        if not entry:
            raise OrchError(f"worker not found: {args.agent_id}", code="worker_not_found")
        entry["registry_path"] = str(agent_registry_path(run_id, args.agent_id))
        entries = [entry]
    else:
        entries = list_agent_entries(run_id)
    agents = []
    for entry in entries:
        derived = derive_agent_state(entry)
        agents.append({**entry, **derived})
    json_out({"ok": True, "action": "worker.status", "run_id": run_id, "run": run, "agents": agents})
    return 0


def worker_wait(args: argparse.Namespace) -> int:
    run = get_run(args.run_id)
    run_id = normalize_run_id(str(run["run_id"]))
    deadline = time.time() + float(args.timeout)
    last_snapshot: dict[str, Any] | None = None
    while True:
        entry = load_agent(run_id, args.agent_id)
        if not entry:
            raise OrchError(f"worker not found: {args.agent_id}", code="worker_not_found")
        derived = derive_agent_state(entry)
        last_snapshot = {**entry, **derived}
        if derived["done"]["exists"] and derived["done"]["valid"]:
            json_out({"ok": True, "action": "worker.wait", "run_id": run_id, "agent": last_snapshot})
            return 0
        if derived["state"] == "crashed":
            json_out({"ok": False, "action": "worker.wait", "run_id": run_id, "agent": last_snapshot, "error": "worker pane is dead before DONE"})
            return 1
        if time.time() >= deadline:
            json_out({"ok": False, "action": "worker.wait", "run_id": run_id, "agent": last_snapshot, "error": "timeout"})
            return 1
        time.sleep(2)


def worker_stop(args: argparse.Namespace) -> int:
    run = get_run(args.run_id)
    run_id = normalize_run_id(str(run["run_id"]))
    entry = load_agent(run_id, args.agent_id)
    if not entry:
        raise OrchError(f"worker not found: {args.agent_id}", code="worker_not_found")
    pane_id = str(entry.get("pane_id") or entry.get("target") or entry.get("tmux_target") or "")
    if not pane_id or not pane_alive(pane_id):
        entry["status"] = "stopped"
        entry["updated_at"] = now_iso()
        write_json_atomic(agent_registry_path(run_id, args.agent_id), entry)
        json_out({"ok": True, "action": "worker.stop", "run_id": run_id, "agent": {**entry, **derive_agent_state(entry)}, "sent": False})
        return 0
    tmux(["send-keys", "-t", pane_id, "C-c"], check=False)
    time.sleep(0.3)
    if not args.no_message:
        send_keys(pane_id, "暂停当前任务，等待 Orchestrator 新指令。不要继续修改文件。", literal=True)
    entry = write_agent_registry(run, args.agent_id, str(entry.get("assigned_agent") or args.agent_id), pane_id, "stopped", str(entry.get("dispatch_path") or ""), str(entry.get("done_path") or ""), {"stopped_at": now_iso()})
    json_out({"ok": True, "action": "worker.stop", "run_id": run_id, "agent": {**entry, **derive_agent_state(entry)}, "sent": True})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="orch", description="Matelink registry-first tmux orchestrator CLI")
    sub = parser.add_subparsers(dest="group", required=True)

    run_p = sub.add_parser("run", help="run lifecycle commands")
    run_sub = run_p.add_subparsers(dest="command", required=True)
    run_create_p = run_sub.add_parser("create", help="create/reuse a tmux run window and run registry")
    run_create_p.add_argument("run_id")
    run_create_p.add_argument("--title", default=None)
    run_create_p.set_defaults(func=run_create)

    worker_p = sub.add_parser("worker", help="worker pane/dispatch/status commands")
    worker_sub = worker_p.add_subparsers(dest="command", required=True)

    create_p = worker_sub.add_parser("create", help="create/reuse a worker pane and registry entry")
    create_p.add_argument("run_id")
    create_p.add_argument("agent_id")
    create_p.add_argument("--assigned-agent", default=None)
    create_p.add_argument("--size", type=int, default=40, help="split size percentage, 10-90")
    create_p.set_defaults(func=worker_create)

    dispatch_p = worker_sub.add_parser("dispatch", help="start mpi, switch agent, send dispatch instruction")
    dispatch_p.add_argument("run_id")
    dispatch_p.add_argument("agent_id")
    dispatch_p.add_argument("--dispatch", default=None)
    dispatch_p.add_argument("--done", default=None)
    dispatch_p.set_defaults(func=worker_dispatch)

    wait_p = worker_sub.add_parser("wait", help="poll DONE and tmux liveness for one worker")
    wait_p.add_argument("run_id")
    wait_p.add_argument("agent_id")
    wait_p.add_argument("--timeout", type=int, default=300)
    wait_p.set_defaults(func=worker_wait)

    status_p = worker_sub.add_parser("status", help="derive worker status from registry + DONE + tmux")
    status_p.add_argument("run_id")
    status_p.add_argument("agent_id", nargs="?")
    status_p.set_defaults(func=worker_status)

    stop_p = worker_sub.add_parser("stop", help="safely nudge a worker to pause/stop")
    stop_p.add_argument("run_id")
    stop_p.add_argument("agent_id")
    stop_p.add_argument("--no-message", action="store_true", help="only send Ctrl-C, do not send a pause message")
    stop_p.set_defaults(func=worker_stop)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except OrchError as exc:
        warn(str(exc))
        json_out({"ok": False, "error": {"code": exc.code, "message": str(exc), **exc.details}})
        return 1
    except subprocess.TimeoutExpired as exc:
        warn(f"command timed out: {exc}")
        json_out({"ok": False, "error": {"code": "timeout", "message": str(exc)}})
        return 1
    except KeyboardInterrupt:
        warn("interrupted")
        json_out({"ok": False, "error": {"code": "interrupted", "message": "interrupted"}})
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
