import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { initTooltip } from '../../src/js/tooltip.js';
import { setLang } from '../../src/js/i18n.js';

describe('app-tooltip', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <button id="a" data-tooltip="tooltip.openDir">A</button>
            <div id="noTooltip">B</div>
        `;
        initTooltip();
        vi.useFakeTimers();
    });
    afterEach(() => { vi.useRealTimers(); });

    it('mouseover 后延迟显示，文本取 t(key)', () => {
        setLang('zh');   // jsdom navigator.language 默认 en-US，显式指定语言保证确定性
        const btn = document.getElementById('a');
        btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
        const tip = document.querySelector('.app-tooltip');
        expect(tip.style.display).toBe('none');        // 未到延迟，未显示
        vi.advanceTimersByTime(600);
        expect(tip.textContent).toBe('配置工作目录');
        expect(tip.classList.contains('app-tooltip--show')).toBe(true);
    });

    it('切换语言后悬浮显示新语言', () => {
        const btn = document.getElementById('a');
        setLang('en');
        btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
        vi.advanceTimersByTime(600);
        expect(document.querySelector('.app-tooltip').textContent).toBe('Configure workspace');
    });

    it('mouseout 立即隐藏', () => {
        const btn = document.getElementById('a');
        btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
        vi.advanceTimersByTime(600);
        const tip = document.querySelector('.app-tooltip');
        expect(tip.classList.contains('app-tooltip--show')).toBe(true);
        document.body.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
        expect(tip.classList.contains('app-tooltip--show')).toBe(false);
    });

    it('语言切换时隐藏当前 tooltip（避免同元素 _target 短路不刷新文本）', () => {
        setLang('zh');
        const btn = document.getElementById('a');
        btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
        vi.advanceTimersByTime(600);
        const tip = document.querySelector('.app-tooltip');
        expect(tip.classList.contains('app-tooltip--show')).toBe(true);
        setLang('en');
        expect(tip.classList.contains('app-tooltip--show')).toBe(false);
    });
});
