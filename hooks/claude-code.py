#!/usr/bin/env python3
"""Agent Island adapter for Claude Code hooks.

Claude Code runs this script on each hook event and passes the event as JSON on
stdin (https://docs.anthropic.com/claude-code/hooks). We translate that into the
Agent Island socket protocol so the daemon and the GNOME indicator show the same
state as for OpenCode, and optionally let the island approve/deny tool use.

Wire it up in ~/.claude/settings.json, e.g.:

  {
    "hooks": {
      "SessionStart":     [{"hooks": [{"type": "command", "command": "~/agent-island/hooks/claude-code.py"}]}],
      "SessionEnd":       [{"hooks": [{"type": "command", "command": "~/agent-island/hooks/claude-code.py"}]}],
      "PreToolUse":       [{"hooks": [{"type": "command", "command": "~/agent-island/hooks/claude-code.py"}]}],
      "PostToolUse":      [{"hooks": [{"type": "command", "command": "~/agent-island/hooks/claude-code.py"}]}],
      "Stop":             [{"hooks": [{"type": "command", "command": "~/agent-island/hooks/claude-code.py"}]}]
    }
  }

By default the hook only mirrors status. Set AGENT_ISLAND_GATE=1 in the hook
environment to route every PreToolUse through the island's Allow/Deny buttons;
the daemon then decides and the hook returns Claude Code a permission decision.
"""
import json
import os
import socket
import sys
import time

RUNTIME = os.environ.get("XDG_RUNTIME_DIR") or "/run/user/%d" % os.getuid()
SOCKET = os.path.join(RUNTIME, "agent-island.sock")

GATE = os.environ.get("AGENT_ISLAND_GATE", "").lower() in ("1", "true", "yes", "on")
TIMEOUT = float(os.environ.get("AGENT_ISLAND_TIMEOUT", "300"))


def agent_pid():
    """Nearest ancestor process that looks like the agent, else our parent."""
    pid = os.getppid()
    best = pid
    for _ in range(40):
        if pid <= 1:
            break
        try:
            with open("/proc/%d/comm" % pid) as fh:
                comm = fh.read().strip()
        except OSError:
            break
        if "claude" in comm or "node" in comm:
            return pid
        try:
            with open("/proc/%d/stat" % pid) as fh:
                pid = int(fh.read().rsplit(")", 1)[1].split()[1])
        except (OSError, IndexError, ValueError):
            break
    return best


def send(msg):
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(3)
        s.connect(SOCKET)
        s.sendall(json.dumps(msg).encode())
        s.close()
    except OSError:
        pass


def send_and_wait(msg, timeout):
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(SOCKET)
        s.sendall(json.dumps(msg).encode())
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        s.close()
        return json.loads(buf.decode())
    except (OSError, ValueError):
        return None


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0

    name = event.get("hook_event_name", "")
    sid = event.get("session_id", "")
    base = {
        "session_id": "claude-%s" % sid,
        "cwd": event.get("cwd") or os.getcwd(),
        "_source": "claude",
        "_ppid": agent_pid(),
    }

    if name == "SessionStart":
        send(dict(base, hook_event_name="SessionStart"))
    elif name == "SessionEnd":
        send(dict(base, hook_event_name="SessionEnd"))
    elif name == "Stop":
        send(dict(base, hook_event_name="PostToolUse"))
    elif name in ("PreToolUse", "PostToolUse"):
        tool = event.get("tool_name", "")
        if name == "PreToolUse" and GATE:
            req = dict(base, hook_event_name="PermissionRequest", tool_name=tool,
                       tool_input=event.get("tool_input") or {},
                       _opencode_request_id="claude-%s-%d" % (sid, int(time.time() * 1000)))
            resp = send_and_wait(req, TIMEOUT)
            behavior = (resp or {}).get("hookSpecificOutput", {}).get("decision", {}).get("behavior")
            decision = "deny" if behavior == "deny" else "allow" if behavior else "ask"
            json.dump({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": decision,
                "permissionDecisionReason": "Agent Island",
            }}, sys.stdout)
        else:
            send(dict(base, hook_event_name=name, tool_name=tool))
    elif name == "Notification":
        msg = (event.get("message") or "").lower()
        if "permission" in msg or "approve" in msg:
            send(dict(base, hook_event_name="PermissionRequest", tool_name="",
                      tool_input={}, _opencode_request_id="claude-notify-%d" % int(time.time() * 1000)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
