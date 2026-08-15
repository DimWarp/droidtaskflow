import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../../src/js/state.js';
import { render } from '../../src/js/render.js';
import { drawWires, setHoveredWire } from '../../src/js/wires.js';

describe('wire-delete X 点击删除连线', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="world"></div><div class="canvas"></div>'
            + '<svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
        state.wires = [];
        state.nodes = [];
        setHoveredWire(null);
    });

    it('hover 后 X 可交互（pointer-events:all），点击 X 删除该线且其他线保留', () => {
        // 源节点带操作组 → 出口 out1；跨节点线 n1.out1 → g1.in
        state.nodes = [
            { id: 'n1', type: 'normal', name: 'src', x: 0, y: 0, w: 560, info: [], logic: [], groups: [{ id: 'grp1', name: 'G', on: true, ops: [], in: {} }], inPorts: ['in'], outPorts: [] },
            { id: 'g1', type: 'goto', name: 'goto', x: 0, y: 200, w: 320, inPorts: ['in'], target: null, info: [], logic: [], groups: [] },
        ];
        render();           // 派生出口 out1
        render();
        state.wires = [
            { id: 'w1', from: 'n1.out1', to: 'g1.in' },
            { id: 'w2', from: 'n1.out1', to: 'n1.in' },   // 同节点内自环（仅作计数参照，不参与删除）
        ];
        // w2 目标 n1.in 存在但同节点 → intra；确保两个 wire 都能渲染出
        drawWires();
        const del = document.querySelector('.wire-delete');
        expect(del).toBeTruthy();
        // 未 hover：pointer-events:none（不可交互）
        expect(del.style.pointerEvents).toBe('none');
        // hover 该线 → X 可交互
        setHoveredWire('w1');
        drawWires();
        const delHovered = document.querySelector('.wire-delete[data-wire="w1"]');
        expect(delHovered.style.pointerEvents).toBe('all');
        // 点击 X → 删除 w1，w2 保留
        delHovered.dispatchEvent(new Event('click', { bubbles: true }));
        expect(state.wires.map(w => w.id)).toEqual(['w2']);
    });
});

describe('drawWires(skipInternal) — 平移帧跳过节点内连线重建', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="world"></div><div class="canvas"></div>'
            + '<svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
        state.wires = [];
        state.nodes = [];
        setHoveredWire(null);
        // n0 占 start 位（start 无入 rail）→ n1 才有 n1.in 端口，自环线才能画进节点内
        state.nodes = [
            { id: 'n0', type: 'normal', name: 'start', x: 0, y: 0, w: 560, info: [], logic: [], groups: [], inPorts: ['in'], outPorts: [] },
            { id: 'n1', type: 'normal', name: 'src', x: 0, y: 0, w: 560, info: [], logic: [], groups: [{ id: 'grp1', name: 'G', on: true, ops: [], in: {} }], inPorts: ['in'], outPorts: [] },
            { id: 'g1', type: 'goto', name: 'goto', x: 0, y: 200, w: 320, inPorts: ['in'], target: null, info: [], logic: [], groups: [] },
        ];
        render();   // 派生出口 out1
        render();
        state.wires = [
            { id: 'w1', from: 'n1.out1', to: 'g1.in' },   // 跨节点
            { id: 'w2', from: 'n1.out1', to: 'n1.in' },   // 同节点自环（intra）
        ];
    });

    it('skipInternal=true 不清空/不重建节点内 .node__wires，外部删除钮仍重建', () => {
        drawWires();   // 全量：写出节点内路径
        const ns = state.nodes[1].el.querySelector('.node__wires');
        const fullHtml = ns.innerHTML;
        expect(fullHtml).toContain('w2');   // intra 线已画进节点内 SVG

        // 平移帧：只重画外部 cross/delete，节点内路径保持不动（随 world transform 自动平移）
        drawWires(true);
        expect(ns.innerHTML).toBe(fullHtml);
        // 跨节点 + 节点内两条线的删除钮都在外部 deleteBtnSVG，仍重建
        expect(document.querySelectorAll('.wire-delete').length).toBe(2);
    });

    it('平移结束的全量 drawWires() 恢复重建节点内路径', () => {
        drawWires(true);
        drawWires();   // endPan 全量
        const ns = state.nodes[1].el.querySelector('.node__wires');
        expect(ns.innerHTML).toContain('w2');
        expect(document.querySelectorAll('.wire-delete').length).toBe(2);
    });
});
