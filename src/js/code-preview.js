/* ============================================================
   REAL-TIME CODE PREVIEW PANEL
   ============================================================ */
import { state } from './state.js';
import { toPythonDSL } from './datamapper.js';
import { syncToolbar } from './global-vars.js';
import { t } from './i18n.js';

let _expanded = false;
let _fullscreen = false;
let _panelWidth = 25; // percentage
let _resizing = false, _resizeStartX, _resizeStartW, _resizeRAF = null;
let _searchIdx = -1, _searchCount = 0;

/** Return current code-preview panel width in px, or null if collapsed. */
export function getCodePanelWidth() {
    if (!_expanded) return null;
    const panel = document.getElementById('codePreview');
    if (!panel) return null;
    return panel.getBoundingClientRect().width;
}

/** Collapse the code preview panel (called on project close, etc.). */
export function collapseCodePreview() {
    if (!_expanded) return;
    _expanded = false;
    const panel = document.getElementById('codePreview');
    const toggle = document.getElementById('codePreviewToggle');
    if (panel) {
        panel.classList.add('code-preview--collapsed');
        panel.classList.remove('code-preview--expanded');
        applyPanelStyle(panel);
    }
    if (toggle) {
        toggle.classList.remove('code-preview__toggle--expanded');
        toggle.setAttribute('aria-expanded', 'false');
    }
}

// 找最近的滚动容器（scrollIntoView 滚动的就是它）；refresh 重建内容时用它保存/恢复 scrollTop。
function getScrollContainer(el) {
    let p = el;
    while (p && p !== document.body) {
        const cs = getComputedStyle(p);
        if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return p;
        p = p.parentElement;
    }
    return null;
}

export function refreshCodePreview() {
    if (!_expanded) return;
    const el = document.getElementById('codePreviewContent');
    // 记录滚动位置：重建内容会归零 scrollTop。搜索命中后用户可能已滚到别处，
    // refresh（非用户主动搜索）不应再跳回匹配，而应保持当前位置。
    const scroller = getScrollContainer(el);
    const savedScrollTop = scroller ? scroller.scrollTop : 0;
    try {
        const code = toPythonDSL(state);
        el.textContent = code;
        if (typeof Prism !== 'undefined') {
            Prism.highlightElement(el);
        }
        // Re-apply search after refresh：只重建高亮/激活标记，不滚动（scroll:false，保持索引）
        const input = document.getElementById('codeSearchInput');
        if (input && input.value) doSearch(input.value, { scroll: false, preserveIndex: true });
        // 恢复滚动位置
        if (scroller) scroller.scrollTop = savedScrollTop;
    } catch (e) {
        el.textContent = '# Error: ' + e.message;
        el.className = '';
    }
}

function clearSearchMarks(el) {
    const marks = el.querySelectorAll('mark.mark--search');
    marks.forEach(m => { m.replaceWith(document.createTextNode(m.textContent)); });
    el.normalize();
}

function highlightMatches(el, query) {
    if (!query) { _searchCount = 0; return; }
    const lower = query.toLowerCase();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    let count = 0;
    for (const node of textNodes) {
        const text = node.textContent;
        const lowerText = text.toLowerCase();
        let lastEnd = 0, idx;
        const fragments = [];
        while ((idx = lowerText.indexOf(lower, lastEnd)) !== -1) {
            fragments.push(document.createTextNode(text.slice(lastEnd, idx)));
            const mark = document.createElement('mark');
            mark.className = 'mark--search';
            mark.textContent = text.slice(idx, idx + query.length);
            mark.dataset.matchIdx = count;
            fragments.push(mark);
            count++;
            lastEnd = idx + query.length;
        }
        if (fragments.length) {
            fragments.push(document.createTextNode(text.slice(lastEnd)));
            const parent = node.parentNode;
            fragments.forEach(f => parent.insertBefore(f, node));
            parent.removeChild(node);
        }
    }
    _searchCount = count;
}

function scrollToMatch(idx) {
    const el = document.getElementById('codePreviewContent');
    const marks = el.querySelectorAll('mark.mark--search');
    marks.forEach(m => m.classList.remove('code-preview__search--active'));
    if (marks.length && idx >= 0 && idx < marks.length) {
        marks[idx].classList.add('code-preview__search--active');
        marks[idx].scrollIntoView({ block: 'center' });
    }
}

