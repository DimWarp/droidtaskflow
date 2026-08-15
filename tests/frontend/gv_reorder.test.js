import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { state } from '../../src/js/state.js';
import { initGlobalVars, renderGlobalVars, dropSlotForX, dropLineLeft } from '../../src/js/global-vars.js';

// 全局变量栏拖拽排序：
//   .gv-item__name（变量名）是拖拽手柄；位移超过 4px 才进入拖拽；
//   拖拽中在可停靠槽位显示竖线（.gv-drop-line），松手后按槽位重排 state.globalVars。

describe('全局变量栏拖拽排序', () => {
    beforeAll(() => {
        // 与 node_drag_transform.test.js 相同的 render() 最小 DOM（render 需要 #world）
        document.body.innerHTML = '<div id="world"></div><div class="canvas"></div>'
            + '<svg id="crossWireSVG"></svg><svg id="deleteBtnSVG"></svg><svg id="previewSVG"></svg>'
            + '<div id="globalVarsBar"><div id="gvItems"></div><button id="gvAdd"></button></div>';
        initGlobalVars();
    });

    beforeEach(() => {
        state.nodes = [];
        state.wires = [];
        state.globalVars = [
            { name: 'a', type: 'string', value: '', fixed: false },
            { name: 'b', type: 'string', value: '', fixed: false },
            { name: 'c', type: 'string', value: '', fixed: false },
        ];
        renderGlobalVars();
    });

    // jsdom 无布局 → getBoundingClientRect 全 0，无法按真实坐标算槽位。
    // 这里给每个 .gv-item 覆写 rect：a=[0,100) b=[100,200) c=[200,300)
    // （中线：a=50, b=150, c=250）。
    const RECTS = [
        { left: 0, width: 100 },
        { left: 100, width: 100 },
        { left: 200, width: 100 },
    ];
    function stubRects() {
        const items = [...document.querySelectorAll('#gvItems .gv-item')];
        items.forEach((el, i) => {
            Object.defineProperty(el, 'getBoundingClientRect', {
                value: () => ({ left: RECTS[i].left, width: RECTS[i].width }),
                configurable: true,
            });
        });
        return items;
    }
    const names = () => [...document.querySelectorAll('#gvItems .gv-item__name')].map(n => n.textContent);

    it('dropSlotForX 按中线计算槽位（纯函数）', () => {
        const mk = (left, width) => ({ getBoundingClientRect: () => ({ left, width }) });
        const items = [mk(100, 100), mk(200, 100)];   // 中线: b=150, c=250
        expect(dropSlotForX(items, 50)).toBe(0);       // b 之前
        expect(dropSlotForX(items, 149)).toBe(0);      // b 内且在中线左侧 → 仍归 b 前
        expect(dropSlotForX(items, 150)).toBe(1);      // 恰在中线 → 归到 b 后
        expect(dropSlotForX(items, 251)).toBe(2);      // c 内且在中线右侧 → 归到 c 后
        expect(dropSlotForX(items, 999)).toBe(2);      // 末尾
        expect(dropSlotForX([], 50)).toBe(0);          // 空列表
        expect(dropSlotForX(null, 50)).toBe(0);
        // minSlot 钳制（device_id 固定排最前）：最前槽位 0 被禁
        const firstFixed = [mk(0, 100), mk(100, 100)];  // 中线: device_id=50, a=150
        expect(dropSlotForX(firstFixed, 5, 1)).toBe(1);        // 指针在最左（device_id 前）→ 钳到 1
        expect(dropSlotForX(firstFixed, 50, 1)).toBe(1);       // 恰在固定项中线 → 仍 1
        expect(dropSlotForX(firstFixed, 149, 1)).toBe(1);      // a 内中线左侧 → 归到 a 前（即 device_id 后）
        expect(dropSlotForX(firstFixed, 150, 1)).toBe(2);      // 恰在 a 中线 → 归到 a 后
        expect(dropSlotForX(firstFixed, 999, 1)).toBe(2);      // 末尾不受影响
    });

    it('拖动 a 到 b,c 之间 → 排序为 [b,a,c]，指示竖线显示', () => {
        stubRects();
        const nameA = document.querySelectorAll('#gvItems .gv-item')[0].querySelector('.gv-item__name');
        nameA.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 150, clientY: 10 }));
        // 拖拽中：竖线指示器显示 + 被拖项弱化 + body 进入拖拽态
        const line = document.querySelector('.gv-drop-line');
        expect(line).toBeTruthy();
        expect(line.style.display).not.toBe('none');
        expect(document.querySelector('.gv-item--dragging')).toBeTruthy();
        expect(document.body.classList.contains('gv-dragging')).toBe(true);

        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        expect(state.globalVars.map(g => g.name)).toEqual(['b', 'a', 'c']);
        expect(names()).toEqual(['b', 'a', 'c']);
        // 拖拽态清理
        expect(document.body.classList.contains('gv-dragging')).toBe(false);
    });

    it('拖动 a 到末尾 → [b,c,a]', () => {
        stubRects();
        const nameA = document.querySelectorAll('#gvItems .gv-item')[0].querySelector('.gv-item__name');
        nameA.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 999, clientY: 10 }));
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        expect(state.globalVars.map(g => g.name)).toEqual(['b', 'c', 'a']);
    });

    it('位移未达阈值视为点击，不排序、不显示指示线', () => {
        stubRects();
        const nameA = document.querySelectorAll('#gvItems .gv-item')[0].querySelector('.gv-item__name');
        nameA.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 12, clientY: 10 }));  // 2px < 4px
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        expect(state.globalVars.map(g => g.name)).toEqual(['a', 'b', 'c']);
        expect(document.querySelector('.gv-drop-line')).toBeNull();  // 从未显示指示线
    });

    it('pointercancel 中止拖拽：不排序、不残留拖拽态', () => {
        stubRects();
        const nameA = document.querySelectorAll('#gvItems .gv-item')[0].querySelector('.gv-item__name');
        nameA.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 150, clientY: 10 }));
        document.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));
        expect(state.globalVars.map(g => g.name)).toEqual(['a', 'b', 'c']);
        expect(document.body.classList.contains('gv-dragging')).toBe(false);
        expect(document.querySelector('.gv-item--dragging')).toBeNull();
    });

    it('拖到自身原位置附近 → 顺序不变（幂等）', () => {
        stubRects();
        const nameB = document.querySelectorAll('#gvItems .gv-item')[1].querySelector('.gv-item__name');
        nameB.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 150, clientY: 10 }));
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 150, clientY: 10 }));
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        expect(state.globalVars.map(g => g.name)).toEqual(['a', 'b', 'c']);
    });

    it('dropLineLeft 按落位后相邻关系定位竖线（纯函数）', () => {
        // all: a=[0,100) b=[100,200) c=[200,300)
        const mk = (offsetLeft, offsetWidth) => ({ offsetLeft, offsetWidth });
        const all = [mk(0, 100), mk(100, 100), mk(200, 100)];
        // 拖最后一个变量 c(di=2) 位置不变(k=2) → 前一位是 all[1]=b，线在 b 右缘+5.5=205.5
        // （"位置不变 → 蓝线在变量左边"）
        expect(dropLineLeft(all, 2, 2)).toBe(205.5);
        // 拖 c 到 a,b 之间(k=1) → 线在 a 右缘 + DROP_LINE_SEP_OFFSET(5.5) = 105.5
        // （蓝线中心对齐变量分隔线中心，分隔线在 a 右缘 + gap6 + 分隔线半宽0.5 处）
        expect(dropLineLeft(all, 2, 1)).toBe(105.5);
        // 拖 c 到最前(k=0) → 线在最前
        expect(dropLineLeft(all, 2, 0)).toBe(0);
        // 拖中间项 a(di=0) 到末尾(k=2) → 前一位是 all[2]=c，线在 c 右缘+5.5=305.5
        expect(dropLineLeft(all, 0, 2)).toBe(305.5);
        // 拖 b(di=1) 到最前(k=0)
        expect(dropLineLeft(all, 1, 0)).toBe(0);
        // 拖 b(di=1) 到末尾(k=2) → 前一位是 all[2]=c → 305.5
        expect(dropLineLeft(all, 1, 2)).toBe(305.5);
        // 拖 a(di=0) 保持原位(k=0) → 线在最前
        expect(dropLineLeft(all, 0, 0)).toBe(0);
    });

    it('拖动最后一个变量、位置不变 → 指示线停在被拖项左侧（b 右缘+5.5），顺序不变', () => {
        state.globalVars = [
            { name: 'a', type: 'string', value: '', fixed: false },
            { name: 'b', type: 'string', value: '', fixed: false },
            { name: 'c', type: 'string', value: '', fixed: false },
        ];
        renderGlobalVars();
        const items = [...document.querySelectorAll('#gvItems .gv-item')];
        items.forEach((el, i) => {
            Object.defineProperty(el, 'getBoundingClientRect', {
                value: () => ({ left: i * 100, width: 100 }), configurable: true,
            });
            Object.defineProperty(el, 'offsetLeft', { value: i * 100, configurable: true });
            Object.defineProperty(el, 'offsetWidth', { value: 100, configurable: true });
        });
        const nameC = items[2].querySelector('.gv-item__name');
        nameC.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 250, clientY: 10 }));
        // 指针仍在 c 自己的区域内移动 → 槽位=末尾(k=2, di=2) → 线在 c 前面（b 右缘+5.5=205.5）
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 280, clientY: 10 }));
        expect(document.querySelector('.gv-drop-line').style.left).toBe('205.5px');
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        expect(state.globalVars.map(g => g.name)).toEqual(['a', 'b', 'c']);
    });

    it('不允许其它变量停靠到 device_id 前面（槽位钳到 1）', () => {
        state.globalVars = [
            { name: 'device_id', type: 'string', value: '', fixed: true },
            { name: 'a', type: 'string', value: '', fixed: false },
            { name: 'b', type: 'string', value: '', fixed: false },
        ];
        renderGlobalVars();
        const items = [...document.querySelectorAll('#gvItems .gv-item')];
        items.forEach((el, i) => Object.defineProperty(el, 'getBoundingClientRect', {
            value: () => ({ left: i * 100, width: 100 }), configurable: true,
        }));
        // 把 a 拖到最左边（device_id 前面）→ 槽位被钳为 device_id 之后
        const nameA = items[1].querySelector('.gv-item__name');
        nameA.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 150, clientY: 10 }));
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 5, clientY: 10 }));
        // 指示线仍显示（停靠在有效槽位 1），不会停在 device_id 前面
        expect(document.querySelector('.gv-drop-line').style.display).not.toBe('none');
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        expect(state.globalVars.map(g => g.name)).toEqual(['device_id', 'a', 'b']);
    });

    it('fixed 变量（device_id）不允许拖动', () => {
        state.globalVars = [
            { name: 'device_id', type: 'string', value: '', fixed: true },
            { name: 'a', type: 'string', value: '', fixed: false },
            { name: 'b', type: 'string', value: '', fixed: false },
        ];
        renderGlobalVars();
        // device_id 的名字不挂拖拽手柄（无 --draggable class、无 title）
        const nameId = document.querySelectorAll('#gvItems .gv-item')[0].querySelector('.gv-item__name');
        expect(nameId.classList.contains('gv-item__name--draggable')).toBe(false);
        // 模拟按住 device_id 名字大幅拖动 → 不进入拖拽、不排序
        nameId.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 999, clientY: 10 }));
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        expect(state.globalVars.map(g => g.name)).toEqual(['device_id', 'a', 'b']);
        expect(document.body.classList.contains('gv-dragging')).toBe(false);
        // 自定义变量名字仍可拖
        expect(document.querySelectorAll('#gvItems .gv-item')[1].querySelector('.gv-item__name').classList.contains('gv-item__name--draggable')).toBe(true);
    });
});
