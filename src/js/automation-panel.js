/* ============================================================
   AUTOMATION PANEL — 侧栏"自动化"区
   任务列表 + 运行历史 + 任务编辑弹窗，经 WS 与后端自动化 hub 交互。

   复用打包链路：toPythonDSL + generateDroidtaskflowPy + buildProjectBundle
   （与 onRunClick 一致，纯前端无需 Pyodide）。
   ============================================================ */
import JSZip from 'jszip';
import { state, toast } from './state.js';
import { getSelectedBackendId, buildProjectBundle, bytesToBase64 } from './backend-client.js';
import { getClientById } from './backend-panel.js';
import { generateDroidtaskflowPy } from './datamapper.js';
import { t, onLanguageChange } from './i18n.js';
import { getDirHandle, listProjectFiles, getProjectName, readProjectSource } from './filesystem.js';
import { parseAnsi } from './console-panel.js';
import { createCopyMenu } from './copy-menu.js';

const MSG = {
  LIST_REQ: 'automation_task_list_req',
  ADD: 'automation_task_add',
  UPDATE: 'automation_task_update',
  REMOVE: 'automation_task_remove',
  ENABLE: 'automation_task_enable',
  RUN_NOW: 'automation_run_now',
  HISTORY_REQ: 'automation_history_req',
  TASK_LIST: 'automation_task_list',
  TASK_ADDED: 'automation_task_added',
  TASK_UPDATED: 'automation_task_updated',
  TASK_REMOVED: 'automation_task_removed',
  RUN_STARTED: 'automation_run_started',
  QUEUED: 'automation_run_queued',
  UNQUEUED: 'automation_run_unqueued',
  EXIT: 'automation_exit',
  HISTORY_LIST: 'automation_history_list',
  LOG_READ_REQ: 'automation_log_read_req',
  LOG_READ: 'automation_log_read',
  LOG_DELETE: 'automation_log_delete',
  LOG_DELETED: 'automation_log_deleted',
};

const STATUS_KEYS = {
  running: 'automation.statusRunning',
  queued: 'automation.statusQueued',
  success: 'automation.statusSuccess',
  failed: 'automation.statusFailed',
  canceled: 'automation.statusCanceled',
  timeout: 'automation.statusTimeout',
  skipped: 'automation.statusSkipped',
};

let _tasks = [];
let _history = [];
let _activeRuns = new Map();   // run_id -> task_id，用于标记"运行中"
let _queuedRuns = new Map();   // run_id -> task_id，用于标记"排队中"
// 运行历史弹窗：入口在每任务卡片"立即运行 / 编辑"之间，按 task_id 拉取该任务历史
let _historyDialogTaskId = null;   // 当前打开的历史弹窗所属任务
let _historyDialogTaskName = '';   // 所属任务名（日志弹窗标题用）
let _dialogRuns = [];
let _histRoot = null;
let _histOnKey = null;
// 运行日志弹窗：历史弹窗每行"查看日志"按钮 → 弹出可滚动查看的日志框。
// 日志按需从后端读取（历史列表不带内容），多设备时顶部标签页切换各设备日志。
let _logRoot = null;
let _logCopyMenu = null;
let _logOnKey = null;
let _logPendingRun = null;   // 正在等待日志读取结果的 run_id
let _logData = [];           // [{device_id, exists, lines}] 当前弹窗日志数据
let _logActiveTab = 0;       // 当前激活的设备标签索引
// 删除日志确认弹窗
let _delRoot = null;
let _delOnKey = null;
// 保存请求关联：req_id 由后端回显在 added/updated/error 帧里，确认"这次保存"成功才收尾
let _pendingReqId = null;
let _pendingTimer = null;      // 保存超时定时器
let _editorIsEdit = false;     // 当前弹窗是新建还是编辑（决定成功 toast 文案）
let _saveSeq = 0;              // 本会话内保存请求递增序号

export function initAutomationPanel() {
  const btn = document.getElementById('btnAddAutomationTask');
  if (btn) btn.addEventListener('click', () => openEditor(null));

  // 后端连接建立 → 拉任务 + 历史快照；切换选中后端 → 重估可用性 + 刷新
  window.addEventListener('dtf:backend-connected', refreshAll);
  window.addEventListener('dtf:backend-selected', refreshAll);
  // 中英文切换：卡片/历史弹窗文案全走 t()，用内存数据重渲染（无需回后端）
  onLanguageChange(() => {
    renderAvailability();
    renderHistoryDialog();
  });

  _subscribe();
  renderAvailability();   // 未连接/未选中后端 → 显示"请连接并选择一个后端"
  refreshAll();
}

/* ============================================================
   客户端订阅 / 刷新
   ============================================================ */

let _testClient = null;

function _getClient() {
  if (_testClient) return _testClient;
  const id = getSelectedBackendId();
  if (!id) return null;
  return getClientById(id) || null;
}

function _subscribe() {
  const cli = _getClient();
  if (!cli || cli._automationHooked) return;
  cli._automationHooked = true;
  cli.on('automation', _onMessage);
  cli.on('error', _onClientError);   // 保存失败：后端校验/处理错误帧
  cli.on('state', _onClientState);   // 保存失败：后端断开
}

function refreshAll() {
  _subscribe();
  refreshTasks();
  refreshHistory();
  renderAvailability();
}

function refreshTasks() {
  const cli = _getClient();
  if (cli && cli.state === 'connected') cli.sendRaw({ type: MSG.LIST_REQ });
}

function refreshHistory(taskId) {
  const cli = _getClient();
  if (cli && cli.state === 'connected') {
    const payload = { type: MSG.HISTORY_REQ, limit: 50 };
    if (taskId) payload.task_id = taskId;   // 任务级历史 → 供历史弹窗
    cli.sendRaw(payload);
  }
}

function _onMessage(msg) {
  switch (msg.type) {
    case MSG.TASK_LIST:
      _tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
      renderTasks();
      break;
    case MSG.TASK_ADDED:
    case MSG.TASK_UPDATED:
      _upsertTask(msg.task);
      renderTasks();
      _checkSaveAck(msg);
      break;
    case MSG.TASK_REMOVED:
      _tasks = _tasks.filter(x => x.id !== msg.task_id);
      renderTasks();
      break;
    case MSG.RUN_STARTED:
      _activeRuns.set(msg.run_id, msg.task_id);
      renderTasks();
      break;
    case MSG.QUEUED:
      _queuedRuns.set(msg.run_id, msg.task_id);
      renderTasks();
      break;
    case MSG.UNQUEUED:
      _queuedRuns.delete(msg.run_id);
      renderTasks();
      break;
    case MSG.EXIT:
      _activeRuns.delete(msg.run_id);
      _queuedRuns.delete(msg.run_id);
      refreshHistory();
      // 历史弹窗开着且是本任务 → 顺带刷新弹窗数据
      if (_historyDialogTaskId && _historyDialogTaskId === msg.task_id) refreshHistory(_historyDialogTaskId);
      renderTasks();
      break;
    case MSG.HISTORY_LIST:
      if (_historyDialogTaskId && msg.task_id === _historyDialogTaskId) {
        // 任务级历史响应 → 弹窗
        _dialogRuns = Array.isArray(msg.runs) ? msg.runs : [];
        renderHistoryDialog();
      } else {
        _history = Array.isArray(msg.runs) ? msg.runs : [];
        renderTasks(); // 上次结果可能变化
      }
      break;
    case MSG.LOG_READ:
      if (_logPendingRun === msg.run_id) {
        _logData = Array.isArray(msg.logs) ? msg.logs : [];
        _logActiveTab = 0;
        renderLogContent();
      }
      break;
    case MSG.LOG_DELETED:
      toast(t('automation.logDeleted'));
      // 本地同步：该条历史记录已删（含日志），弹窗与任务卡片"上次结果"同步移除
      _dialogRuns = _dialogRuns.filter(r => r.run_id !== msg.run_id);
      _history = _history.filter(r => r.run_id !== msg.run_id);
      renderHistoryDialog();
      renderTasks();
      break;
    default:
      break;
  }
}