function doSearch(query, opts) {
    const el = document.getElementById('codePreviewContent');
    clearSearchMarks(el);
    highlightMatches(el, query);
    // 用户主动搜索 → 复位到第 1 个匹配；refresh 重建 → 保持原索引（内容变化越界则钳回）
    if (opts && opts.preserveIndex) {
        if (_searchIdx < 0 || _searchIdx >= _searchCount) _searchIdx = _searchCount > 0 ? 0 : -1;
    } else {
        _searchIdx = _searchCount > 0 ? 0 : -1;
    }
    const countEl = document.getElementById('codeSearchCount');
    if (countEl) countEl.textContent = _searchCount ? `${_searchIdx + 1}/${_searchCount}` : '';
    if (!opts || opts.scroll !== false) scrollToMatch(_searchIdx);
}

function applyPanelStyle(panel) {
    panel.style.width = _panelWidth + '%';
    panel.style.minWidth = _expanded ? '300px' : '0';
    panel.style.maxWidth = _expanded ? '50%' : 'none';
    panel.style.right = _expanded ? '0' : '-' + _panelWidth + '%';

    syncZoomBar();
    // Sync canvas toolbar right edge to code preview left edge.
    // Skip the rAF animation during resize drag — transitions are
    // already disabled, so the palette body just snaps each frame.
    if (_expanded) {
        const panelW = panel.getBoundingClientRect().width;
        syncToolbar(panelW);
    } else {
        syncToolbar(null);
    }
}

/** Shift the zoom bar left so it stays visible next to the code preview. */
function syncZoomBar() {
    const zoomBar = document.getElementById('zoomBar');
    const panel = document.getElementById('codePreview');
    if (!zoomBar || !panel) return;
    if (!_expanded) {
        zoomBar.style.right = '';
        return;
    }
    // actual rendered panel width + gap to zoom bar's default right edge
    const panelW = panel.getBoundingClientRect().width;
    zoomBar.style.right = (panelW + 16) + 'px';
}

/**
 * Ensure _panelWidth never represents less than the CSS min-width (300px)
 * when expressed as a percentage of the current viewport width.
 */
function clampPanelWidthToMin() {
    const mainArea = document.querySelector('.main-area');
    if (!mainArea) return;
    const mainW = mainArea.getBoundingClientRect().width;
    const minPct = (300 / mainW) * 100;
    if (_panelWidth < minPct) _panelWidth = Math.round(minPct);
}

