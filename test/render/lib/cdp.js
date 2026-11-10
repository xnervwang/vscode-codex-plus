// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A static server on 127.0.0.1 and a headless Chromium driven over the DevTools protocol, with no dependencies.
 *
 * Nothing the page asks for leaves the machine. Every request is paused in the browser (the Fetch domain), and one
 * that is not to 127.0.0.1 is failed there and counted in `blocked`: Codex's page reports its errors to an outside
 * collector. Under that, the browser is given a proxy that does not exist and a resolver that resolves nothing, so a
 * request from a target the Fetch domain does not see (a worker of the page) fails too.
 *
 * The browser keeps its own autoplay rule, under which an audio context made before anyone has clicked or typed in the
 * page stays suspended: that is the rule Codex's webview applies, and a check that turned it off could not see a chime
 * that nobody hears.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

/* The Playwright cache's headless shell, newest build first, unless CHROME names one. '' when there is none. */
function findChrome() {
  if (process.env.CHROME) return fs.existsSync(process.env.CHROME) ? process.env.CHROME : '';
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  let names = [];
  try { names = fs.readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)); } catch (_) { return ''; }
  names.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const n of names) {
    const exe = path.join(cache, n, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (fs.existsSync(exe)) return exe;
  }
  return '';
}

/*
 * Serves `mounts` (URL prefix -> directory, read only) and `routes` (URL path -> () => { type, body }) on 127.0.0.1.
 * A route wins over a mount, which is how a file of the installed extension is replaced by the repository's copy.
 */
function serve(mounts, routes = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = decodeURIComponent(url.pathname);
    if (routes[p]) {
      const r = routes[p](url);
      res.writeHead(200, { 'Content-Type': r.type || 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(r.body);
      return;
    }
    const prefix = Object.keys(mounts).find((m) => p.startsWith(m));
    if (!prefix) { res.writeHead(404); res.end(); return; }
    const root = path.resolve(mounts[prefix]);
    const file = path.resolve(root, '.' + p.slice(prefix.length - 1));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  });
  /* Closing drops the connections still open, which a browser keeps alive; waiting for them is what can hang. */
  const close = () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); setTimeout(r, 2000); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Every process this run started, killed when it exits however it exits. */
const children = new Set();
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch (_) { /* gone */ } } });
function started(proc) { children.add(proc); proc.on('exit', () => children.delete(proc)); return proc; }

/* A headless shell with its DevTools port on loopback, and a CDP session on its one page. */
async function launch({ chrome, width = 1100, height = 760, userDataDir }) {
  const args = ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check',
    '--force-color-profile=srgb', '--font-render-hinting=none',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    `--user-data-dir=${userDataDir}`, 'about:blank'];
  const proc = started(spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] }));
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`the headless shell printed no DevTools address: ${buf.slice(-300)}`)), 20000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`the headless shell exited ${c}: ${buf.slice(-300)}`)); });
  });
  const list = await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/list`)).json();
  const ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`)); else resolve(msg.result);
    } else if (msg.method) for (const l of listeners.slice()) l(msg);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const on = (fn) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); };
  const blocked = [];
  on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const u = m.params.request.url;
    if (/^http:\/\/127\.0\.0\.1(:\d+)?\//.test(u)) send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    else {
      blocked.push(u.replace(/[?#].*/, ''));
      send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const errors = [];
  on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(String((d.exception && d.exception.description) || d.text).split('\n')[0]);
    }
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(`evaluate: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
    }
    return r.result.value;
  };
  const navigate = async (url) => {
    const loaded = new Promise((r) => { const off = on((m) => { if (m.method === 'Page.loadEventFired') { off(); r(); } }); });
    await send('Page.navigate', { url });
    await Promise.race([loaded, sleep(30000)]);
  };
  const screenshot = async (file, clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { scale: 1, ...clip } } : {}) });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  };
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); };
  const hover = (x, y) => mouse('mouseMoved', x, y);
  const close = async () => {
    await Promise.race([send('Browser.close').catch(() => {}), sleep(2000)]);
    try { ws.close(); } catch (_) { /* gone */ }
    try { proc.kill('SIGKILL'); } catch (_) { /* gone */ }
  };
  return { send, on, evaluate, navigate, screenshot, click, hover, close, blocked, errors };
}

module.exports = { findChrome, serve, launch, sleep, started };
