#!/usr/bin/env node
// scripts/dev-tools/shot.mjs — Capture a screenshot of a Chrome tab via CDP.
//
// Connects to a running Chrome with --remote-debugging-port (default 9223),
// navigates to the URL if needed, then captures a PNG.
//
// Usage:
//   node scripts/dev-tools/shot.mjs                                       # snapshot of current tab
//   node scripts/dev-tools/shot.mjs --url http://localhost:5173           # navigate + shot
//   node scripts/dev-tools/shot.mjs --match 5173 --out my.png             # pick tab by URL substring
//   node scripts/dev-tools/shot.mjs --viewport 1280x720 --url :5173       # resize before shot
//   node scripts/dev-tools/shot.mjs --full-page                           # full page (not just viewport)
//   node scripts/dev-tools/shot.mjs --clip 0,0,800,600                    # clip x,y,w,h
//
// Default --out: tmp-shots/<ISO-timestamp>.png
// Exit: 0 ok, 2 chrome unreachable, 1 other error.

import process from 'node:process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) throw new Error(`Unexpected positional arg: ${a}`);
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) { out[key] = true; }
        else { out[key] = next; i++; }
    }
    return out;
}

const HELP = `shot.mjs — capture screenshot via CDP

Options:
  --url <URL>         Navigate first (only if current tab URL doesn't start with URL's path).
  --match <substring> Pick tab by URL substring match.
  --port <PORT>       Chrome debug port (default 9223).
  --out <path>        Output file path (default: tmp-shots/<ISO-timestamp>.png).
  --viewport WxH      Set viewport size before shot (e.g. 1280x720).
  --full-page         Capture the entire page, not just the viewport.
  --clip x,y,w,h      Capture a clipped region.
  --scale <factor>    Set page scale factor (Emulation.setPageScaleFactor) before shot.
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }

class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this._id = 0;
        this._pending = new Map();
        this.events = [];
        this.ws.addEventListener('message', (e) => this._onMessage(e));
        this.open = new Promise((res, rej) => {
            this.ws.addEventListener('open', () => res(), { once: true });
            this.ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
        });
    }
    _onMessage(e) {
        const m = JSON.parse(e.data);
        if (m.id != null) {
            const p = this._pending.get(m.id);
            if (!p) return;
            this._pending.delete(m.id);
            m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
        } else { this.events.push(m); }
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

async function findTab(port, match) {
    const r = await fetch(`http://localhost:${port}/json`);
    const tabs = await r.json();
    const pages = tabs.filter(t => t.type === 'page');
    if (match) {
        const hit = pages.find(t => t.url.includes(match));
        if (hit) return hit;
    }
    if (pages.length) return pages[0];
    throw new Error(`no page tab. Available: ${tabs.map(t => `${t.type}:${t.url}`).join(', ')}`);
}

function defaultOutPath() {
    const d = new Date();
    const ts = d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    return join('tmp-shots', `${ts}.png`);
}

async function main() {
    const port = args.port ?? 9223;
    const match = args.match;
    let tab;
    try { tab = await findTab(port, match); }
    catch (e) {
        console.error(`Cannot reach Chrome on port ${port}: ${e.message}`);
        process.exit(2);
    }
    console.error(`# Tab: ${tab.title || '(no title)'} @ ${tab.url}`);

    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.open;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    if (args.viewport) {
        const [w, h] = args.viewport.split('x').map(Number);
        if (!w || !h) throw new Error(`bad --viewport: ${args.viewport}`);
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: w, height: h,
            deviceScaleFactor: 1, mobile: false,
        });
        console.error(`# Viewport set to ${w}x${h}`);
    }

    if (args.scale) {
        const s = Number(args.scale);
        if (!Number.isFinite(s) || s <= 0) throw new Error(`bad --scale: ${args.scale}`);
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: s });
        console.error(`# Page scale set to ${s}`);
        await new Promise(r => setTimeout(r, 120));
    }

    if (args.url && !tab.url.startsWith(args.url.split('?')[0])) {
        console.error(`# Navigating to ${args.url}`);
        const navP = new Promise(res => {
            const i = setInterval(() => {
                if (cdp.events.some(e => e.method === 'Page.loadEventFired')) { clearInterval(i); res(); }
            }, 50);
            setTimeout(() => { clearInterval(i); res(); }, 10000);
        });
        await cdp.send('Page.navigate', { url: args.url });
        await navP;
        await new Promise(r => setTimeout(r, 250));
    }

    const shotParams = { format: 'png' };
    if (args['full-page']) shotParams.captureBeyondViewport = true;
    if (args.clip) {
        const [x, y, w, h] = args.clip.split(',').map(Number);
        if ([x, y, w, h].some(n => Number.isNaN(n))) throw new Error(`bad --clip: ${args.clip}`);
        shotParams.clip = { x, y, width: w, height: h, scale: 1 };
    }

    const result = await cdp.send('Page.captureScreenshot', shotParams);
    const outPath = args.out ?? defaultOutPath();
    mkdirSync(outPath.split('/').slice(0, -1).join('/') || '.', { recursive: true });
    writeFileSync(outPath, Buffer.from(result.data, 'base64'));
    console.error(`# Saved ${outPath}`);

    cdp.close();
}

main().catch(e => { console.error('fatal:', e.message ?? e); process.exit(1); });