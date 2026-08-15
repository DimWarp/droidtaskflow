import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state } from '../../src/js/state.js';
import { setLang } from '../../src/js/i18n.js';

// 这些测试断言中文文案，锁定语言为中文
setLang('zh');

describe('backend-dialog: 测试按钮 + 添加按钮', () => {
    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = '';
        state.selectedDeviceByBackend = {};
    });

    it('dialog 包含三个按钮: 取消 / 测试 / 添加', async () => {
        const dlg = await import('../../src/js/backend-dialog.js');
        const p = dlg.openAddBackendDialog();
        expect(document.querySelector('[data-act="cancel"]')).not.toBeNull();
        expect(document.querySelector('[data-act="test"]')).not.toBeNull();
        expect(document.querySelector('[data-act="ok"]')).not.toBeNull();
        // 点取消清理 DOM,免影响下个测试
        document.querySelector('[data-act="cancel"]').click();
        await p;
    });

    it('点击"添加"返回 {host, port, name},不连接', async () => {
        const dlg = await import('../../src/js/backend-dialog.js');
        const bc = await import('../../src/js/backend-client.js');
        const connectSpy = vi.spyOn(bc.BackendClient.prototype, 'connect').mockResolvedValue();

        const p = dlg.openAddBackendDialog();
        document.querySelector('[data-name="host"]').value = '192.168.1.5';
        document.querySelector('[data-name="port"]').value = '9000';
        document.querySelector('[data-name="name"]').value = 'dev-box';
        document.querySelector('[data-act="ok"]').click();
        const r = await p;

        expect(r).toEqual({ host: '192.168.1.5', port: 9000, name: 'dev-box' });
        expect(connectSpy).not.toHaveBeenCalled();  // 关键:不再自动连接
    });

    it('点击"测试"显示 spinner,完成后恢复', async () => {
        const dlg = await import('../../src/js/backend-dialog.js');
        // mock fetch
        global.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    http: 'ok', ws: 'ok', device_list: 'ok', total: 'ok',
                }),
            })
        );

        const p = dlg.openAddBackendDialog();
        document.querySelector('[data-name="host"]').value = 'h';
        document.querySelector('[data-name="port"]').value = '1';

        const $test = document.querySelector('[data-act="test"]');
        const $spinner = $test.querySelector('.dlg__test-spinner');
        const $label = $test.querySelector('.dlg__test-label');
        // 初始:spinner 隐藏 + label 显示"测试"
        expect($spinner.hidden).toBe(true);
        expect($label.hidden).toBe(false);
        expect($label.textContent).toBe('测试');

        $test.click();
        // 测试中:spinner 显示 + label 隐藏(替换,不是改字)
        expect($spinner.hidden).toBe(false);
        expect($label.hidden).toBe(true);
        expect($label.textContent).toBe('测试');  // 文字不变
        expect($test.disabled).toBe(true);

        // 等 fetch promise 完成
        await new Promise(r => setTimeout(r, 10));
        // 完成后恢复
        expect($spinner.hidden).toBe(true);
        expect($label.hidden).toBe(false);
        expect($test.disabled).toBe(false);

        // 清理:点取消
        document.querySelector('[data-act="cancel"]').click();
        await p;
    });

    it('测试通过 → toast 显示"连接测试通过"', async () => {
        const dlg = await import('../../src/js/backend-dialog.js');
        const stateMod = await import('../../src/js/state.js');
        const toastSpy = vi.spyOn(stateMod, 'toast').mockImplementation(() => {});
        global.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    http: 'ok', ws: 'ok', device_list: 'ok', total: 'ok',
                }),
            })
        );
        try {
            const p = dlg.openAddBackendDialog();
            document.querySelector('[data-name="host"]').value = 'h';
            document.querySelector('[data-name="port"]').value = '1';
            document.querySelector('[data-act="test"]').click();
            await new Promise(r => setTimeout(r, 10));
            expect(toastSpy).toHaveBeenCalled();
            expect(toastSpy.mock.calls[0][0]).toMatch(/连接测试通过/);
            document.querySelector('[data-act="cancel"]').click();
            await p;
        } finally {
            toastSpy.mockRestore();
        }
    });

    it('测试失败 → toast 列出哪几项失败(无 emoji)', async () => {
        const dlg = await import('../../src/js/backend-dialog.js');
        const stateMod = await import('../../src/js/state.js');
        const toastSpy = vi.spyOn(stateMod, 'toast').mockImplementation(() => {});
        global.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    http: 'ok', ws: 'failed', device_list: 'failed', total: 'failed',
                }),
            })
        );
        try {
            const p = dlg.openAddBackendDialog();
            document.querySelector('[data-name="host"]').value = 'h';
            document.querySelector('[data-name="port"]').value = '1';
            document.querySelector('[data-act="test"]').click();
            await new Promise(r => setTimeout(r, 10));
            expect(toastSpy).toHaveBeenCalled();
            const msg = toastSpy.mock.calls[0][0];
            expect(msg).toMatch(/失败/);
            expect(msg).toMatch(/WS 失败/);
            expect(msg).toMatch(/设备列表 失败/);
            expect(msg).not.toMatch(/[❌✅]/);  // 无 emoji
            document.querySelector('[data-act="cancel"]').click();
            await p;
        } finally {
            toastSpy.mockRestore();
        }
    });

    it('测试 endpoint 网络错(fetch reject)→ 全部标记 failed', async () => {
        const dlg = await import('../../src/js/backend-dialog.js');
        const stateMod = await import('../../src/js/state.js');
        const toastSpy = vi.spyOn(stateMod, 'toast').mockImplementation(() => {});
        global.fetch = vi.fn(() => Promise.reject(new Error('NetworkError')));
        try {
            const p = dlg.openAddBackendDialog();
            document.querySelector('[data-name="host"]').value = 'h';
            document.querySelector('[data-name="port"]').value = '1';
            document.querySelector('[data-act="test"]').click();
            await new Promise(r => setTimeout(r, 10));
            expect(toastSpy).toHaveBeenCalled();
            const msg = toastSpy.mock.calls[0][0];
            expect(msg).toMatch(/失败/);
            expect(msg).toMatch(/NetworkError/);
            document.querySelector('[data-act="cancel"]').click();
            await p;
        } finally {
            toastSpy.mockRestore();
        }
    });

    it('添加时 host 为空 → 弹错误,不关闭对话框', async () => {
        const dlg = await import('../../src/js/backend-dialog.js');
        const p = dlg.openAddBackendDialog();
        document.querySelector('[data-name="host"]').value = '';
        document.querySelector('[data-name="port"]').value = '1';
        document.querySelector('[data-act="ok"]').click();
        const $err = document.querySelector('.dlg__error');
        expect($err.hidden).toBe(false);
        expect($err.textContent).toMatch(/主机/);
        // 对话框还开着,DOM 还在
        expect(document.querySelector('.dlg-backdrop')).not.toBeNull();
        document.querySelector('[data-act="cancel"]').click();
        await p;
    });

    it('openEditBackendDialog 预填 host/port/name', async () => {
        const dlg = await import('../../src/js/backend-dialog.js');
        const p = dlg.openEditBackendDialog({ host: 'h', port: 9000, name: 'box' });
        expect(document.querySelector('[data-name="host"]').value).toBe('h');
        expect(document.querySelector('[data-name="port"]').value).toBe('9000');
        expect(document.querySelector('[data-name="name"]').value).toBe('box');
        // "保存"按钮文本(不是"添加")
        expect(document.querySelector('[data-act="ok"]').textContent).toBe('保存');
        document.querySelector('[data-act="cancel"]').click();
        await p;
    });

    it('打开 dialog 时测试按钮 spinner 不在转(回归:hidden + display 冲突)', async () => {
        const dlg = await import('../../src/js/backend-dialog.js');
        const p = dlg.openAddBackendDialog();
        const $spinner = document.querySelector('.dlg__test-spinner');
        // spinner 必须 hidden:true 且 getComputedStyle 不可见
        expect($spinner.hidden).toBe(true);
        // jsdom 不算 display,但我们可以通过 CSS 规则检查修复存在
        document.querySelector('[data-act="cancel"]').click();
        await p;
    });

    it('CSS 保证 .dlg__test-spinner[hidden] 真的 display:none', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        // 关键修复:CSS 必须显式覆盖 display:inline-block,让 [hidden] 真的隐藏
        expect(css).toMatch(/\.dlg__test-spinner\[hidden\][^{]*\{\s*display:\s*none/);
    });

    it('测试按钮有 min-width 锁定宽度,spinner↔文字互换不抖', async () => {
        const fs = await import('fs');
        const css = fs.readFileSync('src/styles/main.css', 'utf8');
        // min-width 必须在 .dlg__test 规则里(保证两种状态下按钮宽度一致)
        const m = css.match(/\.dlg__footer\s+\.dlg__test\s*\{([^}]+)\}/);
        expect(m).toBeTruthy();
        expect(m[1]).toMatch(/min-width/);
    });

    it('点击弹窗外部(backdrop)不关闭对话框,只能点"取消"或"添加"', async () => {
        const dlg = await import('../../src/js/backend-dialog.js');
        let resolved = false;
        const p = dlg.openAddBackendDialog().then((r) => { resolved = true; return r; });
        const $backdrop = document.querySelector('.dlg-backdrop');
        // 填一半数据
        document.querySelector('[data-name="host"]').value = '192.168.1.5';
        // 模拟点 backdrop(用户可能误点)
        $backdrop.click();
        await new Promise(r => setTimeout(r, 10));
        expect(resolved).toBe(false);  // promise 没 resolve,对话框还在
        expect(document.querySelector('.dlg-backdrop')).not.toBeNull();  // DOM 还在
        expect(document.querySelector('[data-name="host"]').value).toBe('192.168.1.5');  // 数据没丢
        // 走"取消"清理
        document.querySelector('[data-act="cancel"]').click();
        const r = await p;
        expect(r).toBeNull();
    });
});