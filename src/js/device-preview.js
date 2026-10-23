/* ============================================================
   DEVICE PREVIEW — 后端按需截图 + 本地图片 + 选点器
   ============================================================ */
import { state, toast, getFocus } from './state.js';
import { BackendClient } from './backend-client.js';
import { t, onLanguageChange } from './i18n.js';

const FOLDED_LS_KEY = 'dtf:device_preview_folded';

let _client = null;
let _measureCtx = null;   // 复用同一 canvas ctx 测按钮文本宽（lazy）
let _ocrResults = null;   // 保存最近一次 OCR 结果，横竖屏切换时重绘
let _crop = null;         // 裁剪模式状态 { canvas, mask, drawing, start, current }，null = 未在裁剪
let _suppressNextClick = false;  // 裁剪拖拽结束会触发一次 click，临时屏蔽选点

export function initDevicePreview() {
    // 每次加载/刷新默认折叠（不再读 LS 恢复展开态）
    collapseDevicePreview();
    // header click → toggle fold
    document.getElementById('devicePreviewHeader').addEventListener('click', () => {
        if (state.devicePreview.folded) {
            unfoldDevicePreview();
        } else {
            collapseDevicePreview();
        }
    });
    // 按钮 click handlers（截图 / 上传截图；选点按钮已移除，picker 默认开启，渲染 canvas 时自动 attachPicker）
    document.getElementById('btnDeviceScreenshot').addEventListener('click', onScreenshotClick);
    document.getElementById('btnDeviceOpenImage').addEventListener('click', onOpenImageClick);
    // "清空"已移入"操作"下拉菜单；菜单 dispatcher 统一调用 onClearClick
    _initActionsMenu();
    // OCR / 图像匹配 / 裁剪复制仍在"工具"下拉；syncToolMenuItems 统一管理 disabled 态
    _initToolsMenu();
    // infobar 第一行：点击 X / Y / HEX 复制到剪贴板 + toast 提示
    document.getElementById('devicePreviewInfobar').addEventListener('click', onInfobarClick);
    initWidthResize();
    layoutDeviceButtons();
    _updateStageHints();
    // 语言切换 → 按钮文案 / 空态提示文案变化 → 重新布局 + 更新提示
    onLanguageChange(() => {
        layoutDeviceButtons();
        _updateStageHints();
    });
    // 截图按钮初始 disabled（无选中设备）
    syncScreenshotButton();
    syncActionsMenu();
    syncToolMenuItems();
    // 初始化 infobar 显示（让 UI 跟 state 同步,即便没 picker 历史点也能看到 "—"）
    updateInfobar();

    // 订阅 backend-client 截图事件：找到当前活跃 client（如果有）并注册 handler
    // （多 client 时按需扩展；当前项目单 client 场景下直接从全局抓）
    _tryRegisterClient();
}

export function setActiveSerial(serial) {
    state.devicePreview.serial = serial;
    syncScreenshotButton();
}

// 同步焦点（用于 sidebar / backend-panel 在切换设备时通知 device-preview）
// 第 4 个参数直接用 fallbackSerial 让 getFocus 不依赖 selectedDeviceByBackend 也能
// 算出 deviceReady（向后兼容 device-preview 自己的 state.devicePreview.serial 路径）。
// 这样 device-preview 的 syncScreenshotButton 用 getFocus 的统一判定，
// 跟右上角运行 / 设备操作菜单共享同一份"后端+设备均可用"语义。
function _activeFocus() {
    return getFocus(undefined, _client, undefined, state.devicePreview.serial);
}

export function collapseDevicePreview() {
    document.getElementById('devicePreview').classList.add('device-preview--collapsed');
    state.devicePreview.folded = true;
    localStorage.setItem(FOLDED_LS_KEY, '1');
}

export function unfoldDevicePreview() {
    document.getElementById('devicePreview').classList.remove('device-preview--collapsed');
    state.devicePreview.folded = false;
    localStorage.setItem(FOLDED_LS_KEY, '0');
}

export function isDevicePreviewFolded() {
    return state.devicePreview.folded;
}

// 由 sidebar 选中变化时通知 — 也可由全局 BackendClient 实例直接调用
export function registerClient(client) {
    _client = client;
    _wireClient(client);
    syncToolMenuItems();   // 后端可能就是已连接才注册的，注册后立即刷新工具禁用态
}

// M2: 当 active backend 切换时调用，同步 client 实例
export function setActiveClient(client) {
    _client = client;
    if (client) _wireClient(client);
    syncToolMenuItems();
}

function _tryRegisterClient() {
    // 取全局 backend client（M0/M1 项目通过 backend-panel 创建并暴露在 window 上）
    if (typeof window !== 'undefined' && window.__dtfBackendClient) {
        registerClient(window.__dtfBackendClient);
    }
}

/* 测试钩子：让测试可以直接设置 OCR / 图像匹配结果，验证 refitStage 拖拽时的 toast 行为。
   生产路径不会触发：OCR / 匹配结果只在后端 reply 时由 _drawOCRBoxes / _drawMatchBoxes 设置。 */
export const __test = {
    setOcrResults(results) { _ocrResults = results; },
    setMatchResults(results) { _matchResults = results; },
    get ocrResults() { return _ocrResults; },
    get matchResults() { return _matchResults; },
};

function _wireClient(client) {
    if (!client || typeof client.setDeviceScreenshotHandler !== 'function') return;
    client.setDeviceScreenshotHandler((evt) => {
        state.devicePreview.fetching = false;
        syncSpinner();
        renderStage(evt.blob, evt.width, evt.height);
        syncScreenshotButton();
    });
    client.setDeviceScreenshotErrorHandler((msg) => {
        state.devicePreview.fetching = false;
        syncSpinner();
        showError(msg);
        syncScreenshotButton();
        syncToolMenuItems();
    });
    // M7: 幂等电源开关 reply → applied=true 静默；applied=false 提示"已是目标状态"。
    // 用覆盖式 setDevicePowerHandler（不是 client.on('device_power', ...)）——
    // 后者是 push 模式，多次切换 client 后 listener 累积导致一次 reply 弹多次 toast。
    if (typeof client.setDevicePowerHandler === 'function') {
        client.setDevicePowerHandler((msg) => {
            if (!msg || msg.ok !== true) {
                toast(t('device.powerFail') + (msg && msg.error ? ': ' + msg.error : ''));
                return;
            }
            // applied=false 表示幂等跳过（后端查到屏幕已是目标状态，没按 keyevent）
            if (msg.applied === false) {
                const key = msg.action === 'on' ? 'device.powerAlreadyOn' : 'device.powerAlreadyOff';
                toast(t(key));
            }
            // applied=true 不弹 toast（操作成功，无需打扰）
        });
    }
    // M8: 点击/滑动 reply 错误时 toast 提示（成功静默）。同 power 走 setDeviceActionHandler。
    if (typeof client.setDeviceActionHandler === 'function') {
        client.setDeviceActionHandler((msg) => {
            if (!msg || msg.ok !== true) {
                toast(t('device.actionFail', { msg: msg && msg.error ? msg.error : '' }));
            }
        });
    }
    // client state 变化（disconnected/connecting/connected）时刷新截图按钮 + 工具菜单禁用态
    // 同样用覆盖式 API（on('state', ...) 是 push，多次 _wireClient 会累积 state listener）。
    if (typeof client.setStateHandler === 'function') {
        client.setStateHandler(() => {
            syncScreenshotButton();
            syncToolMenuItems();
            syncActionsMenu();   // 电源开/关依赖 backend connected
        });
    }
}

// --- 内部 helper ---

function syncScreenshotButton() {
    const btn = document.getElementById('btnDeviceScreenshot');
    if (!btn) return;
    // 统一焦点判定：后端+设备均非 null 且均可用 + 无 in-flight 截图请求。
    // 用 fallbackSerial 传 state.devicePreview.serial — device-preview 模块的 selected
    // 路径不依赖 selectedDeviceByBackend（向后兼容）。
    const client = _client || (typeof window !== 'undefined' ? window.__dtfBackendClient : null);
    const f = getFocus(undefined, client, undefined, state.devicePreview.serial);
    const disabled = !f.ready || state.devicePreview.fetching;
    btn.disabled = disabled;
    // stage 空态提示文字：无选中设备 → "请选中一个可用的设备"
    const stage = document.getElementById('devicePreviewStage');
    if (stage) stage.classList.toggle('device-preview__stage--no-device', !f.deviceSerial);
    // 悬浮提示已移除：截图按钮不再挂原生 title / 自定义 tooltip（原两套样式重复且不需要）
}

function syncSpinner() {
    const sp = document.getElementById('devicePreviewSpinner');
    if (!sp) return;
    if (state.devicePreview.fetching) {
        sp.classList.remove('device-preview__spinner--hidden');
    } else {
        sp.classList.add('device-preview__spinner--hidden');
    }
}

function showError(message) {
    // 错误统一走 toast(顶部弹窗自动消失),infobar 只用于 pick/hover 实时坐标,
    // 不再被错误信息覆盖、也不再用 ❌ 等 emoji
    toast(message);
}

function syncActionsMenu() {
    // 操作下拉菜单项的 disabled 态：
    //   clear            — 只需预览图（无图时禁用）
    //   home/menu/back   — 后端 + 设备焦点（keyevent=3/82/4）
    //   tap/swipe        — 后端 + 设备焦点（鼠标录制 → adb input tap/swipe）
    // 设备操作菜单（电源/主页/返回/菜单/点击/滑动/输入）可用条件 = 焦点 ready
    // （后端连接 + 设备在线）。clear 只要求有图。
    const menu = document.getElementById('deviceActionsMenu');
    if (!menu) return;
    const hasImage = !!state.devicePreview.source;
    const client = _client || (typeof window !== 'undefined' ? window.__dtfBackendClient : null);
    const f = getFocus(undefined, client, undefined, state.devicePreview.serial);
    for (const item of menu.querySelectorAll('.device-tools-menu__item')) {
        const action = item.dataset.action;
        if (action === 'clear') {
            item.disabled = !hasImage;
        } else if (action === 'home' || action === 'menu' || action === 'back'
                   || action === 'tap' || action === 'swipe' || action === 'input'
                   || action === 'power-on' || action === 'power-off') {
            item.disabled = !f.ready;
        }
    }
}

