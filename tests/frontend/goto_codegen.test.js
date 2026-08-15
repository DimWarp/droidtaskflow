import { describe, it, expect, beforeEach } from 'vitest';
import { toPythonDSL, fromPythonDSL } from '../../src/js/datamapper.js';
import { state } from '../../src/js/state.js';

beforeEach(() => {
    state.nodes = [];
    state.wires = [];
    state.projectName = 'test';
    state.globalVars = [];
});

describe('toPythonDSL goto 扁平边', () => {
    it('已接线 goto 入口 → 指向目标标记端口的 edge，不发 goto 入口边', () => {
        state.nodes = [
            { id: 'n1', name: 'A', x: 0, y: 0, w: 560, info: [], logic: [], groups: [], outPorts: ['out'] },
            { id: 'g1', type: 'goto', name: 'goto1', x: 0, y: 0, w: 560, target: 'n2', inPorts: ['in', 'in2'], outPorts: [] },
            { id: 'n2', name: 'D', x: 0, y: 0, w: 560, info: [], logic: [], groups: [], inPorts: ['in'], outPorts: [] },
        ];
        state.wires = [{ from: 'n1.out', to: 'g1.in' }, { from: 'n1.out', to: 'g1.in2' }];
        const dsl = toPythonDSL(state);
        expect(dsl).toContain('@node("g1", name="goto1", type="goto", position={"x":0,"y":0}, target="n2", in_ports=["in","in2"])');
        expect(dsl).toContain('edge("n1", "out", "n2", "g1_in")');
        expect(dsl).toContain('edge("n1", "out", "n2", "g1_in2")');
        expect(dsl).not.toContain('edge("n1", "out", "g1"');
    });

    it('goto 未接线入口不发扁平边', () => {
        state.nodes = [
            { id: 'g1', type: 'goto', name: 'goto1', x: 0, y: 0, w: 560, target: 'n2', inPorts: ['in'], outPorts: [] },
            { id: 'n2', name: 'D', x: 0, y: 0, w: 560, info: [], logic: [], groups: [], inPorts: ['in'], outPorts: [] },
        ];
        state.wires = [];
        const dsl = toPythonDSL(state);
        expect(dsl).not.toContain('edge(');
    });
});

describe('goto 空目标持久化（type 判别）', () => {
    it('toPythonDSL：空目标 goto 恒发射 type="goto"，不发射 target=', () => {
        state.nodes = [
            { id: 'g1', type: 'goto', name: 'goto', x: 0, y: 0, w: 320, target: null, inPorts: ['in'], outPorts: [], info: [], logic: [], groups: [] },
        ];
        const dsl = toPythonDSL(state);
        expect(dsl).toContain('@node("g1", name="goto", type="goto", position={"x":0,"y":0}, width=320)');
        expect(dsl).not.toContain('target=');
        expect(dsl).not.toContain('in_ports=');  // 默认单入口 ['in'] 省略
    });

    it('toPythonDSL：已设目标 goto 同时发射 type + target', () => {
        state.nodes = [
            { id: 'g1', type: 'goto', name: 'goto', x: 0, y: 0, w: 320, target: 'n2', inPorts: ['in'], outPorts: [], info: [], logic: [], groups: [] },
        ];
        const dsl = toPythonDSL(state);
        expect(dsl).toContain('type="goto"');
        expect(dsl).toContain('target="n2"');
    });

    it('fromPythonDSL：type="goto" 且无 target → 还原为空目标 goto', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n1',
            nodes: {
                g1: { id: 'g1', name: 'goto', position: { x: 0, y: 0 }, type: 'goto', width: 320, info_tasks: [], logic_tasks: [], operation_groups: [], exits: {} },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const g = state.nodes.find(n => n.id === 'g1');
        expect(g.type).toBe('goto');
        expect(g.target).toBeNull();
        expect(g.inPorts).toEqual(['in']);
    });

    it('fromPythonDSL：旧格式仅有 target → 仍判别为 goto（向后兼容）', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n1',
            nodes: {
                g1: { id: 'g1', name: 'goto', position: { x: 0, y: 0 }, target: 'n2', info_tasks: [], logic_tasks: [], operation_groups: [], exits: {} },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const g = state.nodes.find(n => n.id === 'g1');
        expect(g.type).toBe('goto');
        expect(g.target).toBe('n2');
    });

    it('round-trip：空目标 goto 加载→重发仍保留 type="goto"', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n1',
            nodes: {
                g1: { id: 'g1', name: 'goto', position: { x: 0, y: 0 }, type: 'goto', width: 320, info_tasks: [], logic_tasks: [], operation_groups: [], exits: {} },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const dsl = toPythonDSL(state);
        expect(dsl).toContain('@node("g1", name="goto", type="goto", position={"x":0,"y":0}');
    });
});

