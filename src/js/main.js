/* ============================================================
   DroidTaskFlow — Entry Point
   ============================================================ */
// Fonts: Maple Mono (4 weights of woff2) are self-hosted via /public/fonts/
// and declared with @font-face in src/styles/main.css. Per typography spec §0.1:
//   --font-ui   -> Maple Mono (UI text: buttons, titles, labels, toasts, dialogs)
//   --font-code -> Maple Mono (code preview area; same family, future-proof token)
import { state, toast, getSelectedDevice } from './state.js';
import { getDirHandle } from './filesystem.js';
import { initInteractions } from './interactions.js';
import { initBackendsPanel, getClientById, autoDiscoverLocalBackends } from './backend-panel.js';
import { getSelectedBackendId } from './backend-client.js';
import { initConsolePanel, getConsolePanel } from './console-panel.js';
import { buildProjectBundle } from './backend-client.js';
import { toPythonDSL, generateDroidtaskflowPy } from './datamapper.js';
import { t, getLang, setLang, onLanguageChange } from './i18n.js';
import { initTooltip } from './tooltip.js';
import { initHistory } from './history.js';
import { initAutomationPanel } from './automation-panel.js';
import { render } from './render.js';
import { renderGlobalVars } from './global-vars.js';
import { refreshProjectList } from './sidebar.js';

// Guard against accidental refresh when project is unsaved or in temp mode
window.addEventListener('beforeunload', e => {
    const isTemp = !getDirHandle();
    if (isTemp && state.nodes.length > 0) {
        e.preventDefault();
        e.returnValue = t('dialog.tempReloadWarn');
        return;
    }
    if (state.dirty) {
        e.preventDefault();
        e.returnValue = t('dialog.dirtyReloadWarn');
        return;
    }
});

// Global error handlers — without these, a SyntaxError in any imported module
// (or an unhandled promise rejection) is silent: the dev tools console shows
// it, but no toast surfaces it to the user. Result: bugs like "every dialog
// button is dead" with no on-screen signal that anything is wrong.
// We log to console (for devtools / npm run check) AND toast (user-visible).
// Note: a SyntaxError in main.js itself prevents these from running at all;
// in that case the browser will still print the error to its own console.
window.addEventListener('error', (e) => {
    const where = e.filename ? ` @ ${e.filename.split('/').pop()}:${e.lineno}` : '';
    console.error('[window.error]', e.error ?? e.message);
    try { toast(t('toast.jsError', { msg: (e.error?.message ?? e.message ?? t('toast.unknown')), where })); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason?.message ?? String(e.reason ?? t('toast.unknown'));
    console.error('[unhandledrejection]', e.reason);
    try { toast(t('toast.promiseError', { msg })); } catch {}
});

async function onRunClick() {
    const id = getSelectedBackendId();
    if (!id) { toast(t('toast.selectBackendLeft')); return; }
    const cli = getClientById(id);
    if (!cli || cli.state !== 'connected') { toast(t('tooltip.backendNotConnected')); return; }
    if (!state.nodes || state.nodes.length === 0) { toast(t('toast.projectEmpty')); return; }
    let mainPy;
    try { mainPy = toPythonDSL(state); }
    catch (e) { toast(t('toast.genFail', { msg: e && e.message ? e.message : e })); return; }
    const dtfPy = await _loadDtfPyStub();
    let zip;
    try { zip = await buildProjectBundle({ mainPyText: mainPy, dtfPyText: dtfPy }); }
    catch (e) { toast(t('toast.bundleFail', { msg: e && e.message ? e.message : e })); return; }
    const runId = crypto.randomUUID();
    const panel = getConsolePanel();
    if (panel) panel.startRun(cli, runId);
    // M1: 把当前后端的选中 device_id 注入 global_args。
    // 后端 runner 把它拼成 CLI args (`--device_id=...`)，子进程入口再写回
    // runtime.global_vars；task 层通过 resolve_serial(global_vars) 拿值。
    const selectedDevice = getSelectedDevice(id);
    const global_args = {};
    if (selectedDevice) global_args.device_id = selectedDevice;
    try { cli.sendRun(zip, runId, undefined, global_args); }
    catch (e) { toast(t('toast.sendFail', { msg: e && e.message ? e.message : e })); }
}

async function _loadDtfPyStub() {
  // 走 datamapper 合并出来的自包含 droidtaskflow.py：
  // - 把 decorators/models/dsl/executor/runner/... 合并到单文件
  // - 通过 sys.modules 注册伪子模块，让 main.py 里的
  //   `from droidtaskflow.tool import adb_tool, llm_tool` 也能解析
  // 比 stub 注释强在：main.py 真的能 import 整个运行时并跑到 print
  return generateDroidtaskflowPy();
}

function _bootstrap() {
    initInteractions();
    initBackendsPanel();
    const consolePane = document.getElementById('consolePane');
    if (consolePane) initConsolePanel(consolePane);
    const btnRun = document.getElementById('btnRun');
    if (btnRun) btnRun.onclick = onRunClick;

    // 语言：模块内 _currentLang 已按浏览器语言初始化（defaultLang）。
    // 统一走 setLang → 设置 #btnLang 文本 + html lang + applyLanguage() → 刷新钩子。
    // 渲染刷新钩子避免循环依赖：i18n 只触发，render 在此注册。
    initTooltip();
    initHistory();
    initAutomationPanel();
    onLanguageChange(() => {
        render(true);   // 语言刷新不改变文档内容，跳过 dirty（否则未打开工程被误标，打开时误弹保存）
        renderGlobalVars();
        refreshProjectList();
    });
    setLang(getLang());

    // 自动发现本地后端（fire-and-forget；老用户已有配置会直接跳过）
    autoDiscoverLocalBackends().then((id) => {
      if (id) toast(t('toast.autoConnected'));
    });
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bootstrap);
} else {
    _bootstrap();
}
