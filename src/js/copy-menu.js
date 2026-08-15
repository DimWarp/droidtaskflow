// 复制右键菜单：替换浏览器默认右键菜单，只留"复制"。
// 浮层元素 position:fixed（默认挂 document.body，也可挂到某个弹窗根节点，
// 随弹窗销毁一并移除）；由 attach() 绑定的元素在 contextmenu 时展示。
// 点空白 / Esc / 失焦 / resize 都关闭；滚动时由调用方在滚动容器上调用 hide()。
// 底部抽屉控制台与自动化日志弹窗共用。

import { t } from './i18n.js';

export function createCopyMenu(parent = document.body) {
  const menu = document.createElement('div');
  menu.className = 'console-copy-menu';
  menu.hidden = true;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = t('console.copy');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    copy();
    hide();
  });
  menu.appendChild(btn);
  parent.appendChild(menu);

  let source = null;   // 无选中文字时的兜底复制源（innerText）

  function copy() {
    const sel = window.getSelection();
    const text = sel ? sel.toString() : '';
    const payload = text || (source ? source.innerText : '') || '';
    if (!payload) return;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(payload).catch(() => _fallbackCopy(payload));
    } else {
      _fallbackCopy(payload);
    }
  }

  function show(x, y) {
    menu.hidden = false;
    // 先放到不可见位置测量尺寸，再 clamp 到视口内
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    menu.style.left = Math.min(Math.max(0, x), Math.max(0, maxX)) + 'px';
    menu.style.top  = Math.min(Math.max(0, y), Math.max(0, maxY)) + 'px';
  }

  function hide() { menu.hidden = true; }

  function attach(el, opts = {}) {
    el.addEventListener('contextmenu', (e) => {
      if (opts.exclude && opts.exclude(e.target)) return;
      e.preventDefault();
      source = el;
      show(e.clientX, e.clientY);
    });
  }

  // 点空白 / Esc / 失焦 都关菜单
  const onDocDown = (e) => {
    if (menu.hidden) return;
    if (menu.contains(e.target)) return;
    hide();
  };
  const onKey = (e) => { if (e.key === 'Escape' && !menu.hidden) hide(); };
  const onBlur = () => hide();
  const onResize = () => hide();
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onResize);

  return {
    menu,
    attach,
    show,
    hide,
    destroy() {
      menu.remove();
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
    },
  };
}

function _fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (_) {}
  ta.remove();
}
