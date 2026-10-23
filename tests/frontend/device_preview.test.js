import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state } from '../../src/js/state.js';
import { setLang } from '../../src/js/i18n.js';

// 这些测试断言中文文案（横屏/竖屏/已复制等），锁定语言为中文
setLang('zh');

// mock Image 让 jsdom 不报错（jsdom 不支持 canvas 但 Image 构造是 ok 的）
class FakeImage {
    constructor() {
        setTimeout(() => this.onload && this.onload(), 0);
    }
    set src(_) {}
}
global.Image = FakeImage;

// jsdom canvas getContext('2d') 返回 null — mock 出来让 renderStage 不报错
const fakeCtx = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: [0, 0, 0, 255] })),
    putImageData: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    strokeStyle: '', fillStyle: '', lineWidth: 1,
};
HTMLCanvasElement.prototype.getContext = function() { return fakeCtx; };
// jsdom 未实现 canvas.toDataURL — mock 返回 data URL，让 OCR/图像匹配能走完"导出 PNG → 发请求"流程
HTMLCanvasElement.prototype.toDataURL = function() { return 'data:image/png;base64,QUFBQQ=='; };

// jsdom 没 URL.createObjectURL — mock
if (!global.URL.createObjectURL) {
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-' + Math.random());
}
if (!global.URL.revokeObjectURL) {
    global.URL.revokeObjectURL = vi.fn();
}

describe('device-preview init + fold + buttons', () => {
    beforeEach(() => {
        // 重置 state 关键字段
        state.devicePreview.folded = true;
        state.devicePreview.serial = null;
        document.body.innerHTML = `
            <div id="devicePreview" class="device-preview device-preview--collapsed">
                <div id="devicePreviewHeader"><span class="device-preview__arrow">▲</span></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot" disabled>截图</button>
                    <button id="btnDeviceOpenImage">上传</button>
                    <button id="btnDeviceOCR">OCR</button>
                    <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button><div id="deviceActionsMenu" class="device-tools-menu"><button id="btnDeviceClear" class="device-tools-menu__item" data-action="clear">清空</button></div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty">
                        <div id="devicePreviewSpinner" class="device-preview__spinner device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                        <div id="devicePreviewInfobarHover">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        localStorage.clear();
    });

    it('initDevicePreview keeps default folded when localStorage empty', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        expect(document.getElementById('devicePreview').classList.contains('device-preview--collapsed')).toBe(true);
    });

    it('initDevicePreview 强制默认折叠（即使 LS 里存了 "0" 也不恢复展开）', async () => {
        localStorage.setItem('dtf:device_preview_folded', '0');
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        expect(document.getElementById('devicePreview').classList.contains('device-preview--collapsed')).toBe(true);
    });

    it('initDevicePreview 在 LS 为空时也默认折叠', async () => {
        localStorage.removeItem('dtf:device_preview_folded');
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        expect(document.getElementById('devicePreview').classList.contains('device-preview--collapsed')).toBe(true);
    });

    it('collapseDevicePreview 单调用：把展开态强制折叠', async () => {
        const dp = await import('../../src/js/device-preview.js');
        document.getElementById('devicePreview').classList.remove('device-preview--collapsed');
        state.devicePreview.folded = false;
        dp.collapseDevicePreview();
        expect(document.getElementById('devicePreview').classList.contains('device-preview--collapsed')).toBe(true);
        expect(state.devicePreview.folded).toBe(true);
    });

    it('关闭工程共用逻辑（closeProject，btnCloseProject/btnOpenDir 都用）会触发 collapseDevicePreview', async () => {
        const fs = await import('fs');
        const src = fs.readFileSync('src/js/interactions.js', 'utf8');
        // closeProject() 是关闭按钮 / 工作目录按钮共用的关闭逻辑，必须收起设备预览
        const idx = src.indexOf('async function closeProject()');
        expect(idx).toBeGreaterThan(-1);
        const slice = src.slice(idx, idx + 800);
        expect(slice).toMatch(/collapseDevicePreview\s*\(\s*\)/);
    });

    it('clicking header toggles fold and persists to localStorage', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        document.getElementById('devicePreviewHeader').click();
        expect(document.getElementById('devicePreview').classList.contains('device-preview--collapsed')).toBe(false);
        expect(localStorage.getItem('dtf:device_preview_folded')).toBe('0');
        document.getElementById('devicePreviewHeader').click();
        expect(document.getElementById('devicePreview').classList.contains('device-preview--collapsed')).toBe(true);
        expect(localStorage.getItem('dtf:device_preview_folded')).toBe('1');
    });

    it('setActiveSerial + connected client enables screenshot button', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        dp.registerClient(client);
        dp.initDevicePreview();
        // 无 serial + client → disabled
        expect(document.getElementById('btnDeviceScreenshot').disabled).toBe(true);
        dp.setActiveSerial('S49');
        // 有 serial + connected client → enabled
        expect(document.getElementById('btnDeviceScreenshot').disabled).toBe(false);
        dp.setActiveSerial(null);
        // 没 serial → disabled
        expect(document.getElementById('btnDeviceScreenshot').disabled).toBe(true);
    });

    it('screenshot button stays disabled when client is disconnected (no infobar error)', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'disconnected';
        dp.registerClient(client);
        dp.initDevicePreview();
        dp.setActiveSerial('S49');
        expect(document.getElementById('btnDeviceScreenshot').disabled).toBe(true);
        // 点击不抛错 + 不显示 infobar error
        const infobar = document.getElementById('devicePreviewInfobar');
        const before = infobar.textContent;
        document.getElementById('btnDeviceScreenshot').click();
        expect(infobar.textContent).toBe(before);  // infobar 没被错误信息覆盖
    });

    it('client state 变化触发 syncScreenshotButton', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        dp.registerClient(client);
        dp.initDevicePreview();
        dp.setActiveSerial('S49');
        expect(document.getElementById('btnDeviceScreenshot').disabled).toBe(false);
        // 模拟后端断开
        client._setState('disconnected');
        expect(document.getElementById('btnDeviceScreenshot').disabled).toBe(true);
        // 重连
        client._setState('connected');
        expect(document.getElementById('btnDeviceScreenshot').disabled).toBe(false);
    });

    it('setActiveSerial stores serial in state', async () => {
        // 用 dynamic import 取 state，避免 vi.resetModules 让两个 import 不同实例
        const dp = await import('../../src/js/device-preview.js');
        const { state: sharedState } = await import('../../src/js/state.js');
        dp.initDevicePreview();
        dp.setActiveSerial('S49');
        expect(sharedState.devicePreview.serial).toBe('S49');
    });
});

describe('device-preview renderStage from backend event', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot"></button>
                    <button id="btnDeviceOpenImage"></button>
                    <button id="btnDeviceOCR">OCR</button>
                    <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button><div id="deviceActionsMenu" class="device-tools-menu"><button id="btnDeviceClear" class="device-tools-menu__item" data-action="clear">清空</button></div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty">
                        <div id="devicePreviewSpinner" class="device-preview__spinner device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                        <div id="devicePreviewInfobarHover">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    });

    it('backend-client device_screenshot event renders canvas with correct dimensions', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        dp.registerClient(client);

        const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
        // 通过 _dispatch 触发（绕过 ws）
        client._dispatch({
            type: 'device_screenshot',
            serial: 'S49',
            png_b64: 'iVBORw0KGgo=',  // 实际是 1x1 PNG 字节
            width: 720,
            height: 1280,
        });
        // 等 microtask（blob URL 创建 + img.onload）
        await new Promise(r => setTimeout(r, 30));
        const stage = document.getElementById('devicePreviewStage');
        const canvas = stage.querySelector('canvas');
        expect(canvas).toBeTruthy();
        expect(canvas.width).toBe(720);
        expect(canvas.height).toBe(1280);
        expect(stage.classList.contains('device-preview__stage--empty')).toBe(false);
    });

    it('aspect ratio computed: width=1000, height=2000, containerWidth=320 → displayHeight=640', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        dp.registerClient(client);

        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 320, configurable: true });

        client._dispatch({
            type: 'device_screenshot',
            serial: 'S49',
            png_b64: 'AAAA',
            width: 1000,
            height: 2000,
        });
        await new Promise(r => setTimeout(r, 30));
        expect(stage.style.height).toBe('640px');
    });

    it('screenshot button click calls requestDeviceScreenshot with active serial', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        client._ws = {
            readyState: 1,
            sent: [],
            send(msg) { this.sent.push(JSON.parse(msg)); },
            close() {},
        };
        dp.registerClient(client);
        dp.initDevicePreview();
        dp.setActiveSerial('S49');
        document.getElementById('btnDeviceScreenshot').click();
        expect(client._ws.sent).toContainEqual({ type: 'device_screenshot_req', serial: 'S49' });
    });
});

describe('device-preview picker', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot"></button>
                    <button id="btnDeviceOpenImage"></button>
                    <button id="btnDeviceOCR">OCR</button>
                    <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button><div id="deviceActionsMenu" class="device-tools-menu"><button id="btnDeviceClear" class="device-tools-menu__item" data-action="clear">清空</button></div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty">
                        <div id="devicePreviewSpinner" class="device-preview__spinner device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                        <div id="devicePreviewInfobarHover">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        state.devicePreview.pickedPoint = null;
    });

    it('pickerMode 默认开启（无按钮 toggle）', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        expect(state.devicePreview.pickerMode).toBe(true);
    });

    it('pickAt computes correct coords and reads RGB', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();

        // 用真实 renderStage 流程（dispatch backend event）让 canvas + 自动 attach picker 同时建立
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 500, configurable: true });
        dp.registerClient(client);

        const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
        // 抓到 renderStage 创建的 canvas,挂上 spy
        const realCreate = document.createElement.bind(document);
        document.createElement = (tag) => {
            const el = realCreate(tag);
            if (tag === 'canvas') {
                window.__pickCanvas = el;
            }
            return el;
        };
        client._dispatch({
            type: 'device_screenshot',
            serial: 'S49',
            png_b64: 'iVBORw0KGgo=',
            width: 1000,
            height: 2000,
        });
        await new Promise(r => setTimeout(r, 30));
        document.createElement = realCreate;
        const canvas = window.__pickCanvas;
        delete window.__pickCanvas;
        expect(canvas).toBeTruthy();

        // 直接覆盖 canvas 的 getContext,spy getImageData
        const getImageDataSpy = vi.fn(() => ({ data: [255, 128, 64, 255] }));
        canvas.getContext = () => ({
            drawImage: vi.fn(),
            getImageData: getImageDataSpy,
            putImageData: vi.fn(),
            beginPath: vi.fn(),
            arc: vi.fn(),
            stroke: vi.fn(),
            fill: vi.fn(),
            fillRect: vi.fn(),
            clearRect: vi.fn(),
            strokeStyle: '',
            fillStyle: '',
            lineWidth: 1,
        });
        canvas.getBoundingClientRect = () => ({
            left: 0, top: 0, width: 500, height: 1000, right: 500, bottom: 1000,
        });

        canvas.dispatchEvent(new MouseEvent('click', { clientX: 250, clientY: 500, bubbles: true }));
        expect(state.devicePreview.pickedPoint).toEqual({
            x: 500, y: 1000, rgb: [255, 128, 64],
        });
        expect(getImageDataSpy).toHaveBeenCalledWith(500, 1000, 1, 1);
    });

    it('updateInfobar shows x/y/RGB after pickAt', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();

        const client = new bc.BackendClient({ host: 'h', port: 1 });
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 540, configurable: true });
        dp.registerClient(client);

        let canvas;
        const realCreate = document.createElement.bind(document);
        document.createElement = (tag) => {
            const el = realCreate(tag);
            if (tag === 'canvas') canvas = el;
            return el;
        };
        client._dispatch({
            type: 'device_screenshot',
            serial: 'S49',
            png_b64: 'AAAA',
            width: 1080,
            height: 1920,
        });
        await new Promise(r => setTimeout(r, 30));
        document.createElement = realCreate;
        expect(canvas).toBeTruthy();

        canvas.getContext = () => ({
            drawImage: vi.fn(),
            getImageData: () => ({ data: [255, 128, 64, 255] }),
            putImageData: vi.fn(),
            beginPath: vi.fn(),
            arc: vi.fn(),
            stroke: vi.fn(),
            fill: vi.fn(),
            fillRect: vi.fn(),
            clearRect: vi.fn(),
            strokeStyle: '', fillStyle: '', lineWidth: 1,
        });
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 540, height: 960, right: 540, bottom: 960 });

        canvas.dispatchEvent(new MouseEvent('click', { clientX: 270, clientY: 480, bubbles: true }));
        // 选点行更新；不再含 rgb() 文本,只显示 HEX
        const pick = document.getElementById('devicePreviewInfobarPick').textContent;
        expect(pick).toMatch(/x: 540/);
        expect(pick).toMatch(/y: 960/);
        expect(pick).toMatch(/#ff8040/);
        expect(pick).not.toMatch(/rgb\(/);
        // 实时行(还没 hover)显示 "—"
        const hover = document.getElementById('devicePreviewInfobarHover').textContent;
        expect(hover).toMatch(/x: —/);
    });
});

describe('device-preview infobar hover (实时坐标)', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot"></button>
                    <button id="btnDeviceOpenImage"></button>
                    <button id="btnDeviceOCR">OCR</button>
                    <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button><div id="deviceActionsMenu" class="device-tools-menu"><button id="btnDeviceClear" class="device-tools-menu__item" data-action="clear">清空</button></div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty"></div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                        <div id="devicePreviewInfobarHover">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        state.devicePreview.pickedPoint = null;
        state.devicePreview.hoverPoint = null;
    });

    it('canvas mousemove 更新 hover 行 HEX', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();

        const client = new bc.BackendClient({ host: 'h', port: 1 });
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 500, configurable: true });
        dp.registerClient(client);

        let canvas;
        const realCreate = document.createElement.bind(document);
        document.createElement = (tag) => {
            const el = realCreate(tag);
            if (tag === 'canvas') canvas = el;
            return el;
        };
        client._dispatch({ type: 'device_screenshot', serial: 'S49', png_b64: 'AAAA', width: 1000, height: 2000 });
        await new Promise(r => setTimeout(r, 30));
        document.createElement = realCreate;

        canvas.getContext = () => ({
            drawImage: vi.fn(),
            getImageData: () => ({ data: [255, 128, 64, 255] }),
            putImageData: vi.fn(),
            beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(), fill: vi.fn(),
            fillRect: vi.fn(), clearRect: vi.fn(),
            strokeStyle: '', fillStyle: '', lineWidth: 1,
        });
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 1000, right: 500, bottom: 1000 });

        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 250, clientY: 500, bubbles: true }));
        expect(state.devicePreview.hoverPoint).toEqual({ x: 500, y: 1000, rgb: [255, 128, 64] });
        const hover = document.getElementById('devicePreviewInfobarHover').textContent;
        expect(hover).toMatch(/x: 500/);
        expect(hover).toMatch(/y: 1000/);
        expect(hover).toMatch(/#ff8040/);
    });

    it('canvas mouseleave 清空 hover 行(显示 "—")', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 500, configurable: true });
        dp.registerClient(client);
        let canvas;
        const realCreate = document.createElement.bind(document);
        document.createElement = (tag) => {
            const el = realCreate(tag);
            if (tag === 'canvas') canvas = el;
            return el;
        };
        client._dispatch({ type: 'device_screenshot', serial: 'S49', png_b64: 'AAAA', width: 1000, height: 2000 });
        await new Promise(r => setTimeout(r, 30));
        document.createElement = realCreate;

        canvas.getContext = () => ({
            drawImage: vi.fn(),
            getImageData: () => ({ data: [1, 2, 3, 255] }),
            putImageData: vi.fn(),
            beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(), fill: vi.fn(),
            fillRect: vi.fn(), clearRect: vi.fn(),
            strokeStyle: '', fillStyle: '', lineWidth: 1,
        });
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 1000, right: 500, bottom: 1000 });

        // 先 hover 一次
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 200, bubbles: true }));
        expect(state.devicePreview.hoverPoint).not.toBeNull();
        // 然后 leave
        canvas.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        expect(state.devicePreview.hoverPoint).toBeNull();
        const hover = document.getElementById('devicePreviewInfobarHover').textContent;
        expect(hover).toMatch(/x: —/);
    });
});

describe('device-preview infobar click-to-copy', () => {
    let toastSpy;
    afterEach(() => {
        // 恢复 toast 真实实现,避免污染其他测试
        if (toastSpy) toastSpy.mockRestore();
    });
    beforeEach(async () => {
        // spy toast:避免测试依赖真实 toast DOM(它会被 beforeEach 的 innerHTML 清掉)
        const stateMod = await import('../../src/js/state.js');
        toastSpy = vi.spyOn(stateMod, 'toast').mockImplementation(() => {});

        document.body.innerHTML = `
            <div id="devicePreview">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot"></button>
                    <button id="btnDeviceOpenImage"></button>
                    <button id="btnDeviceOCR">OCR</button>
                    <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button><div id="deviceActionsMenu" class="device-tools-menu"><button id="btnDeviceClear" class="device-tools-menu__item" data-action="clear">清空</button></div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty"></div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                        <div id="devicePreviewInfobarHover">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        // mock navigator.clipboard
        global.navigator.clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
        state.devicePreview.pickedPoint = { x: 540, y: 960, rgb: [255, 128, 64] };
    });

    it('点击 pick 行 X → 复制 X 值 + toast 提示', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        const evt = new MouseEvent('click', { bubbles: true });
        document.querySelector('#devicePreviewInfobarPick span[data-type="x"]').dispatchEvent(evt);
        expect(global.navigator.clipboard.writeText).toHaveBeenCalledWith('540');
        expect(toastSpy).toHaveBeenCalledWith('已复制：540');
    });

    it('点击 pick 行 Y → 复制 Y 值', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        document.querySelector('#devicePreviewInfobarPick span[data-type="y"]').click();
        expect(global.navigator.clipboard.writeText).toHaveBeenCalledWith('960');
        expect(toastSpy).toHaveBeenCalledWith('已复制：960');
    });

    it('点击 pick 行 HEX → 复制 hex 值', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        document.querySelector('#devicePreviewInfobarPick span[data-type="hex"]').click();
        expect(global.navigator.clipboard.writeText).toHaveBeenCalledWith('#ff8040');
        expect(toastSpy).toHaveBeenCalledWith('已复制：#ff8040');
    });

    it('点击 hover 行不触发复制(只有 pick 行可点)', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        document.querySelector('#devicePreviewInfobarHover span[data-type="x"]').click();
        expect(global.navigator.clipboard.writeText).not.toHaveBeenCalled();
        expect(toastSpy).not.toHaveBeenCalled();
    });

    it('选点行为空时点击不复制', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        state.devicePreview.pickedPoint = null;
        document.querySelector('#devicePreviewInfobarPick span[data-type="x"]').click();
        expect(global.navigator.clipboard.writeText).not.toHaveBeenCalled();
        expect(toastSpy).not.toHaveBeenCalled();
    });
});