function _upsertTask(task) {
  const i = _tasks.findIndex(x => x.id === task.id);
  if (i >= 0) _tasks[i] = task; else _tasks.push(task);
}

/* ============================================================
   保存 ack 关联：req_id 由后端回显在 added/updated/error 帧，
   "这次保存"成功（closeEditor+toast）或失败（保持弹窗+提示）才收尾。
   ============================================================ */

function _checkSaveAck(msg) {
  if (_pendingReqId && msg.req_id === _pendingReqId) _saveSuccess();
}

function _onClientError(msg) {
  if (_pendingReqId && msg.req_id === _pendingReqId) {
    _saveFail(_pendingReqId, t('automation.saveError', { msg: msg.message || '' }));
  }
}

function _onClientState(s) {
  renderAvailability();   // 连接/断开 → 自动化区可用性随之变化
  if (s === 'disconnected') _closeHistoryDialog();   // 断开发挥弹窗里的过期历史
  if (_pendingReqId && s === 'disconnected') {
    _saveFail(_pendingReqId, t('automation.saveDisconnected'));
  }
}

function _saveSuccess() {
  const isEdit = _editorIsEdit;
  clearPendingSave();
  _closeEditor();
  toast(t(isEdit ? 'automation.taskUpdated' : 'automation.taskAdded'));
}

function _saveFail(reqId, message) {
  if (_pendingReqId !== reqId) return;   // 已过期（弹窗已关 / 被更新保存覆盖）
  clearPendingSave();
  const saveBtn = document.getElementById('ae-save');
  if (saveBtn) saveBtn.disabled = false;
  const spin = document.getElementById('ae-save-spinner');
  const label = document.getElementById('ae-save-label');
  if (spin) spin.hidden = true;
  if (label) label.hidden = false;
  _setEditorBusy(false);
  const errEl = document.getElementById('ae-error');
  if (errEl) { errEl.textContent = message; errEl.hidden = false; }
}

function clearPendingSave() {
  if (_pendingTimer) { clearTimeout(_pendingTimer); _pendingTimer = null; }
  _pendingReqId = null;
}

/** 保存中转圈：禁点 ✕ / 取消，避免用户以为已取消而实际后端已落库。 */
function _setEditorBusy(busy) {
  const closeBtn = document.getElementById('ae-close');
  const cancelBtn = document.getElementById('ae-cancel');
  if (closeBtn) closeBtn.disabled = busy;
  if (cancelBtn) cancelBtn.disabled = busy;
}

/* ============================================================
   渲染：可用性 + 任务列表
   ============================================================ */

/** 自动化依赖"选中后端且已连接"；未就绪时整区不可用。 */
function _automationAvailable() {
  const cli = _getClient();
  return Boolean(cli && cli.state === 'connected');
}

/** 后端未选中/未连接 → 禁添加按钮 + 列表区提示"请连接并选择一个后端"。 */
function renderAvailability() {
  const btn = document.getElementById('btnAddAutomationTask');
  if (btn) btn.disabled = !_automationAvailable();
  renderTasks();
}

function renderTasks() {
  const root = document.getElementById('automationTaskList');
  if (!root) return;
  if (!_automationAvailable()) {
    root.innerHTML = `<div class="automation__unavailable">${t('automation.needBackend')}</div>`;
    return;
  }
  if (!_tasks.length) {
    root.innerHTML = `<div class="automation__empty">${t('automation.empty')}</div>`;
    return;
  }
  root.innerHTML = '';
  for (const task of _tasks) {
    root.appendChild(_buildTaskCard(task));
  }
  layoutAutomationActions();
}

// 卡片底部四个按钮：按各自内容宽的比例分配 flex-grow，一起刚好占满整行。
// 与 device-preview 同款方案：canvas 度量文本宽（jsdom 下回退字符估算）。
let _measureCtx = null;
function _btnContentWeight(btn) {
  const text = (btn.textContent || '').trim();
  let w = 0;
  if (_measureCtx && typeof _measureCtx.measureText === 'function') {
    try {
      const font = getComputedStyle(btn).font;
      if (font) _measureCtx.font = font;
      w = _measureCtx.measureText(text).width;
    } catch (_) { w = 0; }
  }
  if (!(w > 0)) {
    // 无真实度量（jsdom / 异常）→ 按字符宽估：CJK≈1、ASCII≈0.6
    for (const ch of text) w += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.6;
  }
  return Math.max(4, w + 2);   // +2 边框宽，保底 4 防 0 权重
}
function layoutAutomationActions() {
  const rows = document.querySelectorAll('.automation__task-actions');
  if (!rows.length) return;
  if (!_measureCtx) {
    try { _measureCtx = document.createElement('canvas').getContext('2d'); } catch (_) { _measureCtx = null; }
  }
  rows.forEach((row) => {
    const btns = Array.from(row.children);
    const weights = btns.map(b => _btnContentWeight(b));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    btns.forEach((b, i) => {
      b.style.flexGrow = (weights[i] / sum).toFixed(4);
      b.style.flexShrink = '0';
      b.style.flexBasis = '0px';
    });
  });
}

