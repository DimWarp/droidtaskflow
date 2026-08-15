/* ============================================================
   GOTO NODE — 纯逻辑（标记端口命名 + 派生 + 悬浮标题）
   ============================================================ */

import { DEFS } from './state.js';

/** 在传入 state 内按 id 查卡片（不依赖模块级全局 state，保证可测） */
function localCard(state, id) {
    for (const n of state.nodes) {
        for (const t of (n.info || [])) if (t.id === id) return t;
        for (const col of (n.logic || [])) for (const t of (col || [])) if (t.id === id) return t;
        for (const g of (n.groups || [])) {
            if (g.id === id) return g;
            for (const o of (g.ops || [])) if (o.id === id) return o;
        }
    }
    return null;
}

/**
 * 连线来源的显示名（alias，不带 id）。
 * - nodeId.taskId.port（任务卡输出 / 操作组触发）→ 卡别名 _name || DEF 别名 || def
 * - nodeId.port（节点出口）→ 节点名
 * 无法识别返回 null。
 */
export function wireSourceLabel(state, from) {
    const parts = (from || '').split('.');
    if (parts.length >= 3) {
        const card = localCard(state, parts[1]);
        if (card && card.def) {
            const d = DEFS[card.def];
            return card._name || (d && d.alias) || card.def;
        }
        if (card && card.name) return card.name;
        return null;
    }
    if (parts.length === 2) {
        const n = state.nodes.find(x => x.id === parts[0]);
        return n && n.name ? n.name : null;
    }
    return null;
}

/**
 * goto 标记端口的悬浮标题：追溯到最根源源头（喂给 goto 对应入口的卡/出口），
 * 无连线则回退为 goto 名。都不带节点 id，只显示 alias。
 */
export function gotoMarkerTitle(state, gotoId, entryName) {
    const g = state.nodes.find(x => x.id === gotoId);
    if (!g) return '';
    const w = state.wires.find(w => w.to === gotoId + '.' + entryName);
    if (w) {
        const label = wireSourceLabel(state, w.from);
        if (label) return label;
    }
    return g.name || '';
}

/** goto 入口对应的目标标记端口名：g<gotoId>_<入口名> */
export function gotoMarkerPortName(gotoId, entryName) {
    return `${gotoId}_${entryName}`;
}

/** 解析扁平边端口名 → { gotoId, entryName }；非 goto 标记端口返回 null */
export function parseGotoMarkerPort(portName) {
    const m = /^(g\d+)_(.+)$/.exec(portName || '');
    if (!m) return null;
    return { gotoId: m[1], entryName: m[2] };
}

/**
 * 派生目标节点上的 goto 标记端口（不写进 D.inPorts，纯渲染层）。
 * 每个 goto 节点的每个入口 → 目标节点上一个 marker（选择目标即显示，不要求已接线）。
 * @returns {Record<string, {portName:string, gotoId:string, gotoName:string, entryName:string}[]>}
 */
export function deriveGotoMarkers(state) {
    const markersByNode = {};
    for (const g of state.nodes) {
        if (g.type !== 'goto' || !g.target) continue;
        for (const pn of (g.inPorts || [])) {
            const m = { portName: gotoMarkerPortName(g.id, pn), gotoId: g.id, gotoName: g.name, entryName: pn };
            m.title = gotoMarkerTitle(state, g.id, pn);
            if (!markersByNode[g.target]) markersByNode[g.target] = [];
            markersByNode[g.target].push(m);
        }
    }
    return markersByNode;
}
