// WS 长连接 + type-field 多路复用消息协议。
// 一后端一实例，状态机：disconnected → connecting → connected → disconnected。

import JSZip from 'jszip';
import { state } from './state.js';

// 协议消息常量，与 backend/droidtaskflow_backend/schema.py 保持一致。
const MSG_PING = 'ping';
const MSG_PONG = 'pong';
const MSG_RUN = 'run';
const MSG_CANCEL = 'cancel';
const MSG_DEVICE_SCAN = 'device_scan';
const MSG_DEVICE_SCAN_REQ = 'device_scan_req';
const MSG_DEVICE_SCAN_REPLY = 'device_scan_req:reply';
// M2: device screenshot
const MSG_DEVICE_SCREENSHOT_REQ = 'device_screenshot_req';
const MSG_DEVICE_SCREENSHOT = 'device_screenshot';
// M6: device keyevent
const MSG_DEVICE_KEYEVENT_REQ = 'device_keyevent_req';
const MSG_DEVICE_KEYEVENT_REPLY = 'device_keyevent_req:reply';
// M7: device power (幂等)
const MSG_DEVICE_POWER_REQ = 'device_power_req';
const MSG_DEVICE_POWER_REPLY = 'device_power_req:reply';
const MSG_LOG = 'log';
const MSG_EXIT = 'exit';
const MSG_ERROR = 'error';

const HEARTBEAT_INTERVAL_MS = 25_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;

export class BackendClient {
  constructor({ host, port, name = '' }) {
    this.id = crypto.randomUUID();
    this.host = host;
    this.port = port;
    this.name = name || `${host}:${port}`;
    this._ws = null;
    this._state = 'disconnected';
    this._listeners = { state: [], log: [], exit: [], error: [], message: [] };
    this._heartbeat = null;
    this._handshakeTimer = null;
    this.closeCode = null;    // CloseEvent.code，4003 = 被占用
    this.closeReason = '';
    // M1: 页面卸载时主动关 WS, 让服务端尽快进入 WebSocketDisconnect 清理路径。
    // 单靠 backend 端 WS state 检测有 race: F5/关 tab 时浏览器不一定发 close frame,
    // 服务端 _serve 会一直挂在 receive_text 上, _ACTIVE_CONNECTIONS 残留
    // 导致下一条新连接被拒为 4003。
    this._installBeforeUnload();
  }

  _installBeforeUnload() {
    window.addEventListener('beforeunload', () => {
      if (this._ws && this._ws.readyState <= WebSocket.OPEN) {
        try { this._ws.close(1000, 'page unload'); } catch (_) { /* race */ }
      }
    });
  }

  // ---- 公共 API ----

  get state() { return this._state; }
  get url() { return `ws://${this.host}:${this.port}/ws`; }

  on(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
    return this;
  }

  _emit(type, payload) {
    for (const fn of this._listeners[type] || []) fn(payload);
    for (const fn of this._listeners.message || []) fn({ type, payload });
  }

