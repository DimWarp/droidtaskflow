// 后端与设备面板：列表 / 状态 / + 添加按钮 / 重试 / 删除。
// 这是 sidebar.js 的扩展模块；保持 sidebar.js 不动。

import { t } from './i18n.js';
import {
  BackendClient,
  loadBackends,
  saveBackends,
  getSelectedBackendId,
  setSelectedBackendId,
  replaceWirelessDevices,
} from './backend-client.js';
import { openAddBackendDialog, openEditBackendDialog } from './backend-dialog.js';
import { openWifiPairDialog } from './wifi-pair-dialog.js';
import { openWifiDiscoverDialog } from './wifi-discover-dialog.js';
import { state, toast, setSelectedDevice, setDeviceList, loadSelectedDeviceFromStorage, getFocus } from './state.js';
import { setActiveSerial as setDevicePreviewSerial, setActiveClient as setDevicePreviewClient } from './device-preview.js';

const _clients = new Map(); // id → BackendClient

// 自动发现：加载页面后按顺序探测本地常见端口
const DISCOVERY_PORTS = [8765, 8766, 8767];
const DISCOVERY_RETRIES = 3;
const DISCOVERY_TIMEOUT_MS = 1000;

export function initBackendsPanel() {
  const btn = document.getElementById('btnAddBackend');
  if (btn) btn.onclick = onAddClick;
  loadSelectedDeviceFromStorage();   // M1: 还原上次选中的 device
  refreshBackends();
  restoreBackends();
  // M2: 把当前 active backend + serial 推到 device-preview
  const sel = getSelectedBackendId();
  if (sel) {
    const serial = state.selectedDeviceByBackend[sel] || null;
    setDevicePreviewSerial(serial);
    setDevicePreviewClient(_clients.get(sel) || null);
  }
}

/**
 * 页面加载完成后自动探测本地后端。
 * 仅当用户尚未保存任何 backend 时执行（避免给老用户重复添加）。
 * 顺序尝试 DISCOVERY_PORTS，每个端口重试 DISCOVERY_RETRIES 次，每次超时 DISCOVERY_TIMEOUT_MS。
 * 命中后：注册为新 backend、设为选中、刷新 sidebar。
 * @returns {Promise<string|null>} 命中时返回新 backend id，否则 null。
 */
export async function autoDiscoverLocalBackends() {
  if (loadBackends().length > 0) return null;

  for (const port of DISCOVERY_PORTS) {
    for (let attempt = 1; attempt <= DISCOVERY_RETRIES; attempt++) {
      if (await _probeHealth('localhost', port)) {
        return _registerDiscovered('localhost', port);
      }
    }
  }
  return null;
}

async function _probeHealth(host, port) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const r = await fetch(`http://${host}:${port}/health`, {
      mode: 'cors',
      signal: ctrl.signal,
    });
    if (!r.ok) return false;
    const body = await r.json();
    return body && body.ok === true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function _registerDiscovered(host, port) {
  const id = crypto.randomUUID();
  const name = `Local :${port}`;
  const list = loadBackends();
  list.push({ id, name, host, port });
  saveBackends(list);
  setSelectedBackendId(id);
  const cli = new BackendClient({ host, port, name });
  cli._autoConnect = true;
  _clients.set(id, cli);
  bindClientEvents(id, cli);
  cli.connect().catch(() => syncRunBtn());
  refreshBackends();
  return id;
}

function onAddClick() {
  openAddBackendDialog().then((r) => {
    if (!r) return;
    const id = crypto.randomUUID();
    const list = loadBackends();
    list.push({ id, name: r.name, host: r.host, port: r.port });
    saveBackends(list);
    setSelectedBackendId(id);
    // 对话框不再 connect；创建 disconnected client 与 restoreBackends 风格一致,
    // 用户通过 sidebar 行内的"连接"按钮触发实际连接
    const cli = new BackendClient({ host: r.host, port: r.port, name: r.name });
    _clients.set(id, cli);
    bindClientEvents(id, cli);
    refreshBackends();
  });
}

