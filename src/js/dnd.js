/* ============================================================
   DRAG & DROP — task / op-group reordering
   ============================================================ */
import { state, DEFS, isValidConnection, toast } from './state.js';
import { render } from './render.js';
import { wireDrag, drawWires } from './wires.js';
import { capture } from './history.js';
import { t } from './i18n.js';

export let itemDrag = null;
let dragPending = null;

export function initDragAndDrop() {
    document.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const titleEl = e.target.closest('.task__head, .op-group__head');
        if (!titleEl) return;
        if (e.target.closest('.port, .switch, [contenteditable="true"]')) return;
        if (wireDrag || itemDrag) return;

        const taskEl = titleEl.closest('.task[data-task-id]');
        const groupEl = titleEl.closest('.op-group');
        const el = taskEl || groupEl;
        if (!el) return;

        let itemId = taskEl ? taskEl.dataset.taskId : null;
        let fromNode = null, fromCol = null, fromLogicCol = null, fromGroup = null, isGroup = false;
        for (const n of state.nodes) {
            if (itemId && n.info.find(t => t.id === itemId)) { fromNode = n; fromCol = 'info'; break; }
            if (itemId) {
                for (let li = 0; li < (n.logic || []).length; li++) {
                    if (n.logic[li].find(t => t.id === itemId)) {
                        fromNode = n; fromCol = 'logic'; fromLogicCol = li; break;
                    }
                }
                if (fromCol === 'logic') break;
            }
            for (const g of (n.groups || [])) {
                if (itemId && g.ops.find(t => t.id === itemId)) { fromNode = n; fromCol = 'operate'; fromGroup = g.id; break; }
            }
            if (fromNode) break;
        }
        if (!fromNode && groupEl && groupEl.dataset.groupId) {
            const gid = groupEl.dataset.groupId;
            for (const n of state.nodes) {
                for (const g of (n.groups || [])) {
                    if (g.id === gid) {
                        itemId = g.id;
                        fromNode = n;
                        fromCol = 'operate';
                        isGroup = true;
                        break;
                    }
                }
                if (fromCol) break;
            }
        }
        if (!fromNode) return;

        dragPending = {
            el, startX: e.clientX, startY: e.clientY,
            offX: e.clientX - el.getBoundingClientRect().left,
            offY: e.clientY - el.getBoundingClientRect().top,
            itemId, fromNode, fromCol, fromLogicCol, fromGroup, isGroup,
            groupEl,
        };
    });

    document.addEventListener('pointermove', e => {
        if (dragPending && !itemDrag) {
            const dx = e.clientX - dragPending.startX;
            const dy = e.clientY - dragPending.startY;
            if (Math.hypot(dx, dy) < 5) return;
            const p = dragPending;
            dragPending = null;
            const r = p.el.getBoundingClientRect();
            const ghost = p.el.cloneNode(true);
            ghost.style.position = 'fixed';
            ghost.style.left = r.left + 'px';
            ghost.style.top = r.top + 'px';
            ghost.style.width = r.width + 'px';
            ghost.style.opacity = '0.7';
            ghost.style.pointerEvents = 'none';
            ghost.style.zIndex = '9999';
            ghost.style.transform = 'rotate(1deg)';
            ghost.style.boxShadow = '0 8px 24px rgba(0,0,0,.25)';
            document.body.appendChild(ghost);
            p.el.style.opacity = '0.3';
            p.el.style.filter = 'grayscale(0.5)';
            itemDrag = {
                el: p.el, itemId: p.itemId, fromNode: p.fromNode, fromCol: p.fromCol,
                fromLogicCol: p.fromLogicCol, fromGroup: p.fromGroup, isGroup: p.isGroup,
                ghost, offX: p.offX, offY: p.offY,
            };
            // Show trash drop target
            const trash = document.getElementById('trashDrop');
            if (trash) trash.classList.add('trash-drop--visible');
        }
        if (!itemDrag) return;
        itemDrag.ghost.style.left = (e.clientX - itemDrag.offX) + 'px';
        itemDrag.ghost.style.top = (e.clientY - itemDrag.offY) + 'px';
        // Highlight trash on hover
        const trash = document.getElementById('trashDrop');
        if (trash) {
            const tgt = document.elementFromPoint(e.clientX, e.clientY);
            trash.classList.toggle('trash-drop--over', !!(tgt && tgt.closest('#trashDrop')));
        }
        document.querySelectorAll('.col--drop-target').forEach(c => c.classList.remove('col--drop-target'));
        document.querySelectorAll('.drop-insert-marker').forEach(m => m.remove());
        if (itemDrag) itemDrag._logicColIdx = null;
        const tgt = document.elementFromPoint(e.clientX, e.clientY);
        const colEl = tgt && tgt.closest('.col');
        if (colEl && itemDrag) {
            const nodeEl = colEl.closest('.node');
            if (nodeEl) {
                // 列身份由 data-col-type / data-logic-idx 决定（LOGIC 多列后网格不再固定 3 列）
                const colType = colEl.dataset.colType;
                const catMatch = itemDrag.fromCol === 'logic'
                    ? colType === 'logic'
                    : colType === itemDrag.fromCol;
                if (catMatch) {
                    colEl.classList.add('col--drop-target');
                    itemDrag._logicColIdx = colEl.dataset.logicIdx != null ? parseInt(colEl.dataset.logicIdx, 10) : null;
                    let parentEl = colEl;
                    let candidateSel = '.task, .op-group, .col__empty';
                    if (itemDrag.fromCol === 'operate') {
                        if (itemDrag.isGroup) {
                            candidateSel = '.op-group';
                            parentEl = colEl;
                        } else {
                            candidateSel = '.task';
                            const opGroups = colEl.querySelectorAll('.op-group');
                            let targetGroup = null;
                            for (const og of opGroups) {
                                const r = og.getBoundingClientRect();
                                if (e.clientX >= r.left && e.clientX <= r.right &&
                                    e.clientY >= r.top && e.clientY <= r.bottom) {
                                    targetGroup = og;
                                    break;
                                }
                            }
                            if (!targetGroup) {
                                let minDist = Infinity;
                                for (const og of opGroups) {
                                    const r = og.getBoundingClientRect();
                                    const dist = Math.abs(e.clientY - (r.top + r.height / 2));
                                    if (dist < minDist) { minDist = dist; targetGroup = og; }
                                }
                            }
                            if (targetGroup) {
                                const opBody = targetGroup.querySelector('.op-group__body');
                                if (opBody) parentEl = opBody;
                            }
                        }
                    } else if (itemDrag.fromCol === 'logic') {
                        // LOGIC 子列内候选：仅 .task（空子列时 items 为空 → 直接 append 标记）
                        candidateSel = '.task';
                    }
                    const allItems = parentEl.querySelectorAll(candidateSel);
                    const items = Array.from(allItems).filter(it => it !== itemDrag.el);
                    let insertIdx = items.length;
                    for (let i = 0; i < items.length; i++) {
                        const r = items[i].getBoundingClientRect();
                        if (e.clientY < r.top + r.height / 2) { insertIdx = i; break; }
                    }
                    itemDrag._insertIdx = insertIdx;
                    itemDrag._parentEl = parentEl;
                    if (!colEl.classList.contains('col--empty')) {
                        if (items.length && insertIdx < items.length) {
                            const marker = document.createElement('div');
                            marker.className = 'drop-insert-marker';
                            const ref = items[insertIdx];
                            ref.parentNode.insertBefore(marker, ref);
                        } else {
                            const marker = document.createElement('div');
                            marker.className = 'drop-insert-marker';
                            parentEl.appendChild(marker);
                        }
                    }
                }
            }
        }
    });

    document.addEventListener('pointerup', e => {
        try {
        if (dragPending && !itemDrag) { dragPending = null; return; }
        if (!itemDrag) return;
        capture();   // 单一捕获点：覆盖拖入回收站删除 与 拖拽移动/重排
        itemDrag.el.style.opacity = '';
        itemDrag.el.style.filter = '';
        itemDrag.ghost.remove();
        document.querySelectorAll('.col--drop-target').forEach(c => c.classList.remove('col--drop-target'));
        document.querySelectorAll('.drop-insert-marker').forEach(m => m.remove());
        // Check drop on trash BEFORE hiding it
        const trash = document.getElementById('trashDrop');
        const tgt = document.elementFromPoint(e.clientX, e.clientY);
        const droppedOnTrash = !!(tgt && tgt.closest('#trashDrop'));
        // Delay trash fade-out so pointer hit-test works
        if (trash) {
            trash.classList.remove('trash-drop--over');
            if (!droppedOnTrash) trash.classList.remove('trash-drop--visible');
            else setTimeout(() => trash.classList.remove('trash-drop--visible'), 500);
        }
        if (droppedOnTrash) {
            const fn = itemDrag.fromNode, fc = itemDrag.fromCol;
            let deletedName = '';
            if (itemDrag.isGroup) {
                const gIdx = fn.groups.findIndex(g => g.id === itemDrag.itemId);
                if (gIdx >= 0) { deletedName = fn.groups[gIdx].name || ''; fn.groups.splice(gIdx, 1); }
            } else if (fc === 'info') {
                const idx = fn.info.findIndex(t => t.id === itemDrag.itemId);
                if (idx >= 0) { deletedName = (DEFS[fn.info[idx].def] || {}).alias || ''; fn.info.splice(idx, 1); }
            } else if (fc === 'logic') {
                const lc = itemDrag.fromLogicCol;
                if (lc != null && fn.logic && fn.logic[lc]) {
                    const idx = fn.logic[lc].findIndex(t => t.id === itemDrag.itemId);
                    if (idx >= 0) { deletedName = (DEFS[fn.logic[lc][idx].def] || {}).alias || ''; fn.logic[lc].splice(idx, 1); }
                }
            } else if (fc === 'operate') {
                for (const g of (fn.groups || [])) {
                    const oIdx = g.ops.findIndex(o => o.id === itemDrag.itemId);
                    if (oIdx >= 0) { deletedName = (DEFS[g.ops[oIdx].def] || {}).alias || ''; g.ops.splice(oIdx, 1); break; }
                }
            }
            // Clean up wires
            if (deletedName) {
                state.wires = state.wires.filter(w => {
                    const [fid] = w.from.split('.');
                    const [tid] = w.to.split('.');
                    return fid !== itemDrag.itemId && tid !== itemDrag.itemId;
                });
                state.dirty = true;
                render();
                toast(t('toast.deleted', { name: deletedName }));
            }
            itemDrag = null;
            return;
        }
        const colEl = tgt && tgt.closest('.col');
        document.querySelectorAll('.col--empty').forEach(c => { c.style.minWidth = ''; c.style.width = ''; });
        if (colEl) {
            const nodeEl = colEl.closest('.node');
            if (nodeEl) {
                const toNode = state.nodes.find(n => n.el === nodeEl);
                if (toNode) {
                    // 列身份由 data-col-type / data-logic-idx 决定（LOGIC 多列后网格不再固定 3 列）
                    const colType = colEl.dataset.colType;
                    const toCol = colType; // 'info' | 'logic' | 'operate'
                    const catMatch = itemDrag.fromCol === 'logic'
                        ? colType === 'logic'
                        : colType === itemDrag.fromCol;
                    const toLogicCol = colEl.dataset.logicIdx != null
                        ? parseInt(colEl.dataset.logicIdx, 10)
                        : (itemDrag._logicColIdx != null ? itemDrag._logicColIdx : null);
                    if (catMatch) {
                        {
                            let item = null, origIdx = -1, origLogicCol = -1;
                            const fn = itemDrag.fromNode, fc = itemDrag.fromCol;
                            if (fc === 'info') {
                                origIdx = fn.info.findIndex(t => t.id === itemDrag.itemId);
                                if (origIdx >= 0) item = fn.info.splice(origIdx, 1)[0];
                            } else if (fc === 'logic') {
                                const lc = itemDrag.fromLogicCol;
                                if (lc != null && fn.logic && fn.logic[lc]) {
                                    origIdx = fn.logic[lc].findIndex(t => t.id === itemDrag.itemId);
                                    if (origIdx >= 0) { item = fn.logic[lc].splice(origIdx, 1)[0]; origLogicCol = lc; }
                                }
                            } else if (fc === 'operate') {
                                for (const g of (fn.groups || [])) {
                                    origIdx = g.ops.findIndex(o => o.id === itemDrag.itemId);
                                    if (origIdx >= 0) { item = g.ops.splice(origIdx, 1)[0]; break; }
                                    if (g.id === itemDrag.itemId) {
                                        origIdx = fn.groups.findIndex(gr => gr.id === itemDrag.itemId);
                                        if (origIdx >= 0) item = fn.groups.splice(origIdx, 1)[0];
                                        break;
                                    }
                                }
                            }
                            if (item) {
                                let insIdx = itemDrag._insertIdx || 0;
                                let samePos = false;
                                const srcGroup = (fn.groups || []).find(g => g.ops.some(o => o.id === itemDrag.itemId));
                                if (itemDrag.fromNode === toNode && fc === toCol) {
                                    if (fc === 'logic') {
                                        samePos = origLogicCol === toLogicCol && insIdx === origIdx;
                                    } else if (fc === 'operate' && !item.ops) {
                                        const tgtGroup = itemDrag._parentEl ? itemDrag._parentEl.closest('.op-group') : null;
                                        const tgtGroupId = tgtGroup ? tgtGroup.dataset.groupId : null;
                                        samePos = srcGroup && tgtGroupId && srcGroup.id === tgtGroupId && insIdx === origIdx;
                                    } else {
                                        samePos = insIdx === origIdx;
                                    }
                                }
                                if (samePos) {
                                    if (fc === 'info') toNode.info.splice(origIdx, 0, item);
                                    else if (fc === 'logic') toNode.logic[origLogicCol].splice(origIdx, 0, item);
                                    else if (fc === 'operate' && item.ops) toNode.groups.splice(origIdx, 0, item);
                                    else if (fc === 'operate') {
                                        (srcGroup || (toNode.groups || []).find(g => g.on !== false))?.ops.splice(origIdx, 0, item);
                                    }
                                    item = null;
                                }
                                if (item) {
                                    if (toCol === 'info') {
                                        toNode.info.splice(insIdx, 0, item);
                                    } else if (toCol === 'logic') {
                                        if (!toNode.logic) toNode.logic = [];
                                        let tCol = toLogicCol;
                                        if (tCol == null || tCol < 0) tCol = 0;
                                        while (toNode.logic.length <= tCol) toNode.logic.push([]);
                                        toNode.logic[tCol].splice(insIdx, 0, item);
                                    } else if (toCol === 'operate' && item.ops) {
                                        if (!toNode.groups) toNode.groups = [];
                                        toNode.groups.splice(insIdx, 0, item);
                                    } else if (toCol === 'operate') {
                                        let targetGroup = null;
                                        if (itemDrag._parentEl && itemDrag._parentEl.classList.contains('op-group__body')) {
                                            const groupEl = itemDrag._parentEl.closest('.op-group');
                                            if (groupEl) {
                                                const gid = groupEl.dataset.groupId;
                                                targetGroup = (toNode.groups || []).find(g => g.id === gid);
                                            }
                                        }
                                        if (!targetGroup) {
                                            targetGroup = (toNode.groups || []).find(g => g.on !== false);
                                        }
                                        if (!targetGroup) {
                                            targetGroup = { id: 'g' + Date.now(), name: 'Group', on: false, ops: [] };
                                            if (!toNode.groups) toNode.groups = [];
                                            toNode.groups.push(targetGroup);
                                        }
                                        targetGroup.ops.splice(insIdx, 0, item);
                                    }
                                }
                                if (item && itemDrag.fromNode !== toNode) {
                                    state.wires = state.wires.filter(w => {
                                        const [fid] = w.from.split('.'), [tid] = w.to.split('.');
                                        if (fid === itemDrag.itemId || tid === itemDrag.itemId) return false;
                                        return true;
                                    });
                                    if (item.in) item.in = {};
                                }
                                if (item) {
                                    state.wires = state.wires.filter(w => {
                                        const [fid] = w.from.split('.'), [tid] = w.to.split('.');
                                        if (fid === itemDrag.itemId || tid === itemDrag.itemId) {
                                            return isValidConnection(fid, tid);
                                        }
                                        return true;
                                    });
                                }
                                if (item) render();
                            }
                        }
                    }
                }
            }
        }
        itemDrag = null;
        } catch (err) {
            // 兜底：drop 处理出错时仍清理拖拽状态，避免拖拽卡死（后续无法再次拖动）
            console.error('dnd pointerup error:', err);
            if (itemDrag) {
                if (itemDrag.ghost) itemDrag.ghost.remove();
                if (itemDrag.el) { itemDrag.el.style.opacity = ''; itemDrag.el.style.filter = ''; }
            }
            document.querySelectorAll('.col--drop-target').forEach(c => c.classList.remove('col--drop-target'));
            document.querySelectorAll('.drop-insert-marker').forEach(m => m.remove());
            const trash = document.getElementById('trashDrop');
            if (trash) trash.classList.remove('trash-drop--over', 'trash-drop--visible');
            itemDrag = null;
            dragPending = null;
        }
    });
}
