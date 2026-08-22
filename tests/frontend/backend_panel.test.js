import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state } from '../../src/js/state.js';

// BackendClient 在 jsdom 下没有 WebSocket — 把 connect() 改成同步返回 resolved promise,
// 避免 initBackendsPanel → restoreBackends 触发 ws 报错噪音
class FakeWS {
    constructor() {}
    close() {}
    send() {}
}
global.WebSocket = FakeWS;

describe('backend-panel: clicking backend row', () => {
    beforeEach(() => {
        localStorage.clear();
        state.selectedDeviceByBackend = {};
        state.deviceListByBackend = {};
        document.body.innerHTML = `
            <div id="sidebar">
                <button id="btnAddBackend"></button>
                <div id="backendListBody">
                    <div id="backendStubHint">添加后端以连接</div>
                    <ul id="backendList"></ul>
                </div>
            </div>
            <!-- device-preview widget DOM — initDevicePreview 需要 -->
            <div id="devicePreview" class="device-preview device-preview--collapsed">
                <div id="devicePreviewHeader"></div>
                <div id="devicePreviewBody">
                    <button id="btnDeviceScreenshot" disabled></button>
                    <button id="btnDeviceOpenImage"></button>
                    <button id="btnDeviceOrientation">横屏</button>
                    <button id="btnDeviceOCR" disabled></button>
                    <button id="btnDeviceClear"></button>
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

    it('点击后端条目(未连接状态)不抛错 — 回归测试(state 变量 shadow)', async () => {
        // 预存一个后端（未连接 — _clients 里没有对应 entry）
        const id = 'test-uuid-1234';
        localStorage.setItem('dtf:backends',
            JSON.stringify([{ id, host: 'h', port: 1, name: 'test' }]));

        const bc = await import('../../src/js/backend-client.js');
        vi.spyOn(bc.BackendClient.prototype, 'connect').mockResolvedValue();

        const bp = await import('../../src/js/backend-panel.js');
        // initBackendsPanel 内部调用 refreshBackends → 渲染 li
        bp.initBackendsPanel();

        const li = document.querySelector('.backend-item');
        expect(li).not.toBeNull();

        // 修复前会抛 "Cannot read properties of undefined (reading 'test-uuid-1234')"
        // (refreshBackends 内的局部 const state shadow 了模块顶部 import 的 state 对象,
        // 字符串没有 selectedDeviceByBackend 属性 → undefined → undefined[uuid] 抛错)
        const errors = [];
        const handler = (e) => {
            if (e.error) errors.push(e.error);
            else errors.push(new Error(e.message || 'unknown'));
        };
        window.addEventListener('error', handler);
        try {
            li.click();
        } finally {
            window.removeEventListener('error', handler);
        }
        expect(errors).toEqual([]);
    });

    it('点击后端条目后 setSelectedBackendId 写入 LS', async () => {
        const id = 'test-uuid-5678';
        localStorage.setItem('dtf:backends',
            JSON.stringify([{ id, host: 'h', port: 1, name: 'test' }]));

        const bc = await import('../../src/js/backend-client.js');
        vi.spyOn(bc.BackendClient.prototype, 'connect').mockResolvedValue();

        const bp = await import('../../src/js/backend-panel.js');
        bp.initBackendsPanel();

        document.querySelector('.backend-item').click();
        expect(localStorage.getItem('dtf:selected_backend')).toBe(id);
    });

    it('reconnect 后 device-preview 截图按钮重新启用(回归测试)', async () => {
        const id = 'test-uuid-reconn';
        localStorage.setItem('dtf:backends',
            JSON.stringify([{ id, host: 'h', port: 1, name: 'test' }]));

        const bc = await import('../../src/js/backend-client.js');
        vi.spyOn(bc.BackendClient.prototype, 'connect').mockResolvedValue();

        const bp = await import('../../src/js/backend-panel.js');
        const dp = await import('../../src/js/device-preview.js');

        dp.initDevicePreview();
        bp.initBackendsPanel();

        // 拿到 initBackendsPanel → restoreBackends 自动创建的 client,手动把它标 connected
        const cli1 = bp.getClientById(id);
        cli1._setState('connected');

        // 点击 backend row → setSelectedBackendId + setDevicePreviewClient(cli1) + setActiveSerial
        document.querySelector('.backend-item').click();
        dp.setActiveSerial('S49');

        // 截图按钮应该 enabled(serial + connected client)
        expect(document.getElementById('btnDeviceScreenshot').disabled).toBe(false);

        // 模拟 reconnect — 旧 client close,新 client 创建
        bp.reconnect(id);
        const cli2 = bp.getClientById(id);
        expect(cli2).not.toBe(cli1);  // 确认是新 client

        // 新 client 也变 connected — 修复前 device-preview 还引用 cli1(state='disconnected'),
        // 按钮永远 disabled;修复后 setDevicePreviewClient(cli2) 让 device-preview 订阅 cli2,
        // cli2._emit('state','connected') 后按钮重新 enable
        cli2._setState('connected');
        expect(document.getElementById('btnDeviceScreenshot').disabled).toBe(false);
    });

    it('已选中的后端再次点击 → 取消选中，其下选中的设备一并取消', async () => {
        const id = 'test-uuid-desel-b';
        localStorage.setItem('dtf:backends', JSON.stringify([{ id, host: 'h', port: 1, name: 'test' }]));
        localStorage.setItem('dtf:selected_backend', id);
        localStorage.setItem('dtf:selected_device_by_backend', JSON.stringify({ [id]: 'S99' }));
        state.selectedDeviceByBackend = { [id]: 'S99' };
        state.deviceListByBackend = { [id]: [{ serial: 'S99', state: 'device' }] };

        const bc = await import('../../src/js/backend-client.js');
        vi.spyOn(bc.BackendClient.prototype, 'connect').mockResolvedValue();
        const bp = await import('../../src/js/backend-panel.js');
        bp.initBackendsPanel();

        // 初始：后端 + 设备都处于选中态
        const li = document.querySelector('.backend-item');
        const devItem = document.querySelector('.device-list__item');
        expect(li.classList.contains('backend-item--selected')).toBe(true);
        expect(devItem.classList.contains('device-list__item--selected')).toBe(true);

        // 再点一次后端 → 后端取消选中，其下选中的设备一并取消
        li.click();
        expect(localStorage.getItem('dtf:selected_backend')).toBe('');
        expect(state.selectedDeviceByBackend[id]).toBeUndefined();
        // 重新渲染后：两者都不再带 selected class
        expect(document.querySelector('.backend-item').classList.contains('backend-item--selected')).toBe(false);
        expect(document.querySelector('.device-list__item').classList.contains('device-list__item--selected')).toBe(false);
    });

    it('已选中的设备再次点击 → 取消选中（父后端保持选中）', async () => {
        const id = 'test-uuid-desel-d';
        localStorage.setItem('dtf:backends', JSON.stringify([{ id, host: 'h', port: 1, name: 'test' }]));
        localStorage.setItem('dtf:selected_backend', id);
        localStorage.setItem('dtf:selected_device_by_backend', JSON.stringify({ [id]: 'S99' }));
        state.selectedDeviceByBackend = { [id]: 'S99' };
        state.deviceListByBackend = { [id]: [{ serial: 'S99', state: 'device' }] };

        const bc = await import('../../src/js/backend-client.js');
        vi.spyOn(bc.BackendClient.prototype, 'connect').mockResolvedValue();
        const bp = await import('../../src/js/backend-panel.js');
        bp.initBackendsPanel();

        const devItem = document.querySelector('.device-list__item');
        expect(devItem.classList.contains('device-list__item--selected')).toBe(true);
        devItem.click();
        expect(state.selectedDeviceByBackend[id]).toBeUndefined();
        // 父后端保持选中
        expect(localStorage.getItem('dtf:selected_backend')).toBe(id);
        expect(document.querySelector('.backend-item').classList.contains('backend-item--selected')).toBe(true);
    });

    it('editBackend 保存后端:只持久化配置,不触发 connect(回归测试)', async () => {
        const id = 'test-uuid-edit';
        localStorage.setItem('dtf:backends',
            JSON.stringify([{ id, host: 'h', port: 1, name: 'old' }]));

        const bc = await import('../../src/js/backend-client.js');
        const connectSpy = vi.spyOn(bc.BackendClient.prototype, 'connect').mockResolvedValue();
        const closeSpy = vi.spyOn(bc.BackendClient.prototype, 'close').mockImplementation(() => {});

        const bp = await import('../../src/js/backend-panel.js');
        bp.initBackendsPanel();

        // initBackendsPanel → restoreBackends 自己也会 connect,清掉这些计数,
        // 只关注"保存"路径有没有 connect/close
        connectSpy.mockClear();
        closeSpy.mockClear();

        // editBackend 内部 fire-and-forget,不返回 promise。
        // 等 dialog DOM 出现,然后驱动 + 等 LS 更新。
        bp.editBackend(id);
        // 轮询 dialog 是否就绪(同步 append,通常立刻就绪,等 1 tick 保险)
        for (let i = 0; i < 20; i++) {
            if (document.querySelector('[data-name="host"]')) break;
            await new Promise(r => setTimeout(r, 5));
        }
        const $host = document.querySelector('[data-name="host"]');
        const $port = document.querySelector('[data-name="port"]');
        const $name = document.querySelector('[data-name="name"]');
        const $ok = document.querySelector('[data-act="ok"]');
        $host.value = 'newhost';
        $port.value = '9999';
        $name.value = 'newname';
        $ok.click();
        // 等 saveBackends 写完 LS
        for (let i = 0; i < 20; i++) {
            const list = JSON.parse(localStorage.getItem('dtf:backends') || '[]');
            const saved = list.find((x) => x.id === id);
            if (saved && saved.host === 'newhost') break;
            await new Promise(r => setTimeout(r, 10));
        }

        // LS 应该更新成新值
        const list = JSON.parse(localStorage.getItem('dtf:backends'));
        const saved = list.find((x) => x.id === id);
        expect(saved.host).toBe('newhost');
        expect(saved.port).toBe(9999);
        expect(saved.name).toBe('newname');

        // 关键断言:connect/close 都未被调用 — 保存按钮只持久化配置,不连接也不断连
        expect(connectSpy).not.toHaveBeenCalled();
        expect(closeSpy).not.toHaveBeenCalled();
    });
});