function _buildTaskCard(task) {
  const card = document.createElement('div');
  card.className = 'automation__task';
  const running = taskHasActiveRun(task.id);
  const queued = taskHasQueuedRun(task.id);
  const last = lastRunOf(task.id);
  const devs = devicesOf(task);
  const lastTxt = last
    ? `<span class="automation__result automation__result--${last.status}">${t(STATUS_KEYS[last.status] || 'automation.statusFailed')}</span>`
    : '';
  const next = nextFireTime(task.schedule, new Date());

  card.innerHTML = `
    <div class="automation__task-head">
      <span class="automation__task-name" title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</span>
      <label class="automation__switch" title="${t('automation.enabled')}">
        <input type="checkbox" ${task.enabled ? 'checked' : ''} data-act="enable">
        <span class="automation__switch-track"></span>
      </label>
    </div>
    <div class="automation__task-meta">
      <span>${escapeHtml(scheduleSummary(task.schedule))}</span>
    </div>
    <div class="automation__task-meta">
      <span>${t('automation.device')}: ${escapeHtml(devs.join(', ') || '—')}</span>
      <span class="automation__next">${t('automation.nextRun')}: ${next ? formatTime(next) : '—'}</span>
    </div>
    <div class="automation__task-status">
      ${queued ? `<span class="automation__result automation__result--queued">● ${t('automation.statusQueued')}</span>` : ''}
      ${running ? `<span class="automation__result automation__result--running">● ${t('automation.statusRunning')}</span>` : lastTxt}
    </div>
    <div class="automation__task-actions">
      <button class="automation__btn" data-act="run" ${(running || queued) ? 'disabled' : ''}>${t('automation.runNow')}</button>
      <button class="automation__btn" data-act="history">${t('automation.history')}</button>
      <button class="automation__btn" data-act="edit">${t('automation.edit')}</button>
      <button class="automation__btn automation__btn--danger" data-act="remove" ${(running || queued) ? 'disabled' : ''}>${t('automation.delete')}</button>
    </div>`;

  card.querySelector('[data-act="enable"]').addEventListener('change', (e) => {
    setEnabled(task.id, e.target.checked);
  });
  card.querySelector('[data-act="run"]').addEventListener('click', () => runNow(task.id));
  card.querySelector('[data-act="history"]').addEventListener('click', () => openHistoryDialog(task.id, task.name));
  card.querySelector('[data-act="edit"]').addEventListener('click', () => openEditor(task));
  card.querySelector('[data-act="remove"]').addEventListener('click', () => confirmDeleteTask(task.id, task.name));
  return card;
}

function taskHasActiveRun(taskId) {
  for (const t of _activeRuns.values()) if (t === taskId) return true;
  return false;
}

function taskHasQueuedRun(taskId) {
  for (const t of _queuedRuns.values()) if (t === taskId) return true;
  return false;
}

function lastRunOf(taskId) {
  return _history.find(r => r.task_id === taskId && r.status !== 'running') || null;
}

/** 任务目标设备列表。新格式用顶层 devices；兼容旧格式 vars.device_id（单串）。 */
function devicesOf(task) {
  if (task && task.devices && task.devices.length) return task.devices;
  const legacy = task && task.vars && task.vars.device_id;
  return legacy ? [legacy] : [];
}

/* ============================================================
   运行历史弹窗：入口在每任务卡片"立即运行 / 编辑"之间
   ============================================================ */

function openHistoryDialog(taskId, taskName) {
  _closeHistoryDialog();
  _historyDialogTaskId = taskId;
  _historyDialogTaskName = taskName;
  _dialogRuns = [];
  _histRoot = document.createElement('div');
  _histRoot.className = 'dlg-backdrop';
  _histRoot.innerHTML = `
    <div class="dlg automation-hist">
      <header class="dlg__header">
        <h3>${escapeHtml(t('automation.historyDialogTitle', { name: taskName }))}</h3>
        <button id="ae-hist-close" type="button" class="dlg__close">✕</button>
      </header>
      <div class="dlg__body">
        <div class="automation-hist__head">
          <span class="automation__hist-status">${t('automation.historyColStatus')}</span>
          <span class="automation__hist-dev">${t('automation.historyColDevice')}</span>
          <span class="automation__hist-time">${t('automation.historyColTime')}</span>
          <span class="automation__hist-dur">${t('automation.historyColDuration')}</span>
          <span class="automation__hist-log">${t('automation.historyColAction')}</span>
        </div>
        <div id="ae-hist-list" class="automation-hist__list"></div>
      </div>
      <footer class="dlg__footer">
        <button id="ae-hist-done" type="button">${t('automation.close')}</button>
      </footer>
    </div>`;
  document.body.appendChild(_histRoot);
  document.getElementById('ae-hist-close').addEventListener('click', _closeHistoryDialog);
  document.getElementById('ae-hist-done').addEventListener('click', _closeHistoryDialog);
  // 日志弹窗 / 删除确认弹窗打开时 ESC 只关上层，不误关下层历史弹窗
  _histOnKey = (e) => { if (e.key === 'Escape' && !_logRoot && !_delRoot) _closeHistoryDialog(); };
  document.addEventListener('keydown', _histOnKey);
  refreshHistory(taskId);   // 拉取该任务的运行历史
  renderHistoryDialog();
}

function _closeHistoryDialog() {
  if (_histOnKey) { document.removeEventListener('keydown', _histOnKey); _histOnKey = null; }
  if (_histRoot) { _histRoot.remove(); _histRoot = null; }
  _historyDialogTaskId = null;
  _historyDialogTaskName = '';
}

function renderHistoryDialog() {
  const root = document.getElementById('ae-hist-list');
  if (!root) return;
  const runs = _dialogRuns || [];
  root.innerHTML = runs.length
    ? runs.map((h, i) => {
        const devs = (h.devices && h.devices.length) ? h.devices
          : (h.device_id ? [h.device_id] : []);      // 兼容旧格式 device_id
        const hasLog = !!(h.log_path && h.log_path.length);
        return `
        <div class="automation__hist-item">
          <span class="automation__result automation__hist-status automation__result--${h.status}">${t(STATUS_KEYS[h.status] || h.status)}</span>
          <span class="automation__hist-dev">${escapeHtml(devs.join(', '))}</span>
          <span class="automation__hist-time">${formatTime(new Date(h.started_at || h.ended_at))}</span>
          <span class="automation__hist-dur">${h.duration_ms != null ? (h.duration_ms / 1000).toFixed(1) + 's' : ''}</span>
          <span class="automation__hist-actions">
            <button type="button" class="automation__hist-icon" data-act="log" data-index="${i}"
              ${hasLog ? '' : 'disabled'} title="${escapeHtml(t('automation.logView'))}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
            <button type="button" class="automation__hist-icon automation__hist-icon--del" data-act="del" data-index="${i}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
          </span>
        </div>`;
      }).join('')
    : `<div class="automation__empty">${t('automation.historyEmpty')}</div>`;
  root.querySelectorAll('.automation__hist-icon').forEach(btn => {
    btn.addEventListener('click', () => {
      const run = _dialogRuns[Number(btn.dataset.index)];
      if (!run) return;
      if (btn.dataset.act === 'log') openLogDialog(run, _historyDialogTaskName);
      else confirmDeleteLog(run);
    });
  });
}

/* ---- 运行日志弹窗（按需读取 + 多设备标签页） ---- */

