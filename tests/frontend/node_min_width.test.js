import { describe, it, expect, beforeEach } from 'vitest';
import { nodeMinWidth, render } from '../../src/js/render.js';
import { state } from '../../src/js/state.js';

describe('nodeMinWidth — 可视列数 × COL_MIN(180)', () => {
    it('0 可视列 → 320', () => {
        expect(nodeMinWidth({}, [false, false])).toBe(320);
    });

    it('1 列 → 180×1 + 0 + 16 + 2 = 198', () => {
        expect(nodeMinWidth({}, [true, false, false])).toBe(198);
    });

    it('3 列 → 180×3 + 2×1 + 16 + 2 = 560', () => {
        expect(nodeMinWidth({}, [true, true, true])).toBe(560);
    });

    it('列数越多最小宽越大（与卡片内容无关）', () => {
        const empty = nodeMinWidth({ info: [], logic: [], groups: [] }, [true, false, false]);
        const full = nodeMinWidth({}, [true, true, true]);
        expect(full).toBeGreaterThan(empty * 2.5);
    });
});

describe('渲染集成 — 节点 minWidth 应用', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="world"></div><div class="canvas"></div><svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
        state.wires = [];
        state.nodes = [];
        state.globalVars = [];
    });

    it('render 后 n.el.style.minWidth = nodeMinWidth（与卡片内容无关）', () => {
        // info(1 text) + 空 operate = 1 列 → 180×1 + 16 + 2 = 198
        const n = {
            id: 'n1', name: 'N', x: 0, y: 0, w: 560, colF: [1, 1, 1.15],
            info: [{ id: 't1', def: 'textT', f: {}, in: {} }], logic: [], groups: [],
            inPorts: ['in'], outPorts: [],
        };
        state.nodes = [n];
        render();
        const expectMin = nodeMinWidth(n, [true, false, false]);   // colHas() 实际值
        expect(expectMin).toBe(198);
        expect(n.el.style.minWidth).toBe(expectMin + 'px');
    });

    it('三列节点最小宽 = 560，与卡片内容无关', () => {
        const n = {
            id: 'n1', name: 'N', x: 0, y: 0, w: 560, colF: [1, 1, 1, 1.15],
            info: [{ id: 't1', def: 'textT', f: {}, in: {} }],
            logic: [[{ id: 't2', def: 'codeT', f: {}, in: {} }]],
            groups: [{ id: 'g1', name: 'G', on: false, ops: [{ id: 't3', def: 'textT', f: {}, in: {} }] }],
            inPorts: ['in'], outPorts: [],
        };
        state.nodes = [n];
        render();
        expect(nodeMinWidth(n, [true, true, true])).toBe(560);
        expect(n.el.style.minWidth).toBe('560px');
    });

    it('goto 节点不应用动态 minWidth（保持默认）', () => {
        const g = {
            id: 'g1', type: 'goto', name: 'goto', x: 0, y: 0, w: 320,
            inPorts: ['in'], target: null, info: [], logic: [], groups: [],
        };
        state.nodes = [g];
        render();
        // goto 节点 elStyle 不含 minWidth → 回退 CSS 320
        expect(g.el.style.minWidth).toBe('');
    });
});
