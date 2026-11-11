// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const KEY = 'codexPlus.ownsTabBarButton';
const FROM_TAB_BAR = [{ scheme: 'file', path: '/w/a.ts', fsPath: '/w/a.ts' }, { groupId: 1 }];
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/* Codex's manifest as installed here, else the parts of it the tab bar reads. */
function codexManifest() {
  for (const root of [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const n of names.filter((x) => /^openai\.chatgpt-/.test(x))) {
      const file = path.join(root, n, 'package.json');
      for (const f of [file + '.codex-extras-manifest.bak', file]) { try { return fs.readFileSync(f, 'utf8'); } catch (_) { /* next */ } }
    }
  }
  return JSON.stringify({ name: 'chatgpt', publisher: 'openai', version: '26.1021.22027', contributes: {
    commands: [{ command: 'chatgpt.openSidebar', title: 'Open Codex Sidebar' }],
    menus: { 'editor/title': [{ command: 'chatgpt.openSidebar', group: 'navigation' }] } } }, null, '\t');
}

const holds = (when, ctx) => !when || when.split('&&').map((p) => p.trim()).every((p) => {
  const m = /^([\w.]+) (==|!=) '([^']*)'$/.exec(p);
  if (m) return (String(ctx[m[1]] === undefined ? '' : ctx[m[1]]) === m[3]) === (m[2] === '==');
  return p.startsWith('!') ? !ctx[p.slice(1)] : !!ctx[p];
});

async function activated(root, tmp, { loaded, config }) {
  const { vscode, control } = fake.create();
  vscode.workspace.isTrusted = true;
  vscode.workspace.onDidGrantWorkspaceTrust = () => ({ dispose() {} });
  const changed = [];
  vscode.workspace.onDidChangeConfiguration = (fn) => { changed.push(fn); return { dispose() {} }; };
  fake.install(vscode);
  control.state.openWith = (u, viewType) => control.setTabs([{ label: 'Codex', input: new vscode.TabInputCustom(u, viewType) }], 0);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false, ...config };
  control.state.extensions.set('openai.chatgpt', { id: 'openai.chatgpt', isActive: true, extensionPath: tmp('codex'), packageJSON: loaded });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  await tick(300);
  return {
    vscode, control,
    configChanged: (key) => { for (const fn of changed) fn({ affectsConfiguration: (k) => k === 'codexPlus' || k === key }); },
    close() { for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } } ext.deactivate(); },
  };
}