function syncToolMenuItems() {
    // 裁剪复制只需预览图；OCR / 图像匹配还需一个已连接且被选中的后端
    // （不依赖设备 serial）。后端未连接时置灰，避免点了才弹"后端未连接"。
    const menu = document.getElementById('deviceToolsMenu');
    if (!menu) return;
    const hasImage = !!state.devicePreview.source;
    const client = _client || (typeof window !== 'undefined' ? window.__dtfBackendClient : null);
    const backendReady = !!(client && client.state === 'connected');
    for (const item of menu.querySelectorAll('.device-tools-menu__item')) {
        if (item.id === 'btnDeviceOCR' || item.dataset.tool === 'image-match') {
            item.disabled = !hasImage || !backendReady;
        } else {
            item.disabled = !hasImage;
        }
    }
}

function onClearClick() {
    _cancelCrop();   // 正在裁剪时清空，先退出并移除监听
    // 清空当前显示的图像、回到空态（保留 serial 让用户能继续截图）
    if (state.devicePreview.blobUrl) {
        URL.revokeObjectURL(state.devicePreview.blobUrl);
    }
    _ocrResults = null;
    _matchResults = null;
    _matchActiveBoxDiv = null;
    _matchActiveBoxData = null;
    state.devicePreview.blobUrl = null;
    state.devicePreview.source = null;
    state.devicePreview.width = 0;
    state.devicePreview.height = 0;
    state.devicePreview.pickedPoint = null;
    state.devicePreview.hoverPoint = null;
    state.devicePreview.inflightSerial = null;
    state.devicePreview.fetching = false;
    state.devicePreview.foregroundApp = '';
    syncSpinner();

    const stage = document.getElementById('devicePreviewStage');
    stage.innerHTML = '';                          // 删 canvas + spinner
    stage.style.height = '';                       // 清 inline height,让 CSS 默认空态高度(512 portrait / 256 landscape)接管
    stage.classList.add('device-preview__stage--empty');

    // 重建 spinner(innerHTML='' 会把 spinner 节点也删掉,之后 syncSpinner() 就
    // 找不到 #devicePreviewSpinner,导致下次点击截图时转圈失效)
    const sp = document.createElement('div');
    sp.id = 'devicePreviewSpinner';
    sp.className = 'device-preview__spinner device-preview__spinner--hidden';
    stage.appendChild(sp);

    // 重建两行 span(直接 bar.textContent 会删掉 devicePreviewInfobarPick/Hover
    // 两个子 div,之后任何 updateInfobar 都因 getElementById 返回 null 失效)
    updateInfobar();
    syncActionsMenu();
    syncToolMenuItems();
}

function onScreenshotClick() {
    const serial = state.devicePreview.serial;
    if (!serial) return;
    if (state.devicePreview.fetching) return;  // 防双击
    // 找 client；按钮 disabled 逻辑保证此时 client.state === 'connected'，
    // 真正失败的请求会让后端通过 setDeviceScreenshotErrorHandler 回报
    const client = _client || (typeof window !== 'undefined' ? window.__dtfBackendClient : null);
    if (!client) return;
    state.devicePreview.source = 'fetching';
    state.devicePreview.fetching = true;
    syncScreenshotButton();
    syncSpinner();
    client.requestDeviceScreenshot(serial);
}

function onOpenImageClick() {
    let input = document.querySelector('input[type="file"][data-dtf-device-image]');
    if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp,image/bmp,image/gif';
        input.style.display = 'none';
        input.setAttribute('data-dtf-device-image', '1');
        input.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) loadFromFile(file);
            input.value = '';  // 允许同文件再选
        });
        document.body.appendChild(input);
    }
    input.click();
}

export function loadFromFile(file) {
    const MAX_BYTES = 20 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
        toast(t('device.imgTooLarge', { mb: (file.size / 1024 / 1024).toFixed(1) }));
        return;
    }
    const reader = new FileReader();
    reader.onload = () => {
        const blob = new Blob([reader.result], { type: file.type });
        const url = URL.createObjectURL(blob);
        if (state.devicePreview.blobUrl) {
            URL.revokeObjectURL(state.devicePreview.blobUrl);
        }
        state.devicePreview.blobUrl = url;
        state.devicePreview.source = 'local';
        state.devicePreview.serial = null;
        state.devicePreview.pickedPoint = null;
        // 探测尺寸 → renderStage
        const probe = new Image();
        probe.onload = () => {
            state.devicePreview.width = probe.naturalWidth;
            state.devicePreview.height = probe.naturalHeight;
            renderStage(blob, probe.naturalWidth, probe.naturalHeight);
        };
        probe.onerror = () => {
            toast(t('device.unsupportedFormat'));
        };
        probe.src = url;
    };
    reader.onerror = () => {
        toast(t('device.fileReadFail'));
    };
    reader.readAsArrayBuffer(file);
}

function renderStage(blob, width, height) {
    _cancelCrop();   // 重新渲染（截图完成/新上传）先退出裁剪
    const stage = document.getElementById('devicePreviewStage');
    stage.innerHTML = '';
    stage.classList.remove('device-preview__stage--empty');
    const { displayW, displayH } = _currentDisplayDims(width, height, stage);
    stage.style.height = displayH + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = width;        // 原生分辨率
    canvas.height = height;
    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = new Image();
    img.onload = () => {
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(blob);
    stage.appendChild(canvas);

    // picker 默认开启 — 渲染图片即挂 click handler,直接点预览画面就选点
    attachPicker(canvas);
    syncActionsMenu();
    syncToolMenuItems();
    removeOCRBoxes();
    _removeMatchBoxes();
    // 显式重置缓存：新图加载后旧 OCR/匹配结果已失效，不重置会被 refitStage 误用
    // （_removeMatchBoxes 已不再隐式清 _matchResults，否则 redraw 路径下次拿不到数据）。
    _ocrResults = null;
    _matchResults = null;

    // 重建 spinner(被 stage.innerHTML='' 清掉了,id/class 不变 syncSpinner 才能继续工作)
    const sp = document.createElement('div');
    sp.id = 'devicePreviewSpinner';
    sp.className = 'device-preview__spinner device-preview__spinner--hidden';
    stage.appendChild(sp);
    syncSpinner();
}

// 计算 stage / canvas display 尺寸。
// 算法统一（portrait / landscape 都一样）：displayW = min(containerWidth, nativeW) 撑满
// stage 宽度且不放大原图，displayH 按比例。landscape 的"特殊"仅在于容器宽度翻倍
// (256→512),所以同一张图 landscape 显示尺寸比 portrait 大。
function _currentDisplayDims(nativeW, nativeH, stage) {
    const containerWidth = stage.clientWidth || 320;
    const displayW = Math.min(containerWidth, nativeW);
    const displayH = Math.round(displayW * (nativeH / nativeW));
    return { displayW, displayH };
}

// 容器宽度变化后重排已有 canvas：不重建（图片 ctx 保留），只改 style。
// stage.clientWidth 跟随容器宽度 → 按当前 stage 宽度等比缩放。
function refitStage() {
    const stage = document.getElementById('devicePreviewStage');
    const canvas = stage && stage.querySelector('canvas');
    if (!canvas) return;
    const { displayW, displayH } = _currentDisplayDims(canvas.width, canvas.height, stage);
    stage.style.height = displayH + 'px';
    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';
    _redrawOCRBoxesIfAny();
    _redrawMatchBoxesIfAny();
}

/* 按钮行：4 个按钮按各自内容宽的比例分配 flex-grow，一起刚好占满整行。
   flex-basis 0 + grow 按占比 → 浏览器自动扣掉 gap/padding 后按比例分完剩余宽。 */
function _btnContentWeight(btn) {
    const text = (btn.textContent || '').trim();
    let w = 0;
    if (_measureCtx && typeof _measureCtx.measureText === 'function') {
        try {
            const font = getComputedStyle(btn).font;
            if (font) _measureCtx.font = font;
            w = _measureCtx.measureText(text).width;
        } catch (_) { w = 0; }
    }
    if (!(w > 0)) {
        // 无真实度量（jsdom / 异常）→ 按字符宽估：CJK≈1、ASCII≈0.6
        for (const ch of text) w += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.6;
    }
    return Math.max(4, w + 2);   // +2 边框宽，保底 4 防 0 权重
}

export function layoutDeviceButtons() {
    const row = document.querySelector('.device-preview__buttons');
    if (!row) return;
    if (!_measureCtx) {
        try { _measureCtx = document.createElement('canvas').getContext('2d'); } catch (_) { _measureCtx = null; }
    }
    const items = Array.from(row.children);   // 3 个 dp-btn + tools 包裹 div
    const weights = items.map(el => {
        // 工具的文案在内层 .dp-btn 上（外层只是定位包裹 div）
        const btn = el.classList.contains('dp-btn') ? el : el.querySelector('.dp-btn');
        return btn ? _btnContentWeight(btn) : 4;
    });
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    items.forEach((el, i) => {
        el.style.flexGrow = (weights[i] / sum).toFixed(4);
        el.style.flexShrink = '0';
        el.style.flexBasis = '0px';
    });
}

// 空态提示文案：stage 的 ::before content 用 CSS 变量，这里按当前语言写入。
// （内容无法用 data-i18n 直接更新，因为伪元素 content 不受其控制）
// 值必须带引号：content 只接受字符串字面量，裸文本会被判为非法 token → none。
function _updateStageHints() {
    const stage = document.getElementById('devicePreviewStage');
    if (!stage) return;
    stage.style.setProperty('--stage-hint', JSON.stringify(t('device.stageEmptyHint')));
    stage.style.setProperty('--stage-hint-no-device', JSON.stringify(t('device.stageNoDeviceHint')));
}

// 标题栏右侧手柄横向拖动调整宽度：min = 默认 = 256，max = 3×256 = 768。不持久化。
const DEVICE_PREVIEW_MIN_W = 256;
const DEVICE_PREVIEW_MAX_W = 768;

function initWidthResize() {
    const root = document.getElementById('devicePreview');
    const handle = document.querySelector('.device-preview__resize');
    if (!root || !handle) return;
    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();   // 不触发 header 的折叠切换
        const startX = e.clientX;
        const startW = root.getBoundingClientRect().width;
        let raf = null;
        const onMove = (ev) => {
            const w = startW + (ev.clientX - startX);
            const clamped = Math.min(DEVICE_PREVIEW_MAX_W, Math.max(DEVICE_PREVIEW_MIN_W, w));
            if (!raf) {
                raf = requestAnimationFrame(() => {
                    raf = null;
                    root.style.width = clamped + 'px';
                    refitStage();
                });
            }
        };
        const onUp = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            // pointerup 后会紧跟一个 click；向左拖过最小宽后松手常落在标题栏主体上，
            // 该 click 目标是 header → 会误触发折叠/展开。这里在捕获阶段拦一次：
            // 只拦截落在 header 内的 click（拖宽松手），其余 click 正常放行。
            const clearSwallow = () => {
                document.removeEventListener('click', swallow, true);
                document.removeEventListener('pointerdown', clearSwallow, true);
            };
            const swallow = (ev) => {
                clearSwallow();
                if (ev.target && ev.target.closest && ev.target.closest('#devicePreviewHeader')) {
                    ev.stopPropagation();
                    ev.preventDefault();
                }
            };
            document.addEventListener('click', swallow, true);
            // 兜底：若 pointerup 后没有 click 跟随（如 pointercancel），在下次 pointerdown 时清掉，
            // 避免误吞后续真正点标题栏的折叠操作
            document.addEventListener('pointerdown', clearSwallow, true);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
    });
    // 手柄自身点击不触发 header 折叠
    handle.addEventListener('click', (e) => e.stopPropagation());
}

