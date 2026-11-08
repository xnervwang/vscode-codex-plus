// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * activate() itself, against a stand-in VS Code and a stand-in Agent Work Plan: the Codex source is registered with it,
 * the session list shows only once that registration was accepted, every command the manifest names is registered, and
 * Restricted Mode writes nothing.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

async function run(root, tmp, { core = 'accept', trusted = true, config = {}, takesRoute = false } = {}) {
  const { vscode, control } = fake.create();
  vscode.workspace.isTrusted = trusted;
  vscode.workspace.onDidGrantWorkspaceTrust = () => ({ dispose() {} });
  fake.install(vscode);
  // Codex answers the new-conversation route by leaving a conversation tab in front; the stand-in does it on request.
  if (takesRoute) control.state.openWith = (u, viewType) => control.setTabs([{ label: 'Codex', input: new vscode.TabInputCustom(u, viewType) }], 0);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  control.state.config = { codexHome: home, installWorkPlanPlugin: 'never', reopenDroppedTabs: false, patchCodex: 'off', ...config };
  const registered = [];
  if (core) {
    const registerSource = (s) => {
      registered.push(s);
      return core === 'accept' ? { accepted: true, code: '', reason: '', registration: { dispose() {} } }
        : { accepted: false, code: 'core-too-old', reason: 'protocol 1 is not one this host accepts (2)', registration: null };
    };
    control.state.extensions.set('xnervwang.agent-work-plan', { isActive: true, exports: core === 'bare' ? {} : { agentWorkPlan: { protocol: 1, accepts: [1], features: [], registerSource } } });
  }
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  const globalState = fake.memento();
  const context = { subscriptions: subs, workspaceState: fake.memento(), globalState, globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root };
  await ext.activate(context);
  await new Promise((r) => setTimeout(r, 300));
  const out = { state: control.state, registered, home, wroteSettings: fs.existsSync(path.join(home, 'plugins', 'data', 'agent-work-plan-codex-extras', 'config.json')) };
  for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
  ext.deactivate();
  return out;
}

