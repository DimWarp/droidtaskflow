/* ============================================================
   WIRE DRAG + SVG
   ============================================================ */
import { state, find, nodeOf, colOf, isValidConnection } from './state.js';
import { makePort } from './dom-utils.js';
import { render } from './render.js';
import { capture } from './history.js';

export let wireDrag = null;
export let hoveredWire = null;
export let hoverLeaveTimer = null;
export let wireGeom = {};
export function setHoveredWire(val) { hoveredWire = val; }

/** 端口颜色：圆形口读内联 SVG 圆的 fill（值来自 --port-c），其余（方块口）读 background-color。 */
function portColor(el) {
    if (!el) return null;
    if (el.querySelector) {
        const c = el.querySelector('.port__circle');
        if (c) {
            const f = getComputedStyle(c).fill;
            if (f && f !== 'none') return f;
        }
        const pv = el.style && el.style.getPropertyValue ? el.style.getPropertyValue('--port-c').trim() : '';
        if (pv) return pv;
    }
    return getComputedStyle(el).backgroundColor;
}

/* ---------- 连线曲率参数 ----------
   task（任务卡片等）：三阶（4 点）贝塞尔，M fx fy C (fx+mx) fy (tx-mx) ty tx ty，mx = 控制点水平偏移。
   nodeToNode（节点 rail→rail）：6 点（五阶）贝塞尔，参考 scripts/dev-tools/bezier-tuner.html：
     mx 分方向：tx-fx<0（向左）→ min(max(|dx|×factorx, min_mx×zoom), max_mx×zoom)；
                tx-fx>=0（向右）→ max(|dx|×factorx, min_mx×zoom)。
     my = (ty−fy) × factory
     P0(fx,fy) P1(fx+mx,fy) P2(fx+mx,fy+my) P3(tx−mx,ty−my) P4(tx−mx,ty) P5(tx,ty)
   两者独立配置。SVG 没有五阶路径命令，nodeToNode 用自适应折线化绘制（形状 = 真五阶曲线）。 */
const WIRE_CURVE = {
    // 节点 rail→rail：6 点五阶。min_mx=下限（原 min 改名），max_mx=向左上限（可手调）
    nodeToNode: { factorx: 0.5, factory: 0.7, min_mx: 50, max_mx: 450 },
    // 其余连线（任务卡片等）：三阶（4 点）C，独立 factor + min
    task: { factor: 0.6, min: 30 },
};

const isNodeRailPort = (el) => !!(el && el.closest && el.closest('.node__port-rail'));

/** 返回连线控制点数组：task 4 点（三阶 C），nodeToNode 6 点（五阶）。坐标为画布坐标。 */
function curveCtrl(fx, fy, tx, ty, isNodeToNode) {
    if (isNodeToNode) {
        const cfg = WIRE_CURVE.nodeToNode;
        const raw = Math.abs(tx - fx) * cfg.factorx;
        // tx-fx<0（向左）：对 mx 加最大值上限 max_mx；tx-fx>=0（向右）：用 min_mx 作下限
        const mx = tx - fx < 0
            ? Math.min(Math.max(raw, cfg.min_mx * state.zoom), cfg.max_mx * state.zoom)
            : Math.max(raw, cfg.min_mx * state.zoom);
        const my = (ty - fy) * cfg.factory;
        return [
            { x: fx, y: fy }, { x: fx + mx, y: fy }, { x: fx + mx, y: fy + my },
            { x: tx - mx, y: ty - my }, { x: tx - mx, y: ty }, { x: tx, y: ty },
        ];
    }
    const cfg = WIRE_CURVE.task;
    const mx = Math.max(Math.abs(tx - fx) * cfg.factor, cfg.min * state.zoom);
    return [
        { x: fx, y: fy }, { x: fx + mx, y: fy }, { x: tx - mx, y: ty }, { x: tx, y: ty },
    ];
}

