#!/usr/bin/env node
// scripts/dev-tools/probe-intra-wire.mjs — 测量「节点内卡片连线」线端点 vs 端口视觉圆心。
//
// 自包含：种子一个含节点内连线（t1.sameout → t2.samein）的工程 → 打开 → 量测。
// 每根节点内路径（非强制线）取 path 端点（SVG 局部坐标），换算成屏幕坐标，
// 与对应 .port 元素中心、.port__circle 视觉中心对比，输出像素偏差。
//
// Usage:
//   node scripts/dev-tools/probe-intra-wire.mjs [--port 9223] [--match 5173]
//
// Exit codes: 0 = ok, 2 = chrome unreachable, 1 = runtime error

import process from 'node:process';
import { readFileSync } from 'node:fs';

const PORT = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : 9223;
const MATCH = process.argv.includes('--match') ? process.argv[process.argv.indexOf('--match') + 1] : '5173';
const BASE = `http://localhost:${MATCH}`;
// 可选：--dsl <path> 用真实工程文件（如 tmp-shots/111.py）；默认用内置样例
const DSL_PATH = process.argv.includes('--dsl') ? process.argv[process.argv.indexOf('--dsl') + 1] : null;

const DSL = DSL_PATH ? readFileSync(DSL_PATH, 'utf8') : `"""
@droidtaskflow:project
@droidtaskflow:version 1.0
"""
import sys
from pathlib import Path

try:
    from droidtaskflow import (
        project, start_node, node, node_info_task, node_logic_task,
        node_op_group, node_op_group_task, node_exit, edge, global_var,
    )
    from droidtaskflow.tool import adb_tool, llm_tool
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from droidtaskflow import (
        project, start_node, node, node_info_task, node_logic_task,
        node_op_group, node_op_group_task, node_exit, edge, global_var,
    )
    from droidtaskflow.tool import adb_tool, llm_tool

project("WireProbe", version="1.0")
start_node("n1")

global_var("device_id", "string", "")

@node("n1", name="start", position={"x":100,"y":100})
@node_exit("out", "out")
def n1():
    pass


@node("n2", name="wireprobe", position={"x":460,"y":120})
@node_exit("out", "out")
@node_info_task("current_activity", alias="ia", id="ia")
@node_logic_task("logic_print", alias="lp", id="lp", wires={"input": "ia.package"})
def n2():
    pass


@node("n3", name="wireprobe2", position={"x":460,"y":620})
@node_exit("out", "out")
@node_logic_task("passthrough", alias="t1", id="t1")
@node_logic_task("passthrough", alias="t2", id="t2", wires={"samein": "t1.sameout"})
@node_op_group("grp1", name="g1", forced=True, exit="out", trigger="t2.sameout")
@node_op_group_task("logic_print", alias="op1", id="op1")
def n3():
    pass


if __name__ == '__main__':
    try:
        __file__
        from droidtaskflow import run_project_file
        run_project_file(__file__)
    except NameError:
        pass  # Pyodide / embedded — no __file__, parse-only mode
`;

