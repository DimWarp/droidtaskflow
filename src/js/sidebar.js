/* ============================================================
   SIDEBAR — left panel: project list, device & automation stubs
   ============================================================ */
import { state, toast } from './state.js';
import { render } from './render.js';
import { getConsolePanel, collapseConsole } from './console-panel.js';
import { syncRunBtn } from './backend-panel.js';
import { getDirHandle, listProjectFiles, loadProjectFile, getProjectName, deleteProject, copyProject, saveToFile } from './filesystem.js';
import { t } from './i18n.js';
import { toPythonDSL } from './datamapper.js';
import { renderGlobalVars, syncToolbar } from './global-vars.js';
import { clearHistory } from './history.js';
import { collapseTaskPalette } from './task-palette.js';
import { collapseCodePreview } from './code-preview.js';
import { collapseDevicePreview } from './device-preview.js';

/** Currently active project filename (e.g. 'main.py'). */
let _currentFile = '';

/** Guard against concurrent project loads — only one load at a time. */
let _loadingProject = false;

/** Only show spinner on the first directory load; silent thereafter. */
let _showSpinner = true;

/** Update the tracked current file (called externally when switching projects). */
export function setCurrentFile(filename) {
    _currentFile = filename;
    _updateSaveCloseBtns();
}
export function getCurrentFile() { return _currentFile; }

/** Enable/disable save & close buttons based on whether a project is open. */
function _updateSaveCloseBtns() {
    const save = document.getElementById('btnSave');
    const close = document.getElementById('btnCloseProject');
    const active = !!_currentFile;
    const isTemp = !getDirHandle();
    // In temp mode, save button is always disabled (no directory to save to)
    if (save) save.disabled = !active || isTemp;
    if (close) close.disabled = !active;
    syncNewProjectBtn();
}

/** Enable/disable the "New Project" button based on temp mode project limit. */
export function syncNewProjectBtn() {
    const btn = document.getElementById('btnNewProject');
    if (!btn) return;
    const isTemp = !getDirHandle();
    const hasProject = !!_currentFile;
    btn.disabled = isTemp && hasProject;
}

/**
 * If the current project has unsaved changes, prompt the user.
 * In temp mode, always prompt (data will be lost on close).
 * Returns true if it's safe to proceed (saved/exported/discarded/no changes), false if cancelled.
 */
export function confirmSaveBeforeClose() {
    const isTemp = !getDirHandle();
    // Normal mode: skip dialog if not dirty
    if (!isTemp && !state.dirty) return Promise.resolve(true);
    // Temp mode: skip dialog only if no project is open
    if (isTemp && !_currentFile) return Promise.resolve(true);

    return new Promise((resolve) => {
        const dialog = document.getElementById('saveConfirmDialog');
        const msgEl = dialog.querySelector('.startup-dialog__msg');
        const btnSave = document.getElementById('saveConfirmSave');
        const btnDiscard = document.getElementById('saveConfirmDiscard');
        const btnCancel = document.getElementById('saveConfirmCancel');

        // Configure dialog content based on mode
        if (isTemp) {
            msgEl.textContent = t('dialog.saveConfirmTempMsg');
            btnSave.textContent = t('dialog.export');
            btnDiscard.textContent = t('dialog.notExport');
            btnCancel.textContent = t('dialog.cancel');
        } else {
            msgEl.textContent = t('dialog.saveConfirmMsg');
            btnSave.textContent = t('dialog.save');
            btnDiscard.textContent = t('dialog.discard');
            btnCancel.textContent = t('dialog.cancel');
        }

        function cleanup() {
            dialog.classList.add('startup-dialog--hidden');
            btnSave.classList.remove('startup-btn--loading');
            btnDiscard.disabled = false;
            btnCancel.disabled = false;
            btnSave.removeEventListener('click', onSave);
            btnDiscard.removeEventListener('click', onDiscard);
            btnCancel.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
        }

        async function onSave() {
            // Show spinner, disable other buttons
            btnSave.classList.add('startup-btn--loading');
            btnDiscard.disabled = true;
            btnCancel.disabled = true;

            const dh = getDirHandle();
            if (dh) {
                const filename = _currentFile || 'main.py';
                await saveToFile(state, dh, filename);
                state.dirty = false;
                toast(t('toast.savedTo', { name: filename }));
            } else {
                // Temp mode: export as zip
                const JSZip = (await import('jszip')).default;
                const { toPythonDSL } = await import('./datamapper.js');
                const { generateDroidtaskflowPy } = await import('./datamapper.js');
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
                state.dirty = false;
                toast(t('toast.exportedZip', { name }));
            }

            cleanup();
            // 保存工程后刷新工程清单：保险起见，外部可能并发改了文件（Pyodide 后台、
            // 用户在 VSCode 改了对应文件等）。保存本身不改动文件名，但刷新一次让 UI 同步。
            await refreshProjectList();
            resolve(true);
        }

        function onDiscard() {
            cleanup();
            state.dirty = false;
            resolve(true);
        }

        function onCancel() {
            cleanup();
            resolve(false);
        }

        function onKey(e) { if (e.key === 'Escape') onCancel(); }
        btnSave.addEventListener('click', onSave);
        btnDiscard.addEventListener('click', onDiscard);
        btnCancel.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
        dialog.classList.remove('startup-dialog--hidden');
    });
}

