# Agent Island

A small "island" in the GNOME top bar that shows what your AI coding agent is
doing and lets you act on it without leaving the current app:

- **status** of every running agent session (idle / working / needs permission),
- **Jump** — raise the terminal window running the session,
- **Allow / Always / Deny** — answer a permission prompt straight from the bar.

Currently targets **OpenCode** on **GNOME Shell (Wayland)**.

```
┌───────────────────────────────┐
│  ○  Agent Island              │
│  ~/project        [opencode]  │
│  ◐ working · Bash             │
│  [ Jump ]                     │
└───────────────────────────────┘
```

## Architecture

```
 OpenCode ──(plugin)──▶ Unix socket ──▶ daemon ──(D-Bus)──▶ GNOME Shell extension
            events        agent-island.sock      StateChanged    panel indicator
                        ◀── reply ──────────── PermissionReply
```

- **daemon/** — Python process. Listens on `$XDG_RUNTIME_DIR/agent-island.sock`
  for agent events, keeps in-memory session state and exposes it on the session
  D-Bus bus `org.agentisland.Daemon` (object `/org/agentisland/Daemon`).
  Methods: `GetState() -> s`, `Jump(i) -> s`, `PermissionReply(ss) -> b`;
  signal: `StateChanged(s)`. Also computes the process/tty/ancestor chain for
  "jump to terminal" and can focus the matching tmux pane.
- **plugin/** — OpenCode plugin (`agent-island.js`). Maps OpenCode events to the
  daemon protocol (`SessionStart`, `PreToolUse`, `PostToolUse`, `SessionEnd`,
  `PermissionRequest`) and forwards permission decisions back to OpenCode.
- **extension/** — GNOME Shell extension (`agent-island@lynx`). A panel
  indicator that reflects daemon state and renders the popup with actions.

## Requirements

- GNOME Shell 45–50 (Wayland)
- Python 3 with `dbus-python` and PyGObject (`python3-dbus`, `python3-gi`)
- OpenCode
- optional: `tmux` (to focus a pane instead of just the window)

## Install

```bash
git clone https://github.com/Dlicak/agent-island.git ~/agent-island
~/agent-island/install.sh
```

The installer copies the extension, links the OpenCode plugin, installs and
starts the user service, and enables the extension. Then **log out and back in**
(GNOME cannot hot-load a changed extension on Wayland).

## Manual install

```bash
# daemon
mkdir -p ~/.config/systemd/user
cp systemd/agent-island.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-island

# extension
cp -r extension ~/.local/share/gnome-shell/extensions/agent-island@lynx
gsettings set org.gnome.shell disable-user-extensions false
gnome-extensions enable agent-island@lynx

# OpenCode plugin
mkdir -p ~/.config/opencode/plugins
ln -sf ~/agent-island/plugin/agent-island.js ~/.config/opencode/plugins/agent-island.js
```

## Other agents

The daemon speaks a single neutral protocol, so any agent that can run a small
hook can feed the island. The OpenCode plugin and the Claude Code hook in
`hooks/` are both thin translators to this protocol.

### Socket protocol

Connect to `$XDG_RUNTIME_DIR/agent-island.sock` and send **one** JSON object:

| field | required | meaning |
|---|---|---|
| `session_id` | yes | stable id, namespaced per agent (e.g. `claude-<id>`) |
| `hook_event_name` | yes | `SessionStart` \| `PreToolUse` \| `PostToolUse` \| `SessionEnd` \| `PermissionRequest` |
| `_source` | yes | agent name shown in the island (`opencode`, `claude`, …) |
| `_ppid` | yes | pid of the agent process (used to find its terminal) |
| `cwd` | no | working directory |
| `tool_name` | no | tool being used |
| `_opencode_request_id` | for `PermissionRequest` | id correlating the request/reply |

For a `PermissionRequest` the daemon **keeps the connection open** and replies
with the decision:

```json
{"hookSpecificOutput": {"decision": {"behavior": "allow"}}}
```

`behavior` is `allow`, `deny` or `always`. On timeout the daemon closes the
connection (the caller should then fall back to asking the user).

### Claude Code

`hooks/claude-code.py` maps Claude Code hooks to the protocol. Add to
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "~/agent-island/hooks/claude-code.py"}]}],
    "SessionEnd":   [{"hooks": [{"type": "command", "command": "~/agent-island/hooks/claude-code.py"}]}],
    "PreToolUse":   [{"hooks": [{"type": "command", "command": "~/agent-island/hooks/claude-code.py"}]}],
    "PostToolUse":  [{"hooks": [{"type": "command", "command": "~/agent-island/hooks/claude-code.py"}]}],
    "Stop":         [{"hooks": [{"type": "command", "command": "~/agent-island/hooks/claude-code.py"}]}]
  }
}
```

By default the hook only mirrors status. To route every `PreToolUse` through the
island's Allow/Deny buttons, set `AGENT_ISLAND_GATE=1` in the hook environment
(the hook then returns Claude Code a `permissionDecision`). Without a reply it
returns `ask`, so it never silently approves.

## Notes

- The daemon keeps session state in memory; a daemon restart (e.g. on logout)
  clears it until the next agent event arrives.
- The socket is created mode `0600` and lives in the per-user runtime dir.
- GNOME Shell caches extension modules per session, so an edited `extension.js`
  only takes effect after re-login.

## License

MIT
