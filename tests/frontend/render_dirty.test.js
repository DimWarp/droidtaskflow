import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '../../src/js/render.js';
import { state } from '../../src/js/state.js';

// 回归：i18n 引导钩子（onLanguageChange → render）在空画布/语言切换时做的是
// "纯重渲"（文档内容没变），但 render() 无条件 state.dirty = true，导致未打开工程
// 就被标 dirty → 点击工程时 confirmSaveBeforeClose 误弹"保存更改"。修复：render(skipDirty)。
describe('render() 的 dirty 语义', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="world"></div><div class="canvas"></div><svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>';
        state.wires = [];
        state.nodes = [];
        state.globalVars = [];
        state.dirty = false;
    });

    it('默认（编辑渲染）标记 dirty', () => {
        render();
        expect(state.dirty).toBe(true);
    });

    it('纯重渲（语言切换/空画布启动渲染）不标记 dirty', () => {
        render(true);
        expect(state.dirty).toBe(false);
    });

    it('纯重渲保留已有 dirty（不清除）', () => {
        state.dirty = true;
        render(true);
        expect(state.dirty).toBe(true);
    });
});
