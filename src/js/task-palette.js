/* ============================================================
   TASK PALETTE — preset task card panel
   Renders available task cards in a slide-out panel.
   Supports drag-to-canvas and click-to-add interactions.
   ============================================================ */
import { state, DEFS, _customTaskSources, toast } from './state.js';
import { loadCustomTasks, loadPresetTasks } from './filesystem.js';
import { buildTask } from './render.js';
import { focusedNodeId, focusedCardId, setFocusedCardId } from './shared.js';
import { itemDrag } from './dnd.js';
import { render } from './render.js';
import { capture } from './history.js';
import { t } from './i18n.js';

/** Merged card list: [{key, alias, category, params, rets, source}] */
export let paletteCards = [];

/** Whether the palette panel is currently expanded */
let _expanded = false;

/** Collapse the task palette panel (called on project close, etc.). */
export function collapseTaskPalette() {
    if (!_expanded) return;
    _expanded = false;
    const panel = document.getElementById('taskPalette');
    if (panel) panel.classList.add('task-palette--collapsed');
}

/** Active palette drag state */
let _palDrag = null;
let _palPending = null;

/* ----------------------------------------------------------
   CARD MERGING
   ---------------------------------------------------------- */

/**
 * Merge preset + custom cards into paletteCards.
 * Preset cards go first, custom cards override (same key wins).
 * Each card's function source is stored in _customTaskSources for export.
 * Card defs are permanently registered in DEFS so toPythonDSL can find them.
 */
function mergeCards(presetCards, customCards) {
    const merged = {};
    // Preset cards first
    for (const card of presetCards) {
        merged[card.key] = { key: card.key, ...card };
        if (card.source) _customTaskSources[card.key] = card.source;
        DEFS[card.key] = {
            name: card.key,
            alias: card.alias,
            category: card.category,
            params: card.params,
            rets: card.rets,
        };
    }
    // Custom cards override (same key wins)
    for (const card of customCards) {
        merged[card.key] = { key: card.key, ...card };
        if (card.source) _customTaskSources[card.key] = card.source;
        DEFS[card.key] = {
            name: card.key,
            alias: card.alias,
            category: card.category,
            params: card.params,
            rets: card.rets,
        };
    }
    paletteCards = Object.values(merged);
}

/* ----------------------------------------------------------
   RENDERING
   ---------------------------------------------------------- */

/**
 * Build the palette panel body from paletteCards.
 * Custom card defs are permanently registered in DEFS by mergeCards().
 * All child elements inside palette cards are made non-interactive.
 */
function renderPaletteCards() {
    const body = document.getElementById('taskPaletteBody');
    if (!body) return;
    body.innerHTML = '';

    const categories = ['info', 'logic', 'operate'];
    for (const cat of categories) {
        const cards = paletteCards.filter(c => c.category === cat);
        const section = document.createElement('div');
        section.className = 'task-palette__section';

        const title = document.createElement('div');
        title.className = 'task-palette__section-title';
        title.textContent = cat.toUpperCase();
        title.addEventListener('click', () => {
            section.classList.toggle('task-palette__section--collapsed');
            // Re-sync position after collapse/expand
            if (window.__syncPaletteBottomGap) window.__syncPaletteBottomGap();
        });
        section.appendChild(title);

        if (!cards.length) {
            const empty = document.createElement('div');
            empty.className = 'task-palette__empty';
            empty.textContent = t('palette.empty'); // 暂无卡片
            section.appendChild(empty);
        }

        for (const card of cards) {
            const t = {
                id: '_pal_' + card.key,
                def: card.key,
                f: {},
                in: {},
                _cols: null,
            };
            // Initialize field values from param init_value
            for (const p of (card.params || [])) {
                t.f[p.n] = p.init != null ? p.init : '';
            }
            const el = buildTask(t);
            el.classList.add('task-palette__card');
            // 注意: 不要设 inline pointer-events: auto —— 会覆盖 .task-palette--collapsed
            // 下 body 的 pointer-events: none, 导致折叠状态下面板区域仍可 hover
            // (cursor: grab 还会变), 用户感知是"面板隐藏了但还有交互".
            // 默认 auto 已满足展开时拖拽, 折叠时自然继承父级 none.
            el.dataset.paletteCard = card.key;
            el.dataset.paletteCategory = card.category;

            // Disable all interactive children
            // .field__image 是 div（image 类型参数的可点击控件，点开会弹选图弹窗），
            // 不在 input/button 等标准控件之列，需单独禁掉——卡片还没放进节点前不该可交互。
            el.querySelectorAll(
                'input, textarea, select, .port, button, [contenteditable], .field__image'
            ).forEach(child => {
                child.style.pointerEvents = 'none';
                child.setAttribute('tabindex', '-1');
                if (
                    child instanceof HTMLInputElement ||
                    child instanceof HTMLTextAreaElement ||
                    child instanceof HTMLSelectElement ||
                    child instanceof HTMLButtonElement
                ) {
                    child.disabled = true;
                }
            });

            section.appendChild(el);
        }
        body.appendChild(section);
    }
}

