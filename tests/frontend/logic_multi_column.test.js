import { describe, it, expect, beforeEach } from 'vitest';
import {
    state, DEFS, normalizeLogic, logicColOf, isValidConnection,
} from '../../src/js/state.js';
import { setLang } from '../../src/js/i18n.js';

// 这些测试断言中文文案（选择变量/添加 LOGIC 子列），锁定语言为中文
setLang('zh');
import { toPythonDSL, fromPythonDSL } from '../../src/js/datamapper.js';
import { buildTask, buildColumnEl, removeLogicSubColumn, normalizeExits, render, alignExitPorts } from '../../src/js/render.js';

// ============================================================
// buildTask：字段控件（global_var / list-with-opts）
// ============================================================

describe('buildTask 字段控件', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="world"></div>';
        state.globalVars = [
            { name: 'device_id', type: 'string', value: '', fixed: true },
            { name: 'count', type: 'number', value: '0' },
        ];
        DEFS['gv_task'] = {
            name: 'gv_task', alias: 'GV', category: 'logic',
            params: [
                { n: 'glo_var', a: 'glo_var', t: 'global_var', w: 1, init: '' },
                { n: 'operator', a: 'operator', t: 'list', w: 0.5, init: '+', opts: ['+', '-', '*', '/'] },
                { n: 'value', a: 'value', t: 'line', w: 0.5, init: '' },
            ],
            rets: [{ n: 'result', a: 'result' }],
        };
    });

    it('global_var 渲染下拉并列出当前全局变量，选中值生效', () => {
        const t = { id: 't1', def: 'gv_task', f: { glo_var: 'count', operator: '+', value: '' }, in: {} };
        const el = buildTask(t, 'logic');
        const sel = el.querySelectorAll('select')[0];
        expect(sel).not.toBeNull();
        const opts = Array.from(sel.options).map(o => o.value);
        expect(opts).toContain('device_id');
        expect(opts).toContain('count');
        expect(sel.value).toBe('count');
    });

    it('list 渲染 p.opts 下拉（operator 合并为 list）', () => {
        const t = { id: 't1', def: 'gv_task', f: { glo_var: '', operator: '-', value: '' }, in: {} };
        const el = buildTask(t, 'logic');
        const sels = el.querySelectorAll('select');
        expect(sels.length).toBe(2); // global_var + list
        const opSel = sels[1];
        expect(Array.from(opSel.options).map(o => o.value)).toEqual(['+', '-', '*', '/']);
        expect(opSel.value).toBe('-');
    });
});

// ============================================================
// LOGIC 多列：normalizeLogic / logicColOf
// ============================================================

describe('normalizeLogic (Task[][] 多列模型)', () => {
    it('旧扁平数组自动迁移为单列', () => {
        const node = { logic: [{ id: 'a' }, { id: 'b' }] };
        expect(normalizeLogic(node)).toEqual([[{ id: 'a' }, { id: 'b' }]]);
    });

    it('空数组保持为空（无 LOGIC）', () => {
        const node = { logic: [] };
        expect(normalizeLogic(node)).toEqual([]);
    });

    it('只要任一子列有卡片，就保留所有子列（含空列）', () => {
        // 中间空列保留
        const node = { logic: [[{ id: 'a' }], [], [{ id: 'c' }]] };
        expect(normalizeLogic(node)).toEqual([[{ id: 'a' }], [], [{ id: 'c' }]]);
        // 首列为空也保留
        const node2 = { logic: [[], [{ id: 'b' }]] };
        expect(normalizeLogic(node2)).toEqual([[], [{ id: 'b' }]]);
        // 末尾空列保留
        const node3 = { logic: [[{ id: 'a' }], []] };
        expect(normalizeLogic(node3)).toEqual([[{ id: 'a' }], []]);
    });

    it('唯一空白列 → 重置为 []', () => {
        const node = { logic: [[]] };
        expect(normalizeLogic(node)).toEqual([]);
    });

    it('所有子列都空 → 重置为 []（回到无 LOGIC 状态）', () => {
        const node = { logic: [[], [], []] };
        expect(normalizeLogic(node)).toEqual([]);
    });

    it('跳过稀疏数组空洞（防御手写 DSL 的跳列）', () => {
        const node = { logic: [undefined, undefined, [{ id: 'c' }]] };
        expect(normalizeLogic(node)).toEqual([[{ id: 'c' }]]);
    });
});

