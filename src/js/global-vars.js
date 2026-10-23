/* ============================================================
   GLOBAL VARIABLES BAR — canvas top toolbar
   ============================================================ */
import { state, toast } from './state.js';
import { render } from './render.js';
import { capture, beginEdit, endEdit } from './history.js';
import { t } from './i18n.js';

let _adding = false; // whether the new-var name input is currently shown

// Hidden mirror <span> 用于精确测量 input 文本宽度 (含 padding/border),
// 一次性创建, 全局复用, 避免每次 insert + remove 触发 reflow.
let _widthMirror = null;
function _getWidthMirror() {
    if (_widthMirror) return _widthMirror;
    _widthMirror = document.createElement('span');
    _widthMirror.style.cssText =
        'position:absolute;visibility:hidden;pointer-events:none;' +
        'left:-9999px;top:-9999px;white-space:pre;';
    document.body.appendChild(_widthMirror);
    return _widthMirror;
}

/**
 * dict/list 初始化值校验：JSON 语法合法 + 顶层类型匹配变量类型。
 * 返回 null = 通过；'json' = JSON 语法错误；'type' = 顶层类型不匹配
 * （dict 须为纯对象、list 须为数组；null / 标量 / 数组↔对象不匹配都拒绝）。
 * 非 dict/list 类型恒通过。导出为纯函数便于单测。
 */
export function validateGVValue(type, text) {
    if (type !== 'dict' && type !== 'list') return null;
    let v;
    try { v = JSON.parse(text); }
    catch (e) { return 'json'; }
    if (type === 'dict') return (v !== null && typeof v === 'object' && !Array.isArray(v)) ? null : 'type';
    return Array.isArray(v) ? null : 'type';
}

/* ═══════════════════════════════════════════════════
   全局变量拖拽排序
   ═══════════════════════════════════════════════════ */
// 只在 .gv-item__name（变量名）上按住拖动。位移超过 DRAG_THRESHOLD_PX 才进入拖拽，
// 未超过视为普通点击（名字本身无点击行为，不产生副作用）。
let _drag = null;                       // { idx, item, startX, startY, active, slot }
const DRAG_THRESHOLD_PX = 4;

/**
 * 计算 clientX 命中的插入槽位（minSlot..items.length）。
 * items 为剩余项（不含被拖项）；指针落在该项中线左侧 → 插到该项之前。
 * minSlot 用于钳制：固定系统变量（device_id）排最前，其它变量不允许停靠到它前面
 * （槽位 0 被禁 → 最小可停靠槽位 = 1）。
 * 导出为纯函数便于单测（jsdom 无布局，测试传 mock rect 的项即可）。
 */
export function dropSlotForX(items, clientX, minSlot = 0) {
    if (!items || items.length === 0) return 0;
    for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (clientX < r.left + r.width / 2) return Math.max(i, minSlot);
    }
    return Math.max(items.length, minSlot);
}

// 竖线指示器：绝对定位在 #gvItems 内（不参与 flex 布局），left 用 content 坐标（offsetLeft），
// 随容器横向滚动保持一致。每次 renderGlobalVars() 重建 innerHTML 会把它冲掉，
// _getDropLine 检测 isConnected 失效后重新创建。
let _dropLine = null;
function _getDropLine() {
    const container = document.getElementById('gvItems');
    if (!container) return null;
    if (_dropLine && _dropLine.isConnected) return _dropLine;
    _dropLine = document.createElement('div');
    _dropLine.className = 'gv-drop-line';
    _dropLine.style.display = 'none';
    container.appendChild(_dropLine);
    return _dropLine;
}
/**
 * 计算指示竖线在完整布局（含被拖项，all 按下标顺序）中的 left。
 * di = 被拖项当前下标；k = 落位后的最终下标。
 * 用"落位后前一位"的右缘定位（蓝线 = 插入边界，即被拖项最终前一位的右缘）：
 *   - k=0          → 最前（all[0] 左缘）
 *   - 其它(k≥1)    → 前一位 = k<=di ? all[k-1] : all[k]，右缘 + DROP_LINE_SEP_OFFSET
 * 因此拖末位变量保持原位（di=k=M-1）时前一位是 all[M-2] → 线在它**前面**，
 * 符合"位置不变则蓝线在变量左边"；拖其它项到末尾时前一位是 all[M-1] → 线在末项右侧。
 * DROP_LINE_SEP_OFFSET：对齐变量分隔线（.gv-item:not(:first-child)::before 1px +
 * .gv__items gap 6px，分隔线中心 = 前项右缘 + 6 + 0.5），2px 蓝线中心对准它：6 + 0.5 - 1 = 5.5。
 * 导出为纯函数便于单测。
 */