/** 点到线段距离（平直度判定）。 */
function distToLine(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const cx = a.x + t * dx, cy = a.y + t * dy;
    return Math.hypot(p.x - cx, p.y - cy);
}

/** 贝塞尔折线化（自适应细分，平直即停）——用于 6 点五阶的 SVG path。 */
function flattenBezier(ctrl, tol = 0.02, maxDepth = 16) {
    const pts = [ctrl[0]];
    const N = ctrl.length;
    function rec(c, depth) {
        const a = c[0], b = c[N - 1];
        let flat = true;
        for (let i = 1; i < N - 1; i++) {
            if (distToLine(c[i], a, b) > tol) { flat = false; break; }
        }
        if (flat || depth >= maxDepth) { pts.push(b); return; }
        // de Casteljau t=0.5 分裂成左右两段
        const l = [a], r = [b];
        let A = c;
        for (let k = 1; k < N; k++) {
            const B = [];
            for (let i = 0; i < A.length - 1; i++) {
                B.push({ x: (A[i].x + A[i + 1].x) / 2, y: (A[i].y + A[i + 1].y) / 2 });
            }
            l.push(B[0]);
            r.push(B[B.length - 1]);
            A = B;
        }
        rec(l, depth + 1);
        rec(r.reverse(), depth + 1);
    }
    rec(ctrl, 0);
    return pts;
}

/** 控制点数组 → SVG path d：4 点用三阶 C（task，保持原样）；6 点用五阶折线。 */
function pathForCtrl(ctrl) {
    if (ctrl.length === 4) {
        return `M ${ctrl[0].x} ${ctrl[0].y} C ${ctrl[1].x} ${ctrl[1].y} ${ctrl[2].x} ${ctrl[2].y} ${ctrl[3].x} ${ctrl[3].y}`;
    }
    return flattenBezier(ctrl).map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
}

/** 曲线在 t=0.5 的点（删除按钮定位）。 */
function curveMidPoint(ctrl) {
    let a = ctrl;
    while (a.length > 1) {
        const b = [];
        for (let i = 0; i < a.length - 1; i++) b.push({ x: (a[i].x + a[i + 1].x) / 2, y: (a[i].y + a[i + 1].y) / 2 });
        a = b;
    }
    return a[0];
}

/* ---------- drag preview ---------- */
let _lastMouseX = 0, _lastMouseY = 0;

/** 用上次的鼠标位置重画预览（缩放按钮等没有 pointer event 的场景）。 */
export function redrawPreview() {
    drawPreview(_lastMouseX, _lastMouseY);
}

