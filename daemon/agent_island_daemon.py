#!/usr/bin/env python3
"""Agent Island daemon.

Listens on a Unix socket for events from AI-agent plugins/hooks (currently
OpenCode), keeps in-memory session state and exposes it over the session D-Bus
so the GNOME Shell extension can render it. Also handles "jump to terminal"
and permission replies.
"""
import os
import sys
import json
import time
import socket
import threading
import subprocess

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

BUS_NAME = "org.agentisland.Daemon"
OBJ_PATH = "/org/agentisland/Daemon"
IFACE = "org.agentisland.Daemon"

PERMISSION_TIMEOUT = 300.0
SESSION_TTL = 12 * 3600.0


def runtime_dir():
    return os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"


SOCKET_PATH = os.path.join(runtime_dir(), "agent-island.sock")


def _read_proc(pid, sub):
    try:
        with open(f"/proc/{pid}/{sub}", "r") as fh:
            return fh.read()
    except OSError:
        return ""


def proc_name(pid):
    try:
        return _read_proc(pid, "comm").strip() or None
    except Exception:
        return None


def ancestors(pid, limit=40):
    """List of pid and its ancestors up to init."""
    out = []
    seen = set()
    cur = int(pid)
    while cur and cur > 1 and len(out) < limit:
        if cur in seen:
            break
        seen.add(cur)
        out.append(cur)
        stat = _read_proc(cur, "stat")
        try:
            cur = int(stat.rsplit(")", 1)[1].split()[1])
        except (IndexError, ValueError):
            break
    return out


def tty_of(pid):
    try:
        return os.readlink(f"/proc/{int(pid)}/fd/0")
    except OSError:
        return None


def cwd_of(pid):
    try:
        return os.readlink(f"/proc/{int(pid)}/cwd")
    except OSError:
        return None


def pids_of_tty(tty):
    out = []
    if not tty:
        return out
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            if os.readlink(f"/proc/{name}/fd/0") == tty:
                out.append(int(name))
        except OSError:
            continue
    return out