export const DROP_LINE_SEP_OFFSET = 5.5;
export function dropLineLeft(all, di, k) {
    const M = all.length;
    if (M === 0) return 0;
    if (k <= 0) return all[0].offsetLeft;
    const neighbor = (k <= di) ? all[k - 1] : all[k];
    return neighbor.offsetLeft + neighbor.offsetWidth + DROP_LINE_SEP_OFFSET;
}

function _showDropLine(slot) {
    const container = document.getElementById('gvItems');
    const line = _getDropLine();
    if (!container || !line || !_drag) return;
    const all = [...container.querySelectorAll('.gv-item')];   // 含被拖项，下标即当前顺序
    line.style.left = dropLineLeft(all, _drag.idx, slot) + 'px';
    line.style.display = 'block';
}
function _hideDropLine() {
    if (_dropLine && _dropLine.isConnected) _dropLine.style.display = 'none';
}

function _dragMove(e) {
    if (!_drag) return;
    if (!_drag.active) {
        const dx = e.clientX - _drag.startX;
        const dy = e.clientY - _drag.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        _drag.active = true;
        _drag.item.classList.add('gv-item--dragging');
        document.body.classList.add('gv-dragging');
    }
    const container = document.getElementById('gvItems');
    if (!container) return;
    const items = [...container.querySelectorAll('.gv-item')].filter(el => el !== _drag.item);
    // 固定项（device_id）排最前：其余变量不允许停靠到它前面 → 最小槽位钳到 1
    const minSlot = items[0] && items[0].dataset.fixed === '1' ? 1 : 0;
    _drag.slot = dropSlotForX(items, e.clientX, minSlot);
    _showDropLine(_drag.slot);
}

function _dragEnd() {
    if (!_drag) return;
    const { idx, item, active, slot } = _drag;
    _drag = null;
    item.classList.remove('gv-item--dragging');
    document.body.classList.remove('gv-dragging');
    _hideDropLine();
    if (!active || slot < 0) return;                // 未超过阈值 → 普通点击，不排序
    if (!state.globalVars[idx]) return;             // stale 守卫（切工程等竞态）
    capture();   // 拖拽排序提交：一次手势一步撤销
    const gv = state.globalVars[idx];
    state.globalVars.splice(idx, 1);
    state.globalVars.splice(slot, 0, gv);
    renderGlobalVars();
    syncToolbar();
    render();
}

function _dragCancel() {
    if (!_drag) return;
    _drag.item.classList.remove('gv-item--dragging');
    document.body.classList.remove('gv-dragging');
    _drag = null;
    _hideDropLine();
}

/**
 * Render all global variable items from state.globalVars into #gvItems.
 */
