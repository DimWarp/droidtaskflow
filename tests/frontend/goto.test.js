import { describe, it, expect, beforeEach } from 'vitest';
import { gotoMarkerPortName, parseGotoMarkerPort, deriveGotoMarkers, gotoMarkerTitle, wireSourceLabel } from '../../src/js/goto.js';
import { render } from '../../src/js/render.js';
import { state, DEFS } from '../../src/js/state.js';
import { toPythonDSL } from '../../src/js/datamapper.js';

describe('gotoMarkerPortName', () => {
    it('生成 g<id>_<entry> 命名', () => {
        expect(gotoMarkerPortName('g1', 'in')).toBe('g1_in');
        expect(gotoMarkerPortName('g1726', 'in2')).toBe('g1726_in2');
    });
});

describe('parseGotoMarkerPort', () => {
    it('解析扁平边端口名', () => {
        expect(parseGotoMarkerPort('g1_in')).toEqual({ gotoId: 'g1', entryName: 'in' });
        expect(parseGotoMarkerPort('in')).toBeNull();
        expect(parseGotoMarkerPort('in2')).toBeNull();
    });
});

describe('deriveGotoMarkers', () => {
    const base = (o) => ({ id: o.id, type: o.type || 'normal', name: o.name || o.id, target: o.target ?? null, inPorts: o.inPorts || ['in'], info: [], logic: [], groups: [] });

    it('goto 每个入口在目标节点上派生一个 marker', () => {
        const state = {
            nodes: [
                base({ id: 'n1', type: 'normal', outPorts: ['out'] }),
                base({ id: 'g1', type: 'goto', name: 'goto1', target: 'n2', inPorts: ['in', 'in2'] }),
                base({ id: 'n2', type: 'normal' }),
            ],
            wires: [{ from: 'n1.out', to: 'g1.in' }, { from: 'n1.out', to: 'g1.in2' }],
        };
        const m = deriveGotoMarkers(state);
        // 两入口均由节点出口 n1.out 喂入 → title 追溯到源头节点名 n1（不带 id）
        expect(m['n2']).toEqual([
            { portName: 'g1_in', gotoId: 'g1', gotoName: 'goto1', entryName: 'in', title: 'n1' },
            { portName: 'g1_in2', gotoId: 'g1', gotoName: 'goto1', entryName: 'in2', title: 'n1' },
        ]);
    });

    it('goto 未选目标时不派生', () => {
        const state = {
            nodes: [base({ id: 'g1', type: 'goto', target: null, inPorts: ['in'] }), base({ id: 'n2' })],
            wires: [],
        };
        expect(deriveGotoMarkers(state)).toEqual({});
    });

    it('入口未接线也派生（选择目标即显示标记）', () => {
        const state = {
            nodes: [base({ id: 'g1', type: 'goto', target: 'n2', inPorts: ['in'] }), base({ id: 'n2' })],
            wires: [],
        };
        expect(deriveGotoMarkers(state)['n2']).toHaveLength(1);
    });

    it('无连线时 marker.title 回退为 goto 名（不带 id）', () => {
        const state = {
            nodes: [base({ id: 'g1', type: 'goto', name: '跳转到A', target: 'n2', inPorts: ['in'] }), base({ id: 'n2' })],
            wires: [],
        };
        const m = deriveGotoMarkers(state)['n2'][0];
        expect(m.title).toBe('跳转到A');
        expect(m.title).not.toContain('g1');
    });
});