describe('device-preview CSS rules', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot"></button>
                    <button id="btnDeviceOpenImage"></button>
                    <button id="btnDeviceOCR">OCR</button>
                    <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button><div id="deviceActionsMenu" class="device-tools-menu"><button id="btnDeviceClear" class="device-tools-menu__item" data-action="clear">清空</button></div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty">
                        <div id="devicePreviewSpinner" class="device-preview__spinner device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                        <div id="devicePreviewInfobarHover">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        state.devicePreview.source = null;
        state.devicePreview.pickedPoint = null;
        // FileReader in jsdom — mock
        global.FileReader = class {
            readAsArrayBuffer(file) {
                setTimeout(() => {
                    this.result = file;  // 直接把 File 当 result 用
                    this.onload && this.onload();
                }, 0);
            }
        };
    });

    it('open image click creates a hidden file input', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        document.getElementById('btnDeviceOpenImage').click();
        const fileInput = document.querySelector('input[type="file"][data-dtf-device-image]');
        expect(fileInput).toBeTruthy();
        expect(fileInput.accept).toContain('image/png');
        expect(fileInput.accept).toContain('image/jpeg');
    });

    it('loadFromFile rejects files larger than 20MB', async () => {
        const stateMod = await import('../../src/js/state.js');
        const toastSpy = vi.spyOn(stateMod, 'toast').mockImplementation(() => {});
        try {
            const dp = await import('../../src/js/device-preview.js');
            dp.initDevicePreview();
            const big = new File([new Uint8Array(21 * 1024 * 1024)], 'big.png', { type: 'image/png' });
            dp.loadFromFile(big);
            await new Promise(r => setTimeout(r, 10));
            expect(toastSpy).toHaveBeenCalled();
            expect(toastSpy.mock.calls[0][0]).toMatch(/过大/);
            expect(state.devicePreview.source).toBeNull();
        } finally {
            toastSpy.mockRestore();
        }
    });

    it('loadFromFile sets source to local on success', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        const file = new File([new Uint8Array(100)], 'test.png', { type: 'image/png' });
        dp.loadFromFile(file);
        await new Promise(r => setTimeout(r, 30));
        expect(state.devicePreview.source).toBe('local');
        expect(state.devicePreview.pickedPoint).toBeNull();
    });
});

describe('device-preview stage render', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot"></button>
                    <button id="btnDeviceOpenImage"></button>
                    <button id="btnDeviceOCR">OCR</button>
                    <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button><div id="deviceActionsMenu" class="device-tools-menu"><button id="btnDeviceClear" class="device-tools-menu__item" data-action="clear">清空</button></div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty">
                        <div id="devicePreviewSpinner" class="device-preview__spinner device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                        <div id="devicePreviewInfobarHover">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        state.devicePreview.source = null;
        state.devicePreview.width = 0;
        state.devicePreview.height = 0;
        // 清掉 inflightSerial：后端 _dispatch 在 serial 不匹配时会丢弃截图消息，
        // 若前一个测试遗留非空值，本 describe 的截图会被静默丢弃（偶发 flaky 来源）
        state.devicePreview.inflightSerial = null;
    });

    it('renderStage 默认尺寸：宽度撑满 stage，高度按原图比例', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 320, configurable: true });
        dp.registerClient(client);

        client._dispatch({
            type: 'device_screenshot',
            serial: 'S49',
            png_b64: 'AAAA',
            width: 1000,
            height: 2000,
        });
        await new Promise(r => setTimeout(r, 30));
        // displayH = 320 * (2000/1000) = 640
        expect(stage.style.height).toBe('640px');
    });
});