/** Create an export button that triggers the hidden #btnExport in the top bar. */
function _makeExportBtn() {
    const btn = document.createElement('button');
    btn.className = 'sidebar__file-export';
    btn.dataset.tooltip = 'tooltip.export';
    btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();  // don't trigger file click
        document.getElementById('btnExport').click();
    });
    return btn;
}

/** Show a styled confirm dialog. Returns a Promise<boolean>. */
function _showConfirmDialog(title, message) {
    return new Promise(resolve => {
        let done = false;
        const finish = (val) => { if (done) return; done = true; overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
        const onKey = (e) => { if (e.key === 'Escape') finish(false); };
        const overlay = document.createElement('div');
        overlay.className = 'startup-dialog';
        overlay.innerHTML = `
            <div class="startup-dialog__card">
                <h2 class="startup-dialog__title">${title}</h2>
                <p class="startup-dialog__msg">${message}</p>
                <div class="startup-dialog__actions startup-dialog__actions--row" style="gap:8px;justify-content:flex-end;">
                    <button class="startup-btn" data-action="cancel">${t('dialog.cancel')}</button>
                    <button class="startup-btn startup-btn--danger" data-action="confirm">${t('dialog.delete')}</button>
                </div>
            </div>`;
        overlay.addEventListener('click', (e) => {
            const act = e.target.dataset.action;
            if (act === 'confirm') finish(true);
            else if (act === 'cancel' || e.target === overlay) finish(false);
        });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
    });
}

/** Create a copy button that duplicates a project file. */
function _makeCopyBtn(filename, displayName) {
    const btn = document.createElement('button');
    btn.className = 'sidebar__file-copy';
    btn.dataset.tooltip = 'tooltip.copyProject';
    btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();  // don't trigger file click
        const dh = getDirHandle();
        if (!dh) return; // 临时模式没有可复制的文件，不显示此按钮
        try {
            await copyProject(dh, filename);
            await refreshProjectList();
            toast(t('toast.copied', { name: displayName }));
        } catch (err) {
            toast(t('toast.copyFail', { msg: err.message || '' }));
        }
    });
    return btn;
}

