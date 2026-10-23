/* ============================================================
   CANVAS INTERACTIONS — zoom, pan, wire hover, toolbar, startup
   ============================================================ */
import { state, toast } from './state.js';
import { render, realignAllExitPorts } from './render.js';
import { drawWires, drawPreview, redrawPreview, wireDrag, updateHoverFromPointer, hoveredWire, setHoveredWire, wireGeom } from './wires.js';
import { shouldStartPan, panButtonEdge } from './pan-decision.js';
import { toPythonDSL, fromPythonDSL, generateDroidtaskflowPy } from './datamapper.js';
import JSZip from 'jszip';
import { restoreDirHandle, openDirectory, saveToFile, pyodideParse, getDirHandle, setDirHandle, createNewProject, loadProjectFile, loadToolFiles } from './filesystem.js';
import { initClipboard } from './clipboard.js';
import { capture, clearHistory } from './history.js';
import { focusedNodeId, setFocusedNodeId, setFocusedCardId } from './shared.js';
import { initDragAndDrop } from './dnd.js';
import { initCodePreview, collapseCodePreview } from './code-preview.js';
import { initTaskPalette, initPaletteCards, collapseTaskPalette } from './task-palette.js';
import { initDevicePreview, collapseDevicePreview } from './device-preview.js';
import { initGlobalVars, syncToolbar, renderGlobalVars } from './global-vars.js';
import { initSidebar, refreshProjectList, setCurrentFile, getCurrentFile, confirmSaveBeforeClose, syncNewProjectBtn } from './sidebar.js';
import { collapseConsole, getConsolePanel } from './console-panel.js';
import { syncRunBtn } from './backend-panel.js';
import { t, toggleLang } from './i18n.js';
import { setNodeObserver } from './shared.js';

/* ============================================================
   RESIZE OBSERVER (created here, shared for render.js use)
   ============================================================ */
const observer = new ResizeObserver(() => { drawWires(); });
setNodeObserver(observer);

