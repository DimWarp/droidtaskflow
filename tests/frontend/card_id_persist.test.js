import { describe, it, expect, beforeEach } from 'vitest';
import { toPythonDSL, fromPythonDSL } from '../../src/js/datamapper.js';
import { state, DEFS } from '../../src/js/state.js';

beforeEach(() => {
    state.nodes = [];
    state.wires = [];
    state.projectName = 'test';
    state.globalVars = [];
    DEFS['ocr'] = { name: 'ocr', alias: 'OCR', params: [], rets: [] };
    DEFS['math'] = { name: 'math', alias: 'Math', params: [], rets: [] };
    DEFS['tap'] = { name: 'tap', alias: 'Tap', params: [], rets: [] };
});

describe('toPythonDSL 卡片 id 持久化', () => {
    it('三类任务装饰器都发射 id=', () => {
        state.nodes = [{
            id: 'n1', name: 'N', x: 0, y: 0, w: 560, outPorts: ['out'],
            info: [{ id: 't100', def: 'ocr', f: {}, in: {} }],
            logic: [[{ id: 't101', def: 'math', f: {}, in: {} }]],
            groups: [{ id: 'g1', name: 'g1', on: false, ops: [{ id: 't102', def: 'tap', f: {}, in: {} }] }],
        }];
        const dsl = toPythonDSL(state);
        expect(dsl).toContain('@node_info_task("ocr", alias="OCR", id="t100")');
        expect(dsl).toContain('@node_logic_task("math", alias="Math", id="t101")');
        expect(dsl).toContain('@node_op_group_task("tap", alias="Tap", id="t102")');
    });
});

describe('fromPythonDSL 卡片 id 读回', () => {
    it('显式 id 原样还原（info/logic/op）', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n1',
            nodes: {
                n1: {
                    id: 'n1', name: 'N', position: { x: 0, y: 0 },
                    info_tasks: [{ id: 't1786196322037', task_name: 'ocr', param_values: {}, wire_inputs: {} }],
                    logic_tasks: [{ id: 't5', task_name: 'math', column: 0, param_values: {}, wire_inputs: {} }],
                    operation_groups: [{
                        id: 'g1', name: 'g1', forced: false,
                        operations: [{ id: 't7', task_name: 'tap', param_values: {}, wire_inputs: {} }],
                    }],
                    exits: {},
                },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const n = state.nodes[0];
        expect(n.info[0].id).toBe('t1786196322037');
        expect(n.logic[0][0].id).toBe('t5');
        expect(n.groups[0].ops[0].id).toBe('t7');
    });

    it('旧文件（无 id）按位置生成 t1/t2...', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n1',
            nodes: {
                n1: {
                    id: 'n1', name: 'N', position: { x: 0, y: 0 },
                    info_tasks: [
                        { task_name: 'ocr', param_values: {}, wire_inputs: {} },
                        { task_name: 'ocr', param_values: {}, wire_inputs: {} },
                    ],
                    logic_tasks: [], operation_groups: [], exits: {},
                },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const n = state.nodes[0];
        expect(n.info[0].id).toBe('t1');
        expect(n.info[1].id).toBe('t2');
    });

    it('显式 id 的卡片连线读回指向原 id', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n1',
            nodes: {
                n1: {
                    id: 'n1', name: 'N', position: { x: 0, y: 0 },
                    info_tasks: [{ id: 't100', task_name: 'ocr', param_values: {}, wire_inputs: { input: 'dev.read' } }],
                    logic_tasks: [], operation_groups: [], exits: {},
                },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        expect(state.wires).toContainEqual({ from: 'dev.read', to: 't100.input' });
    });
});

describe('round-trip：id 跨 from→to 稳定', () => {
    it('显式 id 加载后重新发射仍保留原 id', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n1',
            nodes: {
                n1: {
                    id: 'n1', name: 'N', position: { x: 0, y: 0 },
                    info_tasks: [{ id: 't1786196322037', task_name: 'ocr', param_values: {}, wire_inputs: {} }],
                    logic_tasks: [], operation_groups: [], exits: {},
                },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const dsl = toPythonDSL(state);
        expect(dsl).toContain('@node_info_task("ocr", alias="OCR", id="t1786196322037")');
    });

    it('旧文件经一次保存固化 id，二次重载仍稳定', () => {
        const pyDict = {
            metadata: { name: 'test', version: '1.0' },
            global_vars: {},
            start_node_id: 'n1',
            nodes: {
                n1: {
                    id: 'n1', name: 'N', position: { x: 0, y: 0 },
                    info_tasks: [{ task_name: 'ocr', param_values: {}, wire_inputs: {} }],
                    logic_tasks: [], operation_groups: [], exits: {},
                },
            },
            edges: [],
        };
        // 第一次加载 → 位置生成 t1
        fromPythonDSL(pyDict, state);
        expect(state.nodes[0].info[0].id).toBe('t1');
        // 保存 → 固化为 id="t1"
        const dsl = toPythonDSL(state);
        expect(dsl).toContain('id="t1"');
        // 第二次加载（模拟重载固化后的文件）→ 读回 t1 而非再生成
        state.nodes = []; state.wires = [];
        const pyDict2 = JSON.parse(JSON.stringify(pyDict));
        pyDict2.nodes.n1.info_tasks[0].id = 't1';
        fromPythonDSL(pyDict2, state);
        expect(state.nodes[0].info[0].id).toBe('t1');
    });
});