function bindClientEvents(id, cli) {
  cli.on('state', () => {
    // 4003 = "后端已被占用"（ws.py CLOSE_ALREADY_CONNECTED）
    if (cli.state === 'disconnected' && cli.closeCode === 4003) {
      if (cli._autoConnect) {
        toast(t('toast.backendBusyAuto'));
      } else {
        showBusyBackendDialog(id);
      }
    }
    // 任何断开都清掉该 backend 下的设备列表 (device dot 显示的是 WS 上次
    // 收到的 state; WS 断后 device 数据失真, 应该归零)。reconnect 时
    // handshake 会重新触发 device_scan_req 把列表填回来。
    if (cli.state === 'disconnected') {
      setDeviceList(id, []);
    }
    // M5: 连接建立后通知自动化面板拉取任务/历史快照
    if (cli.state === 'connected') {
      window.dispatchEvent(new CustomEvent('dtf:backend-connected'));
    }
    refreshBackends();
  }).on('error', () => refreshBackends());

  // M1: 收到 device_scan / device_scan_req:reply → 更新 state + 重渲染
  cli.setDeviceScanHandler((devices) => {
    setDeviceList(id, devices);
    refreshBackends();
  });

  // M9c: 收到 backend_caps → 存到 state + 重渲染（控制"添加无线设备"按钮）
  cli.setBackendCapsHandler((msg) => {
    state.adbPairSupportedByBackend[id] = !!msg.adb_pair_supported;
    refreshBackends();
  });

  // M9e: 收到 pair_supported → 拉一次后端持久化记录。后端启动时会自动 connect，
  // 我们同步一份到本地 LS 让 UI 显示编辑按钮、记录条数；后续后端 push 变更会
  // 走 setWirelessDevicesListHandler 自动同步。
  cli.on('state', () => {
    if (cli.state === 'connected' && state.adbPairSupportedByBackend[id] === true) {
      cli.requestWirelessDevicesList();
    }
  });

  // M9: 无线配对 / 断开 reply handler（覆盖式，与 power / screenshot 同模式）
  _wireWifiHandlers(cli);
}

function showBusyBackendDialog(backendId) {
  const dialog = document.getElementById('busyBackendDialog');
  if (!dialog) return;
  dialog.classList.remove('startup-dialog--hidden');

  const cleanup = () => {
    dialog.classList.add('startup-dialog--hidden');
    document.getElementById('busyBackendConfirm').removeEventListener('click', onConfirm);
    document.getElementById('busyBackendCancel').removeEventListener('click', onCancel);
  };

  const onConfirm = async () => {
    cleanup();
    const b = loadBackends().find(x => x.id === backendId);
    if (!b) return;
    try {
      await fetch(`http://${b.host}:${b.port}/force-disconnect`, { method: 'POST', mode: 'cors' });
    } catch (_) { /* 忽略网络错误，直接重试连接 */ }
    reconnect(backendId);
  };

  const onCancel = () => {
    cleanup();
  };

  document.getElementById('busyBackendConfirm').addEventListener('click', onConfirm);
  document.getElementById('busyBackendCancel').addEventListener('click', onCancel);
}

