#!/usr/bin/env node
// Print-to-PDF exporter: renders every print page variant in headless Chrome
// and saves exact-size PDFs (Page.printToPDF with preferCSSPageSize — the
// pages carry their own @page size, so A4/A5/A3 land perfectly).
// No deps (global WebSocket, Node 22+).
//
// Usage:
//   node tools/print-pdf.mjs                 # everything below
//   node tools/print-pdf.mjs door E112       # one variant
//   node tools/print-pdf.mjs door             # all door variants
// Output: pdf/<name>.pdf
//
// Requires the test server: python3 -m http.server 8765 (repo root).

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const BASE = 'http://localhost:8765';
const OUT = 'pdf';

// Event rooms per floor (kept in sync with data/events.json).
const DOOR_ROOMS = ['C106', 'E103', 'E112', 'E105', 'E104', 'A104', 'A218', 'C228', 'N105', 'R212'];
const STAND_ROOMS = ['A101', 'C106', 'E103', 'C228', 'N105', 'R212'];

const PAGES = [
  { kind: 'handout', url: '/print/handout.html', name: 'handout-a5' },
  { kind: 'a3', url: '/print/program-a3.html', name: 'program-a3' },
  ...DOOR_ROOMS.map((r) => ({ kind: 'door', url: `/print/door.html?room=${r}`, name: `door-${r.toLowerCase()}` })),
  ...STAND_ROOMS.map((r) => ({ kind: 'stand', url: `/print/stand.html?at=${r}`, name: `stand-${r.toLowerCase()}` })),
];

const args = process.argv.slice(2);
let pages = PAGES;
if (args.length) {
  const [kind, arg] = args;
  if (arg) pages = PAGES.filter((p) => p.kind === kind && p.name === `${kind}-${String(arg).toLowerCase()}`);
  else pages = PAGES.filter((p) => p.kind === kind);
}

if (!existsSync(OUT)) mkdirSync(OUT);

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const proc = spawn(CHROME, [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--remote-debugging-port=0', '--window-size=1200,1600', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let wsUrl = '';
await new Promise((resolve) => {
  let buf = '';
  const onData = (d) => {
    buf += d;
    const m = buf.match(/ws:\/\/[^\s]+/);
    if (m) { wsUrl = m[0].replace('localhost', '127.0.0.1'); resolve(); }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  setTimeout(() => resolve(), 8000);
});
if (!wsUrl) { console.error('no devtools ws'); proc.kill(); process.exit(1); }

const port = new URL(wsUrl).port;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params }));
});

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1600, deviceScaleFactor: 1, mobile: false });

console.log(`exporting ${pages.length} page(s) → ${OUT}/`);
let ok = 0;
for (const p of pages) {
  await send('Page.navigate', { url: BASE + p.url });
  await new Promise((r) => setTimeout(r, 5000)); // fonts + layout passes settle
  const res = await send('Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: true,
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  if (res.result && res.result.data) {
    writeFileSync(`${OUT}/${p.name}.pdf`, Buffer.from(res.result.data, 'base64'));
    ok++;
    console.log(`  ✓ ${p.name}.pdf`);
  } else {
    console.error(`  ✗ ${p.name} — printToPDF failed`, res.error || '');
  }
}

proc.kill();
console.log(`${ok}/${pages.length} PDFs written to ${OUT}/`);
process.exit(ok === pages.length ? 0 : 1);
