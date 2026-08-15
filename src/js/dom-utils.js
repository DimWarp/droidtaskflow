/* ============================================================
   DOM UTILITIES
   ============================================================ */
export function E(tag, cls, attrs, kids) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
        if (k === 'style' && v) { for (const [sk, sv] of Object.entries(v)) e.style[sk] = sv; }
        else if (k.startsWith('data-')) e.setAttribute(k, v);
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e[k] = v;
    }
    if (kids) (Array.isArray(kids) ? kids.flat() : [kids]).forEach(k => {
        if (k != null) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    });
    return e;
}

export function editable(init, commit, cls) {
    let ed = false;
    const el = document.createElement('span');
    if (cls) el.className = cls;
    el.textContent = init;
    el.setAttribute('contenteditable', 'false');
    el.spellcheck = false;
    el.addEventListener('dblclick', () => {
        ed = true; el.setAttribute('contenteditable', 'true'); el.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.addRange(range);
    });
    el.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); el.textContent = init; el.blur(); }
    });
    el.addEventListener('blur', () => {
        if (!ed) return; ed = false; el.setAttribute('contenteditable', 'false');
        const v = el.textContent.trim();
        if (v && v !== init) commit(v); else el.textContent = init;
    });
    return el;
}

export function makePort(src, dir, bgColor, shape, extra) {
    const isCircle = (shape || 'circle') === 'circle';
    const cls = 'port port--' + (shape || 'circle');
    const attrs = Object.assign({}, extra || {}, { 'data-src': src, 'data-dir': dir });
    // 圆形口不画 backgroundColor（改由内联 SVG 圆承载，见 .port__circle），
    // 颜色存进 --port-c 供 SVG fill 与 wires.js 读取；方块口维持原 backgroundColor 方案。
    if (bgColor && !isCircle) attrs.style = { backgroundColor: bgColor };
    const el = E('button', cls, attrs);
    if (isCircle) {
        if (bgColor) el.style.setProperty('--port-c', bgColor);
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'port__svg');
        svg.setAttribute('viewBox', '0 0 14 14');
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('class', 'port__circle');
        c.setAttribute('cx', '7');
        c.setAttribute('cy', '7');
        c.setAttribute('r', '7');
        svg.appendChild(c);
        el.appendChild(svg);
    }
    return el;
}

/** 自定义悬浮提示单例：定位在触发元素左上角。原生 title 位置由浏览器控制无法移动。 */
let _portTooltipEl = null;
function showPortTooltip(anchor, text) {
    if (!text) return;
    if (!_portTooltipEl) {
        _portTooltipEl = document.createElement('div');
        _portTooltipEl.className = 'port__tooltip';
    }
    if (!_portTooltipEl.isConnected) document.body.appendChild(_portTooltipEl);
    _portTooltipEl.textContent = text;
    _portTooltipEl.classList.add('port__tooltip--show');
    const r = anchor.getBoundingClientRect();
    // 左上角：位于触发点左上方，留 6px 间隙；贴近视口边缘时夹紧
    const left = Math.max(4, r.left - _portTooltipEl.offsetWidth - 6);
    const top = Math.max(4, r.top - _portTooltipEl.offsetHeight - 6);
    _portTooltipEl.style.left = left + 'px';
    _portTooltipEl.style.top = top + 'px';
}
function hidePortTooltip() {
    if (_portTooltipEl) _portTooltipEl.classList.remove('port__tooltip--show');
}

/** goto 目标节点上的同心圈标记端口：外圈初始色、内圈白。无 data-dir → 不可被连线。 */
export function makeGotoMarkerPort(marker) {
    const el = document.createElement('span');
    el.className = 'port--goto-marker';
    // 自定义 tooltip（左上角）替代原生 title（右下角）：内容为追溯源头 alias，无连线回退 goto 名
    const tip = marker.title || marker.gotoName || '';
    el.addEventListener('mouseenter', () => showPortTooltip(el, tip));
    el.addEventListener('mouseleave', hidePortTooltip);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'port__svg');
    svg.setAttribute('viewBox', '0 0 14 14');
    const outer = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    outer.setAttribute('cx', '7'); outer.setAttribute('cy', '7'); outer.setAttribute('r', '7');
    const inner = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    inner.setAttribute('cx', '7'); inner.setAttribute('cy', '7'); inner.setAttribute('r', '3.5');
    svg.appendChild(outer); svg.appendChild(inner);
    el.appendChild(svg);
    return el;
}
