// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Panels Codex built before this extension's hooks existed. A Codex tab restored at a reload activates Codex on its
 * custom editor (onCustomEditor:chatgpt.conversationEditor), ahead of this extension's onStartupFinished, so Codex
 * resolves that tab while the call it makes into this extension finds nothing to call. The panel is still in Codex's
 * own map, editorPanels, and installing the hooks takes it from there.
 *
 * The provider is shaped as Codex's: editorPanels maps a panel to { ready, pendingMessages, initialRoute }, the route of
 * a conversation tab being /local/<id> and that of a New tab /extension/panel/new (resolveCustomEditor), and the class
 * carries the view type of the panels that are not custom editors (panelViewType). The view types are read from the
 * installed Codex when there is one.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('../fake-vscode');

const ID = '01a1abab-0000-7000-8000-0000000000a1';
const OTHER = '01a1cdcd-0000-7000-8000-0000000000a2';

function codexViewTypes() {
  const fallback = { editor: 'chatgpt.conversationEditor', panel: 'chatgpt.panelView' };
  for (const root of [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const n of names.filter((x) => /^openai\.chatgpt-/.test(x)).sort()) {
      try {
        const dir = path.join(root, n);
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const file = path.join(dir, 'out', 'extension.js');
        const src = fs.readFileSync(fs.existsSync(file + '.codex-extras-host.bak') ? file + '.codex-extras-host.bak' : file, 'utf8');
        const pv = /panelViewType="([^"]+)"/.exec(src);
        const ed = ((pkg.contributes || {}).customEditors || [])[0];
        if (pv && ed) return { editor: ed.viewType, panel: pv[1], from: n };
      } catch (_) { /* next */ }
    }
  }
  return fallback;
}

module.exports = async ({ eq, note }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  const patching = require('../../src/patching');
  const types = codexViewTypes();
  if (!types.from) note('no Codex extension installed here: its two view types are taken as they were in 26.1021');

  class Provider {
    constructor() { this.editorPanels = new Map(); }
    sendMessageToPanel() {}
    postMessageToWebview() {}
    navigateToRoute() {}
  }
  Provider.panelViewType = types.panel;
  const provider = new Provider();
  const panelOf = (name, viewType) => ({ name, viewType, webview: { name }, visible: false, active: false, iconPath: null,
    reveal() {}, onDidDispose(fn) { this.dispose = fn; } });
  const tab = panelOf('restored conversation tab', types.editor);
  const blank = panelOf('restored New tab', types.editor);
  const plain = panelOf('a panel Codex made itself', types.panel);
  provider.editorPanels.set(tab, { ready: false, pendingMessages: [], initialRoute: `/local/${ID}` });
  provider.editorPanels.set(blank, { ready: false, pendingMessages: [], initialRoute: '/extension/panel/new' });
  provider.editorPanels.set(plain, { ready: false, pendingMessages: [], initialRoute: `/local/${OTHER}` });

  /* Codex constructed its provider and resolved the three panels; this extension's hooks are installed afterwards. */
  globalThis.__codexExtrasProvider = provider;
  try {
    patching.installHooks();
    const rec = (p) => { const r = patching._registry.get(p); return r ? [r.thread, r.opened, r.route] : null; };
    eq(rec(tab), [ID, ID, `/local/${ID}`],
      'a conversation tab Codex resolved before the hooks existed is taken from Codex\'s own panels, with the conversation its route names');
    eq(patching.canDeliver(ID), true, 'so it can take an answer, as a tab opened after start-up can');
    eq(rec(blank), ['', '', '/extension/panel/new'], 'a restored New tab is kept with no conversation, as the live hook keeps one');
    eq(rec(plain), ['', '', `/local/${OTHER}`],
      'and a panel that is not one of Codex\'s custom editors names no conversation, as the live hook hands it over');
    const size = patching._registry.size;
    patching.installHooks();
    globalThis.__codexExtrasPanel(tab, ID, provider, `/local/${ID}`);
    eq(patching._registry.size, size, 'installing the hooks again, or Codex handing the same panel over, adds nothing');
    tab.dispose();
    eq([patching._registry.has(tab), patching.canDeliver(ID)], [false, false], 'and closing such a tab forgets it like any other');
  } finally {
    for (const p of [tab, blank, plain]) { if (patching._registry.has(p) && p.dispose) p.dispose(); }
    delete globalThis.__codexExtrasProvider;
  }
};