/* ----------------------------------------------------------
   TASK CREATION
   ---------------------------------------------------------- */

/**
 * Create a new task instance from a palette card and insert it
 * into the target node's matching column.
 *
 * @param {Object} card  - palette card definition
 * @param {Object} toNode - target node object from state.nodes
 * @param {string} toCol  - 'info' | 'logic' | 'operate'
 * @param {number} [targetColIdx] - LOGIC 子列下标；缺省 = 最后一列末尾
 */
function addCardToNode(card, toNode, toCol, targetGroupEl, insertIdx, targetColIdx) {
    capture();   // 覆盖点选与托盘拖拽两种加卡片路径
    const newId = 't' + Date.now();
    const task = {
        id: newId,
        def: card.key,
        f: {},
        in: {},
    };

    // Initialise default field values from params
    const d = DEFS[card.key] || card;
    if (d.params) {
        for (const p of d.params) {
            task.f[p.n] = p.init != null ? p.init : '';
        }
    }

    if (toCol === 'info') {
        if (!toNode.info) toNode.info = [];
        toNode.info.push(task);
    } else if (toCol === 'logic') {
        // LOGIC 多列：默认添加到最后一列末尾（palette 拖拽时定位到具体子列）
        if (!toNode.logic) toNode.logic = [];
        if (!toNode.logic.length) toNode.logic.push([]);
        let colIdx = targetColIdx != null ? targetColIdx : toNode.logic.length - 1;
        if (colIdx < 0 || colIdx >= toNode.logic.length) colIdx = toNode.logic.length - 1;
        const col = toNode.logic[colIdx];
        if (insertIdx != null && insertIdx < col.length) {
            col.splice(insertIdx, 0, task);
        } else {
            col.push(task);
        }
    } else if (toCol === 'operate') {
        let targetGroup = null;
        // 1. If dropped on a specific op-group DOM element, use it
        if (targetGroupEl) {
            const gid = targetGroupEl.dataset.groupId;
            targetGroup = (toNode.groups || []).find(g => g.id === gid);
        }
        // 2. If a group card is currently focused, add to that group.
        //    焦点落在组内任务卡片上时（组是它的父焦点，同在卡片焦点树中），也加入该组
        //    （不新建），且新卡片插到该焦点卡片的下方；拖拽指定的 insertIdx 优先。
        if (!targetGroup && focusedCardId) {
            targetGroup = (toNode.groups || []).find(g => g.id === focusedCardId);
            if (!targetGroup) {
                const gi = (toNode.groups || []).findIndex(g => g.ops.some(o => o.id === focusedCardId));
                if (gi >= 0) {
                    targetGroup = toNode.groups[gi];
                    if (insertIdx == null) {
                        const oi = targetGroup.ops.findIndex(o => o.id === focusedCardId);
                        if (oi >= 0) insertIdx = oi + 1;
                    }
                }
            }
        }
        // 3. Fallback: find an active group or create one
        if (!targetGroup) {
            targetGroup = (toNode.groups || []).find(g => g.on !== false);
        }
        if (!targetGroup) {
            targetGroup = { id: 'g' + Date.now(), name: 'Group', on: false, ops: [] };
            if (!toNode.groups) toNode.groups = [];
            toNode.groups.push(targetGroup);
            // 新建操作组后自动设为焦点：与"添加操作组"按钮一致，方便继续往该组加操作
            setFocusedCardId(targetGroup.id);
        }
        if (insertIdx != null && insertIdx < targetGroup.ops.length) {
            targetGroup.ops.splice(insertIdx, 0, task);
        } else {
            targetGroup.ops.push(task);
        }
    }

    render();
    toast(t('toast.added', { name: card.alias })); // 已添加
}