function renderDeviceList(backendId, li) {
  const devices = (state.deviceListByBackend && state.deviceListByBackend[backendId]) || [];
  const selectedSerial = state.selectedDeviceByBackend[backendId];
  // Remove old device list if any
  const old = li.querySelector('.device-list');
  if (old) old.remove();
  if (!devices.length) return;

  const ul = document.createElement('ul');
  ul.className = 'device-list';
  for (const d of devices) {
    const item = document.createElement('li');
    item.className = 'device-list__item' +
      (d.serial === selectedSerial ? ' device-list__item--selected' : '');
    item.dataset.serial = d.serial;

    const dot = document.createElement('span');
    dot.className = 'device-list__dot';
    dot.dataset.state = d.state;   // 'device' | 'offline' | 'unauthorized'

    const lbl = document.createElement('span');
    lbl.className = 'device-list__label';
    lbl.textContent = d.serial;

    item.appendChild(dot);
    item.appendChild(lbl);

    // M9: 设备条目 hover 按钮组（与 .backend-actions 同款：包容器 + 子按钮 flex 排列 + 渐变遮罩）。
    // 视觉顺序（从左到右）：连接/断开 → 编辑 → 删除 → 复制。
    // USB 设备只显示复制按钮。
    // 判断无线：serial 是 adb 给的 "IP:PORT" 格式（如 192.168.1.10:5555）。
    // M9c: 老 adb 不支持 pair 时无线设备路径走不通 — 也不显示无线专用按钮（避免误导）。
    const isWireless = /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(d.serial)
        && state.adbPairSupportedByBackend[backendId] === true;

    const actions = document.createElement('span');
    actions.className = 'device-list__actions';

    if (isWireless) {
        // 1) 连接/断开：在线（state=device）显示断开（X），离线（offline）显示连接（插头）。
        const toggleBtn = document.createElement('button');
        if (d.state === 'device') {
            // 断开（X 图标，与后端 disconnect 同款）— 仅 adb disconnect，保留持久化记录
            // （再点"连接"按钮可重新连上）；与"删除"按钮的区别：不删持久化记录。
            toggleBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            toggleBtn.dataset.tooltip = 'backend.wifiDisconnectDevice';
            toggleBtn.onclick = (e) => {
                e.stopPropagation();
                const cli = _clients.get(backendId);
                if (!cli || cli.state !== 'connected') return;
                if (!cli.requestDeviceDisconnect(d.serial)) {
                    toast(t('backend.wifiDisconnectErr'));
                }
            };
        } else {
            // 连接（插头图标，与后端 connect 同款）— 从 serial 解析 ip:port
            toggleBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8z"/><path d="M12 17v4"/></svg>';
            toggleBtn.dataset.tooltip = 'backend.wifiConnect';
            toggleBtn.onclick = (e) => {
                e.stopPropagation();
                const [ip, portStr] = d.serial.split(':');
                const port = parseInt(portStr, 10);
                const cli = _clients.get(backendId);
                if (!cli || cli.state !== 'connected') {
                    toast(t('backend.wifiConnectErr'));
                    return;
                }
                if (!cli.requestDeviceConnectWifi(ip, port)) {
                    toast(t('backend.wifiConnectErr'));
                }
            };
        }
        actions.appendChild(toggleBtn);

        // 2) 编辑
        const wifiEdit = document.createElement('button');
        // 铅笔图标 — 与 edit backend 按钮同款 SVG，10x10 风格统一
        wifiEdit.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
        wifiEdit.dataset.tooltip = 'backend.wifiEdit';
        wifiEdit.onclick = (e) => {
            e.stopPropagation();
            _editWifiDevice(backendId, d.serial);
        };
        actions.appendChild(wifiEdit);

        // 3) 删除
        const wifiDel = document.createElement('button');
        // 垃圾桶图标 — 与 backend 删除按钮同款 SVG，10x10 风格统一
        wifiDel.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
        wifiDel.dataset.tooltip = 'backend.wifiDisconnect';
        wifiDel.onclick = (e) => {
            e.stopPropagation();
            // 离线设备跳过 adb disconnect（设备不在 tracker 里，disconnect 命令无意义且会失败），
            // handler 内部根据 state 决定是否实际发 adb disconnect 帧。
            _disconnectWifiDevice(backendId, d.serial, d.state);
        };
        actions.appendChild(wifiDel);
    }

    // 4) 复制（无线 + USB 都显示；最右）
    const copyBtn = document.createElement('button');
    copyBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    copyBtn.dataset.tooltip = 'tooltip.copySerial';
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(d.serial).then(() => toast(t('toast.copiedPlain')));
    };
    actions.appendChild(copyBtn);

    item.appendChild(actions);

    item.onclick = (e) => {
      e.stopPropagation();
      if (state.selectedDeviceByBackend[backendId] === d.serial) {
        // 已选中的设备再次点击 → 取消选中（父后端保持选中）
        setSelectedDevice(backendId, null);
        if (state.devicePreview.serial === d.serial) setDevicePreviewSerial(null);
      } else {
        // M1: 选中设备 → 同时把父后端也设为选中（与"点击设备＝跑在设备上"的语义一致）
        setSelectedDevice(backendId, d.serial);
        setSelectedBackendId(backendId);
        // 清掉其他后端选中的设备 — 全局只允许 1 个蓝底，否则跨后端点设备时
        // 旧后端的选中设备仍保留 selected class（视觉漏清）。
        _clearSelectedDevicesExcept(backendId);
        // M2: 同步 device preview widget
        setDevicePreviewSerial(d.serial);
        setDevicePreviewClient(_clients.get(backendId) || null);
      }
      refreshBackends();
      syncRunBtn();
    };
    ul.appendChild(item);
  }
  li.appendChild(ul);
}


