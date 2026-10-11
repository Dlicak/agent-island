# Agent Island

A small "island" in the GNOME top bar that shows what your AI coding agent is
doing and lets you act on it without leaving the current app:

- **status** of every running agent session (idle / working / needs permission),
- **pulse** — the indicator gently pulses (no sound) while a session is waiting
  for permission, so the prompt is noticeable without audio,
- **toast** — a brief silent note in the bar when something notable happens
  (e.g. `✓ commit 1a2b3c4`, `↑ push`), also without sound,
- **Jump** — raise the terminal window running the session,
- **Allow / Always / Deny** — answer a permission prompt straight from the bar.

Currently targets **OpenCode** on **GNOME Shell (Wayland)**.

```
┌───────────────────────────────┐
│  ●  Agent Island              │
│  ~/project        [opencode]  │
│  ● working · build · Bash     │
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
  daemon protocol (`SessionStart`, `Busy`, `SessionIdle`, `Mode`, `PreToolUse`,
  `PostToolUse`, `Error`, `SessionEnd`, `PermissionRequest`, `Notify`) and forwards
  permission decisions back to OpenCode. `Busy`/`SessionIdle` come from the
  `session.status` event (`busy`/`retry`/`idle`) so the indicator stays in
  *working* for the whole time the agent is busy (thinking + tools), not only
  while a tool runs. `Mode` carries the current agent (`build`/`plan`) so the bar
  can colour *working* differently; `Error` comes from `session.error` and tool
  failures. The OpenCode question tool (`Question`) is treated as *waiting* so
  the bar breathes violet while the agent is asking you something. `Notify` is
  emitted on notable completed commands
  (e.g. `git commit`/`git push`, `gh pr`) to drive the silent bar toast.
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

## Notes

- Indicator states — a filled dot whose colour is the state: **grey** = daemon
  offline / no session, **white** = idle (nothing happening), **blue** = working
  (build), **orange** = working (plan), **violet** = waiting for you
  (permission / question: the dot stays put and chevrons `» «` pulse inward
  towards it), **red** = error. The top bar is tinted the same colour, except
  when idle/offline, when it keeps its normal background; in the waiting and
  error states the bar colour also breathes (pulses lighter/darker). The number is the session
  count.
- A silent toast (green text in the bar, ~4s) appears for notable completed
  commands recognised by the plugin (`git commit`, `git push`, `git merge`,
  `git rebase`, `gh pr create/merge`), e.g. `✓ commit 1a2b3c4`.
- The daemon keeps session state in memory; a daemon restart (e.g. on logout)
  clears it until the next agent event arrives. The OpenCode plugin sends a
  heartbeat every 10s, so live sessions reappear within a few seconds even if
  OpenCode itself did not emit anything new.
- The socket is created mode `0600` and lives in the per-user runtime dir.
- GNOME Shell caches extension modules per session, so an edited `extension.js`
  only takes effect after re-login.

## License

MIT
