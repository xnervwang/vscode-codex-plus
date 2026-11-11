// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The context meter in Codex's toolbar row, left of the model picker: a ring and the percentage of the window in use,
 * the host's own figures behind it on hover, and a click that compacts the conversation through Codex's app-server.
 *
 *   the page   drawn from the host's usage message; Codex's meter, which Codex draws only with its setting on, is
 *              hidden while this one is drawn, so the row never shows two; the click sends a request carrying only an
 *              id, and the answer is shown as a short message, in Codex's wording when a turn is running
 *   the host   the usage of the conversation each panel shows, from the rollout state it already reads; the compaction
 *              line as the work plan plugin draws it; the request sent on a channel of its own on Codex's app-server
 *              connection, refused while a turn runs or an approval waits, as Codex refuses its own /compact
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const { createDom } = require('../fake-dom');

const FLEX = { display: 'flex' }, CONTENTS = { display: 'contents' };
const PILL_CLASS = 'no-drag cursor-interaction rounded-full text-tertiary h-token-button-composer px-2';

function toolbar(dom, { rightAt = 799, codexMeter = 0 } = {}) {
  const { el } = dom;
  const add = el('button', { attrs: { type: 'button', 'data-composer-navigation-target': 'add-context' }, class: 'aspect-square',
    rect: { top: 708, left: 16, width: 28, height: 28 } });
  const perm = el('button', { attrs: { type: 'button', 'data-composer-navigation-target': 'permissions' }, class: PILL_CLASS,
    rect: { top: 708, left: 49, width: 119, height: 28 } });
  const left = el('div', { computed: FLEX, rect: { top: 708, left: 16, width: 152, height: 28 }, kids: [el('span', { computed: CONTENTS, kids: [add] }), perm] });
  const trigger = el('button', { attrs: { type: 'button', 'data-codex-intelligence-trigger': 'true' }, rect: { top: 708, left: rightAt + 20, width: 121, height: 28 } });
  const modelSlot = el('span', { rect: { top: 708, left: rightAt + 20, width: 121, height: 28 }, kids: [el('span', { computed: CONTENTS, kids: [trigger] })] });
  const wrap = codexMeter ? el('span', { class: 'text-sm', rect: { top: 713, left: rightAt, width: 16, height: 18 },
    kids: [el('span', { attrs: { role: 'img', 'aria-label': `Context usage: ${codexMeter}%` }, rect: { top: 715, left: rightAt, width: 16, height: 16 } })] }) : null;
  const right = el('div', { computed: FLEX, rect: { top: 708, left: rightAt, width: 250, height: 28 }, kids: [...(wrap ? [wrap] : []), modelSlot] });
  if (!wrap) modelSlot.rect.left = rightAt;
  const grid = el('div', { attrs: { 'data-composer-footer-responsive': '' }, kids: [el('div', { kids: [left] }), el('div', { kids: [right] })] });
  const root = el('div', { attrs: { 'data-codex-composer-root': '' }, rect: { top: 602, left: 8, width: 1084, height: 142 }, kids: [grid] });
  return { root, left, right, modelSlot, wrap };
}

function page(root, opts) {
  const dom = createDom();
  const box = toolbar(dom, opts);
  dom.setBody(dom.el('body', { kids: [dom.el('div', { attrs: { 'data-request-input-activity-root': '' }, kids: [box.root] })] }));
  const posted = [];
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerHeight: 760, innerWidth: 1100 };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const q = (sel) => dom.document.root.querySelectorAll(sel);
  const sheet = () => (q('[data-codex-extras="style"]')[0] || dom.document.head.querySelectorAll('[data-codex-extras="style"]')[0] || { textContent: '' }).textContent;
  return { dom, box, posted, q, sheet, send(m) { listeners.message({ data: m }); },
    view(over = {}) { this.send(Object.assign({ type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true }, over)); } };
}

const USAGE = { used: 251000, window: 400000, line: 378947, lineFrom: 'default', model: 'gpt-6.1-sol', effort: 'medium', windowFrom: null,
  total: { input: 1200000, cached: 980000, output: 45000, reasoning: 12000, total: 1245000 } };
const THREAD = '019a6a10-0000-7000-8000-0000000000c1';