function openLogDialog(run, taskName) {
  _closeLogDialog();
  const paths = (run.log_path || []);
  const devs = (run.devices && run.devices.length) ? run.devices : [];
  _logRoot = document.createElement('div');
  _logRoot.className = 'dlg-backdrop';
  const tabsHtml = paths.length > 1
    ? `<div class="automation-log__tabs">${paths.map((_, i) =>
        `<button type="button" class="automation-log__tab" data-tab="${i}">${escapeHtml(devs[i] || t('automation.logNoDevice'))}</button>`).join('')}</div>`
    : '';
  _logRoot.innerHTML = `
    <div class="dlg automation-log">
      <header class="dlg__header">
        <h3>${escapeHtml(t('automation.logDialogTitle', { name: taskName }))}</h3>
        <button id="ae-log-close" type="button" class="dlg__close">✕</button>
      </header>
      <div class="dlg__body">
        ${tabsHtml}
        <pre class="automation-log__body">${escapeHtml(t('automation.logLoading'))}</pre>
      </div>
      <footer class="dlg__footer">
        <button id="ae-log-done" type="button">${t('automation.close')}</button>
      </footer>
    </div>`;
  document.body.appendChild(_logRoot);
  document.getElementById('ae-log-close').addEventListener('click', _closeLogDialog);
  document.getElementById('ae-log-done').addEventListener('click', _closeLogDialog);
  _logOnKey = (e) => { if (e.key === 'Escape') _closeLogDialog(); };
  document.addEventListener('keydown', _logOnKey);
  // 设备标签页切换
  _logRoot.querySelectorAll('.automation-log__tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _logActiveTab = Number(tab.dataset.tab);
      renderLogContent();
    });
  });
  // 右键复制菜单：与底部控制台同一套 UI（只留"复制"），挂弹窗根节点随关闭移除
  const body = _logRoot.querySelector('.automation-log__body');
  _logCopyMenu = createCopyMenu(_logRoot);
  _logCopyMenu.attach(body);
  body.addEventListener('scroll', () => _logCopyMenu.hide());
  // 按需读取日志文件
  _logData = [];
  _logActiveTab = 0;
  const cli = _getClient();
  if (cli && cli.state === 'connected' && paths.length) {
    _logPendingRun = run.run_id;
    cli.sendRaw({ type: MSG.LOG_READ_REQ, run_id: run.run_id });
  } else {
    body.textContent = t('automation.logMissing');
  }
}

function renderLogContent() {
  if (!_logRoot) return;
  const body = _logRoot.querySelector('.automation-log__body');
  _logRoot.querySelectorAll('.automation-log__tab').forEach((tab, i) => {
    tab.classList.toggle('automation-log__tab--active', i === _logActiveTab);
  });
  const entry = _logData[_logActiveTab];
  if (!entry || !entry.exists) {
    body.textContent = t('automation.logMissing');
    return;
  }
  body.innerHTML = parseAnsi((entry.lines || []).join('\n'));
}

function _closeLogDialog() {
  if (_logOnKey) { document.removeEventListener('keydown', _logOnKey); _logOnKey = null; }
  if (_logCopyMenu) { _logCopyMenu.destroy(); _logCopyMenu = null; }
  if (_logRoot) { _logRoot.remove(); _logRoot = null; }
  _logPendingRun = null;
  _logData = [];
  _logActiveTab = 0;
}

/* ---- 确认弹窗（删除记录 / 删除任务共用，样式统一） ---- */

function _confirmDialog({ title, message, onOk }) {
  _closeDeleteDialog();
  _delRoot = document.createElement('div');
  _delRoot.className = 'dlg-backdrop';
  _delRoot.innerHTML = `
    <div class="dlg automation-confirm">
      <header class="dlg__header">
        <h3>${escapeHtml(title)}</h3>
        <button id="ae-del-close" type="button" class="dlg__close">✕</button>
      </header>
      <div class="dlg__body">
        <div class="automation-confirm__msg">${escapeHtml(message)}</div>
      </div>
      <footer class="dlg__footer">
        <button id="ae-del-cancel" type="button">${escapeHtml(t('dialog.cancel'))}</button>
        <button id="ae-del-ok" type="button" class="dlg__ok">${escapeHtml(t('dialog.confirm'))}</button>
      </footer>
    </div>`;
  document.body.appendChild(_delRoot);
  const close = () => _closeDeleteDialog();
  document.getElementById('ae-del-close').addEventListener('click', close);
  document.getElementById('ae-del-cancel').addEventListener('click', close);
  document.getElementById('ae-del-ok').addEventListener('click', () => {
    onOk();
    _closeDeleteDialog();
  });
  _delOnKey = (e) => { if (e.key === 'Escape') _closeDeleteDialog(); };
  document.addEventListener('keydown', _delOnKey);
}

function confirmDeleteLog(run) {
  _confirmDialog({
    title: t('automation.logDeleteTitle'),
    message: t('automation.logDeleteMsg'),
    onOk() {
      const cli = _getClient();
      if (cli && cli.state === 'connected') cli.sendRaw({ type: MSG.LOG_DELETE, run_id: run.run_id });
    },
  });
}

function confirmDeleteTask(taskId, name) {
  _confirmDialog({
    title: t('automation.deleteTitle'),
    message: t('automation.deleteConfirm', { name }),
    onOk() {
      // 竞态兜底：弹窗打开期间任务可能进入运行/排队，再校验一次
      if (taskHasActiveRun(taskId) || taskHasQueuedRun(taskId)) {
        toast(t('automation.taskDeleteBlocked'));
        return;
      }
      const cli = _getClient();
      if (!cli || cli.state !== 'connected') return;
      cli.sendRaw({ type: MSG.REMOVE, task_id: taskId });
      toast(t('automation.taskRemoved'));
    },
  });
}

function _closeDeleteDialog() {
  if (_delOnKey) { document.removeEventListener('keydown', _delOnKey); _delOnKey = null; }
  if (_delRoot) { _delRoot.remove(); _delRoot = null; }
}

/* ============================================================
   操作
   ============================================================ */

function runNow(taskId) {
  const cli = _getClient();
  if (!cli || cli.state !== 'connected') { toast(t('automation.needBackend')); return; }
  cli.sendRaw({ type: MSG.RUN_NOW, task_id: taskId });
  toast(t('automation.runQueued'));
}

function setEnabled(taskId, enabled) {
  const cli = _getClient();
  if (!cli || cli.state !== 'connected') return;
  cli.sendRaw({ type: MSG.ENABLE, task_id: taskId, enabled });
}


/* ============================================================
   任务编辑弹窗
   ============================================================ */

let _editorRoot = null;
let _editorOnKey = null;

/** 关闭任务编辑弹窗：清理 ESC 监听 + 移除 DOM。可重复调用（已关则 no-op）。 */
function _closeEditor() {
  clearPendingSave();
  if (_editorOnKey) { document.removeEventListener('keydown', _editorOnKey); _editorOnKey = null; }
  if (_editorRoot) { _editorRoot.remove(); _editorRoot = null; }
}

