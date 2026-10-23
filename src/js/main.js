/* ============================================================
   DroidTaskFlow — Entry Point
   ============================================================ */
// Fonts: Maple Mono (4 weights of woff2) are self-hosted via /public/fonts/
// and declared with @font-face in src/styles/main.css. Per typography spec §0.1:
//   --font-ui   -> Maple Mono (UI text: buttons, titles, labels, toasts, dialogs)
//   --font-code -> Maple Mono (code preview area; same family, future-proof token)
import { state, toast, getFocus } from './state.js';
import { getDirHandle, getPyodide } from './filesystem.js';
import { initInteractions } from './interactions.js';
import { initPaletteCards } from './task-palette.js';
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
import { disableButtonTabIndex } from './focus-utils.js';

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
    // 统一焦点判定：后端+设备均非 null 且均可用。焦点内任何一个不满足都给出对应 toast 提示。
    const cli = getClientById(getSelectedBackendId());
    const f = getFocus(getSelectedBackendId(), cli);
    if (!f.backendId) { toast(t('toast.selectBackendLeft')); return; }
    if (!f.backendReady) { toast(t('tooltip.backendNotConnected')); return; }
    if (!f.deviceSerial || !f.deviceReady) { toast(t('toast.selectDevice')); return; }
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
    const global_args = { device_id: f.deviceSerial };
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

    // 默认禁用 button 键盘 Tab：除显式声明 tabindex="0" 的 button 外，全部 tabindex=-1。
    // 用户意图：Tab 只在输入框之间切换，不在按钮之间切换。鼠标点击 + Esc 关闭弹框的视觉噪音
    // 也跟着消失（按钮不可达就不会被 focus → 不会显示 focus-visible 焦点环）。
    // 动态新增的 button 也走 MutationObserver 自动加 tabindex=-1（见 focus-utils.js）。
    // 注意：这是 WAI-ARIA 反模式（交互元素应键盘可达），用户明确要求时再开。
    disableButtonTabIndex();

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

    // 卡片定义初始化：先等 pyodide ready（getPyodide 内部已 toast "pyReady"），
    // 再加载 preset + custom 卡片定义并合并到 paletteCards，最后 toast 完成。
    // 此前是 fire-and-forget 在 initInteractions 末尾触发，偶发跟 pyodide 启动 race
    // 导致 preset 加载失败 / 卡片显示未定义。
    (async () => {
        try {
            await getPyodide();
            await initPaletteCards();
        } catch (e) {
            console.warn('initPaletteCards failed:', e);
        }
    })();

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
