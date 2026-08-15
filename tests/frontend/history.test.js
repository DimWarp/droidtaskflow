import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../../src/js/state.js';
import {
    capture, undo, redo, clearHistory, canUndo, canRedo,
    beginEdit, endEdit, initHistory, LIMIT,
} from '../../src/js/history.js';

// 注册一次 document 级快捷键监听（模块加载时）。
// updateButtons 对缺失按钮 null-guard，jsdom 空文档下安全。
initHistory();

const BASE_DOM =
    '<div id="world"></div><div class="canvas"></div>'
    + '<svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>'
    + '<div id="globalVarsBar"><div id="gvItems"></div><button id="gvAdd"></button></div>'
    + '<button id="btnUndo"></button><button id="btnRedo"></button>';

// 带一个 info 卡片（未知 def 时 buildTask 渲染 '??' 占位，不崩）的普通节点
function makeNode(x = 0) {
    return {
        id: 'n1', name: 'N', x, y: 0, w: 560, colF: [1, 1, 1.15],
        info: [{ id: 't1', def: 'textT', f: {}, in: {} }],
        logic: [], groups: [], inPorts: ['in'], outPorts: ['out'],
    };
}

beforeEach(() => {
    document.body.innerHTML = BASE_DOM;
    state.nodes = [];
    state.wires = [];
    state.globalVars = [];
    state.dirty = false;
    clearHistory();
});

describe('capture / undo / redo 核心', () => {
    it('往返：capture → 改 x → undo 恢复 → redo 恢复新值', () => {
        state.nodes = [makeNode(0)];
        capture();
        state.nodes[0].x = 100;
        expect(canUndo()).toBe(true);

        undo();
        expect(state.nodes[0].x).toBe(0);
        expect(canRedo()).toBe(true);

        redo();
        expect(state.nodes[0].x).toBe(100);
        expect(canUndo()).toBe(true);
    });

    it('undo 后 redo 条目是独立克隆，不被 render() 就地改动污染', () => {
        state.nodes = [makeNode(0)];
        capture();
        state.nodes[0].x = 50;
        undo();          // apply 时 render() 会就地给被应用节点补 el/_ncols 等
        expect(canRedo()).toBe(true);
        redo();
        expect(state.nodes[0].x).toBe(50);
    });

    it('undo 层跳过与当前状态相同的条目（如 Esc 还原后）', () => {
        state.nodes = [makeNode(0)];
        beginEdit();          // 入栈编辑前状态 (x=0)
        state.nodes[0].x = 5; // 键入
        endEdit();
        state.nodes[0].x = 0; // Esc 还原回原值
        undo();               // 弹出 x=0 与当前相同 → 跳过 → 无可撤销
        expect(state.nodes[0].x).toBe(0);
        expect(canUndo()).toBe(false);
    });

    it('capture 层去重：无变更的连续 capture 不重复入栈', () => {
        state.nodes = [makeNode(0)];
        capture();
        capture();            // 两次 capture 间无变更 → 与栈顶相同 → 不入栈
        state.nodes[0].x = 1;
        undo();
        expect(state.nodes[0].x).toBe(0);
        expect(canUndo()).toBe(false);
    });

    it(`LIMIT=${LIMIT} 淘汰最旧条目`, () => {
        // 单节点反复改 x：每个快照只有 1 个节点，50 次 undo 的 render 开销最小
        state.nodes = [makeNode(0)];
        for (let i = 1; i <= LIMIT + 5; i++) {
            capture();
            state.nodes[0].x = i;
        }
        // 栈封顶 LIMIT：x=0..4 的 5 个最旧状态被淘汰，不可达
        for (let i = 0; i < LIMIT; i++) undo();
        expect(state.nodes[0].x).toBe(5);
        expect(canUndo()).toBe(false);
    });

    it('clearHistory 清空栈并禁用按钮', () => {
        state.nodes = [makeNode(0)];
        capture();
        state.nodes[0].x = 1;
        undo();
        expect(canRedo()).toBe(true);

        clearHistory();
        expect(canUndo()).toBe(false);
        expect(canRedo()).toBe(false);
        expect(document.getElementById('btnUndo').disabled).toBe(true);
        expect(document.getElementById('btnRedo').disabled).toBe(true);
    });
});

describe('apply 联动渲染', () => {
    it('undo 后重新渲染节点与全局变量条', () => {
        state.nodes = [makeNode(10)];
        state.globalVars = [{ name: 'g1', type: 'string', value: 'x', fixed: false }];
        capture();
        state.nodes = [];
        state.globalVars = [];
        expect(state.nodes.length).toBe(0);

        undo();
        expect(state.nodes[0].x).toBe(10);
        expect(document.querySelector('#world .node')).toBeTruthy();
        expect(document.querySelector('#gvItems .gv-item')).toBeTruthy();
        expect(state.dirty).toBe(true);
    });
});

describe('编辑会话合并', () => {
    it('beginEdit 内多次修改 → 一次 undo 全回退', () => {
        state.nodes = [makeNode(0)];
        state.nodes[0].info[0].f = { p: 'a' };
        beginEdit();
        state.nodes[0].info[0].f.p = 'ab';
        state.nodes[0].info[0].f.p = 'abc';
        state.nodes[0].info[0].f.p = 'abcd';
        endEdit();

        undo();
        expect(state.nodes[0].info[0].f.p).toBe('a');
        expect(canRedo()).toBe(true);

        redo();
        expect(state.nodes[0].info[0].f.p).toBe('abcd');
    });

    it('悬空会话：beginEdit 后未 endEdit 直接 undo 仍回退', () => {
        state.nodes = [makeNode(0)];
        state.nodes[0].info[0].f = { p: 'a' };
        beginEdit();
        state.nodes[0].info[0].f.p = 'zz';

        undo();
        expect(state.nodes[0].info[0].f.p).toBe('a');

        // 会话已被 undo 内部关闭，后续 capture 正常工作
        capture();
        expect(canUndo()).toBe(true);
    });
});

describe('快捷键', () => {
    it('Ctrl+Z 撤销，Ctrl+Shift+Z 重做', () => {
        state.nodes = [makeNode(0)];
        capture();
        state.nodes[0].x = 9;

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        expect(state.nodes[0].x).toBe(0);

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
        expect(state.nodes[0].x).toBe(9);
    });

    it('Ctrl+Y 触发重做', () => {
        state.nodes = [makeNode(0)];
        capture();
        state.nodes[0].x = 7;
        undo();               // → x=0

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
        expect(state.nodes[0].x).toBe(7);
    });

    it('焦点在 input 内 Ctrl+Z 不触发应用撤销（交给原生）', () => {
        state.nodes = [makeNode(0)];
        capture();
        state.nodes[0].x = 5;

        const input = document.createElement('input');
        document.body.appendChild(input);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        expect(state.nodes[0].x).toBe(5);   // 未被应用撤销
    });
});
