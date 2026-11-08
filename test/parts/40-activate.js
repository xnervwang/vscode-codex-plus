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

async function run(root, tmp, { core = 'accept', trusted = true } = {}) {
  const { vscode, control } = fake.create();
  vscode.workspace.isTrusted = trusted;
  vscode.workspace.onDidGrantWorkspaceTrust = () => ({ dispose() {} });
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  control.state.config = { codexHome: home, installWorkPlanPlugin: 'never', reopenDroppedTabs: false, patchCodex: 'off' };
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

module.exports = async ({ ok, bad, eq, tmp, root }) => {
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
    'a refused registration hides the session list; Agent Work Plan, not this extension, says which one to update');

  const bare = await run(root, tmp, { core: 'bare' });
  eq([bare.state.context['codexExtras.registered'], bare.state.said.map((s) => /Agent Work Plan has no agentWorkPlan interface/.test(s.message))],
    [false, [true]], 'with no interface to register with, it says so once');

  const restricted = await run(root, tmp, { trusted: false });
  if (restricted.registered.length === 1 && !restricted.wroteSettings) ok('in Restricted Mode it still registers, and writes nothing');
  else bad(`restricted: ${JSON.stringify([restricted.registered.length, restricted.wroteSettings])}`);
};