/* ----------------------------------------------------------
   INITIALIZATION  (exported)
   ---------------------------------------------------------- */

/**
 * Initialise the task palette panel: wires up header-click for
 * vertical fold/unfold, and registers pointer events for
 * drag-to-canvas and click-to-add interactions.
 *
 * Call once on startup.
 */
export function initTaskPalette() {
    /* ---- Use existing DOM from index.html ---- */
    const panel = document.getElementById('taskPalette');
    const header = panel.querySelector('.task-palette__header');

    /* ---- Header click: vertical fold / unfold ---- */
    header.addEventListener('click', () => {
        _expanded = !_expanded;
        if (_expanded && !paletteCards.length) initPaletteCards();
        panel.classList.toggle('task-palette--collapsed', !_expanded);
    });

    /* ---- Console height sync: --palette-bottom-gap on body ---- */
    const LS_H = 'dtf:console_height';
    const LS_C = 'dtf:console_collapsed';
    function syncPaletteBottomGap(overrideH) {
        const body = document.getElementById('taskPaletteBody');
        if (!body) return;
        let consoleH;
        if (overrideH != null) {
            consoleH = overrideH;
        } else {
            const cp = document.getElementById('consolePane');
            const collapsed = cp ? cp.classList.contains('console-pane--collapsed') : localStorage.getItem(LS_C) === '1';
            consoleH = collapsed ? 0 : (cp ? cp.offsetHeight : parseInt(localStorage.getItem(LS_H) || '220', 10));
        }
        body.style.setProperty('--palette-bottom-gap', (133 + consoleH) + 'px');
    }
    syncPaletteBottomGap();
    // 暴露给 console-panel 拖拽 resize 和 toggle 时同步
    window.__syncPaletteBottomGap = syncPaletteBottomGap;

    /* ---- Card drag / click ---- */
    document.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const cardEl = e.target.closest('.task-palette__card');
        if (!cardEl) return;
        if (itemDrag || _palDrag || _palPending) return;
        if (!_expanded) return; // 面板折叠时不可拖动卡片

        const cardKey = cardEl.dataset.paletteCard;
        const category = cardEl.dataset.paletteCategory;
        const card = paletteCards.find(c => c.key === cardKey);
        if (!card) return;

        const rect = cardEl.getBoundingClientRect();
        _palPending = {
            card, category, cardEl,
            startX: e.clientX, startY: e.clientY,
            offX: e.clientX - rect.left,
            offY: e.clientY - rect.top,
        };
    });

    document.addEventListener('pointermove', e => {
        // Convert pending to drag after threshold
        if (_palPending && !_palDrag) {
            const dx = e.clientX - _palPending.startX;
            const dy = e.clientY - _palPending.startY;
            if (Math.hypot(dx, dy) < 5) return;
            const p = _palPending;
            _palPending = null;

            const r = p.cardEl.getBoundingClientRect();
            const ghost = p.cardEl.cloneNode(true);
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

            p.cardEl.style.opacity = '0.3';
            p.cardEl.style.filter = 'grayscale(0.5)';

            _palDrag = {
                card: p.card, category: p.category, ghost,
                offX: p.offX, offY: p.offY,
                cardEl: p.cardEl,
            };
        }

        if (!_palDrag) return;
        _palDrag.ghost.style.left = (e.clientX - _palDrag.offX) + 'px';
        _palDrag.ghost.style.top = (e.clientY - _palDrag.offY) + 'px';

        // Highlight matching drop zone
        document.querySelectorAll('.col--drop-target').forEach(
            c => c.classList.remove('col--drop-target')
        );
        document.querySelectorAll('.drop-insert-marker').forEach(m => m.remove());
        _palDrag._targetGroupEl = null;
        _palDrag._logicColIdx = null;
        _palDrag._insertIdx = undefined;
        const tgt = document.elementFromPoint(e.clientX, e.clientY);
        const colEl = tgt && tgt.closest('.col');
        if (colEl && _palDrag) {
            const nodeEl = colEl.closest('.node');
            if (nodeEl) {
                // 列身份由 data-col-type / data-logic-idx 决定（LOGIC 多列后网格不再固定 3 列）
                const colType = colEl.dataset.colType;
                const logicIdx = colEl.dataset.logicIdx != null ? parseInt(colEl.dataset.logicIdx, 10) : null;
                const catMatch = _palDrag.category === 'logic'
                    ? colType === 'logic'
                    : colType === _palDrag.category;
                if (catMatch) {
                    colEl.classList.add('col--drop-target');
                    if (_palDrag.category === 'logic') _palDrag._logicColIdx = logicIdx;
                    let parentEl = colEl;
                    // For operate cards, find target op-group and show insertion marker
                    if (_palDrag.category === 'operate') {
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
                            _palDrag._targetGroupEl = targetGroup;
                            const opBody = targetGroup.querySelector('.op-group__body');
                            if (opBody) parentEl = opBody;
                        }
                    }
                    // Insertion marker（LOGIC 子列内候选是 .task/.col__empty）
                    const candidateSel = _palDrag.category === 'operate' ? '.task'
                        : _palDrag.category === 'logic' ? '.task'
                        : '.task, .op-group, .col__empty';
                    const allItems = parentEl.querySelectorAll(candidateSel);
                    const items = Array.from(allItems);
                    let insertIdx = items.length;
                    for (let i = 0; i < items.length; i++) {
                        const r = items[i].getBoundingClientRect();
                        if (e.clientY < r.top + r.height / 2) { insertIdx = i; break; }
                    }
                    _palDrag._insertIdx = insertIdx;
                    if (items.length && insertIdx < items.length) {
                        const marker = document.createElement('div');
                        marker.className = 'drop-insert-marker';
                        const ref = items[insertIdx];
                        ref.parentNode.insertBefore(marker, ref);
                    } else if (parentEl !== colEl || items.length === 0) {
                        const marker = document.createElement('div');
                        marker.className = 'drop-insert-marker';
                        parentEl.appendChild(marker);
                    }
                }
            }
        }
    });

    document.addEventListener('pointerup', e => {
        // Click (pending, never moved enough)
        if (_palPending && !_palDrag) {
            const c = _palPending.card;
            const cat = _palPending.category;
            _palPending = null;
            if (focusedNodeId) {
                const toNode = state.nodes.find(n => n.id === focusedNodeId);
                if (toNode) {
                    addCardToNode(c, toNode, cat);
                }
            } else {
                toast(t('toast.selectNodeFirst'));
            }
            return;
        }

        if (!_palDrag) return;
        _palDrag.ghost.remove();
        _palDrag.cardEl.style.opacity = '';
        _palDrag.cardEl.style.filter = '';
        document.querySelectorAll('.col--drop-target').forEach(
            c => c.classList.remove('col--drop-target')
        );
        document.querySelectorAll('.drop-insert-marker').forEach(m => m.remove());

        // Drop
        const targetGroupEl = _palDrag._targetGroupEl || null;
        const insertIdx = _palDrag._insertIdx;
        const logicColIdx = _palDrag._logicColIdx;
        const tgt = document.elementFromPoint(e.clientX, e.clientY);
        const colEl = tgt && tgt.closest('.col');
        if (colEl) {
            const nodeEl = colEl.closest('.node');
            if (nodeEl) {
                const toNode = state.nodes.find(n => n.el === nodeEl);
                if (toNode) {
                    const colType = colEl.dataset.colType;
                    const catMatch = _palDrag.category === 'logic'
                        ? colType === 'logic'
                        : colType === _palDrag.category;
                    if (catMatch) {
                        addCardToNode(_palDrag.card, toNode, _palDrag.category, targetGroupEl, insertIdx,
                            _palDrag.category === 'logic' ? logicColIdx : undefined);
                    }
                }
            }
        }
        _palDrag = null;
    });
}

/**
 * Load preset tasks (from server) and custom tasks (from user workspace),
 * merge them into paletteCards, and render.  Safe to call multiple times.
 * Loading order: preset first, custom overrides (same key wins).
 */
export async function initPaletteCards() {
    const [presetResult, customResult] = await Promise.all([
        loadPresetTasks(),
        loadCustomTasks(),
    ]);
    if (presetResult.error) toast(presetResult.error);
    if (customResult.error) toast(customResult.error);
    mergeCards(presetResult.cards, customResult.cards);
    renderPaletteCards();
}
