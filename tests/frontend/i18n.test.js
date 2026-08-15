import { describe, it, expect, beforeEach, vi } from 'vitest';
import { t, defaultLang, getLang, setLang, toggleLang, applyStaticDom, applyLanguage, onLanguageChange } from '../../src/js/i18n.js';

describe('t()', () => {
    it('命中当前语言', () => {
        setLang('zh');
        expect(t('toolbar.openDir')).toBe('配置工作目录');
    });
    it('英文命中', () => {
        setLang('en');
        expect(t('toolbar.openDir')).toBe('Configure workspace');
    });
    it('占位符插值', () => {
        setLang('zh');
        expect(t('toast.added', { name: 'adb tap' })).toBe('已添加 adb tap');
    });
    it('英文缺失回退中文', () => {
        setLang('en');
        expect(t('only.zhKey')).toBe('仅中文');
    });
    it('中英都缺返回键名', () => {
        setLang('zh');
        expect(t('no.such.key')).toBe('no.such.key');
    });
});

describe('defaultLang', () => {
    it('zh 浏览器 → zh', () => {
        Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true });
        expect(defaultLang()).toBe('zh');
    });
    it('其它语言 → en', () => {
        Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });
        expect(defaultLang()).toBe('en');
    });
});

describe('setLang 后 DOM 更新', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <span data-i18n="sidebar.projects">工程</span>
            <button data-i18n-title="toolbar.save">保存工程</button>
            <input data-i18n-placeholder="code.searchPlaceholder" />
        `;
    });
    it('html lang / data-i18n / data-i18n-title / data-i18n-placeholder 更新', () => {
        setLang('en');
        expect(document.documentElement.getAttribute('lang')).toBe('en');
        expect(document.body.querySelector('[data-i18n]').textContent).toBe('Projects');
        expect(document.body.querySelector('[data-i18n-title]').title).toBe('Save project');
        expect(document.body.querySelector('[data-i18n-placeholder]').placeholder).toBe('Search...');
    });
    it('toggleLang 在 zh/en 间切换', () => {
        setLang('zh');
        toggleLang();
        expect(getLang()).toBe('en');
        toggleLang();
        expect(getLang()).toBe('zh');
    });
    it('onLanguageChange 钩子被调用', () => {
        const fn = vi.fn();
        onLanguageChange(fn);
        setLang('en');
        expect(fn).toHaveBeenCalled();
    });
    it('applyLanguage 独立调用刷新静态 DOM', () => {
        setLang('en');
        document.body.querySelector('[data-i18n]').textContent = '旧值';
        applyLanguage();
        expect(document.body.querySelector('[data-i18n]').textContent).toBe('Projects');
    });
});