// picker 默认开启：渲染 canvas 时直接挂上 click + mousemove + mouseleave + contextmenu
function attachPicker(canvas) {
    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('mousemove', onCanvasMouseMove);
    canvas.addEventListener('mouseleave', onCanvasMouseLeave);
    canvas.addEventListener('contextmenu', onCanvasContextMenu);
}

function detachPicker(canvas) {
    canvas.removeEventListener('click', onCanvasClick);
    canvas.removeEventListener('mousemove', onCanvasMouseMove);
    canvas.removeEventListener('mouseleave', onCanvasMouseLeave);
    canvas.removeEventListener('contextmenu', onCanvasContextMenu);
}

function onCanvasClick(evt) {
    // 裁剪拖拽的 mouseup 会触发一次 click，消费并忽略它，避免误选点
    if (_suppressNextClick) {
        _suppressNextClick = false;
        return;
    }
    const canvas = evt.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((evt.clientX - rect.left) * scaleX);
    const y = Math.round((evt.clientY - rect.top) * scaleY);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let rgb = [0, 0, 0];
    try {
        const data = ctx.getImageData(x, y, 1, 1).data;
        rgb = [data[0], data[1], data[2]];
    } catch (e) {
        return;
    }
    state.devicePreview.pickedPoint = { x, y, rgb };
    drawMarker(canvas, { x, y });
    updateInfobar();
}

function onCanvasMouseMove(evt) {
    const canvas = evt.currentTarget;
    const point = _readPixelAtEvent(canvas, evt);
    if (!point) return;
    state.devicePreview.hoverPoint = point;
    updateInfobar();
    _updateOCRHover(canvas, point, evt);
    _updateMatchHover(canvas, point, evt);
}

function onCanvasMouseLeave() {
    const canvas = document.querySelector('#devicePreviewStage canvas');
    if (state.devicePreview.hoverPoint === null) return;
    state.devicePreview.hoverPoint = null;
    updateInfobar();
    _clearOCRHover(canvas);
    _clearMatchHover(canvas);
}

// ── OCR box hover via canvas coordinates ───────────────────────────

let _ocrActiveBoxDiv = null;
let _ocrActiveBoxData = null;  // {text, cx, cy} 当前命中的 OCR box 数据
let _ocrCtxData = null;        // 右键时对 _ocrActiveBoxData 的快照，菜单点击用它（hover 在移向菜单时会被 mousemove 清掉）
let _ocrCtxMenu = null;        // 右键菜单 DOM

function _updateOCRHover(canvas, point, evt) {
    const boxes = canvas._ocrBoxes;
    const tooltip = canvas._ocrTooltip;
    if (!boxes || !tooltip) return;

    let hit = null;
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (point.x >= b.minX && point.x <= b.maxX && point.y >= b.minY && point.y <= b.maxY) {
            hit = b;
            break;
        }
    }

    // 清除旧高亮
    if (_ocrActiveBoxDiv) {
        _ocrActiveBoxDiv.classList.remove('ocr-box--active');
        _ocrActiveBoxDiv = null;
        _ocrActiveBoxData = null;
    }

    if (hit) {
        // 高亮对应的 box div（overlay 中第 i 个 .ocr-box）
        const overlay = canvas._ocrOverlay;
        const idx = boxes.indexOf(hit);
        const boxDivs = overlay.querySelectorAll('.ocr-box');
        if (boxDivs[idx]) {
            boxDivs[idx].classList.add('ocr-box--active');
            _ocrActiveBoxDiv = boxDivs[idx];
        }
        _ocrActiveBoxData = {
            text: hit.text,
            cx: Math.round((hit.minX + hit.maxX) / 2),
            cy: Math.round((hit.minY + hit.maxY) / 2),
        };
        // tooltip 跟随鼠标，显示在左上方
        tooltip.textContent = hit.text;
        tooltip.classList.add('ocr-box__tooltip--visible');
        tooltip.style.left = (evt.clientX + 12) + 'px';
        tooltip.style.top = (evt.clientY - 24) + 'px';
        canvas.style.cursor = 'crosshair';
    } else {
        tooltip.classList.remove('ocr-box__tooltip--visible');
        canvas.style.cursor = '';
    }
}

function _clearOCRHover(canvas) {
    if (!canvas) return;
    if (_ocrActiveBoxDiv) {
        _ocrActiveBoxDiv.classList.remove('ocr-box--active');
        _ocrActiveBoxDiv = null;
    }
    const tooltip = canvas._ocrTooltip;
    if (tooltip) tooltip.classList.remove('ocr-box__tooltip--visible');
    if (canvas) canvas.style.cursor = '';
}

// ── OCR box 右键菜单 ──────────────────────────────────────────────

function onCanvasContextMenu(evt) {
    // 未命中任何 box → 不拦截，走默认菜单
    if (_ocrActiveBoxData) {
        evt.preventDefault();
        _ocrCtxData = _ocrActiveBoxData;   // 快照：鼠标移向菜单时会清掉 hover，这里先留住
        _showOCRContextMenu(evt.clientX, evt.clientY);
    } else if (_matchActiveBoxData) {
        evt.preventDefault();
        _matchCtxData = _matchActiveBoxData;
        _showMatchContextMenu(evt.clientX, evt.clientY);
    }
}

function _ensureOCRContextMenu() {
    if (_ocrCtxMenu) return _ocrCtxMenu;
    const menu = document.createElement('div');
    menu.className = 'ocr-ctx-menu';
    menu.innerHTML = `
        <div class="ocr-ctx-menu__item" data-act="text">复制文字</div>
        <div class="ocr-ctx-menu__item" data-act="coord">复制中心坐标</div>
    `;
    menu.addEventListener('click', (e) => {
        const item = e.target.closest('.ocr-ctx-menu__item');
        if (!item || !_ocrCtxData) return;
        const act = item.dataset.act;
        if (act === 'text') {
            copyToClipboard(_ocrCtxData.text);
            toast(t('toast.copiedWith', { v: _ocrCtxData.text }));
        } else if (act === 'coord') {
            const coord = `${_ocrCtxData.cx},${_ocrCtxData.cy}`;
            copyToClipboard(coord);
            toast(t('toast.copiedWith', { v: coord }));
        }
        _hideOCRContextMenu();
    });
    document.body.appendChild(menu);
    _ocrCtxMenu = menu;
    return menu;
}

function _showOCRContextMenu(x, y) {
    const menu = _ensureOCRContextMenu();
    menu.hidden = false;
    // 先移到不可见位置测量尺寸
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    menu.style.left = Math.min(Math.max(0, x), Math.max(0, maxX)) + 'px';
    menu.style.top = Math.min(Math.max(0, y), Math.max(0, maxY)) + 'px';
}

function _hideOCRContextMenu() {
    _ocrCtxData = null;
    if (_ocrCtxMenu) _ocrCtxMenu.hidden = true;
}

// ── 图像匹配框 hover / 右键菜单 ───────────────────────────────────
// 与 OCR 框交互一致：悬浮高亮 + 右键复制中心坐标。匹配框没有文字，
// 悬浮 tooltip 显示置信度 score（最多 3 位小数），右键菜单只有复制中心坐标。

let _matchActiveBoxDiv = null;
let _matchActiveBoxData = null;  // {cx, cy} 当前命中的匹配框中心
let _matchCtxData = null;        // 右键时对 _matchActiveBoxData 的快照，菜单点击用它（同上）
let _matchCtxMenu = null;

function _updateMatchHover(canvas, point, evt) {
    const boxes = canvas._matchBoxes;
    const tooltip = canvas._matchTooltip;
    if (!boxes || !tooltip) return;

    // 命中检测：优先取"包含鼠标且中心离鼠标最近"的框。
    // 之前按分数降序取第一个包含点，多个框重叠时总选中高分框——若它中心偏右，
    // 右键复制的就是那个框的中心（x 偏大），而非用户 hover 的物体框。
    let hit = null;
    let bestDist = Infinity;
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (point.x < b.minX || point.x > b.maxX || point.y < b.minY || point.y > b.maxY) continue;
        const d = (point.x - (b.minX + b.maxX) / 2) ** 2 + (point.y - (b.minY + b.maxY) / 2) ** 2;
        if (d < bestDist) {
            bestDist = d;
            hit = b;
        }
    }

    // 清除旧高亮
    if (_matchActiveBoxDiv) {
        _matchActiveBoxDiv.classList.remove('match-box--active');
        _matchActiveBoxDiv = null;
        _matchActiveBoxData = null;
    }

    if (hit) {
        const overlay = canvas._matchOverlay;
        const idx = boxes.indexOf(hit);
        const boxDivs = overlay.querySelectorAll('.match-box');
        if (boxDivs[idx]) {
            boxDivs[idx].classList.add('match-box--active');
            _matchActiveBoxDiv = boxDivs[idx];
        }
        _matchActiveBoxData = {
            cx: Math.round((hit.minX + hit.maxX) / 2),
            cy: Math.round((hit.minY + hit.maxY) / 2),
        };
        // 提示框内容：置信度 score，最多 3 位小数
        tooltip.textContent = `score:${Number(hit.score || 0).toFixed(3)}`;
        tooltip.classList.add('match-box__tooltip--visible');
        tooltip.style.left = (evt.clientX + 12) + 'px';
        tooltip.style.top = (evt.clientY - 24) + 'px';
        canvas.style.cursor = 'crosshair';
    } else {
        tooltip.classList.remove('match-box__tooltip--visible');
        canvas.style.cursor = '';
    }
}

