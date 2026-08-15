/* ============================================================
   TOOLTIP — 全局静态悬浮提示（按钮 data-tooltip="key"）
   文本实时通过 t(key) 解析，语言切换后下次悬浮自动用新语言。
   ============================================================ */
import { t, onLanguageChange } from './i18n.js';

const TOOLTIP_DELAY = 600;
let _el = null;
let _timer = null;
let _target = null;

function getEl() {
    if (_el && _el.isConnected) return _el;
    _el = document.createElement('div');
    _el.className = 'app-tooltip';
    document.body.appendChild(_el);
    return _el;
}

export function hideTooltip() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
    _target = null;
    const el = getEl();
    el.classList.remove('app-tooltip--show');
    el.style.display = 'none';
}

function show(target) {
    const el = getEl();
    const key = target.dataset.tooltip;
    if (!key) return;
    el.textContent = t(key);
    const r = target.getBoundingClientRect();
    el.classList.remove('app-tooltip--show');
    el.style.display = 'block';
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.visibility = 'hidden';
    const ew = el.offsetWidth, eh = el.offsetHeight;
    let x = r.left + r.width / 2 - ew / 2;
    x = Math.max(4, Math.min(x, window.innerWidth - ew - 4));
    let y = r.top - eh - 8;
    if (y < 4) y = r.bottom + 8;   // 上方空间不足 → 翻到下方
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.visibility = '';
    el.classList.add('app-tooltip--show');
}

export function initTooltip() {
    document.addEventListener('mouseover', e => {
        const target = e.target.closest && e.target.closest('[data-tooltip]');
        if (!target) return;
        if (_target === target) return;
        hideTooltip();
        _target = target;
        _timer = setTimeout(() => show(target), TOOLTIP_DELAY);
    });
    document.addEventListener('mouseout', e => {
        if (_target && !(e.relatedTarget && _target.contains(e.relatedTarget))) hideTooltip();
    });
    document.addEventListener('scroll', () => hideTooltip(), true);
    window.addEventListener('resize', () => hideTooltip());
    // 语言切换时隐藏当前 tooltip：同元素悬浮因 _target===target 短路不会重算文本，
    // 切语言后下次悬浮（重新 show）才能用新语言。
    onLanguageChange(hideTooltip);
}