describe('gotoMarkerTitle / wireSourceLabel 追溯源头', () => {
    const mk = (nid, cardId, name, extra = {}) => ({ id: nid, name: name || nid, x: 0, y: 0, w: 560, info: [], logic: [], groups: [], inPorts: ['in'], outPorts: ['out'], ...extra });

    it('任务卡输出喂入 goto 入口 → title = 卡别名（_name 优先）', () => {
        const t1 = { id: 't1', def: 'ocr', f: {}, in: {}, _name: '我的OCR' };
        const g = { id: 'g1', type: 'goto', name: 'goto', x: 0, y: 0, w: 320, inPorts: ['in'], target: 'n2', info: [], logic: [], groups: [] };
        const n1 = mk('n1', null, '源节点', { info: [t1] });
        const state = { nodes: [n1, g, mk('n2', null, '目标')], wires: [{ from: 'n1.t1.out', to: 'g1.in' }] };
        expect(gotoMarkerTitle(state, 'g1', 'in')).toBe('我的OCR');
    });

    it('任务卡无自定义别名 → title = DEF 别名', () => {
        DEFS['ocr'] = { name: 'ocr', alias: 'OCR 识别', params: [], rets: [] };
        const t1 = { id: 't1', def: 'ocr', f: {}, in: {} };
        const g = { id: 'g1', type: 'goto', name: 'goto', x: 0, y: 0, w: 320, inPorts: ['in'], target: 'n2', info: [], logic: [], groups: [] };
        const state = { nodes: [mk('n1', null, '源', { info: [t1] }), g, mk('n2', null, '目标')], wires: [{ from: 'n1.t1.out', to: 'g1.in' }] };
        expect(gotoMarkerTitle(state, 'g1', 'in')).toBe('OCR 识别');
    });

    it('节点出口喂入 goto 入口 → title = 节点名', () => {
        const g = { id: 'g1', type: 'goto', name: 'goto', x: 0, y: 0, w: 320, inPorts: ['in'], target: 'n2', info: [], logic: [], groups: [] };
        const state = { nodes: [mk('srcA', null, '源头A'), g, mk('n2', null, '目标')], wires: [{ from: 'srcA.out', to: 'g1.in' }] };
        expect(gotoMarkerTitle(state, 'g1', 'in')).toBe('源头A');
    });

    it('未连线 → title 回退 goto 名', () => {
        const g = { id: 'g1', type: 'goto', name: '跳转卡', x: 0, y: 0, w: 320, inPorts: ['in'], target: 'n2', info: [], logic: [], groups: [] };
        const state = { nodes: [g, mk('n2', null, '目标')], wires: [] };
        expect(gotoMarkerTitle(state, 'g1', 'in')).toBe('跳转卡');
    });

    it('不存在的 goto id → 空字符串', () => {
        expect(gotoMarkerTitle({ nodes: [], wires: [] }, 'ghost', 'in')).toBe('');
    });

    it('wireSourceLabel：操作组触发来源 → 组名', () => {
        const g1 = { id: 'g1', name: '主流程', ops: [], in: {} };
        const state = { nodes: [{ id: 'n1', name: 'N', info: [], logic: [], groups: [g1] }], wires: [] };
        expect(wireSourceLabel(state, 'n1.g1.trigger')).toBe('主流程');
    });

    it('wireSourceLabel：无法识别的来源 → null', () => {
        const state = { nodes: [], wires: [] };
        expect(wireSourceLabel(state, 'ghost.x.y')).toBeNull();
        expect(wireSourceLabel(state, '')).toBeNull();
    });
});

describe('goto 入口口连线后变色', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="world"></div><div class="canvas"></div><svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
        state.wires = [];
        state.nodes = [];
    });

    it('连线后 goto 入口口 --port-c = 源节点出口 --port-c；未连线为默认', () => {
        // 源节点带一个操作组 → normalizeExits 派生出口 out1
        const src = {
            id: 'n1', name: 'src', x: 0, y: 0, w: 560, colF: [1, 1, 1.15],
            info: [], logic: [], inPorts: ['in'], outPorts: [],
            groups: [{ id: 'g1', name: 'G1', on: true, ops: [], in: {} }],
        };
        const g = { id: 'g1', type: 'goto', name: 'goto', x: 0, y: 0, w: 320, inPorts: ['in'], target: null, info: [], logic: [], groups: [] };
        state.nodes = [src, g];
        // 第一次 render 派生出口、着色 _ncols；第二次 render 出口口拿到颜色
        render();
        render();
        const srcPort = document.querySelector('[data-src="n1.out1"]');
        const gPort0 = document.querySelector('[data-src="g1.in"]');
        expect(srcPort).toBeTruthy();
        expect(gPort0).toBeTruthy();
        const srcC = srcPort.style.getPropertyValue('--port-c').trim();
        expect(srcC).not.toBe('');
        // 未连线：goto 入口口保持默认（--port-c 为空）
        expect(gPort0.style.getPropertyValue('--port-c').trim()).toBe('');
        // 连线后 re-render（重建 DOM，需重新查询）：颜色跟随源出口
        state.wires.push({ from: 'n1.out1', to: 'g1.in' });
        render();
        const gPort1 = document.querySelector('[data-src="g1.in"]');
        expect(gPort1.style.getPropertyValue('--port-c').trim()).toBe(srcC);
    });
});

