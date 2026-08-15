#!/usr/bin/env node
// scripts/dev-tools/health-check.mjs — one-shot smoke test for the dev environment.
//
// Verifies, in order:
//   1. Backend /health responds 200 + {ok:true}
//   2. Backend /info responds 200
//   3. Vite dev server (or specified URL) responds 200
//   4. Chrome tab on the URL loads without pageerror / console.error
//   5. #consolePane (if it exists) rect is inside viewport
//
// Reports each check; exits non-zero if any check failed.
//
// Usage:
//   node scripts/dev-tools/health-check.mjs
//   node scripts/dev-tools/health-check.mjs --url http://localhost:5173 --backend-port 8765
//   node scripts/dev-tools/health-check.mjs --no-chrome       # skip browser-side checks
//
// Exit codes:
//   0 = all checks passed
//   1 = one or more checks failed
//   2 = Chrome unreachable (only matters when browser checks enabled)

import process from 'node:process';

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

const HELP = `health-check.mjs — smoke test for the dev environment.

Checks (in order):
  1. Backend GET /health → 200 + ok:true
  2. Backend GET /info    → 200
  3. Frontend URL          → 200
  4. Chrome page           → no pageerror, no console.error during a brief window
  5. #consolePane          → if present, rect inside viewport

Options:
  --url <URL>           Frontend URL (default http://localhost:5173).
  --backend-host <H>    Backend host (default localhost).
  --backend-port <P>    Backend port (default 8765).
  --chrome-port <P>     Chrome --remote-debugging-port (default 9223).
  --no-chrome           Skip browser-side checks (only HTTP checks).
  --quiet               Only print summary.
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }

const cfg = {
    frontend: args.url ?? 'http://localhost:5173',
    backendHost: args['backend-host'] ?? 'localhost',
    backendPort: args['backend-port'] ?? 8765,
    chromePort: args['chrome-port'] ?? 9223,
    noChrome: !!args['no-chrome'],
    quiet: !!args.quiet,
};

const checks = [];
function add(name, status, detail) {
    checks.push({ name, status, detail });
    if (!cfg.quiet) {
        const icon = status === 'ok' ? '✓' : status === 'skip' ? '~' : '✗';
        const color = status === 'ok' ? '\x1b[32m' : status === 'skip' ? '\x1b[33m' : '\x1b[31m';
        console.log(`${color}${icon}\x1b[0m ${name}${detail ? '  — ' + detail : ''}`);
    }
}

// ─── HTTP checks ────────────────────────────────────────────────────────────
async function checkBackend() {
    const base = `http://${cfg.backendHost}:${cfg.backendPort}`;
    try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.status !== 200) { add('Backend /health', 'fail', `HTTP ${r.status}`); return false; }
        const j = await r.json();
        if (!j.ok) { add('Backend /health', 'fail', `ok=false, body=${JSON.stringify(j)}`); return false; }
        add('Backend /health', 'ok', `version=${j.version} uptime=${j.uptime_seconds?.toFixed?.(2)}s`);
    } catch (e) {
        add('Backend /health', 'fail', `${cfg.backendHost}:${cfg.backendPort} unreachable (${e.message})`);
        return false;
    }
    try {
        const r = await fetch(`${base}/info`, { signal: AbortSignal.timeout(2000) });
        if (r.status !== 200) { add('Backend /info', 'fail', `HTTP ${r.status}`); return false; }
        const j = await r.json();
        add('Backend /info', 'ok', `py=${j.py_version} adb=${j.adb} workspace=${j.workspace}`);
    } catch (e) {
        add('Backend /info', 'fail', e.message);
        return false;
    }
    return true;
}

async function checkFrontend() {
    try {
        const r = await fetch(cfg.frontend, { signal: AbortSignal.timeout(3000) });
        if (r.status !== 200) { add('Frontend HTTP', 'fail', `HTTP ${r.status}`); return false; }
        const ct = r.headers.get('content-type') ?? '';
        if (!ct.includes('text/html') && !ct.includes('application/octet-stream')) {
            add('Frontend HTTP', 'fail', `unexpected content-type: ${ct}`);
            return false;
        }
        add('Frontend HTTP', 'ok', `${cfg.frontend} → 200`);
        return true;
    } catch (e) {
        add('Frontend HTTP', 'fail', `${cfg.frontend} unreachable (${e.message})`);
        return false;
    }
}

