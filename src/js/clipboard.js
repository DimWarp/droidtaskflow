/* ============================================================
   CLIPBOARD + FOCUS SYSTEM
   ============================================================ */
import { state, DEFS, toast } from './state.js';
import { render } from './render.js';
import { focusedNodeId, focusedCardId, zCounter, setFocusedNodeId, setFocusedCardId, incZCounter } from './shared.js';
import { capture } from './history.js';
import { t } from './i18n.js';

export let clipboard = null;

export function initClipboard() {
    // Node/card focus: two-level focus system
    document.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const nodeEl = e.target.closest('.node');
        const cardEl = e.target ? (e.target.closest('.task, .op-group')) : null;

        if (nodeEl) {
            const n = state.nodes.find(n => n.el === nodeEl);
            if (n) {
                setFocusedNodeId(n.id);
                n.el.style.zIndex = incZCounter();
                if (cardEl && cardEl.closest('.node') === nodeEl) {
                    const taskId = cardEl.dataset?.taskId;
                    const groupId = cardEl.dataset?.groupId;
                    setFocusedCardId(taskId || groupId || null);
                } else {
                    setFocusedCardId(null);
                }
            }
        } else {
            const canvas = e.target.closest('.canvas');
            // Same fix as panning: use class '.canvas-toolbar' so row 2 widget clicks
            // don't get treated as "click on empty canvas".
            if (canvas && !e.target.closest('.node') && !e.target.closest('#taskPalette') && !e.target.closest('.canvas-toolbar') && !e.target.closest('#trashDrop')) {
                setFocusedNodeId(null);
                setFocusedCardId(null);
            }
        }
        state.nodes.forEach(n => {
            if (n.el) n.el.classList.toggle('node--focused', n.id === focusedNodeId);
        });
        document.querySelectorAll('.task--focused, .op-group--focused').forEach(el => {
            el.classList.remove('task--focused', 'op-group--focused');
        });
        if (focusedCardId) {
            const cardEl = document.querySelector(`[data-task-id="${focusedCardId}"], [data-group-id="${focusedCardId}"]`);
            if (cardEl) {
                cardEl.classList.add(cardEl.dataset.taskId ? 'task--focused' : 'op-group--focused');
                // 操作组内的卡片成为焦点时，所在操作组同步高亮
                if (cardEl.dataset.taskId) {
                    const grp = cardEl.closest('.op-group');
                    if (grp) grp.classList.add('op-group--focused');
                }
            }
        }
        // Sync "添加操作组" button enabled state
        const btnAddGroup = document.getElementById('btnAddGroup');
        if (btnAddGroup) btnAddGroup.disabled = !focusedNodeId;
    }, true);

    // Ctrl+C / Ctrl+V
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            if (e.target.closest('input, textarea, [contenteditable="true"], #codePreview')) return;
            // Allow native copy when user has selected text (e.g. toast message)
            const sel = window.getSelection();
            if (sel && sel.toString().length > 0) return;
            e.preventDefault();
            clipboard = null;
            if (focusedCardId && focusedNodeId) {
                const n = state.nodes.find(n => n.id === focusedNodeId);
                if (n) {
                    let found = n.info.find(t => t.id === focusedCardId);
                    if (!found) {
                        for (const col of (n.logic || [])) {
                            found = col.find(x => x.id === focusedCardId);
                            if (found) break;
                        }
                    }
                    if (found) { clipboard = { item: JSON.parse(JSON.stringify(found)), type: 'task' }; }
                    for (const g of (n.groups || [])) {
                        const o = g.ops.find(o => o.id === focusedCardId);
                        if (o) { clipboard = { item: JSON.parse(JSON.stringify(o)), type: 'task' }; break; }
                        if (g.id === focusedCardId) { clipboard = { item: JSON.parse(JSON.stringify(g)), type: 'group' }; break; }
                    }
                }
                if (clipboard) toast(t('toast.copiedTask'));
            } else if (focusedNodeId) {
                const n = state.nodes.find(n => n.id === focusedNodeId);
                if (n) { clipboard = { item: JSON.parse(JSON.stringify(n)), type: 'node' }; toast(t('toast.copiedNode')); }
            }
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
            if (e.target.closest('input, textarea, [contenteditable="true"], #codePreview')) return;
            e.preventDefault();
            if (!clipboard || !focusedNodeId) return;
            capture();   // 覆盖粘贴 node / group / task 三支路
            const toNode = state.nodes.find(n => n.id === focusedNodeId);
            if (clipboard.type === 'node') {
                const clone = JSON.parse(JSON.stringify(clipboard.item));
                clone.id = 'n' + Date.now();
                clone.x += 40; clone.y += 40;
                if (clone.groups) clone.groups.forEach(g => { g.id = 'g' + Date.now(); if (g.ops) g.ops.forEach((o, i) => { o.id = 'o' + Date.now() + '_' + i; o.in = {}; }); });
                clone.info.forEach((t, i) => { t.id = 't' + Date.now() + '_' + i; t.in = {}; });
                // LOGIC 多列：逐列重映射 ID（兼容旧扁平结构 → 单列）
                if (clone.logic && clone.logic.length && !Array.isArray(clone.logic[0])) {
                    clone.logic = [clone.logic];
                }
                clone.logic = (clone.logic || []).map((col, ci) => col.map((t, i) => {
                    t.id = 't' + Date.now() + '_' + ci + '_' + i;
                    t.in = {};
                    return t;
                }));
                clone.inPorts = ['in'];
                clone.outPorts = ['out'];
                state.nodes.push(clone);
                render();
                toast(t('toast.pastedNode'));
                return;
            }
            if (!toNode) return;
            const item = JSON.parse(JSON.stringify(clipboard.item));
            const newId = 't' + Date.now();
            item.id = newId;
            if (item.in) item.in = {};
            if (clipboard.type === 'group') {
                if (!toNode.groups) toNode.groups = [];
                item.id = 'g' + Date.now();
                if (item.ops) item.ops.forEach((o, i) => { o.id = 'o' + Date.now() + '_' + i; o.in = {}; });
                toNode.groups.push(item);
            } else {
                const def = DEFS[item.def];
                if (!def) return;
                const isOperate = !def.rets.length;
                if (isOperate) {
                    let tg = (toNode.groups || []).find(g => g.on !== false);
                    if (!tg) { tg = { id: 'g' + Date.now(), name: 'Group', on: false, ops: [] }; if (!toNode.groups) toNode.groups = []; toNode.groups.push(tg); }
                    tg.ops.push(item);
                } else if (def.params.some(p => p.t === 'line') && def.rets.length) {
                    // LOGIC 多列：粘贴到最后一列末尾（无列时创建首列）
                    if (!toNode.logic) toNode.logic = [];
                    if (!toNode.logic.length) toNode.logic.push([]);
                    toNode.logic[toNode.logic.length - 1].push(item);
                } else {
                    toNode.info.push(item);
                }
            }
            render();
            toast(t('toast.pasted'));
        }
    });

    // Delete key — remove focused card or node
    document.addEventListener('keydown', e => {
        if (e.key !== 'Delete') return;
        if (e.target.closest('input, textarea, [contenteditable="true"], #codePreview')) return;
        e.preventDefault();
        capture();   // 覆盖删卡片 + 删节点（start-node 拦截等无实际删除变空条目，undo 时跳过）

        // Priority: focused card > focused node
        if (focusedCardId && focusedNodeId) {
            const n = state.nodes.find(n => n.id === focusedNodeId);
            if (n) {
                let deleted = false;
                // Check info tasks
                const iIdx = n.info.findIndex(t => t.id === focusedCardId);
                if (iIdx >= 0) {
                    n.info.splice(iIdx, 1);
                    deleted = true;
                }
                // Check logic tasks（LOGIC 多列：遍历所有子列）
                if (!deleted) {
                    for (let li = 0; li < (n.logic || []).length && !deleted; li++) {
                        const lIdx = n.logic[li].findIndex(t => t.id === focusedCardId);
                        if (lIdx >= 0) {
                            n.logic[li].splice(lIdx, 1);
                            deleted = true;
                        }
                    }
                }
                // Check op-groups and their ops
                if (!deleted) {
                    for (let gi = 0; gi < (n.groups || []).length; gi++) {
                        const g = n.groups[gi];
                        if (g.id === focusedCardId) {
                            // Delete entire op-group
                            n.groups.splice(gi, 1);
                            deleted = true;
                            break;
                        }
                        const oIdx = g.ops.findIndex(o => o.id === focusedCardId);
                        if (oIdx >= 0) {
                            g.ops.splice(oIdx, 1);
                            deleted = true;
                            break;
                        }
                    }
                }
                if (deleted) {
                    // Clean up wires connected to the deleted card
                    state.wires = state.wires.filter(w => {
                        const [fid] = w.from.split('.');
                        const [tid] = w.to.split('.');
                        return fid !== focusedCardId && tid !== focusedCardId;
                    });
                    setFocusedCardId(null);
                    state.dirty = true;
                    render();
                    toast(t('toast.deletedTask'));
                }
            }
        } else if (focusedNodeId) {
            // Start node (first node) cannot be deleted
            if (state.nodes.length > 0 && focusedNodeId === state.nodes[0].id) {
                toast(t('toast.cannotDeleteStart'));
                return;
            }
            const idx = state.nodes.findIndex(n => n.id === focusedNodeId);
            if (idx >= 0) {
                const node = state.nodes[idx];
                // 普通节点被删 → 清空指向它的 goto 目标（目标标记自动消失）
                if (node.type !== 'goto') {
                    for (const g of state.nodes) {
                        if (g.type === 'goto' && g.target === node.id) g.target = null;
                    }
                }
                // Collect all card IDs in this node to clean up wires
                const cardIds = new Set();
                if (node.type === 'goto') cardIds.add(node.id);   // goto 自身的入口线一并清理
                for (const t of [...(node.info || []), ...(node.logic || []).flat()]) cardIds.add(t.id);
                for (const g of (node.groups || [])) {
                    cardIds.add(g.id);
                    for (const o of g.ops) cardIds.add(o.id);
                }
                state.nodes.splice(idx, 1);
                state.wires = state.wires.filter(w => {
                    const [fid] = w.from.split('.');
                    const [tid] = w.to.split('.');
                    return !cardIds.has(fid) && !cardIds.has(tid);
                });
                setFocusedNodeId(null);
                setFocusedCardId(null);
                state.dirty = true;
                render();
                toast(t('toast.deletedNode'));
            }
        }
        // Sync "添加操作组" button
        const btnAddGroup = document.getElementById('btnAddGroup');
        if (btnAddGroup) btnAddGroup.disabled = !focusedNodeId;
    });
}