describe('节点 in_ports 持久化（普通节点）', () => {
    it('toPythonDSL：多入口节点发射 in_ports，默认单入口省略', () => {
        state.nodes = [
            { id: 'n1', name: 'A', x: 0, y: 0, w: 560, info: [], logic: [], groups: [], inPorts: ['in', 'in2'], outPorts: ['out'] },
            { id: 'n2', name: 'B', x: 0, y: 0, w: 560, info: [], logic: [], groups: [], inPorts: ['in'], outPorts: ['out'] },
        ];
        const dsl = toPythonDSL(state);
        expect(dsl).toContain('@node("n1", name="A", position={"x":0,"y":0}, in_ports=["in","in2"])');
        expect(dsl).not.toContain('@node("n2", name="B", position={"x":0,"y":0}, in_ports');
    });

    it('fromPythonDSL：读回 node.in_ports', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n1',
            nodes: {
                n1: { id: 'n1', name: 'A', position: { x: 0, y: 0 }, in_ports: ['in', 'in2'], info_tasks: [], logic_tasks: [], operation_groups: [], exits: {} },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const n = state.nodes.find(x => x.id === 'n1');
        expect(n.inPorts).toEqual(['in', 'in2']);
    });

    it('round-trip：多入口节点重载后仍有多入口', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n1',
            nodes: {
                n1: { id: 'n1', name: 'A', position: { x: 0, y: 0 }, in_ports: ['in', 'in2'], info_tasks: [], logic_tasks: [], operation_groups: [], exits: {} },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const dsl = toPythonDSL(state);
        expect(dsl).toContain('@node("n1", name="A", position={"x":0,"y":0}, in_ports=["in","in2"])');
    });
});

describe('fromPythonDSL goto 回读', () => {
    it('扁平边还原为 goto 入口线并从 wires 移除', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n1',
            nodes: {
                n1: { id: 'n1', name: 'A', position: { x: 0, y: 0 }, info_tasks: [], logic_tasks: [], operation_groups: [], exits: {} },
                g1: { id: 'g1', name: 'goto1', position: { x: 0, y: 0 }, target: 'n2', in_ports: ['in'], info_tasks: [], logic_tasks: [], operation_groups: [], exits: {} },
                n2: { id: 'n2', name: 'D', position: { x: 0, y: 0 }, info_tasks: [], logic_tasks: [], operation_groups: [], exits: {} },
            },
            edges: [{ from_node: 'n1', from_exit: 'out', to_node: 'n2', to_port: 'g1_in' }],
        };
        fromPythonDSL(pyDict, state);
        const g = state.nodes.find(n => n.id === 'g1');
        expect(g.type).toBe('goto');
        expect(g.target).toBe('n2');
        expect(g.inPorts).toContain('in');
        expect(state.wires).toContainEqual({ from: 'n1.out', to: 'g1.in' });
        expect(state.wires.some(w => w.to === 'n2.g1_in')).toBe(false);
    });

    it('fromPythonDSL：in_ports 重复入口去重（防御已损坏文件）', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n1',
            nodes: {
                g1: { id: 'g1', name: 'goto', position: { x: 0, y: 0 }, type: 'goto', in_ports: ['in', 'in2', 'in2'], info_tasks: [], logic_tasks: [], operation_groups: [], exits: {} },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const g = state.nodes.find(n => n.id === 'g1');
        expect(g.type).toBe('goto');
        expect(g.inPorts).toEqual(['in', 'in2']);
    });
});
