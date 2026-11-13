// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A conversation started in a tab whose URI names none, as Codex's New button and this extension's tab bar button open
 * one: Codex hands that tab's panel over with no thread, and the patch learns the thread from the start its own page
 * sends, once the thread has reached Codex's list.
 *
 * Every hook is called the way the patched host calls it: the argument expressions are taken from the patch applied to
 * the pristine Codex bundle installed here, and the names they use are bound to what Codex has there. The panel's thread
 * comes from Codex's own URI parser (test/codex-uri-parser.js), run on the tab's URI. Without an installed Codex the same calls are made by
 * hand, in the shape the patch would make them.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('../fake-vscode');
const { uriParser } = require('../codex-uri-parser');

const NEW = '01a1aaaa-0000-7000-8000-00000000000a';
const NEW2 = '01a1bbbb-0000-7000-8000-00000000000b';
const NEW3 = '01a1cccc-0000-7000-8000-00000000000c';
const NAMED = '01a1dddd-0000-7000-8000-00000000000d';
const LATER = '01a1eeee-0000-7000-8000-00000000000e';
const SIDEBAR = '01a1ffff-0000-7000-8000-00000000000f';
const SIDE_CHAT = '01a19999-0000-7000-8000-000000000009';

function pristineBundle() {
  for (const root of [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const n of names.filter((x) => /^openai\.chatgpt-/.test(x)).sort()) {
      const file = path.join(root, n, 'out', 'extension.js');
      const bak = file + '.codex-extras-host.bak';
      if (fs.existsSync(bak)) return { name: n, src: fs.readFileSync(bak, 'utf8') };
      if (fs.existsSync(file)) {
        const src = fs.readFileSync(file, 'utf8');
        if (!src.includes('/* CODEX-EXTRAS-HOST v')) return { name: n, src };
      }
    }
  }
  return null;
}

/* The argument list of each call to `hook` the patch put into `out`, split at its top-level commas. */
function callArgs(out, hook) {
  const re = new RegExp(`globalThis\\.${hook}&&globalThis\\.${hook}\\(`, 'g');
  const all = [];
  for (const m of out.matchAll(re)) {
    let depth = 1, i = m.index + m[0].length, cur = '', args = [];
    for (; i < out.length && depth; i++) {
      const c = out[i];
      if (c === '(') depth++;
      if (c === ')') { depth--; if (!depth) break; }
      if (c === ',' && depth === 1) { args.push(cur); cur = ''; } else cur += c;
    }
    args.push(cur);
    all.push(args);
  }
  return all;
}