export function drawPreview(mouseX, mouseY) {
    _lastMouseX = mouseX; _lastMouseY = mouseY;
    const l = document.getElementById('previewSVG');
    const c = document.querySelector('.canvas');
    const cr = c.getBoundingClientRect();
    l.setAttribute('width', c.scrollWidth);
    l.setAttribute('height', c.scrollHeight);
    if (!wireDrag) { l.innerHTML = ''; return; }

    // 源端口位置每次重算：拖拽中途缩放/平移后，端口在视口的位置会变，
    // 直接读实时 DOM 取当前坐标，否则预览线起点会停在旧位置与缩放后内容错位。
    let fx, fy;
    const srcEl = document.querySelector(`[data-src="${wireDrag.src}"]`);
    if (srcEl) {
        const r = srcEl.getBoundingClientRect();
        fx = r.left + r.width/2 - cr.left + c.scrollLeft;
        fy = r.top + r.height/2 - cr.top + c.scrollTop;
    } else {
        fx = wireDrag.fx; fy = wireDrag.fy;
    }

    let tp = null, snapX = null, snapY = null;
    const tgt = document.elementFromPoint(mouseX, mouseY);
    const el = tgt && (tgt.closest('.port[data-dir="in"]') || tgt.closest('.port[data-dir="out"]'));
    if (el && el.dataset.src !== wireDrag.src) {
        const [fromTaskId] = wireDrag.src.split('.');
        const [toTaskId] = el.dataset.src.split('.');
        if (isValidConnection(fromTaskId, toTaskId, wireDrag.srcDir, el.dataset.dir)) { tp = el; }
    }

    let tx, ty;
    if (tp) {
        const r = tp.getBoundingClientRect();
        tx = r.left + r.width/2 - cr.left + c.scrollLeft;
        ty = r.top + r.height/2 - cr.top + c.scrollTop;
        snapX = tx; snapY = ty;
    } else {
        tx = mouseX - cr.left + c.scrollLeft;
        ty = mouseY - cr.top + c.scrollTop;
    }

    const pendingSrc = tp ? tp.dataset.src : null;
    let h = '';
    for (const w of state.wires) {
        const isPending = pendingSrc && w.to === pendingSrc;
        if (!isPending) continue;
        const fe = document.querySelector(`[data-src="${w.from}"]`);
        const te = document.querySelector(`[data-src="${w.to}"]`);
        if (!fe || !te) continue;
        const fr = fe.getBoundingClientRect(), tr = te.getBoundingClientRect();
        const fx2 = fr.left + fr.width/2 - cr.left + c.scrollLeft;
        const fy2 = fr.top + fr.height/2 - cr.top + c.scrollTop;
        const tx2 = tr.left + tr.width/2 - cr.left + c.scrollLeft;
        const ty2 = tr.top + tr.height/2 - cr.top + c.scrollTop;
        const col = portColor(fe);
        const ctrl2 = curveCtrl(fx2, fy2, tx2, ty2, isNodeRailPort(fe) && isNodeRailPort(te));
        h += `<path d="${pathForCtrl(ctrl2)}" stroke="${col}" stroke-width="${2 * state.zoom}" fill="none" stroke-dasharray="${6 * state.zoom} ${4 * state.zoom}" style="pointer-events:none"/>`;
    }
    const lineCol = wireDrag.color;
    const ctrl = curveCtrl(fx, fy, tx, ty, isNodeRailPort(srcEl) && (!tp || isNodeRailPort(tp)));
    h += `<path class="wire-preview" d="${pathForCtrl(ctrl)}" stroke="${lineCol}" stroke-width="${2 * state.zoom}" fill="none" style="pointer-events:none"/>`;
    if (tp && snapX !== null) {
        const portCol = portColor(tp);
        const isSquare = tp.classList.contains('port--square');
        if (isSquare) {
            const sz = 13, rad = 3, sw = 2;
            h += `<g transform="translate(${snapX},${snapY}) scale(${state.zoom})"><rect x="${-sz/2}" y="${-sz/2}" width="${sz}" height="${sz}" rx="${rad}" ry="${rad}" fill="${portCol}" style="pointer-events:none"/></g>`;
            h += `<g transform="translate(${snapX},${snapY}) scale(${state.zoom})"><rect x="${-(sz+2*sw)/2}" y="${-(sz+2*sw)/2}" width="${sz + 2*sw}" height="${sz + 2*sw}" rx="${rad + sw}" ry="${rad + sw}" fill="none" stroke="${wireDrag.color}" stroke-width="${sw}" style="pointer-events:none"/></g>`;
        } else {
            h += `<g transform="translate(${snapX},${snapY}) scale(${state.zoom})"><circle cx="0" cy="0" r="7" fill="${portCol}" style="pointer-events:none"/></g>`;
            h += `<g transform="translate(${snapX},${snapY}) scale(${state.zoom})"><circle cx="0" cy="0" r="9" fill="none" stroke="${wireDrag.color}" stroke-width="2" style="pointer-events:none"/></g>`;
        }
    }
    if (wireDrag.detachedX !== undefined) {
        const portDefault = getComputedStyle(document.documentElement).getPropertyValue('--port-default').trim() || 'oklch(0.62 0.02 270)';
        const detEl = wireDrag.detachedEl ? wireDrag.detachedEl : null;
        const detCol = detEl ? portColor(detEl) : portDefault;
        const detIsSquare = detEl && detEl.classList.contains('port--square');
        // detached 位置同样实时重算（缩放后输入端口会移动）
        let detX = wireDrag.detachedX, detY = wireDrag.detachedY;
        if (detEl && detEl.isConnected) {
            const dr = detEl.getBoundingClientRect();
            detX = dr.left + dr.width/2 - cr.left + c.scrollLeft;
            detY = dr.top + dr.height/2 - cr.top + c.scrollTop;
        }
        if (detIsSquare) {
            const sz = 13, rad = 3, sw = 2;
            h += `<g transform="translate(${detX},${detY}) scale(${state.zoom})"><rect x="${-sz/2}" y="${-sz/2}" width="${sz}" height="${sz}" rx="${rad}" ry="${rad}" fill="${detCol}" style="pointer-events:none"/></g>`;
            h += `<g transform="translate(${detX},${detY}) scale(${state.zoom})"><rect x="${-(sz+2*sw)/2}" y="${-(sz+2*sw)/2}" width="${sz + 2*sw}" height="${sz + 2*sw}" rx="${rad + sw}" ry="${rad + sw}" fill="none" stroke="${portDefault}" stroke-width="${sw}" style="pointer-events:none"/></g>`;
        } else {
            h += `<g transform="translate(${detX},${detY}) scale(${state.zoom})"><circle cx="0" cy="0" r="7" fill="${detCol}" style="pointer-events:none"/></g>`;
            h += `<g transform="translate(${detX},${detY}) scale(${state.zoom})"><circle cx="0" cy="0" r="9" fill="none" stroke="${portDefault}" stroke-width="2" style="pointer-events:none"/></g>`;
        }
    }
    l.innerHTML = h;
    // remove conflicting wire from crossWireSVG when target changes
    if (tp !== wireDrag.hoveredTarget) { wireDrag.hoveredTarget = tp; drawWires(); }
}

