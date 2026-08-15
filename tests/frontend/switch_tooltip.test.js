import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { state, DEFS } from '../../src/js/state.js';
import { render } from '../../src/js/render.js';
import { setFocusedNodeId, setFocusedCardId } from '../../src/js/shared.js';
import { initClipboard } from '../../src/js/clipboard.js';
import { initTooltip } from '../../src/js/tooltip.js';
import { setLang } from '../../src/js/i18n.js';

beforeAll(() => { initClipboard(); });

beforeEach(() => {
    document.body.innerHTML = '<div id="world"></div><div class="canvas"></div>'
        + '<svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
    state.wires = [];
    state.nodes = [];
    state.globalVars = [];
    state.zoom = 1;
    setFocusedNodeId(null);
    setFocusedCardId(null);
    DEFS['tap'] = { name: 'tap', alias: 'Tap', params: [], rets: [] };
    initTooltip();
    setLang('zh');
    vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

function nodeWithGroup(on) {
    return [{
        id: 'n1', name: 'N', x: 0, y: 0, w: 560, colF: [1, 1, 1.15],
        info: [], logic: [], inPorts: ['in'], outPorts: ['out'],
        groups: [{ id: 'g1', name: 'G1', on, ops: [{ id: 't1', def: 'tap', f: {}, in: {} }] }],
    }];
}

describe('组强制启用开关 tooltip（canvas.switchOn / canvas.switchOff）', () => {
    it('关闭态 label 带 data-tooltip="canvas.switchOff"，悬浮显示对应文本', () => {
        state.nodes = nodeWithGroup(false);
        render();

        const sw = document.querySelector('[data-group-id="g1"] .switch');
        expect(sw).toBeTruthy();
        expect(sw.getAttribute('data-tooltip')).toBe('canvas.switchOff');

        sw.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
        vi.advanceTimersByTime(600);
        const tip = document.querySelector('.app-tooltip');
        expect(tip.classList.contains('app-tooltip--show')).toBe(true);
        expect(tip.textContent).toBe('强制启用（点击开启）');
    });

    it('开启态 label 带 data-tooltip="canvas.switchOn"，悬浮显示对应文本', () => {
        state.nodes = nodeWithGroup(true);
        render();

        const sw = document.querySelector('[data-group-id="g1"] .switch');
        expect(sw.getAttribute('data-tooltip')).toBe('canvas.switchOn');

        sw.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
        vi.advanceTimersByTime(600);
        expect(document.querySelector('.app-tooltip').textContent).toBe('强制启用（已开启）');
    });

    it('点击切换后重渲染，tooltip key 跟随状态翻转', () => {
        state.nodes = nodeWithGroup(false);
        render();

        const sw = document.querySelector('[data-group-id="g1"] .switch');
        sw.dispatchEvent(new MouseEvent('click', { bubbles: true }));   // g.on=false → true，内部 render()

        const sw2 = document.querySelector('[data-group-id="g1"] .switch');
        expect(sw2).not.toBe(sw);                                        // 重渲染生成新 label
        expect(sw2.getAttribute('data-tooltip')).toBe('canvas.switchOn');
    });
});