// 切到 backendId 后，把其他后端的 selected device 也清掉（保持全局唯一蓝底）。
// 复用于：点后端 li 切后端、点设备 item 跨后端切设备。
// 走 setSelectedDevice(_, null) 同步写 LS，避免"页面看蓝底没了但 LS 还残留"。
function _clearSelectedDevicesExcept(backendId) {
  for (const key of Object.keys(state.selectedDeviceByBackend)) {
    if (key !== backendId) setSelectedDevice(key, null);
  }
}

function refreshBackends() {
  const list = loadBackends();
  const sel = getSelectedBackendId();
  const ul = document.getElementById('backendList');
  const stub = document.getElementById('backendStubHint');
  if (!ul) return;
  ul.innerHTML = '';
  if (list.length === 0) {
    if (stub) stub.hidden = false;
    return;
  }
  if (stub) stub.hidden = true;
  for (const b of list) {
    const li = document.createElement('li');
    li.className = 'backend-item' + (sel === b.id ? ' backend-item--selected' : '');
    li.dataset.id = b.id;

    // M1: tree 布局——把 dot/label/actions 装进一行内层 flex 行；
    // 让 renderDeviceList 追加的 <ul class="device-list"> 自然落到这一行下面。
    const row = document.createElement('div');
    row.className = 'backend-item__row';

    const dot = document.createElement('span');
    dot.className = 'backend-dot';
    const c = _clients.get(b.id);
    // 注意：必须叫 connState,不能叫 state — 否则会 shadow 模块顶部 import 的 state 对象,
    // 导致下方 li.onclick 闭包内 `state.selectedDeviceByBackend[b.id]` 报错
    // (字符串没有 selectedDeviceByBackend 属性 → undefined → undefined[uuid] 抛错)
    const connState = c ? c.state : 'disconnected';
    dot.dataset.state = connState;

    const label = document.createElement('span');
    label.className = 'backend-label';
    label.textContent = b.name || `${b.host}:${b.port}`;

    row.appendChild(dot);
    row.appendChild(label);

    const actions = document.createElement('span');
    actions.className = 'backend-actions';

    // 连接/断开按钮移到第一个（最左）。
    // 连接/断开互斥：连接仅在 disconnected 出现；断开仅在 connected 出现。
    // 设备条目 hover 时显示的"断开无线设备"按钮复用同一对插头/X 图标，视觉一致。
    if (connState === 'connected') {
      const disconnect = document.createElement('button');
      // X 图标 (叉叉) — 与编辑/删除按钮同款 SVG, 风格统一
      disconnect.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      disconnect.dataset.tooltip = 'tooltip.disconnect';
      disconnect.onclick = (e) => { e.stopPropagation(); disconnectBackend(b.id); };
      actions.appendChild(disconnect);
    }

    if (connState === 'disconnected') {
      const connect = document.createElement('button');
      // 插头图标 — 与设备条目 wifi-toggle 同款
      connect.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8z"/><path d="M12 17v4"/></svg>';
      connect.dataset.tooltip = 'tooltip.connect';
      connect.onclick = (e) => { e.stopPropagation(); reconnect(b.id); };
      actions.appendChild(connect);
    }

    // 编辑：所有状态都允许（断开后也能改 host/port/name 再重连）。
    const edit = document.createElement('button');
    edit.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
    edit.dataset.tooltip = 'tooltip.edit';
    edit.onclick = (e) => { e.stopPropagation(); editBackend(b.id); };
    actions.appendChild(edit);

    if (connState === 'connected') {
      // M9: 添加无线设备按钮（+ 图标）。仅在已连接 + 后端 adb 支持 `adb pair`（Platform Tools 31+）时显示。
      // 老 adb 没 adb pair 命令 → 不显示按钮（用户升级 adb 之前用不了）。
      const pairSupported = state.adbPairSupportedByBackend[b.id] === true;
      if (pairSupported) {
        const wifi = document.createElement('button');
        wifi.className = 'backend-actions__wireless';
        // + 图标 — 与现有按钮同款 10x10 SVG，stroke 风格一致
        wifi.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
        wifi.dataset.tooltip = 'backend.addWireless';
        wifi.onclick = (e) => { e.stopPropagation(); _openWifiPairForBackend(b); };
        actions.appendChild(wifi);
      }
    }

    const del = document.createElement('button');
    del.className = 'backend-actions__delete';
    del.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
    del.dataset.tooltip = 'tooltip.delete';
    del.onclick = async (e) => {
      e.stopPropagation();
      const ok = await new Promise(resolve => {
        let done = false;
        const finish = (val) => { if (done) return; done = true; overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
        const onKey = (ev) => { if (ev.key === 'Escape') finish(false); };
        const overlay = document.createElement('div');
        overlay.className = 'startup-dialog';
        overlay.innerHTML = `<div class="startup-dialog__card"><h2 class="startup-dialog__title">${t('backend.deleteTitle')}</h2><p class="startup-dialog__msg">${t('backend.deleteMsg', { name: b.name || b.host + ':' + b.port })}</p><div class="startup-dialog__actions startup-dialog__actions--row" style="gap:8px;justify-content:flex-end;"><button class="startup-btn" data-act="cancel">${t('dialog.cancel')}</button><button class="startup-btn startup-btn--danger" data-act="ok">${t('dialog.delete')}</button></div></div>`;
        overlay.addEventListener('click', (ev) => {
          if (ev.target.dataset.act === 'ok') finish(true);
          else if (ev.target.dataset.act === 'cancel' || ev.target === overlay) finish(false);
        });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
      });
      if (!ok) return;
      removeBackend(b.id);
    };
    actions.appendChild(del);

    row.appendChild(actions);
    li.appendChild(row);

    li.onclick = () => {
      if (getSelectedBackendId() === b.id) {
        // 已选中的后端再次点击 → 取消选中，其下选中的设备一并取消选中
        const wasSerial = state.selectedDeviceByBackend[b.id] || null;
        setSelectedBackendId('');
        setSelectedDevice(b.id, null);
        setDevicePreviewClient(null);
        if (state.devicePreview.serial === wasSerial) setDevicePreviewSerial(null);
      } else {
        setSelectedBackendId(b.id);
        // 清除其他后端的设备选中 UI：切后端时只有当前后端的设备可以是选中态
        _clearSelectedDevicesExcept(b.id);
        // M2: 切换 active backend 时同步 client；device serial 沿用 state 中的值或 null
        const serial = state.selectedDeviceByBackend[b.id] || null;
        setDevicePreviewSerial(serial);
        setDevicePreviewClient(_clients.get(b.id) || null);
      }
      refreshBackends();
      syncRunBtn();
    };
    ul.appendChild(li);
    // M1: device sub-list under this backend
    renderDeviceList(b.id, li);
  }
  syncRunBtn();
}

export function syncRunBtn() {
  const btn = document.getElementById('btnRun');
  if (!btn) return;
  // 悬浮提示统一走 #btnRun 的自定义 data-tooltip="tooltip.run"，不再设原生 title
  // （否则原生 + 自定义两层同时触发）。disabled 态提示随之移除。
  const overlay = document.getElementById('projectOverlay');
  if (overlay && !overlay.classList.contains('project-overlay--hidden')) {
    btn.disabled = true; return;
  }
  // 统一焦点判定：后端+设备均非 null 且均可用 → 启用，否则禁用。
  const id = getSelectedBackendId();
  const f = getFocus(id, id ? _clients.get(id) : null);
  btn.disabled = !f.ready;
}

function restoreBackends() {
  for (const b of loadBackends()) {
    const cli = new BackendClient({ host: b.host, port: b.port, name: b.name });
    cli._autoConnect = true;
    _clients.set(b.id, cli);
    bindClientEvents(b.id, cli);
    cli.connect().catch(() => syncRunBtn());
  }
  syncRunBtn();
}

export function reconnect(id) {
  const b = loadBackends().find((x) => x.id === id);
  if (!b) return;
  const old = _clients.get(id);
  if (old) old.close();
  const cli = new BackendClient({ host: b.host, port: b.port, name: b.name });
  _clients.set(id, cli);
  bindClientEvents(id, cli);
  cli.connect().catch(() => syncRunBtn());
  refreshBackends();
  // device-preview 缓存了旧 client 引用,新建 client 后要重新同步过去,
  // 否则 reconnect/disconnect/editBackend 后 device-preview 的截图按钮态会卡死
  if (id === getSelectedBackendId()) setDevicePreviewClient(cli);
}

function disconnectBackend(id) {
  const cli = _clients.get(id);
  if (cli) cli.close();
  // 清除该后端下的设备选中状态
  const wasSerial = state.selectedDeviceByBackend[id];
  delete state.selectedDeviceByBackend[id];
  if (wasSerial && state.devicePreview.serial === wasSerial) {
    setDevicePreviewSerial(null);
  }
  refreshBackends();
  syncRunBtn();
}

export function editBackend(id) {
  const list = loadBackends();
  const b = list.find((x) => x.id === id);
  if (!b) return;
  openEditBackendDialog({ host: b.host, port: b.port, name: b.name || '' }).then((r) => {
    if (!r) return;
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return;
    list[idx] = { ...list[idx], host: r.host, port: r.port, name: r.name };
    saveBackends(list);
    // 只持久化配置:不断开现有连接,也不创建新连接。
    // 用户通过 sidebar 行内"连接"按钮触发实际连接。
    refreshBackends();
  });
}

function removeBackend(id) {
  const cli = _clients.get(id);
  if (cli) cli.close();
  _clients.delete(id);
  // 清除该后端下的设备选中状态
  const wasSerial = state.selectedDeviceByBackend[id];
  delete state.selectedDeviceByBackend[id];
  if (wasSerial && state.devicePreview.serial === wasSerial) {
    setDevicePreviewSerial(null);
  }
  const list = loadBackends().filter((x) => x.id !== id);
  saveBackends(list);
  if (getSelectedBackendId() === id) setSelectedBackendId(list[0] ? list[0].id : '');
  refreshBackends();
}

// M9: 给指定后端打开无线配对弹窗。
// 弹窗返回字段后：
//   - 只填了 ip+connect_port → requestDeviceConnectWifi（仅 adb connect）
//   - 都填全 → requestDevicePair（adb pair + adb connect）
// 两条路径都把 (ip, connect_port) 写入后端持久化记录，让下次 backend 重启能自动重连。
// 用户点"尝试发现设备"时走 mDNS 扫描 → 弹出"发现的设备"列表 → 选一个 → 预填 IP + 端口。
async function _openWifiPairForBackend(b, initial = null) {
    const client = _clients.get(b.id);
    if (!client || client.state !== 'connected') return;   // 防御性：按钮只在 connected 显示
    const backendName = b.name || `${b.host}:${b.port}`;
    const fields = await openWifiPairDialog({ backendName, initial });
    if (!fields) return;   // 用户取消

    if (fields.discover) {
        // 触发一次 mDNS 扫描 → 弹出设备列表 → 用户选一个 → 预填 IP + 两个端口重新打开主弹窗
        const reply = await new Promise((resolve) => {
            client.setDeviceMdnsScanHandler((msg) => {
                client.setDeviceMdnsScanHandler(null);   // 一次性：清掉防泄漏
                resolve(msg);
            });
            if (!client.requestDeviceMdnsScan()) {
                client.setDeviceMdnsScanHandler(null);
                resolve(null);
            }
        });
        const services = (reply && reply.services) || [];
const picked = await openWifiDiscoverDialog(services);
        if (!picked) return;   // 用户取消选择
        // mDNS 报的端口 = Android 11+ 同端口（连/配对都用它）。
        // 但配对码 (pair) 在很多设备上端口不同（尤其 Android 12+），所以 pairPort 让用户自己填。
        return _openWifiPairForBackend(b, {
            ip: picked.address,
            connectPort: picked.port,
        });
    }

    if (fields.onlyConnect) {
        if (!client.requestDeviceConnectWifi(fields.ip, fields.connectPort)) {
            toast(t('backend.wifiConnectErr'));
            return;
        }
        // 写持久化：哪怕设备暂时连不上，下次重启 backend 还会再尝试重连
        client.requestWirelessDeviceAdd(fields.ip, fields.connectPort);
        return;
    }

    if (!client.requestDevicePair(fields.ip, fields.pairPort, fields.connectPort, fields.code)) {
        toast(t('backend.wifiPairErr'));
        return;
    }
    // pair 路径也写持久化（pair 成功后设备立即出现在 tracker；失败 reply 不影响记录写入）
    client.requestWirelessDeviceAdd(fields.ip, fields.connectPort);
}

// M9e: 编辑现有无线设备（复用 openWifiPairDialog 弹窗，预填 ip + connect_port）。
// 用户点"连接"后：
//   - 只填了 ip+connect_port → 走 connect（设备已配对过这台 host，重连）
//   - 填了 pair 字段 → 走 pair（无线配对可能失效 → 重新配对）
async function _editWifiDevice(backendId, serial) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(serial);
    if (!m) return;
    const ip = m[1];
    const connectPort = parseInt(m[2], 10);
    const b = loadBackends().find(x => x.id === backendId);
    if (!b) return;
    const client = _clients.get(backendId);
    if (!client || client.state !== 'connected') return;
    await _openWifiPairForBackend(b, { ip, connectPort });
}