function _clearMatchHover(canvas) {
    if (!canvas) return;
    if (_matchActiveBoxDiv) {
        _matchActiveBoxDiv.classList.remove('match-box--active');
        _matchActiveBoxDiv = null;
        _matchActiveBoxData = null;
    }
    const tooltip = canvas._matchTooltip;
    if (tooltip) tooltip.classList.remove('match-box__tooltip--visible');
    if (canvas) canvas.style.cursor = '';
}

function _ensureMatchContextMenu() {
    if (_matchCtxMenu && document.body.contains(_matchCtxMenu)) return _matchCtxMenu;
    const menu = document.createElement('div');
    menu.className = 'ocr-ctx-menu';
    menu.innerHTML = `
        <div class="ocr-ctx-menu__item" data-act="coord">复制中心坐标</div>
    `;
    menu.addEventListener('click', (e) => {
        const item = e.target.closest('.ocr-ctx-menu__item');
        if (!item || !_matchCtxData) return;
        if (item.dataset.act === 'coord') {
            const coord = `${_matchCtxData.cx},${_matchCtxData.cy}`;
            copyToClipboard(coord);
            toast(t('toast.copiedWith', { v: coord }));
        }
        _hideMatchContextMenu();
    });
    document.body.appendChild(menu);
    _matchCtxMenu = menu;
    return menu;
}

function _showMatchContextMenu(x, y) {
    const menu = _ensureMatchContextMenu();
    menu.hidden = false;
    // 先移到不可见位置测量尺寸
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    menu.style.left = Math.min(Math.max(0, x), Math.max(0, maxX)) + 'px';
    menu.style.top = Math.min(Math.max(0, y), Math.max(0, maxY)) + 'px';
}

function _hideMatchContextMenu() {
    _matchCtxData = null;
    if (_matchCtxMenu) _matchCtxMenu.hidden = true;
}

// 点击空白 / Esc 关闭菜单（OCR + 匹配共用）
document.addEventListener('mousedown', (e) => {
    for (const menu of [_ocrCtxMenu, _matchCtxMenu]) {
        if (!menu || menu.hidden) continue;
        if (menu.contains(e.target)) continue;
        menu.hidden = true;
        if (menu === _ocrCtxMenu) _ocrCtxData = null;
        else _matchCtxData = null;
    }
}, true);
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (_ocrCtxMenu) _ocrCtxMenu.hidden = true;
    if (_matchCtxMenu) _matchCtxMenu.hidden = true;
    _ocrCtxData = null;
    _matchCtxData = null;
});

// 共用：从 mousemove / click event 计算 native 坐标 + RGB（无 ctx / 越界时返回 null）
function _readPixelAtEvent(canvas, evt) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((evt.clientX - rect.left) * scaleX);
    const y = Math.round((evt.clientY - rect.top) * scaleY);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let rgb = [0, 0, 0];
    try {
        const data = ctx.getImageData(x, y, 1, 1).data;
        rgb = [data[0], data[1], data[2]];
    } catch (e) {
        return null;
    }
    return { x, y, rgb };
}

function drawMarker(canvas, point) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!canvas._bgImageData) {
        canvas._bgImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } else {
        ctx.putImageData(canvas._bgImageData, 0, 0);
    }
    // 缩放比：canvas 原生尺寸 / 显示尺寸，lineWidth 需反向缩放才能在屏幕上看起来一致
    const displayW = parseFloat(canvas.style.width) || canvas.getBoundingClientRect().width || canvas.width;
    const scale = canvas.width / displayW;
    const r = Math.max(6, Math.round(canvas.width / 100));
    const { x, y } = point;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(0.5, 2 / scale);  // 屏幕上约 2px
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, Math.round(r * 0.6), 0, 2 * Math.PI);
    ctx.fillStyle = '#e53935';
    ctx.fill();
}

function updateInfobar() {
    _updateRow('devicePreviewInfobarPick', state.devicePreview.pickedPoint);
    _updateRow('devicePreviewInfobarHover', state.devicePreview.hoverPoint);
    _updateAppRow();
}

// 把一行（pick / hover）的三段 span 更新到给定 point；无数据时填 "—"
function _updateRow(rowId, point) {
    const row = document.getElementById(rowId);
    if (!row) return;
    const values = _formatRow(point);
    const spans = row.querySelectorAll('span[data-type]');
    for (const sp of spans) {
        const t = sp.dataset.type;
        const label = t === 'hex' ? 'HEX' : t;
        const v = values[t];
        sp.textContent = `${label}: ${v}`;
    }
}

function _formatRow(point) {
    if (!point) return { x: '—', y: '—', hex: '—' };
    const hex = '#' + point.rgb.map(v => v.toString(16).padStart(2, '0')).join('');
    return { x: String(point.x), y: String(point.y), hex };
}

function _updateAppRow() {
    const row = document.getElementById('devicePreviewInfobarApp');
    if (!row) return;
    const sp = row.querySelector('span[data-type="app"]');
    if (sp) sp.textContent = `app: ${state.devicePreview.foregroundApp || '—'}`;
}

function onInfobarClick(evt) {
    const span = evt.target.closest('span[data-type]');
    if (!span) return;
    const rowId = span.parentElement.id;
    // 选点行 和 app 行都可复制
    if (rowId === 'devicePreviewInfobarApp') {
        const app = state.devicePreview.foregroundApp;
        if (app) { copyToClipboard(app); toast(t('toast.copiedWith', { v: app })); }
        return;
    }
    if (rowId !== 'devicePreviewInfobarPick') return;
    const p = state.devicePreview.pickedPoint;
    if (!p) return;
    const type = span.dataset.type;
    let value;
    if (type === 'x') value = String(p.x);
    else if (type === 'y') value = String(p.y);
    else if (type === 'hex') {
        value = '#' + p.rgb.map(v => v.toString(16).padStart(2, '0')).join('');
    } else return;
    copyToClipboard(value);
    toast(t('toast.copiedWith', { v: value }));
}

async function copyToClipboard(text) {
    // 优先 Clipboard API(HTTPS / localhost / file://);降级到 execCommand
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch (_) { /* fall through */ }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) { /* ignore */ }
    ta.remove();
}

// ── 工具下拉菜单 ────────────────────────────────────────────────────
// "工具"按钮展开一个下拉，容纳更多工具（OCR / 图像匹配 / 裁剪复制...）。
// 以后加工具只需在 HTML 的 #deviceToolsMenu 里加一个 <button data-tool="...">，
// 并在这里的 dispatch 里补一个分支。

function _initToolsMenu() {
    const toolsBtn = document.getElementById('btnDeviceTools');
    const arrow = toolsBtn && toolsBtn.querySelector('.dp-btn__arrow');
    const menu = document.getElementById('deviceToolsMenu');
    if (!toolsBtn || !arrow || !menu) return;

    const setArrow = (open) => { arrow.textContent = open ? '▴' : '▾'; };
    const hide = () => {
        menu.hidden = true;
        toolsBtn.classList.remove('dp-btn--active');
        setArrow(false);
    };
    const toggle = () => {
        const show = menu.hidden;
        menu.hidden = !show;
        toolsBtn.classList.toggle('dp-btn--active', show);
        setArrow(show);
    };

    toolsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle();
    });

    // 菜单项点击：OCR 走原有流程，其余为占位
    menu.addEventListener('click', (e) => {
        const item = e.target.closest('.device-tools-menu__item');
        if (!item || item.disabled) return;
        hide();
        if (item.id === 'btnDeviceOCR') {
            onOCRClick();
        } else if (item.dataset.tool === 'image-match') {
            _startImageMatch();
        } else if (item.dataset.tool === 'crop-copy') {
            _enterCropMode();
        }
    });

    // 点击菜单外部 / Esc 关闭。注意：用 toolsBtn.contains(e.target) 判定"是否点在按钮上"，
    // 不是 e.target === toolsBtn — 按钮内部可能点击的是 span / svg 元素，e.target 不是按钮本身。
    // 旧逻辑"e.target === toolsBtn"会在 mousedown 阶段误判为"点在外部"而 hide()，
    // 随后 click 阶段 toggle() 又展开 → 出现"按下闭合、松开又展开"的闪烁。
    document.addEventListener('mousedown', (e) => {
        if (menu.hidden) return;
        if (menu.contains(e.target) || toolsBtn.contains(e.target)) return;
        hide();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.hidden) hide();
    });
}

// ── 操作下拉菜单 ────────────────────────────────────────────────────

// M7: 幂等电源开关。后端先查屏幕状态再决定是否按 POWER keyevent，返回 {ok, applied}
//   applied=false 表示幂等跳过（已是目标状态），applied=true 表示实际按了 key。
// reply 通过 client.on('device_power', ...) 异步回传，调用方自行监听处理 toast。
function _sendDevicePower(action) {
    const client = _client || (typeof window !== 'undefined' ? window.__dtfBackendClient : null);
    if (!client || client.state !== 'connected') {
        toast(t('device.powerFail') + ': ' + t('device.keyeventFail'));
        return false;
    }
    const serial = state.devicePreview.serial;
    if (!serial) {
        toast(t('device.powerFail') + ': ' + t('device.keyeventFail'));
        return false;
    }
    return client.requestDevicePower(serial, action);
}

// M8: 通用 keyevent 操作（home=3、menu=82、back=4）。通过 BackendClient.requestDeviceKeyevent，
// 未连接 / 缺设备 → 返回 false 让 caller 弹 toast。
function _sendKeyevent(keycode) {
    const client = _client || (typeof window !== 'undefined' ? window.__dtfBackendClient : null);
    if (!client || client.state !== 'connected') return false;
    const serial = state.devicePreview.serial;
    if (!serial) return false;
    return client.requestDeviceKeyevent(serial, keycode);
}