  connect() {
    if (this._state !== 'disconnected') return Promise.resolve();
    this._setState('connecting');
    return new Promise((resolve, reject) => {
      let resolved = false;
      try {
        this._ws = new WebSocket(this.url);
      } catch (e) {
        this._setState('disconnected');
        reject(e);
        return;
      }
      this._handshakeTimer = setTimeout(() => {
        if (this._state === 'connecting') {
          try { this._ws.close(); } catch (_) {}
          if (!resolved) { resolved = true; reject(new Error('handshake timeout')); }
        }
      }, HANDSHAKE_TIMEOUT_MS);

      this._ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        if (msg.type === MSG_PONG && this._state === 'connecting') {
          if (this._handshakeTimer) { clearTimeout(this._handshakeTimer); this._handshakeTimer = null; }
          this._setState('connected');
          this._startHeartbeat();
          // M1: 主动拉一次设备列表（保证拿到最新 snapshot）
          this.requestDeviceScan();
          if (!resolved) { resolved = true; resolve(); }
          return;
        }
        // M1: 处理 device_scan / device_scan_req:reply
        if (msg.type === MSG_DEVICE_SCAN || msg.type === MSG_DEVICE_SCAN_REPLY) {
          const devices = Array.isArray(msg.devices) ? msg.devices : [];
          if (this._onDeviceScan) this._onDeviceScan(devices);
          return;
        }
        this._dispatch(msg);
      };
      this._ws.onopen = () => { this._ws.send(JSON.stringify({ type: MSG_PING })); };
      this._ws.onclose = (e) => this._onSocketClose(e);
      this._ws.onerror = () => {
        if (!resolved) { resolved = true; reject(new Error('ws error')); }
      };
    });
  }

  close() {
    this._stopHeartbeat();
    if (this._handshakeTimer) { clearTimeout(this._handshakeTimer); this._handshakeTimer = null; }
    if (this._ws && this._ws.readyState <= 1) {
      try { this._ws.close(); } catch (_) {}
    }
    this._ws = null;
    this.closeCode = null;
    this.closeReason = '';
    this._setState('disconnected');
  }

  sendRun(zipBytes, runId, entry = 'main.py', global_args = {}) {
    if (this._state !== 'connected') throw new Error('not connected');
    const msg = {
      type: MSG_RUN,
      run_id: runId,
      zip_b64: bytesToBase64(zipBytes),
      entry,
    };
    if (global_args && Object.keys(global_args).length) {
      msg.global_args = global_args;
    }
    this._ws.send(JSON.stringify(msg));
  }

  sendCancel(runId) {
    if (this._state !== 'connected') return;
    this._ws.send(JSON.stringify({ type: MSG_CANCEL, run_id: runId }));
  }

  /** 通用发送（自动化任务 CRUD / 历史查询等）。未连接返回 false。 */
  sendRaw(obj) {
    if (this._state !== 'connected') return false;
    try { this._ws.send(JSON.stringify(obj)); return true; } catch (_) { return false; }
  }

  // M1: 主动拉设备列表
  requestDeviceScan() {
    if (this._state !== 'connected') return;
    try {
      this._ws.send(JSON.stringify({ type: MSG_DEVICE_SCAN_REQ }));
    } catch (_) {}
  }

  // M1: 外部注册设备列表回调（backend-panel / sidebar 渲染）
  setDeviceScanHandler(fn) { this._onDeviceScan = fn; }

  // M2: 向后端请求对 serial 设备截图
  requestDeviceScreenshot(serial) {
    if (this._state !== 'connected') return false;
    try {
      // race 防护：记录 in-flight serial；旧请求回来时不匹配则丢弃
      state.devicePreview.inflightSerial = serial;
      state.devicePreview.fetching = true;
      this._ws.send(JSON.stringify({ type: MSG_DEVICE_SCREENSHOT_REQ, serial }));
      return true;
    } catch (_) { return false; }
  }

  // M2: 外部注册截图回调（device-preview.js）
  setDeviceScreenshotHandler(fn) { this._onDeviceScreenshot = fn; }
  setDeviceScreenshotErrorHandler(fn) { this._onDeviceScreenshotError = fn; }

  // M7: 幂等电源开关 reply 回调（device-preview.js）。覆盖式以避免多次切换 client 时
  // _wireClient 重复 push listener 导致一次 reply 触发多次 toast。
  setDevicePowerHandler(fn) { this._onDevicePower = fn; }

  // 覆盖式 state 回调（替代 client.on('state', ...) push 模式——后者多次 _wireClient 后
  // listener 累积导致一个状态变化触发 N 次回调）。
  setStateHandler(fn) { this._onState = fn; }

  // M6: 通用设备按键（电源开/关等都通过通用 keycode 发，行为由设备系统决定）
  requestDeviceKeyevent(serial, keycode) {
    if (this._state !== 'connected' || !serial) return false;
    try {
      this._ws.send(JSON.stringify({
        type: MSG_DEVICE_KEYEVENT_REQ,
        serial,
        keycode,
      }));
      return true;
    } catch (_) { return false; }
  }

  // M7: 幂等的电源开关（action='on'/'off'）。后端先查屏幕状态再决定是否按 POWER keyevent，
  // 返回 reply {ok, applied}：applied=false 表示幂等跳过（已是目标状态）。
  requestDevicePower(serial, action) {
    if (this._state !== 'connected' || !serial) return false;
    if (action !== 'on' && action !== 'off') return false;
    try {
      this._ws.send(JSON.stringify({
        type: MSG_DEVICE_POWER_REQ,
        serial,
        action,
      }));
      return true;
    } catch (_) { return false; }
  }

  // M2: 设置 inflightSerial / fetching（device-preview 调用）
  _markScreenshotInflight(serial) {
    // 通过自定义事件让 device-preview 同步它自己的 state
    window.dispatchEvent(new CustomEvent('dtf:screenshot-inflight', { detail: { serial } }));
  }

  // ---- 内部 ----

  _setState(s) {
    if (this._state === s) return;
    this._state = s;
    if (this._onState) this._onState(s);
    this._emit('state', s);
  }

  _startHeartbeat() {
    this._heartbeat = setInterval(() => {
      if (this._state === 'connected' && this._ws) {
        try { this._ws.send(JSON.stringify({ type: MSG_PING })); } catch (_) {}
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
  }

  _onSocketClose(e) {
    this._stopHeartbeat();
    if (this._handshakeTimer) { clearTimeout(this._handshakeTimer); this._handshakeTimer = null; }
    this._ws = null;
    // 捕获 close code，前端可用它区分"后端 busy"（4003）和普通断开
    this.closeCode = (e && e.code) || null;
    this.closeReason = (e && e.reason) || '';
    this._setState('disconnected');
  }

  _dispatch(msg) {
    switch (msg.type) {
      case MSG_PONG: break; // 心跳回包；已连接态忽略
      case MSG_LOG: this._emit('log', msg); break;
      case MSG_EXIT: this._emit('exit', msg); break;
      case MSG_ERROR:
        this._emit('error', msg);
        // M2: error during screenshot → notify device-preview
        if (state.devicePreview.fetching && this._onDeviceScreenshotError) {
          state.devicePreview.fetching = false;
          state.devicePreview.inflightSerial = null;
          this._onDeviceScreenshotError(msg.message);
        }
        break;
      case MSG_PING:
        try { this._ws.send(JSON.stringify({ type: MSG_PONG })); } catch (_) {}
        break;
      case MSG_DEVICE_SCREENSHOT:
        // race guard: 旧请求回来 serial 不匹配则丢弃
        if (state.devicePreview.inflightSerial !== null &&
            state.devicePreview.inflightSerial !== msg.serial) {
          break;
        }
        if (!this._onDeviceScreenshot) break;
        // decode base64 PNG → Blob
        const bin = atob(msg.png_b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/png' });
        // release old blob URL
        if (state.devicePreview.blobUrl) URL.revokeObjectURL(state.devicePreview.blobUrl);
        state.devicePreview.serial = msg.serial;
        state.devicePreview.blobUrl = URL.createObjectURL(blob);
        state.devicePreview.width = msg.width;
        state.devicePreview.height = msg.height;
        state.devicePreview.source = 'backend';
        state.devicePreview.fetching = false;
        state.devicePreview.pickedPoint = null;
        state.devicePreview.inflightSerial = null;
        // 前台应用信息
        const pkg = msg.package || '';
        const act = msg.activity || '';
        state.devicePreview.foregroundApp = (pkg && act) ? `${pkg}/${act}` : pkg || '';
        this._onDeviceScreenshot({ serial: msg.serial, blob, width: msg.width, height: msg.height });
        break;
      case MSG_DEVICE_POWER_REPLY:
        // 幂等电源开关结果：{ok, applied, action}。applied=false 表示幂等跳过。
        // 走 setDevicePowerHandler 覆盖式回调（不是 emit('device_power', ...)），
        // 避免多次 _wireClient 后 listener 累积导致一次 reply 多次 toast。
        if (this._onDevicePower) this._onDevicePower(msg);
        break;
      default:
        // M5: 自动化消息统一透传给 'automation' 监听者（automation-panel 订阅）
        if (typeof msg.type === 'string' && msg.type.startsWith('automation_')) {
          this._emit('automation', msg);
        }
        break;
    }
  }
}

// ---- bundle 打包 ----

/**
 * 把 main.py 文本 + droidtaskflow.py 文本打成 zip（uint8array）。
 * 不依赖 Pyodide；纯前端即可。
 */
export async function buildProjectBundle({ mainPyText, dtfPyText }) {
  const zip = new JSZip();
  zip.file('main.py', mainPyText);
  zip.file('droidtaskflow.py', dtfPyText || '# stub');
  return await zip.generateAsync({ type: 'uint8array' });
}

// ---- 工具 ----

export function bytesToBase64(uint8) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < uint8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, uint8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ---- 持久化 ----

const LS_BACKENDS = 'dtf:backends';
const LS_SELECTED = 'dtf:selected_backend';

export function loadBackends() {
  try { return JSON.parse(localStorage.getItem(LS_BACKENDS) || '[]'); }
  catch (_) { return []; }
}

export function saveBackends(list) {
  localStorage.setItem(LS_BACKENDS, JSON.stringify(list));
}

export function getSelectedBackendId() {
  return localStorage.getItem(LS_SELECTED) || '';
}

export function setSelectedBackendId(id) {
  localStorage.setItem(LS_SELECTED, id);
  // 通知依赖"选中后端"的面板（自动化等）重估可用性
  window.dispatchEvent(new CustomEvent('dtf:backend-selected'));
}