// M9e: 从持久化记录里移除某个无线设备（不主动 disconnect — 设备层操作交给
// 垃圾桶按钮 / device preview 的"删除无线设备"流程）。
function _forgetWifiDevice(backendId, ip, connectPort) {
    const client = _clients.get(backendId);
    if (!client || client.state !== 'connected') {
        toast(t('backend.wifiForgetErr'));
        return;
    }
    if (!client.requestWirelessDeviceRemove(ip, connectPort)) {
        toast(t('backend.wifiForgetErr'));
    }
}

// M9: 断开无线设备（adb disconnect <serial>）。
// 同步从后端持久化记录里移除该 IP+port — "删除无线设备"按钮的语义是
// 用户已不打算再用这台无线设备，所以同时把记录清掉，下次 backend 重启不会再自动重连。
// state=device → adb disconnect + 删持久化
// state=offline → 仅删持久化（不调 adb disconnect：设备根本不在 tracker 里，命令会失败且没意义）
async function _disconnectWifiDevice(backendId, serial, state = 'offline') {
    const client = _clients.get(backendId);
    if (!client || client.state !== 'connected') return;
    const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(serial);
    if (m) {
        // 删持久化是同步帧（request* 内部仅 send_text，server 端 remove 同步执行 + 推 push/device_scan）。
        // UI 刷新依赖后端 push 的 device_scan 帧，handler 里 toast 即可。
        client.requestWirelessDeviceRemove(m[1], parseInt(m[2], 10));
    }
    if (state === 'device') {
        if (!client.requestDeviceDisconnect(serial)) {
            toast(t('backend.wifiDisconnectErr'));
        }
        // 在线：setDeviceDisconnectHandler 的 ok=true 回调会 toast "已断开无线设备"，这里不重复
    } else {
        // 离线：没有 adb disconnect reply 触发 toast，这里 toast "已从记录中移除" 给用户反馈
        toast(t('backend.wifiForgetOk'));
    }
}