describe('logicColOf', () => {
    beforeEach(() => { state.nodes = []; });

    it('返回任务所在 LOGIC 子列下标', () => {
        state.nodes = [{ id: 'n1', info: [], logic: [[{ id: 't0' }], [{ id: 't1' }]], groups: [] }];
        expect(logicColOf('t0')).toBe(0);
        expect(logicColOf('t1')).toBe(1);
    });

    it('不在 LOGIC 中返回 null', () => {
        state.nodes = [{ id: 'n1', info: [{ id: 'x' }], logic: [], groups: [] }];
        expect(logicColOf('x')).toBeNull();
    });
});

// ============================================================
// isValidConnection：logic→logic 仅相邻列
// ============================================================

describe('isValidConnection 相邻列规则', () => {
    beforeEach(() => {
        state.nodes = [{
            id: 'n1', name: 'n1', info: [{ id: 'i1' }],
            logic: [[{ id: 't0' }, { id: 't2' }], [{ id: 't1' }]],
            groups: [], outPorts: ['out'], inPorts: ['in'],
        }];
    });

    it('允许 列0出口 → 列1入口', () => {
        expect(isValidConnection('t0', 't1', 'out', 'in')).toBe(true);
    });

    it('拒绝 同列内 的 logic→logic 连线', () => {
        expect(isValidConnection('t0', 't2', 'out', 'in')).toBe(false);
    });

    it('拒绝 逆序（列1 → 列0）连线', () => {
        expect(isValidConnection('t1', 't0', 'out', 'in')).toBe(false);
    });

    it('info→logic 仍允许（回归）', () => {
        expect(isValidConnection('i1', 't0', 'out', 'in')).toBe(true);
    });

    it('其他节点出口 → 任意入口接线点（多入口 fan-in 回归）', () => {
        state.nodes = [
            { id: 'n1', name: 'n1', info: [], logic: [], groups: [], outPorts: ['out'], inPorts: ['in'] },
            { id: 'n2', name: 'n2', info: [], logic: [], groups: [], outPorts: ['out'], inPorts: ['in', 'in2'] },
        ];
        expect(isValidConnection('n1', 'n2', 'out', 'in')).toBe(true);
    });
});

// ============================================================
// DSL round-trip：column 字段
// ============================================================

