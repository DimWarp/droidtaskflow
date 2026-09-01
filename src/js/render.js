/* ============================================================
   BUILD / RENDER
   ============================================================ */
import { state, DEFS, find, portColor, hash, toast, normalizeLogic, pickInputToRemove, nextInPortName } from './state.js';
import { E, editable, makePort, makeGotoMarkerPort } from './dom-utils.js';
import { bindWireDrag, drawWires } from './wires.js';
import { deriveGotoMarkers } from './goto.js';
import { scheduleAutoSave } from './filesystem.js';
import { refreshCodePreview } from './code-preview.js';
import { getCurrentFile } from './sidebar.js';
import { focusedNodeId, focusedCardId, zCounter, _nodeObserver } from './shared.js';

// 节点标题拖拽阈值：pointerdown 后位移超过此像素才视为拖拽（区别于纯点击选中）。
// 与 global-vars.js / task-palette.js 里的 DRAG_THRESHOLD_PX = 4 保持一致。
// — 为什么需要：标题是可点击的（点中节点聚焦 / 双击改名），用户拖动 / 选中意图冲突；
//   旧版 pointerdown 立即 moving=true → 1px 抖动就会位移；新版本阈值内算"纯点击"只选中。
const DRAG_THRESHOLD_PX = 4;
import { t as i18n } from './i18n.js';
import { capture, beginEdit, endEdit } from './history.js';

export function buildTask(t, ctx) {
    const d = DEFS[t.def];
    if (!d) {
        // 卡片未在 DEFS 里（用户用 custom_task.py 定义的、但工作区没打开 / 加载失败），
        // 旧版显示 "??" 让人困惑。改成明确错误：标 def 名 + 指引去 custom_task.py 加。
        return E('div', 'task task--undefined', null, [
            E('div', 'task__undefined-msg', {
                title: i18n('canvas.cardUndefined', { def: t.def }),
            }, i18n('canvas.cardUndefined', { def: t.def })),
        ]);
    }

    let outColors = t._cols;
    if (!outColors || Object.keys(outColors).length !== d.rets.length) {
        outColors = d.rets.reduce((m, r, i) => { m[r.n] = portColor(hash(t.id), i, d.rets.length); return m; }, {});
        t._cols = outColors;
    }

    const inColor = {};
    for (const [pn, src] of Object.entries(t.in)) {
        const [sid, sn] = src.split('.');
        const s = find(sid);
        if (s && s._cols && s._cols[sn]) inColor[pn] = s._cols[sn];
    }

    const lines = d.params.filter(p => p.t === 'line' || p.t === 'both');
    const boxes = d.params.filter(p => p.t !== 'line');
    const rets  = d.rets;
    const n = Math.max(lines.length, rets.length);

    let wires = null;
    if (n > 0) {
        const inp = [], out = [];
        for (let i = 0; i < n; i++) {
            const lp = lines[i], rp = rets[i];
            inp.push(E('div', 'wire-row', null, [
                lp ? makePort(t.id + '.' + lp.n, 'in', inColor[lp.n] || '', 'circle') : E('span', null, { style: { width: '14px', display: 'inline-block' } }),
                lp ? E('span', 'wire-row__label', null, lp.a) : '',
            ]));
            out.push(E('div', 'wire-row', null, [
                rp ? makePort(t.id + '.' + rp.n, 'out', outColors[rp.n], 'circle') : E('span', null, { style: { width: '14px', display: 'inline-block' } }),
                rp ? E('span', 'wire-row__label', null, rp.a) : '',
            ]));
        }
        wires = E('div', 'wires-zone', null, [
            E('div', 'wires-col wires-col--input', null, inp),
            E('div', 'wires-mid'),
            E('div', 'wires-col wires-col--output', null, out),
        ]);
    }

    let fields = null;
    if (boxes.length > 0) {
        const fs = boxes.map(p => {
            let inp;
            if (p.t === 'code') {
                // 代码输入框：行号列 + 高亮层(pre) + 透明文字 textarea。
                // 高度由高亮层 pre 内容自动撑起，宽度拖拽改变折行后 pre 自动重排，
                // 高度/行号由 syncCodeField 同步（见节点缩放 pointermove/up）。
                const gutter = E('div', 'code-field__gutter', null, [E('div', null, null, '1')]);
                const hl = E('pre', 'code-field__hl');
                const ta = E('textarea', 'field__input', {
                    value: t.f[p.n] != null ? t.f[p.n] : '',
                    'data-autosize': '1',
                    wrap: 'soft',
                    rows: 3,
                    spellcheck: false,
                    oninput: function() {
                        beginEdit(); t.f[p.n] = this.value; state.dirty = true;
                        syncCodeField(this);
                    },
                    onblur: () => endEdit(),
                });
                ta._gutter = gutter;
                ta._hl = hl;
                ta.addEventListener('compositionstart', () => ta.classList.add('code-field__composing'));
                ta.addEventListener('compositionend', () => { ta.classList.remove('code-field__composing'); syncCodeField(ta); });
                inp = E('div', 'code-field', null, [gutter, E('div', 'code-field__editor', null, [hl, ta])]);
            } else if (p.t === 'list') {
                inp = E('select', 'field__input', { value: t.f[p.n] != null ? t.f[p.n] : '', onchange: function() { capture(); t.f[p.n] = this.value; state.dirty = true; } },
                    (p.opts || []).map(o => E('option', null, { value: o }, o))
                );
                // E() 的 value 在 option 追加前设置，jsdom/浏览器对 select 不生效，
                // 必须追加后显式赋值才能选中对应项。
                inp.value = t.f[p.n] != null ? t.f[p.n] : '';
            } else if (p.t === 'global_var') {
                // 全局变量选择：下拉列出当前工程的全局变量（带"选择变量"占位项）
                const opts = (state.globalVars || []).map(gv => gv.name);
                inp = E('select', 'field__input', { onchange: function() { capture(); t.f[p.n] = this.value; state.dirty = true; } }, [
                    E('option', null, { value: '', disabled: true }, i18n('canvas.chooseVar')),
                    ...opts.map(o => E('option', null, { value: o }, o)),
                ]);
                inp.value = t.f[p.n] != null ? t.f[p.n] : '';
            } else if (p.t === 'image') {
                const imgData = t.f[p.n] || '';
                if (imgData) {
                    const img = E('img', null, { src: imgData, draggable: false });
                    inp = E('div', 'field__image', null, [img]);
                } else {
                    inp = E('div', 'field__image field__image--empty', null, i18n('canvas.insertImage'));
                }
                inp.addEventListener('click', () => _showImagePopup(t, p.n));
            } else {
                const oninput = function() { beginEdit(); t.f[p.n] = this.value; state.dirty = true; };
                inp = E('input', 'field__input', { type: 'text', value: t.f[p.n] != null ? t.f[p.n] : '', oninput, onblur: () => endEdit() });
            }
            const pct = (p.w || 1) * 100;
            const basis = pct < 100 ? `calc(${pct}% - 3px)` : '100%';
            return E('div', 'field', { style: { flex: `0 0 ${basis}`, maxWidth: `${pct}%` } }, [E('label', 'field__label', null, p.a), inp]);
        });
        fields = E('div', 'field-row', null, fs);
    }

    const title = editable(t._name || d.alias, v => { capture(); t._name = v; render(); }, 'task__title');
    const head = E('div', 'task__head', null, title);
    const body = E('div', 'task__body', null, [wires, fields].filter(Boolean));
    return E('article', 'task', { 'data-task-id': t.id }, [head, body]);
}