// M8: 返回键 = KEY['BACK']=4
function onBackClick() { return _sendKeyevent(4); }
// M8b: 主页键 = KEY['HOME']=3
function onHomeClick() { return _sendKeyevent(3); }
// M8b: 菜单键 = KEY['MENU']=82
function onMenuClick() { return _sendKeyevent(82); }

// M8: 鼠标录制核心（点击 + 滑动共用）
// 流程：覆盖灰色蒙版 → pointerdown 记起点（同时建起点 + 滑动模式的 end+line）→
//        pointermove 更新预览（swipe）→ pointerup 完成录制、清除蒙版 + 预览元素。
// mode='tap'  → pointerup 立即完成，x=x1, y=y1
// mode='swipe' → pointerup 完成，x1/y1=起按下点，x2/y2=松开点，duration=按下到松开毫秒
//
// 坐标转换：screen 坐标 → stage 内部坐标 → image 原图坐标。
// 屏幕坐标 - stageRect.left = stage 内部 x；再 / stageCanvas.width * image.width = 真实原图 x。
// 超出预览区域：line 端点 + endDot 视觉 clamp 到 stage 边界（线视觉截断），
//   但实际发给后端的坐标**不 clamp**（按用户原话："如果鼠标超出预览区域，
//   则线截断到边框区域，终止预览点也保持在预览区域内，注意线保持连接到终止预览点"
//   ——视觉截断，原值不截）。
//
// 关键 M8b 交互改动：
//   - 不在 mask 一上就创建起 点：起点 + 滑动模式的 end+线都在 pointerdown 时才创建
//     （用户要求"不要在左上角显示一个初始点"）。
//   - 拖到 stage 外：右键 或 Esc → 清除所有预览、退出录制模式（用户要求）。
//   - 操作按钮临时变"取消"，点击同样退出录制（用户要求）。
//   - 线 z-index 比点低，保证点显示在线上（用户要求）。
function _startMouseRecord(mode) {
    const stage = document.getElementById('devicePreviewStage');
    const canvas = stage && stage.querySelector('canvas');
    if (!stage || !canvas) {
        toast(t('device.recordNoPreview'));
        return;
    }
    const stageRect = stage.getBoundingClientRect();
    const cRect = canvas.getBoundingClientRect();
    const imgW = state.devicePreview.width || cRect.width;
    const imgH = state.devicePreview.height || cRect.height;
    if (!imgW || !imgH) {
        toast(t('device.recordNoImageSize'));
        return;
    }

    // 蒙版：覆盖整个 stage（比裁剪复制的 0.55 淡，方便看预览图）
    const mask = document.createElement('div');
    mask.className = 'device-record-mask';
    mask.style.cssText = 'position:absolute;inset:0;z-index:6;cursor:crosshair;';
    stage.appendChild(mask);

    // 预览元素容器：分两层
    //   1) 线层（device-record-overlay-line, z=7）—— 比点层低，line 渲染在下面
    //   2) 点层（device-record-overlay,     z=8）—— 点在 line 上面
    // 两层都在 mask 之上；mask 接管 pointerdown
    const lineLayer = document.createElement('div');
    lineLayer.className = 'device-record-overlay device-record-overlay--line';
    lineLayer.style.cssText = 'position:absolute;inset:0;z-index:7;pointer-events:none;';
    stage.appendChild(lineLayer);
    const overlay = document.createElement('div');
    overlay.className = 'device-record-overlay device-record-overlay--dot';
    overlay.style.cssText = 'position:absolute;inset:0;z-index:8;pointer-events:none;';
    stage.appendChild(overlay);

    // 滑动的 SVG line（先创建空容器，pointerdown 后写入第一个 line 元素）
    let lineSvg = null;

    let startDot = null;     // 起点（pointerdown 才创建）
    let endDot = null;       // 滑动模式终点
    let startX = null, startY = null, startTime = 0;
    let recording = false;   // 是否在拖动中（pointerdown 之后）

    const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const _toImage = (clientX, clientY) => {
        // clientX/Y → stage 内部 → 原图
        const sx = clientX - stageRect.left;
        const sy = clientY - stageRect.top;
        return {
            x: Math.round(sx / cRect.width * imgW),
            y: Math.round(sy / cRect.height * imgH),
        };
    };
    const _placeDot = (dot, clientX, clientY) => {
        // dot 中心对齐到 client 位置；clamp 到 stage 视觉内
        const cx = _clamp(clientX, stageRect.left, stageRect.right);
        const cy = _clamp(clientY, stageRect.top, stageRect.bottom);
        dot.style.left = (cx - stageRect.left) + 'px';
        dot.style.top = (cy - stageRect.top) + 'px';
    };
    const _ensureLine = () => {
        if (lineSvg) return;
        lineSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        lineSvg.setAttribute('class', 'device-record-line');
        lineSvg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;';
        lineLayer.appendChild(lineSvg);
    };
    const _drawLine = (x1, y1, x2, y2) => {
        // 线两端都 clamp 到 stage 视觉内（保持视觉连接）
        const cx1 = _clamp(x1, stageRect.left, stageRect.right);
        const cy1 = _clamp(y1, stageRect.top, stageRect.bottom);
        const cx2 = _clamp(x2, stageRect.left, stageRect.right);
        const cy2 = _clamp(y2, stageRect.top, stageRect.bottom);
        lineSvg.innerHTML = `<line x1="${cx1 - stageRect.left}" y1="${cy1 - stageRect.top}" `
            + `x2="${cx2 - stageRect.left}" y2="${cy2 - stageRect.top}" `
            + 'stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 3" />';
    };

    const _restoreActionsButton = () => {
        const btn = document.getElementById('btnDeviceActions');
        if (btn) {
            const label = btn.querySelector('span[data-i18n]');
            if (label) {
                label.setAttribute('data-i18n', 'device.actions');
                label.textContent = t('device.actions');
            }
        }
        // 同步 syncActionsMenu 重新计算 disabled 态
        syncActionsMenu();
    };

    // 一次性 "操作"→"取消" 按钮的监听：所有取消路径（onCancelClick / RMB / Esc / onUp 正常完成）
    // 都最终走 _cleanup()，abort() 会一次性摘掉 actionsBtn 上的 click 监听，
    // 避免右键 / Esc 取消后留下幽灵 handler、下次点 "操作" 还按取消处理。
    const _cancelAbort = new AbortController();

    const _cleanup = (restoreBtn = true) => {
        try { mask.remove(); } catch (_) {}
        try { lineLayer.remove(); } catch (_) {}
        try { overlay.remove(); } catch (_) {}
        mask.removeEventListener('pointerdown', onDown);
        mask.removeEventListener('contextmenu', onContextMenu);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        document.removeEventListener('keydown', onKeydown, true);
        _cancelAbort.abort();   // 一次性清掉 actionsBtn 上的 click 监听
        canvas.style.cursor = '';
        if (restoreBtn) _restoreActionsButton();
    };

    const onContextMenu = (e) => {
        // 右键 = 取消录制（用户在拖动中可按右键放弃）。仅当已开始 recording 时生效。
        if (!recording) return;
        e.preventDefault();
        e.stopPropagation();
        recording = false;
        toast(t('device.recordCancelled'));
        _cleanup();
    };

    const onKeydown = (e) => {
        // Esc = 取消录制（全局捕获，确保焦点在别处时也生效）
        if (e.key !== 'Escape') return;
        if (!recording) {
            // mask 还没被按下 → 仍处于"进入录制"等用户点击的状态
            // 此时也允许 Esc 退出（无任何预览点 / 线可清，但用户预期是"放弃录制"）
            _cleanup();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        recording = false;
        toast(t('device.recordCancelled'));
        _cleanup();
    };

    const onDown = (e) => {
        // 只响应左键（pointerdown 鼠标录制）；
        // 右键/中键 → onContextMenu 走取消路径
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        startX = e.clientX; startY = e.clientY;
        startTime = performance.now();
        recording = true;
        // 用户要求：起点在按下时才创建（不在左上角预显示）
        startDot = document.createElement('div');
        startDot.className = 'device-record-dot device-record-dot--start';
        overlay.appendChild(startDot);
        _placeDot(startDot, startX, startY);
        if (mode === 'swipe') {
            endDot = document.createElement('div');
            endDot.className = 'device-record-dot device-record-dot--end';
            overlay.appendChild(endDot);
            _placeDot(endDot, startX, startY);
            _ensureLine();
            _drawLine(startX, startY, startX, startY);
        }
    };

    const onMove = (e) => {
        if (!recording) return;        // pointerdown 之前不响应
        if (mode === 'swipe') {
            _placeDot(endDot, e.clientX, e.clientY);
            _drawLine(startX, startY, e.clientX, e.clientY);
        }
    };

    const onUp = (e) => {
        if (!recording) return;        // 屏蔽无效的 pointerup（用户中途按了别键之类）
        recording = false;
        const duration = Math.round(performance.now() - startTime);
        const start = _toImage(startX, startY);
        let result;
        if (mode === 'tap') {
            result = { x: start.x, y: start.y };
        } else {
            const end = _toImage(e.clientX, e.clientY);
            result = { x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration };
        }
        _cleanup();
        const client = _client || (typeof window !== 'undefined' ? window.__dtfBackendClient : null);
        const serial = state.devicePreview.serial;
        if (!client || !serial) return;
        if (mode === 'tap') {
            if (!client.requestDeviceTap(serial, result.x, result.y)) {
                toast(t('device.actionFail'));
            }
        } else {
            if (!client.requestDeviceSwipe(serial, result.x1, result.y1, result.x2, result.y2, result.duration)) {
                toast(t('device.actionFail'));
            }
        }
    };

    mask.addEventListener('pointerdown', onDown);
    mask.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    document.addEventListener('keydown', onKeydown, true);
    // 临时改光标，提示用户进入录制模式
    canvas.style.cursor = 'crosshair';

    // 操作按钮临时变 "取消"（用户要求"操作-点击/滑动 进入录制模式后，
    // 操作按钮暂时变成取消，点击后放弃录制并退出录制"）。
    const actionsBtn = document.getElementById('btnDeviceActions');
    if (actionsBtn) {
        const label = actionsBtn.querySelector('span[data-i18n]');
        if (label) {
            label.setAttribute('data-i18n', 'device.cancel');
            label.textContent = t('device.cancel');
        }
        // 用 AbortController 注册一次性 click 监听（capture 阶段）：
        // _cleanup() 里 abort() 一次性摘掉，无论走 onCancelClick / RMB / Esc / 正常完成。
        actionsBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            recording = false;
            toast(t('device.recordCancelled'));
            _cleanup();
        }, { capture: true, signal: _cancelAbort.signal });
    }
}