export function deleteWire(wireId) {
    capture();
    state.wires = state.wires.filter(w => w.id !== wireId);
    state.dirty = true;
    for (const n of state.nodes) {
        for (const g of (n.groups || [])) {
            if (g.in) {
                for (const [k, v] of Object.entries(g.in)) {
                    const w = state.wires.find(w => w.from === v && w.to === g.id + '.' + k);
                    if (!w) delete g.in[k];
                }
            }
        }
        for (const t of [...n.info, ...(n.logic || []).flat(), ...n.groups.flatMap(g => g.ops)]) {
            if (t.in) {
                for (const [k, v] of Object.entries(t.in)) {
                    const w = state.wires.find(w => w.from === v && w.to === t.id + '.' + k);
                    if (!w) delete t.in[k];
                }
            }
        }
    }
    render();
}

export function startDrag(srcEl) {
    capture();   // 连线手势起点：整段手势一步撤销（新线 / 重接 / 断线均含编辑前状态）
    if (hoveredWire) { setHoveredWire(null); drawWires(); }
    let fx, fy, color, srcId, detachedTo = null, detachedX, detachedY;
    if (srcEl.dataset.dir === 'out') {
        // group out old wire kept for dashed preview; cleaned in pointerup
    }
    if (srcEl.dataset.dir === 'in') {
        const old = state.wires.find(w => w.to === srcEl.dataset.src);
        if (!old) return;
        state.wires = state.wires.filter(w => w.to !== srcEl.dataset.src);
        const [tid, pn] = srcEl.dataset.src.split('.');
        const tt = find(tid);
        if (tt && tt.in) delete tt.in[pn];
        detachedTo = srcEl.dataset.src;
        const c = document.querySelector('.canvas');
        const cr2 = c.getBoundingClientRect();
        const tr = srcEl.getBoundingClientRect();
        detachedX = tr.left + tr.width/2 - cr2.left + c.scrollLeft;
        detachedY = tr.top + tr.height/2 - cr2.top + c.scrollTop;
        const srcPort = document.querySelector(`[data-src="${old.from}"]`);
        if (srcPort) {
            const r = srcPort.getBoundingClientRect();
            const c2 = document.querySelector('.canvas');
            const cr = c2.getBoundingClientRect();
            fx = r.left + r.width/2 - cr.left + c2.scrollLeft;
            fy = r.top + r.height/2 - cr.top + c2.scrollTop;
            color = portColor(srcPort);
            srcId = old.from;
        }
    }
    if (fx === undefined) {
        const r = srcEl.getBoundingClientRect();
        const c3 = document.querySelector('.canvas');
        const cr = c3.getBoundingClientRect();
        fx = r.left + r.width/2 - cr.left + c3.scrollLeft;
        fy = r.top + r.height/2 - cr.top + c3.scrollTop;
        color = portColor(srcEl);
        srcId = srcEl.dataset.src;
    }
    wireDrag = { src: srcId, color, fx, fy, srcDir: srcEl.dataset.dir, detachedTo,
                 detachedX, detachedY, detachedEl: srcEl.dataset.dir === 'in' ? srcEl : null };
}