export function initCodePreview() {
    const panel = document.getElementById('codePreview');
    const toggle = document.getElementById('codePreviewToggle');
    const fullscreenBtn = document.getElementById('codePreviewFullscreen');
    const resizeHandle = panel.querySelector('.code-preview__resize');
    const mainArea = panel.parentElement;

    /* ---------- expand / collapse ---------- */
    toggle.addEventListener('click', () => {
        _expanded = !_expanded;
        panel.classList.toggle('code-preview--collapsed', !_expanded);
        panel.classList.toggle('code-preview--expanded', _expanded);
        toggle.classList.toggle('code-preview__toggle--expanded', _expanded);
        toggle.setAttribute('aria-expanded', String(_expanded));
        clampPanelWidthToMin();
        applyPanelStyle(panel);
        if (_expanded) refreshCodePreview();
    });

    /* ---------- fullscreen ---------- */
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener('click', () => {
            _fullscreen = !_fullscreen;
            panel.classList.toggle('code-preview--fullscreen', _fullscreen);
            fullscreenBtn.textContent = _fullscreen ? '✕' : '⛶';
        });
    }

    /* ---------- resize from left edge ---------- */
    resizeHandle.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        if (_fullscreen) return;
        e.preventDefault();
        e.stopPropagation();
        _resizing = true;
        _resizeStartX = e.clientX;
        _resizeStartW = _panelWidth;
        // Disable transitions during drag so elements track instantly
        const zoomBar = document.getElementById('zoomBar');
        if (zoomBar) zoomBar.style.transition = 'none';
        const toolbar = document.getElementById('canvasToolbar');
        if (toolbar) toolbar.style.transition = 'none';
        const paletteBody = document.getElementById('taskPaletteBody');
        if (paletteBody) paletteBody.style.transition = 'none';
        resizeHandle.setPointerCapture(e.pointerId);
    });
    document.addEventListener('pointermove', e => {
        if (!_resizing) return;
        const dx = _resizeStartX - e.clientX;
        const mainW = mainArea.getBoundingClientRect().width;
        const dw = (dx / mainW) * 100;
        const minPct = (300 / mainW) * 100;  // CSS min-width in %
        _panelWidth = Math.max(minPct, Math.min(50, _resizeStartW + dw));
        if (!_resizeRAF) {
            _resizeRAF = requestAnimationFrame(() => {
                _resizeRAF = null;
                applyPanelStyle(panel);
            });
        }
    });
    document.addEventListener('pointerup', e => {
        if (!_resizing) return;
        _resizing = false;
        if (_resizeRAF) { cancelAnimationFrame(_resizeRAF); _resizeRAF = null; }
        // Restore transitions (CSS takes over)
        const zoomBar = document.getElementById('zoomBar');
        if (zoomBar) zoomBar.style.transition = '';
        const toolbar = document.getElementById('canvasToolbar');
        if (toolbar) toolbar.style.transition = '';
        const paletteBody = document.getElementById('taskPaletteBody');
        if (paletteBody) paletteBody.style.transition = '';
        resizeHandle.releasePointerCapture(e.pointerId);
    });

    /* ---------- context menu (copy) ---------- */
    let ctxMenu = null;
    function hideCtxMenu() {
        if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
    }
    panel.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        hideCtxMenu();
        const sel = window.getSelection();
        const hasSel = sel && sel.toString().length > 0;
        ctxMenu = document.createElement('div');
        ctxMenu.className = 'code-preview__ctxmenu';
        ctxMenu.innerHTML = `<button class="code-preview__ctxmenu-item">${t('code.copy')}</button>`;
        ctxMenu.style.left = e.clientX + 'px';
        ctxMenu.style.top = e.clientY + 'px';
        ctxMenu.querySelector('button').addEventListener('click', () => {
            if (hasSel) {
                navigator.clipboard.writeText(sel.toString()).catch(() => {});
            } else {
                const code = document.getElementById('codePreviewContent').textContent;
                navigator.clipboard.writeText(code).catch(() => {});
            }
            hideCtxMenu();
        });
        document.body.appendChild(ctxMenu);
    });
    document.addEventListener('click', e => {
        if (ctxMenu && !ctxMenu.contains(e.target)) hideCtxMenu();
    });

    /* ---------- search / find ---------- */
    const searchInput = document.getElementById('codeSearchInput');
    const searchCount = document.getElementById('codeSearchCount');
    const searchPrev = document.getElementById('codeSearchPrev');
    const searchNext = document.getElementById('codeSearchNext');
    const searchClose = document.getElementById('codeSearchClose');

    searchInput.addEventListener('input', () => doSearch(searchInput.value));

    searchInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                _searchIdx = _searchIdx > 0 ? _searchIdx - 1 : _searchCount - 1;
            } else {
                _searchIdx = _searchIdx < _searchCount - 1 ? _searchIdx + 1 : 0;
            }
            scrollToMatch(_searchIdx);
            if (searchCount && _searchCount) {
                searchCount.textContent = `${_searchIdx + 1}/${_searchCount}`;
            }
        }
        if (e.key === 'Escape') {
            searchInput.value = '';
            doSearch('');
            searchInput.blur();
        }
    });

    searchPrev.addEventListener('click', () => {
        if (!_searchCount) return;
        _searchIdx = _searchIdx > 0 ? _searchIdx - 1 : _searchCount - 1;
        scrollToMatch(_searchIdx);
        if (searchCount) searchCount.textContent = `${_searchIdx + 1}/${_searchCount}`;
    });

    searchNext.addEventListener('click', () => {
        if (!_searchCount) return;
        _searchIdx = _searchIdx < _searchCount - 1 ? _searchIdx + 1 : 0;
        scrollToMatch(_searchIdx);
        if (searchCount) searchCount.textContent = `${_searchIdx + 1}/${_searchCount}`;
    });

    searchClose.addEventListener('click', () => {
        searchInput.value = '';
        doSearch('');
    });

    // Ctrl+F / Cmd+F inside code preview
    panel.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            e.stopPropagation();
            searchInput.focus();
            searchInput.select();
        }
    });

    applyPanelStyle(panel);

    /**
     * Sync _panelWidth to the panel's actual rendered pixel width,
     * then re-apply positions to toggle / task-palette / zoom-bar.
     * Called on browser resize (ResizeObserver + window.resize).
     */
    function onViewportResize() {
        if (!_expanded || _resizing) return;
        const mainW = mainArea.getBoundingClientRect().width;
        const actualPx = panel.getBoundingClientRect().width;
        _panelWidth = Math.round((actualPx / mainW) * 100);
        const minPct = Math.round((300 / mainW) * 100);
        if (_panelWidth < minPct) _panelWidth = minPct;
        applyPanelStyle(panel);
    }

    /* ResizeObserver on mainArea catches most viewport changes */
    const viewportObserver = new ResizeObserver(() => onViewportResize());
    viewportObserver.observe(mainArea);

    /* window.resize fallback — covers edge cases ResizeObserver may miss */
    window.addEventListener('resize', () => onViewportResize());
}