describe('toPythonDSL / fromPythonDSL column 字段', () => {
    beforeEach(() => {
        DEFS['if_condition'] = {
            name: 'if_condition', alias: '条件判断', category: 'logic',
            params: [], rets: [],
        };
        state.projectName = 'test';
        state.globalVars = [];
        state.wires = [];
    });

    it('toPythonDSL：列 0 不输出 column，列 1 输出 column=1', () => {
        state.nodes = [{
            id: 'n1', name: 'n1', x: 0, y: 0, w: 0, colF: null, outPorts: ['out'],
            info: [],
            logic: [
                [{ id: 't0', def: 'if_condition', f: {}, in: {} }],
                [{ id: 't1', def: 'if_condition', f: {}, in: {} }],
            ],
            groups: [],
        }];
        const code = toPythonDSL(state);
        expect(code).toContain('@node_logic_task("if_condition", alias="条件判断", id="t0")');
        expect(code).toContain('@node_logic_task("if_condition", alias="条件判断", id="t1", column=1)');
    });

    it('fromPythonDSL：按 column 分组重建多列', () => {
        state.nodes = [];
        const pyDict = {
            metadata: { name: 't' },
            global_vars: {},
            nodes: {
                n1: {
                    name: 'n1', position: { x: 0, y: 0 }, exits: {}, info_tasks: [],
                    logic_tasks: [
                        { id: 'a', task_name: 'if_condition', param_values: {}, wire_inputs: {}, column: 0 },
                        { id: 'b', task_name: 'if_condition', param_values: {}, wire_inputs: {}, column: 1 },
                        { id: 'c', task_name: 'if_condition', param_values: {}, wire_inputs: {}, column: 1 },
                    ],
                    operation_groups: [],
                },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const n = state.nodes[0];
        expect(n.logic).toHaveLength(2);
        expect(n.logic[0]).toHaveLength(1);
        expect(n.logic[1]).toHaveLength(2);
    });

    it('fromPythonDSL：通过 col_fractions 长度恢复加载后丢失的空子列', () => {
        state.nodes = [];
        const pyDict = {
            metadata: { name: 't' },
            global_vars: {},
            nodes: {
                n1: {
                    name: 'n1', position: { x: 0, y: 0 }, exits: {}, info_tasks: [],
                    col_fractions: [1, 1, 1, 1],
                    logic_tasks: [
                        { id: 'a', task_name: 'if_condition', param_values: {}, wire_inputs: {}, column: 0 },
                    ],
                    operation_groups: [],
                },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const n = state.nodes[0];
        expect(n.logic).toHaveLength(2);
        expect(n.logic[0]).toHaveLength(1);
        expect(n.logic[1]).toHaveLength(0);
    });

    it('toPythonDSL：非 in 入口端口 → edge 带 to_port', () => {
        state.nodes = [
            { id: 'n1', name: 'n1', x: 0, y: 0, w: 0, colF: null, outPorts: ['out'], inPorts: ['in'], info: [], logic: [], groups: [] },
            { id: 'n2', name: 'n2', x: 200, y: 0, w: 0, colF: null, outPorts: ['out'], inPorts: ['in', 'in2'], info: [], logic: [], groups: [] },
            { id: 'n3', name: 'n3', x: 0, y: 200, w: 0, colF: null, outPorts: ['out'], inPorts: ['in'], info: [], logic: [], groups: [] },
        ];
        state.wires = [
            { from: 'n1.out', to: 'n2.in' },
            { from: 'n3.out', to: 'n2.in2' },
        ];
        const code = toPythonDSL(state);
        expect(code).toContain('edge("n1", "out", "n2")');
        expect(code).toContain('edge("n3", "out", "n2", "in2")');
    });

    it('fromPythonDSL：多个 edge 到同一节点 → 多个入口接线点', () => {
        state.nodes = [];
        const pyDict = {
            metadata: { name: 't' },
            global_vars: {},
            nodes: {
                n1: { name: 'n1', position: { x: 0, y: 0 }, exits: {}, info_tasks: [], logic_tasks: [], operation_groups: [] },
                n2: { name: 'n2', position: { x: 200, y: 0 }, exits: {}, info_tasks: [], logic_tasks: [], operation_groups: [] },
                n3: { name: 'n3', position: { x: 0, y: 200 }, exits: {}, info_tasks: [], logic_tasks: [], operation_groups: [] },
            },
            edges: [
                { from_node: 'n1', from_exit: 'out', to_node: 'n2', to_port: 'in' },
                { from_node: 'n3', from_exit: 'out', to_node: 'n2', to_port: 'in2' },
            ],
        };
        fromPythonDSL(pyDict, state);
        const n2 = state.nodes.find(n => n.id === 'n2');
        expect(n2.inPorts).toEqual(['in', 'in2']);
        const wiresToN2 = state.wires.filter(w => w.to === 'n2.in' || w.to === 'n2.in2');
        expect(wiresToN2).toHaveLength(2);
    });

    it('fromPythonDSL：旧文件 edge 无 to_port → 默认入口 in', () => {
        state.nodes = [];
        const pyDict = {
            metadata: { name: 't' },
            global_vars: {},
            nodes: {
                n1: { name: 'n1', position: { x: 0, y: 0 }, exits: {}, info_tasks: [], logic_tasks: [], operation_groups: [] },
                n2: { name: 'n2', position: { x: 200, y: 0 }, exits: {}, info_tasks: [], logic_tasks: [], operation_groups: [] },
            },
            edges: [
                { from_node: 'n1', from_exit: 'out', to_node: 'n2' },
            ],
        };
        fromPythonDSL(pyDict, state);
        const n2 = state.nodes.find(n => n.id === 'n2');
        expect(n2.inPorts).toEqual(['in']);
    });

    it('fromPythonDSL：旧文件无 column → 全部归列 0（单列）', () => {
        state.nodes = [];
        const pyDict = {
            metadata: { name: 't' },
            global_vars: {},
            nodes: {
                n1: {
                    name: 'n1', position: { x: 0, y: 0 }, exits: {}, info_tasks: [],
                    logic_tasks: [
                        { id: 'a', task_name: 'if_condition', param_values: {}, wire_inputs: {} },
                        { id: 'b', task_name: 'if_condition', param_values: {}, wire_inputs: {} },
                    ],
                    operation_groups: [],
                },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const n = state.nodes[0];
        expect(n.logic).toHaveLength(1);
        expect(n.logic[0]).toHaveLength(2);
    });
});

// ============================================================
// LOGIC 子列标题按钮（+/−）与删除
// ============================================================

describe('buildColumnEl LOGIC 子列按钮', () => {
    it('Logic-0 标题右侧显示 "+"（无 "−"）', () => {
        const n = { logic: [[], []], colF: [1, 1, 1, 1] };
        const el = buildColumnEl(n, 'logic', [], 'logic', 0, false, true);
        const btn = el.querySelector('.col__add-subcol');
        expect(btn).not.toBeNull();
        expect(btn.textContent).toBe('+');
        expect(btn.title).toBe('');
    });

    it('Logic-i（i≥1）标题右侧显示 "−"（无 "+"）', () => {
        const n = { logic: [[], []], colF: [1, 1, 1, 1] };
        const el = buildColumnEl(n, 'logic', [], 'logic', 1, false, true);
        const btn = el.querySelector('.col__add-subcol');
        expect(btn).not.toBeNull();
        expect(btn.textContent).toBe('−');
        expect(btn.title).toBe('');
    });

    it('占位列（forceVisible=false）不显示任何按钮', () => {
        const n = { logic: [[]], colF: [1, 1, 1] };
        const el = buildColumnEl(n, 'logic', [], 'logic', 0, false, false);
        expect(el.querySelector('.col__add-subcol')).toBeNull();
    });
});

describe('removeLogicSubColumn', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="world"></div><div class="canvas"></div><svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
        state.wires = [];
        state.nodes = [];
    });

    it('删除指定子列并清理相关连线与 in 映射残留', () => {
        const n = {
            id: 'n1', name: 'n1', x: 0, y: 0, w: 560, colF: [1, 1, 1, 1],
            outPorts: ['out'], inPorts: ['in'], info: [], groups: [],
            logic: [
                [{ id: 't0', def: 'logic_print', f: {}, in: {} }],
                [{ id: 't1', def: 'logic_print', f: {}, in: { input: 't0.out' } }],
            ],
        };
        state.nodes = [n];
        state.wires = [
            { id: 'w1', from: 't0.out', to: 't1.in' },   // 列0 → 列1
            { id: 'w2', from: 'n1.out', to: 'n2.in' },    // 节点级连线，应保留
            { id: 'w3', from: 't1.out', to: 'x.in' },     // 列1 → 其他，应保留
            { id: 'w4', from: 'x.out', to: 't0.in' },     // 其他 → 列0，应删除
        ];
        removeLogicSubColumn(n, 0);
        expect(n.logic).toHaveLength(1);
        expect(n.logic[0].map(t => t.id)).toEqual(['t1']);
        // w1、w4 连到被删列任务 t0 → 删除；w2、w3 保留
        expect(state.wires.map(w => w.id).sort()).toEqual(['w2', 'w3']);
        // t1.in.input 来源 t0 已删 → 清理残留
        expect(n.logic[0][0].in).toEqual({});
    });

    it('删除到 0 列 → logic 重置为空数组（LOGIC 分区隐藏，palette 可重建单列）', () => {
        const n = {
            id: 'n1', name: 'n1', x: 0, y: 0, w: 560, colF: [1, 1, 1],
            outPorts: ['out'], inPorts: ['in'], info: [], groups: [],
            logic: [[{ id: 't0', def: 'logic_print', f: {}, in: {} }]],
        };
        state.nodes = [n];
        removeLogicSubColumn(n, 0);
        expect(n.logic).toEqual([]);
    });
});

// ============================================================
// 节点出口跟随操作组数量（normalizeExits + 渲染 + DSL）
// ============================================================

describe('normalizeExits（出口自动跟随组数）', () => {
    it('0 组 → 0 出口', () => {
        const n = { id: 'n1', groups: [], outPorts: ['out'] };
        normalizeExits(n);
        expect(n.outPorts).toEqual([]);
        expect(n.groups).toEqual([]);
    });

    it('N 组 → 派生 out1..outN，并按下标配对 g.outTo/g.exit', () => {
        const n = { id: 'n1', groups: [{ id: 'g1' }, { id: 'g2' }], outPorts: [] };
        normalizeExits(n);
        expect(n.outPorts).toEqual(['out1', 'out2']);
        expect(n.groups[0].outTo).toBe('n1.out1');
        expect(n.groups[0].exit).toBe('out1');
        expect(n.groups[1].outTo).toBe('n1.out2');
        expect(n.groups[1].exit).toBe('out2');
    });

    it('数量匹配时保留旧名（旧文件 out/out2、手写自定义名）', () => {
        const n = { id: 'n1', groups: [{ id: 'g1' }, { id: 'g2' }], outPorts: ['out', 'out2'] };
        normalizeExits(n);
        expect(n.outPorts).toEqual(['out', 'out2']);
        expect(n.groups[0].exit).toBe('out');
        expect(n.groups[1].exit).toBe('out2');
    });

    it('数量不匹配时补/截到组数', () => {
        // 组比出口多 → 补 out{i+1}
        const a = { id: 'n1', groups: [{}, {}, {}], outPorts: ['out'] };
        normalizeExits(a);
        expect(a.outPorts).toEqual(['out', 'out2', 'out3']);
        // 出口比组多 → 截断
        const b = { id: 'n1', groups: [{}, {}], outPorts: ['out1', 'out2', 'out3'] };
        normalizeExits(b);
        expect(b.outPorts).toEqual(['out1', 'out2']);
    });
});

describe('render 出口跟随组数', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="world"></div><div class="canvas"></div><svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
        state.wires = [];
        state.nodes = [];
    });

    it('出口 rail 无 +/- 按钮，端口数=组数；组头显示方块口 + 配对出口名', () => {
        const n = {
            id: 'n1', name: 'n1', x: 0, y: 0, w: 560, colF: [1, 1, 1],
            info: [], logic: [], inPorts: ['in'], outPorts: [],
            groups: [
                { id: 'g1', name: 'G1', on: true, ops: [], in: {} },
                { id: 'g2', name: 'G2', on: true, ops: [], in: {} },
            ],
        };
        state.nodes = [n];
        render();
        expect(n.outPorts).toEqual(['out1', 'out2']);
        const rail = document.querySelector('.node__port-rail--out');
        expect(rail.querySelectorAll('.port').length).toBe(2);
        expect(rail.querySelectorAll('.node__port-add').length).toBe(0);  // 无 +/- 按钮
        // 组头方块口：存在、颜色来自配对出口、且不是 .port（不可交互）；无 out1/out2 标签
        const sq = [...document.querySelectorAll('.op-group__exit-port')];
        expect(sq.length).toBe(2);
        expect(document.querySelectorAll('.op-group__exit').length).toBe(0);
        sq.forEach((p, i) => {
            expect(p.classList.contains('port')).toBe(false);
            expect(p.dataset.src).toBe(`g${i + 1}.out`);
        });
        // 强制连线已画入节点内 SVG（每组一条 .wire-line--forced）
        const forced = document.querySelectorAll('.node__wires path.wire-line--forced');
        expect(forced.length).toBe(2);
    });
});