module.exports = async ({ eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  let manifest = null;
  try { manifest = require('../../src/manifest'); } catch (_) { /* checked below */ }
  const original = codexManifest();
  const patched = manifest ? manifest.patchSource(original).out : '';
  eq(!!patched, true, 'Codex\'s manifest can be given the change, so a VS Code that loaded it can be stood in for');

  /* ── this extension's side of the tab bar ── */
  const ours = (pkg.contributes.menus['editor/title'] || []);
  const cmd = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
  const icon = { light: 'images/codex-light.svg', dark: 'images/codex-dark.svg' };
  eq([ours.map((m) => [m.command, cmd.get(m.command) && cmd.get(m.command).title, cmd.get(m.command) && JSON.stringify(cmd.get(m.command).icon) === JSON.stringify(icon)]),
    ['codexPlus.tabBarNewInTab', 'codexPlus.tabBarOpenSidebar'].filter((c) => !(pkg.contributes.menus.commandPalette || []).some((m) => m.command === c && m.when === 'false'))],
  [[['codexPlus.tabBarNewInTab', 'Codex Plus: New Codex Conversation in a Tab', true], ['codexPlus.tabBarOpenSidebar', 'Codex Plus: Open Codex Sidebar', true]], []],
  'this extension\'s tab bar has two items with Codex\'s icon, titled for what each opens, and neither is in the command palette');

  /* ── the button VS Code shows, its hover and what it does ── */
  const cell = async (state, tabBarButton) => {
    const loaded = JSON.parse(state === 'unpatched' ? original : patched);
    const config = { tabBarButton, ...(state === 'off' ? { enabled: false } : {}) };
    const w = await activated(root, tmp, { loaded, config });
    try {
      const ctx = { [KEY]: w.control.state.context[KEY], 'config.codexPlus.tabBarButton': tabBarButton,
        'config.codexPlus.enabled': state !== 'off' };
      const titles = new Map((loaded.contributes.commands || []).map((c) => [c.command, c.title]));
      const shown = [
        ...(loaded.contributes.menus['editor/title'] || []).filter((m) => holds(m.when, ctx)).map((m) => ({ codex: true, title: titles.get(m.command) })),
        ...ours.filter((m) => holds(m.when, ctx)).map((m) => ({ codex: false, command: m.command, title: cmd.get(m.command).title })),
      ];
      let does = '';
      if (shown.length === 1) {
        const before = w.control.state.commands.length;
        if (shown[0].codex) {
          const took = !!(globalThis.__codexExtrasTabBar && globalThis.__codexExtrasTabBar(FROM_TAB_BAR));
          await tick(50);
          does = took ? (w.control.state.commands.slice(before).some((c) => c[0] === 'vscode.openWith') ? 'tab' : 'nothing') : 'sidebar';
        } else {
          await w.control.state.handlers[shown[0].command]();
          await tick(50);
          const ran = w.control.state.commands.slice(before).map((c) => c[0]);
          does = ran.includes('vscode.openWith') ? 'tab' : ran.includes('chatgpt.openSidebar') ? 'sidebar' : 'nothing';
        }
      }
      return [state, tabBarButton, w.control.state.context[KEY] === true, shown.length, shown.map((s) => `${s.codex ? 'Codex' : 'ours'}: ${s.title}`).join(), does];
    } finally { w.close(); }
  };
  const cells = [];
  for (const state of ['patched', 'unpatched', 'off']) for (const setting of ['tab', 'sidebar']) cells.push(await cell(state, setting));
  eq(cells, [
    ['patched', 'tab', true, 1, 'ours: Codex Plus: New Codex Conversation in a Tab', 'tab'],
    ['patched', 'sidebar', true, 1, 'ours: Codex Plus: Open Codex Sidebar', 'sidebar'],
    ['unpatched', 'tab', false, 1, 'Codex: Open Codex Sidebar', 'tab'],
    ['unpatched', 'sidebar', false, 1, 'Codex: Open Codex Sidebar', 'sidebar'],
    ['off', 'tab', false, 1, 'Codex: Open Codex Sidebar', 'sidebar'],
    ['off', 'sidebar', false, 1, 'Codex: Open Codex Sidebar', 'sidebar'],
  ], 'with the loaded Codex manifest carrying the change, without it, and with the additions off, under either setting: one Codex button, '
    + 'this extension\'s only when the loaded manifest carries the change, its hover saying what it opens; without the change Codex\'s own '
    + 'button keeps its title and, set to tab, opens a tab through the host patch until the reload that loads the change');

  /* ── the key follows the master switch and the loaded manifest while the window runs ── */
  const w = await activated(root, tmp, { loaded: JSON.parse(patched || original), config: {} });
  try {
    const seen = [w.control.state.context[KEY]];
    w.control.state.config.enabled = false;
    w.configChanged('codexPlus.enabled');
    seen.push(w.control.state.context[KEY]);
    w.control.state.config.enabled = true;
    w.configChanged('codexPlus.enabled');
    seen.push(w.control.state.context[KEY]);
    w.control.state.extensions.set('openai.chatgpt', { id: 'openai.chatgpt', isActive: true, extensionPath: tmp('codex2'), packageJSON: JSON.parse(original) });
    w.control.fireExtensions();
    seen.push(w.control.state.context[KEY]);
    w.control.state.extensions.delete('openai.chatgpt');
    w.control.fireExtensions();
    seen.push(w.control.state.context[KEY]);
    eq(seen, [true, false, true, false, false],
      'the key goes with the master switch, and with a Codex whose loaded manifest lacks the change, or no Codex at all, it is off');
    eq(w.control.state.commands.some((c) => c[0] === 'setContext' && c[1] === 'codexPlus.tabBarHooked'), false,
      'and nothing sets codexPlus.tabBarHooked, which no menu reads');
  } finally { w.close(); }
};
