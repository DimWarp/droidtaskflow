/* ============================================================
   UNDO / REDO — snapshot-based history (per open project)
   Captures a deep clone of {nodes, wires, globalVars} BEFORE a
   mutation. Undo pops the pre-op snapshot and re-applies it.
   projectName 不进快照（只在历史清空边界变化），视图状态不进。
   ============================================================ */
import { state } from './state.js';
import { render } from './render.js';
import { renderGlobalVars } from './global-vars.js';

export const LIMIT = 50;
let undoStack = [];   // [{ json, data }] — data 是深克隆
let redoStack = [];
let _editing = false; // 文本编辑会话合并标志

/** 文档状态深克隆快照。{json} 用于快速无操作比较，{data} 用于恢复。 */
function snapshot() {
    const data = JSON.parse(JSON.stringify({
        nodes: state.nodes,
        wires: state.wires,
        globalVars: state.globalVars,
    }));
    return { json: JSON.stringify(data), data };
}

/**
 * 把快照应用到实时 state。引用赋值（不深克隆）。
 * 安全前提：每次入栈的都是 apply 之前独立取的深克隆；弹出的快照已离开栈，
 * render() 就地补充 el/_ncols 等缓存不污染任何栈条目。
 */
function apply(snap) {
    state.nodes = snap.data.nodes;
    state.wires = snap.data.wires;
    state.globalVars = snap.data.globalVars;
    state.dirty = true;   // 撤销/重做是变更（render() 也会置）
    render();
    renderGlobalVars();
    updateButtons();
}

const pushUndo = s => { undoStack.push(s); if (undoStack.length > LIMIT) undoStack.shift(); };
const pushRedo = s => { redoStack.push(s); if (redoStack.length > LIMIT) redoStack.shift(); };

/**
 * 在离散 mutation 前调用，入栈当前状态。编辑会话内（beginEdit 之后）被抑制。
 * capture 层去重：与栈顶快照相同（两次 capture 间无变更）则不重复入栈。
 */
export function capture() {
    if (_editing) return;
    const snap = snapshot();
    if (undoStack.length && undoStack[undoStack.length - 1].json === snap.json) return;
    pushUndo(snap);
    redoStack = [];
    updateButtons();
}

/** 开始一个合并的文本编辑会话：幂等，首次调用入栈编辑前状态。 */
export function beginEdit() {
    if (_editing) return;
    _editing = true;
    pushUndo(snapshot());
    redoStack = [];
    updateButtons();
}

/** 结束文本编辑会话。 */
export function endEdit() {
    _editing = false;
    updateButtons();
}

/** 撤销：弹出前一个与当前状态不同的快照并恢复。 */
export function undo() {
    if (_editing) endEdit();   // 关闭可能悬空的编辑会话
    if (!undoStack.length) return updateButtons();
    const cur = snapshot();
    let prev = undoStack.pop();
    // 无操作跳过（承重层）：手势起点捕获可能产生"未变更"条目，跳过它们
    while (prev && prev.json === cur.json) prev = undoStack.pop();
    if (!prev) return updateButtons();
    pushRedo(cur);
    apply(prev);
}

/** 重做：镜像 undo。 */
export function redo() {
    if (_editing) endEdit();
    if (!redoStack.length) return updateButtons();
    const cur = snapshot();
    let next = redoStack.pop();
    while (next && next.json === cur.json) next = redoStack.pop();
    if (!next) return updateButtons();
    pushUndo(cur);
    apply(next);
}

/** 清空历史（工程加载/新建/关闭/导入/删除时调用）。 */
export function clearHistory() {
    undoStack = [];
    redoStack = [];
    _editing = false;
    updateButtons();
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

export function updateButtons() {
    const u = document.getElementById('btnUndo');
    const r = document.getElementById('btnRedo');
    if (u) u.disabled = !undoStack.length;
    if (r) r.disabled = !redoStack.length;
}

/** 绑定快捷键 + 按钮。启动时调用一次。 */
export function initHistory() {
    document.addEventListener('keydown', e => {
        if (!(e.ctrlKey || e.metaKey)) return;
        const tgt = e.target;
        // 焦点在文本输入/文本域/可编辑元素/代码预览内 → 交给原生撤销，不抢
        if (tgt && tgt.closest && tgt.closest('input, textarea, [contenteditable="true"], #codePreview')) return;
        const k = e.key.toLowerCase();
        if (k === 'z') {
            e.preventDefault();
            if (e.shiftKey) redo(); else undo();
        } else if (k === 'y') {
            e.preventDefault();
            redo();
        }
    });
    const u = document.getElementById('btnUndo');
    const r = document.getElementById('btnRedo');
    if (u) u.addEventListener('click', undo);
    if (r) r.addEventListener('click', redo);
    updateButtons();
}