// "操作"按钮在 mask 进入录制后临时变"取消"。点"取消" → _startMouseRecord 内部 handler 兜底。
// 这个工具函数给 mask 外的代码提供"主动放弃录制"的入口（例如 syncActionsMenu 在 client
// 状态变化时检测到 mask 还在就跑一次清理）。
function _cancelMouseRecord() {
    const stage = document.getElementById('devicePreviewStage');
    if (!stage) return;
    const mask = stage.querySelector('.device-record-mask');
    if (mask) mask.click();   // 触发 _startMouseRecord 内部的 cancel handler（按右键 / Esc 路径）
}

// M8b: 输入操作（操作 → 输入面板）
// 流程：覆盖一层与点击/滑动相同的灰色蒙版 → 中心显示 textarea + 发送按钮 →
//       用户输入文字后回车或点发送 → 后端 am broadcast ADBKeyboard → 退出。
// 点击蒙版空白（textarea 之外）= 取消输入（与点击/滑动录制"按右键取消"对称）。
function _startInputMode() {
    const stage = document.getElementById('devicePreviewStage');
    const canvas = stage && stage.querySelector('canvas');
    if (!stage || !canvas) {
        toast(t('device.recordNoPreview'));
        return;
    }

    // 同一蒙版样式（视觉上跟点击/滑动录制一致：灰色 + z-index 6）
    const mask = document.createElement('div');
    mask.className = 'device-record-mask';
    mask.style.cssText = 'position:absolute;inset:0;z-index:6;cursor:crosshair;';
    stage.appendChild(mask);

    // 输入面板（z-index 7，蒙版之上）
    const panel = document.createElement('div');
    panel.className = 'device-input-panel';
    panel.innerHTML = `
        <textarea class="device-input-panel__textarea" rows="3"
                  placeholder="${t('device.inputPlaceholder')}"></textarea>
        <div class="device-input-panel__actions">
            <button class="device-input-panel__send dp-btn" data-i18n="device.inputSend">${t('device.inputSend')}</button>
            <button class="device-input-panel__send-enter dp-btn" data-i18n="device.inputSendEnter">${t('device.inputSendEnter')}</button>
        </div>
        <div class="device-input-panel__hint">${t('device.inputNeedAdbKeyboard')}</div>
    `;
    stage.appendChild(panel);

    const ta = panel.querySelector('.device-input-panel__textarea');
    const sendBtn = panel.querySelector('.device-input-panel__send');
    const sendEnterBtn = panel.querySelector('.device-input-panel__send-enter');

    // 关闭整个输入面板。
    // mode='send'      → 发文本
    // mode='sendEnter' → 发文本 + 紧跟 Enter keyevent=66（提交表单 / 触发搜索按钮）
    // mode='cancel'    → 关闭，不发
    const close = (mode) => {
        const text = ta ? ta.value : '';
        const trimmed = text && text.trim();
        try { mask.remove(); } catch (_) {}
        try { panel.remove(); } catch (_) {}
        // 同步 syncActionsMenu 重新计算 disabled 态
        syncActionsMenu();
        if (mode === 'cancel' || !trimmed) return;
        const client = _client || (typeof window !== 'undefined' ? window.__dtfBackendClient : null);
        const serial = state.devicePreview.serial;
        if (!client || !serial) return;
        const sent = client.requestDeviceInputText(serial, text);
        if (!sent) {
            toast(t('device.actionFail'));
            return;
        }
        if (mode === 'sendEnter') {
            // 紧跟 Enter 键（keycode 66）。失败也提示，但面板已关、不阻塞用户。
            client.requestDeviceKeyevent(serial, 66);
            toast(t('device.inputSentEnter'));
        } else {
            toast(t('device.inputSent'));
        }
    };

    // 点击蒙版空白 = 取消（不发送）
    mask.addEventListener('click', (e) => {
        if (e.target === mask) close('cancel');
    });
    // 蒙版右键 = 取消
    mask.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        close('cancel');
    });
    // 发送按钮（只发文本）
    sendBtn.addEventListener('click', () => {
        const text = ta.value;
        if (!text || !text.trim()) {
            toast(t('device.inputEmpty'));
            return;
        }
        close('send');
    });
    // 发送并 Enter（发文本 + Enter key）
    sendEnterBtn.addEventListener('click', () => {
        const text = ta.value;
        if (!text || !text.trim()) {
            toast(t('device.inputEmpty'));
            return;
        }
        close('sendEnter');
    });
    // Enter 发送（不按 Shift+Enter 避免插入换行时被吞）—— 等同于"发送并Enter"，
    // 浏览器原生 textarea 的 Enter 键常用于"提交"，跟"发送并Enter"语义一致。
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendEnterBtn.click();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            close('cancel');
        }
    });
    // 同步 syncActionsMenu 状态（输入操作禁用，避免重复打开）
    syncActionsMenu();
    // 自动 focus
    setTimeout(() => ta.focus(), 0);
}

// "操作"按钮展开一个下拉，容纳清空 / 电源开 / 电源关。
// 以后加操作只需在 HTML 的 #deviceActionsMenu 里加一个 <button data-action="...">，
// 并在这里的 dispatch + syncActionsMenu 加一个分支。

// "操作"按钮展开一个下拉，容纳清空 / 电源开 / 电源关。
// 以后加操作只需在 HTML 的 #deviceActionsMenu 里加一个 <button data-action="...">，
// 并在这里的 dispatch + syncActionsMenu 加一个分支。
// 与"工具"下拉互斥关闭（document mousedown listener 会同时关掉两个）。

function _initActionsMenu() {
    const actionsBtn = document.getElementById('btnDeviceActions');
    const arrow = actionsBtn && actionsBtn.querySelector('.dp-btn__arrow');
    const menu = document.getElementById('deviceActionsMenu');
    if (!actionsBtn || !arrow || !menu) return;

    const setArrow = (open) => { arrow.textContent = open ? '▴' : '▾'; };
    const hide = () => {
        menu.hidden = true;
        actionsBtn.classList.remove('dp-btn--active');
        setArrow(false);
    };
    const toggle = () => {
        const show = menu.hidden;
        menu.hidden = !show;
        actionsBtn.classList.toggle('dp-btn--active', show);
        setArrow(show);
    };

    actionsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle();
    });

    // 菜单项点击 → 清空 / 电源开 / 电源关 / 主页 / 返回 / 菜单 / 点击 / 滑动 / 输入
    // （幂等：后端查屏幕状态再决定是否按 POWER）
    menu.addEventListener('click', (e) => {
        const item = e.target.closest('.device-tools-menu__item');
        if (!item || item.disabled) return;
        hide();
        const action = item.dataset.action;
        if (action === 'clear') {
            onClearClick();
        } else if (action === 'home') {
            onHomeClick();
        } else if (action === 'back') {
            onBackClick();
        } else if (action === 'menu') {
            onMenuClick();
        } else if (action === 'tap') {
            _startMouseRecord('tap');
        } else if (action === 'swipe') {
            _startMouseRecord('swipe');
        } else if (action === 'input') {
            _startInputMode();
        } else if (action === 'power-on') {
            _sendDevicePower('on');
        } else if (action === 'power-off') {
            _sendDevicePower('off');
        }
    });

    // 点击菜单外部 / Esc 关闭。注意：用 actionsBtn.contains(e.target) 判定"是否点在按钮上"，
    // 不是 e.target === actionsBtn — 按钮内部可能点击的是 span / svg 元素，e.target 不是按钮本身。
    // 旧逻辑会在 mousedown 阶段误判为"点在外部"而 hide()，随后 click 阶段 toggle() 又展开。
    document.addEventListener('mousedown', (e) => {
        if (menu.hidden) return;
        if (menu.contains(e.target) || actionsBtn.contains(e.target)) return;
        hide();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.hidden) hide();
    });
}

// ── 裁剪复制 ────────────────────────────────────────────────────────
// 减法方案：主 canvas 原图不动；盖一层独立灰色蒙版，拖拽时用
// destination-out 把框内从蒙版中挖掉（减），露出下面主 canvas 的清晰原图。
// 松开后按原图 1:1 像素复制到剪贴板。

function _enterCropMode() {
    const stage = document.getElementById('devicePreviewStage');
    const canvas = stage && stage.querySelector('canvas');
    if (!canvas || !state.devicePreview.source) {
        toast(t('device.screenshotFirst'));
        return;
    }
    _cancelCrop();  // 防御：若已在裁剪模式则先退出

    // 进入裁剪前一步清除所有框（OCR + 图像匹配），不再临时隐藏——裁剪完成或取消后不恢复
    removeOCRBoxes();
    _removeMatchBoxes();
    _ocrResults = null;          // 显式重置缓存（见 renderStage 同款注释）
    _matchResults = null;

    // 独立灰蒙版层，覆盖在主 canvas 上方（原图 canvas 永不修改）
    const mask = document.createElement('canvas');
    mask.className = 'device-crop-mask';
    mask.width = canvas.width;
    mask.height = canvas.height;
    const canvasRect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    mask.style.cssText =
        `position:absolute;left:${canvasRect.left - stageRect.left}px;` +
        `top:${canvasRect.top - stageRect.top}px;` +
        `width:${canvasRect.width}px;height:${canvasRect.height}px;` +
        `pointer-events:none;z-index:6;`;
    stage.appendChild(mask);

    _crop = { canvas, mask, drawing: false, start: null, current: null };

    // 初始整图变灰
    const mctx = mask.getContext('2d');
    mctx.globalCompositeOperation = 'source-over';
    mctx.fillStyle = 'rgba(0,0,0,0.55)';
    mctx.fillRect(0, 0, mask.width, mask.height);

    // 切走 picker，防止选点/OCR hover 干扰；十字光标
    detachPicker(canvas);
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('mousedown', onCropMouseDown);
    document.addEventListener('mousemove', onCropMouseMove);
    document.addEventListener('mouseup', onCropMouseUp);
    document.addEventListener('keydown', onCropKeydown);
    toast(t('device.cropHint'));
}

function _cancelCrop() {
    _exitCropMode();
}

