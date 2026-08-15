import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../../src/js/state.js';
import { render } from '../../src/js/render.js';

// 节点拖动期间用 transform: translate 搬动（不触发布局/重绘，合成器移动），
// 松手才把最终位置落回 left/top 并清掉 transform / will-change。

describe('节点拖动 transform 方案', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="world"></div><div class="canvas"></div>'
            + '<svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
        state.wires = [];
        state.nodes = [];
        state.globalVars = [];
        state.zoom = 1;
        state.nodes = [{
            id: 'n1', name: 'N', x: 100, y: 50, w: 560, colF: [1, 1, 1.15],
            info: [], logic: [], groups: [],
            inPorts: ['in'], outPorts: [],
        }];
        render();
    });

    it('拖动中：left/top 不动，transform=translate(位移)，n.x/n.y 已更新', () => {
        const n = state.nodes[0];
        const hdr = document.querySelector('.node__header');
        hdr.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 200, clientY: 100 }));
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, button: 0, clientX: 240, clientY: 120 }));

        expect(n.x).toBeCloseTo(140);
        expect(n.y).toBeCloseTo(70);
        expect(n.el.style.transform).toBe('translate(40px, 20px)');
        expect(n.el.style.left).toBe('100px');   // 拖动期 left/top 不动，位置靠 transform
        expect(n.el.style.top).toBe('50px');
    });

    it('松手：transform 清空，最终位置落回 left/top，will-change 复位', () => {
        const n = state.nodes[0];
        const hdr = document.querySelector('.node__header');
        hdr.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 200, clientY: 100 }));
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, button: 0, clientX: 240, clientY: 120 }));
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

        expect(n.el.style.transform).toBe('');
        expect(n.el.style.willChange).toBe('');
        expect(n.el.style.left).toBe('140px');
        expect(n.el.style.top).toBe('70px');
        expect(n.x).toBe(140);
        expect(n.y).toBe(70);
    });
});
