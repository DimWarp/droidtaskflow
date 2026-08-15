#!/usr/bin/env node
// scripts/dev-tools/repro-match-ctx.mjs — reproduce "图像匹配框右键没有菜单".
// Real browser (CDP). Loads a synthetic screenshot into the REAL app module,
// then builds the match overlay EXACTLY like _drawMatchBoxes does, hovers a box
// and sends a REAL right-click. Reports highlight/tooltip/menu state.
//
// Usage: node scripts/dev-tools/repro-match-ctx.mjs [--port 9223] [--url http://localhost:5173]

import process from 'node:process';

function parseArgs(argv) {
    const out = { port: 9223, url: 'http://localhost:5173' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
        else out[key] = true;
    }
    return out;
}
const args = parseArgs(process.argv.slice(2));

class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this._id = 0;
        this._pending = new Map();
        this.events = [];
        this._consoleErrors = [];
        this._exceptions = [];
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
            return;
        }
        this.events.push(m);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this._consoleErrors.push(m.params);
        else if (m.method === 'Runtime.exceptionThrown') this._exceptions.push(m.params.exceptionDetails);
    }
    send(method, params = {}) {
        const id = ++this._id;
        return new Promise((res, rej) => {
            this._pending.set(id, { res, rej });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    close() { try { this.ws.close(); } catch {} }
}
async function findTab(port) {
    const tabs = await (await fetch(`http://localhost:${port}/json`)).json();
    const pages = tabs.filter(t => t.type === 'page');
    if (pages.length) return pages[0];
    throw new Error('no page tab');
}
async function evalJS(cdp, expr) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text}: ${r.exceptionDetails.exception?.description ?? ''}`);
    return r.result.value;
}
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    const tab = await findTab(args.port);
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.open;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    await cdp.send('Page.navigate', { url: `${args.url}?repro=${Date.now() % 100000}` });
    await delay(2500);
    await evalJS(cdp, `(() => { const t = document.getElementById('startupBtnTemp'); if (t) t.click(); return !!t; })()`);
    await delay(300);

    const report = await evalJS(cdp, `(async () => {
        const delay = (ms) => new Promise(r => setTimeout(r, ms));
        const out = { errors: [] };
        window.addEventListener('error', e => out.errors.push('window: ' + e.message));
        try {
            const dp = await import('/src/js/device-preview.js');

            // fake client (needed by loadFromFile→renderStage flows that touch client state)
            const client = {
                state: 'connected',
                _ws: { readyState: 1, addEventListener(){}, removeEventListener(){}, send(){}, close(){} },
                setDeviceScreenshotHandler(){}, setDeviceScreenshotErrorHandler(){}, on(){},
            };
            dp.registerClient(client);

            // synthetic screenshot
            const c = document.createElement('canvas');
            c.width = 1000; c.height = 2000;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0,0,1000,2000);
            ctx.fillStyle = '#3366cc'; ctx.fillRect(0,0,200,200);
            const blob = await new Promise(r => c.toBlob(r, 'image/png'));
            await dp.loadFromFile(new File([blob], 'shot.png', { type: 'image/png' }));
            await delay(250);
            dp.unfoldDevicePreview();
            await delay(100);

            const stage = document.getElementById('devicePreviewStage');
            const canvas = stage.querySelector('canvas');
            out.canvas = { w: canvas.width, h: canvas.height, hasBoxesData: !!canvas._matchBoxes };

            // Build match overlay EXACTLY as _drawMatchBoxes does (native coords [[10,10],[200,200]]).
            const cr = canvas.getBoundingClientRect();
            const sr = stage.getBoundingClientRect();
            const offsetX = cr.left - sr.left, offsetY = cr.top - sr.top;
            const scaleX = cr.width / canvas.width, scaleY = cr.height / canvas.height;
            const overlay = document.createElement('div');
            overlay.className = 'match-boxes-overlay';
            const box = document.createElement('div');
            box.className = 'match-box';
            box.style.left = (offsetX + 10 * scaleX) + 'px';
            box.style.top = (offsetY + 10 * scaleY) + 'px';
            box.style.width = (190 * scaleX) + 'px';
            box.style.height = (190 * scaleY) + 'px';
            overlay.appendChild(box);
            const tooltip = document.createElement('div');
            tooltip.className = 'match-box__tooltip';
            overlay.appendChild(tooltip);
            stage.appendChild(overlay);
            canvas._matchBoxes = [{ minX: 10, maxX: 200, minY: 10, maxY: 200, score: 0.7598 }];
            canvas._matchTooltip = tooltip;
            canvas._matchOverlay = overlay;
            out.overlayBuilt = !!stage.querySelector('.match-boxes-overlay');

            // Hover the box center.
            const hx = cr.left + 100 * scaleX, hy = cr.top + 100 * scaleY;
            canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: hx, clientY: hy, bubbles: true }));
            await delay(50);
            out.hover = {
                active: !!stage.querySelector('.match-box--active'),
                tooltipText: tooltip.textContent,
                tooltipVisible: tooltip.classList.contains('match-box__tooltip--visible'),
            };

            // Log every event the canvas receives during the real right-click.
            const evtLog = [];
            for (const t of ['mousemove', 'mousedown', 'mouseup', 'contextmenu', 'click', 'mouseleave']) {
                canvas.addEventListener(t, (e) => evtLog.push({
                    t, btn: e.button, x: Math.round(e.clientX), y: Math.round(e.clientY),
                    target: (e.target && (e.target.className || e.target.tagName)) || '',
                }), true);
            }
            window.addEventListener('contextmenu', (e) => {
                evtLog.push({ t: 'window-contextmenu', target: (e.target && (e.target.className || e.target.tagName)) || '', preventDefault: e.defaultPrevented });
            }, true);
            out.evtLogPre = evtLog.slice();

            // Synthetic contextmenu first (isolates handler logic from browser sequencing).
            const syn = new MouseEvent('contextmenu', { clientX: hx, clientY: hy, bubbles: true, cancelable: true });
            canvas.dispatchEvent(syn);
            await delay(50);
            const synMenus = [...document.querySelectorAll('.ocr-ctx-menu')].map(m => ({
                hidden: m.hidden, items: [...m.querySelectorAll('.ocr-ctx-menu__item')].map(i => i.dataset.act),
            }));
            out.syntheticContextmenu = {
                defaultPrevented: syn.defaultPrevented,
                menus: synMenus,
                anyVisible: synMenus.some(m => !m.hidden),
            };
            // Reset: hide any menu + re-highlight via a fresh mousemove.
            for (const m of document.querySelectorAll('.ocr-ctx-menu')) m.hidden = true;
            canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: hx, clientY: hy, bubbles: true }));
            await delay(30);

            out.click = { x: Math.round(hx), y: Math.round(hy) };
            out.evtLogProbe = evtLog;
            out.canvasBefore = {
                hasBoxesData: !!canvas._matchBoxes,
                boxCount: (canvas._matchBoxes || []).length,
            };
            // Capture clipboard writes so we can see if copyToClipboard ran.
            window.__clip = [];
            if (navigator.clipboard) {
                navigator.clipboard.writeText = (t) => { window.__clip.push(t); return Promise.resolve(); };
            }
            window.__toasts = [];
            const origToast = (window.__origToast = window.__origToast || null);
            window.__toastCount = 0;

            window.__evtLog = evtLog;
            return out;
        } catch (e) {
            out.errors.push('scenario: ' + e.message);
            return out;
        }
    })()`);

    // REAL right-click via CDP Input.
    const cx = report.click.x, cy = report.click.y;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'right', buttons: 2, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'right', buttons: 0, clickCount: 1 });
    await delay(150);

    const after = await evalJS(cdp, `(() => {
        const stage = document.getElementById('devicePreviewStage');
        const menus = [...document.querySelectorAll('.ocr-ctx-menu')].map(m => ({
            hidden: m.hidden, left: m.style.left, top: m.style.top,
            items: [...m.querySelectorAll('.ocr-ctx-menu__item')].map(i => i.dataset.act),
        }));
        return { menus, anyVisible: menus.some(m => !m.hidden),
                 stillActive: !!(stage && stage.querySelector('.match-box--active')) };
    })()`);
    const evtLogAfter = await evalJS(cdp, `(() => window.__evtLog || null)()`);

    // Click the menu item ("复制中心坐标") via CDP Input.
    const itemRect = await evalJS(cdp, `(() => {
        const m = [...document.querySelectorAll('.ocr-ctx-menu')].find(x => !x.hidden);
        if (!m) return null;
        const item = m.querySelector('[data-act="coord"]');
        if (!item) return null;
        const r = item.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);

    let itemClick = null;
    if (itemRect) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: itemRect.x, y: itemRect.y });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: itemRect.x, y: itemRect.y, button: 'left', buttons: 1, clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: itemRect.x, y: itemRect.y, button: 'left', buttons: 0, clickCount: 1 });
        await delay(200);
        itemClick = await evalJS(cdp, `(() => ({
            clip: window.__clip || [],
            menuStillThere: [...document.querySelectorAll('.ocr-ctx-menu')].filter(m => !m.hidden).length,
            anyMenuVisible: [...document.querySelectorAll('.ocr-ctx-menu')].some(m => !m.hidden),
        }))()`);
    }

    const result = {
        report,
        consoleErrors: cdp._consoleErrors.slice(-10).map(e => (e.args || []).map(a => a.value ?? a.description).join(' ')),
        exceptions: cdp._exceptions.slice(-5).map(e => e.exception?.description ?? e.text),
        afterRealRightClick: after,
        evtLogAfter: evtLogAfter,
        menuItemRect: itemRect,
        itemClick,
    };
    console.log(JSON.stringify(result, null, 2));
    cdp.close();
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