function _exitCropMode() {
    if (!_crop) return;
    const { canvas, mask } = _crop;
    mask.remove();   // 移除灰蒙版；主 canvas 从未被改，无需恢复
    canvas.style.cursor = '';
    canvas.removeEventListener('mousedown', onCropMouseDown);
    document.removeEventListener('mousemove', onCropMouseMove);
    document.removeEventListener('mouseup', onCropMouseUp);
    document.removeEventListener('keydown', onCropKeydown);
    attachPicker(canvas);   // 重新挂回选点
    _crop = null;
}

function onCropMouseDown(evt) {
    if (!_crop || evt.button !== 0) return;
    evt.preventDefault();
    _crop.drawing = true;
    _crop.start = _clientToNative(_crop.canvas, evt);
    _crop.current = _crop.start;
    _drawCropPreview();
}

function onCropMouseMove(evt) {
    if (!_crop || !_crop.drawing) return;
    _crop.current = _clientToNative(_crop.canvas, evt);
    _drawCropPreview();
}

function onCropMouseUp() {
    if (!_crop || !_crop.drawing) return;
    _crop.drawing = false;
    const { canvas, start, current } = _crop;
    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    const w = Math.abs(current.x - start.x);
    const h = Math.abs(current.y - start.y);

    // 拖拽结束的 mouseup 会紧跟一个 click：屏蔽它，避免误触发选点
    _suppressNextClick = true;
    _exitCropMode();

    if (w < 2 || h < 2) {
        toast(t('device.cropTooSmall'));
        return;
    }
    // 主 canvas 就是原图，直接按原始像素裁剪
    _copyCrop(canvas, { x, y, w, h });
}

function onCropKeydown(evt) {
    if (evt.key === 'Escape') {
        _cancelCrop();
        toast(t('device.cropCancelled'));
    }
}

// 在灰蒙版上重画：全灰 → destination-out 挖掉框内（减法）→ 画边框。
// 只操作蒙版 canvas，主 canvas 像素不动，跟手。
function _drawCropPreview() {
    const { mask, start, current } = _crop;
    const mctx = mask.getContext('2d');
    const w = mask.width, h = mask.height;

    // 先清空蒙版（避免半透明灰层层叠加越拖越深），再盖全灰
    mctx.globalCompositeOperation = 'source-over';
    mctx.clearRect(0, 0, w, h);
    mctx.fillStyle = 'rgba(0,0,0,0.55)';
    mctx.fillRect(0, 0, w, h);

    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    const bw = Math.abs(current.x - start.x);
    const bh = Math.abs(current.y - start.y);

    // 减法：把框内从蒙版中挖掉 → 该区域透明 → 露出主 canvas 清晰原图
    mctx.globalCompositeOperation = 'destination-out';
    mctx.clearRect(x, y, bw, bh);

    // 边框（显示缩放比反向调线宽）
    mctx.globalCompositeOperation = 'source-over';
    const displayW = parseFloat(mask.style.width) || mask.getBoundingClientRect().width || mask.width;
    const scale = mask.width / displayW;
    mctx.strokeStyle = 'rgba(80,70,228,0.9)';
    mctx.lineWidth = Math.max(1, 1 / scale);
    mctx.strokeRect(x + 0.5, y + 0.5, bw, bh);
}

// client 坐标 → canvas 原生像素（1:1），并 clamp 到画布内
function _clientToNative(canvas, evt) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((evt.clientX - rect.left) * scaleX);
    const y = Math.round((evt.clientY - rect.top) * scaleY);
    return {
        x: Math.min(Math.max(x, 0), canvas.width),
        y: Math.min(Math.max(y, 0), canvas.height),
    };
}

// 从 canvas 中按原始像素矩形裁剪 → 复制 PNG 到剪贴板
function _copyCrop(canvas, { x, y, w, h }) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cctx = c.getContext('2d');
    cctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);

    const finish = (blob) => {
        if (!blob) {
            toast(t('device.cropFail'));
            return;
        }
        toast(t('device.copiedImage', { w, h }));
        // 降级兜底：剪贴板不支持图片时改为下载
        if (navigator.clipboard && window.ClipboardItem) {
            navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                .catch(() => _downloadBlob(blob, `crop_${w}x${h}.png`));
        } else {
            _downloadBlob(blob, `crop_${w}x${h}.png`);
        }
    };
    c.toBlob(finish, 'image/png');
}

function _downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── OCR ──────────────────────────────────────────────────────────────

function onOCRClick() {
    if (!state.devicePreview.source || state.devicePreview.fetching) return;
    _showOCRPopup();
}

function _showOCRPopup() {
    const stage = document.getElementById('devicePreviewStage');
    if (!stage) return;
    // 移除已有弹窗
    _removeOCRPopup();

    const overlay = document.createElement('div');
    overlay.className = 'ocr-popup-overlay';
    overlay.innerHTML = `
        <div class="ocr-popup">
            <label class="ocr-popup__label">score: <input type="number" class="ocr-popup__input" min="0.01" max="0.99" step="0.01" value="0.50"></label>
            <div class="ocr-popup__actions">
                <button class="ocr-popup__cancel dp-btn">取消</button>
                <button class="ocr-popup__ok dp-btn" disabled>确定</button>
            </div>
        </div>
    `;
    stage.appendChild(overlay);

    const input = overlay.querySelector('.ocr-popup__input');
    const okBtn = overlay.querySelector('.ocr-popup__ok');
    const cancelBtn = overlay.querySelector('.ocr-popup__cancel');

    function validate() {
        const v = parseFloat(input.value);
        okBtn.disabled = isNaN(v) || v <= 0 || v >= 1;
    }
    input.addEventListener('input', validate);
    validate();

    okBtn.addEventListener('click', () => {
        const score = parseFloat(input.value);
        if (isNaN(score) || score <= 0 || score >= 1) return;
        _removeOCRPopup();
        _startOCR(score);
    });

    cancelBtn.addEventListener('click', () => _removeOCRPopup());

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) _removeOCRPopup();
    });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') _removeOCRPopup();
    });
}

function _removeOCRPopup() {
    const old = document.querySelector('.ocr-popup-overlay');
    if (old) old.remove();
}

function _startOCR(score) {
    const stage = document.getElementById('devicePreviewStage');
    const canvas = stage && stage.querySelector('canvas');
    if (!canvas) return;

    // 先清空图像匹配框（如有），与图像匹配流程先清 OCR 框对称
    _removeMatchBoxes();
    _matchResults = null;        // 显式重置（_removeMatchBoxes 不再隐式清缓存）

    // 从 canvas 导出 base64 PNG
    let pngB64;
    try {
        pngB64 = canvas.toDataURL('image/png').split(',')[1];
    } catch (e) {
        toast(t('device.exportFail'));
        return;
    }

    // 显示 spinner
    state.devicePreview.fetching = true;
    syncSpinner();
    syncToolMenuItems();

    const client = _client || (typeof window !== 'undefined' ? window.__dtfBackendClient : null);
    if (!client || !client._ws || client._ws.readyState !== WebSocket.OPEN) {
        state.devicePreview.fetching = false;
        syncSpinner();
        syncToolMenuItems();
        toast(t('tooltip.backendNotConnected'));
        return;
    }

    // 发送 OCR 请求
    const handler = (evt) => {
        try {
            const msg = JSON.parse(evt.data);
            if (msg.type !== 'device_ocr') return;
            client._ws.removeEventListener('message', handler);
            state.devicePreview.fetching = false;
            syncSpinner();
            syncToolMenuItems();
            if (msg.error) {
                toast(t('device.ocrError', { msg: msg.error }));
                return;
            }
            _drawOCRBoxes(canvas, msg.results || []);
        } catch (_) {}
    };
    client._ws.addEventListener('message', handler);

    client._ws.send(JSON.stringify({
        type: 'device_ocr_req',
        png_b64: pngB64,
        score,
    }));
}

function removeOCRBoxes() {
    const stage = document.getElementById('devicePreviewStage');
    if (!stage) return;
    const canvas = stage.querySelector('canvas');
    if (canvas) {
        canvas._ocrBoxes = null;
        canvas._ocrTooltip = null;
        canvas._ocrOverlay = null;
        canvas.style.cursor = '';
    }
    _ocrActiveBoxDiv = null;
    _ocrActiveBoxData = null;   // 与 _removeMatchBoxes 对称：框清掉后命中数据也要清，否则 stale 的 ocr 数据会在 onCanvasContextMenu 里抢先劫持匹配框右键
    const old = stage.querySelector('.ocr-boxes-overlay');
    if (old) old.remove();
}

function _redrawOCRBoxesIfAny() {
    // 拖拽预览窗宽度时 refitStage 调用本函数 → 重建框以匹配新尺寸。
    // 用 _renderOCRBoxes 静默渲染（不弹 toast），避免每个 RAF tick 都 toast。
    const stage = document.getElementById('devicePreviewStage');
    const canvas = stage && stage.querySelector('canvas');
    if (canvas && _ocrResults) _renderOCRBoxes(canvas, _ocrResults);
}

function _drawOCRBoxes(canvas, results) {
    // 首次绘制（OCR 后端 reply 后）：toast 提示
    removeOCRBoxes();
    if (!results.length) {
        toast(t('device.ocrNoText'));
        return;
    }
    _ocrResults = results;
    _renderOCRBoxes(canvas, results);
    toast(t('device.ocrFound', { n: results.length }));
}

// 实际 DOM 构造（与 toast 解耦，refitStage 拖拽时复用此函数）
function _renderOCRBoxes(canvas, results) {
    removeOCRBoxes();

    const stage = canvas.parentElement;
    const overlay = document.createElement('div');
    overlay.className = 'ocr-boxes-overlay';

    const canvasRect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const offsetX = canvasRect.left - stageRect.left;
    const offsetY = canvasRect.top - stageRect.top;
    const scaleX = canvasRect.width / canvas.width;
    const scaleY = canvasRect.height / canvas.height;

    // 保存 box 数据（原图坐标）供 mousemove 命中检测
    const boxData = [];

    for (const item of results) {
        const box = item.box;
        if (!box || box.length < 4) continue;

        const xs = box.map(p => p[0]);
        const ys = box.map(p => p[1]);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        boxData.push({ minX, maxX, minY, maxY, text: item.text });

        const boxDiv = document.createElement('div');
        boxDiv.className = 'ocr-box';
        boxDiv.style.left = (offsetX + minX * scaleX) + 'px';
        boxDiv.style.top = (offsetY + minY * scaleY) + 'px';
        boxDiv.style.width = ((maxX - minX) * scaleX) + 'px';
        boxDiv.style.height = ((maxY - minY) * scaleY) + 'px';
        overlay.appendChild(boxDiv);
    }

    // 共享 tooltip（跟随鼠标，显示在上方）
    const tooltip = document.createElement('div');
    tooltip.className = 'ocr-box__tooltip';
    overlay.appendChild(tooltip);

    stage.appendChild(overlay);

    // 挂到 canvas 上供 mousemove 使用
    canvas._ocrBoxes = boxData;
    canvas._ocrTooltip = tooltip;
    canvas._ocrOverlay = overlay;
}

