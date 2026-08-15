# scripts/dev-tools

CDP-based debugging helpers for the DroidTaskFlow frontend. Use these instead
of writing ad-hoc `/tmp/probe.mjs` scripts every time you need to inspect the
live page state.

## Why these exist

Recent debugging sessions lost multiple rounds each to the same pattern:
investigate the wrong layer (CSS / data flow / listeners) before checking the
actual evidence (DOM rect, parent chain, console errors). These scripts make
the evidence step cheap and one-shot:

| Bug actually was | What I should have done first |
|---|---|
| Console pane `height: 0` (collapsed) | `npm run dev:probe -- --rect '#consolePane'` |
| `#consolePane` was a sibling of `.app-shell`, not a child | `npm run dev:probe -- --parents '#consolePane'` |
| `main.js` had a SyntaxError, whole module failed to load | `npm run dev:probe -- --errors` |

The shared rules are recorded in the project memory file
`feedback-debug-first-evidence.md`.

## Prerequisites

- **Chrome running with `--remote-debugging-port`** (default 9223).
  The current session uses `google-chrome-stable --headless --remote-debugging-port=9223 --no-sandbox`.
  Any Chrome with that flag works; a headed Chrome is fine too.
- **Node 22+** (the scripts use the built-in `globalThis.WebSocket` / `fetch`,
  no `npm install` needed).
- For the smoke-test: **backend running on `localhost:8765`** and **Vite dev
  on `localhost:5173`** (or pass `--url` / `--backend-port` to override).

## Tools

### `npm run dev:probe` — `probe.mjs`

CDP probe. Connect to a Chrome tab, optionally navigate, then inspect.

```bash
# Current tab + show captured console errors / page exceptions
node scripts/dev-tools/probe.mjs

# Get bounding rect + computed style of a selector
node scripts/dev-tools/probe.mjs --rect '#consolePane'

# Parent chain up to <html>
node scripts/dev-tools/probe.mjs --parents '.console-pane'

# Specific layout properties
node scripts/dev-tools/probe.mjs --style '#consolePane'

# Free-form eval (returns JSON-encoded result)
node scripts/dev-tools/probe.mjs --eval 'document.querySelector("#consolePane")?.className'

# Navigate first if needed
node scripts/dev-tools/probe.mjs --url http://localhost:5173 --rect '#consolePane'

# Different Chrome port or pick by URL substring
node scripts/dev-tools/probe.mjs --port 9224 --match 5173 --errors
```

Output is JSON — pipe to `jq` for readability:
```bash
npm run dev:probe -- --rect '#consolePane' | jq .rect
```

### `npm run dev:shot` — `shot.mjs`

CDP screenshot. Saves to `tmp-shots/<ISO-timestamp>.png` by default.

```bash
node scripts/dev-tools/shot.mjs --url http://localhost:5173
node scripts/dev-tools/shot.mjs --url http://localhost:5173 --viewport 1280x720 --out before.png
node scripts/dev-tools/shot.mjs --full-page --out whole.png
node scripts/dev-tools/shot.mjs --clip 0,500,1280,220 --out console-only.png
```

`tmp-shots/` is **gitignored**. Add it to `.gitignore` if it's not there.

### `npm run check` — `health-check.mjs`

One-shot smoke test. Runs all of:
1. Backend `GET /health` → 200 + `ok:true`
2. Backend `GET /info` → 200
3. Vite (or `--url`) → 200
4. Chrome page on that URL → zero `console.error`, zero `Runtime.exceptionThrown` during a brief window
5. `#consolePane` → if present, rect inside viewport

Exits non-zero if any check fails. Suitable for pre-commit / CI.

```bash
npm run check
npm run check -- --url http://localhost:5173 --backend-port 8765
npm run check -- --no-chrome   # skip browser checks
```

## Extending

Add a new flag, then check `args.foo` inside the matching branch. Common
additions:

- `--click <selector>` → dispatch a click and report what happened
- `--screenshot-after <ms>` → take a shot N ms after navigation
- `--wait <selector>` → block until element appears, then probe

The CDP class is the only shared piece — feel free to copy it into a new
script. Don't refactor all three into a shared module unless a fourth script
appears; the duplication is intentional to keep each script self-contained.