/** Create a delete button for a project. */
function _makeDeleteBtn(filename, displayName) {
    const btn = document.createElement('button');
    btn.className = 'sidebar__file-delete';
    btn.dataset.tooltip = 'tooltip.deleteProject';
    btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`;
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();  // don't trigger file click
        if (!await _showConfirmDialog(t('dialog.deleteTitle'), t('dialog.deleteMsg', { name: displayName }))) return;
        const dh = getDirHandle();
        if (dh) {
            const isCurrent = filename === _currentFile;
            try {
                // If deleting the currently open project, close it first (no save)
                if (isCurrent) {
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
                    clearHistory();   // 删除当前工程 → 历史清空
                    collapseTaskPalette();
                    collapseCodePreview();
                    collapseDevicePreview();
                    collapseConsole();
                    const cp = getConsolePanel(); if (cp) cp.setToggleEnabled(false);
                    syncToolbar();
                    syncNewProjectBtn();
                }
                await deleteProject(dh, filename);
                await refreshProjectList();
                if (isCurrent) {
                    const overlay = document.getElementById('projectOverlay');
                    if (overlay) overlay.classList.remove('project-overlay--hidden');
                    syncRunBtn();
                }
                toast(t('toast.deleted', { name: displayName }));
            } catch (err) {
                toast(t('toast.deleteFail', { msg: err.message || '' }));
            }
        } else {
            // Temp mode: just clear the project
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
            clearHistory();   // 清空临时工程 → 历史清空
            refreshProjectList();
            const overlay = document.getElementById('projectOverlay');
            if (overlay) overlay.classList.remove('project-overlay--hidden');
            syncRunBtn();
            toast(t('toast.tempCleared'));
        }
    });
    return btn;
}

/** Create a rename button that edits the project name inline. */
function _makeRenameBtn(filename, currentDisplayName) {
    const btn = document.createElement('button');
    btn.className = 'sidebar__file-rename';
    btn.dataset.tooltip = 'tooltip.rename';
    btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();  // don't trigger file click
        const fileEl = btn.closest('.sidebar__file');
        if (!fileEl) return;
        const nameSpan = fileEl.querySelector('.sidebar__file-name');
        if (!nameSpan) return;

        const oldName = nameSpan.textContent;

        // Replace span with an inline input
        const input = document.createElement('input');
        input.className = 'sidebar__file-input';
        input.value = oldName;

        nameSpan.replaceWith(input);

        // Create confirm button with checkmark
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'sidebar__file-confirm';
        confirmBtn.title = t('dialog.confirm');
        confirmBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        input.insertAdjacentElement('afterend', confirmBtn);

        input.focus();
        input.select();

        // Hide action buttons during edit
        const renameBtn = fileEl.querySelector('.sidebar__file-rename');
        const exportBtn = fileEl.querySelector('.sidebar__file-export');
        const deleteBtn = fileEl.querySelector('.sidebar__file-delete');
        if (renameBtn) renameBtn.style.display = 'none';
        if (exportBtn) exportBtn.style.display = 'none';
        if (deleteBtn) deleteBtn.style.display = 'none';

        let _finishing = false;

        const finish = async (commit) => {
            if (_finishing) return;
            _finishing = true;

            const newName = commit ? input.value.trim() : '';

            if (!commit || !newName || newName === oldName) {
                // Revert: restore buttons, replace input+confirmBtn back with span
                if (renameBtn) renameBtn.style.display = '';
                if (exportBtn) exportBtn.style.display = '';
                if (deleteBtn) deleteBtn.style.display = '';
                confirmBtn.remove();
                const span = document.createElement('span');
                span.className = 'sidebar__file-name';
                span.textContent = oldName;
                input.replaceWith(span);
                return;
            }

            const dh = getDirHandle();
            if (dh && filename) {
                // Gray input, spinner on confirm button, block interactions
                input.disabled = true;
                input.classList.add('sidebar__file-input--saving');
                confirmBtn.classList.add('sidebar__file-confirm--saving');
                confirmBtn.disabled = true;
                // Keep rename/export hidden; block close & switching
                const closeBtn = document.getElementById('btnCloseProject');
                if (closeBtn) closeBtn.disabled = true;
                const sectionBody = document.querySelector('.sidebar__section:nth-child(2) .sidebar__section-body');
                if (sectionBody) sectionBody.classList.add('sidebar__section-body--busy');
                try {
                    // Update the project name in state, render, and save
                    state.projectName = newName;
                    state.dirty = true;
                    render();
                    await saveToFile(state, dh, filename);
                    state.dirty = false;
                    await refreshProjectList();
                    if (closeBtn) closeBtn.disabled = !getCurrentFile();
                    if (sectionBody) sectionBody.classList.remove('sidebar__section-body--busy');
                    toast(t('toast.renamed', { name: newName }));
                } catch (err) {
                    // Revert project name on failure
                    state.projectName = oldName;
                    state.dirty = false;
                    input.disabled = false;
                    input.classList.remove('sidebar__file-input--saving');
                    confirmBtn.classList.remove('sidebar__file-confirm--saving');
                    confirmBtn.disabled = false;
                    if (closeBtn) closeBtn.disabled = !getCurrentFile();
                    if (sectionBody) sectionBody.classList.remove('sidebar__section-body--busy');
                    toast(t('toast.renameFail', { msg: err.message || '' }));
                    // Revert UI
                    if (renameBtn) renameBtn.style.display = '';
                    if (exportBtn) exportBtn.style.display = '';
                    if (deleteBtn) deleteBtn.style.display = '';
                    confirmBtn.remove();
                    const span = document.createElement('span');
                    span.className = 'sidebar__file-name';
                    span.textContent = oldName;
                    input.replaceWith(span);
                }
            } else {
                // Temp mode: just update the display name
                state.projectName = newName;
                setCurrentFile(newName);
                refreshProjectList();
                toast(t('toast.renamed', { name: newName }));
            }
        };

        confirmBtn.addEventListener('click', (ev) => { ev.stopPropagation(); finish(true); });
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
            if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
    });
    return btn;
}

/**
 * Refresh the "工程" section: list .py files from project/ or show
 * a placeholder when no working directory is bound.
 */
export async function refreshProjectList() {
    const body = document.querySelector('.sidebar__section:nth-child(2) .sidebar__section-body');
    if (!body) return;

    const dh = getDirHandle();
    if (!dh) {
        // Temp mode: show in-memory project if one is active
        if (_currentFile) {
            const displayName = _currentFile === '__temp__' ? t('sidebar.tempProject') : _currentFile;
            body.innerHTML = '';
            const item = document.createElement('div');
            item.className = 'sidebar__file sidebar__file--active';
            item.innerHTML = `<span class="sidebar__file-name">${displayName}</span>`;
            item.appendChild(_makeRenameBtn(_currentFile, displayName));
            item.appendChild(_makeExportBtn());
            item.appendChild(_makeDeleteBtn(_currentFile, displayName));
            body.appendChild(item);
        } else {
            body.innerHTML = `<div class="sidebar__placeholder">${t('sidebar.placeholderChooseDir')}</div>`;
        }
        return;
    }

    let files = [];
    try { files = await listProjectFiles(dh); } catch (e) {
        body.innerHTML = `<div class="sidebar__placeholder">${t('sidebar.placeholderReadFail')}</div>`;
        return;
    }

    if (!files.length) {
        body.innerHTML = `<div class="sidebar__placeholder">${t('sidebar.placeholderEmpty')}</div>`;
        return;
    }

    // Only show spinner on the first load after workspace selection
    const minSpinnerMs = 500;
    let t0 = 0;
    if (_showSpinner) {
        body.innerHTML = `<div class="sidebar__spinner"></div>`;
        t0 = performance.now();
    }

    // Resolve all project names first — never show raw filenames in the DOM
    const nameResults = await Promise.all(
        files.map(async (filename) => {
            try {
                return { filename, name: await getProjectName(dh, filename) };
            } catch (e) {
                return { filename, name: filename.replace(/\.py$/, '') };
            }
        })
    );

    const items = [];
    for (const { filename, name } of nameResults) {

        const item = document.createElement('div');
        item.className = 'sidebar__file';
        if (filename === _currentFile) item.classList.add('sidebar__file--active');

        item.innerHTML = `<span class="sidebar__file-name">${name}</span>`;

        if (filename === _currentFile) {
            item.appendChild(_makeRenameBtn(filename, name));
            item.appendChild(_makeExportBtn());
        }
        item.appendChild(_makeCopyBtn(filename, name));
        item.appendChild(_makeDeleteBtn(filename, name));

        item.addEventListener('click', async () => {
            if (filename === _currentFile) return;
            if (_loadingProject) {
                toast(t('toast.loading'));
                return;
            }
            if (!await confirmSaveBeforeClose()) return;
            const dh2 = getDirHandle();
            if (!dh2) return;
            _loadingProject = true;
            try {
                await loadProjectFile(dh2, filename);
                if (window.__centerOnFirstNode) window.__centerOnFirstNode();
                setCurrentFile(filename);
                refreshProjectList();
                const overlay = document.getElementById('projectOverlay');
                if (overlay) overlay.classList.add('project-overlay--hidden');
                const cp = getConsolePanel(); if (cp) cp.setToggleEnabled(true);
                syncRunBtn();
                toast(t('toast.switched', { name }));
            } catch (e) {
                toast(t('toast.loadFail', { msg: e.message || filename }));
            } finally {
                _loadingProject = false;
            }
        });

        items.push(item);
    }

    if (_showSpinner) {
        _showSpinner = false;
        // Ensure spinner is visible for at least minSpinnerMs
        const elapsed = performance.now() - t0;
        if (elapsed < minSpinnerMs) {
            await new Promise(r => setTimeout(r, minSpinnerMs - elapsed));
        }
    }

    body.innerHTML = '';
    items.forEach(item => body.appendChild(item));
}

/**
 * Sidebar collapse / expand toggle. Class lives on .app-shell now because
 * --sidebar-w is defined there (the sidebar column width follows it).
 */
function initSidebarToggle() {
    const shell = document.querySelector('.app-shell');
    const btn = document.getElementById('sidebarToggle');
    if (!shell || !btn) return;
    btn.addEventListener('click', () => {
        shell.classList.toggle('app-shell--sb-collapsed');
    });
}

/**
 * Initialise the sidebar.  Call once on startup.
 */
export function initSidebar() {
    initSidebarToggle();
    refreshProjectList();
}