export function renderGlobalVars() {
    const container = document.getElementById('gvItems');
    if (!container) return;
    container.innerHTML = '';

    (state.globalVars || []).forEach((gv, idx) => {
        const item = document.createElement('div');
        item.className = 'gv-item';
        item.dataset.idx = idx;
        item.dataset.fixed = gv.fixed ? '1' : '0';   // 拖拽时用于识别"固定项不可被停靠在前面"

        // Name label — 也是拖拽排序手柄（按住拖动，位移超阈值进入拖拽）。
        // fixed 系统变量（device_id）固定排在最前，不允许拖动。
        const nameEl = document.createElement('span');
        nameEl.className = 'gv-item__name';
        nameEl.textContent = gv.name;
        if (!gv.fixed) {
            nameEl.classList.add('gv-item__name--draggable');
            nameEl.title = t('tooltip.dragSort');
            nameEl.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;   // 仅左键
                _drag = { idx, item, startX: e.clientX, startY: e.clientY, active: false, slot: -1 };
            });
        }
        item.appendChild(nameEl);

        // Type dropdown (only for custom vars; device_id is fixed 'string')
        if (!gv.fixed) {
            const typeSel = document.createElement('select');
            typeSel.className = 'gv-item__type';
            ['string', 'number', 'boolean', 'dict', 'list'].forEach(t => {
                const opt = document.createElement('option');
                opt.value = t; opt.textContent = t;
                if (gv.type === t) opt.selected = true;
                typeSel.appendChild(opt);
            });
            typeSel.addEventListener('change', () => {
                capture();
                state.globalVars[idx].type = typeSel.value;
                state.dirty = true;
                // dict/list 的值输入是多行 textarea，切换类型后重建当前项
                renderGlobalVars();
                syncToolbar();
            });
            item.appendChild(typeSel);
        }

        // Value input
        // Placeholder 是动态的：光标闪烁（focused）→ "初始化值"，
        // 未输入（blurred 且 value 为空）→ "命令传参"（dict/list 显示 JSON 示例）。
        // 这两个文案把 "由谁提供值" 的意图直接写在 UI 上，
        // 旧版的 "脚本传入" 勾选框已去掉（M1 决策：CLI args 优先于项目值；
        // 项目值为空即表示走 CLI 通道）。
        //
        // 提交语义：
        //   Esc              → 退回本次编辑前的值（focus 时快照）, blur
        //   Enter            → 写入并 blur
        //   在 input 之外的 pointerdown（左/右键都算）→ 同 Enter
        //   blur 时清理挂在外面的 document 监听, 防止泄漏
        //
        // 为什么用 pointerdown 而不是 mousedown：
        //   interactions.js 的 .canvas pointerdown handler 在画布空白处会 preventDefault,
        //   按 W3C spec 这会抑制后续 mousedown 触发, 导致鼠标点画布空白时
        //   input 不会自动 blur, document 上的 mousedown listener 也收不到。
        //   在 capture 阶段监听 pointerdown 可以早于 canvas handler 跑, 不受 preventDefault 影响。
        //
        // dict/list：值输入用多行 textarea（自动高度，超限内部滚动），提交时校验 JSON，
        // 非法则 toast 提示并恢复编辑前值（避免坏值进入序列化）。
        const isMulti = gv.type === 'dict' || gv.type === 'list';
        const valInput = isMulti
            ? Object.assign(document.createElement('textarea'), { rows: 1, wrap: 'off' })
            : Object.assign(document.createElement('input'), { type: 'text' });
        valInput.className = isMulti ? 'gv-item__value gv-item__value--multi' : 'gv-item__value';
        valInput.value = gv.value != null ? String(gv.value) : '';
        const blurPlaceholder = isMulti ? t('gv.noCliPlaceholder') : t('gv.cmdPlaceholder');
        valInput.placeholder = blurPlaceholder;   // 默认 = blurred 态
        // 自适应宽度: 用隐藏 mirror span 测量文本精确像素宽度 (含 padding/border),
        // 直接设为 valInput.style.width。空值 (显示 placeholder) 时也按 placeholder 宽度算,
        // 不设下限 —— 用户要求"正好能显示提示字符的宽度", 再额外 +5px 右边留白。
        // 多行输入（dict/list）：宽度按"最宽一行"自适应 —— 若按整体文本测宽，
        // 输入少量字时框很窄，配合软换行会折成两行；textarea 用 white-space:pre
        // 禁止软换行（\n 换行保留），宽度=最宽行则每行都完整显示，不会出现
        // 垂直滚动条/伪两行。
        const _RIGHT_PADDING_EXTRA_PX = 5;
        const updateValueWidth = () => {
            const mirror = _getWidthMirror();
            const cs = getComputedStyle(valInput);
            mirror.style.fontFamily = cs.fontFamily;
            mirror.style.fontSize = cs.fontSize;
            mirror.style.fontWeight = cs.fontWeight;
            mirror.style.fontStyle = cs.fontStyle;
            mirror.style.letterSpacing = cs.letterSpacing;
            mirror.style.paddingLeft = cs.paddingLeft;
            mirror.style.paddingRight = cs.paddingRight;
            mirror.style.borderLeftWidth = cs.borderLeftWidth;
            mirror.style.borderRightWidth = cs.borderRightWidth;
            mirror.style.boxSizing = cs.boxSizing;
            const text = valInput.value || valInput.placeholder || '';
            const widest = text.split('\n').reduce((a, b) => a.length > b.length ? a : b, '');
            mirror.textContent = widest;
            valInput.style.width = (mirror.getBoundingClientRect().width + _RIGHT_PADDING_EXTRA_PX) + 'px';
        };
        // dict/list 多行输入：内容驱动高度（1 行起）。
        // scrollHeight 是内容高（含 padding），border-box 下 height 需再补上下边框高，
        // 否则内容区被 border 吃掉 2px → 溢出出现滚动区（overflow:hidden 会裁掉末行底部）。
        const autosizeValue = () => {
            if (!isMulti) return;
            const cs = getComputedStyle(valInput);
            const borderV = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
            valInput.style.height = 'auto';
            valInput.style.height = (valInput.scrollHeight + borderV) + 'px';
        };
        updateValueWidth();
        autosizeValue();
        // 字体可能还没下载完 (MapleMono 6-7MB woff2, font-display: swap).
        // 首次测量会用 fallback 字体宽度, 比真实字体窄. 等字体就绪后再测一次.
        // document.fonts.ready 是 Promise: 字体已加载则立即 resolve, 未加载则等加载完.
        // 重复注册多个 .then 都接同一个 Promise, 字体就绪时一起触发, 每个 closure 修正自己的 valInput。
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => { updateValueWidth(); autosizeValue(); });
        }
        // Esc 恢复目标 = 进入编辑时看到的值（focus 时快照）, 用 let 方便 focus 重写
        let originalValue = valInput.value;
        valInput.addEventListener('focus', () => {
            originalValue = valInput.value;
            if (!valInput.value) valInput.placeholder = t('gv.initPlaceholder');
        });
        valInput.addEventListener('blur', () => {
            if (!valInput.value) valInput.placeholder = blurPlaceholder;
            // dict/list 校验：值变了且校验失败（语法错误或类型不匹配）→ toast + 恢复编辑前值
            // （Esc 恢复后值未变则跳过）
            const gv = state.globalVars[idx];
            if (gv && isMulti && valInput.value && valInput.value !== originalValue) {
                const err = validateGVValue(gv.type, valInput.value);
                if (err) {
                    toast(t(err === 'json'
                        ? 'toast.gvInvalidJson'
                        : (gv.type === 'dict' ? 'toast.gvDictType' : 'toast.gvListType')));
                    valInput.value = originalValue;
                    gv.value = originalValue;
                }
            }
            // blur 后也要按当前 value/placeholder 重算一次 size,
            // 因为 focus 期间 placeholder 切换为 "初始化值", 长度可能不同
            updateValueWidth();
            endEdit();   // Enter / Esc / 外部 pointerdown 三条提交路径都以 blur 收尾，一处关闭会话
        });
        valInput.addEventListener('input', () => {
            beginEdit();   // 首次输入捕获编辑前状态；整段编辑会话一步撤销
            state.globalVars[idx].value = valInput.value;
            state.dirty = true;
            updateValueWidth();
            autosizeValue();
        });
        valInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                e.preventDefault();
                valInput.value = originalValue;
                state.globalVars[idx].value = originalValue;
                updateValueWidth();
                valInput.blur();
            } else if (e.key === 'Enter') {
                // 统一提交语义：dict/list 的 textarea 也不支持 Enter 换行（多行内容靠粘贴）；
                // 换行符会保留在 value 里并随内容撑高显示。
                e.preventDefault();
                state.globalVars[idx].value = valInput.value;
                state.dirty = true;
                valInput.blur();
            }
        });

        item.appendChild(valInput);

        // Remove button (only for custom vars)
        if (!gv.fixed) {
            const rmBtn = document.createElement('button');
            rmBtn.className = 'gv-item__remove';
            rmBtn.textContent = '−';
            rmBtn.addEventListener('click', () => {
                capture();
                state.globalVars.splice(idx, 1);
                renderGlobalVars();
                syncToolbar();
                render();
            });
            item.appendChild(rmBtn);
        }

        container.appendChild(item);
    });

    // Render the new-name input if we're in "adding" state
    if (_adding) _renderNewNameInput();
}