describe('DSL 出口自动配对', () => {
    beforeEach(() => {
        state.projectName = 'test';
        state.globalVars = [];
        state.wires = [];
    });

    it('toPythonDSL：每组建发 @node_exit + @node_op_group(exit=配对出口)', () => {
        state.nodes = [{
            id: 'n1', name: 'n1', x: 0, y: 0, w: 0, colF: null, outPorts: ['out1', 'out2'],
            info: [], logic: [], groups: [
                { id: 'g1', name: 'G1', on: true, ops: [], in: {} },
                { id: 'g2', name: 'G2', on: true, ops: [], in: {} },
            ],
        }];
        const code = toPythonDSL(state);
        expect(code).toContain('@node_exit("out1", "out1")');
        expect(code).toContain('@node_exit("out2", "out2")');
        expect(code).toContain('exit="out1"');
        expect(code).toContain('exit="out2"');
    });

    it('fromPythonDSL：组 exit 不再生成组→节点出口连线，outPorts 保留旧名', () => {
        state.nodes = [];
        const pyDict = {
            metadata: { name: 't' }, global_vars: {},
            nodes: {
                n1: {
                    name: 'n1', position: { x: 0, y: 0 },
                    exits: { out1: {}, out2: {} }, info_tasks: [], logic_tasks: [],
                    operation_groups: [
                        { id: 'g1', name: 'G1', forced: true, exit: 'out1', operations: [] },
                        { id: 'g2', name: 'G2', forced: true, exit: 'out2', operations: [] },
                    ],
                },
            },
            edges: [],
        };
        fromPythonDSL(pyDict, state);
        const n = state.nodes[0];
        expect(n.outPorts).toEqual(['out1', 'out2']);
        const groupWires = state.wires.filter(w => /^g\d\.out$/.test(w.from));
        expect(groupWires).toHaveLength(0);  // 组出口连线不再存在于 state.wires
    });
});