// M9: 注册 pair / disconnect / connect_wifi reply handler（覆盖式），给后端行用。
// 应在 client 注册到 panel 时调用（bindClientEvents）。
function _wireWifiHandlers(client) {
    client.setDevicePairHandler((msg) => {
        if (msg && msg.ok) {
            toast(t('backend.wifiPairOk'));
            // 设备列表会通过 _pump_device_events → device_scan 自动刷新，无需手动
        } else {
            toast(t('backend.wifiPairErr') + ': ' + (msg && msg.error ? msg.error : 'unknown'));
        }
    });
    client.setDeviceConnectWifiHandler((msg) => {
        if (msg && msg.ok) {
            toast(t('backend.wifiConnectOk'));
        } else {
            toast(t('backend.wifiConnectErr') + ': ' + (msg && msg.error ? msg.error : 'unknown'));
        }
    });
    client.setDeviceDisconnectHandler((msg) => {
        if (msg && msg.ok) {
            toast(t('backend.wifiDisconnectOk'));
        } else {
            toast(t('backend.wifiDisconnectErr') + ': ' + (msg && msg.error ? msg.error : 'unknown'));
        }
    });
    client.setWirelessDevicesListHandler((msg) => {
        // 收到 list-reply 或后端 push → 用最新列表覆盖本地 LS 视图缓存
        const id = client.id;   // BackendClient 自己的 id 是生成后不变的
        // 这里取 client.id 即可（client 是 backend 实例），但 backend-panel 里
        // bindClientEvents 拿不到外部 backendId —— 改为直接用 client.id
        const list = (msg && msg.devices) || [];
        replaceWirelessDevices(id, list);
    });
}

export function getClientById(id) {
  return _clients.get(id);
}