export function bindWireDrag() {
    document.querySelectorAll('.port[data-dir="out"]').forEach(b => {
        b.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.stopPropagation();
            startDrag(b);
        });
    });
}

export function drawWires(skipInternal = false) {
    const c = document.querySelector('.canvas');
    const cr = c.getBoundingClientRect();
    const liveIds = new Set(state.wires.map(w => w.id));
    for (const id of Object.keys(wireGeom)) { if (!liveIds.has(id)) delete wireGeom[id]; }

    const portPos = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width/2 - cr.left + c.scrollLeft, y: r.top + r.height/2 - cr.top + c.scrollTop }; };

    // 端口元素 / 位置 / 颜色按 data-src 去重：同一端口被多条线引用时只 query/测一次
    // （getBoundingClientRect 同步强制布局、getComputedStyle 强制样式计算，是热点）。
    // 同一帧内同步循环中元素与样式稳定，缓存安全。
    const elCache = new Map(), posCache = new Map(), colCache = new Map();
    const cachedEl = (src) => {
        let e = elCache.get(src);
        if (!e) { e = document.querySelector(`[data-src="${src}"]`); elCache.set(src, e); }
        return e;
    };
    const cachedPos = (el) => {
        const s = el.getAttribute('data-src');
        let p = posCache.get(s);
        if (!p) { p = portPos(el); posCache.set(s, p); }
        return p;
    };
    const cachedCol = (el) => {
        const s = el.getAttribute('data-src');
        if (!colCache.has(s)) colCache.set(s, portColor(el));
        return colCache.get(s);
    };

    const wireLineSvg = (w, ctrl, col, zoomMul) => {
        let sw = hoveredWire === w.id ? 3 : 2;
        if (zoomMul) sw *= state.zoom;
        return `<g data-wire="${w.id}"><path class="wire-line" d="${pathForCtrl(ctrl)}" stroke="${col}" stroke-width="${sw}" fill="none" style="pointer-events:none"/></g>`;
    };
    const deleteBtnSvg = (w, midX, midY, col) => {
        const isH = hoveredWire === w.id;
        const op = isH ? 1 : 0;
        const pe = isH ? 'all' : 'none';
        return `<g class="wire-delete" data-wire="${w.id}" transform="translate(${midX},${midY}) scale(${state.zoom})" style="cursor:pointer;pointer-events:${pe};opacity:${op}">`
            + `<circle r="6" fill="var(--bg)" stroke="${col}" stroke-width="1.2"/>`
            + `<path d="M -1.6 -1.6 L 1.6 1.6 M 1.6 -1.6 L -1.6 1.6" stroke="${col}" stroke-width="1.2" stroke-linecap="round"/>`
            + `</g>`;
    };

    const crossList = [], intraList = [];
    state.wires.forEach((w, i) => {
        if (!w.id) w.id = 'w' + Date.now() + '_' + i;
        const fe = cachedEl(w.from), te = cachedEl(w.to);
        if (!fe || !te) return;
        const fp = cachedPos(fe), tp = cachedPos(te);
        const col = cachedCol(fe);
        const isNN = isNodeRailPort(fe) && isNodeRailPort(te);
        const ctrl = curveCtrl(fp.x, fp.y, tp.x, tp.y, isNN);
        const mid = curveMidPoint(ctrl);
        wireGeom[w.id] = { fx: fp.x, fy: fp.y, tx: tp.x, ty: tp.y, ctrl };
        const entry = { w, fx: fp.x, fy: fp.y, tx: tp.x, ty: tp.y, col, ctrl, midX: mid.x, midY: mid.y };
        const fnEl = fe.closest('.node'), tnEl = te.closest('.node');
        if (fnEl && tnEl && fnEl === tnEl) { entry.nodeEl = fnEl; intraList.push(entry); }
        else { crossList.push(entry); }
    });

    const crossSvg = document.getElementById('crossWireSVG');
    crossSvg.setAttribute('width', c.scrollWidth);
    crossSvg.setAttribute('height', c.scrollHeight);
    let crossH = '', delH = '';
    const pendingTarget = wireDrag?.hoveredTarget?.dataset?.src;
    crossList.forEach(e => {
        if (pendingTarget && e.w.to === pendingTarget) return;
        crossH += wireLineSvg(e.w, e.ctrl, e.col, true);
        delH += deleteBtnSvg(e.w, e.midX, e.midY, e.col);
    });
    crossSvg.innerHTML = crossH;

    // 节点内连线：删除钮画在外部 deleteBtnSVG（不随 world transform 走）→ 平移期间
    // 也要重建；路径画在节点内 .node__wires（随 transform 自动平移）→ skipInternal
    // 时跳过路径重建，省掉每节点一次 rect + innerHTML。
    intraList.forEach(e => {
        if (pendingTarget && e.w.to === pendingTarget) return;
        delH += deleteBtnSvg(e.w, e.midX, e.midY, e.col);
    });
    if (!skipInternal) {
        document.querySelectorAll('.node__wires').forEach(s => { s.innerHTML = ''; });
        const intraByNode = new Map();   // 按节点聚合：每节点一次 rect + 一次 innerHTML 赋值
        intraList.forEach(e => {
            if (pendingTarget && e.w.to === pendingTarget) return;
            const ns = e.nodeEl.querySelector('.node__wires');
            if (!ns) return;
            let ent = intraByNode.get(ns);
            if (!ent) {
                const nr = e.nodeEl.getBoundingClientRect();
                const nx = nr.left - cr.left + c.scrollLeft, ny = nr.top - cr.top + c.scrollTop;
                const z = state.zoom;
                const nw = nr.width / z, nh = nr.height / z;
                ent = { nx, ny, z, nw, nh, html: '' };
                intraByNode.set(ns, ent);
                ns.style.width = nw + 'px';
                ns.style.height = nh + 'px';
                ns.setAttribute('width', nw);
                ns.setAttribute('height', nh);
            }
            ent.html += wireLineSvg(e.w, e.ctrl.map(p => ({ x: (p.x - ent.nx) / ent.z, y: (p.y - ent.ny) / ent.z })), e.col, false);
        });
        intraByNode.forEach((ent, ns) => { ns.innerHTML = ent.html; });
    }

    // 强制连线：操作组出口（方块口）→ 配对节点出口。自动、不可交互：
    // 不在 state.wires 中，无 data-wire / 删除钮 / hover，pointer-events 关闭。
    // 全部画在节点内 .node__wires（随 world transform 自动平移）→ 平移期间跳过。
    if (!skipInternal) {
        for (const node of state.nodes) {
            const nodeEl = node.el;
            if (!nodeEl) continue;
            const ns = nodeEl.querySelector('.node__wires');
            if (!ns) continue;
            const nr = nodeEl.getBoundingClientRect();
            // .node__wires SVG 的 origin 在节点 padding-box 顶（absolute top:0 相对 padding box，
            // 节点带 1px border → SVG 比 border-box 低 1px）。连线坐标必须按 SVG origin 算，
            // 否则整条线会恒偏右下 1px（用户可见"线偏下"）。nr 仅用于算 SVG 尺寸。
            const nsr = ns.getBoundingClientRect();
            const nx = nsr.left - cr.left + c.scrollLeft, ny = nsr.top - cr.top + c.scrollTop;
            const z = state.zoom;
            const nw = nr.width / z, nh = nr.height / z;
            ns.style.width = nw + 'px';
            ns.style.height = nh + 'px';
            ns.setAttribute('width', nw);
            ns.setAttribute('height', nh);
            for (const g of (node.groups || [])) {
                if (!g.exit) continue;
                const sp = nodeEl.querySelector(`.op-group__exit-port[data-src="${g.id}.out"]`);
                const outEl = nodeEl.querySelector(`[data-src="${node.id}.${g.exit}"]`);
                if (!sp || !outEl) continue;
                const sr = sp.getBoundingClientRect(), or = outEl.getBoundingClientRect();
                // 端口 rect 是视口坐标，需转画布坐标（- cr.left + c.scrollLeft）再减节点画布原点 nx/ny，
                // 否则会多出 canvas 偏移，连线偏右偏下。
                const fx = (sr.left + sr.width / 2 - cr.left + c.scrollLeft - nx) / z;
                const fy = (sr.top + sr.height / 2 - cr.top + c.scrollTop - ny) / z;
                const tx = (or.left + or.width / 2 - cr.left + c.scrollLeft - nx) / z;
                const ty = (or.top + or.height / 2 - cr.top + c.scrollTop - ny) / z;
                const col = portColor(outEl);
                const mx = Math.max(Math.abs(tx - fx) * 0.5, 24);
                ns.innerHTML += `<path class="wire-line wire-line--forced" d="M ${fx} ${fy} C ${fx+mx} ${fy} ${tx-mx} ${ty} ${tx} ${ty}" stroke="${col}" stroke-width="2" fill="none" style="pointer-events:none"/>`;
            }
        }
    }

    const delSvg = document.getElementById('deleteBtnSVG');
    delSvg.setAttribute('width', c.scrollWidth);
    delSvg.setAttribute('height', c.scrollHeight);
    delSvg.innerHTML = delH;

    document.querySelectorAll('.wire-delete').forEach(d => {
        d.addEventListener('pointerdown', e => e.stopPropagation());
        d.addEventListener('click', e => {
            e.stopPropagation();
            const wireId = d.dataset.wire;
            hoveredWire = null;
            if (hoverLeaveTimer) { clearTimeout(hoverLeaveTimer); hoverLeaveTimer = null; }
            deleteWire(wireId);
        });
    });
}