/*
 * What the click relies on in each Codex build installed here, read from its untouched host bundle: the provider the
 * patch hands over keeps Codex's app-server connection as codexMcpConnection, the connection accepts an extra provider
 * name (registerProvider) and requests sent under it (sendRequest), and each answer goes to the provider named before
 * the first colon of its id. None of these are patch edits. If a build renames one of them, the click says compacting
 * is not available, and this test names the missing part.
 */
function connectionParts(text) {
  const at = text.indexOf('editorPanels=new Map');
  const ctor = at < 0 ? '' : text.slice(text.lastIndexOf('constructor(', at), at);
  return { connection: /this\.codexMcpConnection=[\w$]+;/.test(ctor),
    registerProvider: /registerProvider\([\w$]+,[\w$]+\)\{if\(this\.providers\.has\([\w$]+\)\)/.test(text),
    sendRequest: /sendRequest\([\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+=!1\)\{this\.sendProviderRequest\(/.test(text),
    routedByName: /let\[[\w$]+,\.\.\.[\w$]+\]=[\w$]+\.split\(":"\)/.test(text) };
}

module.exports = async ({ eq, note, tmp, root }) => {
  {
    let seen = 0;
    for (const base of [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')]) {
      let names = [];
      try { names = fs.readdirSync(base); } catch (_) { continue; }
      for (const n of names.filter((x) => /^openai\.chatgpt-/.test(x))) {
        const f = path.join(base, n, 'out', 'extension.js'), bak = f + '.codex-extras-host.bak';
        if (!fs.existsSync(f)) continue;
        seen++;
        eq(connectionParts(fs.readFileSync(fs.existsSync(bak) ? bak : f, 'utf8')), { connection: true, registerProvider: true, sendRequest: true, routedByName: true },
          `${n}: Codex's provider keeps its app-server connection, which takes a provider and a request of this extension's own name`);
      }
    }
    if (!seen) note('no Codex extension installed here: what the meter\'s click relies on was not checked against a real build');
  }
  /* ── the page ── */
  {
    const p = page(root);
    p.view();
    p.send({ type: 'codex-extras-usage', usage: USAGE });
    const meter = p.q('[data-codex-extras="meter"]')[0];
    eq([!!meter, meter && meter.parentNode === p.box.right, meter && meter.nextElementSibling === p.box.modelSlot], [true, true, true],
      'the meter goes into Codex\'s toolbar row, just left of the model picker, where Codex draws its own');
    const arc = meter && meter.querySelectorAll('circle')[1];
    eq([meter && meter.tagName, meter && meter.getAttribute('tabindex'), meter && meter.className === PILL_CLASS,
      meter && /63%/.test(meter.textContent), arc && Math.abs(parseFloat(arc.getAttribute('stroke-dashoffset')) - 37.25) < 0.01],
    ['BUTTON', '-1', true, true, true],
    'it is a button with the classes of Codex\'s permissions pill, a ring drawn as Codex draws its own, and the share in use as a number');

    meter.dispatch('mouseenter', {});
    p.dom.runTimers();
    const box = p.q('[data-codex-extras="context"]')[0];
    const text = box ? box.textContent : '';
    eq([box && box.style.display, ['gpt-6.1-sol', 'medium', '251.0k / 400.0k', 'In context', 'Free', 'Auto-compact at', '378.9k', '127.9k to go',
      'This conversation', 'Input', '1.2M', 'Cached input', '980.0k', 'Output', '45.0k', 'Reasoning', '12.0k', 'Total', 'Click to compact now']
      .filter((w) => !text.includes(w))], ['block', []],
    'hovering it opens the figures: in use and the window, free, where Codex compacts and how far off that is, what the conversation has spent, model and effort');
    meter.dispatch('mouseleave', {});
    p.dom.runTimers();
    eq(box.style.display, 'none', 'and they go when the pointer leaves');

    /* The window this conversation uses, with where it came from. */
    const rows = () => p.q('[data-codex-extras="context"]')[0].childNodes.map((n) => n.textContent);
    const hover = (from, window = 828400) => {
      p.send({ type: 'codex-extras-usage', usage: { ...USAGE, window, line: Math.floor(window * 0.9 / 0.95), windowFrom: from } });
      meter.dispatch('mouseenter', {});
      p.dom.runTimers();
      const all = rows();
      const at = all.findIndex((t) => t.startsWith('Context window'));
      meter.dispatch('mouseleave', {});
      p.dom.runTimers();
      return at < 0 ? null : [all[at], all[at + 1], all[at + 2].startsWith('In context')];
    };
    eq(hover({ kind: 'setting', model: 'gpt-6.1-sol', asked: '1.05M', used: 872000, most: true }),
      ['Context window828.4k', '95% of 872.0k, Codex\'s maximum · codexPlus.contextWindow for gpt-6.1-sol, 1.05M', true],
      'a row above In context gives the window Codex uses for this conversation, and a note under it the setting it came from and Codex\'s most');
    eq(hover({ kind: 'default', model: 'openai.gpt-6.1-sol', asked: '', used: 272000, most: false }, 258400),
      ['Context window258.4k', '95% of 272.0k · Codex\'s default for openai.gpt-6.1-sol', true], 'or Codex\'s own default for the model');
    eq(hover({ kind: 'config', model: 'gpt-6.1-sol', asked: '', used: 500000, most: false }, 475000),
      ['Context window475.0k', '95% of 500.0k · model_context_window in config.toml', true], 'or the value written into config.toml');
    eq(hover({ kind: 'earlier', model: 'gpt-6.1-sol', asked: '', used: 0, most: false }, 258400)[1],
      'set when Codex opened this conversation, before the window set now; a reload of the window applies it',
      'or a value from before the setting changed, with what applies the current one');
    eq(hover(null, 400000), ['Context window400.0k', 'In context251.0k62.8%', false], 'with nothing said about it, the row has no note');
    p.send({ type: 'codex-extras-usage', usage: { ...USAGE, window: 828400, line: 784800 } });
    eq([/30%/.test(meter.textContent), meter.getAttribute('aria-label')], [true, 'Context: 30% of the window in use. Click to compact this conversation now.'],
      'the meter\'s share follows the window Codex reports');

    let prevented = 0;
    meter.dispatch('mousedown', { preventDefault() { prevented++; } });
    meter.dispatch('click', { stopPropagation() {} });
    meter.dispatch('click', { stopPropagation() {} });
    const asks = p.posted.filter((m) => m.kind === 'compact');
    eq([prevented, asks.length, asks[0] && Object.keys(asks[0]).sort()], [1, 1, ['id', 'kind', 'type']],
      'a click asks the host to compact, with nothing but an id, keeps the caret in the message box, and a second click while it waits asks nothing');
    p.send({ type: 'codex-extras-compacted', id: asks[0].id, outcome: 'busy' });
    eq((p.q('[data-codex-extras="label"]')[0] || {}).textContent, 'Compact is disabled while a chat is in progress',
      'a turn running is said in Codex\'s own words for its /compact');
    meter.dispatch('click', { stopPropagation() {} });
    const again = p.posted.filter((m) => m.kind === 'compact');
    p.send({ type: 'codex-extras-compacted', id: again[1] && again[1].id, outcome: 'started' });
    eq([again.length, (p.q('[data-codex-extras="label"]')[0] || {}).textContent], [2, 'Compaction started'],
      'once answered it can be asked again, and a compaction under way is said');

    p.send({ type: 'codex-extras-usage', usage: Object.assign({}, USAGE, { used: 340000 }) });
    eq(p.q('[data-codex-extras="meter"]')[0].classList.contains('codex-extras-ctx-low'), true,
      'at 80% or more it is outlined, as Codex\'s own was (codexPlus.lowContextOutline)');
    p.send({ type: 'codex-extras-usage', usage: null });
    eq(p.q('[data-codex-extras="meter"]').length, 0, 'with no figures yet, a conversation not started, nothing is drawn');
    p.send({ type: 'codex-extras-usage', usage: USAGE });
    p.view({ contextMeter: false });
    eq(p.q('[data-codex-extras="meter"]').length, 0, 'codexPlus.contextMeter off draws no meter');
  }
  {
    /* Codex's own meter on (its setting Show context window usage): hidden while this one is drawn, back when it is not. */
    const p = page(root, { codexMeter: 63 });
    p.view();
    p.send({ type: 'codex-extras-usage', usage: USAGE });
    eq([p.box.wrap.classList.contains('codex-extras-ctx-hidden'), /\.codex-extras-ctx-hidden\{display:none !important;\}/.test(p.sheet()),
      p.q('[data-codex-extras="meter"]').length], [true, true, 1],
    'Codex\'s own meter is hidden while this one is drawn, so the row never shows two');
    p.view({ contextMeter: false });
    eq([p.box.wrap.classList.contains('codex-extras-ctx-hidden'), p.q('[data-codex-extras="meter"]').length], [false, 0],
      'and shown again when this one is turned off');
  }
  {
    const p = page(root, { rightAt: 172 });
    p.view();
    p.send({ type: 'codex-extras-usage', usage: USAGE });
    const bar = p.q('[data-codex-extras="bar"]')[0];
    eq([!!bar, bar && bar.contains(p.q('[data-codex-extras="meter"]')[0])], [true, true],
      'with no room in the toolbar the meter goes below the message box with the two buttons');
  }

  /* ── the host ── */
  const { vscode } = fake.create();
  fake.install(vscode);
  delete require.cache[require.resolve('../../src/patching')];
  const patching = require('../../src/patching');
  const st = { context: { used: 251000, window: 400000 }, tokens: { total: 1245000, input: 1200000, output: 45000, cached: 980000, reasoning: 12000 },
    model: 'gpt-6.1-sol', effort: 'medium' };
  eq(patching.usageOf(st, 0).usage, USAGE, 'the usage is the rollout\'s newest token count, and the line is where the work plan plugin puts it: 0.9 / 0.95 of the window');
  eq([patching.usageOf(st, 300000).usage.line, patching.usageOf(st, 300000).usage.lineFrom, patching.usageOf(st, 500000).usage.lineFrom],
    [300000, 'config', 'default'], 'model_auto_compact_token_limit moves the line when it is lower');
  eq([patching.usageOf(null).usage, patching.usageOf({ context: null }).usage], [null, null], 'and a conversation with no token count yet has none');
  eq(patching.viewOf({ enabled: true, infoButton: false, chimeButton: true, contextMeter: false }),
    { type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true, lowContext: true, replyFigures: true, replyDuration: true,
      buttons: true, chime: true, infoButton: false, chimeButton: true, contextMeter: false },
    'the three settings reach the page with the rest');
  const conv = require('../../src/codex-source').conversationOf({ id: THREAD, title: 't', updatedMs: Date.now() },
    { unread: new Set(), openHere: new Set(), state: Object.assign({ working: false, lastActivityMs: Date.now() }, st) });
  eq(conv.tokens, st.tokens, 'a conversation carries what it has spent, from the same token count as its context');

  patching.installHooks();
  let meterOn = true, list = [Object.assign({ sessionId: THREAD, state: 'idle', working: false }, st)];
  patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
    vscode, log: () => {}, settings: () => ({ patchCodex: 'off', enabled: true, chime: false, figures: false, contextMeter: meterOn }),
    source: { onDidChangeConversations: () => ({ dispose() {} }), _focus() {}, listConversations: async () => list, logo: null },
    context: { globalStorageUri: vscode.Uri.file(tmp('gs2')) }, compactLimit: () => 0 });
  const sent = [];
  const requests = [];
  let handler = null;
  const conn = {
    registerProvider(name, h) { if (handler) throw new Error(`Provider already registered: ${name}`); handler = Object.assign({ name }, h); return { dispose() { handler = null; } }; },
    sendRequest(name, id, method, params) { requests.push({ name, id, method, params }); },
  };
  const provider = { postMessageToWebview: (w, m) => sent.push(m), sendMessageToPanel() {}, codexMcpConnection: conn };
  const panel = { webview: {}, reveal() {}, onDidDispose() {}, iconPath: null };
  globalThis.__codexExtrasPanel(panel, THREAD, provider);
  await patching.refreshPanels();
  const usage = sent.filter((m) => m.type === 'codex-extras-usage').pop();
  eq(usage && usage.usage && usage.usage.used, 251000, 'each panel is sent its conversation\'s usage on the pass that draws its figures');
  meterOn = false;
  await patching.refreshPanels();
  eq(sent.filter((m) => m.type === 'codex-extras-usage').pop().usage, null, 'and none with codexPlus.contextMeter off');

  const answer = () => sent.filter((m) => m.type === 'codex-extras-compacted').pop();
  const tick = () => new Promise((r) => setTimeout(r, 10));
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'compact', id: 'k1' }, provider);
  await tick();
  eq([requests.length, requests[0] && requests[0].method, requests[0] && requests[0].params, handler && requests[0].name === handler.name],
    [1, 'thread/compact/start', { threadId: THREAD }, true],
    'a click asks Codex\'s app-server to compact the conversation the panel shows, on a channel of this extension\'s own');
  handler.onResult({ id: requests[0].id, result: {} });
  await tick();
  eq([answer().id, answer().outcome], ['k1', 'started'], 'and the page is told it started');
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'compact', id: 'k2' }, provider);
  await tick();
  eq([requests.length, answer().outcome], [1, 'busy'], 'a compaction just started counts as a turn running, so a second click sends nothing');
  globalThis.__codexExtrasAppServer('notification', { method: 'turn/completed', params: { threadId: THREAD, turn: { id: 't1' } } });
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'compact', id: 'k3' }, provider);
  await tick();
  handler.onResult({ id: requests[1].id, error: { code: -32600, message: 'thread not found: x' } });
  await tick();
  eq([requests.length, answer().outcome, answer().reason], [2, 'failed', 'thread not found: x'], 'once that turn ends it can be asked again, and a refusal is passed on');
  globalThis.__codexExtrasAppServer('notification', { method: 'turn/started', params: { threadId: THREAD, turn: { id: 't2' } } });
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'compact', id: 'k4' }, provider);
  await tick();
  eq([requests.length, answer().outcome], [2, 'busy'], 'while a turn runs nothing is sent, as Codex refuses its own /compact then');
  globalThis.__codexExtrasAppServer('notification', { method: 'turn/completed', params: { threadId: THREAD, turn: { id: 't2' } } });
  list = [Object.assign({ sessionId: THREAD, state: 'working', working: true }, st)];
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'compact', id: 'k5' }, provider);
  await tick();
  eq([requests.length, answer().outcome], [2, 'busy'], 'and so is a turn the rollout says is running, which a window reloaded mid-turn learns only from there');
  list = [Object.assign({ sessionId: THREAD, state: 'idle', working: false }, st)];
  /* A turn whose turn/completed never arrived, as when the app-server restarts mid-turn: after ten minutes, and with the
     rollout showing no turn running, it no longer blocks a compaction. */
  globalThis.__codexExtrasAppServer('notification', { method: 'turn/started', params: { threadId: THREAD, turn: { id: 't3' } } });
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try {
    globalThis.__codexExtrasMessage(panel.webview, { kind: 'compact', id: 'k5b' }, provider);
    await tick();
  } finally { Date.now = realNow; }
  handler.onResult({ id: requests[2] && requests[2].id, result: {} });
  await tick();
  eq([requests.length, answer().id, answer().outcome], [3, 'k5b', 'started'],
    'a turn start whose end never came stops counting after ten minutes, unless the rollout says it still runs');
  globalThis.__codexExtrasAppServer('notification', { method: 'turn/completed', params: { threadId: THREAD, turn: { id: 't3' } } });
  delete provider.codexMcpConnection;
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'compact', id: 'k6' }, provider);
  await tick();
  eq([requests.length, answer().outcome], [3, 'unavailable'], 'a Codex whose connection is not reachable says so rather than doing nothing');
  /* What Show Status says of them, from the page's self-check. */
  const said = patching.selfCheckLines({ report: { format: 1, script: { version: '1.0.1' },
    buttons: { setting: true, composerFound: true, drawn: true, inToolbar: true, info: true, chime: false },
    context: { meterFound: true, percentUsed: 63, codexMeterHidden: true, ours: true, oursPercent: 63, outlined: false, outlineSetting: true, outlineAt: 80 } } }).join('\n');
  eq(["in Codex's toolbar row; information button yes, chime button no", "found, 63% used, hidden while this extension's is drawn",
    "this extension's: drawn, 63% used"].filter((w) => !said.includes(w)), [],
  'Show Status says where the controls are, which of them are drawn, and which meter is the one shown');
  patching._approvals.clear();
};