export function initInteractions() {

    /* ---------- Zoom helpers ---------- */
    const worldEl = document.getElementById('world');
    const canvasEl = document.querySelector('.canvas');
    const GRID_BASE = 22; // base dot spacing in px at 100% zoom
    function updateGrid() {
        const z = state.zoom;
        canvasEl.style.backgroundSize = `${GRID_BASE * z}px ${GRID_BASE * z}px`;
        canvasEl.style.backgroundPosition = `${state.panX * z}px ${state.panY * z}px`;
    }
    function updateZoomBar() {
        const pct = ((state.zoom - 0.3) / 1.7) * 100;
        const pct100 = (1.0 - 0.3) / 1.7 * 100; // 100% tick position ≈ 41.18%
        document.getElementById('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
        const fill = document.getElementById('zoomFill');
        fill.style.left = Math.min(pct, pct100) + '%';
        fill.style.width = Math.abs(pct - pct100) + '%';
        document.getElementById('zoomThumb').style.left = pct + '%';
    }
    function setZoom(z) {
        const cr = document.querySelector('.canvas').getBoundingClientRect();
        const cx = cr.width / 2, cy = cr.height / 2;
        const wx = cx / state.zoom - state.panX;
        const wy = cy / state.zoom - state.panY;
        state.zoom = Math.min(2, Math.max(0.3, z));
        state.panX = cx / state.zoom - wx;
        state.panY = cy / state.zoom - wy;
        worldEl.style.transform = `scale(${state.zoom}) translate(${state.panX}px, ${state.panY}px)`;
        updateGrid();
        drawWires();
        realignAllExitPorts();
        // 拖线中缩放：重画预览线让其跟随（用上次鼠标位置）
        if (wireDrag) redrawPreview();
        updateZoomBar();
    }

    /* ---------- Zoom (mouse wheel, focus at cursor) ---------- */
    document.querySelector('.canvas').addEventListener('wheel', e => {
        // Don't zoom when scrolling ANY toolbar row (class .canvas-toolbar matches
        // both row 1 #canvasToolbar and row 2 #canvasToolbarRow2) or task palette body.
        // Using id-based '#canvasToolbar' would miss row 2 and let wheel zoom through.
        if (e.target.closest('.canvas-toolbar') || e.target.closest('#taskPaletteBody')) return;
        const cr = document.querySelector('.canvas').getBoundingClientRect();
        const wx = (e.clientX - cr.left) / state.zoom - state.panX;
        const wy = (e.clientY - cr.top) / state.zoom - state.panY;
        const delta = -e.deltaY * 0.001;
        state.zoom = Math.min(2, Math.max(0.3, state.zoom + delta * state.zoom));
        state.panX = (e.clientX - cr.left) / state.zoom - wx;
        state.panY = (e.clientY - cr.top) / state.zoom - wy;
        worldEl.style.transform = `scale(${state.zoom}) translate(${state.panX}px, ${state.panY}px)`;
        updateGrid();
        drawWires();
        realignAllExitPorts();
        // 拖线中滚轮缩放：用当前鼠标位置重画预览线，使其跟随缩放后的画布
        if (wireDrag) drawPreview(e.clientX, e.clientY);
        updateZoomBar();
    }, { passive: false });

    /* ---------- Pan (middle mouse / right during wire drag / left on empty canvas) ----------
       关键：浏览器对「已按住某键时再按第二个键」不派发 pointerdown/pointerup，只派发
       pointermove（e.button=新按键、e.buttons=按住位掩码）。因此 pan 的启停统一用
       e.buttons 位掩码（1=左 2=右 4=中）的上升/下降沿判定，在 pointerdown / pointermove /
       pointerup 上挂同一个 handler（pointerup 也是 buttons 归零，下降沿自然触发）。
       历史 Bug 仍适用：右键/左键要排除 .node / #zoomBar / .canvas-toolbar，否则
       setPointerCapture 会抢走指针、破坏工具栏点击（见下方 shouldStartPan 真值表）。
       设备预览在 .canvas-toolbar--row2 里，右键它若被当成拖动画布 → 匹配框 hover 被清。 */
    let _panning = false, _panButton = null, _panPointerId = null,
        _panVX, _panVY, _panRAF = null, _lastButtons = 0;

    function beginPan(button, e) {
        _panning = true;
        _panButton = button;
        _panPointerId = e.pointerId;
        _panVX = e.clientX;
        _panVY = e.clientY;
        const canvas = e.target.closest('.canvas');
        canvas.classList.add('canvas--grabbing');
        canvas.setPointerCapture(e.pointerId);
        // 点击画布空白区域时，让当前聚焦的输入框失焦
        if (document.activeElement && document.activeElement !== document.body) {
            document.activeElement.blur();
        }
        if (e.cancelable) e.preventDefault();
    }
    function endPan() {
        _panning = false;
        _panButton = null;
        _lastButtons = 0;
        const canvas = document.querySelector('.canvas');
        canvas.classList.remove('canvas--grabbing');
        if (_panPointerId != null) {
            try { canvas.releasePointerCapture(_panPointerId); } catch {}
            _panPointerId = null;
        }
        if (_panRAF) { cancelAnimationFrame(_panRAF); _panRAF = null; drawWires(); }
    }

    function onPanButtonState(e) {
        const prev = _lastButtons;
        _lastButtons = e.buttons;
        if (!_panning && !e.target.closest('.canvas')) return;
        const act = panButtonEdge(prev, e.buttons, {
            overNode: !!e.target.closest('.node'),
            overZoomBar: !!e.target.closest('#zoomBar'),
            overToolbar: !!e.target.closest('.canvas-toolbar'),
            wireDragActive: !!wireDrag,
            overWireDelete: !!e.target.closest('.wire-delete'),
        }, _panning ? _panButton : null);
        if (act?.stop) { endPan(); }
        else if (act?.start) { beginPan(act.button, e); }
    }
    // pointerdown 用捕获相位：resize 手柄 / 节点拖拽 / 分隔线等内部 handler 会
    // stopPropagation，冒泡相位收不到 → _lastButtons 停留在旧值 → 拖出节点边界后
    // 第一个 pointermove 会误判出左键"假上升沿"、把画布拖走。捕获相位先于目标
    // 相位执行，stopPropagation 不影响它，按钮状态始终准确。
    document.addEventListener('pointerdown', onPanButtonState, true);
    document.addEventListener('pointermove', onPanButtonState);
    document.addEventListener('pointerup', onPanButtonState);
    document.addEventListener('pointercancel', () => { if (_panning) endPan(); else _lastButtons = 0; });

    document.addEventListener('pointermove', e => {
        if (!_panning) return;
        e.preventDefault();
        const dx = e.clientX - _panVX;
        const dy = e.clientY - _panVY;
        _panVX = e.clientX;
        _panVY = e.clientY;
        state.panX += dx / state.zoom;
        state.panY += dy / state.zoom;
        worldEl.style.transform = `scale(${state.zoom}) translate(${state.panX}px, ${state.panY}px)`;
        updateGrid();
        // 平移期间跳过节点内连线重建（intra/forced 画在 .node__wires，随 world
        // transform 自动平移）；仅重画外部 crossWireSVG + deleteBtnSVG。结束再全量。
        if (!_panRAF) _panRAF = requestAnimationFrame(() => { _panRAF = null; drawWires(true); });
    });

    window.addEventListener('contextmenu', e => e.preventDefault());
    document.querySelector('.canvas').addEventListener('scroll', () => {
        if (!hoveredWire) drawWires();
    });

    /* ---------- Center on first node after project load ---------- */
    function centerOnFirstNode() {
        const n = state.nodes[0];
        if (!n) return;
        state.zoom = 1;
        const cw = canvasEl.clientWidth, ch = canvasEl.clientHeight;
        const cx = n.x + (n.w || 560) / 2;
        const cy = n.y + ((n.el && n.el.offsetHeight) || 200) / 2;
        state.panX = cw / 2 - cx;
        state.panY = ch / 2 - cy;
        worldEl.style.transform = `scale(1) translate(${state.panX}px, ${state.panY}px)`;
        updateGrid();
        updateZoomBar();
        drawWires();
    }
    window.__centerOnFirstNode = centerOnFirstNode;

    /* ---------- Wire hover tracking ---------- */
    // canvas 把 toolbar / task-palette / device-preview 都包了，这些面板盖在画布上层。
    // 删除叉 (deleteBtnSVG z=998) 比面板 z (100/102) 高，hover 到一根线后，鼠标就算移到
    // 画布空白区，只要 mid 落在面板矩形下，叉仍会透出。两种情况要清 hover：
    //   1) e.target 在面板内 — pointermove 命中的事件目标
    //   2) hoveredWire 的 midX/midY 投影到 viewport 后落在面板矩形内 — 鼠标在画布空地，
    //      但叉的位置被面板挡着
    const _hoverBlockerSelector = '.canvas-toolbar, .task-palette, .device-preview';
    function _midHitsPanel() {
        if (!hoveredWire) return false;
        const g = wireGeom[hoveredWire];
        if (!g || !g.ctrl) return false;
        // de Casteljau at t=0.5 — 与 wires.js curveMidPoint 同步
        let a = g.ctrl;
        while (a.length > 1) {
            const b = [];
            for (let i = 0; i < a.length - 1; i++) b.push({ x: (a[i].x + a[i + 1].x) / 2, y: (a[i].y + a[i + 1].y) / 2 });
            a = b;
        }
        const cr = document.querySelector('.canvas').getBoundingClientRect();
        const sx = (a[0].x + state.panX) * state.zoom + cr.left;
        const sy = (a[0].y + state.panY) * state.zoom + cr.top;
        for (const el of document.querySelectorAll(_hoverBlockerSelector)) {
            const r = el.getBoundingClientRect();
            if (sx >= r.left && sx <= r.right && sy >= r.top && sy <= r.bottom) return true;
        }
        return false;
    }
    document.querySelector('.canvas').addEventListener('pointermove', e => {
        // 拖动/平移/拖线中（有键按下）不追踪 hover：否则每帧对全部线算 distToBezier，
        // 且 hover 翻转会触发一次全量 drawWires（绕过 skipInternal），拖节点时帧被拖垮。
        if (e.buttons !== 0) return;
        if (e.target.closest(_hoverBlockerSelector) || _midHitsPanel()) {
            if (hoveredWire) { setHoveredWire(null); drawWires(); }
            return;
        }
        updateHoverFromPointer(e.clientX, e.clientY);
    });
    document.querySelector('.canvas').addEventListener('pointerenter', e => {
        updateHoverFromPointer(e.clientX, e.clientY);
    });
    document.querySelector('.canvas').addEventListener('pointerleave', () => {
        if (hoveredWire) { setHoveredWire(null); drawWires(); }
    });

    /* ---------- Zoom bar ---------- */
    const zoomTrack = document.getElementById('zoomTrack');
    const zoomThumb = document.getElementById('zoomThumb');
    let _zmoving = false;

    function zoomFromTrackX(clientX) {
        const r = zoomTrack.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        return 0.3 + pct * 1.7;
    }

    zoomTrack.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const tick = e.target.closest('.zoom-tick');
        if (tick) {
            setZoom(parseFloat(tick.dataset.zoom));
            return;
        }
        if (e.target === zoomThumb) {
            _zmoving = true;
            zoomThumb.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }
        // click on track -> snap
        setZoom(zoomFromTrackX(e.clientX));
    });

    zoomThumb.addEventListener('pointermove', e => {
        if (!_zmoving) return;
        setZoom(zoomFromTrackX(e.clientX));
    });

    zoomThumb.addEventListener('pointerup', e => {
        if (!_zmoving) return;
        _zmoving = false;
        zoomThumb.releasePointerCapture(e.pointerId);
    });

    document.getElementById('zoomMinus').addEventListener('click', () => {
        setZoom(state.zoom - 0.1);
    });
    document.getElementById('zoomPlus').addEventListener('click', () => {
        setZoom(state.zoom + 0.1);
    });

    updateZoomBar();

    /* ---------- Code preview panel ---------- */
    initCodePreview();

    /* ---------- Task palette panel ---------- */
    initTaskPalette();

    /* ---------- Device preview widget (M2) ---------- */
    initDevicePreview();

    /* ---------- Global variables bar ---------- */
    initGlobalVars();

    /* ---------- Sidebar ---------- */
    initSidebar();

    /* ---------- Add node button ---------- */
    document.getElementById('btnAddNode').addEventListener('click', () => {
        const cr = document.querySelector('.canvas').getBoundingClientRect();
        // Viewport center in canvas coordinates
        const cx = (cr.width / 2) / state.zoom - state.panX;
        const cy = (cr.height / 2) / state.zoom - state.panY;
        const id = 'n' + Date.now();
        capture();
        state.nodes.push({
            id, name: 'node_' + id.slice(-4),
            x: Math.round(cx - 280), y: Math.round(cy - 80),
            info: [], logic: [], groups: [],
            outPorts: ['out'], w: 560, colF: [1, 1, 1.15], inPorts: ['in'],
        });
        setFocusedNodeId(id);
        setFocusedCardId(null);
        const btnAddGroup = document.getElementById('btnAddGroup');
        if (btnAddGroup) btnAddGroup.disabled = false;
        render();
        syncToolbar();
        toast(t('toast.addedNode'));
    });

    /* ---------- Add goto node button ---------- */
    document.getElementById('btnAddGoto').addEventListener('click', () => {
        const cr = document.querySelector('.canvas').getBoundingClientRect();
        const cx = (cr.width / 2) / state.zoom - state.panX;
        const cy = (cr.height / 2) / state.zoom - state.panY;
        const id = 'g' + Date.now();
        capture();
        state.nodes.push({ id, type: 'goto', name: 'goto', x: Math.round(cx - 160), y: Math.round(cy - 60), w: 320, inPorts: ['in'], target: null, info: [], logic: [], groups: [] });
        setFocusedNodeId(id);
        setFocusedCardId(null);
        render();
        toast(t('toast.addedGoto'));
    });

    /* ---------- Add op-group button ---------- */
    document.getElementById('btnAddGroup').addEventListener('click', () => {
        const n = state.nodes.find(n => n.id === focusedNodeId);
        if (!n) return;
        if (!n.groups) n.groups = [];
        const gid = 'g' + Date.now();
        capture();
        n.groups.push({ id: gid, name: 'Group', on: false, ops: [] });
        setFocusedCardId(gid);
        state.dirty = true;
        render();
        toast(t('toast.addedGroup'));
    });

    /* ---------- Language toggle ---------- */
    const btnLang = document.getElementById('btnLang');
    if (btnLang) btnLang.addEventListener('click', toggleLang);

    /* ---------- Dark mode toggle ---------- */
    document.getElementById('btnDarkMode').addEventListener('click', () => {
        state.dark = !state.dark;
        const root = document.documentElement;
        // 切换期间临时禁用全局 transition（html.theme-freeze）：所有元素同一帧
        // 立即换成新主题色，避免"各控件自带 hover transition 时长不一"造成的割裂渐变。
        // 两帧后摘除，恢复日常 hover 过渡。
        root.classList.add('theme-freeze');
        root.setAttribute('data-theme', state.dark ? 'dark' : 'light');
        requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-freeze')));
    });

    /* ---------- Toolbar button handlers ---------- */
    document.getElementById('btnOpenDir').addEventListener('click', async () => {
        // 切换工作目录：先复用 closeProject() 关闭当前工程（含空态蒙版/面板收起），
        // 再解除目录绑定、进入"选工作目录"启动对话框。
        if (!await closeProject()) return;
        setDirHandle(null);
        refreshProjectList();
        showStartupDialog();
    });
    document.getElementById('btnNewProject').addEventListener('click', async () => {
        const dh = getDirHandle();
        const btn = document.getElementById('btnNewProject');
        if (dh) {
            btn.classList.add('sidebar__title-btn--loading');
            btn.disabled = true;
            try {
                const filename = await createNewProject(dh);
                // Don't auto-open the new project — just refresh the list
                await refreshProjectList();
                syncToolbar();
                toast(t('toast.projectCreated'));
            } catch (e) {
                toast(t('toast.projectCreateFail', { msg: e.message || '' }));
            } finally {
                btn.classList.remove('sidebar__title-btn--loading');
                btn.disabled = false;
            }
        } else {
            // Temp mode: start with a start node
            const startId = 'n' + Date.now();
            state.nodes = [{
                id: startId, name: 'start',
                x: 100, y: 100,
                info: [], logic: [], groups: [],
                outPorts: ['out'], w: 560, colF: [1, 1, 1.15], inPorts: ['in'],
            }];
            state.wires = [];
            state.projectName = 'untitled';
            state.globalVars = [
                { name: 'device_id', type: 'string', value: '', fixed: true },
            ];
            setCurrentFile('__temp__');
            setFocusedNodeId(startId);
            setFocusedCardId(null);
            render();
            if (window.__centerOnFirstNode) window.__centerOnFirstNode();
            renderGlobalVars();
            state.dirty = false;
            clearHistory();   // 新工程 → 历史清空
            refreshProjectList();
            syncToolbar();
            syncNewProjectBtn();
            hideProjectOverlay();
            toast(t('toast.projectCreatedTemp'));
        }
    });
    document.getElementById('btnImport').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.py';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (!await confirmSaveBeforeClose()) return;
            try {
                const code = await file.text();
                const pyDict = await pyodideParse(code);
                fromPythonDSL(pyDict, state);
                render();
                if (window.__centerOnFirstNode) window.__centerOnFirstNode();
                state.dirty = false;
                clearHistory();   // 导入工程 → 历史清空
                hideProjectOverlay();
                // In temp mode, mark that we have an active project for the sidebar
                if (!getDirHandle()) {
                    setCurrentFile(state.projectName || file.name);
                    refreshProjectList();
                    syncNewProjectBtn();
                }
                toast(t('toast.projectImported'));
            } catch (err) { toast(t('toast.parseFail', { msg: err.message })); }
        };
        input.click();
    });
    document.getElementById('btnExport').addEventListener('click', async () => {
        const name = state.projectName || 'project';
        const zip = new JSZip();
        zip.file('main.py', toPythonDSL(state));
        zip.file('droidtaskflow.py', generateDroidtaskflowPy());
        const blob = await zip.generateAsync({ type: 'blob' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name + '.zip';
        a.click();
        URL.revokeObjectURL(a.href);
        toast(t('toast.exportedZip', { name }));
    });
    document.getElementById('btnSave').addEventListener('click', async () => {
        const btn = document.getElementById('btnSave');
        if (btn.disabled || btn.classList.contains('icon-btn--saving')) return;
        const dh = getDirHandle();
        if (!dh) {
            toast(t('toast.openDirFirst'));
            return;
        }
        const filename = getCurrentFile() || 'main.py';
        btn.classList.add('icon-btn--saving');
        try {
            await saveToFile(state, dh, filename);
            state.dirty = false;
            toast(t('toast.savedTo', { name: filename }));
        } catch (e) {
            toast(t('toast.saveFail', { msg: e.message || '' }));
        } finally {
            btn.classList.remove('icon-btn--saving');
        }
    });
    /* ---------- Startup dialog (also reused by btnOpenDir) ---------- */
    async function showStartupDialog() {
        const cachedHandle = await restoreDirHandle();
        const dialog = document.getElementById('startupDialog');
        const msgEl = document.getElementById('startupDialogMsg');
        const btnHistory = document.getElementById('startupBtnHistory');
        const btnNew = document.getElementById('startupBtnNew');
        const btnTemp = document.getElementById('startupBtnTemp');

        // Reset state
        dialog.classList.remove('startup-dialog--hidden');
        btnHistory.style.display = 'none';
        btnNew.classList.remove('startup-btn--loading');
        btnHistory.disabled = btnNew.disabled = btnTemp.disabled = false;

        async function setupDirectory(handle, label, alreadyLoaded) {
            if (!alreadyLoaded) setDirHandle(handle);
            dialog.classList.add('startup-dialog--hidden');
            // 不在这里 hideProjectOverlay：选了目录 ≠ 打开了工程，
            // overlay 在 sidebar 点击工程文件加载后才隐藏。
            // Refresh project list first so it appears immediately
            refreshProjectList();
            // Load palette in background (non-blocking)
            initPaletteCards({ silent: true }).catch(e => { /* palette is non-critical */ });
            initClipboard();
            initDragAndDrop();
        }

        // Remove old listeners by cloning buttons
        const hClone = btnHistory.cloneNode(true);
        const nClone = btnNew.cloneNode(true);
        const tClone = btnTemp.cloneNode(true);
        btnHistory.replaceWith(hClone); btnNew.replaceWith(nClone); btnTemp.replaceWith(tClone);
        const btnH = document.getElementById('startupBtnHistory');
        const btnN = document.getElementById('startupBtnNew');
        const btnT = document.getElementById('startupBtnTemp');

        // Show dialog
        if (cachedHandle) {
            btnH.style.display = '';
            msgEl.textContent = t('dialog.historyDirPrompt');
            const pathEl = document.getElementById('startupDialogPath');
            pathEl.textContent = cachedHandle.name;
            pathEl.style.display = '';
            btnH.addEventListener('click', async () => {
                btnH.disabled = btnN.disabled = btnT.disabled = true;
                try {
                    await setupDirectory(cachedHandle, t('dialog.historyDir'));
                } catch (e) {
                    toast(t('toast.historyDirFail', { msg: e.message || t('toast.rechooseDir') }));
                    btnH.disabled = btnN.disabled = btnT.disabled = false;
                    dialog.classList.remove('startup-dialog--hidden');
                }
            }, { once: true });
        } else {
            msgEl.textContent = t('dialog.chooseDirPrompt');
        }
        let _newDirPending = false;
        btnN.addEventListener('click', async () => {
            if (_newDirPending) return;
            _newDirPending = true;
            btnH.disabled = btnN.disabled = btnT.disabled = true;
            btnN.classList.add('startup-btn--loading');
            const h = await openDirectory();
            if (h) {
                await setupDirectory(h, t('dialog.newDir'), true /* openDirectory already loaded */);
                btnN.classList.remove('startup-btn--loading');
            } else {
                btnN.classList.remove('startup-btn--loading');
                btnH.disabled = btnN.disabled = btnT.disabled = false;
                _newDirPending = false;
            }
        });
        btnT.addEventListener('click', () => {
            setDirHandle(null);  // 解除工作目录绑定，进入纯临时模式
            dialog.classList.add('startup-dialog--hidden');
            hideProjectOverlay();
            toast(t('toast.tempWarnToast'));
            refreshProjectList();
            initClipboard();
            initDragAndDrop();
            const cp = getConsolePanel(); if (cp) cp.setToggleEnabled(true);
        }, { once: true });
    }

    /* ---------- Project overlay ---------- */
    function showProjectOverlay() {
        const overlay = document.getElementById('projectOverlay');
        if (overlay) overlay.classList.remove('project-overlay--hidden');
        // Expand sidebar so the user can create or open a project
        const shell = document.querySelector('.app-shell');
        if (shell) shell.classList.remove('app-shell--sb-collapsed');
        // 无工程:禁用输出窗口
        const cp = getConsolePanel(); if (cp) cp.setToggleEnabled(false);
        syncRunBtn();
    }
    function hideProjectOverlay() {
        const overlay = document.getElementById('projectOverlay');
        if (overlay) overlay.classList.add('project-overlay--hidden');
        // 有工程:启用输出窗口
        const cp = getConsolePanel(); if (cp) cp.setToggleEnabled(true);
        syncRunBtn();
    }

    /* ---------- Close project (共用：关闭按钮 / 工作目录按钮) ---------- */
    // 关闭当前工程：清空状态 + 收起面板 + 刷新工程列表 + 显示空态蒙版。
    // 返回 false 表示用户在保存提醒里取消了，调用方应中止后续操作。
    async function closeProject() {
        if (!await confirmSaveBeforeClose()) return false;
        state.nodes = [];
        state.wires = [];
        state.projectName = 'untitled';
        state.globalVars = [
            { name: 'device_id', type: 'string', value: '', fixed: true },
        ];
        setCurrentFile('');
        render();
        renderGlobalVars();
        state.dirty = false;
        clearHistory();   // 关闭工程 → 历史清空
        collapseTaskPalette();
        collapseCodePreview();
        collapseDevicePreview();
        collapseConsole();
        const cp2 = getConsolePanel(); if (cp2) cp2.setToggleEnabled(false);
        refreshProjectList();
        syncToolbar();
        syncNewProjectBtn();
        showProjectOverlay();
        return true;
    }

    document.getElementById('btnCloseProject').addEventListener('click', async () => {
        if (!await closeProject()) return;
        toast(t('toast.projectClosed'));
    });

    /* ---------- Trash drop target (drag to delete) ---------- */
    const trashEl = document.createElement('div');
    trashEl.id = 'trashDrop';
    trashEl.className = 'trash-drop';
    trashEl.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`;
    trashEl.title = t('tooltip.trashDrop');
    document.querySelector('.canvas').appendChild(trashEl);

    /* ---------- 浏览器缩放 / 窗口尺寸变化：reflow 后重对齐出口端口 ----------
       真实浏览器 Ctrl+滚轮缩放会改 innerWidth → 触发 resize → reflow，方块口/rail
       的 CSS 位置可能漂移，而圆口 top 是 render 时算的旧值 → 出口对不齐。
       resize 事件发生在 reflow 之后，此刻重测（getBoundingClientRect）拿到的是新布局。 */
    let _reflowRAF = null;
    window.addEventListener('resize', () => {
        if (_reflowRAF) return;
        _reflowRAF = requestAnimationFrame(() => {
            _reflowRAF = null;
            realignAllExitPorts();
            drawWires();
        });
    });

    /* ---------- Startup ---------- */
    loadToolFiles().catch(e => console.warn('loadToolFiles failed:', e));
    // 卡片定义加载已挪到 _bootstrap 里：等 pyodide ready 后显式 await initPaletteCards()，
    // 完成后 toast "任务卡片定义加载完成"。这里不再 fire-and-forget。
    showProjectOverlay();
    showStartupDialog();
}