describe('alignExitPorts（出口端口对齐操作组标题栏）', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="world"></div><div class="canvas"></div><svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
        state.wires = [];
        state.nodes = [];
    });

    it('每个出口端口按对应操作组头部设置 top（jsdom 布局为 0，验证代码执行）', () => {
        const n = {
            id: 'n1', name: 'n1', x: 0, y: 0, w: 560, colF: [1, 1, 1],
            info: [], logic: [], inPorts: ['in'], outPorts: [],
            groups: [
                { id: 'g1', name: 'G1', on: true, ops: [], in: {} },
                { id: 'g2', name: 'G2', on: true, ops: [], in: {} },
            ],
        };
        state.nodes = [n];
        render();
        const ports = document.querySelectorAll('.node__port-rail--out .port');
        expect(ports.length).toBe(2);
        ports.forEach(p => {
            expect(parseFloat(p.style.top)).toBeGreaterThan(-100);  // top 已设置（非 NaN/空）
        });
    });
});

describe('alignExitPorts 缩放数学（zoom 除法）', () => {
    it('zoom=2 时端口 top 还原为节点本地坐标', () => {
        const el = document.createElement('section');
        el.innerHTML = `
            <div class="op-group"><span class="op-group__exit-port"></span></div>
            <div class="op-group"><span class="op-group__exit-port"></span></div>
            <div class="node__port-rail node__port-rail--out">
                <div class="port"></div>
                <div class="port"></div>
            </div>`;
        state.zoom = 2;
        // 模拟 world scale=2 后的视口坐标：方块口本地 offset 与 scale 乘积 + rail 视口 top
        el.getBoundingClientRect = () => ({ top: 200, height: 400, left: 0, width: 200 });
        const rail = el.querySelector('.node__port-rail--out');
        rail.getBoundingClientRect = () => ({ top: 200, height: 400, left: 0, width: 200 });  // 测试中 rail 与节点同顶
        const sqPorts = el.querySelectorAll('.op-group__exit-port');
        // 方块口中心本地 offset 50 / 150 → 视口 top 200+100=300 / 200+300=500
        sqPorts[0].getBoundingClientRect = () => ({ top: 293.5, height: 13, left: 0, width: 13 });  // 中心 300
        sqPorts[1].getBoundingClientRect = () => ({ top: 493.5, height: 13, left: 0, width: 13 });  // 中心 500
        const ports = el.querySelectorAll('.port');
        Object.defineProperty(ports[0], 'offsetHeight', { value: 14, configurable: true });
        Object.defineProperty(ports[1], 'offsetHeight', { value: 14, configurable: true });
        alignExitPorts(el, {});
        // 方块口1 中心本地 offset = (293.5-200)/2 + 13/2/2 = 50；top = 50 - 7 = 43
        expect(parseFloat(ports[0].style.top)).toBeCloseTo(43);
        // 方块口2 中心本地 offset = (493.5-200)/2 + 13/2/2 = 150；top = 150 - 7 = 143
        expect(parseFloat(ports[1].style.top)).toBeCloseTo(143);
    });
});