describe('device-preview 宽度拖拽', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview">
                <div id="devicePreviewHeader">
                    <span class="device-preview__resize"></span>
                </div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot"></button>
                    <button id="btnDeviceOpenImage"></button>
                    <button id="btnDeviceOCR">OCR</button>
                    <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button><div id="deviceActionsMenu" class="device-tools-menu"><button id="btnDeviceClear" class="device-tools-menu__item" data-action="clear">清空</button></div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty">
                        <div id="devicePreviewSpinner" class="device-preview__spinner device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                        <div id="devicePreviewInfobarHover">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    });

    it('拖拽手柄调宽，钳制在 [256, 768]', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        const root = document.getElementById('devicePreview');
        const handle = document.querySelector('.device-preview__resize');
        Object.defineProperty(root, 'getBoundingClientRect', {
            value: () => ({ width: 256, left: 0, right: 256, top: 0, bottom: 28 }),
            configurable: true,
        });
        const ev = (type, opts) => new PointerEvent(type, { bubbles: true, ...opts });
        handle.dispatchEvent(ev('pointerdown', { button: 0, clientX: 100 }));
        document.dispatchEvent(ev('pointermove', { clientX: 200 }));   // +100 → 356
        await new Promise(r => setTimeout(r, 30));                      // flush rAF
        expect(root.style.width).toBe('356px');
        document.dispatchEvent(ev('pointermove', { clientX: 900 }));   // → clamp 768
        await new Promise(r => setTimeout(r, 30));
        expect(root.style.width).toBe('768px');
        document.dispatchEvent(ev('pointermove', { clientX: -500 }));  // → clamp 256
        await new Promise(r => setTimeout(r, 30));
        expect(root.style.width).toBe('256px');
        document.dispatchEvent(ev('pointerup', {}));
    });

    it('点击手柄不触发 header 折叠', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        const handle = document.querySelector('.device-preview__resize');
        const header = document.getElementById('devicePreviewHeader');
        let headerClicked = false;
        header.addEventListener('click', () => { headerClicked = true; });
        handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(headerClicked).toBe(false);
    });

    it('拖宽向左越过最小宽、松手落在标题栏主体上，不触发折叠', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        const root = document.getElementById('devicePreview');
        const handle = document.querySelector('.device-preview__resize');
        const header = document.getElementById('devicePreviewHeader');
        Object.defineProperty(root, 'getBoundingClientRect', {
            value: () => ({ width: 256, left: 0, right: 256, top: 0, bottom: 28 }),
            configurable: true,
        });
        const ev = (type, opts) => new PointerEvent(type, { bubbles: true, ...opts });
        expect(root.classList.contains('device-preview--collapsed')).toBe(true);
        // 拖宽：往左拖到最小宽后继续左移（松手位置落到 header 主体上）
        handle.dispatchEvent(ev('pointerdown', { button: 0, clientX: 100 }));
        document.dispatchEvent(ev('pointermove', { clientX: -500 }));
        await new Promise(r => setTimeout(r, 30));
        document.dispatchEvent(ev('pointerup', {}));
        // 松手后浏览器会给"落在 header 上"的 click —— 手动模拟（bug 场景）
        header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(root.classList.contains('device-preview--collapsed')).toBe(true);
        expect(state.devicePreview.folded).toBe(true);
    });
});

