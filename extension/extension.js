import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.agentisland.Daemon';
const OBJ_PATH = '/org/agentisland/Daemon';
const IFACE = 'org.agentisland.Daemon';

const SYMBOL = { idle: '●', working: '●', waiting: '●', error: '●' };
const LABEL = { idle: 'idle', working: 'working', waiting: 'needs input', error: 'error' };

const Indicator = GObject.registerClass(
class AgentIslandIndicator extends PanelMenu.Button {
  _init() {
    super._init(0.5, 'Agent Island');
    this._sessions = [];
    this._online = false;

    this._box = new St.BoxLayout({
      style_class: 'agent-island-box',
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._symbol = new St.Label({ text: '○', y_align: Clutter.ActorAlign.CENTER });
    try { this._symbol.set_pivot_point(0.5, 0.5); } catch (e) {}
    this._count = new St.Label({ text: '', y_align: Clutter.ActorAlign.CENTER, style_class: 'ai-count' });
    this._toast = new St.Label({
      text: '',
      visible: false,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: 'agent-island-toast',
    });
    this._box.add_child(this._symbol);
    this._box.add_child(this._count);
    this._box.add_child(this._toast);
    this.add_child(this._box);

    this._pulseId = null;
    this._pulseBig = true;
    this._pollId = null;
    this._toastId = null;
    this._lastNotify = 0;

    this._proxy = new Gio.DBusProxy({
      g_connection: Gio.DBus.session,
      g_name: BUS_NAME,
      g_object_path: OBJ_PATH,
      g_interface_name: IFACE,
      g_flags: Gio.DBusProxyFlags.DO_NOT_AUTO_START,
    });
    this._proxy.init_async(GLib.PRIORITY_DEFAULT, null, (proxy, res) => {
      try { proxy.init_finish(res); } catch (e) { logError(e); }
      this._sync();
    });

    this._signalId = this._proxy.connect('g-signal', (proxy, sender, signal, params) => {
      if (signal !== 'StateChanged')
        return;
      try {
        this._applyState(JSON.parse(params.deep_unpack()[0]));
      } catch (e) { logError(e); }
    });

    this._ownerId = this._proxy.connect('notify::g-name-owner', () => this._sync());

    this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
      this._refresh();
      return GLib.SOURCE_CONTINUE;
    });

    this.menu.connect('open-state-changed', (menu, open) => {
      if (open)
        this._refresh();
    });

    this._rebuildMenu();
    this._updatePanel();
  }

  _sync() {
    this._refresh();
  }

  _refresh() {
    this._proxy.call('GetState', null, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
      let state = null;
      try {
        const reply = proxy.call_finish(res);
        state = JSON.parse(reply.deep_unpack()[0]);
      } catch (e) {
        state = null;
      }
      const wasOnline = this._online;
      if (state) {
        this._applyState(state);
      } else {
        this._online = false;
        this._sessions = [];
        this._updatePanel();
        this._rebuildMenu();
      }
      if (wasOnline !== this._online)
        console.log(`[agent-island] daemon online=${this._online}`);
    });
  }

  _applyState(state) {
    this._online = true;
    this._sessions = state.sessions || [];
    const n = state.notify;
    if (n && n.id !== this._lastNotify) {
      this._lastNotify = n.id;
      if (n.text && (Date.now() / 1000 - (n.at || 0)) < 15)
        this._showToast(n.text);
    }
    this._updatePanel();
    this._rebuildMenu();
  }

  _showToast(text) {
    if (!this._toast)
      return;
    console.log(`[agent-island] toast: ${text}`);
    this._toast.text = text;
    this._toast.visible = true;
    if (this._toastId) {
      GLib.source_remove(this._toastId);
      this._toastId = null;
    }
    this._toastId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
      this._toastId = null;
      if (this._toast) {
        this._toast.visible = false;
        this._toast.text = '';
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  _updatePanel() {
    const waiting = this._sessions.some(s => s.status === 'waiting');
    const error = this._sessions.some(s => s.status === 'error');
    const working = this._sessions.some(s => s.status === 'working');
    const plan = this._sessions.some(s => s.status === 'working' && (s.mode || '').toLowerCase() === 'plan');
    if (!this._online) {
      this._symbol.text = SYMBOL.idle;
      this._symbol.style_class = 'agent-island-symbol ai-offline';
      this._count.text = '';
      this._stopPulse();
      return;
    }
    if (!this._sessions.length) {
      this._symbol.text = SYMBOL.idle;
      this._symbol.style_class = 'agent-island-symbol ai-idle';
      this._count.text = '';
      this._stopPulse();
      return;
    }
    this._symbol.text = SYMBOL.idle;
    let cls;
    if (waiting)
      cls = 'ai-question';
    else if (error)
      cls = 'ai-error';
    else if (plan)
      cls = 'ai-plan';
    else if (working)
      cls = 'ai-working';
    else
      cls = 'ai-idle';
    this._symbol.style_class = 'agent-island-symbol ' + cls;
    this._count.text = String(this._sessions.length);

    if (waiting)
      this._startPulse();
    else
      this._stopPulse();
  }

  _startPulse() {
    if (this._pulseId || !this._symbol)
      return;
    this._pulseBig = true;
    this._symbol.ease({
      scale_x: 2.2, scale_y: 2.2, duration: 700,
      mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
    });
    this._pulseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 750, () => {
      this._pulseBig = !this._pulseBig;
      const s = this._pulseBig ? 2.2 : 1.0;
      this._symbol.ease({
        scale_x: s, scale_y: s, duration: 700,
        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
      });
      return GLib.SOURCE_CONTINUE;
    });
  }

  _stopPulse() {
    if (this._pulseId) {
      GLib.source_remove(this._pulseId);
      this._pulseId = null;
    }
    if (this._symbol)
      this._symbol.ease({ scale_x: 1.0, scale_y: 1.0, duration: 200 });
    if (this._box)
      this._box.ease({ opacity: 255, duration: 200 });
  }

  _basename(p) {
    if (!p)
      return '';
    const parts = p.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || p;
  }

  _rebuildMenu() {
    this.menu.removeAll();
    if (!this._online) {
      this.menu.addMenuItem(new PopupMenu.PopupMenuItem('Agent Island: daemon offline', { reactive: false }));
      return;
    }
    if (!this._sessions.length) {
      this.menu.addMenuItem(new PopupMenu.PopupMenuItem('No agents running', { reactive: false }));
      return;
    }
    for (const s of this._sessions) {
      const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: 'ai-item' });
      const content = new St.BoxLayout({ vertical: true, style_class: 'ai-item-box' });
      content.add_child(new St.Label({
        text: `${this._basename(s.cwd) || s.agent}  [${s.agent}]`,
        style_class: 'ai-title',
      }));
      content.add_child(new St.Label({
        text: `${SYMBOL[s.status] || '●'} ${LABEL[s.status] || s.status}`
          + `${s.mode ? ' · ' + s.mode : ''}`
          + `${s.tool ? ' · ' + s.tool : ''}`
          + `${s.status === 'error' && s.error ? ' · ' + s.error : ''}`,
        style_class: 'ai-sub',
      }));

      const actions = new St.BoxLayout({ style_class: 'ai-actions' });
      actions.add_child(this._button('Jump', 'ai-btn', () => this._jump(s.pid)));

      if (s.status === 'waiting' && s.permission) {
        actions.add_child(this._button('Allow', 'ai-btn ai-allow', () => this._reply(s.permission.id, 'allow')));
        actions.add_child(this._button('Always', 'ai-btn', () => this._reply(s.permission.id, 'always')));
        actions.add_child(this._button('Deny', 'ai-btn ai-deny', () => this._reply(s.permission.id, 'deny')));
      }
      content.add_child(actions);
      item.add_child(content);
      this.menu.addMenuItem(item);
    }
  }

  _button(text, styleClass, onClicked) {
    const btn = new St.Button({ style_class: styleClass, child: new St.Label({ text }) });
    btn.connect('clicked', onClicked);
    return btn;
  }

  _jump(pid) {
    if (!pid)
      return;
    this.menu.close();
    this._proxy.call('Jump', new GLib.Variant('(i)', [pid]), Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
      try {
        const reply = proxy.call_finish(res);
        const info = JSON.parse(reply.deep_unpack()[0]);
        this._raise(info.ancestors || []);
      } catch (e) { logError(e); }
    });
  }

  _reply(id, reply) {
    if (!id)
      return;
    this._proxy.call('PermissionReply', new GLib.Variant('(ss)', [String(id), reply]), Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
      try { proxy.call_finish(res); } catch (e) { logError(e); }
      this._refresh();
    });
  }

  _raise(ancestorPids) {
    const set = new Set(ancestorPids);
    const tracker = Shell.WindowTracker.get_default();
    let target = null;
    for (const actor of global.get_window_actors()) {
      const win = actor.meta_window;
      if (!win || win.is_skip_taskbar())
        continue;
      const pids = [];
      const pid = win.get_pid();
      if (pid && pid > 0)
        pids.push(pid);
      const app = tracker.get_window_app(win);
      if (app)
        pids.push(...app.get_pids());
      if (pids.some(p => set.has(p))) {
        target = win;
        break;
      }
    }
    if (target)
      Main.activateWindow(target, global.get_current_time());
  }

  destroy() {
    this._stopPulse();
    if (this._pollId) {
      GLib.source_remove(this._pollId);
      this._pollId = null;
    }
    if (this._toastId) {
      GLib.source_remove(this._toastId);
      this._toastId = null;
    }
    if (this._proxy) {
      if (this._signalId)
        this._proxy.disconnect(this._signalId);
      if (this._ownerId)
        this._proxy.disconnect(this._ownerId);
      this._proxy = null;
    }
    super.destroy();
  }
});

export default class AgentIslandExtension extends Extension {
  enable() {
    console.log('[agent-island] enable');
    this._indicator = new Indicator();
    Main.panel.addToStatusArea('agent-island', this._indicator, 1, 'center');
    console.log('[agent-island] indicator added');
  }

  disable() {
    console.log('[agent-island] disable');
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
  }
}
