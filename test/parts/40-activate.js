// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * activate() itself, against a stand-in VS Code: alone it draws the shared views and the status bar; with
 * claude-code-extras' workPlanHost of version 2 it registers the Codex source and draws none of them. Every command the
 * manifest names is registered.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

async function run(root, tmp, withHost) {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  control.state.config = { codexHome: home, installWorkPlanPlugin: 'never', reopenDroppedTabs: false };
  const registered = [];
  if (withHost) {
    control.state.extensions.set('xnervwang.claude-code-extras', { isActive: true,
      exports: { workPlanHost: { version: 3, majors: [3], features: [], registerSource: (s) => { registered.push(s); return { dispose() {} }; } } } });
  }
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  const context = { subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento(),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root };
  await ext.activate(context);
  await new Promise((r) => setTimeout(r, 50));
  const out = { state: control.state, registered };
  for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
  ext.deactivate();
  return out;
}

module.exports = async ({ ok, bad, eq, tmp, root }) => {
  const alone = await run(root, tmp, false);
  eq(alone.state.context['codexExtras.standalone'], true, 'alone, it marks itself as drawing the shared views');
  const shared = ['codexExtras.workPlan', 'codexExtras.conversations', 'codexExtras.answer'];
  eq(shared.map((v) => alone.state.views.includes(v)), [true, true, true], 'and draws the work plan, Conversations and Answer views');
  if (alone.state.status.some((s) => /Conversations|to decide/.test(s.text))) ok('with its status bar entry');
  else bad('no status bar entry while standalone');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = pkg.contributes.commands.map((c) => c.command);
  const missing = declared.filter((c) => !alone.state.registered.includes(c));
  eq(missing, [], 'every command in the manifest is registered');

  const hosted = await run(root, tmp, true);
  eq([hosted.registered.length, hosted.registered[0] && hosted.registered[0].id], [1, 'codex'], 'with a host, the Codex source is registered with it');
  eq([hosted.state.context['codexExtras.standalone'], hosted.state.context['codexExtras.hosted']], [false, true],
    'and the standalone key is false, the hosted key true');
  eq(shared.filter((v) => hosted.state.views.includes(v)), [], 'and none of the shared views is drawn here');
  eq(hosted.state.status.filter((s) => s.shown).length, 0, 'and no status bar entry is made');
  if (hosted.state.views.includes('codexExtras.sessionsHosted')) ok('the Codex session list is registered for the host\'s container too');
  else bad('the hosted session list view has no provider');
  eq(alone.state.context['codexExtras.hosted'], false, 'alone, the hosted key is false');
};
