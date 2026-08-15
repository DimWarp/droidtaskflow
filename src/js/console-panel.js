// 底部抽屉控制台：单 run 显示 + 自动滚动 + 折叠展开 + 高度记忆。
// 折叠状态通过 .app-shell 上的 .console-pane--collapsed 控制：
// 展开时 row 3 = 220px（grid-template-rows），折叠时 row 3 = 0，
// 控制台完全滑出屏幕底部，主区域获得全部高度。
// 切换按钮是 #consoleToggle，清空按钮 #consoleClear 在它右边，
// 折叠时清空按钮自动 disabled（用户能看到位置，但不能误触）。

import { t } from './i18n.js';
import { createCopyMenu } from './copy-menu.js';

const LS_COLLAPSED = 'dtf:console_collapsed';
const LS_HEIGHT = 'dtf:console_height';

// ── ANSI escape → HTML ──────────────────────────────────────────────
const ANSI_COLORS = [
  '#000', '#c00', '#0a0', '#c50', '#00c', '#c0c', '#0cc', '#ccc',
  '#555', '#f55', '#5f5', '#ff5', '#55f', '#f5f', '#5ff', '#fff',
];

export function parseAnsi(text) {
  // strip OSC sequences like \033]0;title\007
  text = text.replace(/\x1b\][^\x07]*\x07/g, '');
  // also handle \033]...\033\\ (ST terminator)
  text = text.replace(/\x1b\][^\x1b]*\x1b\\/g, '');
  // split on CSI sequences: ESC[ ... final_letter (m = SGR)
  const parts = text.split(/(\x1b\[[0-9;]*[A-Za-z])/g);
  let html = '';
  let fg = '', bg = '', bold = false;

  function openSpan() {
    let style = '';
    if (fg) style += `color:${fg};`;
    if (bg) style += `background:${bg};`;
    if (bold) style += 'font-weight:bold;';
    return style ? `<span style="${style}">` : '';
  }
  function closeSpan() {
    return (fg || bg || bold) ? '</span>' : '';
  }

  for (const part of parts) {
    if (!part.startsWith('\x1b[')) {
      // plain text — HTML-escape, wrapped in current style span
      const escaped = part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (escaped) html += openSpan() + escaped + closeSpan();
      continue;
    }
    // parse SGR params
    const m = part.match(/^\x1b\[([0-9;]*)([A-Za-z])$/);
    if (!m) continue;
    if (m[2] !== 'm') continue;
    const nums = m[1] ? m[1].split(';').map(Number) : [0];
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i];
      if (n === 0) { fg = ''; bg = ''; bold = false; }
      else if (n === 1) { bold = true; }
      else if (n === 22) { bold = false; }
      else if (n >= 30 && n <= 37) { fg = ANSI_COLORS[n - 30]; }
      else if (n >= 40 && n <= 47) { bg = ANSI_COLORS[n - 40]; }
      else if (n >= 90 && n <= 97) { fg = ANSI_COLORS[n - 90 + 8]; }
      else if (n >= 100 && n <= 107) { bg = ANSI_COLORS[n - 100 + 8]; }
      else if (n === 39) { fg = ''; }
      else if (n === 49) { bg = ''; }
      else if (n === 38 && nums[i + 1] === 5 && nums[i + 2] !== undefined) {
        fg = ansi256(nums[i + 2]); i += 2;
      }
      else if (n === 48 && nums[i + 1] === 5 && nums[i + 2] !== undefined) {
        bg = ansi256(nums[i + 2]); i += 2;
      }
      else if (n === 38 && nums[i + 1] === 2 && nums.length >= i + 5) {
        fg = `rgb(${nums[i+2]},${nums[i+3]},${nums[i+4]})`; i += 4;
      }
      else if (n === 48 && nums[i + 1] === 2 && nums.length >= i + 5) {
        bg = `rgb(${nums[i+2]},${nums[i+3]},${nums[i+4]})`; i += 4;
      }
    }
  }
  return html;
}