/* 代码输入框同步：渲染 Python 高亮（pre）+ 逻辑行号（gutter）。
   高亮层按"每逻辑行一个 block div"渲染（div 内再包 token span）——textarea 的软换行
   也是按行独立布局，两者折行点一致（裸文本/连续内联流会与 textarea 折行不同，已实测），
   故拖动节点宽度改变折行后重渲染即自动收缩/撑高（高度由 pre 内容撑起，textarea 绝对
   定位铺满容器，无需 JS 管高度）。
   行号按逻辑行（\n 分隔）编号：行号 div 高度 = 对应逻辑行实际显示高度，软换行折出的
   行在 gutter 留空。offsetWidth 为 0 说明未挂载/无布局（jsdom），跳过。 */
function syncCodeField(ta) {
    if (!ta.offsetWidth) return;
    const hl = ta._hl;
    const g = ta._gutter;
    if (hl) {
        const lines = ta.value.split('\n');
        let html = '';
        for (const ln of lines) {
            // 空行用 nbsp 占位保证 block div 有行高；高亮按行执行
            html += '<div>' + highlightPython(ln.length ? ln : '\u00a0') + '</div>';
        }
        hl.innerHTML = html;
    }
    if (g && hl) {
        let gh = '';
        const kids = hl.children;
        for (let i = 0; i < kids.length; i++) {
            // 行高取浮点（getBoundingClientRect）避免 offsetHeight 取整累加误差；
            // 画布有 transform: scale(state.zoom)，rect 返回的是缩放后的屏幕高度，
            // 必须除以 zoom 还原为布局像素，否则行号 div 高度被二次缩放——
            // zoom<1 行号挤在一起、zoom>1 行号间距偏大（与 alignExitPorts 同一处理模式）。
            const h = kids[i].getBoundingClientRect().height / state.zoom;
            gh += '<div style="height:' + h + 'px">' + (i + 1) + '</div>';
        }
        g.innerHTML = gh;
    }
}
function syncAllCodeFields() {
    document.querySelectorAll('textarea.field__input[data-autosize]').forEach(syncCodeField);
}
function syncNodeCodeFields(root) {
    root.querySelectorAll('textarea.field__input[data-autosize]').forEach(syncCodeField);
}
// 自托管字体 font-display: swap：字体加载完成后字符宽度变化 → 折行变化，
// 重测一次全部代码框（首次 render 若在字体就绪前，折行/行号按 fallback 字体算会偏）。
if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => syncAllCodeFields());
}

/* 极简 Python 语法高亮：注释 / 字符串（含三引号与前缀）/ 数字 / 装饰器 / 关键字 / 内置函数。
   按"单行"调用（每逻辑行独立高亮，行容器保证与 textarea 折行一致）。
   单次正则交替匹配——字符串、注释整段吞掉，其内部不再二次匹配；输出已转义 HTML。
   仅做"够用"级别的显示高亮，不追求完整词法。 */
const _PY_RE = /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|(?:[rRbBuUfF]{0,2})"(?:[^"\\\n]|\\.)*"|(?:[rRbBuUfF]{0,2})'(?:[^'\\\n]|\\.)*')|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(@[\w.]+)|(\b(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b)|(\b(?:abs|all|any|bin|bool|bytearray|bytes|callable|chr|classmethod|compile|complex|delattr|dict|dir|divmod|enumerate|eval|exec|filter|float|format|frozenset|getattr|globals|hasattr|hash|help|hex|id|input|int|isinstance|issubclass|iter|len|list|locals|map|max|memoryview|min|next|object|oct|open|ord|pow|print|property|range|repr|reversed|round|set|setattr|slice|sorted|staticmethod|str|sum|super|tuple|type|vars|zip|__import__)\b)/g;
function _escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function highlightPython(code) {
    let out = '', last = 0, m;
    while ((m = _PY_RE.exec(code))) {
        out += _escHtml(code.slice(last, m.index));
        let cls;
        if (m[1] !== undefined) cls = 'tk-comment';
        else if (m[2] !== undefined) cls = 'tk-string';
        else if (m[3] !== undefined) cls = 'tk-number';
        else if (m[4] !== undefined) cls = 'tk-decorator';
        else if (m[5] !== undefined) cls = 'tk-keyword';
        else cls = 'tk-builtin';
        out += '<span class="' + cls + '">' + _escHtml(m[0]) + '</span>';
        last = m.index + m[0].length;
    }
    out += _escHtml(code.slice(last));
    return out;
}