class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this._id = 0;
        this._pending = new Map();
        this.ws.addEventListener('message', (e) => this._onMessage(e));
        this.open = new Promise((res, rej) => {
            this.ws.addEventListener('open', () => res(), { once: true });
            this.ws.addEventListener('error', () => rej(new Error('websocket error')), { once: true });
        });
    }
    _onMessage(e) {
        const m = JSON.parse(e.data);
        if (m.id != null) {
            const p = this._pending.get(m.id);
            if (!p) return;
            this._pending.delete(m.id);
            if (m.error) p.rej(new Error(m.error.message));
            else p.res(m.result);
        }
    }
    send(method, params = {}) {
        const id = ++this._id;
        return new Promise((res, rej) => {
            const t = setTimeout(() => { this._pending.delete(id); rej(new Error(`CDP ${method} timeout`)); }, 15000);
            this._pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    close() { try { this.ws.close(); } catch {} }
}

async function findTab(port, match) {
    const r = await fetch(`http://localhost:${port}/json`);
    if (!r.ok) throw new Error(`/json returned ${r.status}`);
    const tabs = await r.json();
    const pages = tabs.filter(t => t.type === 'page');
    if (match) { const hit = pages.find(t => t.url.includes(match)); if (hit) return hit; }
    if (pages.length) return pages[0];
    throw new Error('no page tab found');
}

async function evalJS(cdp, expr) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text}: ${r.exceptionDetails.exception?.description ?? ''}`);
    return r.result.value;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 导航到 about:blank 再进 app —— 绕过 probe.mjs 发现的「--url 同 path 跳过导航」问题。
async function hardNavigate(cdp, url) {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    const p = new Promise(res => {
        const i = setInterval(async () => {
            const v = await evalJS(cdp, `document.readyState === 'complete' ? 1 : 0`).catch(() => 0);
            if (v) { clearInterval(i); res(); }
        }, 60);
        setTimeout(() => { clearInterval(i); res(); }, 8000);
    });
    await cdp.send('Page.navigate', { url });
    await p;
    await sleep(300);
}

async function waitFor(cdp, expr, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        try {
            const v = await evalJS(cdp, expr);
            if (v) return v;
        } catch {}
        await sleep(120);
    }
    throw new Error(`waitFor timeout: ${expr}`);
}

async function main() {
    let tab;
    try { tab = await findTab(PORT, MATCH); }
    catch (e) { console.error(`Cannot reach Chrome on ${PORT}: ${e.message}`); process.exit(2); }

    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.open;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // 1) 种子 OPFS 工作区 + 写入工程文件 + IndexedDB 存 dirHandle
    await hardNavigate(cdp, BASE + '/');
    await waitFor(cdp, `!!document.getElementById('startupBtnHistory')`);
    const seed = await evalJS(cdp, `(async () => {
        const root = await navigator.storage.getDirectory();
        const ws = await root.getDirectoryHandle('dtf-wire-probe', { create: true });
        const proj = await ws.getDirectoryHandle('project', { create: true });
        const fh = await proj.getFileHandle('main.py', { create: true });
        const w = await fh.createWritable();
        await w.write(${JSON.stringify(DSL)});
        await w.close();
        const db = await new Promise((res, rej) => {
            const req = indexedDB.open('droidtaskflow', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('settings');
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
        });
        await new Promise((res, rej) => {
            const tx = db.transaction('settings', 'readwrite');
            tx.objectStore('settings').put(ws, 'dirHandle');
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
        });
        const perm = await ws.queryPermission({ mode: 'readwrite' });
        return { perm, files: await (async () => { const l = []; for await (const [n] of proj.entries()) l.push(n); return l; })() };
    })()`);
    console.error(`# seed: perm=${seed.perm} files=${JSON.stringify(seed.files)}`);

    // 2) 重载 → 历史按钮 → 打开工程
    await hardNavigate(cdp, BASE + '/');
    await waitFor(cdp, `!!document.getElementById('startupBtnHistory')`);
    const histVisible = await evalJS(cdp, `(() => {
        const b = document.getElementById('startupBtnHistory');
        return getComputedStyle(b).display !== 'none';
    })()`);
    console.error(`# history btn visible: ${histVisible}`);
    await evalJS(cdp, `document.getElementById('startupBtnHistory').click()`);
    await sleep(500);
    const fileCount = await waitFor(cdp, `document.querySelectorAll('.sidebar__file').length`);
    console.error(`# sidebar files: ${fileCount}`);
    await evalJS(cdp, `(() => {
        const f = [...document.querySelectorAll('.sidebar__file')].find(e => (e.querySelector('.sidebar__file-name')||{}).textContent === 'WireProbe') || document.querySelector('.sidebar__file');
        f.click();
    })()`);

    // 3) 等节点渲染（含 pyodide 加载，可能要一会儿）
    await waitFor(cdp, `document.querySelectorAll('#world .node').length >= 2`, 30000);
    await sleep(800);

    // 4) 量测函数：节点内路径端点 vs 端口中心
    const measureFn = `(() => {
        const zoom = (() => {
            const m = getComputedStyle(document.getElementById('world')).transform;
            const mm = m.match(/matrix\\(([^)]+)\\)/);
            return mm ? Math.abs(parseFloat(mm[1].split(',')[0])) : 1;
        })();
        const out = { zoom, wires: [] };
        const nodes = [...document.querySelectorAll('#world .node')];
        for (const node of nodes) {
            const ns = node.querySelector('.node__wires');
            if (!ns) continue;
            const nsr = ns.getBoundingClientRect();
            const paths = [...ns.querySelectorAll('path.wire-line:not(.wire-line--forced)')];
            for (const p of paths) {
                const d = p.getAttribute('d') || '';
                // 解析 path：M/L 各 2 数 1 点；C 累积 6 数取末对（端点），忽略控制点
                const pts = [];
                const tokens = d.split(/\\s+/);
                let cmd = null, buf = [];
                const NEED = { M: 2, L: 2, C: 6 };
                for (const tk of tokens) {
                    if (/^[MLC]$/.test(tk)) { cmd = tk; buf = []; continue; }
                    if (!cmd) continue;
                    buf.push(...tk.split(',').map(Number));
                    const need = NEED[cmd];
                    if (buf.length >= need) {
                        if (cmd === 'M' || cmd === 'L') { pts.push({ x: buf[0], y: buf[1] }); buf = []; }
                        else { pts.push({ x: buf[4], y: buf[5] }); buf = []; }
                    }
                }
                if (pts.length < 2) { out.wires.push({ d, error: 'parse' }); continue; }
                const start = pts[0], end = pts[pts.length - 1];
                // 找最近的端口（元素中心）
                const ports = [...node.querySelectorAll('.port[data-src]')].map(pr => {
                    const r = pr.getBoundingClientRect();
                    const c = pr.querySelector('.port__circle');
                    const cr = c ? c.getBoundingClientRect() : null;
                    return {
                        src: pr.getAttribute('data-src'),
                        dir: pr.getAttribute('data-dir'),
                        portCx: (r.left + r.width / 2 - nsr.left) / zoom,
                        portCy: (r.top + r.height / 2 - nsr.top) / zoom,
                        circleCx: cr ? (cr.left + cr.width / 2 - nsr.left) / zoom : null,
                        circleCy: cr ? (cr.top + cr.height / 2 - nsr.top) / zoom : null,
                        circleVsPort: cr ? { dx: (cr.left + cr.width/2) - (r.left + r.width/2), dy: (cr.top + cr.height/2) - (r.top + r.height/2) } : null,
                    };
                });
                const nearest = (x, y) => {
                    let best = null, bd = Infinity;
                    for (const pt of ports) {
                        const dd = Math.hypot(pt.portCx - x, pt.portCy - y);
                        if (dd < bd) { bd = dd; best = pt; }
                    }
                    return { pt: best, dist: bd };
                };
                const ns_ = nearest(start.x, start.y);
                const ne_ = nearest(end.x, end.y);
                out.wires.push({
                    d,
                    start: { x: start.x, y: start.y },
                    end: { x: end.x, y: end.y },
                    startNearest: ns_.pt ? { src: ns_.pt.src, dir: ns_.pt.dir, distPx: +(ns_.dist * zoom).toFixed(3), dxPx: +((start.x - ns_.pt.portCx) * zoom).toFixed(3), dyPx: +((start.y - ns_.pt.portCy) * zoom).toFixed(3) } : null,
                    endNearest: ne_.pt ? { src: ne_.pt.src, dir: ne_.pt.dir, distPx: +(ne_.dist * zoom).toFixed(3), dxPx: +((end.x - ne_.pt.portCx) * zoom).toFixed(3), dyPx: +((end.y - ne_.pt.portCy) * zoom).toFixed(3) } : null,
                    circleVsPortSample: ports.find(p => p.circleVsPort) ? ports.find(p => p.circleVsPort).circleVsPort : null,
                });
            }
        }
        return out;
    })()`;

    // 5) 多档缩放量测：把 zoom 归位到 1.0，再依次放大
    async function setZoomTo(target) {
        const cur = await evalJS(cdp, `(Number(getComputedStyle(document.getElementById('world')).transform.match(/matrix\\(([^)]+)\\)/)[1].split(',')[0]) || 1)`);
        const steps = Math.round((target - cur) / 0.1);
        const btn = steps >= 0 ? 'zoomPlus' : 'zoomMinus';
        for (let i = 0; i < Math.abs(steps); i++) await evalJS(cdp, `document.getElementById('${btn}').click()`);
        await sleep(200);
    }
    await setZoomTo(1.0);

    let allMax = 0;
    for (const z of [1.0, 0.5, 0.3, 1.3, 1.7, 2.0]) {
        await setZoomTo(z);
        const measure = await evalJS(cdp, measureFn);
        console.log(`\n========== zoom = ${measure.zoom} ==========`);
        for (const w of measure.wires) {
            console.log(`--- wire ---`);
            console.log(`  d = ${w.d}`);
            if (w.error) { console.log(`  parse error`); continue; }
            console.log(`  start 端点(${w.start.x},${w.start.y}) → 最近口 ${w.startNearest ? JSON.stringify(w.startNearest) : '无'}`);
            console.log(`  end   端点(${w.end.x},${w.end.y}) → 最近口 ${w.endNearest ? JSON.stringify(w.endNearest) : '无'}`);
            console.log(`  circleVsPort (元素中心差) = ${JSON.stringify(w.circleVsPortSample)}`);
        }
        for (const w of measure.wires) {
            if (w.startNearest) allMax = Math.max(allMax, Math.abs(w.startNearest.dxPx), Math.abs(w.startNearest.dyPx));
            if (w.endNearest) allMax = Math.max(allMax, Math.abs(w.endNearest.dxPx), Math.abs(w.endNearest.dyPx));
        }
    }

    console.log(`\n=== 判定 ===`);
    console.log(`  端点 vs 端口元素中心 最大偏差: ${allMax}px`);
    console.log(`  ${allMax <= 0.05 ? '对齐 ✅' : '仍偏 ❌'}`);

    cdp.close();
    process.exit(allMax <= 0.05 ? 0 : 1);
}

main().catch(e => { console.error('fatal:', e.message ?? e); process.exit(1); });
