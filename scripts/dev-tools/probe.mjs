#!/usr/bin/env node
// scripts/dev-tools/probe.mjs — CDP probe for debugging DroidTaskFlow UI.
//
// Connects to a running Chrome with --remote-debugging-port=<PORT> (default 9223),
// then lets you query DOM state. Uses native WebSocket / fetch — no external deps.
//
// Usage:
//   node scripts/dev-tools/probe.mjs                                     # list current tab + show errors
//   node scripts/dev-tools/probe.mjs --url http://localhost:5173         # navigate first
//   node scripts/dev-tools/probe.mjs --match 5173 --rect '#consolePane'
//   node scripts/dev-tools/probe.mjs --parents '.console-pane'
//   node scripts/dev-tools/probe.mjs --style '#consolePane'
//   node scripts/dev-tools/probe.mjs --eval 'document.title'
//   node scripts/dev-tools/probe.mjs --errors                            # dump captured pageerror / console.error
//   node scripts/dev-tools/probe.mjs --port 9224
//
// Exit codes:
//   0 = ok, 1 = eval/runtime error, 2 = chrome unreachable, 3 = bad usage

import process from 'node:process';

// ─── arg parsing ────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') { out.help = true; continue; }
        if (!a.startsWith('--')) throw new Error(`Unexpected positional arg: ${a}`);
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            out[key] = true;
        } else {
            out[key] = next;
            i++;
        }
    }
    return out;
}

const HELP = `probe.mjs — CDP probe for DroidTaskFlow UI debugging

Required: Chrome running with --remote-debugging-port=<PORT> (default 9223).

Options:
  --url <URL>        Navigate the current page to this URL before probing.
  --match <substring> Pick the tab whose URL contains this substring.
  --port <PORT>      Chrome debug port (default 9223).
  --rect <selector>  Print getBoundingClientRect + computed style for the element.
  --parents <selector>  Print the parent chain up to <html> for the element.
  --style <selector>  Print computed layout properties (display/visibility/overflow/...).
  --eval <JS>        Evaluate JS in the page; prints JSON-encoded result.
  --errors           Print all captured console.error + Runtime.exceptionThrown events.

At least one of --rect/--parents/--style/--eval/--errors is required (or pass --help).

Examples:
  node scripts/dev-tools/probe.mjs --rect '#consolePane'
  node scripts/dev-tools/probe.mjs --parents '.console-pane' --errors
  node scripts/dev-tools/probe.mjs --eval 'document.querySelector("#consolePane")?.className'
`;

const args = parseArgs(process.argv.slice(2));
if (args.help || process.argv.length === 2) { console.log(HELP); process.exit(0); }

// ─── CDP client ─────────────────────────────────────────────────────────────
class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this._id = 0;
        this._pending = new Map();
        this.events = [];                         // buffered non-response events
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
        // Event
        this.events.push(m);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            this._consoleErrors.push(m.params);
        } else if (m.method === 'Runtime.exceptionThrown') {
            this._exceptions.push(m.params.exceptionDetails);
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
    if (!r.ok) throw new Error(`/json returned ${r.status}`);
    const tabs = await r.json();
    const pages = tabs.filter(t => t.type === 'page');
    if (match) {
        const hit = pages.find(t => t.url.includes(match));
        if (hit) return hit;
    }
    if (pages.length) return pages[0];
    throw new Error(`no page tab found. Available: ${tabs.map(t => `${t.type}:${t.url}`).join(', ')}`);
}

async function evalJS(cdp, expr) {
    const r = await cdp.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
    });
    if (r.exceptionDetails) {
        const ed = r.exceptionDetails;
        throw new Error(`${ed.text}: ${ed.exception?.description ?? ''}`);
    }
    return r.result.value;
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
    const port = args.port ?? 9223;
    const match = args.match;
    const targetURL = args.url;

    let tab;
    try { tab = await findTab(port, match); }
    catch (e) {
        console.error(`Cannot reach Chrome on port ${port}: ${e.message}`);
        console.error(`Start Chrome with: google-chrome-stable --headless --remote-debugging-port=${port} --no-sandbox`);
        process.exit(2);
    }
    console.error(`# Tab: ${tab.title || '(no title)'} @ ${tab.url}`);

    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.open;

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    if (targetURL && !tab.url.startsWith(targetURL.split('?')[0])) {
        console.error(`# Navigating to ${targetURL}`);
        const navP = new Promise(res => {
            const i = setInterval(() => {
                if (cdp.events.some(e => e.method === 'Page.loadEventFired')) { clearInterval(i); res(); }
            }, 50);
            setTimeout(() => { clearInterval(i); res(); }, 10000);
        });
        await cdp.send('Page.navigate', { url: targetURL });
        await navP;
        // small grace period for late scripts
        await new Promise(r => setTimeout(r, 200));
    }

    const out = {};
    try {
        if (args.rect) {
            out.rect = await evalJS(cdp, `(() => {
                const el = document.querySelector(${JSON.stringify(args.rect)});
                if (!el) return { error: 'not found' };
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return {
                    x: r.x, y: r.y, width: r.width, height: r.height,
                    right: r.right, bottom: r.bottom,
                    viewport: { w: window.innerWidth, h: window.innerHeight },
                    inViewport: r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth,
                    display: cs.display,
                    visibility: cs.visibility,
                    opacity: cs.opacity,
                    transform: cs.transform,
                    overflow: cs.overflow,
                    classList: [...el.classList],
                    parentTag: el.parentElement?.tagName ?? null,
                    parentClass: el.parentElement?.className ?? null,
                };
            })()`);
        }

        if (args.parents) {
            out.parents = await evalJS(cdp, `(() => {
                let el = document.querySelector(${JSON.stringify(args.parents)});
                if (!el) return null;
                const chain = [];
                while (el) {
                    const cls = (typeof el.className === 'string' ? el.className.trim() : '');
                    chain.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls.split(/\\s+/).join('.') : ''));
                    el = el.parentElement;
                }
                return chain;
            })()`);
        }

        if (args.style) {
            out.style = await evalJS(cdp, `(() => {
                const el = document.querySelector(${JSON.stringify(args.style)});
                if (!el) return null;
                const cs = getComputedStyle(el);
                const props = ['display', 'visibility', 'opacity', 'position', 'top', 'left', 'right', 'bottom',
                    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
                    'overflow', 'overflow-x', 'overflow-y', 'transform', 'z-index', 'pointer-events'];
                const o = {};
                for (const p of props) o[p] = cs.getPropertyValue(p);
                return o;
            })()`);
        }

        if (args.eval !== undefined) {
            out.eval = await evalJS(cdp, args.eval);
        }

        if (args.errors) {
            out.consoleErrors = cdp._consoleErrors.map(c => ({
                type: c.type,
                text: c.args.map(a => a.value ?? a.description ?? '').join(' '),
            }));
            out.exceptions = cdp._exceptions.map(e => ({
                text: e.text,
                url: e.url,
                line: e.lineNumber,
                col: e.columnNumber,
                description: e.exception?.description ?? null,
            }));
        }
    } catch (e) {
        console.error('eval error:', e.message);
        process.exit(1);
    }

    if (Object.keys(out).length === 0) {
        console.error('# No probe flag given — pass --rect / --parents / --style / --eval / --errors');
    }
    console.log(JSON.stringify(out, null, 2));
    cdp.close();
}

main().catch(e => { console.error('fatal:', e.message ?? e); process.exit(1); });