// ─── CDP checks ─────────────────────────────────────────────────────────────
class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this._id = 0;
        this._pending = new Map();
        this.consoleErrors = [];
        this.exceptions = [];
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
        } else {
            if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
                this.consoleErrors.push(m.params);
            } else if (m.method === 'Runtime.exceptionThrown') {
                this.exceptions.push(m.params.exceptionDetails);
            }
        }
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
    throw new Error('no page tab');
}

async function evalJS(cdp, expr) {
    const r = await cdp.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
        throw new Error(`${r.exceptionDetails.text}: ${r.exceptionDetails.exception?.description ?? ''}`);
    }
    return r.result.value;
}

async function checkBrowser() {
    let tab;
    try { tab = await findTab(cfg.chromePort, new URL(cfg.frontend).host); }
    catch (e) {
        add('Chrome tab', 'fail', `no tab for ${cfg.frontend} on port ${cfg.chromePort} (${e.message})`);
        return false;
    }
    console.error(`# Using tab: ${tab.title || '(no title)'} @ ${tab.url}`);

    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.open;

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    if (!tab.url.startsWith(cfg.frontend.split('?')[0])) {
        console.error(`# Navigating to ${cfg.frontend}`);
        const navP = new Promise(res => {
            const i = setInterval(() => {
                if (cdp.consoleErrors.length || cdp.exceptions.length) { /* keep listening */ }
            }, 50);
            // resolve on load
            const check = () => {
                const last = cdp.consoleErrors.length + cdp.exceptions.length;
                setTimeout(() => {
                    if (cdp.consoleErrors.length + cdp.exceptions.length === last) {
                        clearInterval(i); res();
                    }
                }, 1500);
            };
            check();
        });
        await cdp.send('Page.navigate', { url: cfg.frontend });
        await navP;
        await new Promise(r => setTimeout(r, 300));
    } else {
        // Already there; give the page a moment
        await new Promise(r => setTimeout(r, 1500));
    }

    let ok = true;
    if (cdp.exceptions.length) {
        ok = false;
        add('Page exceptions', 'fail',
            `${cdp.exceptions.length} uncaught: ` + cdp.exceptions.slice(0, 3)
                .map(e => e.exception?.description ?? e.text)
                .join(' | '));
    } else {
        add('Page exceptions', 'ok', 'none');
    }
    if (cdp.consoleErrors.length) {
        ok = false;
        add('console.error', 'fail',
            `${cdp.consoleErrors.length}: ` + cdp.consoleErrors.slice(0, 3)
                .map(c => c.args.map(a => a.value ?? a.description ?? '').join(' '))
                .join(' | '));
    } else {
        add('console.error', 'ok', 'none');
    }

    // Console pane layout check
    try {
        const rect = await evalJS(cdp, `(() => {
            const el = document.getElementById('consolePane');
            if (!el) return { present: false };
            const r = el.getBoundingClientRect();
            return {
                present: true,
                x: r.x, y: r.y, width: r.width, height: r.height,
                viewport: { w: window.innerWidth, h: window.innerHeight },
                inViewport: r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth,
                parentClass: el.parentElement?.className ?? null,
                display: getComputedStyle(el).display,
            };
        })()`);
        if (!rect.present) {
            add('#consolePane', 'skip', 'not present on page (may be intentional)');
        } else if (!rect.inViewport) {
            ok = false;
            add('#consolePane', 'fail',
                `rect (y=${rect.y}, bottom=${rect.y + rect.height}) outside viewport (h=${rect.viewport.h}); parent=${rect.parentClass}`);
        } else {
            add('#consolePane', 'ok', `y=${rect.y}, h=${rect.height}, parent=${rect.parentClass}`);
        }
    } catch (e) {
        add('#consolePane', 'fail', `eval error: ${e.message}`);
        ok = false;
    }

    cdp.close();
    return ok;
}

// ─── run ────────────────────────────────────────────────────────────────────
async function main() {
    const backendOK = await checkBackend();
    const frontendOK = await checkFrontend();
    let browserOK = true;
    if (!cfg.noChrome) {
        try { browserOK = await checkBrowser(); }
        catch (e) {
            if (e.message?.includes('ws error') || e.message?.includes('unreachable')) {
                console.error(`fatal: ${e.message}`);
                process.exit(2);
            }
            throw e;
        }
    } else {
        add('Browser checks', 'skip', '--no-chrome');
    }

    const failures = checks.filter(c => c.status === 'fail').length;
    console.error('');
    if (failures === 0) {
        console.error(`✓ all checks passed (${checks.length})`);
        process.exit(0);
    } else {
        console.error(`✗ ${failures} check(s) failed`);
        process.exit(1);
    }
}

main().catch(e => { console.error('fatal:', e.message ?? e); process.exit(1); });