module.exports = async ({ ok, bad, note, eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = pkg.contributes.commands.map((c) => c.command);

  const hosted = await run(root, tmp);
  eq([hosted.registered.length, hosted.registered[0] && hosted.registered[0].id, hosted.registered[0] && hosted.registered[0].protocol],
    [1, 'codex', 1], 'the Codex source is registered with Agent Work Plan, at protocol 1');
  eq(hosted.state.context['codexExtras.registered'], true, 'an accepted registration shows the session list');
  eq(hosted.state.views, ['codexExtras.sessions'], 'the session list is the only view this extension provides');
  eq(hosted.state.status.filter((s) => s.shown).length, 0, 'and it makes no status bar entry');
  eq(declared.filter((c) => !hosted.state.registered.includes(c)), [], 'every command in the manifest is registered');
  eq(hosted.wroteSettings, true, 'in a trusted window the hooks\' settings are written');
  eq(hosted.state.said.length, 0, 'nothing is said when it is taken');

  const refused = await run(root, tmp, { core: 'refuse' });
  eq([refused.state.context['codexExtras.registered'], refused.state.said.length], [false, 0],
    'a refused registration leaves the key off, and Agent Work Plan, not this extension, says which one to update');

  const bare = await run(root, tmp, { core: 'bare' });
  eq([bare.state.context['codexExtras.registered'], bare.state.said.map((s) => /Agent Work Plan has no agentWorkPlan interface/.test(s.message))],
    [false, [true]], 'with no interface to register with, it says so once');

  const restricted = await run(root, tmp, { trusted: false });
  if (restricted.registered.length === 1 && !restricted.wroteSettings) ok('in Restricted Mode it still registers, and writes nothing');
  else bad(`restricted: ${JSON.stringify([restricted.registered.length, restricted.wroteSettings])}`);

  /* ── the session list's own title bar: what a reader sees on it, and what is a click further away ── */
  const title = (pkg.contributes.menus['view/title'] || []).filter((m) => /codexExtras\.sessions/.test(m.when || ''));
  const onBar = title.filter((m) => /^navigation/.test(m.group || ''));
  const byCommand = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
  eq(onBar.length <= 4, true, `at most four buttons sit on the title bar, the rest in its ... menu (there are ${onBar.length})`);
  eq(onBar.sort((a, b) => a.group.localeCompare(b.group)).map((m) => m.command),
    ['codexExtras.newInTab', 'codexExtras.newInSidebar', 'codexExtras.findThread', 'codexExtras.refreshSessions'],
    'the two for opening a conversation come first, then search and refresh');
  eq(onBar.filter((m) => !byCommand.get(m.command) || !byCommand.get(m.command).icon).map((m) => m.command), [],
    'each of them has an icon, or it would show as a word on the bar');
  eq(title.filter((m) => !/^navigation/.test(m.group || '')).map((m) => m.command),
    ['codexExtras.showAllFolders', 'codexExtras.openSettings'], 'the ... menu holds the two that are not everyday actions');
  const menus = [].concat(...Object.values(pkg.contributes.menus)).map((m) => m.command);
  eq(menus.filter((c) => !byCommand.has(c)), [], 'every command a menu names is declared');

  /*
   * The tab bar's button starts a conversation and never raises one that is open: before this it opened the one last in
   * front, which with a single Codex tab already in front only moved the focus and looked like nothing happened. In a
   * tab it opens Codex's new-conversation route itself, naming the group in front, because Codex's own command asks for
   * the group of the text file last focused and so can put the conversation in a split.
   */
  {
    const w = await run(root, tmp, { config: { openButtonTarget: 'tab' }, takesRoute: true });
    const before = w.state.commands.length;
    await w.state.handlers['codexExtras.openCodex']();
    const ran = w.state.commands.slice(before);
    const [cmd, uri, viewType, options] = ran[0] || [];
    eq([ran.length, cmd, uri && uri.path, viewType, options && options.viewColumn, options && options.preview],
      [1, 'vscode.openWith', '/extension/panel/new', 'chatgpt.conversationEditor', 1, false],
      'in a tab it opens the new-conversation route itself, in the first editor group, and asks Codex for nothing more');
  }
  {
    // A split's narrow half is the group in front when its title bar button is pressed, so the group is a setting.
    const w = await run(root, tmp, { config: { openButtonTarget: 'tab', newConversationGroup: 'active' }, takesRoute: true });
    const before = w.state.commands.length;
    await w.state.handlers['codexExtras.openCodex']();
    const options = (w.state.commands.slice(before)[0] || [])[3];
    eq(options && options.viewColumn, -1, 'set to the group in front, it names that group instead of the first');
  }
  {
    const w = await run(root, tmp, { config: { openButtonTarget: 'tab' } });
    const before = w.state.commands.length;
    await w.state.handlers['codexExtras.openCodex']();
    eq(w.state.commands.slice(before).map((c) => c[0]), ['vscode.openWith', 'chatgpt.newCodexPanel'],
      'when the route leaves no conversation tab, Codex\'s own command is asked instead');
  }
  {
    const w = await run(root, tmp, { config: { openButtonTarget: 'sidebar' } });
    const before = w.state.commands.length;
    await w.state.handlers['codexExtras.openCodex']();
    eq(w.state.commands.slice(before).map((c) => c[0]), ['chatgpt.openSidebar'],
      'set to the sidebar it opens Codex\'s sidebar and no tab');
  }

  /* The Codex commands this extension runs, against the Codex installed here: New in sidebar needs no patch, since
     Codex contributes both commands it uses. */
  const ours = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const called = [...new Set((ours.match(/'chatgpt\.[A-Za-z]+'/g) || []).map((s) => s.slice(1, -1)))].sort();
  eq(called, ['chatgpt.newChat', 'chatgpt.newCodexPanel', 'chatgpt.openSidebar'], 'it runs three commands of Codex\'s own');
  const dirs = [];
  for (const base of [path.join(require('os').homedir(), '.vscode-server', 'extensions'), path.join(require('os').homedir(), '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(base); } catch (_) { continue; }
    for (const n of names) if (/^openai\.chatgpt-/.test(n)) dirs.push(path.join(base, n));
  }
  if (!dirs.length) note('no Codex extension installed here: the commands it contributes were not checked');
  for (const dir of dirs) {
    let codex;
    try { codex = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (_) { continue; }
    const has = new Set((codex.contributes.commands || []).map((c) => c.command));
    eq(called.filter((c) => !has.has(c)), [], `${path.basename(dir)} contributes all three`);
  }
};
