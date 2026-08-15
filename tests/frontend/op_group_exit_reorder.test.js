import { describe, it, expect } from 'vitest';
import { state } from '../../src/js/state.js';
import { toPythonDSL, fromPythonDSL } from '../../src/js/datamapper.js';
import { normalizeExits } from '../../src/js/render.js';

// ============================================================
// 操作组重排不改变各组出口归属（exit 是组的持久化属性）
// ============================================================
// 回归：以前 normalizeExits 按下标重新配对 g.exit = outPorts[i]，拖拽交换两个
// 操作组的先后次序后，两组出口名随之交换 → 指向的下一节点也交换（错误）。
// 出口名是运行时匹配 edge.from_exit 的语义键，必须随组持久化。

describe('normalizeExits — 重排后 exit 随组保持', () => {
    it('交换两组次序：各组建久化 exit 不变，outPorts 顺序跟随组顺序', () => {
        const n = {
            id: 'n1',
            groups: [{ id: 'g1', exit: 'out' }, { id: 'g2', exit: 'out2' }],
            outPorts: ['out', 'out2'],
        };
        // 模拟拖拽交换：g2 拖到 g1 前面
        n.groups = [n.groups[1], n.groups[0]];
        normalizeExits(n);
        expect(n.groups[0].exit).toBe('out2');   // 不随下标变成 out
        expect(n.groups[1].exit).toBe('out');
        // 出口列表顺序 = 组顺序（端口与组行对齐），名字 = 各组建久化出口
        expect(n.outPorts).toEqual(['out2', 'out']);
        expect(n.groups[0].outTo).toBe('n1.out2');
        expect(n.groups[1].outTo).toBe('n1.out');
    });

    it('重复调用不漂移（幂等）', () => {
        const n = {
            id: 'n1',
            groups: [{ id: 'g2', exit: 'out2' }, { id: 'g1', exit: 'out' }],
            outPorts: ['out2', 'out'],
        };
        normalizeExits(n);
        normalizeExits(n);
        expect(n.groups[0].exit).toBe('out2');
        expect(n.groups[1].exit).toBe('out');
    });

    it('缺 exit 的组仍按旧名池/序列派生（向后兼容）', () => {
        // 旧文件：@node_exit 声明了 out/out2，但组不带 exit= → 按序取旧名
        const n = { id: 'n1', groups: [{ id: 'g1' }, { id: 'g2' }], outPorts: ['out', 'out2'] };
        normalizeExits(n);
        expect(n.groups[0].exit).toBe('out');
        expect(n.groups[1].exit).toBe('out2');
        expect(n.outPorts).toEqual(['out', 'out2']);
    });
});

describe('toPythonDSL — exit= 取组持久化出口', () => {
    it('重排后 g2 在前，其 exit= 仍为 out2（不按新下标写成 out）', () => {
        state.projectName = 't';
        state.globalVars = [];
        state.wires = [];
        state.nodes = [{
            id: 'n1', name: 'n1', x: 0, y: 0, w: 0, colF: null, outPorts: ['out', 'out2'],
            info: [], logic: [], groups: [
                { id: 'g2', name: 'G2', on: true, ops: [], in: {}, exit: 'out2' },
                { id: 'g1', name: 'G1', on: true, ops: [], in: {}, exit: 'out' },
            ],
        }];
        const code = toPythonDSL(state);
        const g2Line = code.split('\n').find(l => l.includes('"g2"'));
        const g1Line = code.split('\n').find(l => l.includes('"g1"'));
        expect(g2Line).toContain('exit="out2"');
        expect(g1Line).toContain('exit="out"');
    });
});

describe('fromPythonDSL — 读入并保留组 exit 字段', () => {
    it('组 exit 不按下标重新配对', () => {
        state.nodes = [];
        const pyDict = {
            metadata: { name: 't' }, global_vars: {},
            nodes: {
                n1: {
                    name: 'n1', position: { x: 0, y: 0 },
                    exits: { out: {}, out2: {} }, info_tasks: [], logic_tasks: [],
                    operation_groups: [
                        { id: 'g2', name: 'G2', forced: true, exit: 'out2', operations: [] },
                        { id: 'g1', name: 'G1', forced: true, exit: 'out', operations: [] },
                    ],
                },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const n = state.nodes[0];
        expect(n.groups[0].exit).toBe('out2');
        expect(n.groups[1].exit).toBe('out');
    });
});
