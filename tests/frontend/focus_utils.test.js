// focus-utils.disableButtonTabIndex: 默认所有 <button> tabindex=-1（跳过键盘 Tab 焦点循环），
// 仅 input/textarea/select 等表单控件保留 Tab；显式 tabindex="0" 的 button 保留。
import { describe, it, expect, beforeEach } from 'vitest';
import { disableButtonTabIndex } from '../../src/js/focus-utils.js';

describe('disableButtonTabIndex', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('现有 button 自动 tabindex=-1；input/textarea/select 不动；显式 tabindex=0 保留', () => {
        document.body.innerHTML = `
            <div>
                <button>A</button>
                <button>B</button>
                <button tabindex="0">C</button>
                <input type="text">
                <textarea></textarea>
                <select><option>x</option></select>
                <a href="#">link</a>
            </div>
        `;

        disableButtonTabIndex();

        expect(document.querySelectorAll('button')[0].tabIndex).toBe(-1);
        expect(document.querySelectorAll('button')[1].tabIndex).toBe(-1);
        expect(document.querySelectorAll('button')[2].tabIndex).toBe(0);
        // 表单控件不被脚本动
        expect(document.querySelector('input').tabIndex).toBe(0);
        expect(document.querySelector('textarea').tabIndex).toBe(0);
        expect(document.querySelector('select').tabIndex).toBe(0);
        // link 不被脚本动
        expect(document.querySelector('a').tabIndex).toBe(0);
    });

    it('后续插入的 button 也会被 MutationObserver 自动 tabindex=-1', async () => {
        document.body.innerHTML = `<div id="root"></div>`;
        disableButtonTabIndex();

        const root = document.getElementById('root');
        // 直接 child
        const btn1 = document.createElement('button');
        btn1.textContent = 'X';
        root.appendChild(btn1);
        // 嵌套子树
        const div = document.createElement('div');
        const btn2 = document.createElement('button');
        btn2.textContent = 'Y';
        div.appendChild(btn2);
        root.appendChild(div);
        // 显式保留
        const btn3 = document.createElement('button');
        btn3.textContent = 'Z';
        btn3.setAttribute('tabindex', '0');
        root.appendChild(btn3);

        // MutationObserver 在 jsdom 里走 microtask 异步，等待 flush
        await new Promise(r => setTimeout(r, 0));

        expect(btn1.tabIndex).toBe(-1);
        expect(btn2.tabIndex).toBe(-1);
        expect(btn3.tabIndex).toBe(0);
    });

    it('显式 tabindex="-1" 也保留（不重复设置，不破坏语义）', () => {
        document.body.innerHTML = `<button tabindex="-1">A</button>`;
        disableButtonTabIndex();
        expect(document.querySelector('button').tabIndex).toBe(-1);
    });

    it('input/button 这种带 type 的 input[type=button] 不会被误判为 BUTTON 元素', () => {
        // <input type="button"> 是 INPUT 元素，不是 BUTTON；不该被改 tabindex。
        document.body.innerHTML = `
            <input type="button" value="x">
            <button>real</button>
        `;
        disableButtonTabIndex();
        expect(document.querySelector('input[type=button]').tabIndex).toBe(0);  // 不动
        expect(document.querySelector('button').tabIndex).toBe(-1);  // 真 button 改
    });
});