describe('goto marker 自定义 tooltip（左上角，替代原生 title）', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="world"></div><div class="canvas"></div><svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
        state.wires = [];
        state.nodes = [];
        DEFS['ocr'] = { name: 'ocr', alias: 'OCR 识别', params: [], rets: [] };
    });

    it('悬浮 marker 显示追溯源头别名，定位左上角；移出隐藏', () => {
        const src = { id: 'n1', name: '源头', x: 0, y: 0, w: 560, colF: [1, 1, 1.15], info: [{ id: 't1', def: 'ocr', f: {}, in: {} }], logic: [], groups: [], inPorts: ['in'], outPorts: ['out'] };
        const g = { id: 'g1', type: 'goto', name: 'goto', x: 0, y: 0, w: 320, inPorts: ['in'], target: 'n2', info: [], logic: [], groups: [] };
        const dst = { id: 'n2', name: '目标', x: 100, y: 0, w: 560, colF: [1, 1, 1.15], info: [], logic: [], groups: [], inPorts: ['in'], outPorts: [] };
        state.nodes = [src, g, dst];
        state.wires = [{ from: 'n1.t1.out', to: 'g1.in' }];
        render();
        const marker = document.querySelector('.port--goto-marker');
        expect(marker).toBeTruthy();
        marker.dispatchEvent(new Event('mouseenter'));
        const tt = document.querySelector('.port__tooltip');
        expect(tt).toBeTruthy();
        expect(tt.textContent).toBe('OCR 识别');
        expect(tt.classList.contains('port__tooltip--show')).toBe(true);
        expect(tt.style.left).not.toBe('');
        expect(tt.style.top).not.toBe('');
        marker.dispatchEvent(new Event('mouseleave'));
        expect(tt.classList.contains('port__tooltip--show')).toBe(false);
    });

    it('marker 无连线 → tooltip 回退 goto 名', () => {
        const g = { id: 'g1', type: 'goto', name: '跳转卡', x: 0, y: 0, w: 320, inPorts: ['in'], target: 'n2', info: [], logic: [], groups: [] };
        const dst = { id: 'n2', name: '目标', x: 100, y: 0, w: 560, colF: [1, 1, 1.15], info: [], logic: [], groups: [], inPorts: ['in'], outPorts: [] };
        state.nodes = [g, dst];
        state.wires = [];
        render();
        const marker = document.querySelector('.port--goto-marker');
        expect(marker).toBeTruthy();
        marker.dispatchEvent(new Event('mouseenter'));
        const tt = document.querySelector('.port__tooltip');
        expect(tt.textContent).toBe('跳转卡');
        marker.dispatchEvent(new Event('mouseleave'));
    });
});

