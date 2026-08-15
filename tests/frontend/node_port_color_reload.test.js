import { describe, it, expect, beforeEach } from 'vitest';
import { fromPythonDSL } from '../../src/js/datamapper.js';
import { render } from '../../src/js/render.js';
import { state } from '../../src/js/state.js';

/**
 * 回归：重载后节点入口口颜色丢失。
 * 用户案例：DSL 中目标节点（带 in_ports=["in2"]）声明在源节点之前，
 * edge("源", "out1", "目标", "in2")。loadProjectFile 只 render() 一次，
 * 若入口口颜色在渲染循环内读源节点 _ncols，目标先于源渲染 → 首帧无色。
 */
describe('重载后节点入口口颜色（_ncols 渲染顺序）', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="world"></div><div class="canvas"></div><svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
        state.wires = [];
        state.nodes = [];
        state.globalVars = [];
    });

    it('目标节点在 DSL 中先于源节点 → 单次 render 后入口口颜色 = 源出口颜色', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n0',
            nodes: {
                // 顺序 = DSL 声明顺序：起始 → 目标 → 源
                n0: { id: 'n0', name: 'start', position: { x: 0, y: 0 }, info_tasks: [], logic_tasks: [], operation_groups: [], exits: {} },
                nT: { id: 'nT', name: '目标', position: { x: 100, y: 0 }, info_tasks: [], logic_tasks: [], operation_groups: [], exits: {}, in_ports: ['in2'] },
                nS: { id: 'nS', name: '源', position: { x: 200, y: 0 }, info_tasks: [], logic_tasks: [], operation_groups: [{ id: 'g1', name: 'G1', forced: false, operations: [] }], exits: { out1: { name: 'out1', label: 'out1' } } },
            },
            edges: [{ from_node: 'nS', from_exit: 'out1', to_node: 'nT', to_port: 'in2' }],
        };
        fromPythonDSL(pyDict, state);
        // loadProjectFile 只调用一次 render()
        render();

        const srcPort = document.querySelector('[data-src="nS.out1"]');
        const tgtPort = document.querySelector('[data-src="nT.in2"]');
        expect(srcPort).toBeTruthy();
        expect(tgtPort).toBeTruthy();
        const srcC = srcPort.style.getPropertyValue('--port-c').trim();
        expect(srcC).not.toBe('');
        // 目标先于源渲染，首帧也应拿到颜色
        expect(tgtPort.style.getPropertyValue('--port-c').trim()).toBe(srcC);
    });

    it('源节点在 DSL 中先于目标 → 单次 render 后入口口颜色正常（对照组）', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n0',
            nodes: {
                n0: { id: 'n0', name: 'start', position: { x: 0, y: 0 }, info_tasks: [], logic_tasks: [], operation_groups: [], exits: {} },
                nS: { id: 'nS', name: '源', position: { x: 200, y: 0 }, info_tasks: [], logic_tasks: [], operation_groups: [{ id: 'g1', name: 'G1', forced: false, operations: [] }], exits: { out1: { name: 'out1', label: 'out1' } } },
                nT: { id: 'nT', name: '目标', position: { x: 100, y: 0 }, info_tasks: [], logic_tasks: [], operation_groups: [], exits: {}, in_ports: ['in2'] },
            },
            edges: [{ from_node: 'nS', from_exit: 'out1', to_node: 'nT', to_port: 'in2' }],
        };
        fromPythonDSL(pyDict, state);
        render();

        const srcPort = document.querySelector('[data-src="nS.out1"]');
        const tgtPort = document.querySelector('[data-src="nT.in2"]');
        expect(srcPort).toBeTruthy();
        expect(tgtPort).toBeTruthy();
        const srcC = srcPort.style.getPropertyValue('--port-c').trim();
        expect(srcC).not.toBe('');
        expect(tgtPort.style.getPropertyValue('--port-c').trim()).toBe(srcC);
    });
});