function _showImagePopup(task, paramName) {
    let currentData = task.f[paramName] || '';
    const overlay = E('div', 'image-popup-overlay', { tabindex: '-1' });
    const popup = E('div', 'image-popup');

    const previewArea = E('div', 'image-popup__preview' + (currentData ? '' : ' image-popup__preview--empty'));

    function updatePreview() {
        previewArea.innerHTML = '';
        previewArea.className = 'image-popup__preview' + (currentData ? '' : ' image-popup__preview--empty');
        if (currentData) {
            previewArea.appendChild(E('img', null, { src: currentData }));
        } else {
            previewArea.textContent = i18n('canvas.uploadImage');
        }
    }
    updatePreview();

    // Hidden file input
    const fileInput = E('input', null, { type: 'file', accept: 'image/*', style: { display: 'none' } });
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => { currentData = reader.result; updatePreview(); };
        reader.readAsDataURL(file);
    });

    previewArea.addEventListener('click', () => fileInput.click());

    // Clipboard read button — uses navigator.clipboard.read() (requires user gesture + localhost/https)
    const btnPaste = E('button', 'image-popup__paste', null, i18n('device.pasteFromClipboard'));
    btnPaste.addEventListener('click', async () => {
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const imgType = item.types.find(t => t.startsWith('image/'));
                if (imgType) {
                    const blob = await item.getType(imgType);
                    const reader = new FileReader();
                    reader.onload = () => { currentData = reader.result; updatePreview(); };
                    reader.readAsDataURL(blob);
                    return;
                }
            }
            toast(i18n('device.clipboardNoImage'));
        } catch (e) {
            toast(i18n('device.clipboardReadFail', { msg: e.message }));
        }
    });

    // Close & cleanup
    function close() {
        overlay.remove();
    }

    const btnCancel = E('button', 'image-popup__cancel', null, i18n('dialog.cancel'));
    const btnOk = E('button', 'image-popup__ok', null, i18n('dialog.confirm'));
    btnCancel.addEventListener('click', close);
    btnOk.addEventListener('click', () => {
        capture();
        task.f[paramName] = currentData;
        state.dirty = true;
        close();
        render();
    });

    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

    const actions = E('div', 'image-popup__actions', null, [btnPaste, btnCancel, btnOk]);
    popup.append(previewArea, fileInput, actions);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
    overlay.focus();
}

/**
 * 渲染单个节点列元素（Info / 单个 Logic 子列）。
 * Operate 列结构特殊（含操作组），由 render() 内联构建。
 * 每个列元素挂 `data-col-type`（info|logic|operate），逻辑子列额外挂 `data-logic-idx`。
 */
export function buildColumnEl(n, type, items, ctx, logicIdx, allEmpty, forceVisible) {
    const ds = { 'data-col-type': type };
    if (logicIdx != null) ds['data-logic-idx'] = String(logicIdx);
    const title = type === 'info' ? 'Info' : type === 'operate' ? 'Operate' : 'Logic-' + logicIdx;

    // LOGIC 激活时标题行右侧按钮（LOGIC 为空时占位列 forceVisible=false → 无按钮）：
    //   Logic-0 → "+" 添加新子列；Logic-i（i≥1）→ "−" 删除该子列。
    // "−" 与 "+" 位置/样式完全一致（复用 .col__add-subcol）；空子列同样带按钮（可删多余空列）。
    let titleEl;
    if (type === 'logic' && forceVisible) {
        const isAdd = logicIdx === 0;
        titleEl = E('div', 'col__title col__title--with-add', null, [
            E('span', null, null, title),
            E('button', 'col__add-subcol', {
                type: 'button',
            }, isAdd ? '+' : '−'),
        ]);
        titleEl.querySelector('.col__add-subcol').addEventListener(
            'click',
            isAdd ? () => addLogicSubColumn(n) : () => removeLogicSubColumn(n, logicIdx)
        );
    } else {
        titleEl = E('h3', 'col__title', null, title);
    }

    if (!items || items.length === 0) {
        if (forceVisible) {
            // LOGIC 激活时的空子列：不隐藏，显示标题 + 空提示（参与宽度均分）
            return E('div', 'col col--logic-empty', ds, [
                titleEl,
                E('div', 'col__empty', null, 'drop ' + ctx + ' here'),
            ]);
        }
        const cls = allEmpty ? 'col col--empty-all' : 'col col--empty';
        return E('div', cls, ds, [
            titleEl,
            E('div', 'col__empty', null, allEmpty ? `add ${ctx} task here` : `drop ${ctx} here`),
        ]);
    }
    return E('div', 'col', ds, [titleEl, ...items.map(t => buildTask(t, ctx))]);
}

/**
 * 节点出口跟随操作组数量：`n.outPorts` 长度恒等于 `n.groups.length`。
 * - `g.exit` 是操作组的**持久化属性**：重排组次序、增删组都不改变已有组的出口名
 *   （出口名是运行时匹配 `edge.from_exit` 的语义键，按下标重配对会让重排后的
 *   组指向错误的下一个节点）。
 * - 仅当组缺 `g.exit`（新建组 / 旧文件组不带 exit=）时才取名：优先取旧名池
 *   `n.outPorts` 里未被占用的名字（兼容 @node_exit 声明的 out/out2 等），
 *   池空则按序列派生 `out1/out2/…`。
 * - `n.outPorts` = 各组 exit 名，顺序 = 组顺序（出口端口与组行对齐）。
 */
export function normalizeExits(n) {
    if (!n.groups) n.groups = [];
    const used = new Set();
    const pool = Array.isArray(n.outPorts) ? n.outPorts.slice() : [];
    for (const g of n.groups) {
        if (g.exit && !used.has(g.exit)) { used.add(g.exit); continue; }
        const fromPool = pool.find(p => !used.has(p));
        g.exit = fromPool !== undefined ? fromPool : nextFreeExitName(used);
        used.add(g.exit);
    }
    n.outPorts = n.groups.map(g => g.exit);
    n.groups.forEach(g => { g.outTo = n.id + '.' + g.exit; });
}

/** 派生下一个可用出口名：沿用 out/out1/out2… 序列（'out' 视作 out1），返回最大号 + 1 */
function nextFreeExitName(used) {
    let max = 0;
    for (const nm of used) {
        const m = /^out(\d*)$/.exec(nm);
        if (!m) continue;
        const num = m[1] ? parseInt(m[1], 10) : 1;
        if (num > max) max = num;
    }
    return max === 0 ? 'out1' : 'out' + (max + 1);
}