describe('减少入口按钮：优先删未连线入口', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="world"></div><div class="canvas"></div><svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
        state.wires = [];
        state.nodes = [];
    });
    const delBtn = () => [...document.querySelectorAll('.node__port-add')].find(b => b.textContent === '−');
    const addBtn = () => [...document.querySelectorAll('.node__port-add')].find(b => b.textContent === '+');

    const start = () => ({ id: 'n0', name: 'start', x: 0, y: 0, w: 560, colF: [1, 1, 1.15], info: [], logic: [], groups: [], inPorts: ['in'], outPorts: ['out'] });

    it('删除中间入口后添加入口不撞名（回归：原 bug 会生成重复 in3）', () => {
        const n = { id: 'n1', name: 'N', x: 0, y: 0, w: 560, colF: [1, 1, 1.15], info: [], logic: [], groups: [], inPorts: ['in', 'in2', 'in3'], outPorts: ['out'] };
        state.nodes = [start(), n];
        state.wires = [{ from: 'a.x', to: 'n1.in' }, { from: 'b.y', to: 'n1.in3' }];  // in2 未连线
        render();
        // 删 in2（唯一未连线）→ ['in','in3']
        delBtn().click();
        expect(n.inPorts).toEqual(['in', 'in3']);
        // 再添加：应生成 in2（最小可用），不得生成 in3 与已有撞名
        addBtn().click();
        expect(n.inPorts).toEqual(['in', 'in3', 'in2']);
        expect(new Set(n.inPorts).size).toBe(n.inPorts.length);  // 无重复
    });

    it('存在未连线入口 → 删未连线者，已连线保留', () => {
        const n = { id: 'n1', name: 'N', x: 0, y: 0, w: 560, colF: [1, 1, 1.15], info: [], logic: [], groups: [], inPorts: ['in', 'in2', 'in3'], outPorts: ['out'] };
        state.nodes = [start(), n];  // 起始节点无入口 rail；n1 才有 +/- 按钮
        state.wires = [{ from: 't1.out', to: 'n1.in' }];  // in 已连线
        render();
        expect(delBtn()).toBeTruthy();
        delBtn().click();
        expect(n.inPorts).toEqual(['in', 'in2']);  // 删未连线的 in3
        expect(state.wires).toHaveLength(1);
        expect(state.wires[0]).toMatchObject({ from: 't1.out', to: 'n1.in' });
    });

    it('中间入口未连线 → 删它并保留其余线', () => {
        const n = { id: 'n1', name: 'N', x: 0, y: 0, w: 560, colF: [1, 1, 1.15], info: [], logic: [], groups: [], inPorts: ['in', 'in2', 'in3'], outPorts: ['out'] };
        state.nodes = [start(), n];
        state.wires = [{ from: 'a.x', to: 'n1.in' }, { from: 'b.y', to: 'n1.in3' }];  // in2 未连线
        render();
        delBtn().click();
        expect(n.inPorts).toEqual(['in', 'in3']);
        expect(state.wires.length).toBe(2);
    });

    it('全部连线 → 删最底部并清理其线', () => {
        const n = { id: 'n1', name: 'N', x: 0, y: 0, w: 560, colF: [1, 1, 1.15], info: [], logic: [], groups: [], inPorts: ['in', 'in2'], outPorts: ['out'] };
        state.nodes = [start(), n];
        state.wires = [{ from: 't1.out', to: 'n1.in' }, { from: 't2.out', to: 'n1.in2' }];
        render();
        delBtn().click();
        expect(n.inPorts).toEqual(['in']);  // 删最底部 in2
        expect(state.wires).toHaveLength(1);
        expect(state.wires[0]).toMatchObject({ from: 't1.out', to: 'n1.in' });  // in2 的线被清
    });
});

describe('goto 节点缺 info 字段不崩溃', () => {
    beforeEach(() => {
        state.nodes = [];
        state.wires = [];
        state.globalVars = [];
    });

    it('toPythonDSL：goto 节点无 info/logic/groups 字段 + 卡片级连线 → nodeOf/colOf 守卫不抛错', () => {
        const start = { id: 'n1', name: 'start', x: 0, y: 0, w: 560, info: [{ id: 't1', def: 'x', f: {}, in: {} }], logic: [], groups: [], inPorts: [], outPorts: ['out1'] };
        // 模拟 btnAddGoto 旧版创建的最小 goto 节点：无 info/logic/groups 字段
        const g = { id: 'g1', type: 'goto', name: 'goto', x: 0, y: 0, w: 320, inPorts: ['in'], target: null };
        const n3 = { id: 'n3', name: 'n3', x: 0, y: 0, w: 560, info: [{ id: 't3', def: 'x', f: {}, in: {} }], logic: [], groups: [], inPorts: ['in'], outPorts: ['out1'] };
        state.nodes = [start, g, n3];
        // 卡片级跨节点连线：nodeOf('t3') 会遍历到 goto 节点（其 info 缺失）
        state.wires = [{ from: 't3.out1', to: 't1.in' }];
        expect(() => toPythonDSL(state)).not.toThrow();
    });
});