async function openEditor(task) {
  _closeEditor();   // 清理上一次未关的弹窗（防止残留 ESC 监听）
  _editorIsEdit = Boolean(task);
  const cli = _getClient();
  if (!cli || cli.state !== 'connected') { toast(t('automation.needBackend')); return; }

  const devices = (state.deviceListByBackend[getSelectedBackendId()] || []).map(d => d.serial);
  const initDevices = devicesOf(task);
  const spec = (task && task.schedule) || { type: 'interval', unit: 'minutes', value: 30 };

  // 复用"添加后端"对话框的 .dlg 结构，样式统一（dlg-backdrop/dlg/dlg__header/dlg__body/dlg__footer）
  _editorRoot = document.createElement('div');
  _editorRoot.className = 'dlg-backdrop';
  _editorRoot.innerHTML = `
    <div class="dlg automation-editor">
      <header class="dlg__header">
        <h3>${t(task ? 'automation.editTitle' : 'automation.addTitle')}</h3>
        <button id="ae-close" type="button" class="dlg__close">✕</button>
      </header>
      <div class="dlg__body">
        <label><span>${t('automation.name')}</span>
          <input id="ae-name" type="text" value="${escapeHtml(task ? task.name : '')}" placeholder="${escapeHtml(t('automation.namePlaceholder'))}">
        </label>
        <label><span>${t('automation.scheduleType')}</span>
          <select id="ae-type">
            <option value="interval">${t('automation.typeInterval')}</option>
            <option value="daily">${t('automation.typeDaily')}</option>
            <option value="weekly">${t('automation.typeWeekly')}</option>
            <option value="monthly">${t('automation.typeMonthly')}</option>
            <option value="yearly">${t('automation.typeYearly')}</option>
            <option value="oneshot">${t('automation.typeOneshot')}</option>
          </select>
        </label>
        <div id="ae-sched" class="automation-editor__sched"></div>
        <div class="automation-editor__field">
          <span class="automation-editor__label">${t('automation.script')}</span>
          <div id="ae-script-src" class="ae-script-src" role="radiogroup">
            <label class="ae-src-opt">
              <input type="radio" name="ae-script-src" value="project" checked>
              <span>${t('automation.scriptProject')}</span>
            </label>
            <label class="ae-src-opt">
              <input type="radio" name="ae-script-src" value="upload">
              <span>${t('automation.scriptUpload')}</span>
            </label>
          </div>
        </div>
        <div id="ae-script-box" class="automation-editor__script"></div>
        <div class="automation-editor__devices">
          <div class="automation-editor__devices-title">${t('automation.device')}
            <button type="button" id="ae-add-device" class="automation__btn">+</button>
          </div>
          <div id="ae-devices" class="automation-editor__devices-body"></div>
        </div>
        <div class="automation-editor__vars">
          <div class="automation-editor__vars-title">${t('automation.vars')}
            <button type="button" id="ae-add-var" class="automation__btn">+</button>
          </div>
          <div id="ae-vars" class="automation-editor__vars-body"></div>
        </div>
        <div id="ae-error" class="dlg__error" hidden></div>
      </div>
      <footer class="dlg__footer">
        <label class="automation-editor__check">
          <input id="ae-enabled" type="checkbox" ${(task ? task.enabled !== false : true) ? 'checked' : ''}>
          <span>${t('automation.enabled')}</span>
        </label>
        <button id="ae-cancel" type="button">${t('automation.cancel')}</button>
        <button id="ae-save" type="button" class="dlg__ok dlg__save">
          <span id="ae-save-spinner" class="dlg__save-spinner" hidden></span>
          <span id="ae-save-label">${t('automation.save')}</span>
        </button>
      </footer>
    </div>`;

  document.body.appendChild(_editorRoot);
  // 与添加后端对话框一致：点击背景不关闭（防误触丢已填数据），只能走 ✕ / 取消 / ESC
  document.getElementById('ae-close').addEventListener('click', _closeEditor);
  document.getElementById('ae-cancel').addEventListener('click', _closeEditor);
  _editorOnKey = (e) => { if (e.key === 'Escape' && !_pendingReqId) _closeEditor(); };
  document.addEventListener('keydown', _editorOnKey);

  // 目标设备：多行下拉。+ 增行 / ✕ 删行 / 只剩 1 行时 ✕ 禁用；
  // 已被其他行选中的设备在本行置灰不可选（同一任务不重复选设备）。
  // 命令传参变量里的 device_id 固定行：单台显示序号，多台显示 "multi"。
  const devBox = document.getElementById('ae-devices');
  const addDevBtn = document.getElementById('ae-add-device');
  // 单个下拉的选项：sel=本行当前值；taken=被其他行占用的设备集合 → 这些设备置灰 disabled。
  // 当前值不在设备列表（如已离线）时保留为 selected+disabled 选项，避免保存时静默丢设备。
  function _deviceOpts(sel, taken) {
    const keep = sel && !devices.includes(sel)
      ? `<option value="${escapeHtml(sel)}" selected disabled>${escapeHtml(sel)}</option>` : '';
    let list;
    if (!devices.length) {
      list = `<option value="" ${sel ? '' : 'selected'} disabled>${escapeHtml(t('automation.noDevice'))}</option>`;
    } else {
      // 未选择时：空占位选项（hidden 不进下拉列表）→ 浮层 span 显示"请选择设备"
      const ph = sel ? '' : `<option value="" selected disabled hidden></option>`;
      list = ph + devices.map(s =>
          `<option value="${escapeHtml(s)}" ${s === sel ? 'selected' : ''} ${taken.has(s) && s !== sel ? 'disabled' : ''}>${escapeHtml(s)}</option>`).join('');
    }
    return keep + list;
  }
  // 重建所有目标设备下拉：读各行当前值 → 其他行已选中的设备标记 disabled；
  // 同时同步浮层占位显隐（有设备且未选择时显示"请选择设备"）
  function renderDeviceRows() {
    const rows = [...devBox.querySelectorAll('.ae-device-row')];
    const taken = new Set(rows.map(r => r.querySelector('.ae-device-sel').value).filter(Boolean));
    rows.forEach((r) => {
      const w = r.querySelector('.ae-device-selw');
      const select = w.querySelector('.ae-device-sel');
      select.innerHTML = _deviceOpts(select.value, taken);
      const ph = w.querySelector('.ae-device-sel__ph');
      if (ph) ph.hidden = !devices.length || select.value !== '';
    });
  }
  function syncDeviceIdRow() {
    const v = document.querySelector('.ae-var-fixed .ae-var-val');
    if (!v) return;
    const rows = devBox.querySelectorAll('.ae-device-row');
    const vals = [...rows].map(r => r.querySelector('.ae-device-sel').value).filter(Boolean);
    v.value = vals.length > 1 ? t('automation.multi') : (vals[0] || '');
  }
  function updateDevDelDisabled() {
    const rows = devBox.querySelectorAll('.ae-device-row');
    rows.forEach((r) => { r.querySelector('.ae-device-del').disabled = rows.length <= 1; });
  }
  function addDeviceRow(sel = '') {
    const row = document.createElement('div');
    row.className = 'automation-editor__var-row ae-device-row';
    // 浮层占位方案（镜像脚本"请选择工程"）：占位文字不进下拉列表，由 span 浮在 select 上
    row.innerHTML = `
      <div class="ae-device-selw">
        <select class="ae-device-sel">${_deviceOpts(sel, new Set())}</select>
        <span class="ae-device-sel__ph">${escapeHtml(t('automation.selectDevice'))}</span>
      </div>
      <button type="button" class="automation__btn automation__btn--danger ae-device-del">✕</button>`;
    row.querySelector('.ae-device-del').addEventListener('click', () => {
      row.remove();
      renderDeviceRows();
      updateDevDelDisabled();
      syncDeviceIdRow();
    });
    row.querySelector('.ae-device-sel').addEventListener('change', () => {
      renderDeviceRows();
      syncDeviceIdRow();
    });
    devBox.appendChild(row);
    renderDeviceRows();
    updateDevDelDisabled();
    syncDeviceIdRow();
  }
  // "+" 增行：默认不选中任何设备，显示"请选择设备"占位
  addDevBtn.addEventListener('click', () => addDeviceRow(''));

  // 脚本来源：工程清单 / 上传自定义脚本（左右互斥二选一）。不再要求先打开工程文件。
  const scriptSrc = document.getElementById('ae-script-src');
  const scriptBox = document.getElementById('ae-script-box');
  const scriptMeta = (task && task.script) || null;
  if (scriptMeta && scriptMeta.source === 'upload') setScriptSource('upload');
  // 后端已存脚本名（编辑工程型任务时：脚本下拉默认选中"后端"项，保存时不重传覆盖）。
  // 显示用 script.project_name（工程名）；老数据无 project_name 时回退 name。
  const backendScriptName = (scriptMeta && scriptMeta.source === 'project')
    ? (scriptMeta.project_name || scriptMeta.name) : '';
  // 工程清单 = 绑定的工程目录下的 .py 文件（读文件原文即可当 main.py，无需解析），
  // 下拉显示工程名（getProjectName：DSL 里的 project("...")，读不到则回退文件名）
  let scriptProjects = [];
  const dh = getDirHandle();
  if (dh) {
    try { scriptProjects = await listProjectFiles(dh); } catch (_) { scriptProjects = []; }
  }
  const scriptProjectNames = await Promise.all(
    scriptProjects.map(async (f) => {
      try { return { file: f, name: await getProjectName(dh, f) }; }
      catch (_) { return { file: f, name: f.replace(/\.py$/, '') }; }
    })
  );
  function renderScriptBox() {
    if (getScriptSource() === 'upload') {
      const reupload = (scriptMeta && scriptMeta.source === 'upload')
        ? `<div class="automation-editor__vars-hint">${t('automation.scriptReuploadHint')}</div>` : '';
      scriptBox.innerHTML = `
        <input id="ae-script-files" type="file" multiple accept=".py">
        <div class="automation-editor__vars-hint">${t('automation.scriptUploadHint')}</div>${reupload}`;
      return;
    }
    if (!scriptProjects.length && !backendScriptName) {
      scriptBox.innerHTML = `<div class="automation-editor__script-empty">${t('automation.scriptNoProjects')}</div>`;
      return;
    }
    // 编辑已有工程型任务：默认选中"后端已存脚本"项（__backend__，显示 项目名（后端）），
    // 保持选中并保存 → 不重发 bundle，后端脚本原样保留。
    // 新建任务：默认未选择，浮层提示"请选择工程"（hidden+disabled 空选项占位，不进下拉列表）。
    const ph = !backendScriptName ? 'selected' : '';
    let opts = backendScriptName
      ? `<option value="__backend__" selected>${escapeHtml(backendScriptName)}${escapeHtml(t('automation.scriptBackendSuffix'))}</option>`
      : `<option value="" disabled hidden ${ph}></option>`;
    opts += scriptProjectNames.map(p =>
      `<option value="${escapeHtml(p.file)}">${escapeHtml(p.name)}</option>`
    ).join('');
    scriptBox.innerHTML = `
      <div class="ae-script-sel">
        <select id="ae-script-project">${opts}</select>
        <span class="ae-script-sel__ph" ${ph ? '' : 'hidden'}>${t('automation.scriptProjectPlaceholder')}</span>
      </div>`;
    const psel = scriptBox.querySelector('#ae-script-project');
    const pph = scriptBox.querySelector('.ae-script-sel__ph');
    const syncPh = () => { if (pph) pph.hidden = psel.value !== ''; };
    syncPh();
    psel.addEventListener('change', syncPh);
  }
  renderScriptBox();
  scriptSrc.addEventListener('change', renderScriptBox);

  // 变量编辑器：固定 device_id 行（只读展示目标设备，单台显示序号 / 多台显示 "multi"，无 ✕）
  // + 可增删额外变量行
  const varsBody = document.getElementById('ae-vars');
  const deviceRow = document.createElement('div');
  deviceRow.className = 'automation-editor__var-row ae-var-fixed';
  deviceRow.innerHTML = `
    <span class="ae-var-key ae-var-key--fixed">device_id</span>
    <input class="ae-var-val" value="" readonly>`;
  varsBody.appendChild(deviceRow);
  // device_id 固定行建好后初始化设备行（编辑按 task.devices，新建 1 行默认当前设备）
  if (initDevices.length) initDevices.forEach(d => addDeviceRow(d));
  else addDeviceRow('');   // 新建任务：默认不选中任何设备（占位"请选择设备"）
  syncDeviceIdRow();

  const extra = (task && task.vars) ? Object.entries(task.vars) : [];
  function addVarRow(key = '', val = '') {
    const row = document.createElement('div');
    row.className = 'automation-editor__var-row';
    row.innerHTML = `
      <input class="ae-var-key" placeholder="${escapeHtml(t('automation.varKeyPlaceholder'))}" value="${escapeHtml(key)}">
      <input class="ae-var-val" placeholder="${escapeHtml(t('automation.varValPlaceholder'))}" value="${escapeHtml(val)}">
      <button type="button" class="automation__btn automation__btn--danger ae-var-del" title="${escapeHtml(t('automation.delVar'))}">✕</button>`;
    row.querySelector('.ae-var-del').addEventListener('click', () => row.remove());
    varsBody.appendChild(row);
  }
  extra.forEach(([k, v]) => addVarRow(k, v));
  document.getElementById('ae-add-var').addEventListener('click', () => addVarRow());

  // 计划参数表单
  const typeSel = document.getElementById('ae-type');
  typeSel.value = spec.type;
  const schedBox = document.getElementById('ae-sched');
  function renderSched() {
    const type = typeSel.value;
    // 时间输入：包进 .ae-pick（relative），右侧独立时钟按钮开/关选择器
    const timeHtml = `<div class="ae-pick"><input id="ae-time" type="time" value="${spec.time || '09:00'}"><button type="button" class="ae-pick-btn ae-pick-btn--time" tabindex="-1"></button></div>`;
    let html = '';
    if (type === 'interval') {
      html = `
        <input id="ae-int-val" type="number" min="1" value="${spec.interval_value || 30}">
        <select id="ae-int-unit">
          <option value="seconds" ${spec.interval_unit === 'seconds' ? 'selected' : ''}>${t('automation.unitSeconds')}</option>
          <option value="minutes" ${spec.interval_unit !== 'seconds' && spec.interval_unit !== 'hours' ? 'selected' : ''}>${t('automation.unitMinutes')}</option>
          <option value="hours" ${spec.interval_unit === 'hours' ? 'selected' : ''}>${t('automation.unitHours')}</option>
        </select>`;
    } else if (type === 'daily') {
      html = timeHtml;
    } else if (type === 'weekly') {
      html = `
        <div class="automation-editor__weekdays">${[0,1,2,3,4,5,6].map(i =>
          `<label class="automation-editor__wd"><input type="checkbox" value="${i}" ${(spec.weekdays||[]).includes(i)?'checked':''}>${t(`automation.wd${i}`)}</label>`).join('')}</div>
        ${timeHtml}`;
    } else if (type === 'monthly') {
      html = `
        <span class="automation-editor__label">${t('automation.dayOfMonth')}</span>
        <input id="ae-dom" type="number" min="1" max="31" value="${spec.day_of_month || 1}">
        ${timeHtml}`;
    } else if (type === 'yearly') {
      html = `
        <span class="automation-editor__label">${t('automation.month')}</span>
        <input id="ae-month" type="number" min="1" max="12" value="${spec.month || 1}">
        <span class="automation-editor__label">${t('automation.dayOfMonth')}</span>
        <input id="ae-dom" type="number" min="1" max="31" value="${spec.day_of_month || 1}">
        ${timeHtml}`;
    } else if (type === 'oneshot') {
      const atVal = spec.at ? spec.at.slice(0, 16) : '';
      // 原生 datetime-local 的空态文案不可控（yyyy/mm/日 --:--），用浮层盖住改成自定义占位
      html = `
        <div class="ae-dt">
          <input id="ae-at" type="datetime-local" value="${escapeHtml(atVal)}">
          <span class="ae-dt__ph" ${atVal ? 'hidden' : ''}>${t('automation.dtPlaceholder')}</span>
          <button type="button" class="ae-pick-btn ae-pick-btn--cal" tabindex="-1"></button>
        </div>`;
    }
    schedBox.innerHTML = html;
    // oneshot：输入有值就隐藏占位浮层
    const atInput = schedBox.querySelector('#ae-at');
    if (atInput) {
      const ph = schedBox.querySelector('.ae-dt__ph');
      const sync = () => { if (ph) ph.hidden = atInput.value !== ''; };
      sync();
      atInput.addEventListener('input', sync);
      atInput.addEventListener('change', sync);
    }
    // 选择器只由右侧按钮开/关；点击框体交给浏览器原生分段编辑（年月日时分，敲数字直接改）。
    // mousedown preventDefault：避免按钮抢焦点导致输入框失焦→选择器被原生关闭的竞态。
    // 打开态再点按钮 → blur() 关闭；change/input/失焦/Esc 也复位（选值/输入时选择器已收起）。
    schedBox.querySelectorAll('input[type="time"], input[type="datetime-local"]').forEach(inp => {
      const btn = inp.parentElement.querySelector('.ae-pick-btn');
      if (!btn || typeof inp.showPicker !== 'function') return;
      let open = false;
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        if (open) {
          open = false;
          inp.blur();
        } else {
          try { inp.showPicker(); open = true; } catch (_) {}
        }
      });
      inp.addEventListener('change', () => { open = false; });
      inp.addEventListener('input', () => { open = false; });
      inp.addEventListener('blur', () => { open = false; });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') open = false; });
    });
  }
  renderSched();
  typeSel.addEventListener('change', renderSched);

  // 保存：校验 + 打包 → 转圈发送 → 等后端 ack（added/updated 回显 req_id）才关弹窗；
  // 失败（错误帧 / 后端断开 / 超时）→ 完成转圈、保持弹窗并提示。
  document.getElementById('ae-save').addEventListener('click', async () => {
    if (_pendingReqId) return;   // 已在保存中，忽略重复点击
    const errEl = document.getElementById('ae-error');
    if (errEl) errEl.hidden = true;

    const name = document.getElementById('ae-name').value.trim();
    if (!name) { toast(t('automation.nameRequired')); return; }
    const devicesArr = [...devBox.querySelectorAll('.ae-device-sel')].map(s => s.value).filter(Boolean);
    if (!devicesArr.length) { toast(t('automation.deviceRequired')); return; }

    const schedule = collectSchedule(typeSel.value, document.getElementById('ae-sched'));
    if (!schedule) { toast(t('automation.scheduleRequired')); return; }

    // 变量：仅额外键值行（device_id 由 devices 表达，不再写入 vars）
    const vars = {};
    varsBody.querySelectorAll('.automation-editor__var-row').forEach((row) => {
      if (row.classList.contains('ae-var-fixed')) return;   // 固定 device_id 行
      const k = row.querySelector('.ae-var-key').value.trim();
      if (!k) return;
      vars[k] = row.querySelector('.ae-var-val').value;
    });

    const built = await buildScriptBundleFromEditor();
    if (!built) return;

    const payload = { type: task ? MSG.UPDATE : MSG.ADD, name, schedule, devices: devicesArr, vars, enabled: document.getElementById('ae-enabled').checked };
    if (task) payload.task_id = task.id;
    if (!built.keep) {   // "后端"项（保留后端脚本）时不重发 bundle / script
      payload.script = built.script;
      payload.zip_b64 = built.b64;
    }
    payload.req_id = 'ae' + (++_saveSeq);

    // 进入保存中：转圈 + 禁点 ✕/取消/ESC
    _pendingReqId = payload.req_id;
    const saveBtn = document.getElementById('ae-save');
    saveBtn.disabled = true;
    const spin = document.getElementById('ae-save-spinner');
    const label = document.getElementById('ae-save-label');
    if (spin) spin.hidden = false;
    if (label) label.hidden = true;
    _setEditorBusy(true);
    _pendingTimer = setTimeout(() => _saveFail(_pendingReqId, t('automation.saveTimeout')), 10000);

    if (!cli.sendRaw(payload)) {
      // 发送前连接已断（sendRaw 返回 false）
      _saveFail(_pendingReqId, t('automation.saveDisconnected'));
    }
  });
}