/**
 * 节点出口端口与对应操作组出口方块口水平对齐：端口 i 的垂直中心 = 方块口 i 的垂直中心。
 * 在 render 将节点挂进 DOM 后调用（getBoundingClientRect 强制布局），
 * 每个 render 都会重算，组内增删任务等变化随之更新。
 *
 * 注意：getBoundingClientRect 返回的是 world transform（scale/pan）后的视口坐标，
 * 节点相对位移需除以 state.zoom 还原成节点本地坐标，否则缩放后端口会错位。
 */
export function alignExitPorts(el, n) {
    const ports = el.querySelectorAll('.node__port-rail--out .port');
    const sqPorts = el.querySelectorAll('.op-group__exit-port');
    if (!ports.length || !sqPorts.length) return;
    const scale = state.zoom || 1;
    const rail = el.querySelector('.node__port-rail--out');
    if (!rail) return;
    // rail 是端口的包含块（position:absolute; top:0），其原点在节点 padding 边
    // （border 内侧）。用 rail rect 做参考可自动抵消节点 border 的偏移，
    // 否则端口会恒定偏下 1px（节点 border 宽度）。
    const railRect = rail.getBoundingClientRect();
    ports.forEach((p, i) => {
        const sq = sqPorts[i];
        if (!sq) return;
        const sr = sq.getBoundingClientRect();
        const top = (sr.top - railRect.top) / scale + sr.height / scale / 2 - p.offsetHeight / 2;
        p.style.top = top + 'px';
    });
}

/**
 * 缩放 / 窗口尺寸变化后重新对齐所有节点的出口端口。
 * alignExitPorts 只在 render 时跑一次；真实浏览器缩放（Ctrl+滚轮）会改 innerWidth → resize →
 * 触发 reflow，方块口/rail 的 CSS 位置可能漂移，而圆口 top 是旧值 → 出口对不齐。
 * 缩放和 resize 时重跑（getBoundingClientRect 强制按当前布局重新测量）即可复平。
 */
export function realignAllExitPorts() {
    for (const n of state.nodes) {
        if (n.el) alignExitPorts(n.el, n);
    }
}

/** 末尾追加一个空 LOGIC 子列，并让所有列重新均分节点宽度 */
function addLogicSubColumn(n) {
    capture();
    if (!n.logic) n.logic = [];
    n.logic.push([]);
    // 新子列加入后所有列均分宽度（每列 1fr）；用户可随后拖拽分隔线调宽
    n.colF = Array(2 + n.logic.length).fill(1);
    render();
}

/**
 * 删除一个 LOGIC 子列及其内部任务卡片。
 * 连带清理：任何一端连到该列任务的连线、其他任务/操作组指向该列的 in 映射残留。
 * 删除后剩余列重新均分宽度（与 addLogicSubColumn 一致）。
 */
export function removeLogicSubColumn(n, idx) {
    capture();
    const removedIds = new Set((n.logic[idx] || []).map(t => t.id));
    if (removedIds.size > 0) {
        // 1) 移除任何一端连到被删列任务的连线
        state.wires = state.wires.filter(w => {
            const ft = w.from.split('.')[0];
            const tt = w.to.split('.')[0];
            return !removedIds.has(ft) && !removedIds.has(tt);
        });
        // 2) 清理其他任务 / 操作组的 in 映射残留（来源连线已删）
        for (const node of state.nodes) {
            for (const t of [...node.info, ...(node.logic || []).flat(), ...(node.groups || []).flatMap(g => g.ops)]) {
                if (t.in) {
                    for (const [k, v] of Object.entries(t.in)) {
                        if (removedIds.has(v.split('.')[0])) delete t.in[k];
                    }
                }
            }
            for (const g of (node.groups || [])) {
                if (g.in) {
                    for (const [k, v] of Object.entries(g.in)) {
                        if (removedIds.has(v.split('.')[0])) delete g.in[k];
                    }
                }
                // 组出口由 normalizeExits 自动配对（g.outTo 恒指向节点出口），无需在此清理
            }
        }
    }
    // 3) 删除子列；colF 重新均分（与 addLogicSubColumn 一致）
    n.logic.splice(idx, 1);
    n.colF = Array(2 + n.logic.length).fill(1);
    render();
}

/**
 * 保证 n.colF 长度 = 2 + LOGIC 列槽数（[info, logic0, ..., operate]）。
 * LOGIC 为空时仍保留 1 个"占位槽"（对应空态 Logic 列的 10px/等分宽度），
 * 因此期望长度 = 2 + max(1, LOGIC 子列数)。
 * 旧工程 [1, 1, 1.15]（3 个值）在单列 LOGIC 下长度正好匹配 → 原样保留。
 */
function ensureColF(n) {
    const expected = 2 + Math.max(1, (n.logic || []).length);
    if (!n.colF || n.colF.length !== expected) {
        n.colF = Array(expected).fill(1);
        if (expected >= 2) n.colF[expected - 1] = 1.15;
    }
    return n.colF;
}

/* ----------------------------------------------------------
   节点最小宽度 = 可视列数 × COL_MIN
   ---------------------------------------------------------- */

// 每列最小宽度（px）：列内内容可自行占满，节点最小宽只按列数保证不塌缩。
const COL_MIN = 180;

/**
 * 节点最小宽度 = 可视列数 × 每列最小宽 COL_MIN + 分隔线 + body padding + border。
 * 不按卡片内容推导（内容宽由布局自然扩展，仅列数决定下限）。
 * has 来自 colHas()（render 闭包）；goto 节点无三列，不调用本函数。
 */
export function nodeMinWidth(n, has) {
    const visible = has.filter(Boolean).length;
    if (visible === 0) return 320;   // 空节点保持默认
    return Math.round(COL_MIN * visible + (visible - 1) * 1 + 16 + 2);  // 分隔线1px×N-1 + body padding 16 + border 2
}

