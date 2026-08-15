#!/usr/bin/env node
// scripts/dev-tools/repro-wire-pan.mjs — CDP 复现「拖线中按中/右键平移」。
//
// 自包含：导航到全新 URL（重置输入状态）→ 临时模式 + 添加节点 → 找一个可命中的
// 出口端口 → 模拟：左键按下开始拖线 → 移动 → 中键按下 → 中键拖动 → 中键松开 →
// 左键松开。记录全部 pointer 事件，对比 world transform 是否因平移改变。
//
// Usage:
//   node scripts/dev-tools/repro-wire-pan.mjs
//   node scripts/dev-tools/repro-wire-pan.mjs --port 9223 --match 5173
//
// Exit codes: 0 = ok (平移生效), 3 = 平移未生效, 2 = chrome unreachable, 1 = runtime error

import process from 'node:process';

const PORT = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : 9223;
const MATCH = process.argv.includes('--match') ? process.argv[process.argv.indexOf('--match') + 1] : '5173';
const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : `http://localhost:${MATCH === '5173' ? '5173' : MATCH}`;

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
            const t = setTimeout(() => { this._pending.delete(id); rej(new Error(`CDP ${method} timeout`)); }, 8000);
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

async function main() {
    let tab;
    try { tab = await findTab(PORT, MATCH); }
    catch (e) { console.error(`Cannot reach Chrome on ${PORT}: ${e.message}`); process.exit(2); }

    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.open;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // 导航到全新 URL，重置任何残留的鼠标/拖拽状态
    const freshURL = `${BASE}/?repro-pan=${Date.now()}`;
    console.error(`# navigating: ${freshURL}`);
    await cdp.send('Page.navigate', { url: freshURL });
    // 等 app 初始化完成（startup 对话框按钮可用）
    for (let i = 0; i < 60; i++) {
        await sleep(100);
        const ok = await evalJS(cdp, `!!document.getElementById('startupBtnTemp') && !!document.querySelector('.canvas')`);
        if (ok) break;
    }

    // 进入临时模式（等布局稳定后用真实鼠标点击 startup 按钮）+ 添加节点 + 添加操作组
    await sleep(800);   // 等 startup dialog 布局完成（headless 下过早点击会拿到 0×0 rect）
    const tempPos = await evalJS(cdp, `(() => {
        const b = document.getElementById('startupBtnTemp');
        if (!b || b.disabled) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`);
    if (tempPos) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tempPos.x, y: tempPos.y, button: 'none', buttons: 0 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tempPos.x, y: tempPos.y, button: 'left', buttons: 1, clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tempPos.x, y: tempPos.y, button: 'left', buttons: 0, clickCount: 1 });
    } else {
        console.error('# temp button not ready');
        process.exit(1);
    }
    await sleep(400);
    const addNode = await evalJS(cdp, `(() => {
        const b = document.getElementById('btnAddNode');
        if (!b || b.disabled) return 'disabled';
        b.click();
        return 'ok';
    })()`);
    console.error(`# add node: ${addNode}`);
    await sleep(400);
    const addGroup = await evalJS(cdp, `(() => {
        const b = document.getElementById('btnAddGroup');
        if (!b || b.disabled) return 'disabled';
        b.click();
        return 'ok';
    })()`);
    console.error(`# add group: ${addGroup}`);
    await sleep(400);

    // 注入事件记录器
    await evalJS(cdp, `
        window.__ptrLog = [];
        const rec = (ev) => {
            const t = ev.target;
            window.__ptrLog.push({
                type: ev.type, button: ev.button, buttons: ev.buttons,
                clientX: Math.round(ev.clientX), clientY: Math.round(ev.clientY),
                target: t ? (t.className && t.className.split ? t.className.split(/\\s+/).slice(0,3).join('.') : t.tagName) : null,
                inNode: !!(t && t.closest && t.closest('.node')),
                inPort: !!(t && t.closest && t.closest('.port')),
            });
        };
        for (const ty of ['pointerdown','pointermove','pointerup','pointercancel']) {
            document.addEventListener(ty, rec, true);
        }
    `);

    // 找一个可命中的出口端口
    const setup = await evalJS(cdp, `(() => {
        const ports = [...document.querySelectorAll('.port[data-dir="out"]')];
        for (const p of ports) {
            const r = p.getBoundingClientRect();
            const cx = Math.round(r.x + r.width/2), cy = Math.round(r.y + r.height/2);
            const hit = document.elementFromPoint(cx, cy);
            if (hit && hit.closest && hit.closest('.port') === p) {
                return { cx, cy, transform: document.getElementById('world').style.transform, portCount: ports.length };
            }
        }
        return {
            error: 'no hittable out port',
            detail: ports.slice(0, 6).map(p => {
                const r = p.getBoundingClientRect();
                const cx = Math.round(r.x + r.width/2), cy = Math.round(r.y + r.height/2);
                const hit = document.elementFromPoint(cx, cy);
                return { cx, cy, hitTag: hit ? hit.tagName : null, hitCls: hit ? (hit.className || '').toString().slice(0, 30) : null };
            }),
        };
    })()`);
    if (setup.error) {
        console.error(setup.error, JSON.stringify(setup.detail, null, 2));
        process.exit(1);
    }
    const { cx, cy } = setup;
    console.error(`# port at (${cx}, ${cy}) (${setup.portCount} out ports); initial world: ${setup.transform}`);

    const mouse = (type, x, y, button, buttons, clickCount = 1) =>
        cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount });

    // 1) 左键按下出口端口 → 开始拖线
    await mouse('mousePressed', cx, cy, 'left', 1);
    await sleep(60);
    // 2) 移动鼠标（左键仍按住）
    await mouse('mouseMoved', cx + 260, cy + 120, 'none', 1);
    await sleep(60);
    // 3) 中键按下（左键仍按住）→ 应启动平移（chrome 只派发 pointermove，buttons=1+4=5）
    await mouse('mousePressed', cx + 260, cy + 120, 'middle', 5);
    await sleep(60);
    // 4) 中键按住拖动 → 平移应改变 panX/panY
    await mouse('mouseMoved', cx + 120, cy + 180, 'none', 5);
    await sleep(120);
    const midTransform = await evalJS(cdp, `document.getElementById('world').style.transform`);
    console.error(`# transform after middle-drag: ${midTransform}`);
    // 5) 中键松开（左键仍按住）
    await mouse('mouseReleased', cx + 120, cy + 180, 'middle', 1);
    await sleep(60);
    // 6) 左键松开 → 完成/取消连线
    await mouse('mouseReleased', cx + 120, cy + 180, 'left', 0);
    await sleep(100);

    const result = await evalJS(cdp, `(() => ({
        log: window.__ptrLog,
        finalTransform: document.getElementById('world').style.transform,
        previewContent: (document.getElementById('previewSVG').innerHTML || '').slice(0, 120),
    }))()`);

    console.log('=== pointer event log ===');
    for (const ev of result.log) {
        console.log(`  ${ev.type.padEnd(11)} button=${ev.button} buttons=${ev.buttons} at (${ev.clientX},${ev.clientY}) target=${ev.target} node=${ev.inNode} port=${ev.inPort}`);
    }
    console.log('=== transforms ===');
    console.log(`  initial: ${setup.transform}`);
    console.log(`  mid:     ${midTransform}`);
    console.log(`  final:   ${result.finalTransform}`);
    console.log(`  previewSVG: ${JSON.stringify(result.previewContent)}`);

    const panMoved = midTransform !== setup.transform;
    console.log(`\n=== 判定 ===`);
    console.log(`  中键拖动后 transform 是否改变（平移生效）: ${panMoved ? '是 ✅' : '否 ❌'}`);

    cdp.close();
    process.exit(panMoved ? 0 : 3);
}

main().catch(e => { console.error('fatal:', e.message ?? e); process.exit(1); });
