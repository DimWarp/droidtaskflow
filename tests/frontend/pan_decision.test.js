import { describe, it, expect } from 'vitest';
import { shouldStartPan, panButtonEdge } from '../../src/js/pan-decision.js';

describe('shouldStartPan', () => {
    it('中键 (1) 任何情况下都启动平移', () => {
        expect(shouldStartPan(1, true,  false, false, false)).toBe(true);
        expect(shouldStartPan(1, false, false, false, false)).toBe(true);
        expect(shouldStartPan(1, true,  true,  true,  true )).toBe(true);
        expect(shouldStartPan(1, false, true,  true,  false)).toBe(true);
    });
    it('拖线中右键 (2) 在任意目标上都启动平移', () => {
        expect(shouldStartPan(2, true,  false, false, true)).toBe(true);  // 节点上
        expect(shouldStartPan(2, true,  true,  true,  true)).toBe(true);  // 任意目标
        expect(shouldStartPan(2, false, false, false, true)).toBe(true);  // 空白
    });
    it('右键 (2) 跟中键一样穿透任何元素平移（contextmenu 已被全局 preventDefault）', () => {
        expect(shouldStartPan(2, false, false, false, false)).toBe(true);
        expect(shouldStartPan(2, true,  false, false, false)).toBe(true); // 节点上
        expect(shouldStartPan(2, false, true,  false, false)).toBe(true); // zoomBar
        expect(shouldStartPan(2, false, false, true,  false)).toBe(true); // toolbar
        expect(shouldStartPan(2, false, false, false, false, true)).toBe(true); // 删除钮
    });
    it('左键 (0) 只在空白且未拖线时平移', () => {
        expect(shouldStartPan(0, false, false, false, false)).toBe(true);
        expect(shouldStartPan(0, true,  false, false, false)).toBe(false); // 节点上
        expect(shouldStartPan(0, false, false, false, true )).toBe(false); // 拖线中
        expect(shouldStartPan(0, false, true,  false, false)).toBe(false); // zoomBar
        expect(shouldStartPan(0, false, false, true,  false)).toBe(false); // toolbar
        expect(shouldStartPan(0, false, false, false, false, true)).toBe(false); // 删除钮
    });
    it('其他按钮 (3/4/5) 不启动平移', () => {
        expect(shouldStartPan(3, false, false, false, false)).toBe(false);
        expect(shouldStartPan(4, true,  false, false, true )).toBe(false);
        expect(shouldStartPan(5, false, false, false, true )).toBe(false);
    });
});

// 位掩码：1=左 2=右 4=中
const EMPTY = { overNode: false, overZoomBar: false, overToolbar: false, wireDragActive: false };

describe('panButtonEdge — 按钮位掩码上升/下降沿', () => {
    it('拖线中（左键已按住）再按中键：pointermove(buttons 1→5) 识别为中键上升沿 → 启动中键平移', () => {
        const r = panButtonEdge(1, 5, { ...EMPTY, wireDragActive: true }, null);
        expect(r).toEqual({ start: true, button: 1 });
    });
    it('拖线中松中键：pointermove(buttons 5→1) 识别为中键下降沿 → 停止平移', () => {
        const r = panButtonEdge(5, 1, EMPTY, 1);
        expect(r).toEqual({ stop: true });
    });
    it('拖线中（左键已按住）按右键：pointermove(buttons 1→3) → 启动右键平移（即使光标在节点上）', () => {
        const r = panButtonEdge(1, 3, { overNode: true, overZoomBar: false, overToolbar: false, wireDragActive: true }, null);
        expect(r).toEqual({ start: true, button: 2 });
    });
    it('拖线中松右键：pointermove(buttons 3→1) → 停止平移', () => {
        const r = panButtonEdge(3, 1, EMPTY, 2);
        expect(r).toEqual({ stop: true });
    });
    it('普通中键单独按下：pointerdown(buttons 0→4) → 启动中键平移', () => {
        const r = panButtonEdge(0, 4, EMPTY, null);
        expect(r).toEqual({ start: true, button: 1 });
    });
    it('普通中键松开：pointerup(buttons 4→0) → 停止平移', () => {
        const r = panButtonEdge(4, 0, EMPTY, 1);
        expect(r).toEqual({ stop: true });
    });
    it('普通左键空白按下：pointerdown(buttons 0→1) → 启动左键平移', () => {
        const r = panButtonEdge(0, 1, EMPTY, null);
        expect(r).toEqual({ start: true, button: 0 });
    });
    it('左键按下节点标题（节点拖动）：不应启动平移', () => {
        const r = panButtonEdge(0, 1, { ...EMPTY, overNode: true }, null);
        expect(r).toBeNull();
    });
    it('拖线开始瞬间（左键在端口按下后 wireDrag 已置位）：不启动左键平移', () => {
        const r = panButtonEdge(0, 1, { ...EMPTY, wireDragActive: true }, null);
        expect(r).toBeNull();
    });
    it('纯移动（buttons 不变 1→1）：无动作', () => {
        expect(panButtonEdge(1, 1, { ...EMPTY, wireDragActive: true }, null)).toBeNull();
        expect(panButtonEdge(5, 5, EMPTY, 1)).toBeNull();
    });
    it('中键平移中左键松开（buttons 5→4）：平移不中断', () => {
        const r = panButtonEdge(5, 4, EMPTY, 1);
        expect(r).toBeNull();
    });
    it('右键平移中左键松开（buttons 3→2）：平移不中断', () => {
        const r = panButtonEdge(3, 2, EMPTY, 2);
        expect(r).toBeNull();
    });
    it('非拖线右键在空白按下：pointerdown(buttons 0→2) → 启动右键平移', () => {
        const r = panButtonEdge(0, 2, EMPTY, null);
        expect(r).toEqual({ start: true, button: 2 });
    });
    it('非拖线右键在节点上按下：启动（跟中键一样穿透）', () => {
        const r = panButtonEdge(0, 2, { ...EMPTY, overNode: true }, null);
        expect(r).toEqual({ start: true, button: 2 });
    });
    // ---- overWireDelete 贯通（真实路径：捕获相位 pointerdown 会走到 panButtonEdge）----
    it('左键按下删除钮：不启动平移（overWireDelete 排除贯通到真实路径）', () => {
        const r = panButtonEdge(0, 1, { ...EMPTY, overWireDelete: true }, null);
        expect(r).toBeNull();
    });
    it('非拖线右键按下删除钮：启动平移（穿透任何元素）', () => {
        const r = panButtonEdge(0, 2, { ...EMPTY, overWireDelete: true }, null);
        expect(r).toEqual({ start: true, button: 2 });
    });
    it('拖线中右键按下删除钮：仍启动平移（拖线恒可平移，不被排除覆盖）', () => {
        const r = panButtonEdge(0, 3, { ...EMPTY, wireDragActive: true, overWireDelete: true }, null);
        expect(r).toEqual({ start: true, button: 2 });
    });
    it('空白左键按下：仍启动平移（overWireDelete 不影响正常平移）', () => {
        const r = panButtonEdge(0, 1, EMPTY, null);
        expect(r).toEqual({ start: true, button: 0 });
    });
});