/** 渲染 goto 节点：标题 + 入口 rail（可增删）+ 目标下拉卡片。无出口、无三列。 */
function buildGotoNode(n, world) {
    if (!n.w) n.w = 560;
    if (!n.inPorts || !n.inPorts.length) n.inPorts = ['in'];
    n.outPorts = [];

    const h = editable(n.name, v => { capture(); n.name = v; render(); }, 'node__title');
    const hdr = E('header', 'node__header', null, h);
    // moving: 真在拖动（位移过阈值）。pending: pointerdown 已按但未超阈值（候选拖动）。
    // 区分二者：超阈值前算"纯点击"——只选中节点不进入拖动；超阈值才 capture 撤销并 moving。
    let mx, my, ox, oy, moving = false, pending = false, _moveRAF = null;
    hdr.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        if (e.target.contentEditable === 'true') return;
        // 记起点但不调 capture —— 阈值内松手 = 纯点击（只选中节点，不进撤销栈）。
        // 真进入拖动时再 capture 一次（只占"拖动前"那一帧，不浪费"纯点击"的撤销位）。
        pending = true; mx = e.clientX; my = e.clientY; ox = n.x; oy = n.y;
        n.el.style.willChange = 'transform';
    });
    document.addEventListener('pointermove', e => {
        if (pending && !moving) {
            if (Math.hypot(e.clientX - mx, e.clientY - my) < DRAG_THRESHOLD_PX) return;
            // 越过阈值 → 真进入拖动（捕获撤销 + 提升合成层）
            moving = true;
            capture();
        }
        if (!moving) return;
        n.x = ox + (e.clientX - mx) / state.zoom;
        n.y = oy + (e.clientY - my) / state.zoom;
        n.el.style.transform = `translate(${n.x - ox}px, ${n.y - oy}px)`;
        if (!_moveRAF) _moveRAF = requestAnimationFrame(() => { _moveRAF = null; drawWires(true); });
    });
    document.addEventListener('pointerup', () => {
        if (pending) {
            pending = false;
            // 纯点击：清除 willChange 提升，不改 state.dirty（已确认阈值内未位移）
            n.el.style.willChange = '';
        }
        if (!moving) return;
        moving = false;
        if (_moveRAF) { cancelAnimationFrame(_moveRAF); _moveRAF = null; }
        state.dirty = true;
        n.el.style.left = n.x + 'px';
        n.el.style.top = n.y + 'px';
        n.el.style.transform = '';
        n.el.style.willChange = '';
        drawWires(true);
        refreshCodePreview();
    });

    // 宽度调整手柄（同普通节点）：左/右边缘拖拽改 n.w
    const rL = E('div', 'node__resize-l');
    const rR = E('div', 'node__resize-r');
    let side = null, sx2, ow, ox2;
    [rL, rR].forEach(rh => {
        rh.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.stopPropagation();
            capture();   // 缩放手势起点
            side = rh.classList.contains('node__resize-l') ? 'L' : 'R';
            sx2 = e.clientX; ow = n.w; ox2 = n.x;
        });
    });
    document.addEventListener('pointermove', e => {
        if (!side) return;
        const dx = (side === 'R' ? e.clientX - sx2 : sx2 - e.clientX) / state.zoom;
        n.w = Math.max(107, Math.min(6000, ow + dx));   // goto 最小宽 320 → 107（320/3）
        if (side === 'L') { n.x = ox2 - (n.w - ow); n.el.style.left = n.x + 'px'; }
        n.el.style.width = n.w + 'px';
        drawWires();
    });
    document.addEventListener('pointerup', () => { if (side) state.dirty = true; side = null; });

    // 入口口颜色同普通节点：连线后取源节点出口颜色（无连线保持默认色）
    const inPortEls = n.inPorts.map(pn => {
        const w = state.wires.find(w => w.to === n.id + '.' + pn);
        let col = '';
        if (w) {
            const [sid, sn] = w.from.split('.');
            const sNode = state.nodes.find(x => x.id === sid);
            if (sNode && sNode._ncols && sNode._ncols[sn]) col = sNode._ncols[sn];
        }
        return makePort(n.id + '.' + pn, 'in', col, 'circle');
    });
    const btnAddIn = E('button', 'node__port-add', { 'data-tooltip': 'canvas.addIn' }, '+');
    btnAddIn.addEventListener('click', e => {
        e.stopPropagation();
        capture();
        // 最小可用后缀命名，避免删除中间入口后长度错位撞名
        n.inPorts.push(nextInPortName(n.inPorts));
        render();
    });
    inPortEls.push(btnAddIn);
    if (n.inPorts.length > 1) {
        const btnDelIn = E('button', 'node__port-add', { 'data-tooltip': 'canvas.delIn', style: { color: 'var(--on-surface-mute)' } }, '−');
        btnDelIn.addEventListener('click', e => {
            e.stopPropagation();
            capture();
            // 优先删未连线的入口（自下而上），全连线才删最底部；顺带清理指向被删口的线
            const idx = pickInputToRemove(state, n.id, n.inPorts);
            const removed = n.inPorts[idx];
            n.inPorts.splice(idx, 1);
            const portSrc = n.id + '.' + removed;
            state.wires = state.wires.filter(w => w.to !== portSrc);
            render();
        });
        inPortEls.push(btnDelIn);
    }
    const railIn = E('div', 'node__port-rail node__port-rail--in', null, inPortEls);

    const sel = E('select', 'field__input goto__target', { onchange: function() { capture(); n.target = this.value || null; state.dirty = true; render(); } }, [
        E('option', null, { value: '' }, i18n('canvas.chooseTarget')),
        ...state.nodes
            .filter(x => x.id !== n.id && x.type !== 'goto' && (state.nodes[0] ? x.id !== state.nodes[0].id : true))
            .map(x => E('option', null, { value: x.id }, x.name)),
    ]);
    sel.value = n.target || '';

    const nodeWireSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    nodeWireSvg.setAttribute('class', 'node__wires');
    const pCount = n.inPorts.length;
    const minH = 60 + (pCount + 1) * 32;
    const elStyle = { left: n.x + 'px', top: n.y + 'px', width: n.w + 'px' };
    if (pCount >= 2) elStyle['min-height'] = minH + 'px';
    const el = E('section', 'node node--goto', { style: elStyle }, [
        hdr, rL, rR, railIn, E('div', 'goto__card', null, [sel]), nodeWireSvg,
    ]);
    n.el = el;
    n._wireSvg = nodeWireSvg;
    world.appendChild(el);
    if (focusedNodeId != null && n.id === focusedNodeId) { el.classList.add('node--focused'); el.style.zIndex = zCounter; }
    if (_nodeObserver) _nodeObserver.observe(el);
}