describe('device-preview 按钮行动态布局（按内容宽分配 flex-grow）', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview">
                <div id="devicePreviewHeader"><span class="device-preview__resize"></span></div>
                <div id="devicePreviewBody">
                    <div class="device-preview__buttons">
                        <button id="btnDeviceScreenshot" class="dp-btn">short</button>
                        <button id="btnDeviceOpenImage" class="dp-btn">a-very-long-button-label</button>
                        <button id="btnDeviceClear" class="device-tools-menu__item dp-btn">mid</button>
                        <div class="device-preview__tools">
                            <button id="btnDeviceTools" class="dp-btn">another-mid</button>
                        </div>
                    </div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty">
                        <div id="devicePreviewSpinner" class="device-preview__spinner device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick"><span data-type="x">x: —</span></div>
                        <div id="devicePreviewInfobarHover"><span data-type="x">x: —</span></div>
                    </div>
                </div>
            </div>
        `;
        state.devicePreview.serial = null;
        state.devicePreview.source = null;
        localStorage.clear();
    });

    // jsdom 的 canvas getContext 被 mock 成无 measureText → 走字符宽估测，
    // 比例确定可断言（长文案权重更大）。
    it('flex-grow 按内容长分配：最长文案占比最大', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        const items = document.querySelectorAll('.device-preview__buttons > *');
        expect(items.length).toBe(4);
        const grows = [...items].map(el => parseFloat(el.style.flexGrow));
        for (const g of grows) {
            expect(Number.isFinite(g)).toBe(true);
            expect(g).toBeGreaterThan(0);
        }
        // 文案长：idx1(24) > idx3(11) > idx0(5) > idx2(3) → grow 顺序一致
        expect(grows[1]).toBeGreaterThan(grows[3]);
        expect(grows[3]).toBeGreaterThan(grows[0]);
        expect(grows[0]).toBeGreaterThan(grows[2]);
        // basis 0 + shrink 0 → 整行按 grow 比例分满
        for (const el of items) {
            expect(el.style.flexBasis).toBe('0px');
            expect(el.style.flexShrink).toBe('0');
        }
    });

    it('文案等长后重新布局 → flex-grow 趋同（语言切换钩子生效）', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        const items = document.querySelectorAll('.device-preview__buttons > *');
        for (const el of items) {
            const btn = el.classList.contains('dp-btn') ? el : el.querySelector('.dp-btn');
            btn.textContent = 'same';   // 4 字符，全部等长
        }
        const { applyLanguage } = await import('../../src/js/i18n.js');
        applyLanguage();   // 触发 onLanguageChange → layoutDeviceButtons
        const after = [...items].map(el => parseFloat(el.style.flexGrow));
        expect(after.length).toBe(4);
        for (let i = 1; i < after.length; i++) {
            expect(Math.abs(after[i] - after[0])).toBeLessThan(0.02);
        }
    });
});

describe('device-preview CSS rules', () => {
    it('__buttons has gap > 0 so 截图 / 上传截图 之间留间隔', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        // 抓 .device-preview__buttons { ... } 这一段
        const m = css.match(/\.device-preview__buttons\s*\{([^}]+)\}/);
        expect(m).toBeTruthy();
        expect(m[1]).toMatch(/gap:\s*[1-9]/);  // 任何非零正值
    });

    it('__stage--empty 默认高度 = 2 × 控件宽度 (= 512px)', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        // 抓基础规则:.device-preview__stage--empty { ... }(必须在行首,排除
        // .device-preview--landscape .device-preview__stage--empty 子选择器形式)
        const m = css.match(/^[ \t]*\.device-preview__stage--empty\s*\{([^}]+)\}/m);
        expect(m).toBeTruthy();
        expect(m[1]).toMatch(/height:\s*512px/);
    });

    it('展开后 header 下面两个圆角变直角(衔接 body)', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        // 抓 .device-preview:not(.device-preview--collapsed) .device-preview__header { ... } 这一段
        const m = css.match(
            /\.device-preview:not\(\.device-preview--collapsed\)\s*\.device-preview__header\s*\{([^}]+)\}/
        );
        expect(m).toBeTruthy();
        // 上面两个角是圆角(--r-sm),下面两个角是 0
        expect(m[1]).toMatch(/border-radius:\s*var\(--r-sm\)\s*var\(--r-sm\)\s*0\s*0/);
    });

    it('.canvas-toolbar--row2 自身 pointer-events:none 让中间空白鼠标穿透,子 widget pointer-events:auto 恢复', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        // row2 自身的 pointer-events:none
        const row2 = css.match(/\.canvas-toolbar--row2\s*\{([^}]+)\}/);
        expect(row2).toBeTruthy();
        expect(row2[1]).toMatch(/pointer-events:\s*none/);
        // 子选择器 > * 恢复
        expect(css).toMatch(/\.canvas-toolbar--row2\s*>\s*\*\s*\{[^}]*pointer-events:\s*auto/);
    });

    it('.sidebar__section-body 含 thin 滚动条样式（dark mode 统一）', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        const body = css.match(/\.sidebar__section-body\s*\{([^}]+)\}/);
        expect(body).toBeTruthy();
        expect(body[1]).toMatch(/scrollbar-width:\s*thin/);
        // webkit 滚动条样式要齐全
        expect(css).toMatch(/\.sidebar__section-body::-webkit-scrollbar\s*\{\s*width:\s*5px/);
        expect(css).toMatch(/\.sidebar__section-body::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--border\)/);
    });

    it('.code-preview__body 含 thin 滚动条样式（含横纵 5px）', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        const body = css.match(/\.code-preview__body\s*\{([^}]+)\}/);
        expect(body).toBeTruthy();
        expect(body[1]).toMatch(/scrollbar-width:\s*thin/);
        // 横纵都有（width + height）
        expect(css).toMatch(/\.code-preview__body::-webkit-scrollbar\s*\{\s*width:\s*5px;\s*height:\s*5px/);
        expect(css).toMatch(/\.code-preview__body::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--border\)/);
    });

    it('标题栏含拖宽手柄 .device-preview__resize（cursor: ew-resize）', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        const h = css.match(/\.device-preview__resize\s*\{([^}]+)\}/);
        expect(h).toBeTruthy();
        expect(h[1]).toMatch(/cursor:\s*ew-resize/);
    });

    it('拖宽手柄无 hover 变色示意（去掉背景反馈）', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        expect(css).not.toMatch(/\.device-preview__resize\s*:\s*hover\s*\{/);
    });

    it('4 个按钮不在 HTML 写死 flex（比例由 layoutDeviceButtons 按内容动态分配）', async () => {
        const fs = await import('fs');
        const html = fs.readFileSync('index.html', 'utf8');
        // 三个直接按钮 + tools 包裹 div 都不得内联 flex
        expect(html).not.toMatch(/btnDevice(Screenshot|OpenImage|Clear)[^>]*flex\s*:/);
        expect(html).not.toMatch(/device-preview__tools[^>]*flex\s*:/);
    });

    it('截图按钮不再有悬浮提示（无 data-tooltip、无原生 title 赋值）', async () => {
        const fs = await import('fs');
        const html = fs.readFileSync('index.html', 'utf8');
        expect(html).not.toMatch(/btnDeviceScreenshot[^>]*data-tooltip/);
        const src = fs.readFileSync('src/js/device-preview.js', 'utf8');
        // syncScreenshotButton 不再给 btn.title 赋值（原生 title 会跟自定义 tooltip 双提示）
        const fn = src.slice(src.indexOf('function syncScreenshotButton'), src.indexOf('function syncSpinner'));
        expect(fn).not.toMatch(/\.title\s*=/);
    });

    it('infobar 两行：pick 加粗 (600) + hover 正常 (400)', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        const pick = css.match(/^[ \t]*\.device-preview__infobar-pick\s*\{([^}]+)\}/m);
        expect(pick).toBeTruthy();
        expect(pick[1]).toMatch(/font-weight:\s*600/);
        // hover 有共享块(无 font-weight)+专属块(含 font-weight:400),要取后者
        const hovers = [...css.matchAll(/^[ \t]*\.device-preview__infobar-hover\s*\{([^}]+)\}/gm)];
        const hoverWithWeight = hovers.find(m => /font-weight:\s*400/.test(m[1]));
        expect(hoverWithWeight).toBeTruthy();
        // infobar 父容器是 flex column
        const bar = css.match(/^[ \t]*\.device-preview__infobar\s*\{([^}]+)\}/m);
        expect(bar).toBeTruthy();
        expect(bar[1]).toMatch(/flex-direction:\s*column/);
    });

    it('infobar 三段横轴占比 X:Y:HEX = 1:1:2(HEX 占 2 份)', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        // nth-child(3) 后可能跟逗号(多个 selector 共享一个块),用 [,{] 容错
        const hexPick = css.match(/^[ \t]*\.device-preview__infobar-pick\s*>\s*span:nth-child\(3\)\s*[,{]([^}]+)\}/m);
        expect(hexPick).toBeTruthy();
        expect(hexPick[1]).toMatch(/flex:\s*2/);
        const hexHover = css.match(/^[ \t]*\.device-preview__infobar-hover\s*>\s*span:nth-child\(3\)\s*\{([^}]+)\}/m);
        expect(hexHover).toBeTruthy();
        expect(hexHover[1]).toMatch(/flex:\s*2/);
        // X / Y span 默认 flex:1
        const spanDefault = css.match(/\.device-preview__infobar-(?:pick|hover)\s*>\s*span\s*\{([^}]+)\}/);
        expect(spanDefault).toBeTruthy();
        expect(spanDefault[1]).toMatch(/flex:\s*1\s+1\s+0/);
    });

    it('infobar pick 行 span 可点击(cursor:pointer)', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        const clickable = css.match(/\.device-preview__infobar-pick\s*>\s*span\[data-type\]\s*\{([^}]+)\}/);
        expect(clickable).toBeTruthy();
        expect(clickable[1]).toMatch(/cursor:\s*pointer/);
    });

    it('空态提示走 CSS 变量（不硬编码中文，i18n 键驱动）', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        const before = css.match(/\.device-preview__stage--empty::before\s*\{([^}]+)\}/);
        expect(before).toBeTruthy();
        expect(before[1]).toMatch(/content:\s*var\(--stage-hint\)/);
        // 换行后每行居中：flex justify-content 只居中整块，行内对齐靠 text-align
        expect(before[1]).toMatch(/text-align:\s*center/);
        const noDev = css.match(/\.device-preview__stage--empty\.device-preview__stage--no-device::before\s*\{([^}]+)\}/);
        expect(noDev).toBeTruthy();
        expect(noDev[1]).toMatch(/content:\s*var\(--stage-hint-no-device\)/);
    });

    it('切语言后 stage 的 --stage-hint 更新（伪元素 content 跟随语言）', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const { setLang } = await import('../../src/js/i18n.js');
        dp.initDevicePreview();
        const stage = document.getElementById('devicePreviewStage');
        const hint = () => JSON.parse(stage.style.getPropertyValue('--stage-hint'));
        const noDev = () => JSON.parse(stage.style.getPropertyValue('--stage-hint-no-device'));
        expect(hint()).toMatch(/点击「截图」或「上传截图」加载画面/);
        setLang('en');
        expect(hint()).toMatch(/Click "Screenshot" or "Upload"/);
        expect(noDev()).toMatch(/Select an available device/);
        setLang('zh');
    });

    it('pick 行 span 无 padding(避免第一行比第二行右偏)', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        const clickable = css.match(/\.device-preview__infobar-pick\s*>\s*span\[data-type\]\s*\{([^}]+)\}/);
        expect(clickable).toBeTruthy();
        expect(clickable[1]).not.toMatch(/padding/);
    });
});

describe('device-preview clear button', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot" disabled></button>
                    <button id="btnDeviceOpenImage"></button>
                    <button id="btnDeviceOCR" disabled>OCR</button>
                    <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button><div id="deviceActionsMenu" class="device-tools-menu"><button id="btnDeviceClear" class="device-tools-menu__item" disabled data-action="clear">清空</button></div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty">
                        <div id="devicePreviewSpinner" class="device-preview__spinner device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                        <div id="devicePreviewInfobarHover">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        state.devicePreview.source = null;
        state.devicePreview.serial = null;
        state.devicePreview.blobUrl = null;
        state.devicePreview.width = 0;
        state.devicePreview.height = 0;
        state.devicePreview.pickedPoint = null;
    });

    it('清空按钮初始 disabled（无图）', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        expect(document.getElementById('btnDeviceClear').disabled).toBe(true);
    });

    it('加载图后清空按钮 enabled', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 320, configurable: true });
        dp.registerClient(client);
        client._dispatch({
            type: 'device_screenshot',
            serial: 'S49', png_b64: 'AAAA', width: 1000, height: 2000,
        });
        await new Promise(r => setTimeout(r, 30));
        expect(document.getElementById('btnDeviceClear').disabled).toBe(false);
    });

    it('点击清空：state 清干净, stage 回到空态, infobar 重置', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 320, configurable: true });
        dp.registerClient(client);
        client._dispatch({
            type: 'device_screenshot',
            serial: 'S49', png_b64: 'AAAA', width: 1000, height: 2000,
        });
        await new Promise(r => setTimeout(r, 30));
        // 加载完成,模拟用户选了点
        state.devicePreview.pickedPoint = { x: 100, y: 200, rgb: [255, 0, 0] };
        state.devicePreview.blobUrl = 'blob:mock-test';
        state.devicePreview.width = 1000;
        state.devicePreview.height = 2000;
        document.getElementById('devicePreviewStage').style.height = '640px';

        // 点击清空
        document.getElementById('btnDeviceClear').click();

        expect(state.devicePreview.source).toBeNull();
        expect(state.devicePreview.pickedPoint).toBeNull();
        expect(state.devicePreview.blobUrl).toBeNull();
        expect(state.devicePreview.width).toBe(0);
        expect(state.devicePreview.height).toBe(0);
        // stage 回到空态:canvas 清掉、--empty class 加回、inline height 清掉
        expect(document.getElementById('devicePreviewStage').querySelector('canvas')).toBeNull();
        expect(document.getElementById('devicePreviewStage').classList.contains('device-preview__stage--empty')).toBe(true);
        expect(document.getElementById('devicePreviewStage').style.height).toBe('');
        // infobar 仍是两行结构(选点 + 实时),不是被 textContent 压成单行
        expect(document.getElementById('devicePreviewInfobarPick')).toBeTruthy();
        expect(document.getElementById('devicePreviewInfobarHover')).toBeTruthy();
        expect(document.querySelectorAll('#devicePreviewInfobar > div').length).toBe(2);
        // 按钮重新 disabled
        expect(document.getElementById('btnDeviceClear').disabled).toBe(true);
    });

    it('清空后再次加载图 + 选点 → infobar 两行都更新(不再因结构破坏失效)', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 320, configurable: true });
        dp.registerClient(client);
        // 加载 → 选点
        client._dispatch({ type: 'device_screenshot', serial: 'S49', png_b64: 'AAAA', width: 720, height: 1280 });
        await new Promise(r => setTimeout(r, 30));
        // 清空
        document.getElementById('btnDeviceClear').click();
        // 验证 infobar 仍是两行结构
        expect(document.querySelectorAll('#devicePreviewInfobar > div').length).toBe(2);
        // 再加载 + 模拟 click
        client._dispatch({ type: 'device_screenshot', serial: 'S49', png_b64: 'BBBB', width: 1000, height: 2000 });
        await new Promise(r => setTimeout(r, 30));
        const canvas = stage.querySelector('canvas');
        canvas.getContext = () => ({
            drawImage: vi.fn(),
            getImageData: () => ({ data: [10, 20, 30, 255] }),
            putImageData: vi.fn(),
            beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(), fill: vi.fn(),
            fillRect: vi.fn(), clearRect: vi.fn(),
            strokeStyle: '', fillStyle: '', lineWidth: 1,
        });
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 640, right: 320, bottom: 640 });
        canvas.dispatchEvent(new MouseEvent('click', { clientX: 100, clientY: 200, bubbles: true }));
        // 选点行更新(证明 infobar 结构完好,后续 updateInfobar 仍能工作)
        const pick = document.getElementById('devicePreviewInfobarPick').textContent;
        expect(pick).toMatch(/x: 313/);  // (100/320)*1000 = 312.5 ≈ 313
        expect(pick).toMatch(/#0a141e/);  // rgb(10,20,30)
    });
});

describe('device-preview spinner (waiting for backend)', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot"></button>
                    <button id="btnDeviceOpenImage"></button>
                    <button id="btnDeviceOCR">OCR</button>
                    <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button><div id="deviceActionsMenu" class="device-tools-menu"><button id="btnDeviceClear" class="device-tools-menu__item" data-action="clear">清空</button></div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty">
                        <div id="devicePreviewSpinner" class="device-preview__spinner device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                        <div id="devicePreviewInfobarHover">
                            <span data-type="x">x: —</span>
                            <span data-type="y">y: —</span>
                            <span data-type="hex">HEX: —</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        state.devicePreview.fetching = false;
        state.devicePreview.serial = null;
        state.devicePreview.source = null;
    });

    it('初始 spinner 隐藏（spinner--hidden class 存在）', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        const sp = document.getElementById('devicePreviewSpinner');
        expect(sp.classList.contains('device-preview__spinner--hidden')).toBe(true);
    });

    it('点截图按钮 → spinner 显示（去掉 --hidden class）', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        client._ws = {
            readyState: 1, sent: [],
            send(msg) { this.sent.push(JSON.parse(msg)); },
            close() {},
        };
        dp.registerClient(client);
        dp.initDevicePreview();
        dp.setActiveSerial('S49');
        expect(state.devicePreview.fetching).toBe(false);

        document.getElementById('btnDeviceScreenshot').click();
        expect(state.devicePreview.fetching).toBe(true);
        expect(document.getElementById('devicePreviewSpinner').classList.contains('device-preview__spinner--hidden')).toBe(false);
    });

    it('后端返回 device_screenshot 事件 → spinner 重新隐藏', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        client._ws = {
            readyState: 1, sent: [],
            send(msg) { this.sent.push(JSON.parse(msg)); },
            close() {},
        };
        dp.registerClient(client);
        dp.initDevicePreview();
        dp.setActiveSerial('S49');
        document.getElementById('btnDeviceScreenshot').click();
        expect(document.getElementById('devicePreviewSpinner').classList.contains('device-preview__spinner--hidden')).toBe(false);

        // 后端回应截图
        client._dispatch({
            type: 'device_screenshot',
            serial: 'S49', png_b64: 'AAAA', width: 720, height: 1280,
        });
        await new Promise(r => setTimeout(r, 30));
        expect(state.devicePreview.fetching).toBe(false);
        expect(document.getElementById('devicePreviewSpinner').classList.contains('device-preview__spinner--hidden')).toBe(true);
    });

    it('后端返回错误 → spinner 也重新隐藏', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        client._ws = {
            readyState: 1, sent: [],
            send(msg) { this.sent.push(JSON.parse(msg)); },
            close() {},
        };
        dp.registerClient(client);
        dp.initDevicePreview();
        dp.setActiveSerial('S49');
        document.getElementById('btnDeviceScreenshot').click();
        expect(document.getElementById('devicePreviewSpinner').classList.contains('device-preview__spinner--hidden')).toBe(false);

        client._dispatch({ type: 'error', message: '截图失败' });
        expect(state.devicePreview.fetching).toBe(false);
        expect(document.getElementById('devicePreviewSpinner').classList.contains('device-preview__spinner--hidden')).toBe(true);
    });

    it('CSS spinner 用 btn-spin keyframe 旋转', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        const sp = css.match(/\.device-preview__spinner::after\s*\{([^}]+)\}/);
        expect(sp).toBeTruthy();
        expect(sp[1]).toMatch(/animation:\s*btn-spin/);
    });

    it('点击清空后,再次点击截图 spinner 仍能正常显示(回归测试)', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        client._ws = {
            readyState: 1, sent: [],
            send(msg) { this.sent.push(JSON.parse(msg)); },
            close() {},
        };
        dp.registerClient(client);
        dp.initDevicePreview();
        dp.setActiveSerial('S49');

        // 先加载一张图
        client._dispatch({ type: 'device_screenshot', serial: 'S49', png_b64: 'AAAA', width: 720, height: 1280 });
        await new Promise(r => setTimeout(r, 30));

        // 点击清空 — 这会 stage.innerHTML='' 干掉 spinner 元素
        document.getElementById('btnDeviceClear').click();
        // 关键: spinner 节点必须被重建,否则下次 syncSpinner() 找不到元素
        expect(document.getElementById('devicePreviewSpinner')).not.toBeNull();
        expect(document.getElementById('devicePreviewSpinner').classList.contains('device-preview__spinner--hidden')).toBe(true);

        // 再次点击截图 — spinner 必须显示
        document.getElementById('btnDeviceScreenshot').click();
        expect(state.devicePreview.fetching).toBe(true);
        expect(document.getElementById('devicePreviewSpinner').classList.contains('device-preview__spinner--hidden')).toBe(false);
    });
});

describe('device-preview tools menu (无图时工具置灰)', () => {
    beforeEach(() => {
        state.devicePreview.source = null;
        state.devicePreview.serial = null;
        state.devicePreview.fetching = false;
        state.devicePreview.blobUrl = null;
        state.devicePreview.width = 0;
        state.devicePreview.height = 0;
        document.body.innerHTML = `
            <div id="devicePreview">
                <div id="devicePreviewHeader"><span class="device-preview__arrow">▲</span></div>
                <div id="devicePreviewBody">
                    <div class="device-preview__buttons">
                        <button id="btnDeviceScreenshot" disabled>截图</button>
                        <button id="btnDeviceOpenImage">上传</button>
                        <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button><div id="deviceActionsMenu" class="device-tools-menu"><button id="btnDeviceClear" class="device-tools-menu__item" disabled data-action="clear">清空</button></div>
                        <div class="device-preview__tools">
                            <button id="btnDeviceTools"><span data-i18n="device.tools">工具</span><span class="dp-btn__arrow">▾</span></button>
                            <div id="deviceToolsMenu" hidden>
                                <button class="device-tools-menu__item" data-tool="crop-copy">裁剪复制</button>
                                <button class="device-tools-menu__item" data-tool="image-match">图像匹配</button>
                                <button id="btnDeviceOCR" class="device-tools-menu__item">OCR</button>
                            </div>
                        </div>
                    </div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty">
                        <div id="devicePreviewSpinner" class="device-preview__spinner device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick">
                            <span data-type="x">x: —</span><span data-type="y">y: —</span><span data-type="hex">HEX: —</span>
                        </div>
                        <div id="devicePreviewInfobarHover">
                            <span data-type="x">x: —</span><span data-type="y">y: —</span><span data-type="hex">HEX: —</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        localStorage.clear();
    });

    const allItems = () => [...document.querySelectorAll('#deviceToolsMenu .device-tools-menu__item')];

    it('无图时：裁剪复制/图像匹配/OCR 全部 disabled', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
        const items = allItems();
        expect(items.length).toBe(3);
        for (const item of items) expect(item.disabled).toBe(true);
    });

    it('加载图后：裁剪复制 enabled；OCR/图像匹配需后端已连接（不依赖设备）', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 320, configurable: true });
        dp.registerClient(client);
        client._dispatch({ type: 'device_screenshot', serial: 'S49', png_b64: 'AAAA', width: 1000, height: 2000 });
        await new Promise(r => setTimeout(r, 30));
        // 后端未连接：裁剪复制（有图即可）enabled，OCR/图像匹配 disabled
        const crop = allItems().find(i => i.dataset.tool === 'crop-copy');
        const match = allItems().find(i => i.dataset.tool === 'image-match');
        const ocr = document.getElementById('btnDeviceOCR');
        expect(crop.disabled).toBe(false);
        expect(match.disabled).toBe(true);
        expect(ocr.disabled).toBe(true);
        // 后端连上（state 事件触发同步）→ OCR/图像匹配 enabled
        client._setState('connected');
        expect(match.disabled).toBe(false);
        expect(ocr.disabled).toBe(false);
    });

    it('截图后点清空：三个工具重新 disabled', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 320, configurable: true });
        dp.registerClient(client);
        client._dispatch({ type: 'device_screenshot', serial: 'S49', png_b64: 'AAAA', width: 1000, height: 2000 });
        await new Promise(r => setTimeout(r, 30));
        expect(document.getElementById('btnDeviceClear').disabled).toBe(false);
        document.getElementById('btnDeviceClear').click();
        for (const item of allItems()) expect(item.disabled).toBe(true);
    });

    it('图像匹配弹窗挂在预览 stage 内部（非全屏 body）', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';   // OCR/图像匹配需后端已连接才可点
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 320, configurable: true });
        dp.registerClient(client);
        client._dispatch({ type: 'device_screenshot', serial: 'S49', png_b64: 'AAAA', width: 1000, height: 2000 });
        await new Promise(r => setTimeout(r, 30));

        // 打开工具菜单 → 点图像匹配
        document.getElementById('btnDeviceTools').click();
        const matchItem = document.querySelector('.device-tools-menu__item[data-tool="image-match"]');
        matchItem.click();

        const overlay = document.querySelector('.image-popup-overlay--stage');
        expect(overlay).toBeTruthy();
        // 挂载在 stage 内，而不是全屏覆盖 body
        expect(overlay.parentElement).toBe(stage);
        expect(overlay.classList.contains('image-popup-overlay')).toBe(true);  // 仍复用基础样式
        expect(overlay.querySelector('.image-popup')).toBeTruthy();
    });

    it('图像匹配：选定模板后「确定」按钮才可用（回归：FileReader 异步导致确定永远禁用）', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';   // OCR/图像匹配需后端已连接才可点
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 320, configurable: true });
        dp.registerClient(client);
        client._dispatch({ type: 'device_screenshot', serial: 'S49', png_b64: 'AAAA', width: 1000, height: 2000 });
        await new Promise(r => setTimeout(r, 30));

        document.getElementById('btnDeviceTools').click();
        document.querySelector('.device-tools-menu__item[data-tool="image-match"]').click();

        const overlay = document.querySelector('.image-popup-overlay--stage');
        const okBtn = overlay.querySelector('.image-popup__ok');
        // 未选模板 → 确定禁用
        expect(okBtn.disabled).toBe(true);

        // 模拟选文件：给隐藏 input 塞一个 File 并触发 change（FileReader.onload 异步赋值模板）。
        // jsdom 的 FileReader 缺 readAsDataURL，这里临时补上。
        const origReadAsDataURL = FileReader.prototype.readAsDataURL;
        FileReader.prototype.readAsDataURL = function () {
            this.result = 'data:image/png;base64,QUFBQQ==';
            setTimeout(() => this.onload && this.onload(), 0);
        };
        const input = overlay.querySelector('input[type="file"]');
        const file = new File(['x'], 'tpl.png', { type: 'image/png' });
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 30));
        FileReader.prototype.readAsDataURL = origReadAsDataURL;

        // 模板就绪 → 确定必须可用（回归点：旧逻辑挂在 change 上、onload 后才赋值 → 永远禁用）
        expect(okBtn.disabled).toBe(false);
    });

    it('OCR 弹窗点确定：先清除图像匹配框', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';   // OCR/图像匹配需后端已连接才可点
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 320, configurable: true });
        dp.registerClient(client);
        client._dispatch({ type: 'device_screenshot', serial: 'S49', png_b64: 'AAAA', width: 1000, height: 2000 });
        await new Promise(r => setTimeout(r, 30));

        // 画上图像匹配框 overlay（_removeMatchBoxes 会删 .match-boxes-overlay）
        const matchOverlay = document.createElement('div');
        matchOverlay.className = 'match-boxes-overlay';
        stage.appendChild(matchOverlay);
        expect(stage.querySelector('.match-boxes-overlay')).toBeTruthy();

        // 打开工具菜单 → 点 OCR → 弹窗点确定
        document.getElementById('btnDeviceTools').click();
        document.getElementById('btnDeviceOCR').click();
        const ocrOverlay = stage.querySelector('.ocr-popup-overlay');
        expect(ocrOverlay).toBeTruthy();
        ocrOverlay.querySelector('.ocr-popup__ok').click();

        // 匹配框必须已被清除
        expect(stage.querySelector('.match-boxes-overlay')).toBeNull();
    });

    it('图像匹配框：悬浮高亮 + 右键复制中心坐标（与 OCR 一致）', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';   // OCR/图像匹配需后端已连接才可点
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 320, configurable: true });

        // 假 WS：收到 device_imagematch_req 就回一个匹配结果
        const listeners = { message: [] };
        const ws = {
            readyState: 1,
            sent: [],
            addEventListener(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
            removeEventListener(evt, fn) { listeners[evt] = (listeners[evt] || []).filter(f => f !== fn); },
            send(msg) {
                this.sent.push(JSON.parse(msg));
                const parsed = JSON.parse(msg);
                if (parsed.type === 'device_imagematch_req') {
                    setTimeout(() => {
                        const reply = {
                            type: 'device_imagematch',
                            results: [{ box: [[10,10],[20,10],[20,20],[10,20]], score: 0.7598 }],
                        };
                        (listeners.message || []).forEach(fn => fn({ data: JSON.stringify(reply) }));
                    }, 0);
                }
            },
            close() {},
        };
        client._ws = ws;
        dp.registerClient(client);

        client._dispatch({ type: 'device_screenshot', serial: 'S49', png_b64: 'AAAA', width: 1000, height: 2000 });
        await new Promise(r => setTimeout(r, 30));
        const canvas = stage.querySelector('canvas');

        // mock 几何信息，让坐标换算（1000x2000 → 显示 320x640）可算
        const rect = { left: 0, top: 0, width: 320, height: 640, right: 320, bottom: 640, x: 0, y: 0, toJSON() {} };
        canvas.getBoundingClientRect = () => rect;
        stage.getBoundingClientRect = () => rect;

        // 走图像匹配流程：菜单 → 弹窗 → 选模板 → 确定
        document.getElementById('btnDeviceTools').click();
        document.querySelector('.device-tools-menu__item[data-tool="image-match"]').click();
        const overlay = stage.querySelector('.image-popup-overlay--stage');
        const okBtn = overlay.querySelector('.image-popup__ok');
        const origReadAsDataURL = FileReader.prototype.readAsDataURL;
        FileReader.prototype.readAsDataURL = function () {
            this.result = 'data:image/png;base64,QUFBQQ==';
            setTimeout(() => this.onload && this.onload(), 0);
        };
        const input = overlay.querySelector('input[type="file"]');
        Object.defineProperty(input, 'files', { value: [new File(['x'], 'tpl.png', { type: 'image/png' })], configurable: true });
        input.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 30));
        FileReader.prototype.readAsDataURL = origReadAsDataURL;
        expect(okBtn.disabled).toBe(false);
        okBtn.click();
        await new Promise(r => setTimeout(r, 30));  // 等假 WS 回包 + _drawMatchBoxes

        const matchBoxes = stage.querySelectorAll('.match-box');
        expect(matchBoxes.length).toBe(1);

        // 悬浮命中 → 高亮 + tooltip 显示置信度（最多 3 位小数）
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5, bubbles: true }));
        expect(stage.querySelector('.match-box--active')).toBeTruthy();
        expect(stage.querySelector('.match-box__tooltip').textContent).toBe('score:0.760');

        // 右键 → 拦截默认菜单并弹出匹配框右键菜单
        const ctxEvt = new MouseEvent('contextmenu', { clientX: 5, clientY: 5, bubbles: true, cancelable: true });
        canvas.dispatchEvent(ctxEvt);
        expect(ctxEvt.defaultPrevented).toBe(true);
        const menu = document.querySelector('.ocr-ctx-menu');
        expect(menu).toBeTruthy();
        expect(menu.style.left).not.toBe('-9999px');  // 已定位显示

        // 点「复制中心坐标」→ 菜单关闭（中心 = (15,15)）
        menu.querySelector('[data-act="coord"]').click();
        expect(menu.hidden).toBe(true);
    });

    it('图像匹配：多个重叠框时 hover/右键命中最贴近鼠标的框（不复制到另一个框的中心）', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';   // OCR/图像匹配需后端已连接才可点
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 320, configurable: true });

        const listeners = { message: [] };
        const ws = {
            readyState: 1,
            sent: [],
            addEventListener(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
            removeEventListener(evt, fn) { listeners[evt] = (listeners[evt] || []).filter(f => f !== fn); },
            send(msg) {
                this.sent.push(JSON.parse(msg));
                const parsed = JSON.parse(msg);
                if (parsed.type === 'device_imagematch_req') {
                    setTimeout(() => {
                        const reply = {
                            type: 'device_imagematch',
                            // A 分数更高但中心偏右(150,50)；B 中心在(140,50)，两框重叠
                            results: [
                                { box: [[0,0],[300,0],[300,100],[0,100]], score: 0.95 },
                                { box: [[100,0],[180,0],[180,100],[100,100]], score: 0.85 },
                            ],
                        };
                        (listeners.message || []).forEach(fn => fn({ data: JSON.stringify(reply) }));
                    }, 0);
                }
            },
            close() {},
        };
        client._ws = ws;
        dp.registerClient(client);

        client._dispatch({ type: 'device_screenshot', serial: 'S49', png_b64: 'AAAA', width: 1000, height: 2000 });
        await new Promise(r => setTimeout(r, 30));
        const canvas = stage.querySelector('canvas');
        const rect = { left: 0, top: 0, width: 320, height: 640, right: 320, bottom: 640, x: 0, y: 0, toJSON() {} };
        canvas.getBoundingClientRect = () => rect;
        stage.getBoundingClientRect = () => rect;

        document.getElementById('btnDeviceTools').click();
        document.querySelector('.device-tools-menu__item[data-tool="image-match"]').click();
        const overlay = stage.querySelector('.image-popup-overlay--stage');
        const okBtn = overlay.querySelector('.image-popup__ok');
        const origReadAsDataURL = FileReader.prototype.readAsDataURL;
        FileReader.prototype.readAsDataURL = function () {
            this.result = 'data:image/png;base64,QUFBQQ==';
            setTimeout(() => this.onload && this.onload(), 0);
        };
        const input = overlay.querySelector('input[type="file"]');
        Object.defineProperty(input, 'files', { value: [new File(['x'], 'tpl.png', { type: 'image/png' })], configurable: true });
        input.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 30));
        FileReader.prototype.readAsDataURL = origReadAsDataURL;
        okBtn.click();
        await new Promise(r => setTimeout(r, 30));

        const boxDivs = stage.querySelectorAll('.match-box');
        expect(boxDivs.length).toBe(2);

        // hover 在 B 中心 (140,50) → 屏幕 (140*0.32, 50*0.32) = (44.8, 16)
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 44.8, clientY: 16, bubbles: true }));
        // 旧逻辑会命中 A（分数高、中心偏右），新逻辑应命中中心更近的 B
        expect(boxDivs[1].classList.contains('match-box--active')).toBe(true);
        expect(boxDivs[0].classList.contains('match-box--active')).toBe(false);
    });

    it('裁剪复制：先一步清除 OCR 框和图像匹配框，再进入裁剪', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        dp.initDevicePreview();
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        const stage = document.getElementById('devicePreviewStage');
        Object.defineProperty(stage, 'clientWidth', { value: 320, configurable: true });
        dp.registerClient(client);
        client._dispatch({ type: 'device_screenshot', serial: 'S49', png_b64: 'AAAA', width: 1000, height: 2000 });
        await new Promise(r => setTimeout(r, 30));

        // 画上 OCR 框 + 匹配框 overlay
        const ocrOv = document.createElement('div');
        ocrOv.className = 'ocr-boxes-overlay';
        stage.appendChild(ocrOv);
        const matchOv = document.createElement('div');
        matchOv.className = 'match-boxes-overlay';
        stage.appendChild(matchOv);

        // 打开工具菜单 → 裁剪复制
        document.getElementById('btnDeviceTools').click();
        document.querySelector('.device-tools-menu__item[data-tool="crop-copy"]').click();

        // 两个框都被清除，且进入了裁剪（灰蒙版存在）
        expect(stage.querySelector('.ocr-boxes-overlay')).toBeNull();
        expect(stage.querySelector('.match-boxes-overlay')).toBeNull();
        expect(stage.querySelector('.device-crop-mask')).toBeTruthy();

        // 取消裁剪（Esc），清理状态
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(stage.querySelector('.device-crop-mask')).toBeNull();
    });
});

