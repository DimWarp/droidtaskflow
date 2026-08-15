import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state } from '../../src/js/state.js';

describe('BackendClient device_screenshot', () => {
    let client;
    let fakeWs;

    beforeEach(async () => {
        // 重置 state.devicePreview
        state.devicePreview.inflightSerial = null;
        state.devicePreview.fetching = false;
        state.devicePreview.source = null;

        // mock WebSocket — 模拟 OPEN 状态
        fakeWs = {
            readyState: 1, // OPEN
            sent: [],
            send(msg) { this.sent.push(JSON.parse(msg)); },
            close() {},
        };
        global.WebSocket = function() { return fakeWs; };

        const mod = await import('../../src/js/backend-client.js');
        client = new mod.BackendClient({ host: 'h', port: 1, name: 't' });
        // 替换内部 _ws 为我们的 fakeWs + 标记为 connected
        client._ws = fakeWs;
        client._state = 'connected';
    });

    it('requestDeviceScreenshot sends correct WS message', () => {
        client.requestDeviceScreenshot('S49');
        expect(fakeWs.sent).toContainEqual({ type: 'device_screenshot_req', serial: 'S49' });
    });

    it('requestDeviceScreenshot sets inflightSerial + fetching', () => {
        client.requestDeviceScreenshot('S49');
        expect(state.devicePreview.inflightSerial).toBe('S49');
        expect(state.devicePreview.fetching).toBe(true);
    });

    it('requestDeviceScreenshot returns false when not connected', async () => {
        const mod = await import('../../src/js/backend-client.js');
        const c2 = new mod.BackendClient({ host: 'h2', port: 2 });
        // state is disconnected by default
        expect(c2.requestDeviceScreenshot('X')).toBe(false);
    });

    it('onDeviceScreenshot invokes handler with decoded blob', () => {
        const handler = vi.fn();
        client.setDeviceScreenshotHandler(handler);
        // 构造 1x1 PNG (720x1280 用 _png_dimensions 也能解析, 但这里简化)
        // 用 24 字节 PNG header
        const fakePngBytes = new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d,
            0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x02, 0xd0,  // width=720
            0x00, 0x00, 0x05, 0x00,  // height=1280
        ]);
        // base64
        let bin = '';
        for (let i = 0; i < fakePngBytes.length; i++) bin += String.fromCharCode(fakePngBytes[i]);
        const b64 = btoa(bin);

        // 设 inflightSerial 匹配
        state.devicePreview.inflightSerial = 'S49';
        state.devicePreview.fetching = true;

        // 触发消息处理：直接调 _dispatch
        client._dispatch({
            type: 'device_screenshot',
            serial: 'S49',
            png_b64: b64,
            width: 720,
            height: 1280,
        });
        expect(handler).toHaveBeenCalledOnce();
        const call = handler.mock.calls[0][0];
        expect(call.serial).toBe('S49');
        expect(call.width).toBe(720);
        expect(call.height).toBe(1280);
        expect(call.blob).toBeInstanceOf(Blob);
        expect(call.blob.type).toBe('image/png');
    });

    it('onDeviceScreenshot race guard drops stale response', () => {
        const handler = vi.fn();
        client.setDeviceScreenshotHandler(handler);
        state.devicePreview.inflightSerial = 'S1';  // 当前 in-flight 是 S1
        client._dispatch({
            type: 'device_screenshot',
            serial: 'S2',  // 但回来的是 S2 → 应丢弃
            png_b64: '',
            width: 100, height: 100,
        });
        expect(handler).not.toHaveBeenCalled();
    });

    it('onDeviceScreenshot clears inflightSerial on success', () => {
        const handler = vi.fn();
        client.setDeviceScreenshotHandler(handler);
        state.devicePreview.inflightSerial = 'S49';
        client._dispatch({
            type: 'device_screenshot',
            serial: 'S49',
            png_b64: 'AAAA',
            width: 10, height: 10,
        });
        expect(state.devicePreview.inflightSerial).toBeNull();
        expect(state.devicePreview.fetching).toBe(false);
    });

    it('onDeviceScreenshot resets pickedPoint to null', () => {
        const handler = vi.fn();
        client.setDeviceScreenshotHandler(handler);
        state.devicePreview.pickedPoint = { x: 100, y: 100, rgb: [255, 0, 0] };
        client._dispatch({
            type: 'device_screenshot',
            serial: 'S1',
            png_b64: 'AAAA',
            width: 10, height: 10,
        });
        expect(state.devicePreview.pickedPoint).toBeNull();
    });

    it('error message during screenshot invokes error handler and resets state', () => {
        const errHandler = vi.fn();
        client.setDeviceScreenshotErrorHandler(errHandler);
        state.devicePreview.fetching = true;
        state.devicePreview.inflightSerial = 'S49';
        client._dispatch({
            type: 'error',
            run_id: '',
            message: 'device offline',
        });
        expect(errHandler).toHaveBeenCalledWith('device offline');
        expect(state.devicePreview.fetching).toBe(false);
        expect(state.devicePreview.inflightSerial).toBeNull();
    });
});