#!/usr/bin/env node
// Minimal CDP QA helper: opens URLs in headless Chrome, reports layout metrics,
// takes screenshots. No deps (uses global WebSocket, Node 22+).
// Usage:
//   node tools/cdp-check.mjs <url> [--win WxH] [--shot out.png] [--wait ms] [--eval "js"]
// Prints JSON metrics: scrollW/H, clientW/H, overflowX/Y, title, plus eval result.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const url = args[0];
if (!url) { console.error('usage: node tools/cdp-check.mjs <url> [--win WxH] [--shot out.png] [--wait ms] [--eval js]'); process.exit(1); }
const get = (flag, def) => { const i = args.indexOf(flag); return i > 0 ? args[i + 1] : def; };
const win = get('--win', '1280x900').split('x').map(Number);
const shot = get('--shot', null);
const waitMs = Number(get('--wait', 2500));
const evalJs = get('--eval', null);

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const proc = spawn(CHROME, [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=0`, `--window-size=${win[0]},${win[1]}`, 'about:blank',
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

// browser-level endpoint -> find the page target's ws url
const port = new URL(wsUrl).port;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
let pageWs = page && page.webSocketDebuggerUrl;
if (!pageWs) {
  // create a target
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`)).json();
  pageWs = created.webSocketDebuggerUrl;
}
wsUrl = pageWs;

const ws = new WebSocket(wsUrl);
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
await send('Emulation.setDeviceMetricsOverride', { width: win[0], height: win[1], deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, waitMs));

const evRes = await send('Runtime.evaluate', {
  returnByValue: true,
  awaitPromise: true,
  expression: `(async () => {
    const d = document.documentElement, b = document.body;
    const r = {
      title: document.title,
      scrollW: Math.max(d.scrollWidth, b ? b.scrollWidth : 0),
      scrollH: Math.max(d.scrollHeight, b ? b.scrollHeight : 0),
      clientW: d.clientWidth, clientH: d.clientHeight,
    };
    r.overflowX = r.scrollW > r.clientW + 1;
    r.overflowY = r.scrollH > r.clientH + 1;
    ${evalJs ? 'try { let v = eval(' + JSON.stringify(evalJs) + '); if (v && typeof v.then === "function") v = await v; r.eval = v; } catch(e) { r.eval = "ERR: " + e.message; }' : ''}
    return r;
  })()`,
});
const metrics = evRes.result && evRes.result.result ? evRes.result.result.value : { error: JSON.stringify(evRes).slice(0, 300) };

if (shot) {
  const img = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).result.data;
  writeFileSync(shot, Buffer.from(img, 'base64'));
}
console.log(JSON.stringify(metrics));
ws.close(); proc.kill();
