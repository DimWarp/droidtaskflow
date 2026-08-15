import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { state, DEFS } from '../../src/js/state.js';
import { render } from '../../src/js/render.js';
import { setFocusedNodeId, setFocusedCardId } from '../../src/js/shared.js';
import { initClipboard } from '../../src/js/clipboard.js';

beforeAll(() => {
    initClipboard();
});

// 操作组内卡片成为焦点时，所在 op-group 同步高亮（op-group--focused），
// 保持组上下文可见。render 每次全量重建节点，焦点 class 在渲染时同步加上。

beforeEach(() => {
    document.body.innerHTML = '<div id="world"></div><div class="canvas"></div>'
        + '<svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
    state.wires = [];
    state.nodes = [];
    state.globalVars = [];
    state.zoom = 1;
    setFocusedNodeId(null);
    setFocusedCardId(null);
    DEFS['tap'] = { name: 'tap', alias: 'Tap', params: [], rets: [] };
});

function nodeWithGroup() {
    return [{
        id: 'n1', name: 'N', x: 0, y: 0, w: 560, colF: [1, 1, 1.15],
        info: [], logic: [], inPorts: ['in'], outPorts: ['out'],
        groups: [{ id: 'g1', name: 'G1', on: false, ops: [{ id: 't1', def: 'tap', f: {}, in: {} }] }],
    }];
}

describe('操作组内卡片焦点 → 操作组同步高亮', () => {
    it('render 路径：组内任务成为焦点时，所在 op-group 也加 op-group--focused', () => {
        state.nodes = nodeWithGroup();
        setFocusedNodeId('n1');
        setFocusedCardId('t1');
        render();

        const task = document.querySelector('[data-task-id="t1"]');
        const grp = document.querySelector('[data-group-id="g1"]');
        expect(task).toBeTruthy();
        expect(grp).toBeTruthy();
        expect(task.classList.contains('task--focused')).toBe(true);
        expect(grp.classList.contains('op-group--focused')).toBe(true);
    });

    it('焦点在操作组本身时，只高亮组，不误加 task 焦点', () => {
        state.nodes = nodeWithGroup();
        setFocusedNodeId('n1');
        setFocusedCardId('g1');
        render();

        const task = document.querySelector('[data-task-id="t1"]');
        const grp = document.querySelector('[data-group-id="g1"]');
        expect(grp.classList.contains('op-group--focused')).toBe(true);
        expect(task.classList.contains('task--focused')).toBe(false);
    });

    it('普通列任务成为焦点时不误伤 op-group', () => {
        const nodes = nodeWithGroup();
        nodes[0].info = [{ id: 'tA', def: 'tap', f: {}, in: {} }];
        state.nodes = nodes;
        setFocusedNodeId('n1');
        setFocusedCardId('tA');
        render();

        const grp = document.querySelector('[data-group-id="g1"]');
        expect(document.querySelector('[data-task-id="tA"]').classList.contains('task--focused')).toBe(true);
        expect(grp.classList.contains('op-group--focused')).toBe(false);
    });

    it('clipboard 点击刷新路径：pointerdown 组内任务 → op-group 同步高亮', () => {
        state.nodes = nodeWithGroup();
        render();
        const task = document.querySelector('[data-task-id="t1"]');
        // 模拟点击组内任务卡片：capture 阶段的 pointerdown 处理器设置焦点并刷新 class
        task.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
        const grp = document.querySelector('[data-group-id="g1"]');
        expect(task.classList.contains('task--focused')).toBe(true);
        expect(grp.classList.contains('op-group--focused')).toBe(true);
    });
});
