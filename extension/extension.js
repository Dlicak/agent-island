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
const PANEL_RGB = {
  'ai-working': [53, 132, 228, 0],
  'ai-plan': [230, 97, 0, 0.72],
  'ai-question': [145, 65, 172, 0.72],
  'ai-error': [224, 27, 36, 0.72],
};

const Indicator = GObject.registerClass(
class AgentIslandIndicator extends PanelMenu.Button {
  _init() {
    super._init(0.5, 'Agent Island');
    try { this.menu.box.add_style_class_name('agent-island-menu'); } catch (e) {}
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
    this._arrowL = new St.Label({
      text: '»', visible: false, y_align: Clutter.ActorAlign.CENTER, style_class: 'agent-island-arrow',
    });
    this._arrowR = new St.Label({
      text: '«', visible: false, y_align: Clutter.ActorAlign.CENTER, style_class: 'agent-island-arrow',
    });
    this._box.add_child(this._arrowL);
    this._box.add_child(this._symbol);
    this._box.add_child(this._arrowR);
    this._box.add_child(this._count);
    this._box.add_child(this._toast);
    this.add_child(this._box);

    this._pulseId = null;
    this._pulseIn = true;
    this._panelTimer = null;
    this._panelBase = null;
    this._panelPhase = 0;
    this._barTint = null;
    this._barTintBlur = null;
    this._barTintSizeId = null;
    this._barTintPosId = null;
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
    this._toast.opacity = 0;
    this._toast.set_translation(0, -4, 0);
    this._toast.ease({
      opacity: 255, translation_y: 0, duration: 260,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
    if (this._toastId) {
      GLib.source_remove(this._toastId);
      this._toastId = null;
    }
    this._toastId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
      this._toastId = null;
      if (this._toast)
        this._toast.ease({ opacity: 0, duration: 260, mode: Clutter.AnimationMode.EASE_IN_QUAD });
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        if (this._toast) {
          this._toast.visible = false;
          this._toast.text = '';
        }
        return GLib.SOURCE_REMOVE;
      });
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
      this._setPanel(null);
      this._stopPulse();
      return;
    }
    if (!this._sessions.length) {
      this._symbol.text = SYMBOL.idle;
      this._symbol.style_class = 'agent-island-symbol ai-idle';
      this._count.text = '';
      this._setPanel(null);
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
    this._arrowL.style_class = 'agent-island-arrow ' + cls;
    this._arrowR.style_class = 'agent-island-arrow ' + cls;
    this._count.text = String(this._sessions.length);
    this._setPanel(cls);

    if (waiting)
      this._startPulse();
    else
      this._stopPulse();
  }

  _setPanel(cls) {
    try {
      this._panelBase = cls ? PANEL_RGB[cls] : null;
      if (!this._panelBase) {
        this._stopPanelWave();
        this._removePanelBlur();
        Main.panel.set_style(null);
        return;
      }
      this._ensurePanelBlur();
      this._panelWave = (cls === 'ai-question' || cls === 'ai-error');
      if (this._panelWave)
        this._startPanelWave();
      else {
        this._stopPanelWave();
        this._paintPanel();
      }
    } catch (e) { logError(e); }
  }

  _setTintStyle(style) {
    if (this._barTint)
      this._barTint.set_style(style);
    else
      Main.panel.set_style(style);
  }

  _paintPanel() {
    const [r, g, b, a] = this._panelBase;
    this._setTintStyle(`background-color: rgba(${r}, ${g}, ${b}, ${a});`);
  }

  _paintPanelWave(p) {
    const [r, g, b, a] = this._panelBase;
    const mix = (v, w) => Math.round(v + (255 - v) * w);
    const dark = `rgba(${r}, ${g}, ${b}, ${a})`;
    const light = `rgba(${mix(r, 0.5)}, ${mix(g, 0.5)}, ${mix(b, 0.5)}, ${a})`;
    const pct = Math.round(p * 100);
    const lo = Math.max(0, pct - 25);
    const hi = Math.min(100, pct + 25);
    this._setTintStyle(`background-color: ${dark}; background-image: linear-gradient(to right, ${dark} ${lo}%, ${light} ${pct}%, ${dark} ${hi}%);`);
  }

  _ensurePanelBlur() {
    if (this._barTint)
      return;
    try {
      const pb = Main.layoutManager.panelBox;
      const ui = Main.layoutManager.uiGroup;
      this._barTint = new St.Widget({ reactive: false });
      this._barTintBlur = new Shell.BlurEffect({ radius: 24, brightness: 0.85 });
      this._barTint.add_effect(this._barTintBlur);
      ui.insert_child_below(this._barTint, pb);
      this._syncBarTint();
      this._barTintSizeId = pb.connect('notify::size', () => this._syncBarTint());
      this._barTintPosId = pb.connect('notify::position', () => this._syncBarTint());
      Main.panel.set_style('background-color: transparent;');
    } catch (e) { this._barTint = null; logError(e); }
  }

  _syncBarTint() {
    if (!this._barTint)
      return;
    const pb = Main.layoutManager.panelBox;
    const w = pb.width || Main.panel.width || global.screen_width;
    const h = pb.height || Main.panel.height;
    this._barTint.set_position(pb.x, pb.y);
    this._barTint.set_size(w, h);
  }

  _removePanelBlur() {
    if (this._barTintSizeId) {
      try { Main.layoutManager.panelBox.disconnect(this._barTintSizeId); } catch (e) {}
      this._barTintSizeId = null;
    }
    if (this._barTintPosId) {
      try { Main.layoutManager.panelBox.disconnect(this._barTintPosId); } catch (e) {}
      this._barTintPosId = null;
    }
    if (this._barTint) {
      try { this._barTint.destroy(); } catch (e) {}
      this._barTint = null;
      this._barTintBlur = null;
    }
    try { Main.panel.set_style(null); } catch (e) {}
  }

  _startPanelWave() {
    if (this._panelTimer)
      return;
    this._panelPhase = 0;
    this._panelTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
      this._panelPhase += 0.042;
      const x = (this._panelPhase % (2 * Math.PI)) / (2 * Math.PI);
      const p = x < 0.5 ? x * 2 : (1 - x) * 2;
      this._paintPanelWave(p);
      return GLib.SOURCE_CONTINUE;
    });
  }

  _stopPanelWave() {
    if (this._panelTimer) {
      GLib.source_remove(this._panelTimer);
      this._panelTimer = null;
    }
  }

  _startPulse() {
    if (this._pulseId || !this._symbol)
      return;
    this._arrowL.visible = true;
    this._arrowR.visible = true;
    this._pulseIn = true;
    const apply = (inward) => {
      this._arrowL.ease({
        translation_x: inward ? 0 : -9, duration: 600,
        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
      });
      this._arrowR.ease({
        translation_x: inward ? 0 : 9, duration: 600,
        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
      });
    };
    apply(true);
    this._pulseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 650, () => {
      this._pulseIn = !this._pulseIn;
      apply(this._pulseIn);
      return GLib.SOURCE_CONTINUE;
    });
  }

  _stopPulse() {
    if (this._pulseId) {
      GLib.source_remove(this._pulseId);
      this._pulseId = null;
    }
    if (this._arrowL) {
      this._arrowL.visible = false;
      this._arrowL.set_translation(0, 0, 0);
    }
    if (this._arrowR) {
      this._arrowR.visible = false;
      this._arrowR.set_translation(0, 0, 0);
    }
    if (this._symbol)
      this._symbol.ease({ translation_x: 0, scale_x: 1.0, scale_y: 1.0, duration: 200 });
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
    this._stopPanelWave();
    this._setPanel(null);
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