describe('M7 操作下拉：电源开/关（幂等）', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview" class="device-preview device-preview--collapsed">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <div class="device-preview__buttons">
                        <button id="btnDeviceScreenshot" disabled>截图</button>
                        <button id="btnDeviceOpenImage">上传</button>
                        <div class="device-preview__actions">
                            <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button>
                            <div id="deviceActionsMenu" class="device-tools-menu" hidden>
                                <button id="btnDeviceClear" class="device-tools-menu__item" data-action="clear">清空</button>
                                <button class="device-tools-menu__item" data-action="power-on">电源开</button>
                                <button class="device-tools-menu__item" data-action="power-off">电源关</button>
                            </div>
                        </div>
                    </div>
                    <div id="devicePreviewStage"></div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick"><span data-type="x">x: —</span></div>
                        <div id="devicePreviewInfobarHover"><span data-type="x">x: —</span></div>
                    </div>
                </div>
            </div>
        `;
    });

    async function setupConnectedClient() {
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        client._ws = {
            readyState: 1, sent: [],
            send(msg) { this.sent.push(JSON.parse(msg)); },
            close() {},
        };
        dp.registerClient(client);
        dp.initDevicePreview();
        dp.setActiveSerial('S49');
        return { dp, client };
    }

    function findSent(client, type) {
        return client._ws.sent.find(m => m.type === type);
    }

    it('点电源开 → 发 device_power_req {action:"on"}，不走通用 keyevent', async () => {
        const { client } = await setupConnectedClient();
        // 打开操作菜单
        document.getElementById('btnDeviceActions').click();
        // 点电源开
        document.querySelector('.device-tools-menu__item[data-action="power-on"]').click();

        // 没发 keyevent 通用请求
        expect(findSent(client, 'device_keyevent_req')).toBeUndefined();
        // 发了幂等 power 请求
        const sent = findSent(client, 'device_power_req');
        expect(sent).toBeDefined();
        expect(sent.action).toBe('on');
        expect(sent.serial).toBe('S49');
    });

    it('点电源关 → 发 device_power_req {action:"off"}', async () => {
        const { client } = await setupConnectedClient();
        document.getElementById('btnDeviceActions').click();
        document.querySelector('.device-tools-menu__item[data-action="power-off"]').click();

        const sent = findSent(client, 'device_power_req');
        expect(sent.action).toBe('off');
        expect(sent.serial).toBe('S49');
    });

    it('reply applied=true（按了 key）不弹 toast', async () => {
        const { client } = await setupConnectedClient();
        document.getElementById('btnDeviceActions').click();
        document.querySelector('.device-tools-menu__item[data-action="power-on"]').click();

        // 模拟 reply: applied=true（后端真按了 POWER）
        client._dispatch({ type: 'device_power_req:reply', ok: true, applied: true, action: 'on' });

        // 等待 toast 渲染（如果有）
        await new Promise(r => setTimeout(r, 30));
        // 没 toast 出现
        expect(document.querySelectorAll('.toast').length).toBe(0);
    });

    it('reply applied=false（幂等跳过）→ 调 toast 提示"已是开"（action=on）', async () => {
        const stateMod = await import('../../src/js/state.js');
        const spy = vi.spyOn(stateMod, 'toast');
        try {
            const { client } = await setupConnectedClient();
            document.getElementById('btnDeviceActions').click();
            document.querySelector('.device-tools-menu__item[data-action="power-on"]').click();

            client._dispatch({ type: 'device_power_req:reply', ok: true, applied: false, action: 'on' });

            // 期望 toast 被调用至少一次，且某次参数含"屏幕已亮"
            expect(spy).toHaveBeenCalled();
            const calls = spy.mock.calls.map(c => c[0]);
            expect(calls.some(t => typeof t === 'string' && t.includes('屏幕已亮'))).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });

    it('reply applied=false action=off → 调 toast 提示"已是关"', async () => {
        const stateMod = await import('../../src/js/state.js');
        const spy = vi.spyOn(stateMod, 'toast');
        try {
            const { client } = await setupConnectedClient();
            document.getElementById('btnDeviceActions').click();
            document.querySelector('.device-tools-menu__item[data-action="power-off"]').click();

            client._dispatch({ type: 'device_power_req:reply', ok: true, applied: false, action: 'off' });

            expect(spy).toHaveBeenCalled();
            const calls = spy.mock.calls.map(c => c[0]);
            expect(calls.some(t => typeof t === 'string' && t.includes('屏幕已息'))).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });
});


// ───────────────────────────────────────────────────────────────────────────────
// M8: 操作下拉新增点击/滑动/返回；除清空外都需要后端+设备有效
// ───────────────────────────────────────────────────────────────────────────────

describe('M8 操作：点击/滑动/返回 + M8b：主页/菜单/输入/电源', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview" class="device-preview device-preview--collapsed">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot" disabled></button>
                    <button id="btnDeviceOpenImage">上传</button>
                    <div class="device-preview__actions">
                        <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button>
                        <div id="deviceActionsMenu" class="device-tools-menu" hidden>
                            <button id="btnDeviceClear" class="device-tools-menu__item" data-action="clear" disabled>清空</button>
                            <button class="device-tools-menu__item" data-action="power-on" disabled>电源开</button>
                            <button class="device-tools-menu__item" data-action="power-off" disabled>电源关</button>
                            <button class="device-tools-menu__item" data-action="home" disabled>主页</button>
                            <button class="device-tools-menu__item" data-action="back" disabled>返回</button>
                            <button class="device-tools-menu__item" data-action="menu" disabled>菜单</button>
                            <button class="device-tools-menu__item" data-action="tap" disabled>点击</button>
                            <button class="device-tools-menu__item" data-action="swipe" disabled>滑动</button>
                            <button class="device-tools-menu__item" data-action="input" disabled>输入</button>
                        </div>
                    </div>
                    <div class="device-preview__tools">…</div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty">
                        <canvas></canvas>
                        <div id="devicePreviewSpinner" class="device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick"><span></span></div>
                        <div id="devicePreviewInfobarHover"><span></span></div>
                    </div>
                </div>
            </div>
        `;
    });

    function getAction(action) {
        return document.querySelector(`#deviceActionsMenu [data-action="${action}"]`);
    }

    it('后端未连 + 无设备：所有操作项 disabled，清空也 disabled', async () => {
        state.devicePreview.serial = null;
        state.devicePreview.source = null;
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'disconnected';
        dp.registerClient(client);
        dp.initDevicePreview();

        expect(getAction('clear').disabled).toBe(true);
        expect(getAction('power-on').disabled).toBe(true);
        expect(getAction('power-off').disabled).toBe(true);
        expect(getAction('home').disabled).toBe(true);
        expect(getAction('back').disabled).toBe(true);
        expect(getAction('menu').disabled).toBe(true);
        expect(getAction('tap').disabled).toBe(true);
        expect(getAction('swipe').disabled).toBe(true);
        expect(getAction('input').disabled).toBe(true);
    });

    it('后端已连 + 有设备 + 有图：所有操作项 enabled', async () => {
        state.devicePreview.serial = 'S49';
        state.devicePreview.source = 'backend';
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        dp.registerClient(client);
        dp.initDevicePreview();

        expect(getAction('clear').disabled).toBe(false);
        expect(getAction('power-on').disabled).toBe(false);
        expect(getAction('power-off').disabled).toBe(false);
        expect(getAction('home').disabled).toBe(false);
        expect(getAction('back').disabled).toBe(false);
        expect(getAction('menu').disabled).toBe(false);
        expect(getAction('tap').disabled).toBe(false);
        expect(getAction('swipe').disabled).toBe(false);
        expect(getAction('input').disabled).toBe(false);
    });

    it('后端断了 / 设备掉线：所有非清空项 disabled（清空仍按 hasImage 判断）', async () => {
        // 模拟：之前连上+有图，按钮 enabled；设备掉线 → syncActionsMenu 重新跑 → 操作项 disabled
        state.devicePreview.serial = 'S49';
        state.devicePreview.source = 'backend';
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        dp.registerClient(client);
        dp.initDevicePreview();
        expect(getAction('tap').disabled).toBe(false);

        // 设备掉线（后端还在）
        state.devicePreview.serial = null;
        dp.initDevicePreview();
        expect(getAction('clear').disabled).toBe(false);
        expect(getAction('power-on').disabled).toBe(true);
        expect(getAction('power-off').disabled).toBe(true);
        expect(getAction('home').disabled).toBe(true);
        expect(getAction('back').disabled).toBe(true);
        expect(getAction('menu').disabled).toBe(true);
        expect(getAction('tap').disabled).toBe(true);
        expect(getAction('swipe').disabled).toBe(true);
        expect(getAction('input').disabled).toBe(true);
    });
});