/** Insert the new-variable name input before the [+] button */
function _renderNewNameInput() {
    const container = document.getElementById('gvItems');
    const addBtn = document.getElementById('gvAdd');
    if (!container || !addBtn) return;

    // Remove any existing new-name input
    const existing = container.querySelector('.gv__new-name');
    if (existing) existing.remove();

    const inp = document.createElement('input');
    inp.className = 'gv__new-name';
    inp.type = 'text';
    inp.placeholder = t('gv.namePlaceholder');
    inp.style.marginLeft = '4px';

    const confirm = () => {
        const name = inp.value.trim();
        inp.remove();
        _adding = false;
        if (name && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            // Check for duplicate
            if ((state.globalVars || []).some(gv => gv.name === name)) {
                toast(t('toast.gvExists', { name }));
                return;
            }
            capture();
            state.globalVars.splice(state.globalVars.length, 0, {
                name, type: 'string', value: '', fixed: false,
            });
            renderGlobalVars();
            syncToolbar();
            render();
        } else if (name) {
            toast(t('toast.gvInvalid'));
        }
    };

    inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); confirm(); }
        if (e.key === 'Escape') { inp.remove(); _adding = false; }
    });
    inp.addEventListener('blur', () => {
        // Small delay so click on other elements processes first
        setTimeout(() => {
            if (document.contains(inp)) confirm();
        }, 150);
    });

    container.appendChild(inp);
    inp.focus();
}

/**
 * Adjust toolbar right edge to account for expanded code preview panel.
 * Called from code-preview.js when panel expands/collapses.
 * @param {number|null} panelWidth - width in px of expanded code preview, or null if collapsed
 */