class Daemon(dbus.service.Object):
    def __init__(self, bus):
        super().__init__(bus, OBJ_PATH)
        self.sessions = {}
        self.pending = {}
        self.last_notify = None
        self.notify_seq = 0
        self.lock = threading.Lock()

    # ------------------------------------------------------------------ D-Bus
    @dbus.service.method(IFACE, in_signature="", out_signature="s")
    def GetState(self):
        return self._state_json()

    @dbus.service.method(IFACE, in_signature="i", out_signature="s")
    def Jump(self, pid):
        pid = int(pid)
        info = {"pid": pid, "ancestors": ancestors(pid), "tty": tty_of(pid),
                "tmux": False}
        info["tmux"] = self._tmux_select(info["tty"])
        return json.dumps(info)

    @dbus.service.method(IFACE, in_signature="ss", out_signature="b")
    def PermissionReply(self, request_id, reply):
        request_id = str(request_id)
        with self.lock:
            slot = self.pending.get(request_id)
            if slot is None:
                return False
            behavior = {
                "allow": "allow", "once": "allow",
                "always": "always",
                "deny": "deny", "reject": "deny",
            }.get(str(reply), str(reply))
            slot["decision"] = {
                "hookSpecificOutput": {"decision": {"behavior": behavior}}
            }
            for sess in self.sessions.values():
                perm = sess.get("permission")
                if perm and perm.get("id") == request_id:
                    sess["permission"] = None
                    sess["status"] = "idle"
                    sess["updated"] = time.time()
            slot["done"].set()
        self._emit()
        return True

    @dbus.service.signal(IFACE, signature="s")
    def StateChanged(self, state_json):
        pass

    # --------------------------------------------------------------- internals
    def _state_json(self):
        with self.lock:
            sessions = sorted(self.sessions.values(), key=lambda s: s.get("updated", 0),
                              reverse=True)
            return json.dumps({"sessions": [dict(s) for s in sessions],
                               "notify": self.last_notify})

    def _emit(self):
        GLib.idle_add(self._emit_main)

    def _emit_main(self):
        try:
            self.StateChanged(self._state_json())
        except Exception:
            pass
        return False

    def _tmux_select(self, tty):
        if not tty or not self._which("tmux"):
            return False
        try:
            env = dict(os.environ)
            out = subprocess.run(
                ["tmux", "list-panes", "-a", "-F", "#{pane_tty} #{session_name}:#{window_index}.#{pane_index}"],
                capture_output=True, text=True, timeout=3, env=env)
            for line in out.stdout.splitlines():
                parts = line.split()
                if len(parts) >= 2 and parts[0] == tty:
                    target = parts[1]
                    subprocess.run(["tmux", "select-window", "-t", target],
                                   timeout=3, env=env, capture_output=True)
                    subprocess.run(["tmux", "select-pane", "-t", target],
                                   timeout=3, env=env, capture_output=True)
                    return True
        except Exception:
            pass
        return False

    @staticmethod
    def _which(name):
        from shutil import which
        return which(name)

    def apply_event(self, msg):
        sid = msg.get("session_id")
        if not sid:
            return
        hook = msg.get("hook_event_name")
        now = time.time()
        created = False
        with self.lock:
            if hook == "SessionEnd":
                self.sessions.pop(sid, None)
            else:
                sess = self.sessions.get(sid)
                if sess is None:
                    sess = {"id": sid, "agent": msg.get("_source", "agent"),
                            "started": now}
                    self.sessions[sid] = sess
                    created = True
                if msg.get("_ppid"):
                    sess["pid"] = msg.get("_ppid")
                if hook == "SessionStart":
                    if msg.get("cwd"):
                        sess["cwd"] = msg.get("cwd")
                    sess.update({"status": "idle", "tool": None, "permission": None,
                                 "busy": False, "error": None})
                elif hook == "Mode":
                    if msg.get("mode"):
                        sess["mode"] = msg.get("mode")
                elif hook == "Busy":
                    sess["busy"] = True
                    sess["error"] = None
                    if sess.get("status") != "waiting":
                        sess["status"] = "working"
                elif hook == "SessionIdle":
                    sess["busy"] = False
                    sess["error"] = None
                    if sess.get("status") != "waiting":
                        sess.update({"status": "idle", "tool": None})
                elif hook == "PreToolUse":
                    sess["error"] = None
                    tool = msg.get("tool_name")
                    if tool and tool.lower() in ("question", "ask", "askuserquestion"):
                        sess.update({"status": "waiting", "tool": tool, "permission": None})
                    else:
                        sess.update({"status": "working", "tool": tool})
                elif hook == "PostToolUse":
                    sess["tool"] = None
                    if not sess.get("busy"):
                        sess["status"] = "idle"
                elif hook == "PermissionRequest":
                    sess.update({
                        "status": "waiting",
                        "tool": msg.get("tool_name"),
                        "permission": {
                            "id": msg.get("_opencode_request_id"),
                            "tool": msg.get("tool_name"),
                            "patterns": (msg.get("tool_input") or {}).get("patterns", []),
                        },
                    })
                elif hook == "Error":
                    sess["status"] = "error"
                    sess["error"] = msg.get("message") or "error"
                elif hook == "Heartbeat":
                    sess.setdefault("status", "idle")
                    if msg.get("cwd") and not sess.get("cwd"):
                        sess["cwd"] = msg.get("cwd")
                elif hook == "Notify":
                    sess.setdefault("status", "idle")
                    self.notify_seq += 1
                    self.last_notify = {
                        "id": self.notify_seq,
                        "text": msg.get("message") or "",
                        "session_id": sid,
                        "at": now,
                    }
                sess["updated"] = now
                pid = sess.get("pid")
                if pid:
                    sess["tty"] = tty_of(pid)
                    sess["ancestors"] = ancestors(pid)
                    sess["proc"] = proc_name(pid)
                    if not sess.get("cwd"):
                        sess["cwd"] = cwd_of(pid)
                if hook == "Heartbeat" and not created:
                    return
        self._emit()

    def handle_permission(self, conn, msg):
        req = str(msg.get("_opencode_request_id") or "")
        slot = {"conn": conn, "decision": None, "done": threading.Event()}
        if req:
            with self.lock:
                self.pending[req] = slot
        self.apply_event(msg)
        if not req:
            try:
                conn.close()
            except Exception:
                pass
            return
        replied = slot["done"].wait(PERMISSION_TIMEOUT)
        if replied and slot["decision"]:
            try:
                conn.sendall(json.dumps(slot["decision"]).encode())
            except OSError:
                pass
        with self.lock:
            self.pending.pop(req, None)
        try:
            conn.close()
        except Exception:
            pass

    def handle_conn(self, conn):
        data = b""
        conn.settimeout(1.0)
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                chunk = conn.recv(65536)
            except socket.timeout:
                break
            except OSError:
                break
            if not chunk:
                break
            data += chunk
            try:
                json.loads(data.decode("utf-8"))
                break
            except Exception:
                continue
        if not data:
            try:
                conn.close()
            except Exception:
                pass
            return
        try:
            msg = json.loads(data.decode("utf-8"))
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            return
        if msg.get("hook_event_name") == "PermissionRequest":
            self.handle_permission(conn, msg)
        else:
            self.apply_event(msg)
            try:
                conn.close()
            except Exception:
                pass

    def serve_socket(self):
        if os.path.exists(SOCKET_PATH):
            try:
                os.unlink(SOCKET_PATH)
            except OSError:
                pass
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(SOCKET_PATH)
        os.chmod(SOCKET_PATH, 0o600)
        srv.listen(32)
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                continue
            threading.Thread(target=self.handle_conn, args=(conn,), daemon=True).start()

    def sweep(self):
        now = time.time()
        with self.lock:
            for sid in [s for s, v in self.sessions.items()
                        if now - v.get("updated", now) > SESSION_TTL]:
                del self.sessions[sid]
        self._emit()
        return True


def main():
    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    try:
        name = dbus.service.BusName(BUS_NAME, bus)
    except dbus.exceptions.NameExistsException:
        print("agent-island: daemon already running", file=sys.stderr)
        return 1
    daemon = Daemon(bus)
    _ = name
    threading.Thread(target=daemon.serve_socket, daemon=True).start()
    GLib.timeout_add_seconds(300, daemon.sweep)
    print(f"agent-island: listening on {SOCKET_PATH}", flush=True)
    GLib.MainLoop().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