describe('M8b 操作：菜单顺序', () => {
    it('操作下拉菜单项按指定顺序排列：清空→电源开→电源关→主页→返回→菜单→点击→滑动→输入', async () => {
        document.body.innerHTML = `
            <div id="devicePreview" class="device-preview">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot"></button>
                    <button id="btnDeviceOpenImage"></button>
                    <div class="device-preview__actions">
                        <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button>
                        <div id="deviceActionsMenu" class="device-tools-menu" hidden>
                            <button id="btnDeviceClear" class="device-tools-menu__item" data-action="clear" disabled>清空</button>
                            <button class="device-tools-menu__item" data-action="power-on" disabled>电源开</button>
                            <button class="device-tools-menu__item" data-action="power-off" disabled>电源关</button>
                            <button class="device-tools-menu__item" data-action="home" disabled>主页</button>
                            <button class="device-tools-menu__item" data-action="back" disabled>返回</button>
                            <button class="device-tools-menu__item" data-action="menu" disabled>菜单</button>
                            <button class="device-tools-menu__item" data-action="tap" disabled>点击</button>
                            <button class="device-tools-menu__item" data-action="swipe" disabled>滑动</button>
                            <button class="device-tools-menu__item" data-action="input" disabled>输入</button>
                        </div>
                    </div>
                    <div class="device-preview__tools">…</div>
                    <div id="devicePreviewStage"><canvas></canvas></div>
                </div>
            </div>
        `;
        const items = document.querySelectorAll('#deviceActionsMenu [data-action]');
        const order = Array.from(items).map(el => el.dataset.action);
        expect(order).toEqual([
            'clear', 'power-on', 'power-off', 'home', 'back', 'menu',
            'tap', 'swipe', 'input',
        ]);
    });
});