module.exports = async ({ eq, bad, note, tmp }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const host = require('../../src/host');
  const patching = require('../../src/patching');
  const { createCodexSource } = require('../../src/codex-source');

  /* ── the calls as the patched host makes them ── */
  const bundle = pristineBundle();
  let callPanel, callOther, callRequest, callResponse, parse;
  if (bundle) {
    const { src } = bundle;
    const out = host.patchSource(src).out;
    const groups = (name) => {
      const e = host.EDITS.find((x) => x.name === name);
      return [...src.matchAll(new RegExp(e.re.source, e.re.flags))][0];
    };
    const run = (args, names, values, self) => new Function(...names, `return globalThis.__h(${args.join(',')})`).call(self, ...values);
    const bind = (hook, args) => (names, values, self) => {
      globalThis.__h = globalThis[hook];
      try { return run(args, names, values, self); } finally { delete globalThis.__h; }
    };
    const panels = callArgs(out, '__codexExtrasPanel');
    const requests = callArgs(out, '__codexExtrasPageRequest');
    const [response] = callArgs(out, '__codexExtrasPageResponse');
    const cp = groups('conversation panels'), op = groups('other panels'), pr = groups('page requests'), ps = groups('page responses');
    callPanel = (panel, uri, provider) => {
      const parsed = parse(uri);
      return bind('__codexExtrasPanel', panels[0])([cp[5], cp[2], cp[3]], [panel, parsed.conversationId, parsed], provider);
    };
    callOther = (panel, opts, provider) => bind('__codexExtrasPanel', panels[1])([op[1], op[2]], [panel, opts], provider);
    callRequest = (webview, msg, which) => bind('__codexExtrasPageRequest', requests[which === 'prewarm' ? 1 : 0])([pr[4], pr[2]], [webview, msg]);
    callResponse = (webview, resp) => bind('__codexExtrasPageResponse', response)([ps[3], ps[1]], [webview, resp]);
    const parser = uriParser(src);
    if (parser) {
      parse = (p) => parser.parse({ scheme: parser.scheme, authority: parser.authority, path: p, query: '' });
    } else {
      bad(`${bundle.name}: Codex's URI parser was not found in its bundle, so a tab's thread is read by hand; test/codex-uri-parser.js does not match this build`);
    }
    eq([panels.length, requests.length, callArgs(out, '__codexExtrasPageResponse').length], [2, 2, 1],
      `${bundle.name}: the patch hands over panels from two places, page requests from two and page responses from one`);
  } else {
    note('no Codex extension installed here: the hooks are called by hand rather than as the patched host calls them');
    callPanel = (panel, uri, provider) => { const p = parse(uri); return globalThis.__codexExtrasPanel(panel, p.conversationId, provider, p.path); };
    callOther = (panel, opts, provider) => globalThis.__codexExtrasPanel(panel, null, provider, opts && opts.initialRoute);
    callRequest = (webview, msg, which) => globalThis.__codexExtrasPageRequest(webview, msg.request, which === 'prewarm' ? 'prewarm' : 'request');
    callResponse = (webview, resp) => globalThis.__codexExtrasPageResponse(webview, resp);
  }
  if (!parse) {
    parse = (p) => { const m = /^\/(local|remote)\/([^/]+)/.exec(p); return { path: p, conversationId: m ? m[2] : null }; };
  }
  eq(parse('/extension/panel/new').conversationId, null, 'Codex itself reads no conversation out of the New tab\'s URI');

  /* ── a window with the patch in effect ── */
  const sent = [];
  const provider = { sendMessageToPanel: (p, msg) => sent.push({ to: p, msg }), postMessageToWebview: (w, msg) => sent.push({ to: w, msg }),
    navigateToRoute() {} };
  const changed = new fake.EventEmitter();
  let conversations = [];
  const source = { listConversations: async () => conversations, onDidChangeConversations: changed.event, logo: null, _focus() {} };
  const context = { subscriptions: [], globalState: fake.memento(), globalStorageUri: vscode.Uri.file(tmp('gs')) };
  patching.installHooks();
  patching._approvals.clear();
  patching.activate(context, { vscode, log: () => {}, source, context,
    settings: () => ({ patchCodex: 'off', chime: true, figures: false, enabled: true, timestamps: true }) });
  const panelOf = (id) => ({ webview: { id }, visible: false, viewColumn: undefined, active: false, iconPath: null,
    reveal() { this.revealed = (this.revealed || 0) + 1; }, onDidDispose(fn) { this.dispose = fn; } });
  const say = (webview, on) => globalThis.__codexExtrasMessage(webview, { type: 'codex-extras', kind: 'approval', on }, provider);
  const toPanel = (p) => sent.filter((s) => s.to === p || s.to === p.webview).map((s) => s.msg);

  /* The sidebar went to another conversation earlier. */
  globalThis.__codexExtrasBroadcast('thread-stream-following-changed', { conversationId: SIDEBAR, following: true });

  /* ── a New tab, before anything is typed ── */
  const one = panelOf('first new tab');
  one.visible = true; one.viewColumn = 1; one.active = true;
  callPanel(one, '/extension/panel/new', provider);
  const rec = patching._registry.get(one);
  eq([patching.panelThreads(), rec && rec.thread, rec && rec.route], [[], '', '/extension/panel/new'],
    'a New tab\'s panel is kept with no conversation, and with the route Codex opened it on');
  /* Its page prewarms a thread, which is what Codex does before anything is typed. */
  callRequest(one.webview, { type: 'thread-prewarm-start', request: { id: 'prewarm-1', params: { cwd: '/w' } } }, 'prewarm');
  callResponse(one.webview, { id: 'prewarm-1', result: { thread: { id: NEW, ephemeral: false } } });
  await patching.refreshPanels();
  eq([patching.panelThreads(), patching.canDeliver(NEW)], [[], false],
    'a prewarmed thread is not the tab\'s conversation while nobody has typed into it: Codex has not listed it');
  say(one.webview, true);
  eq([patching.approvalsOf(SIDEBAR).decide, patching._approvals.decideCount()], [0, 0],
    'and a card its page shows meanwhile is not put on the conversation the sidebar last went to');
  say(one.webview, false);

  /* ── its first message ── */
  conversations = [{ sessionId: NEW, state: 'working', working: true }];
  await patching.refreshPanels();
  eq([patching.panelThreads(), patching.canDeliver(NEW)], [[NEW], true],
    'once the first message is sent the thread is in Codex\'s list, and the tab is that conversation\'s');
  sent.length = 0;
  const r = await patching.deliver(NEW, 'an answer', { waitMs: 50 });
  eq([r.outcome, toPanel(one).map((m) => m.type).slice(0, 2)], ['uncertain', ['codex-extras-answer', 'navigate-to-route']],
    'so an answer for it goes into that tab, and its page, which here never answers, leaves it uncertain');
  globalThis.__codexExtrasAppServer('request', { id: 41, method: 'item/commandExecution/requestApproval', params: { threadId: NEW } });
  say(one.webview, true);
  eq([patching._approvals.threads(), patching._approvals.decideCount(), patching.approvalsOf(SIDEBAR).decide], [[NEW], 1, 0],
    'its approval card counts for its own conversation only: one request waiting is one answer owed');
  globalThis.__codexExtrasAppServer('answer', { id: 41 });
  say(one.webview, false);

  /* What the source answers for that tab, with the patch itself rather than a stand-in. */
  const newTab = { label: 'Codex', input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex', authority: 'route',
    path: '/extension/panel/new' }), 'chatgpt.conversationEditor') };
  const reader = { threads: () => [], sections: () => new Map(), state: () => null, unread: () => new Map(), hasPlan: () => false,
    thread: () => null, present: () => true, refresh: async () => false, ready: async () => ({ threads: [], readable: true }) };
  control.setTabs([newTab], 0);
  const src1 = createCodexSource(vscode, { reader, patching });
  try {
    eq([src1.sessionForTab(control.groups[0].tabs[0]), src1.isFocused(NEW)], [NEW, true], 'the work plan view is given that conversation for the tab in front');
  } finally { src1.dispose(); }

  /* ── a second New tab at the same time ── */
  const two = panelOf('second new tab');
  callPanel(two, '/extension/panel/new', provider);
  callRequest(two.webview, { type: 'mcp-request', request: { id: 'read-1', method: 'thread/read', params: { threadId: NEW } } });
  callResponse(two.webview, { id: 'read-1', result: { thread: { id: NEW } } });
  callResponse(two.webview, { id: 'prewarm-1', result: { thread: { id: NEW } } });
  await patching.refreshPanels();
  eq([patching._registry.get(two).thread, patching.panelThreads()], ['', [NEW]],
    'a second New tab takes nothing from an answer to a request that started no thread, nor from another page\'s request id');
  callRequest(two.webview, { type: 'mcp-request', request: { id: 'start-2', method: 'thread/start', params: {} } });
  callResponse(two.webview, { id: 'start-2', result: { thread: { id: NEW2 } } });
  conversations = [{ sessionId: NEW, state: 'idle' }, { sessionId: NEW2, state: 'working', working: true }];
  await patching.refreshPanels();
  eq([patching._registry.get(one).thread, patching._registry.get(two).thread], [NEW, NEW2],
    'each New tab is matched to the thread its own page started, by its own webview, however many are open');
  control.setTabs([newTab, { ...newTab }], 0);
  const src2 = createCodexSource(vscode, { reader, patching });
  try {
    eq(src2.sessionForTab(control.groups[0].tabs[0]), NEW,
      'with two such tabs the one in front is still named, by the one panel visible in its column');
    eq(src2.sessionForTab(control.groups[0].tabs[1]), '', 'and one behind it is left unnamed rather than guessed');
  } finally { src2.dispose(); }

  /* ── settings reach a tab whose conversation is not known yet ── */
  const three = panelOf('third new tab');
  callPanel(three, '/extension/panel/new', provider);
  sent.length = 0;
  await patching.refreshPanels();
  eq(toPanel(three).some((m) => m.type === 'codex-extras-view'), true, 'the settings reach a New tab before its conversation is known');

  /* ── a side chat, and a new conversation in the same tab ── */
  callRequest(one.webview, { type: 'mcp-request', request: { id: 'fork-1', method: 'thread/fork', params: { threadId: NEW, ephemeral: true } } });
  callResponse(one.webview, { id: 'fork-1', result: { thread: { id: SIDE_CHAT, ephemeral: true } } });
  callRequest(one.webview, { type: 'mcp-request', request: { id: 'start-eph', method: 'thread/start', params: { ephemeral: true } } });
  callResponse(one.webview, { id: 'start-eph', result: { thread: { id: SIDE_CHAT, ephemeral: true } } });
  conversations = [...conversations, { sessionId: SIDE_CHAT, state: 'working', working: true }];
  await patching.refreshPanels();
  eq(patching._registry.get(one).thread, NEW, 'a side chat beside the conversation never becomes the tab\'s conversation');
  globalThis.__codexExtrasAppServer('request', { id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: NEW } });
  say(one.webview, true);
  callRequest(one.webview, { type: 'mcp-request', request: { id: 'start-3', method: 'thread/start', params: {} } });
  callResponse(one.webview, { id: 'start-3', result: { thread: { id: NEW3 } } });
  await patching.refreshPanels();
  eq(patching._registry.get(one).thread, NEW, 'a new conversation started in the same tab waits until it is listed');
  conversations = [...conversations, { sessionId: NEW3, state: 'working', working: true }];
  await patching.refreshPanels();
  eq([patching._registry.get(one).thread, patching.canDeliver(NEW), patching.canDeliver(NEW3)], [NEW3, false, true],
    'then the tab follows it, and the conversation it left takes no more answers through it');
  globalThis.__codexExtrasAppServer('answer', { id: 42 });
  eq(patching.approvalsOf(NEW).decide, 0, 'and what its page said about the card of the conversation it left is dropped');
  say(one.webview, false);

  /* ── a tab opened on a conversation, which then starts another ── */
  const named = panelOf('named tab');
  callPanel(named, `/local/${NAMED}`, provider);
  eq(patching._registry.get(named).thread, NAMED, 'a tab opened on a conversation is that conversation\'s from the start');
  callRequest(named.webview, { type: 'mcp-request', request: { id: 'start-4', method: 'thread/start', params: {} } });
  callResponse(named.webview, { id: 'start-4', result: { thread: { id: LATER } } });
  conversations = [...conversations, { sessionId: NAMED, state: 'idle' }, { sessionId: LATER, state: 'working', working: true }];
  await patching.refreshPanels();
  const namedTab = control.codexTab(NAMED);
  control.setTabs([newTab, namedTab], 0);
  const src3 = createCodexSource(vscode, { reader, patching });
  try {
    eq([patching.nowShowing(NAMED), src3.sessionForTab(namedTab), patching.canDeliver(NAMED)], [LATER, LATER, false],
      'a conversation started in it replaces the one its URI still names, for the work plan view as for answers');
  } finally { src3.dispose(); }

  /* ── panels that are not conversations ── */
  const diff = panelOf('diff panel');
  callOther(diff, { title: 'Codex Diff', initialRoute: '/diff' }, provider);
  eq(patching._registry.get(diff) && patching._registry.get(diff).route, '/diff', 'Codex\'s other panels are handed over too');
  say(diff.webview, true);
  eq([patching.approvalsOf(SIDEBAR).decide, patching._approvals.decideCount()], [0, 0], 'so a page of theirs is never taken for the sidebar\'s');
  say(diff.webview, false);
  const sidebarPage = { id: 'sidebar' };
  say(sidebarPage, true);
  eq(patching.approvalsOf(SIDEBAR).decide, 1, 'while a page that is no panel\'s is the sidebar, and speaks for its conversation');
  say(sidebarPage, false);

  /* ── a closed tab, and taking the patch off ── */
  sent.length = 0;
  control.state.extensions.set('openai.chatgpt', { extensionPath: tmp('no-codex-files'), packageJSON: { version: '0' } });
  patching.removePatch(vscode);
  eq([one, two, three, named, diff].map((p) => toPanel(p).some((m) => m.type === 'codex-extras-view' && m.timestamps === false)),
    [true, true, true, true, true], 'taking the patch off tells every page to clear what it drew, known conversation or not');
  three.dispose();
  eq(patching._registry.has(three), false, 'a closed tab is forgotten');
  for (const p of [one, two, named, diff]) p.dispose();
  patching._approvals.clear();
};