function ansi256(n) {
  if (n < 16) return ANSI_COLORS[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  n -= 16;
  const r = Math.floor(n / 36) * 51;
  const g = Math.floor((n % 36) / 6) * 51;
  const b = (n % 6) * 51;
  return `rgb(${r},${g},${b})`;
}

class ConsolePanel {
  constructor(rootEl) {
    this.root = rootEl;                          // #consolePane
    this.shell = document.querySelector('.app-shell');
    this.linesEl = null;
    this.cancelBtnEl = null;
    this.clearBtnEl = null;
    this.toggleBtnEl = null;
    this.queueEl = null;
    this.runId = null;
    this.cli = null;
    this._handlers = [];
    this.scrolledUp = false;
    this._queue = [];            // [{cli, runId, label}]
    this._runCounter = 0;
    this._buildDom();
    this._restoreUi();
  }

  _buildDom() {
    this.linesEl = this.root.querySelector('#consoleLines');
    this.cancelBtnEl = this.root.querySelector('#consoleCancel');
    this.queueEl = this.root.querySelector('#consoleQueue');
    // 清空按钮在 .console-handle-row 里（toggle 右边），不在 #consolePane 下
    this.clearBtnEl = document.getElementById('consoleClear');
    this.toggleBtnEl = document.getElementById('consoleToggle');

    this.clearBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.linesEl.innerHTML = '';
    });
    this.cancelBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this._onCancelClick();
    });
    if (this.toggleBtnEl) {
      this.toggleBtnEl.addEventListener('click', () => this.toggle());
    }

    // 右键自定义菜单：替换浏览器默认的多选项菜单，只留"复制"。
    // <pre> 本身已支持文本选中和 Ctrl+C；这里只接管 contextmenu 的 UI 部分。
    this._copyMenu = createCopyMenu();
    this._copyMenu.attach(this.linesEl, { exclude: (t) => t === this.cancelBtnEl });

    this.linesEl.addEventListener('scroll', () => {
      const slop = 5;
      this.scrolledUp = (this.linesEl.scrollHeight - this.linesEl.scrollTop - this.linesEl.clientHeight) > slop;
      // 滚动时关掉右键菜单，避免错位
      this._copyMenu.hide();
    });

    // 顶部 resize handle：拖拽调整 grid row 高度
    const topHandle = this.root.querySelector('#consoleResizeTop');
    topHandle.addEventListener('mousedown', (e) => {
      const startY = e.clientY;
      const startH = this.root.offsetHeight;
      const shell = this.shell;
      let curH = startH;
      // 拖拽期间禁用 grid transition，避免底部边界延迟
      shell.style.transition = 'none';
      const onMove = (ev) => {
        const dh = startY - ev.clientY; // 向上拖 = 正 = 变高
        curH = Math.max(150, Math.min(window.innerHeight / 2, startH + dh));
        shell.style.gridTemplateRows = `40px minmax(0, 1fr) ${curH}px`;
        if (window.__syncPaletteBottomGap) window.__syncPaletteBottomGap(curH);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        shell.style.transition = '';
        localStorage.setItem(LS_HEIGHT, String(curH));
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  _restoreUi() {
    // 默认收起：仅当用户显式展开过（值为 '0'）才展开。
    // 旧行为用 === '1' 判断会让首次访问默认展开，反转更符合"控制台是辅助"的角色。
    const collapsed = localStorage.getItem(LS_COLLAPSED) !== '0';
    const h = parseInt(localStorage.getItem(LS_HEIGHT) || '220', 10);
    // 用 grid-template-rows 控制高度（而非 style.height），与拖拽 resize 一致
    if (this.shell && !collapsed && h !== 220) {
      this.shell.style.gridTemplateRows = `40px minmax(0, 1fr) ${h}px`;
    }
    this._setCollapsed(collapsed);
  }

  _setCollapsed(collapsed) {
    if (!this.shell) return;
    this.shell.classList.toggle('console-pane--collapsed', collapsed);
    // 折叠时清除 inline grid-template-rows，让 CSS class 接管（→ 0）
    if (collapsed) this.shell.style.gridTemplateRows = '';
    // 清空按钮只在展开状态可点：折叠时置灰 + pointer-events:none（CSS）
    if (this.clearBtnEl) this.clearBtnEl.disabled = collapsed;
  }

  toggle() {
    if (!this.shell) return;
    const c = this.shell.classList.toggle('console-pane--collapsed');
    localStorage.setItem(LS_COLLAPSED, c ? '1' : '0');
    // 折叠时清除 inline，让 CSS class 的 0 生效；
    // 展开时恢复用户保存的自定义高度（如有）
    if (c) {
      this.shell.style.gridTemplateRows = '';
    } else {
      const h = parseInt(localStorage.getItem(LS_HEIGHT) || '220', 10);
      this.shell.style.gridTemplateRows = h !== 220
        ? `40px minmax(0, 1fr) ${h}px`
        : '';
    }
    // 同步任务卡片展开栏高度（传入目标值，让 CSS transition 动画）
    const targetH = c ? 0 : parseInt(localStorage.getItem(LS_HEIGHT) || '220', 10);
    if (window.__syncPaletteBottomGap) window.__syncPaletteBottomGap(targetH);
    // 同步清空按钮可用态
    if (this.clearBtnEl) this.clearBtnEl.disabled = c;
  }

  collapse() {
    if (!this.shell) return;
    this.shell.classList.add('console-pane--collapsed');
    this.shell.style.gridTemplateRows = '';
    localStorage.setItem(LS_COLLAPSED, '1');
    if (window.__syncPaletteBottomGap) window.__syncPaletteBottomGap(0);
    if (this.clearBtnEl) this.clearBtnEl.disabled = true;
  }

  setToggleEnabled(enabled) {
    if (this.toggleBtnEl) {
      this.toggleBtnEl.disabled = !enabled;
      this.toggleBtnEl.style.opacity = enabled ? '' : '0.35';
      this.toggleBtnEl.style.cursor = enabled ? '' : 'default';
    }
  }

  startRun(cli, runId) {
    this._runCounter++;
    const label = t('console.runLabel', { n: this._runCounter });
    // 如果已有 run 在跑，加入队列
    if (this.runId) {
      this._queue.push({ cli, runId, label });
      this._renderQueue();
      // 自动展开控制台让用户看到排队
      if (this.shell?.classList.contains('console-pane--collapsed')) {
        this.toggle();
      }
      return;
    }
    this._activateRun(cli, runId, label);
  }

  _activateRun(cli, runId, label) {
    // 解除上一 run
    this._detachHandlers();
    this.runId = runId;
    this.cli = cli;
    this._currentLabel = label || t('console.run');
    this.cancelBtnEl.hidden = false;
    this.linesEl.innerHTML = '';
    // 强制展开
    if (this.shell?.classList.contains('console-pane--collapsed')) {
      this.toggle();
    }

    const onLog = (m) => {
      if (m.run_id !== this.runId) return;
      this._appendLine(m.line);
      this._autoFollow();
    };
    const onExit = (m) => {
      if (m.run_id !== this.runId) return;
      this._finishRun();
    };
    const onError = (m) => {
      if (m.run_id !== this.runId) return;
      this._appendLine(`[ERROR] ${m.message}`);
      this._finishRun();
    };
    cli.on('log', onLog);
    cli.on('exit', onExit);
    cli.on('error', onError);
    this._handlers.push(
      { type: 'log', fn: onLog },
      { type: 'exit', fn: onExit },
      { type: 'error', fn: onError },
    );
    this._renderQueue();
  }

  _finishRun() {
    this.runId = null;
    this.cancelBtnEl.hidden = true;
    // 启动队列中的下一个
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      this._activateRun(next.cli, next.runId, next.label);
    } else {
      this._renderQueue();
    }
  }

  _cancelQueueItem(runId) {
    // 取消当前运行
    if (this.runId === runId) {
      if (this.cli) this.cli.sendCancel(runId);
      return;
    }
    // 取消排队中的项
    const idx = this._queue.findIndex(q => q.runId === runId);
    if (idx >= 0) {
      this._queue.splice(idx, 1);
      this._renderQueue();
    }
  }

  _renderQueue() {
    if (!this.queueEl) return;
    this.queueEl.innerHTML = '';
    const all = [];
    // 排队中的项（先提交的在上面）
    for (const q of this._queue) {
      all.push({ ...q, status: 'queued' });
    }
    // 当前运行的项（在最底下）
    if (this.runId) {
      all.push({ runId: this.runId, label: this._currentLabel || t('console.run'), status: 'running' });
    }
    if (all.length === 0) return;

    all.forEach(item => {
      const row = document.createElement('div');
      row.className = 'console-pane__queue-item' + (item.status === 'running' ? ' console-pane__queue-item--running' : '');
      const lbl = document.createElement('span');
      lbl.className = 'console-pane__queue-item__label';
      lbl.textContent = item.label;
      const st = document.createElement('span');
      st.className = 'console-pane__queue-item__status';
      st.textContent = item.status === 'running' ? t('console.running') : t('console.queued');
      row.append(lbl, st);
      // 当前运行和排队中的都可以取消
      const btn = document.createElement('button');
      btn.className = 'console-pane__queue-item__cancel';
      btn.textContent = '✕';
      btn.title = item.status === 'running' ? t('tooltip.cancelRun') : t('tooltip.removeQueue');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._cancelQueueItem(item.runId);
      });
      row.appendChild(btn);
      this.queueEl.appendChild(row);
    });
  }

  _detachHandlers() {
    if (!this.cli) return;
    for (const h of this._handlers) {
      this.cli._listeners[h.type] = (this.cli._listeners[h.type] || []).filter((fn) => fn !== h.fn);
    }
    this._handlers = [];
  }

  _appendLine(line) {
    const div = document.createElement('div');
    div.innerHTML = parseAnsi(line);
    this.linesEl.appendChild(div);
  }

  _autoFollow() {
    if (this.scrolledUp) return;
    this.linesEl.scrollTop = this.linesEl.scrollHeight;
  }

  _onCancelClick() {
    if (this.cli && this.runId) {
      this.cli.sendCancel(this.runId);
    }
  }
}

let _instance = null;
export function initConsolePanel(rootEl) {
  if (!_instance) _instance = new ConsolePanel(rootEl);
  return _instance;
}
export function getConsolePanel() { return _instance; }
export function collapseConsole() { if (_instance) _instance.collapse(); }