describe('M8b 操作：home/menu 走 keyevent', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview" class="device-preview">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot"></button>
                    <button id="btnDeviceOpenImage"></button>
                    <div class="device-preview__actions">
                        <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button>
                        <div id="deviceActionsMenu" class="device-tools-menu">
                            <button class="device-tools-menu__item" data-action="home">主页</button>
                            <button class="device-tools-menu__item" data-action="back">返回</button>
                            <button class="device-tools-menu__item" data-action="menu">菜单</button>
                        </div>
                    </div>
                    <div class="device-preview__tools">…</div>
                    <div id="devicePreviewStage"><canvas></canvas></div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick"><span></span></div>
                        <div id="devicePreviewInfobarHover"><span></span></div>
                        <div id="devicePreviewInfobarApp"><span></span></div>
                    </div>
                </div>
            </div>
        `;
    });

    it('点"主页"调 requestDeviceKeyevent(serial, 3)', async () => {
        state.devicePreview.serial = 'S49';
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        const sent = [];
        // 直接 mock client._ws.send（绕过握手）
        client._ws = { readyState: 1, send: (s) => sent.push(s) };
        dp.registerClient(client);
        dp.initDevicePreview();

        document.querySelector('[data-action="home"]').click();
        const last = JSON.parse(sent[sent.length - 1]);
        expect(last).toEqual({ type: 'device_keyevent_req', serial: 'S49', keycode: 3 });
    });

    it('点"菜单"调 requestDeviceKeyevent(serial, 82)', async () => {
        state.devicePreview.serial = 'S49';
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        const sent = [];
        client._ws = { readyState: 1, send: (s) => sent.push(s) };
        dp.registerClient(client);
        dp.initDevicePreview();

        document.querySelector('[data-action="menu"]').click();
        const last = JSON.parse(sent[sent.length - 1]);
        expect(last).toEqual({ type: 'device_keyevent_req', serial: 'S49', keycode: 82 });
    });

    it('点"返回"调 requestDeviceKeyevent(serial, 4)', async () => {
        state.devicePreview.serial = 'S49';
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        const sent = [];
        client._ws = { readyState: 1, send: (s) => sent.push(s) };
        dp.registerClient(client);
        dp.initDevicePreview();

        document.querySelector('[data-action="back"]').click();
        const last = JSON.parse(sent[sent.length - 1]);
        expect(last).toEqual({ type: 'device_keyevent_req', serial: 'S49', keycode: 4 });
    });
});

describe('M8b 操作：输入 打开面板 + 发送调 input_text', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview" class="device-preview">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot"></button>
                    <button id="btnDeviceOpenImage"></button>
                    <div class="device-preview__actions">
                        <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button>
                        <div id="deviceActionsMenu" class="device-tools-menu">
                            <button class="device-tools-menu__item" data-action="input">输入</button>
                        </div>
                    </div>
                    <div class="device-preview__tools">…</div>
                    <div id="devicePreviewStage">
                        <canvas></canvas>
                        <div id="devicePreviewSpinner" class="device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick"><span></span></div>
                        <div id="devicePreviewInfobarHover"><span></span></div>
                        <div id="devicePreviewInfobarApp"><span></span></div>
                    </div>
                </div>
            </div>
        `;
    });

    it('点"输入"调出输入面板（蒙版 + textarea + 发送按钮）', async () => {
        state.devicePreview.serial = 'S49';
        state.devicePreview.width = 1080;
        state.devicePreview.height = 2400;
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        dp.registerClient(client);
        dp.initDevicePreview();

        document.querySelector('[data-action="input"]').click();
        const mask = document.querySelector('.device-record-mask');
        const panel = document.querySelector('.device-input-panel');
        const ta = panel && panel.querySelector('textarea');
        const send = panel && panel.querySelector('.device-input-panel__send');
        expect(mask).toBeTruthy();
        expect(panel).toBeTruthy();
        expect(ta).toBeTruthy();
        expect(send).toBeTruthy();
    });

    it('输入文字 + 点发送 → requestDeviceInputText(serial, text) + 关闭面板', async () => {
        state.devicePreview.serial = 'S49';
        state.devicePreview.width = 1080;
        state.devicePreview.height = 2400;
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        const sent = [];
        client._ws = { readyState: 1, send: (s) => sent.push(s) };
        dp.registerClient(client);
        dp.initDevicePreview();

        document.querySelector('[data-action="input"]').click();
        const ta = document.querySelector('.device-input-panel__textarea');
        const send = document.querySelector('.device-input-panel__send');
        ta.value = 'hello 你好';
        send.click();

        // 面板已清掉
        expect(document.querySelector('.device-input-panel')).toBeNull();
        // ws 发了 input_text_req
        const inputMsg = sent.map(JSON.parse).find(m => m.type === 'device_input_text_req');
        expect(inputMsg).toEqual({
            type: 'device_input_text_req', serial: 'S49', text: 'hello 你好',
        });
    });

    it('空文本点发送：不发请求 + 面板仍在 + toast 提示', async () => {
        state.devicePreview.serial = 'S49';
        state.devicePreview.width = 1080;
        state.devicePreview.height = 2400;
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        const sent = [];
        client._ws = { readyState: 1, send: (s) => sent.push(s) };
        dp.registerClient(client);
        dp.initDevicePreview();

        document.querySelector('[data-action="input"]').click();
        const send = document.querySelector('.device-input-panel__send');
        send.click();
        // 没发任何 input_text_req
        const inputMsg = sent.map(JSON.parse).find(m => m.type === 'device_input_text_req');
        expect(inputMsg).toBeUndefined();
        // 面板还在（点空白才能关）
        expect(document.querySelector('.device-input-panel')).toBeTruthy();
    });

    it('输入文字 + 点"发送并Enter" → 先发文本再发 keyevent(66=ENTER)', async () => {
        state.devicePreview.serial = 'S49';
        state.devicePreview.width = 1080;
        state.devicePreview.height = 2400;
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        const sent = [];
        client._ws = { readyState: 1, send: (s) => sent.push(s) };
        dp.registerClient(client);
        dp.initDevicePreview();

        document.querySelector('[data-action="input"]').click();
        const ta = document.querySelector('.device-input-panel__textarea');
        const sendEnter = document.querySelector('.device-input-panel__send-enter');
        expect(sendEnter).toBeTruthy();   // 按钮存在
        ta.value = '搜索内容';
        sendEnter.click();

        // 面板已清
        expect(document.querySelector('.device-input-panel')).toBeNull();
        // 发送顺序：先 input_text_req，再 keyevent(66=ENTER)
        const types = sent.map(s => JSON.parse(s).type);
        const inputIdx = types.indexOf('device_input_text_req');
        const enterIdx = types.indexOf('device_keyevent_req');
        expect(inputIdx).toBeGreaterThanOrEqual(0);
        expect(enterIdx).toBeGreaterThan(inputIdx);   // 顺序：先 text 再 Enter
        const allMsgs = sent.map(JSON.parse);
        expect(allMsgs[inputIdx]).toEqual({
            type: 'device_input_text_req', serial: 'S49', text: '搜索内容',
        });
        expect(allMsgs[enterIdx]).toEqual({
            type: 'device_keyevent_req', serial: 'S49', keycode: 66,
        });
    });

    it('textarea 按 Enter（不按 Shift）= 等同于"发送并Enter"', async () => {
        state.devicePreview.serial = 'S49';
        state.devicePreview.width = 1080;
        state.devicePreview.height = 2400;
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        const sent = [];
        client._ws = { readyState: 1, send: (s) => sent.push(s) };
        dp.registerClient(client);
        dp.initDevicePreview();

        document.querySelector('[data-action="input"]').click();
        const ta = document.querySelector('.device-input-panel__textarea');
        ta.value = 'abc';
        // 模拟 Enter 键（非 Shift 模式）
        ta.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
        // 应该按"发送并Enter"路径：发文本 + Enter keyevent
        const types = sent.map(s => JSON.parse(s).type);
        expect(types).toContain('device_input_text_req');
        expect(types).toContain('device_keyevent_req');
        const enterMsg = sent.map(JSON.parse).find(m => m.type === 'device_keyevent_req');
        expect(enterMsg.keycode).toBe(66);
    });
});