// ── 图像匹配 ────────────────────────────────────────────────────────
// 弹窗选模板（复用 image-popup 交互：上传 / 剪贴板）+ 阈值输入；
// 确认后清空 OCR 框、转圈，发 device_imagematch_req（与 OCR 同链路），
// 响应画匹配框 overlay。

function _startImageMatch() {
    const stage = document.getElementById('devicePreviewStage');
    const canvas = stage && stage.querySelector('canvas');
    if (!canvas || !state.devicePreview.source) {
        toast(t('device.screenshotFirst'));
        return;
    }
    if (state.devicePreview.fetching) return;

    let templateData = '';   // 模板图片 data URL
    const overlay = document.createElement('div');
    // --stage 变体：弹窗约束在预览 stage 内部（与 OCR 弹窗一致），而非全屏覆盖
    overlay.className = 'image-popup-overlay image-popup-overlay--stage';
    overlay.tabIndex = -1;

    const popup = document.createElement('div');
    popup.className = 'image-popup';

    // 模板预览区（点击上传 / 从剪贴板读取）
    const preview = document.createElement('div');
    preview.className = 'image-popup__preview image-popup__preview--empty';
    function updatePreview() {
        preview.innerHTML = '';
        preview.className = 'image-popup__preview' + (templateData ? '' : ' image-popup__preview--empty');
        if (templateData) {
            preview.appendChild(Object.assign(document.createElement('img'), { src: templateData }));
        } else {
            preview.textContent = t('device.clickUploadTemplate');
        }
    }
    updatePreview();

    // 统一模板设置：更新预览 + 同步「确定」按钮可用态。
    // 注意 templateData 是 FileReader 异步 onload 里才赋值的，所以必须在这里
    // （onload 内）同步更新按钮；之前挂在 fileInput change 上会在 templateData
    // 还是 '' 时执行，导致确定按钮永远 disabled、点击无反应。
    function setTemplate(dataUrl) {
        templateData = dataUrl;
        updatePreview();
        btnOk.disabled = !dataUrl;
    }

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/webp,image/bmp,image/gif';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => { setTemplate(reader.result); };
        reader.readAsDataURL(file);
    });
    preview.addEventListener('click', () => fileInput.click());

    const btnPaste = document.createElement('button');
    btnPaste.className = 'image-popup__paste';
    btnPaste.textContent = t('device.pasteFromClipboard');
    btnPaste.addEventListener('click', async () => {
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const imgType = item.types.find(t => t.startsWith('image/'));
                if (imgType) {
                    const blob = await item.getType(imgType);
                    const reader = new FileReader();
                    reader.onload = () => { setTemplate(reader.result); };
                    reader.readAsDataURL(blob);
                    return;
                }
            }
            toast(t('device.clipboardNoImage'));
        } catch (e) {
            toast(t('device.clipboardReadFail', { msg: e.message }));
        }
    });

    // 阈值输入
    const thresholdLabel = document.createElement('label');
    thresholdLabel.className = 'ocr-popup__label';
    thresholdLabel.style.marginBottom = '10px';
    thresholdLabel.textContent = 'threshold: ';
    const thresholdInput = document.createElement('input');
    thresholdInput.type = 'number';
    thresholdInput.className = 'ocr-popup__input';
    thresholdInput.min = '0.01';
    thresholdInput.max = '1';
    thresholdInput.step = '0.01';
    thresholdInput.value = '0.8';
    thresholdLabel.appendChild(thresholdInput);

    function close() { overlay.remove(); }

    const actions = document.createElement('div');
    actions.className = 'image-popup__actions';
    const btnCancel = document.createElement('button');
    btnCancel.className = 'image-popup__cancel';
    btnCancel.textContent = t('dialog.cancel');
    btnCancel.addEventListener('click', close);
    const btnOk = document.createElement('button');
    btnOk.className = 'image-popup__ok';
    btnOk.textContent = t('dialog.confirm');
    btnOk.disabled = true;   // 选了模板才可确认
    btnOk.addEventListener('click', () => {
        const threshold = parseFloat(thresholdInput.value);
        if (!templateData || isNaN(threshold) || threshold <= 0 || threshold > 1) {
            toast(t('device.chooseTemplate'));
            return;
        }
        close();
        _runImageMatch(canvas, templateData, threshold);
    });
    actions.append(btnPaste, btnCancel, btnOk);

    popup.append(preview, fileInput, thresholdLabel, actions);
    overlay.appendChild(popup);
    stage.appendChild(overlay);   // 与 OCR 弹窗一致：挂在预览 stage 内部，不覆盖整个 web 界面
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    overlay.focus();
}

function _runImageMatch(canvas, templateData, threshold) {
    // 先清空 OCR 画框（如有）
    removeOCRBoxes();

    // 从 canvas 导出 base64 PNG
    let pngB64;
    try {
        pngB64 = canvas.toDataURL('image/png').split(',')[1];
    } catch (e) {
        toast(t('device.exportFail'));
        return;
    }

    // 转圈
    state.devicePreview.fetching = true;
    syncSpinner();
    syncToolMenuItems();

    const client = _client || (typeof window !== 'undefined' ? window.__dtfBackendClient : null);
    if (!client || !client._ws || client._ws.readyState !== WebSocket.OPEN) {
        state.devicePreview.fetching = false;
        syncSpinner();
        syncToolMenuItems();
        toast(t('tooltip.backendNotConnected'));
        return;
    }

    const handler = (evt) => {
        try {
            const msg = JSON.parse(evt.data);
            if (msg.type !== 'device_imagematch') return;
            client._ws.removeEventListener('message', handler);
            state.devicePreview.fetching = false;
            syncSpinner();
            syncToolMenuItems();
            if (msg.error) {
                toast(t('device.matchError', { msg: msg.error }));
                return;
            }
            _drawMatchBoxes(canvas, msg.results || []);
        } catch (_) {}
    };
    client._ws.addEventListener('message', handler);

    client._ws.send(JSON.stringify({
        type: 'device_imagematch_req',
        png_b64: pngB64,
        template_b64: templateData,
        threshold,
    }));
}

let _matchResults = null;   // 保存最近一次匹配结果，横竖屏切换时重绘

function _removeMatchBoxes() {
    const stage = document.getElementById('devicePreviewStage');
    if (!stage) return;
    const canvas = stage.querySelector('canvas');
    if (canvas) {
        canvas._matchBoxes = null;
        canvas._matchTooltip = null;
        canvas._matchOverlay = null;
        canvas.style.cursor = '';
    }
    _matchActiveBoxDiv = null;
    _matchActiveBoxData = null;
    const old = stage.querySelector('.match-boxes-overlay');
    if (old) old.remove();
    // 注意：不重置 _matchResults 缓存 — _renderMatchBoxes（redraw 路径）会调本函数清 DOM，
    // 但需要 _matchResults 保留才能在 refitStage 后续帧里继续重建框。
    // 缓存清理由 caller 负责：onClearClick（清空预览）/ _runImageMatch（新匹配前）
    // 会显式设 _matchResults = null / 新结果。
}

function _redrawMatchBoxesIfAny() {
    // 拖拽预览窗宽度时 refitStage 调用本函数 → 重建框以匹配新尺寸。
    // 用 _renderMatchBoxes 静默渲染（不弹 toast），避免每个 RAF tick 都 toast。
    const stage = document.getElementById('devicePreviewStage');
    const canvas = stage && stage.querySelector('canvas');
    if (canvas && _matchResults) _renderMatchBoxes(canvas, _matchResults);
}

function _drawMatchBoxes(canvas, results) {
    // 首次绘制（图像匹配后端 reply 后）：toast 提示
    _removeMatchBoxes();
    if (!results.length) {
        toast(t('device.noMatch'));
        return;
    }
    _matchResults = results;
    _renderMatchBoxes(canvas, results);
    toast(t('device.matchFound', { n: results.length }));
}

// 实际 DOM 构造（与 toast 解耦，refitStage 拖拽时复用此函数）
function _renderMatchBoxes(canvas, results) {
    _removeMatchBoxes();

    const stage = canvas.parentElement;
    const overlay = document.createElement('div');
    overlay.className = 'match-boxes-overlay';

    const canvasRect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const offsetX = canvasRect.left - stageRect.left;
    const offsetY = canvasRect.top - stageRect.top;
    const scaleX = canvasRect.width / canvas.width;
    const scaleY = canvasRect.height / canvas.height;

    // 保存 box 数据（原图坐标）供 mousemove 命中检测 + 右键中心点
    const boxData = [];

    for (const item of results) {
        const box = item.box;
        if (!box || box.length < 4) continue;
        const xs = box.map(p => p[0]);
        const ys = box.map(p => p[1]);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        boxData.push({ minX, maxX, minY, maxY, score: item.score });

        const boxDiv = document.createElement('div');
        boxDiv.className = 'match-box';
        boxDiv.style.left = (offsetX + minX * scaleX) + 'px';
        boxDiv.style.top = (offsetY + minY * scaleY) + 'px';
        boxDiv.style.width = ((maxX - minX) * scaleX) + 'px';
        boxDiv.style.height = ((maxY - minY) * scaleY) + 'px';
        overlay.appendChild(boxDiv);
    }

    // 共享 tooltip（跟随鼠标，显示在上方）
    const tooltip = document.createElement('div');
    tooltip.className = 'match-box__tooltip';
    overlay.appendChild(tooltip);

    stage.appendChild(overlay);

    // 挂到 canvas 上供 mousemove / contextmenu 使用
    canvas._matchBoxes = boxData;
    canvas._matchTooltip = tooltip;
    canvas._matchOverlay = overlay;
}