export function syncToolbar(panelWidth) {
    const toolbar = document.getElementById('canvasToolbar');
    if (!toolbar) return;

    // When panelWidth is not passed explicitly, query the live code-preview state
    if (panelWidth === undefined) {
        const cp = document.getElementById('codePreview');
        if (cp && !cp.classList.contains('code-preview--collapsed')) {
            panelWidth = cp.getBoundingClientRect().width;
        } else {
            panelWidth = null;
        }
    }

    if (panelWidth) {
        toolbar.style.right = panelWidth + 'px';
        // M2: row 2 (.canvas-toolbar--row2) 也跟随 code-preview 收缩，避免被遮
        const row2 = document.getElementById('canvasToolbarRow2');
        if (row2) row2.style.right = panelWidth + 'px';
    } else {
        toolbar.style.right = '';
        const row2 = document.getElementById('canvasToolbarRow2');
        if (row2) row2.style.right = '';
    }

    // Body is now position:absolute — follows header automatically via CSS.
    // No manual syncPalettePosition needed.
}

/**
 * Initialize the global variables bar. Call once on startup.
 */
export function initGlobalVars() {
    // Module-level document listeners — registered ONCE for the app lifetime.
    //
    // Why not per-item: 之前每个 input 都注册一份 document pointerdown/contextmenu,
    // 然后靠 blur 时 removeEventListener 清理。问题:
    //   1. cleanup 函数引用的 commitExternalClick / blockContextMenuOutside 是错的变量名,
    //      removeEventListener 从来没真生效, listener 跨 renderGlobalVars() 一直累计。
    //   2. listener 闭包捕获的 idx 是注册时的; 多次 add/remove 后, 旧 listener 用 stale idx
    //      访问 state.globalVars[idx] 会得到 undefined → "Cannot set properties of undefined"。
    //   3. 切工程会调 renderGlobalVars() 重渲染, 旧 listener 全部失效但还在 document 上。
    //
    // 现在改为: 一个 module-level 监听器, 在事件触发时通过 DOM (activeElement + closest +
    // data-idx) 实时定位当前正在编辑的 input 和对应的 state 索引。加 stale idx 守卫。
    document.addEventListener('pointerdown', (e) => {
        const input = document.activeElement;
        if (!input || !input.classList || !input.classList.contains('gv-item__value')) return;
        if (input.contains(e.target)) return;  // 点 input 内部不算"外部"
        const item = input.closest('.gv-item');
        if (!item) return;
        const idx = Number(item.dataset.idx);
        if (!Number.isFinite(idx) || !state.globalVars[idx]) return;  // stale idx 守卫
        state.globalVars[idx].value = input.value;
        state.dirty = true;
        input.blur();
    }, true);  // capture phase, 早于 canvas 的 .canvas pointerdown handler
    // input 外右键: 阻止默认菜单, 避免和编辑状态冲突 (window 全局 contextmenu 已被
    // interactions.js 拦下过; 这里只针对 activeElement 是 gv input 的情况)
    document.addEventListener('contextmenu', (e) => {
        const input = document.activeElement;
        if (!input || !input.classList || !input.classList.contains('gv-item__value')) return;
        if (input.contains(e.target)) return;
        e.preventDefault();
    });

    // 全局变量拖拽排序：move/up/cancel 挂在 document 上（一次注册，app 生命周期内不重复挂）。
    // pointerdown 在 renderGlobalVars() 里按 item 绑定到 .gv-item__name（名字是手柄）。
    document.addEventListener('pointermove', _dragMove);
    document.addEventListener('pointerup', _dragEnd);
    document.addEventListener('pointercancel', _dragCancel);

    const addBtn = document.getElementById('gvAdd');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            if (_adding) return;
            _adding = true;
            _renderNewNameInput();
        });
    }

    renderGlobalVars();

    // Horizontal scroll via mouse wheel when hovering over the bar
    const bar = document.getElementById('globalVarsBar');
    if (bar) {
        bar.addEventListener('wheel', (e) => {
            const items = document.getElementById('gvItems');
            if (items && items.scrollWidth > items.clientWidth) {
                e.preventDefault();
                items.scrollLeft += e.deltaY;
            }
        }, { passive: false });
    }

    // Position bar to leave room for add-node button
    syncToolbar();
    window.addEventListener('resize', syncToolbar);
    if (window.MutationObserver) {
        const observer = new MutationObserver(syncToolbar);
        if (bar) observer.observe(bar, { childList: true, subtree: true, characterData: true });
    }
}