describe('M8b 录制模式取消：操作按钮 listener 在所有取消路径都被摘掉', () => {
    // 回归 bug：用户右键 / Esc 取消录制后，actionsBtn 上"取消" click listener 没摘掉，
    // 下次点"操作"按钮还按 cancel handler 处理（toast 弹"已取消录制"），需再点一下才真打开菜单。
    // 修：用 AbortController 在 _cleanup() 里统一 abort。
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="devicePreview" class="device-preview">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot"></button>
                    <button id="btnDeviceOpenImage"></button>
                    <div class="device-preview__actions">
                        <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button>
                        <div id="deviceActionsMenu" class="device-tools-menu">
                            <button class="device-tools-menu__item" data-action="tap">点击</button>
                            <button class="device-tools-menu__item" data-action="swipe">滑动</button>
                        </div>
                    </div>
                    <div class="device-preview__tools">…</div>
                    <div id="devicePreviewStage">
                        <canvas></canvas>
                        <div id="devicePreviewSpinner" class="device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick"><span></span></div>
                        <div id="devicePreviewInfobarHover"><span></span></div>
                        <div id="devicePreviewInfobarApp"><span></span></div>
                    </div>
                </div>
            </div>
        `;
    });

    it('右键取消录制后，再点"操作"按钮直接打开菜单（不弹已取消录制 toast）', async () => {
        state.devicePreview.serial = 'S49';
        state.devicePreview.width = 1080;
        state.devicePreview.height = 2400;
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        dp.registerClient(client);
        dp.initDevicePreview();

        const tapBtn = document.querySelector('[data-action="tap"]');
        tapBtn.click();
        // 进入录制：mask 已建、按钮文字变 "取消"
        expect(document.querySelector('.device-record-mask')).toBeTruthy();
        const actionsBtn = document.getElementById('btnDeviceActions');
        const label = actionsBtn.querySelector('span[data-i18n]');
        expect(label.getAttribute('data-i18n')).toBe('device.cancel');

        // 先 pointerdown（左键）让 recording 置 true（用户原话：按下未松开时右键才生效）
        const mask = document.querySelector('.device-record-mask');
        const downEvt = new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, button: 0, clientX: 50, clientY: 50,
        });
        mask.dispatchEvent(downEvt);

        // 在 mask 上右键 → 取消（recording=true 时才生效）
        const ctxEvt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        mask.dispatchEvent(ctxEvt);

        // mask 已清、按钮文字恢复 "操作"
        expect(document.querySelector('.device-record-mask')).toBeNull();
        expect(label.getAttribute('data-i18n')).toBe('device.actions');

        // 关键：再点"操作"按钮应直接打开菜单（不弹"已取消录制"）
        actionsBtn.click();
        const menu = document.getElementById('deviceActionsMenu');
        expect(menu.hidden).toBe(false);
    });

    it('Esc 取消录制后，再点"操作"按钮直接打开菜单', async () => {
        state.devicePreview.serial = 'S49';
        state.devicePreview.width = 1080;
        state.devicePreview.height = 2400;
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        dp.registerClient(client);
        dp.initDevicePreview();

        const tapBtn = document.querySelector('[data-action="tap"]');
        tapBtn.click();
        expect(document.querySelector('.device-record-mask')).toBeTruthy();

        // Esc → 取消
        const escEvt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.dispatchEvent(escEvt);

        expect(document.querySelector('.device-record-mask')).toBeNull();

        // 再点"操作"应直接打开菜单
        const actionsBtn = document.getElementById('btnDeviceActions');
        actionsBtn.click();
        const menu = document.getElementById('deviceActionsMenu');
        expect(menu.hidden).toBe(false);
    });

    it('点"取消"按钮完成录制后，再点"操作"按钮直接打开菜单', async () => {
        state.devicePreview.serial = 'S49';
        state.devicePreview.width = 1080;
        state.devicePreview.height = 2400;
        const dp = await import('../../src/js/device-preview.js');
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        dp.registerClient(client);
        dp.initDevicePreview();

        const tapBtn = document.querySelector('[data-action="tap"]');
        tapBtn.click();
        expect(document.querySelector('.device-record-mask')).toBeTruthy();

        // 点"取消"按钮（此时 actionsBtn 显示"取消"）→ 取消
        const actionsBtn = document.getElementById('btnDeviceActions');
        actionsBtn.click();
        expect(document.querySelector('.device-record-mask')).toBeNull();

        // 再点"操作"应直接打开菜单
        actionsBtn.click();
        const menu = document.getElementById('deviceActionsMenu');
        expect(menu.hidden).toBe(false);
    });
});

describe('device-preview refitStage：OCR / 匹配框 redraw 不弹 toast', () => {
    // 回归 bug：完成 OCR / 图像匹配后，框已画好；拖动设备预览窗口宽度时，
    // refitStage 每帧调用 _redrawOCRBoxesIfAny / _redrawMatchBoxesIfAny，
    // 旧实现走 _drawOCRBoxes / _drawMatchBoxes（带 toast），结果每个 RAF tick 都弹
    // "识别到 n 个文本区域" / "匹配到 n 处"，拖一次窗口会刷出几十个 toast。
    // 修法：_redraw* 改调 _render*（静默 DOM 构造），_draw* 只在首次绘制 toast。
    beforeEach(async () => {
        document.body.innerHTML = `
            <div id="devicePreview">
                <div id="devicePreviewHeader">
                    <span class="device-preview__resize"></span>
                </div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot"></button>
                    <button id="btnDeviceOpenImage"></button>
                    <button id="btnDeviceOCR">OCR</button>
                    <button id="btnDeviceActions"><span data-i18n="device.actions">操作</span><span class="dp-btn__arrow">▾</span></button><div id="deviceActionsMenu" class="device-tools-menu"><button id="btnDeviceClear" class="device-tools-menu__item" data-action="clear">清空</button></div>
                    <div id="devicePreviewStage" class="device-preview__stage--empty">
                        <canvas width="1080" height="2400" style="position:absolute;left:0;top:0;width:540px;height:1200px"></canvas>
                        <div id="devicePreviewSpinner" class="device-preview__spinner device-preview__spinner--hidden"></div>
                    </div>
                    <div id="devicePreviewInfobar">
                        <div id="devicePreviewInfobarPick"><span></span></div>
                        <div id="devicePreviewInfobarHover"><span></span></div>
                        <div id="devicePreviewInfobarApp"><span></span></div>
                    </div>
                </div>
            </div>
        `;
        const dp = await import('../../src/js/device-preview.js');
        dp.initDevicePreview();
    });

    // 拦截 state.toast 调用计数（_drawOCRBoxes / _drawMatchBoxes 走这个）
    function spyToast() {
        const toasts = [];
        // monkey-patch state 模块的 toast（设备预览内 import { toast } from './state.js'）
        // 因为是模块闭包里的命名导入，需要通过修改 export — Vitest 下用 vi.spyOn 不可，
        // 直接改模块对象的属性不可（命名导入是只读绑定）。
        // 折中：监听 state.js 模块的 toast 实际是 const toast = (msg) => {...}，
        // 设备预览通过 named import 拿的是同一个引用。
        // 我们用全局 spyOn state 模块的 toast（如果 state 把 toast 挂到了 state.* 上）
        // — 实际没有，所以改用 monkey-patch 模块对象的 default export / 整个 module cache。
        return toasts;
    }

    it('OCR 结果已设 + 多次 refitStage 等效（模拟拖拽 5 帧）— 不弹 toast', async () => {
        // 通过 __test 钩子设置 _ocrResults，让 _redrawOCRBoxesIfAny 进入分支
        const dp = await import('../../src/js/device-preview.js');
        const stateMod = await import('../../src/js/state.js');
        // device-preview 内通过 named import 拿到的 toast 是 state.js 模块顶层 const 绑定。
        // Vitest jsdom 下没有直接 monkey-patch named import 的标准方案 — 改用
        // vi.spyOn + state.js 的属性钩子（如果 toast 是 state.toast 形式则可 spy）。
        // 当前 state.js 的 toast 是顶层 const — 改用 import * as all 重写：
        // 最简方案：直接数 DOM 里 toast 容器的子元素数量。
        const dp2 = dp;
        // 设一个有 1 个 box 的结果（最简）
        dp2.__test.setOcrResults([
            { box: [[10, 20], [200, 20], [200, 60], [10, 60]], text: 'hello' },
        ]);
        // 模拟 refitStage 走 5 次（每次调 _redrawOCRBoxesIfAny）
        const stage = document.getElementById('devicePreviewStage');
        for (let i = 0; i < 5; i++) {
            // 模拟 canvas 尺寸/位置变化 → redraw 路径会重建 box overlay
            const canvas = stage.querySelector('canvas');
            canvas.getBoundingClientRect = () => ({
                left: 0 + i, top: 0, right: 540 + i, bottom: 1200,
                width: 540 + i, height: 1200, x: 0, y: 0, toJSON: () => {},
            });
            stage.getBoundingClientRect = () => ({
                left: 0, top: 0, right: 540 + i, bottom: 1200,
                width: 540 + i, height: 1200, x: 0, y: 0, toJSON: () => {},
            });
            // 触发 redraw — 通过 dispatch pointermove 不好绕开 RAF；直接走 refitStage
            // 等价路径：先调用 dp 内任意触发 refitStage 的入口。最简单是手动同步重新渲染。
            // 这里用 dispatch 拖拽手柄的 pointermove：太复杂。改：直接调 _redrawOCRBoxesIfAny 不导出。
            // 退而求其次：mock 一个 _drawOCRBoxes 触发（用 _renderOCRBoxes）也都不导出。
            // 测试核心：通过 __test 改 _ocrResults 后，调红raw需要入口。
            // → 改用实际拖拽手柄 path
            const root = document.getElementById('devicePreview');
            Object.defineProperty(root, 'getBoundingClientRect', {
                value: () => ({ width: 540 + i, left: 0, right: 540 + i, top: 0, bottom: 28 }),
                configurable: true,
            });
            const handle = document.querySelector('.device-preview__resize') || (() => {
                const h = document.createElement('span');
                h.className = 'device-preview__resize';
                document.getElementById('devicePreviewHeader').appendChild(h);
                return h;
            })();
            handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 540 }));
            document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 540 + i }));
            await new Promise(r => setTimeout(r, 30));   // flush RAF
            document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        }
        // 框 overlay 仍然存在（redraw 没把数据清掉）
        expect(stage.querySelector('.ocr-boxes-overlay')).toBeTruthy();
        // 没产生任何 toast DOM（toast 是把 span 加到 body）
        const toastEls = document.querySelectorAll('body > div, body > span');
        // 简单 sanity：DOM 里没有 device-ocrFound 文本
        expect(document.body.textContent).not.toMatch(/识别到 \d+ 个文本区域/);
        dp2.__test.setOcrResults(null);
    });

    it('图像匹配结果已设 + 多次 refitStage 等效（模拟拖拽 5 帧）— 不弹 toast', async () => {
        const dp = await import('../../src/js/device-preview.js');
        dp.__test.setMatchResults([
            { box: [[10, 20], [200, 20], [200, 60], [10, 60]], score: 0.92 },
        ]);
        const stage = document.getElementById('devicePreviewStage');
        for (let i = 0; i < 5; i++) {
            const root = document.getElementById('devicePreview');
            Object.defineProperty(root, 'getBoundingClientRect', {
                value: () => ({ width: 540 + i, left: 0, right: 540 + i, top: 0, bottom: 28 }),
                configurable: true,
            });
            const canvas = stage.querySelector('canvas');
            canvas.getBoundingClientRect = () => ({
                left: 0 + i, top: 0, right: 540 + i, bottom: 1200,
                width: 540 + i, height: 1200, x: 0, y: 0, toJSON: () => {},
            });
            stage.getBoundingClientRect = () => ({
                left: 0, top: 0, right: 540 + i, bottom: 1200,
                width: 540 + i, height: 1200, x: 0, y: 0, toJSON: () => {},
            });
            const handle = document.querySelector('.device-preview__resize') || (() => {
                const h = document.createElement('span');
                h.className = 'device-preview__resize';
                document.getElementById('devicePreviewHeader').appendChild(h);
                return h;
            })();
            handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 540 }));
            document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 540 + i }));
            await new Promise(r => setTimeout(r, 30));
            document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        }
        expect(stage.querySelector('.match-boxes-overlay')).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/匹配到 \d+ 处/);
        dp.__test.setMatchResults(null);
    });

    it('回归：匹配框在连续拖拽多帧时**实际跟随**尺寸更新（之前 _removeMatchBoxes 把 _matchResults 清空导致只第一帧更新）', async () => {
        const dp = await import('../../src/js/device-preview.js');
        const stage = document.getElementById('devicePreviewStage');
        dp.__test.setMatchResults([
            { box: [[10, 20], [200, 20], [200, 60], [10, 60]], score: 0.92 },
        ]);

        // 帧 0：设初始尺寸
        let curW = 540;
        const root = document.getElementById('devicePreview');
        Object.defineProperty(root, 'getBoundingClientRect', {
            value: () => ({ width: curW, left: 0, right: curW, top: 0, bottom: 28 }),
            configurable: true,
        });
        const canvas = stage.querySelector('canvas');
        const setRect = () => {
            canvas.getBoundingClientRect = () => ({
                left: 0, top: 0, right: curW, bottom: 1200,
                width: curW, height: 1200, x: 0, y: 0, toJSON: () => {},
            });
            stage.getBoundingClientRect = () => ({
                left: 0, top: 0, right: curW, bottom: 1200,
                width: curW, height: 1200, x: 0, y: 0, toJSON: () => {},
            });
        };
        setRect();

        // 触发一次拖拽让 _redrawMatchBoxesIfAny 跑起来（_matchResults 已被 _renderMatchBoxes
        // 第一次调用 _removeMatchBoxes 置 null 的旧 bug 就在这里炸）
        const handle = document.querySelector('.device-preview__resize');
        handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: curW }));
        // 帧 1：拖到 600
        curW = 600; setRect();
        document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: curW }));
        await new Promise(r => setTimeout(r, 30));
        const overlay1 = stage.querySelector('.match-boxes-overlay');
        const box1 = overlay1 && overlay1.querySelector('.match-box');
        const width1 = box1 ? parseFloat(box1.style.width) : null;
        // 帧 2：拖到 800（关键：之前 _matchResults 已被第一次 redraw 清掉，这次应不再更新）
        curW = 800; setRect();
        document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: curW }));
        await new Promise(r => setTimeout(r, 30));
        const overlay2 = stage.querySelector('.match-boxes-overlay');
        const box2 = overlay2 && overlay2.querySelector('.match-box');
        const width2 = box2 ? parseFloat(box2.style.width) : null;
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));

        // 框 overlay 仍在
        expect(overlay2).toBeTruthy();
        // 关键断言：第 2 帧的框宽度应**严格大于**第 1 帧的框宽度（画布缩放后框跟着放大）。
        // 旧 bug 下 width2 === width1（_matchResults 在帧 1 已被置 null，帧 2 noop）。
        expect(width1).toBeGreaterThan(0);
        expect(width2).toBeGreaterThan(width1);
        dp.__test.setMatchResults(null);
    });
});
