// clipboard.js: 粘贴节点卡片放在画布相机中心（viewport center in canvas coordinates），
// 而不是固定偏移原位置。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state } from '../../src/js/state.js';
import { initClipboard, clipboard } from '../../src/js/clipboard.js';
import { setFocusedNodeId } from '../../src/js/shared.js';
import { render } from '../../src/js/render.js';

vi.mock('../../src/js/render.js', () => ({ render: vi.fn() }));
vi.mock('../../src/js/state.js', async () => {
    const actual = await vi.importActual('../../src/js/state.js');
    return { ...actual, toast: vi.fn() };
});

function makeNode(over = {}) {
    return Object.assign({
        id: 'n_original', type: 'normal', name: 'node',
        x: 100, y: 200, w: 320,
        info: [], logic: [], groups: [],
        inPorts: ['in'], outPorts: ['out'],
    }, over);
}

describe('clipboard: 粘贴节点到画布相机中心', () => {
    beforeEach(() => {
        state.nodes = [];
        state.zoom = 1;
        state.panX = 0;
        state.panY = 0;
        clipboard.item = null;
        clipboard.type = null;
        setFocusedNodeId(null);
    });

    it('有 .canvas 时，粘贴到画布 viewport center（zoom=1, pan=0 → 直接是中心）', () => {
        // mock canvas rect: 800x600 居中在屏幕 (100, 50)
        document.body.innerHTML = `<div class="canvas" style="width:800px;height:600px;position:absolute;left:100px;top:50px"></div>`;
        // jsdom getBoundingClientRect 返回 0,0；需要 mock
        document.querySelector('.canvas').getBoundingClientRect = () => ({
            left: 100, top: 50, width: 800, height: 600, right: 900, bottom: 650, x: 100, y: 50,
        });
        const node = makeNode({ x: 100, y: 200 });
        state.nodes.push(node);
        clipboard.item = node;
        clipboard.type = 'node';
        setFocusedNodeId(node.id);
        initClipboard();

        // 触发 Ctrl+V 粘贴。dispatch 到 document.body 而非 document：
        // 真实浏览器里 e.target 总是 element（closest 是 HTMLElement 方法）；
        // dispatchEvent(document) 让 jsdom e.target=document，没 closest 方法会抛。
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));

        // 新节点 x/y 应该是画布中心的世界坐标：
        // (cr.width/2) / zoom - panX = 400 / 1 - 0 = 400
        // (cr.height/2) / zoom - panY = 300 / 1 - 0 = 300
        const pasted = state.nodes[1];
        expect(pasted.x).toBe(400);
        expect(pasted.y).toBe(300);
        // 不是原位置的 +40 偏移
        expect(pasted.x).not.toBe(140);
        expect(pasted.y).not.toBe(240);
    });

    it('zoom ≠ 1 / pan ≠ 0 时世界坐标转换正确', () => {
        document.body.innerHTML = `<div class="canvas" style="width:800px;height:600px"></div>`;
        document.querySelector('.canvas').getBoundingClientRect = () => ({
            left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0,
        });
        state.zoom = 0.5;     // 缩小
        state.panX = 50;      // 向右平移 50
        state.panY = -30;     // 向上平移 30
        const node = makeNode({ x: 999, y: 999 });
        state.nodes.push(node);
        clipboard.item = node;
        clipboard.type = 'node';
        setFocusedNodeId(node.id);
        initClipboard();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));

        // 世界中心 = (cr.width/2) / zoom - panX = 400 / 0.5 - 50 = 750
        //           = (cr.height/2) / zoom - panY = 300 / 0.5 - (-30) = 630
        const pasted = state.nodes[1];
        expect(pasted.x).toBe(750);
        expect(pasted.y).toBe(630);
    });

    it('无 .canvas 时 fallback 到原位置 +40 偏移（jsdom 测试极简 fixture）', () => {
        document.body.innerHTML = '';
        const node = makeNode({ x: 100, y: 200 });
        state.nodes.push(node);
        clipboard.item = node;
        clipboard.type = 'node';
        setFocusedNodeId(node.id);
        initClipboard();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));

        const pasted = state.nodes[1];
        expect(pasted.x).toBe(140);
        expect(pasted.y).toBe(240);
    });
});