/* ---------- nearest-wire hover ---------- */
function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx*dx + dy*dy;
    let t = len2 > 0 ? ((px-ax)*dx + (py-ay)*dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t*dx, cy = ay + t*dy;
    return Math.hypot(px-cx, py-cy);
}

/** 点到贝塞尔曲线距离：按控制点数组通用采样（task 4 点 / nodeToNode 6 点），de Casteljau。 */
function distToBezier(px, py, ctrl) {
    let minD = Infinity, prev = ctrl[0];
    const N = ctrl.length;
    for (let i = 1; i <= 16; i++) {
        const t = i / 16;
        let a = ctrl;
        for (let r = 1; r < N; r++) {
            const b = [];
            for (let k = 0; k < N - r; k++) {
                b.push({ x: (1 - t) * a[k].x + t * a[k + 1].x, y: (1 - t) * a[k].y + t * a[k + 1].y });
            }
            a = b;
        }
        const p = a[0];
        const d = distToSegment(px, py, prev.x, prev.y, p.x, p.y);
        if (d < minD) minD = d;
        prev = p;
    }
    return minD;
}

export function updateHoverFromPointer(clientX, clientY) {
    if (wireDrag) return;
    const c = document.querySelector('.canvas');
    const cr = c.getBoundingClientRect();
    const px = clientX - cr.left + c.scrollLeft;
    const py = clientY - cr.top + c.scrollTop;
    if (px < 0 || py < 0 || px > c.scrollWidth || py > c.scrollHeight) {
        if (hoveredWire) { hoveredWire = null; drawWires(); }
        return;
    }
    const dists = [];
    for (const id of Object.keys(wireGeom)) {
        const g = wireGeom[id];
        const d = distToBezier(px, py, g.ctrl);
        dists.push({ id, d });
    }
    dists.sort((a, b) => a.d - b.d);
    const ENTER_TOL = 16;
    const STICK_TOL = 16;

    if (hoveredWire) {
        const cur = dists.find(x => x.id === hoveredWire);
        if (cur && cur.d <= STICK_TOL) { return; }
    }

    const newHover = dists.length && dists[0].d <= ENTER_TOL ? dists[0].id : null;
    if (newHover !== hoveredWire) {
        hoveredWire = newHover;
        drawWires();
    }
}

