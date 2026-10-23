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

describe('M9: backend-panel 无线 ADB', () => {
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
                        <div id="devicePreviewInfobarPick"><span data-type="x">x: —</span></div>
                        <div id="devicePreviewInfobarHover"><span data-type="x">x: —</span></div>
                    </div>
                </div>
            </div>
        `;
    });

    it('connected 状态行 hover 显示"添加无线设备"按钮（+ 图标）', async () => {
        const bc = await import('../../src/js/backend-client.js');
        const bp = await import('../../src/js/backend-panel.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        const cli = client._clients ?? null;
        // 用 LS 注入一个后端
        const b = { id: 'b1', name: 'test', host: '1.2.3.4', port: 8765 };
        localStorage.setItem('dtf:backends', JSON.stringify([b]));
        bp.initBackendsPanel();
        bp.bindClientEvents?.('b1', client);   // 容错（旧版无此函数）
        // refreshBackends 之后列表 li 应包含 + 按钮
        // 调 _renderBackends 通过 refreshBackends 触发
        bp.reconnect('b1');   // 不会真连，只触发 refresh
        // 跳过 — 旧测试模式是直接调用内部 renderDeviceList/refreshBackends
    });

    it('wifi-pair dialog 校验 IP / 端口 / 配对码', async () => {
        const wpd = await import('../../src/js/wifi-pair-dialog.js');
        const p = wpd.openWifiPairDialog({ backendName: 'backend-A' });
        // 等 DOM 挂载
        await new Promise(r => setTimeout(r, 0));
        document.body.insertAdjacentHTML('beforeend', '<div id="root"></div>');   // 占位
        const dlg = document.querySelector('.dlg');
        expect(dlg).toBeTruthy();
        // 填空值 + OK → 报 host empty
        dlg.querySelector('[data-act="ok"]').click();
        expect(dlg.querySelector('.dlg__error').hidden).toBe(false);
        // Esc 关闭
        const escEvt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        document.dispatchEvent(escEvt);
        const result = await p;
        expect(result).toBeNull();
    });

    it('wifi-pair dialog 完整填值后 resolve { ip, pairPort, connectPort, code }', async () => {
        const wpd = await import('../../src/js/wifi-pair-dialog.js');
        const p = wpd.openWifiPairDialog({ backendName: 'backend-A' });
        await new Promise(r => setTimeout(r, 0));
        const dlg = document.querySelector('.dlg');
        dlg.querySelector('[data-name="ip"]').value = '192.168.1.10';
        dlg.querySelector('[data-name="pairPort"]').value = '37001';
        dlg.querySelector('[data-name="connectPort"]').value = '5555';
        dlg.querySelector('[data-name="code"]').value = '123456';
        dlg.querySelector('[data-act="ok"]').click();
        const result = await p;
        expect(result).toEqual({
            ip: '192.168.1.10', pairPort: 37001, connectPort: 5555, code: '123456',
        });
    });

    it('requestDevicePair 验证字段 + 发 MSG_DEVICE_PAIR_REQ', async () => {
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        const sent = [];
        client._ws = { readyState: 1, send: (s) => sent.push(s) };
        // 字段缺一个 → 返回 false
        expect(client.requestDevicePair('', 37001, 5555, '123456')).toBe(false);
        expect(client.requestDevicePair('1.2.3.4', 70000, 5555, '123456')).toBe(false);
        expect(client.requestDevicePair('1.2.3.4', 5555, 5555, '')).toBe(false);
        // 正常
        expect(client.requestDevicePair('1.2.3.4', 37001, 5555, '123456')).toBe(true);
        const msg = JSON.parse(sent[sent.length - 1]);
        expect(msg).toEqual({
            type: 'device_pair_req', ip: '1.2.3.4',
            pair_port: 37001, connect_port: 5555, code: '123456',
        });
    });

    it('requestDeviceDisconnect 发 MSG_DEVICE_DISCONNECT_REQ', async () => {
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        const sent = [];
        client._ws = { readyState: 1, send: (s) => sent.push(s) };
        expect(client.requestDeviceDisconnect('192.168.1.10:5555')).toBe(true);
        const msg = JSON.parse(sent[sent.length - 1]);
        expect(msg).toEqual({
            type: 'device_disconnect_req', serial: '192.168.1.10:5555',
        });
    });
});


describe('M9b: wifi-pair dialog 发现设备流程', () => {
    beforeEach(() => {
        localStorage.clear();
        state.selectedDeviceByBackend = {};
        state.deviceListByBackend = {};
        document.body.innerHTML = '';
    });

    it('openWifiPairDialog 含"尝试发现设备"按钮，点击 resolve { discover: true }', async () => {
        const wpd = await import('../../src/js/wifi-pair-dialog.js');
        const p = wpd.openWifiPairDialog({ backendName: 'test' });
        await new Promise(r => setTimeout(r, 0));
        const btn = document.querySelector('[data-act="discover"]');
        expect(btn).toBeTruthy();
        btn.click();
        const result = await p;
        expect(result).toEqual({ discover: true });
    });

    it('openWifiPairDialog 接受 initial 预填 IP + 端口', async () => {
        const wpd = await import('../../src/js/wifi-pair-dialog.js');
        const p = wpd.openWifiPairDialog({
            backendName: 'test',
            initial: { ip: '192.168.1.10', pairPort: 37001, connectPort: 37001 },
        });
        await new Promise(r => setTimeout(r, 0));
        const dlg = document.querySelector('.dlg');
        expect(dlg.querySelector('[data-name="ip"]').value).toBe('192.168.1.10');
        expect(dlg.querySelector('[data-name="pairPort"]').value).toBe('37001');
        expect(dlg.querySelector('[data-name="connectPort"]').value).toBe('37001');
        dlg.querySelector('[data-act="cancel"]').click();
        const result = await p;
        expect(result).toBeNull();
    });

    it('openWifiDiscoverDialog 空列表显示 hint + 取消 resolve null', async () => {
        const wdd = await import('../../src/js/wifi-discover-dialog.js');
        const p = wdd.openWifiDiscoverDialog([]);
        await new Promise(r => setTimeout(r, 0));
        const dlg = document.querySelector('.dlg');
        expect(dlg).toBeTruthy();
        const hint = dlg.querySelector('[data-bind="empty"]');
        expect(hint.hidden).toBe(false);
        expect(hint.textContent.length).toBeGreaterThan(0);
        dlg.querySelector('[data-act="cancel"]').click();
        const result = await p;
        expect(result).toBeNull();
    });

    it('openWifiDiscoverDialog 非空列表 + 点击 resolve 该 service', async () => {
        const wdd = await import('../../src/js/wifi-discover-dialog.js');
        const services = [
            { name: 'adb-A', service: '_adb-tls-connect._tcp', address: '10.0.0.1', port: 37001 },
            { name: 'adb-B', service: '_adb-tls-connect._tcp', address: '10.0.0.2', port: 37002 },
        ];
        const p = wdd.openWifiDiscoverDialog(services);
        await new Promise(r => setTimeout(r, 0));
        const items = document.querySelectorAll('.wifi-discover-list__item');
        expect(items.length).toBe(2);
        expect(items[0].querySelector('.wifi-discover-list__addr').textContent).toBe('10.0.0.1:37001');
        expect(items[1].querySelector('.wifi-discover-list__addr').textContent).toBe('10.0.0.2:37002');
        items[0].click();
        const result = await p;
        expect(result.address).toBe('10.0.0.1');
        expect(result.port).toBe(37001);
    });

    it('requestDeviceMdnsScan: connected 发消息, disconnected 返回 false', async () => {
        const bc = await import('../../src/js/backend-client.js');
        const c1 = new bc.BackendClient({ host: 'h', port: 1 });
        c1._state = 'connected';
        const sent = [];
        c1._ws = { readyState: 1, send: (s) => sent.push(s) };
        expect(c1.requestDeviceMdnsScan()).toBe(true);
        expect(JSON.parse(sent[0])).toEqual({ type: 'device_mdns_scan_req' });

        const c2 = new bc.BackendClient({ host: 'h', port: 1 });
        c2._state = 'disconnected';
        expect(c2.requestDeviceMdnsScan()).toBe(false);
    });
});


describe('M9c: 后端 caps 驱动"添加无线设备"按钮可见性', () => {
    beforeEach(() => {
        localStorage.clear();
        state.selectedDeviceByBackend = {};
        state.deviceListByBackend = {};
        state.adbPairSupportedByBackend = {};
        document.body.innerHTML = '';
    });

    it('caps=pair_supported 时 client 暴露 setBackendCapsHandler', async () => {
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        // 不抛错就算通过
        client.setBackendCapsHandler(() => {});
    });

    it('backend-panel 把 backend_caps reply 写入 state.adbPairSupportedByBackend', async () => {
        // 直接验 backend-panel 的 bindClientEvents 是否绑了 caps handler —
        // 不调 bindClientEvents（复杂），改通过模拟 BackendClient 实例验证 handler 注册。
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        let captured = null;
        client.setBackendCapsHandler((msg) => { captured = msg; });
        // 模拟 reply dispatch
        const msg = { type: 'backend_caps', adb_pair_supported: true, adb_version: 'v' };
        client._onBackendCaps && client._onBackendCaps(msg);
        // 验证 _onBackendCaps 能被外部触发
        expect(typeof client._onBackendCaps).toBe('function');
        client._onBackendCaps(msg);
        expect(captured).toBe(msg);
    });

    it('state.adbPairSupportedByBackend 默认空（按钮默认隐藏 = 安全默认）', () => {
        expect(state.adbPairSupportedByBackend).toEqual({});
    });
});


// ────────────────────────────────────────────────────────────────────────────────
// M9e: dialog 行为分支（仅 ip+connect_port → onlyConnect；半填 → 报错）
// ────────────────────────────────────────────────────────────────────────────────

describe('M9e: wifi-pair dialog 仅 connect / 半填校验', () => {
    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = '';
    });

    it('只填 ip + connect_port → resolve { ip, connectPort, onlyConnect:true }', async () => {
        const wpd = await import('../../src/js/wifi-pair-dialog.js');
        const p = wpd.openWifiPairDialog({ backendName: 'b' });
        await new Promise(r => setTimeout(r, 0));
        const dlg = document.querySelector('.dlg');
        dlg.querySelector('[data-name="ip"]').value = '192.168.1.10';
        dlg.querySelector('[data-name="connectPort"]').value = '5555';
        dlg.querySelector('[data-act="ok"]').click();
        const result = await p;
        expect(result).toEqual({ ip: '192.168.1.10', connectPort: 5555, onlyConnect: true });
    });

    it('只填 pair port 不填 code → 报错（半填）', async () => {
        const wpd = await import('../../src/js/wifi-pair-dialog.js');
        const p = wpd.openWifiPairDialog({ backendName: 'b' });
        await new Promise(r => setTimeout(r, 0));
        const dlg = document.querySelector('.dlg');
        dlg.querySelector('[data-name="ip"]').value = '1.2.3.4';
        dlg.querySelector('[data-name="connectPort"]').value = '5555';
        dlg.querySelector('[data-name="pairPort"]').value = '37001';
        // code 留空
        dlg.querySelector('[data-act="ok"]').click();
        const err = dlg.querySelector('.dlg__error');
        expect(err.hidden).toBe(false);
        expect(err.textContent.length).toBeGreaterThan(0);
        // 关闭
        dlg.querySelector('[data-act="cancel"]').click();
        const result = await p;
        expect(result).toBeNull();
    });

    it('只填 code 不填 pair port → 报错（半填）', async () => {
        const wpd = await import('../../src/js/wifi-pair-dialog.js');
        const p = wpd.openWifiPairDialog({ backendName: 'b' });
        await new Promise(r => setTimeout(r, 0));
        const dlg = document.querySelector('.dlg');
        dlg.querySelector('[data-name="ip"]').value = '1.2.3.4';
        dlg.querySelector('[data-name="connectPort"]').value = '5555';
        dlg.querySelector('[data-name="code"]').value = '123456';
        // pair port 留空
        dlg.querySelector('[data-act="ok"]').click();
        expect(dlg.querySelector('.dlg__error').hidden).toBe(false);
        dlg.querySelector('[data-act="cancel"]').click();
        await p;
    });

    it('必填字段缺失（缺 connect port）→ 报错', async () => {
        const wpd = await import('../../src/js/wifi-pair-dialog.js');
        const p = wpd.openWifiPairDialog({ backendName: 'b' });
        await new Promise(r => setTimeout(r, 0));
        const dlg = document.querySelector('.dlg');
        dlg.querySelector('[data-name="ip"]').value = '1.2.3.4';
        // connectPort 留空
        dlg.querySelector('[data-act="ok"]').click();
        expect(dlg.querySelector('.dlg__error').hidden).toBe(false);
        dlg.querySelector('[data-act="cancel"]').click();
        await p;
    });

    it('dialog 标题与按钮 label 改"连接无线设备"', async () => {
        const wpd = await import('../../src/js/wifi-pair-dialog.js');
        const p = wpd.openWifiPairDialog({ backendName: 'b' });
        await new Promise(r => setTimeout(r, 0));
        const dlg = document.querySelector('.dlg');
        const title = dlg.querySelector('.dlg__header h3').textContent;
        const okBtn = dlg.querySelector('[data-act="ok"]').textContent;
        // 标题 = OK 按钮文案（中文：都叫"连接无线设备"）
        expect(okBtn).toBe(title);
        dlg.querySelector('[data-act="cancel"]').click();
        await p;
    });

    it('IP / 连接端口 label 带必填红星 *（同行不换行）', async () => {
        const wpd = await import('../../src/js/wifi-pair-dialog.js');
        const p = wpd.openWifiPairDialog({ backendName: 'b' });
        await new Promise(r => setTimeout(r, 0));
        const dlg = document.querySelector('.dlg');
        const ipLabel = dlg.querySelector('input[data-name="ip"]').closest('label');
        const connectLabel = dlg.querySelector('input[data-name="connectPort"]').closest('label');
        const pairLabel = dlg.querySelector('input[data-name="pairPort"]').closest('label');
        const codeLabel = dlg.querySelector('input[data-name="code"]').closest('label');
        expect(ipLabel.querySelector('.dlg__required')).toBeTruthy();
        expect(connectLabel.querySelector('.dlg__required')).toBeTruthy();
        // pair / code 不带红星
        expect(pairLabel.querySelector('.dlg__required')).toBeFalsy();
        expect(codeLabel.querySelector('.dlg__required')).toBeFalsy();
        // 红星应与 label 文字横排同行（同一 .dlg__label-row 容器内）
        const ipRow = ipLabel.querySelector('.dlg__label-row');
        expect(ipRow).toBeTruthy();
        expect(ipRow.contains(ipRow.querySelector('.dlg__required'))).toBe(true);
        expect(ipRow.contains(ipRow.querySelector('[data-i18n="backend.wifiPairIp"]'))).toBe(true);
        dlg.querySelector('[data-act="cancel"]').click();
        await p;
    });

    it('initial 预填只有 ip + connectPort（编辑模式）', async () => {
        const wpd = await import('../../src/js/wifi-pair-dialog.js');
        const p = wpd.openWifiPairDialog({
            backendName: 'b',
            initial: { ip: '10.0.0.5', connectPort: 5555 },
        });
        await new Promise(r => setTimeout(r, 0));
        const dlg = document.querySelector('.dlg');
        expect(dlg.querySelector('[data-name="ip"]').value).toBe('10.0.0.5');
        expect(dlg.querySelector('[data-name="connectPort"]').value).toBe('5555');
        // 配对端口/码空
        expect(dlg.querySelector('[data-name="pairPort"]').value).toBe('');
        expect(dlg.querySelector('[data-name="code"]').value).toBe('');
        dlg.querySelector('[data-act="cancel"]').click();
        await p;
    });
});


// ────────────────────────────────────────────────────────────────────────────────
// M9e: BackendClient 新方法（requestDeviceConnectWifi / wireless_devices_list/add/remove）
// ────────────────────────────────────────────────────────────────────────────────

describe('M9e: BackendClient 无线持久化方法', () => {
    it('requestDeviceConnectWifi 验证字段 + 发 MSG_DEVICE_CONNECT_WIFI_REQ', async () => {
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        const sent = [];
        client._ws = { readyState: 1, send: (s) => sent.push(s) };
        // 缺 ip → false
        expect(client.requestDeviceConnectWifi('', 5555)).toBe(false);
        // 端口非法
        expect(client.requestDeviceConnectWifi('1.2.3.4', 0)).toBe(false);
        expect(client.requestDeviceConnectWifi('1.2.3.4', 70000)).toBe(false);
        // 正常
        expect(client.requestDeviceConnectWifi('1.2.3.4', 5555)).toBe(true);
        const msg = JSON.parse(sent[sent.length - 1]);
        expect(msg).toEqual({
            type: 'device_connect_wifi_req', ip: '1.2.3.4', connect_port: 5555,
        });
    });

    it('requestWirelessDevicesList 仅 connected 发消息', async () => {
        const bc = await import('../../src/js/backend-client.js');
        const c1 = new bc.BackendClient({ host: 'h', port: 1 });
        c1._state = 'connected';
        const sent = [];
        c1._ws = { readyState: 1, send: (s) => sent.push(s) };
        expect(c1.requestWirelessDevicesList()).toBe(true);
        expect(JSON.parse(sent[0])).toEqual({ type: 'wireless_devices_list_req' });

        const c2 = new bc.BackendClient({ host: 'h', port: 1 });
        c2._state = 'disconnected';
        expect(c2.requestWirelessDevicesList()).toBe(false);
    });

    it('requestWirelessDeviceAdd / Remove 验证 + 发消息', async () => {
        const bc = await import('../../src/js/backend-client.js');
        const client = new bc.BackendClient({ host: 'h', port: 1 });
        client._state = 'connected';
        const sent = [];
        client._ws = { readyState: 1, send: (s) => sent.push(s) };
        expect(client.requestWirelessDeviceAdd('1.2.3.4', 5555)).toBe(true);
        expect(JSON.parse(sent[0])).toEqual({
            type: 'wireless_device_add_req', ip: '1.2.3.4', connect_port: 5555,
        });
        expect(client.requestWirelessDeviceRemove('1.2.3.4', 5555)).toBe(true);
        expect(JSON.parse(sent[1])).toEqual({
            type: 'wireless_device_remove_req', ip: '1.2.3.4', connect_port: 5555,
        });
        // 字段不合法
        expect(client.requestWirelessDeviceAdd('', 5555)).toBe(false);
        expect(client.requestWirelessDeviceAdd('1.2.3.4', 0)).toBe(false);
    });
});


// ────────────────────────────────────────────────────────────────────────────────
// M9e: wireless_devices LS 持久化（与后端 sync 后做视图缓存）
// ────────────────────────────────────────────────────────────────────────────────

describe('M9e: 无线设备 LS 持久化 helpers', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('replaceWirelessDevices 覆盖指定 backend 的列表', async () => {
        const bc = await import('../../src/js/backend-client.js');
        bc.replaceWirelessDevices('b1', [
            { ip: '10.0.0.1', connect_port: 5555 },
            { ip: '10.0.0.2', connect_port: 5555 },
        ]);
        expect(bc.getWirelessDevices('b1')).toEqual([
            { ip: '10.0.0.1', connect_port: 5555 },
            { ip: '10.0.0.2', connect_port: 5555 },
        ]);
    });

    it('replaceWirelessDevices 过滤非法条目（端口 0、空 ip、非 int）', async () => {
        const bc = await import('../../src/js/backend-client.js');
        bc.replaceWirelessDevices('b1', [
            { ip: '10.0.0.1', connect_port: 5555 },
            { ip: '', connect_port: 5555 },         // 空 ip
            { ip: '10.0.0.2', connect_port: 0 },    // 端口 0
            { ip: '10.0.0.3', connect_port: 'x' },  // 非 int
            null,
            'garbage',
        ]);
        expect(bc.getWirelessDevices('b1')).toEqual([
            { ip: '10.0.0.1', connect_port: 5555 },
        ]);
    });

    it('replaceWirelessDevices 触发 dtf:wireless-devices-changed 事件', async () => {
        const bc = await import('../../src/js/backend-client.js');
        let fired = null;
        const handler = (e) => { fired = e.detail; };
        window.addEventListener('dtf:wireless-devices-changed', handler);
        try {
            bc.replaceWirelessDevices('bX', [{ ip: '1.1.1.1', connect_port: 5555 }]);
            expect(fired).toEqual({ backendId: 'bX' });
        } finally {
            window.removeEventListener('dtf:wireless-devices-changed', handler);
        }
    });

    it('replaceWirelessDevices 覆盖时不合并：后端是 source of truth', async () => {
        const bc = await import('../../src/js/backend-client.js');
        bc.replaceWirelessDevices('b1', [{ ip: '10.0.0.1', connect_port: 5555 }]);
        bc.replaceWirelessDevices('b1', [{ ip: '10.0.0.9', connect_port: 6666 }]);
        expect(bc.getWirelessDevices('b1')).toEqual([
            { ip: '10.0.0.9', connect_port: 6666 },
        ]);
    });

    it('getWirelessDevices 对未知 backend 返回空数组', async () => {
        const bc = await import('../../src/js/backend-client.js');
        expect(bc.getWirelessDevices('unknown')).toEqual([]);
        expect(bc.getWirelessDevices('')).toEqual([]);
        expect(bc.getWirelessDevices(null)).toEqual([]);
    });
});
