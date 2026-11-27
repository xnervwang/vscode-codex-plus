// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A page this extension loads again after Codex replaced it with its recovery page (src/broken-pages.js) starts on the
 * route its tab's URI names, which for a New tab is a new conversation page. A page that broke just as its first
 * message turned it into the conversation's page would lose that conversation from its tab, so the new page is sent to
 * the conversation the page before it had begun (src/patching.js followAfterReload): once the new page is up, and once
 * that conversation's first turn has started. A thread Codex made ahead of any message is not followed, nor is the
 * conversation a tab's URI names already, and a conversation the new page begins itself ends it.
 */
const path = require('path');
const fake = require('../fake-vscode');

const BEGUN = '01a3c0c1-0000-7000-8000-00000000000a';
const PREWARMED = '01a3c0c1-0000-7000-8000-00000000000b';
const LATE = '01a3c0c1-0000-7000-8000-00000000000c';
const NAMED = '01a3c0c1-0000-7000-8000-00000000000d';
const LEFT = '01a3c0c1-0000-7000-8000-00000000000e';
const OWN = '01a3c0c1-0000-7000-8000-00000000000f';
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, tmp, root }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(root, 'src') + path.sep)) delete require.cache[k];
  const patching = require('../../src/patching');
  const uri = (p, fragment) => String(vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: p, fragment }));
  const sent = [], logged = [];
  const provider = { editorPanels: new Map(), sendMessageToPanel: (p, m) => sent.push([p.name, m]), postMessageToWebview() {}, navigateToRoute() {} };
  const source = { listConversations: async () => [], onDidChangeConversations: new fake.EventEmitter().event, logo: null, _focus() {}, _heard() {} };
  const context = { subscriptions: [], workspaceState: fake.memento(), globalState: fake.memento(), globalStorageUri: vscode.Uri.file(tmp('gs')) };
  patching.activate(context, { vscode, log: (l) => logged.push(l), source, context, present: () => true, reloadWaitMs: 0,
    settings: () => ({ patchCodex: 'off', chime: false, figures: false, enabled: true, timestamps: false }) });
  const panels = {};
  const open = (name, u, thread, route) => {
    const p = { name, webview: { name, html: `<html>${name}</html>` }, title: 'Codex', visible: true, viewColumn: 1, active: false, iconPath: null,
      reveal() {}, onDidDispose(fn) { this.dispose = fn; } };
    (globalThis.__codexExtrasPanelUris || (globalThis.__codexExtrasPanelUris = new WeakMap())).set(p, u);
    globalThis.__codexExtrasPanel(p, thread, provider, route);
    panels[name] = p;
    return p;
  };
  const ask = (p, id, kind = 'request') => globalThis.__codexExtrasPageRequest(p.webview, { id, method: 'thread/start', params: {} }, kind);
  const answer = (p, id, thread) => globalThis.__codexExtrasPageResponse(p.webview, { id, result: { thread: { id: thread } } });
  const turn = (thread, id) => globalThis.__codexExtrasAppServer('notification', { method: 'turn/started', params: { threadId: thread, turn: { id } } });
  const breaks = async (p) => {
    globalThis.__codexExtrasMessage(p.webview, { type: 'codex-extras', kind: 'brokenPage', reason: 'module', file: 'local-conversation-page-x.js' }, provider);
    await tick(60);
  };
  const up = (p) => globalThis.__codexExtrasMessage(p.webview, { type: 'codex-extras', kind: 'tz', timeZone: 'UTC' }, provider);
  const to = (name) => sent.filter(([n, m]) => n === name && m.type === 'navigate-to-route').map(([, m]) => m.path);

  const NEW = '/extension/panel/new';
  const begun = open('begun', uri(NEW, 'new-1'), null, NEW);
  ask(begun, 'b1', 'prewarm');
  answer(begun, 'b1', BEGUN);
  turn(BEGUN, 'tb');
  await breaks(begun);
  eq([/Codex Plus loaded this page again/.test(begun.webview.html), to('begun')], [true, []],
    'a New tab whose page broke just after its first message started a turn gets a new page, sent nowhere before it is up');
  up(begun);
  eq(to('begun'), [`/local/${BEGUN}`], 'once up, the new page is sent to the conversation the page before it had begun');
  up(begun);
  eq(to('begun').length, 1, 'and only once');

  const warm = open('prewarmed', uri(NEW, 'new-2'), null, NEW);
  ask(warm, 'w1', 'prewarm');
  answer(warm, 'w1', PREWARMED);
  await breaks(warm);
  up(warm);
  eq(to('prewarmed'), [], 'a thread Codex made ahead of any message, with no turn, is not followed: the new page stays a new conversation page');

  const late = open('late', uri(NEW, 'new-3'), null, NEW);
  ask(late, 'l1');
  await breaks(late);
  up(late);
  answer(late, 'l1', LATE);
  eq(to('late'), [], 'a start the page sent before it broke is answered after the new page is up, before its first turn: nothing yet');
  turn(LATE, 'tl');
  eq(to('late'), [`/local/${LATE}`], 'and when that conversation\'s first turn starts, the new page is sent to it');

  const named = open('named', uri(`/local/${NAMED}`), NAMED, `/local/${NAMED}`);
  await breaks(named);
  up(named);
  eq(to('named'), [], 'a tab showing the conversation its URI names gets a new page on that conversation already, and is sent nowhere');

  const own = open('own', uri(NEW, 'new-4'), null, NEW);
  ask(own, 'o1');
  await breaks(own);
  up(own);
  ask(own, 'o2');
  answer(own, 'o1', LEFT);
  turn(LEFT, 'to1');
  answer(own, 'o2', OWN);
  turn(OWN, 'to2');
  eq(to('own'), [], 'once the new page begins a conversation of its own, the one the page before it began is not followed');
  eq(logged.filter((l) => /sent the page loaded again/.test(l)).length, 2, 'each page sent to a conversation says so in the log');
  for (const d of context.subscriptions) { try { d.dispose(); } catch (_) { /* gone */ } }
};