/* Wire drag document-level event handlers */
document.addEventListener('pointermove', e => {
    if (!wireDrag) return;
    drawPreview(e.clientX, e.clientY);
});

document.addEventListener('pointerup', e => {
    if (!wireDrag) return;
    if (e.button !== 0) return;   // 中/右键松开不完成连线（拖线只由左键发起）
    let tp = wireDrag.hoveredTarget;
    const tgt = document.elementFromPoint(e.clientX, e.clientY);
    const fresh = tgt && (tgt.closest('.port[data-dir="in"]') || tgt.closest('.port[data-dir="out"]'));
    if (fresh && fresh.dataset.src !== wireDrag.src) {
        const [ftId] = wireDrag.src.split('.');
        const [ttId] = fresh.dataset.src.split('.');
        if (isValidConnection(ftId, ttId, wireDrag.srcDir, fresh.dataset.dir)) tp = fresh;
    }
    if (tp && tp.dataset.src !== wireDrag.src) {
        const [tid, pn] = tp.dataset.src.split('.');
        let owner = state.nodes.flatMap(n => n.groups || []).find(g => g.id === tid);
        let isNodeLevel = false;
        if (!owner) { owner = find(tid); }
        if (!owner) { owner = state.nodes.find(n => n.id === tid); isNodeLevel = true; }
        if (owner) {
            const sourceIsNodeOut = wireDrag.src.endsWith('.out') && state.nodes.some(n => n.id + '.out' === wireDrag.src || n.outPorts.some(p => n.id + '.' + p === wireDrag.src));
            const targetIsNodeIn = isNodeLevel && tp.dataset.dir === 'in';
            state.wires = state.wires.filter(w => {
                if (w.to === tp.dataset.src) return false;
                if (sourceIsNodeOut && targetIsNodeIn && w.from === wireDrag.src) return false;
                return true;
            });
            let wireFrom, wireTo;
            if (isNodeLevel) {
                // 节点级目标（入口 / 出口）：连线由 state.wires 驱动，无 inPort 缓存
                wireFrom = wireDrag.src;
                wireTo = tp.dataset.src;
            } else {
                // 任务 / 操作组端口（如 g.id.trigger）：记入 owner.in 映射
                owner.in = owner.in || {};
                owner.in[pn] = wireDrag.src;
                wireFrom = wireDrag.src;
                wireTo = tp.dataset.src;
            }
            state.wires.push({ from: wireFrom, to: wireTo });
        }
    }
    wireDrag = null;
    document.getElementById('previewSVG').innerHTML = '';
    render();
});