export function render(skipDirty) {
    // 重建画布默认视为内容变更（绝大多数调用来自编辑操作），标记 dirty。
    // 纯重渲（语言切换、空画布启动渲染）传 true：文档内容没变，不标 dirty——
    // 否则 i18n 引导钩子会把"未打开的工程"误标 dirty，点击工程时
    // confirmSaveBeforeClose 误弹"保存更改"。
    if (!skipDirty) state.dirty = true;
    const world = document.getElementById('world');
    world.innerHTML = '';
    // 缩放/平移先应用：后续 alignExitPorts / drawWires 用 getBoundingClientRect 测量时
    // 拿到的就是当前 zoom 下的坐标（否则用上一帧的旧 transform，缩放后端口错位）。
    world.style.transform = `scale(${state.zoom}) translate(${state.panX}px, ${state.panY}px)`;
    const markersByNode = deriveGotoMarkers(state);
    // 预计算所有普通节点出口颜色（_ncols）：入口口颜色读取源节点 _ncols，
    // 若在渲染循环内边算边用，目标节点先于源节点渲染时取不到颜色（重载后首帧无色，
    // loadProjectFile 只 render 一次）。_ncols 只依赖 n.id + n.outPorts（纯函数），
    // 与渲染顺序无关，可在循环前统一算出。
    for (const n of state.nodes) {
        if (n.type === 'goto') continue;
        normalizeExits(n);
        if (!n._ncols || Object.keys(n._ncols).length !== n.outPorts.length) {
            n._ncols = n.outPorts.reduce((m, pn, i) => {
                m[pn] = portColor(hash(n.id), i + 100, 1000);
                return m;
            }, {});
        }
    }
    state.nodes.forEach(n => {
        if (n.type === 'goto') { buildGotoNode(n, world); return; }
        if (!n.w) n.w = 560;
        let nOutColors = n._ncols;
        if (!nOutColors || Object.keys(nOutColors).length !== n.outPorts.length) {
            nOutColors = n.outPorts.reduce((m, pn, i) => {
                m[pn] = portColor(hash(n.id), i + 100, 1000);
                return m;
            }, {});
            n._ncols = nOutColors;
        }
        const h = editable(n.name, v => { capture(); n.name = v; render(); }, 'node__title');
        const hdr = E('header', 'node__header', null, h);

        let mx, my, ox, oy, moving = false, pending = false, _moveRAF = null;
        hdr.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            if (e.target.contentEditable === 'true') return;
            // 阈值模式：阈值内算"纯点击"（只选中），超阈值才 capture + moving
            pending = true; mx = e.clientX; my = e.clientY; ox = n.x; oy = n.y;
            n.el.style.willChange = 'transform';
        });
        document.addEventListener('pointermove', e => {
            if (pending && !moving) {
                if (Math.hypot(e.clientX - mx, e.clientY - my) < DRAG_THRESHOLD_PX) return;
                moving = true;
                capture();
            }
            if (!moving) return;
            n.x = ox + (e.clientX - mx) / state.zoom;
            n.y = oy + (e.clientY - my) / state.zoom;
            // 用 transform 搬节点：不触发布局/重绘（合成器移动），结束再落回 left/top。
            // drawWires 走 rAF 节流：pointermove 频率（如 125Hz）常高于显示刷新率，
            // 每事件同步重画会吃满主线程 → 掉帧；线最多落后一帧，节点本体始终顺滑。
            n.el.style.transform = `translate(${n.x - ox}px, ${n.y - oy}px)`;
            if (!_moveRAF) _moveRAF = requestAnimationFrame(() => { _moveRAF = null; drawWires(true); });
        });
        document.addEventListener('pointerup', () => {
            if (pending) { pending = false; n.el.style.willChange = ''; }
            if (!moving) return;
            moving = false;
            if (_moveRAF) { cancelAnimationFrame(_moveRAF); _moveRAF = null; }
            state.dirty = true;
            n.el.style.left = n.x + 'px';
            n.el.style.top = n.y + 'px';
            n.el.style.transform = '';
            n.el.style.willChange = '';
            drawWires(true);   // 落回 left/top 后按最终坐标补画一次 cross
            refreshCodePreview();
        });

        const rL = E('div', 'node__resize-l');
        const rR = E('div', 'node__resize-r');
        let side = null, sx2, ow, ox2;
        [rL,rR].forEach(rh => {
            rh.addEventListener('pointerdown', e => {
                if (e.button !== 0) return;
                e.stopPropagation();
                capture();   // 缩放手势起点
                side = rh.classList.contains('node__resize-l') ? 'L' : 'R';
                sx2 = e.clientX; ow = n.w; ox2 = n.x;
            });
        });
        document.addEventListener('pointermove', e => {
            if (!side) return;
            const dx = (side === 'R' ? e.clientX - sx2 : sx2 - e.clientX) / state.zoom;
            // 最小宽 = 最宽卡片 × 可视列数（colHas 在同闭包内，pointermove 在 render 后触发）
            const nodeMinW = nodeMinWidth(n, colHas());
            n.w = Math.max(nodeMinW, Math.min(6000, ow + dx));
            if (side === 'L') { n.x = ox2 - (n.w - ow); n.el.style.left = n.x + 'px'; }
            n.el.style.width = n.w + 'px';
            drawWires();
            // 宽度变化 → 软换行折行数变化 → 代码框高度/行号需跟随（拖拽中实时更新）
            syncNodeCodeFields(n.el);
        });
        document.addEventListener('pointerup', () => {
            if (side) { state.dirty = true; syncNodeCodeFields(n.el); }   // 落定后再同步一次
            side = null;
        });

        // LOGIC 多列结构规范化（扁平旧数据 → 单列；清理空白列）
        normalizeLogic(n);
        ensureColF(n);
        // 节点出口强制跟随操作组数量（每组自动配对一个出口，见 normalizeExits）
        normalizeExits(n);
        // 入口接线点：默认单个 'in'（旧工程没有 inPorts 字段 → 迁移）
        if (!n.inPorts || !n.inPorts.length) n.inPorts = ['in'];
        const bodyRef = { el: null };
        let divGapIdx = null, dStartX = 0, dStartF = null;
        // 列内容标记：[info, logic0..logicN(或占位), operate]，与 colF/渲染列一一对应。
        // LOGIC 激活（任一子列有卡片）时，所有 LOGIC 子列（含空列）都算"有内容"→ 参与宽度均分。
        // LOGIC 为空（n.logic=[]）时仍保留 1 个 false 槽位——对应空态 Logic 占位列。
        const colHas = () => {
            const anyLogicCards = (n.logic || []).some(c => c.length > 0);
            return [
                (n.info || []).length > 0,
                ...((n.logic || []).length ? (n.logic || []).map(() => anyLogicCards) : [false]),
                (n.groups || []).length > 0,
            ];
        };
        const buildGrid = () => {
            const has = colHas();
            const allEmpty = has.every(h => !h);
            const parts = [];
            for (let i = 0; i < has.length; i++) {
                parts.push(has[i] ? n.colF[i] + 'fr' : (allEmpty ? '1fr' : '10px'));
                if (i < has.length - 1) parts.push((has[i] && has[i + 1]) ? '1px' : '0px');
            }
            return parts.join(' ');
        };
        const onDivMove = e => {
            if (divGapIdx == null) return;
            const dx = e.clientX - dStartX;
            const nodeW = n.w || 560;
            const totalF = dStartF.reduce((a, b) => a + b, 0);
            const pxPerF = (nodeW - 16) / totalF;
            const dF = dx / pxPerF;
            const MIN = 0.4;
            const nf = dStartF.slice();
            nf[divGapIdx] = Math.max(MIN, dStartF[divGapIdx] + dF);
            nf[divGapIdx + 1] = Math.max(MIN, dStartF[divGapIdx + 1] - dF);
            n.colF = nf;
            if (bodyRef.el) bodyRef.el.style.gridTemplateColumns = buildGrid();
            drawWires();
        };
        const onDivUp = () => {
            if (divGapIdx == null) return;
            state.dirty = true;
            divGapIdx = null;
            document.removeEventListener('pointermove', onDivMove);
            document.removeEventListener('pointerup', onDivUp);
        };

        const allNodeEmpty = (n.info||[]).length===0 && !(n.logic||[]).some(c=>c.length>0) && (n.groups||[]).length===0;
        // LOGIC 是否激活：任一子列有卡片 → 所有子列（含空列）都显示并参与宽度均分
        const anyLogicCards = (n.logic || []).some(c => c.length > 0);
        // 列元素顺序：info → logic0..logicN → operate
        const colEls = [
            buildColumnEl(n, 'info', n.info, 'info', null, allNodeEmpty),
            // LOGIC 激活（任一子列有卡片）→ 所有子列（含空列）都渲染并参与均分；
            // LOGIC 为空 → 渲染占位列（保留可拖放的空态）
            ...(((n.logic || []).length ? (n.logic || []) : [[]]).map((c, i) =>
                buildColumnEl(n, 'logic', c, 'logic', i, allNodeEmpty, anyLogicCards)
            )),
            (n.groups || []).length === 0
                ? E('div', 'col ' + (allNodeEmpty ? 'col--empty-all' : 'col--empty'), { 'data-col-type': 'operate' }, [E('h3', 'col__title', null, 'Operate'), E('div', 'col__empty', null, allNodeEmpty ? 'add operate task here' : 'drop operate here')])
                : E('div', 'col', { 'data-col-type': 'operate' }, [
                    E('h3', 'col__title', null, 'Operate'),
                    ...n.groups.map(g => {
                        const sw = E('label', 'switch' + (g.on ? ' switch--on' : ''), { 'data-tooltip': g.on ? 'canvas.switchOn' : 'canvas.switchOff' }, [
                            E('span', 'switch__track', null, E('span', 'switch__thumb')),
                        ]);
                        sw.addEventListener('click', () => { capture(); g.on = !g.on; render(); });
                        let trigCol = '';
                        if (g.in && g.in.trigger) {
                            const [sid, sn] = g.in.trigger.split('.');
                            const src = find(sid);
                            if (src && src._cols && src._cols[sn]) trigCol = src._cols[sn];
                        }
                        let gOutCol = '';
                        if (g.exit) {
                            // 配对出口的颜色（g.exit = 组持久化出口名，随组不随下标）
                            gOutCol = nOutColors[g.exit] || '';
                        }
                        return E('div', 'op-group', { 'data-group-id': g.id }, [
                            E('div', 'op-group__head', null, [
                                makePort(g.id + '.trigger', 'in', trigCol, 'square', { 'data-tooltip': 'canvas.triggerGroup' }),
                                sw,
                                editable(g.name, v => { capture(); g.name = v; render(); }, 'op-group__name'),
                                // 组出口方块口：与配对节点出口强制连线、不可交互。
                                // 刻意不用 .port class（否则会被拖拽绑定 / 作为落点），
                                // data-src 仅供 drawWires 定位画强制连线。
                                E('span', 'op-group__exit-port', {
                                    'data-src': g.id + '.out',
                                    style: gOutCol ? { backgroundColor: gOutCol } : {},
                                }),
                            ]),
                            E('div', 'op-group__body', null, g.ops.map(o => buildTask(o, 'op')))
                        ]);
                    })
                ]),
        ];
        // 交错插入分隔线：LOGIC 子列之间用虚线，其余分区边界用实线
        const bodyChildren = [];
        for (let i = 0; i < colEls.length; i++) {
            bodyChildren.push(colEls[i]);
            if (i < colEls.length - 1) {
                const isLogicGap = colEls[i].dataset.colType === 'logic' && colEls[i + 1].dataset.colType === 'logic';
                bodyChildren.push(E('div', 'col__divider' + (isLogicGap ? ' col__divider--dashed' : '')));
            }
        }
        const body = E('div', 'node__body', null, bodyChildren);
        body.style.gridTemplateColumns = buildGrid();
        bodyRef.el = body;

        const has = colHas();
        const visibleCols = has.filter(Boolean).length;
        body.style.paddingLeft = has[0] ? '' : '0px';
        body.style.paddingRight = has[has.length - 1] ? '' : '0px';
        const dividers = body.querySelectorAll('.col__divider');
        dividers.forEach((div, gapIdx) => {
            if (visibleCols <= 1) { div.classList.add('col__divider--disabled'); return; }
            if (!(has[gapIdx] && has[gapIdx + 1])) { div.classList.add('col__divider--disabled'); return; }
            div.style.cursor = 'col-resize';
            div.addEventListener('pointerdown', e => {
                if (e.button !== 0) return;
                e.stopPropagation();
                capture();   // 列宽拖拽手势起点：整段拖拽一步撤销
                divGapIdx = gapIdx;
                dStartX = e.clientX;
                dStartF = n.colF.slice();
                document.addEventListener('pointermove', onDivMove);
                document.addEventListener('pointerup', onDivUp);
            });
        });

        const isStart = state.nodes.length > 0 && n.id === state.nodes[0].id;
        // 入口接线点：每个 inPorts 一个端口（颜色取自连线源的出口颜色），支持 "+"/"−" 增删
        let railIn = null;
        if (!isStart) {
            const inPortEls = n.inPorts.map(pn => {
                const w = state.wires.find(w => w.to === n.id + '.' + pn);
                let col = '';
                if (w) {
                    const [sid, sn] = w.from.split('.');
                    const sNode = state.nodes.find(x => x.id === sid);
                    if (sNode && sNode._ncols && sNode._ncols[sn]) col = sNode._ncols[sn];
                }
                return makePort(n.id + '.' + pn, 'in', col, 'circle');
            });
            // goto 标记端口（同心圈，不可连线）追加在正常入口之后
            for (const m of (markersByNode[n.id] || [])) inPortEls.push(makeGotoMarkerPort(m));
            const btnAddIn = E('button', 'node__port-add', { 'data-tooltip': 'canvas.addIn' }, '+');
            btnAddIn.addEventListener('click', e => {
                e.stopPropagation();
                capture();
                // 最小可用后缀命名，避免删除中间入口后长度错位撞名
                n.inPorts.push(nextInPortName(n.inPorts));
                render();
            });
            inPortEls.push(btnAddIn);
            if (n.inPorts.length > 1) {
                const btnDelIn = E('button', 'node__port-add', { 'data-tooltip': 'canvas.delIn', style: { color: 'var(--on-surface-mute)' } }, '−');
                btnDelIn.addEventListener('click', e => {
                    e.stopPropagation();
                    capture();
                    // 优先删未连线的入口（自下而上），全连线才删最底部；顺带清理指向被删口的线
                    const idx = pickInputToRemove(state, n.id, n.inPorts);
                    const removed = n.inPorts[idx];
                    n.inPorts.splice(idx, 1);
                    const portSrc = n.id + '.' + removed;
                    state.wires = state.wires.filter(w => w.to !== portSrc);
                    render();
                });
                inPortEls.push(btnDelIn);
            }
            railIn = E('div', 'node__port-rail node__port-rail--in', null, inPortEls);
        }
        // 出口端口由 normalizeExits 自动派生（数量=操作组数，名字=组持久化出口，顺序=组顺序），无 +/- 按钮
        const railOut = E('div', 'node__port-rail node__port-rail--out', null,
            n.outPorts.map(pn => makePort(n.id + '.' + pn, 'out', nOutColors[pn], 'circle'))
        );

        // 节点最小高度同时考虑入口 / 出口端口数量（含 goto 标记端口），避免端口重叠
        const markerCount = (markersByNode[n.id] || []).length;
        const pCount = Math.max(n.outPorts.length, (n.inPorts || ['in']).length + markerCount);
        const minH = 60 + (pCount + 1) * 32;
        // 节点最小宽度随内容推导：最宽 task 卡片 × 可视列数（has 是 colHas() 结果）
        const nodeMinW = nodeMinWidth(n, has);
        const elStyle = { left: n.x + 'px', top: n.y + 'px', width: n.w + 'px', minWidth: nodeMinW + 'px' };
        if (pCount >= 2) elStyle['min-height'] = minH + 'px';
        const nodeWireSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        nodeWireSvg.setAttribute('class', 'node__wires');
        const el = E('section', 'node', { style: elStyle }, [
            hdr, rL, rR, body, railIn, railOut, nodeWireSvg,
        ]);
        n.el = el;
        n._wireSvg = nodeWireSvg;
        world.appendChild(el);
        alignExitPorts(el, n);   // 出口端口与对应操作组标题栏水平对齐
        if (focusedNodeId != null && n.id === focusedNodeId) { el.classList.add('node--focused'); el.style.zIndex = zCounter; }
        if (focusedCardId != null) {
            // 同步加焦点 class（不再 setTimeout(0)）：render 每次 world.innerHTML='' 全量重建节点，
            // 新元素初始不带环，若延迟一帧才加 class，焦点环会"先消失再出现"地闪一下。
            const cardEl = el.querySelector(`[data-task-id="${focusedCardId}"], [data-group-id="${focusedCardId}"]`);
            if (cardEl) {
                cardEl.classList.add(cardEl.dataset.taskId ? 'task--focused' : 'op-group--focused');
                // 操作组内的卡片成为焦点时，所在操作组同步高亮（保持组上下文可见）
                if (cardEl.dataset.taskId) {
                    const grp = cardEl.closest('.op-group');
                    if (grp) grp.classList.add('op-group--focused');
                }
            }
        }
        if (_nodeObserver) _nodeObserver.observe(el);
    });
    bindWireDrag();
    drawWires();
    syncAllCodeFields();   // 代码输入框按内容撑高 + 行号（需在 DOM 挂载后取 scrollHeight）
    scheduleAutoSave(state, getCurrentFile());
    refreshCodePreview();
}