/** 从表单收集 schedule spec（返回 null 表示非法）。 */
function collectSchedule(type, schedBox) {
  const $ = (id) => schedBox.querySelector(id);
  const time = $('#ae-time') ? $('#ae-time').value : null;
  if (type === 'interval') {
    const val = Number($('#ae-int-val').value);
    return val >= 1 ? { type, unit: $('#ae-int-unit').value, value: val } : null;
  }
  if (type === 'daily') return time ? { type, time } : null;
  if (type === 'weekly') {
    const wds = [...schedBox.querySelectorAll('.automation-editor__wd input:checked')].map(i => Number(i.value));
    return time && wds.length ? { type, time, weekdays: wds.sort((a, b) => a - b) } : null;
  }
  if (type === 'monthly') {
    const dom = Number($('#ae-dom').value);
    return time && dom >= 1 && dom <= 31 ? { type, time, day_of_month: dom } : null;
  }
  if (type === 'yearly') {
    const month = Number($('#ae-month').value);
    const dom = Number($('#ae-dom').value);
    return time && month >= 1 && month <= 12 && dom >= 1 && dom <= 31
      ? { type, time, month, day_of_month: dom } : null;
  }
  if (type === 'oneshot') {
    const at = $('#ae-at').value;
    return at ? { type, at: at + ':00' } : null;
  }
  return null;
}

