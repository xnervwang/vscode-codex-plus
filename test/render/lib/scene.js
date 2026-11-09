// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * One running Codex page: a made-up CODEX_HOME, Codex's real app-server on it with no network, a static server on
 * 127.0.0.1 serving the installed Codex webview read only with the repository's page script in place of the installed
 * copy, and a headless Chromium on the page. The page's app-server traffic goes through the __toNode binding to the
 * app-server and back; `toPage` sends a message as Codex's host or as this extension's host would.
 */
const fs = require('fs');
const path = require('path');
const { serve, launch, sleep } = require('./cdp');
const page = require('./codex-page');
const fakeHome = require('./fake-codex-home');
const appServer = require('./app-server');

const HARNESS = path.join(__dirname, '..', 'harness');
/* What a signed-in account would answer. The app-server's own answer in a made-up home is "not signed in", and the
   page then shows its login screen instead of the conversation. */
const SIGNED_IN = {
  'account/read': () => ({ account: { type: 'chatgpt', email: 'demo.user@example.com', planType: 'pro' }, requiresOpenaiAuth: true, workspaceRouting: null }),
  getAuthStatus: () => ({ authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: true }),
};

/*
 * `env` is { chrome, codex: { dir, version, binary }, capnweb, work }; `opts` is { name, width, height, turns, days,
 * settings }. `onAppServer(kind, msg)` is told of every notification and request the app-server sends the page.
 */
async function open(env, { name, width = 1100, height = 760, turns, days, settings = {}, onAppServer = () => {} }) {
  const dir = path.join(env.work, name);
  fs.mkdirSync(dir, { recursive: true });
  const data = fakeHome.write(dir, { turns, days });
  const as = appServer.start({ binary: env.codex.binary, codexHome: data.codexHome, home: data.home, version: env.codex.version,
    log: path.join(dir, 'app-server.log') });
  await as.ready;
  const config = { capnweb: `/codex-webview/assets/${env.capnweb}`, version: env.codex.version, settings };
  const srv = await serve({ '/codex-webview/': path.join(env.codex.dir, 'webview'), '/harness/': HARNESS }, {
    '/codex.html': () => ({ body: page.pageHtml(env.codex.dir, { route: `/local/${fakeHome.THREAD}`, version: env.codex.version,
      pre: [{ src: '/harness/config.js' }, { src: '/harness/vscode-stub.js' }, { src: '/harness/services.js' },
        { src: '/harness/codex-host.js', module: true }] }) }),
    '/harness/config.js': () => ({ type: 'text/javascript; charset=utf-8', body: `window.__renderConfig = ${JSON.stringify(config)};\n` }),
    '/codex-webview/codex-extras-page.js': () => ({ type: 'text/javascript; charset=utf-8', body: fs.readFileSync(page.PAGE_SCRIPT, 'utf8') }),
  });
  const userDataDir = path.join(dir, 'chrome-profile');
  const b = await launch({ chrome: env.chrome, width, height, userDataDir });
  const toPage = (msg) => b.send('Runtime.evaluate', { expression: `window.__fromHost(${JSON.stringify(msg)})` }).catch(() => {});
  as.handlers.notification = (m) => { onAppServer('notification', m); toPage({ type: 'mcp-notification', hostId: 'local', method: m.method, params: m.params }); };
  as.handlers.request = (m) => { onAppServer('request', m); toPage({ type: 'mcp-request', hostId: 'local', request: { id: m.id, method: m.method, params: m.params } }); };
  b.on((m) => {
    if (m.method !== 'Runtime.bindingCalled' || m.params.name !== '__toNode') return;
    let msg;
    try { msg = JSON.parse(m.params.payload); } catch (_) { return; }
    if (msg.kind === 'mcp-request') {
      const req = msg.request;
      if (SIGNED_IN[req.method]) { toPage({ type: 'mcp-response', hostId: 'local', message: { id: req.id, result: SIGNED_IN[req.method]() } }); return; }
      as.request(req.method, req.params || {}, req.id).then((r) => toPage({ type: 'mcp-response', hostId: 'local', message: { id: req.id, result: r.result, error: r.error } }));
    } else if (msg.kind === 'mcp-notification' && msg.request) as.notify(msg.request.method, msg.request.params);
    else if (msg.kind === 'mcp-response' && msg.response) as.respond(msg.response.id, msg.response.result);
  });
  await b.send('Runtime.addBinding', { name: '__toNode' });
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
  await b.navigate(`http://127.0.0.1:${srv.port}/codex.html`);
  const want = Math.min((turns || fakeHome.FOUR).length, 4);
  let shown = 0;
  for (let i = 0; i < 100 && shown < want; i++) {
    shown = await b.evaluate('document.querySelectorAll("[data-turn-key]").length').catch(() => 0);
    if (shown < want) await sleep(400);
  }
  await sleep(800);
  const close = async () => { await b.close(); as.stop(); await srv.close(); };
  return { b, as, toPage, data, dir, shown, close };
}

module.exports = { open, sleep };