/** 脚本来源二选一：读取当前选中的 radio（默认 project）。 */
function getScriptSource() {
  const sel = document.getElementById('ae-script-src');
  const checked = sel && sel.querySelector('input[type="radio"]:checked');
  return checked ? checked.value : 'project';
}

/** 脚本来源二选一：设置选中项（程序化勾选不触发 change，调用方自行重渲染）。 */
function setScriptSource(val) {
  const sel = document.getElementById('ae-script-src');
  const radio = sel && sel.querySelector(`input[type="radio"][value="${val}"]`);
  if (radio) radio.checked = true;
}

/**
 * 按脚本来源打包 bundle：
 *  - upload：上传的自定义脚本（必须含 main.py），zip 进所有文件 + droidtaskflow.py
 *  - project：工程清单里的 .py（原文即 main.py），与运行按钮/导出一致的
 *    main.py + droidtaskflow.py
 * 返回 { b64, script }；失败时已 toast 并返回 null。
 */
async function buildScriptBundleFromEditor() {
  try {
    const source = getScriptSource();
    const dtfPy = generateDroidtaskflowPy();
    if (source === 'upload') {
      const input = document.getElementById('ae-script-files');
      if (!input || !input.files || !input.files.length) {
        toast(t('automation.scriptRequired'));
        return null;
      }
      const r = await buildUploadBundle(input.files, dtfPy);
      if (r.error) { toast(t('automation.scriptUploadMissing')); return null; }
      return { b64: r.b64, script: { source: 'upload', name: 'upload' } };
    }
    // project 模式：总是从工程文件读原文当 main.py
    const sel = document.getElementById('ae-script-project');
    const file = sel ? sel.value : '';
    if (file === '__backend__') return { keep: true };   // 保留后端已存脚本（编辑时的默认项）
    if (!file) { toast(t('automation.scriptProjectRequired')); return null; }
    const dh = getDirHandle();
    if (!dh) { toast(t('automation.scriptNoProjects')); return null; }
    const mainPy = await readProjectSource(dh, file);
    // project_name：工程显示名（DSL 里的 project("...")），随 script 元数据持久化，
    // 编辑时"后端"项用它显示（老数据无 project_name 时回退 name）
    let projectName = file;
    try { projectName = await getProjectName(dh, file); } catch (_) {}
    const zip = await buildProjectBundle({ mainPyText: mainPy, dtfPyText: dtfPy });
    return { b64: bytesToBase64(zip), script: { source: 'project', name: file, project_name: projectName } };
  } catch (e) {
    toast(t('automation.bundleFail', { msg: e && e.message ? e.message : String(e) }));
    return null;
  }
}

/**
 * 上传自定义脚本打包（纯逻辑，可单测）：入口文件必须命名为 main.py，
 * 全部选中文件原样入 zip，再注入 droidtaskflow.py。
 * @param {FileList|Array<File>} fileList
 * @returns {Promise<{b64: string} | {error: 'main.py'}>}
 */
export async function buildUploadBundle(fileList, dtfPy) {
  const files = Array.from(fileList || []);
  if (!files.some(f => f.name === 'main.py')) return { error: 'main.py' };
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, await f.text());
  zip.file('droidtaskflow.py', dtfPy || '');
  const b64 = bytesToBase64(await zip.generateAsync({ type: 'uint8array' }));
  return { b64 };
}

/* ============================================================
   纯函数：下次触发时间（与后端 schedule.py 语义一致）
   ============================================================ */

export function nextFireTime(spec, after) {
  if (!spec) return null;
  const t = spec.type;
  const parseTime = (s) => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s || '');
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

  if (t === 'interval') {
    const unitS = { seconds: 1, minutes: 60, hours: 3600 }[spec.unit] || 60;
    return new Date(after.getTime() + unitS * (spec.value || 1) * 1000);
  }

  if (t === 'daily' || t === 'weekly' || t === 'monthly' || t === 'yearly') {
    const tm = parseTime(spec.time) || [0, 0];
    const hh = tm[0], mm = tm[1];

    if (t === 'daily') {
      const cand = new Date(after);
      cand.setHours(hh, mm, 0, 0);
      if (cand <= after) cand.setDate(cand.getDate() + 1);
      return cand;
    }
    if (t === 'weekly') {
      for (let i = 0; i <= 7; i++) {
        const d = new Date(after);
        d.setDate(d.getDate() + i);
        if ((spec.weekdays || []).includes((d.getDay() + 6) % 7)) {
          const cand = new Date(d);
          cand.setHours(hh, mm, 0, 0);
          if (cand > after) return cand;
        }
      }
      return null;
    }
    if (t === 'monthly') {
      let y = after.getFullYear(), m = after.getMonth();
      for (let i = 0; i < 60; i++) {
        const day = Math.min(spec.day_of_month || 1, daysInMonth(y, m));
        const cand = new Date(y, m, day, hh, mm, 0, 0);
        if (cand > after) return cand;
        m += 1;
        if (m > 11) { m = 0; y += 1; }
      }
      return null;
    }
    if (t === 'yearly') {
      for (let y = after.getFullYear(); y < after.getFullYear() + 3; y++) {
        const day = Math.min(spec.day_of_month || 1, daysInMonth(y, (spec.month || 1) - 1));
        const cand = new Date(y, (spec.month || 1) - 1, day, hh, mm, 0, 0);
        if (cand > after) return cand;
      }
      return null;
    }
  }

  if (t === 'oneshot') {
    if (spec.fired) return null;
    const at = new Date(spec.at);
    return isNaN(at.getTime()) ? null : (at > after ? at : null);
  }
  return null;
}

export function scheduleSummary(spec) {
  if (!spec) return '';
  switch (spec.type) {
    case 'interval':
      return t('automation.summaryInterval', {
        value: spec.value,
        unit: t({ seconds: 'automation.unitSeconds', minutes: 'automation.unitMinutes', hours: 'automation.unitHours' }[spec.unit] || 'automation.unitMinutes'),
      });
    case 'daily':
      return t('automation.summaryDaily', { time: spec.time });
    case 'weekly':
      return t('automation.summaryWeekly', { days: (spec.weekdays || []).map(d => t('automation.wd' + d)).join(' '), time: spec.time });
    case 'monthly':
      return t('automation.summaryMonthly', { day: spec.day_of_month, time: spec.time });
    case 'yearly':
      return t('automation.summaryYearly', { month: spec.month, day: spec.day_of_month, time: spec.time });
    case 'oneshot':
      return spec.fired ? t('automation.summaryOneshotFired') : t('automation.summaryOneshot', { at: spec.at });
    default:
      return spec.type || '';
  }
}

/* ============================================================
   小工具
   ============================================================ */

function formatTime(d) {
  if (isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* 测试钩子：暴露内部状态与消息入口（生产无副作用）。 */
export const __test = {
  setTestClient(cli) { _testClient = cli; },
  get tasks() { return _tasks; },
  get history() { return _history; },
  handleMessage(msg) { _onMessage(msg); },
  resetRuns() { _activeRuns.clear(); _queuedRuns.clear(); },
};
