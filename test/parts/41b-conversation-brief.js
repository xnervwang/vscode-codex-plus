// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * codexPlus.conversationBrief: written to the hooks' config.json as `brief`, and reported to Agent Plus as the source's
 * 'brief' feature. Changing the setting tells Agent Plus to list the conversations again.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

async function run(root, tmp, config, change) {
  const { vscode, control } = fake.create();
  const heard = [];
  vscode.workspace.onDidChangeConfiguration = (fn) => { heard.push(fn); return { dispose() {} }; };
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = Object.assign({ reopenDroppedTabs: false }, config);
  const registered = [];
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: (s) => { registered.push(s); return { accepted: true, code: '', reason: '', registration: { dispose() {} } }; } } } });
  const ext = require(path.join(root, 'extension.js'));
  const install = require(path.join(root, 'src', 'plugin-install.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  const settings = () => { try { return JSON.parse(fs.readFileSync(path.join(install.planDir(home), 'config.json'), 'utf8')); } catch (_) { return {}; } };
  const source = registered[0];
  const out = { brief: settings().brief, features: source && source.features };
  if (change && source) {
    let fired = 0;
    source.onDidChangeConversations(() => { fired++; });
    Object.assign(control.state.config, change);
    for (const fn of heard) fn({ affectsConfiguration: (k) => Object.keys(change).some((c) => k === 'codexPlus' || k === `codexPlus.${c}`) });
    out.after = { brief: settings().brief, features: source.features, fired };
  }
  for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
  ext.deactivate();
  return out;
}

module.exports = async ({ eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const props = Object.assign({}, ...[].concat(pkg.contributes.configuration).map((c) => c.properties || {}));
  const setting = props['codexPlus.conversationBrief'] || {};
  const common = fs.readFileSync(path.join(root, 'codex-plugin', 'agent-work-plan', 'hooks', 'plan_common.py'), 'utf8');
  eq([setting.type, setting.default, setting.scope, /"brief": True,/.test(common), /brief/.test(setting.markdownDescription || '')
    && /Conversations/.test(setting.markdownDescription || '')],
  ['boolean', true, 'application', true, true],
  'codexPlus.conversationBrief is a machine-wide flag, on by default as the plugin is, saying what it asks for and what a click shows');

  const on = await run(root, tmp, {});
  const off = await run(root, tmp, { conversationBrief: false, 'agentPlus.tokenMode': 'custom' });
  const noPlans = await run(root, tmp, { workPlan: false, 'agentPlus.tokenMode': 'custom' });
  eq([on.brief, on.features, off.brief, off.features, noPlans.features], [true, ['brief'], false, [], []],
    'in the Custom token mode, the hooks are given the setting as `brief`, and the source lists the brief while it is on and plans are kept');

  /* The sweep (src/workplan.js) deletes side files by suffix, so a new suffix has to be added there too. */
  const hooks = path.join(root, 'codex-plugin', 'agent-work-plan', 'hooks');
  const python = ['plan_common.py', 'plan_agent.py'].map((f) => fs.readFileSync(path.join(hooks, f), 'utf8')).join('\n');
  const suffixes = [...python.matchAll(/^\w+_SUFFIX = "(\.\w+)"/gm)].map((m) => m[1]).filter((x) => x !== '.lock');
  const { SIDE_SUFFIXES } = require(path.join(root, 'src', 'workplan.js'));
  eq([suffixes.includes('.compacted') && suffixes.includes('.briefed'), suffixes.filter((x) => !SIDE_SUFFIXES.includes(x))], [true, []],
    'every file the hooks keep beside a plan, the brief\'s two included, is one the sweep removes with its conversation');

  const custom = { 'agentPlus.tokenMode': 'custom' };
  const turned = await run(root, tmp, custom, { conversationBrief: false });
  const back = await run(root, tmp, { conversationBrief: false, ...custom }, { conversationBrief: true });
  eq([turned.after, back.after], [{ brief: false, features: [], fired: 1 }, { brief: true, features: ['brief'], fired: 1 }],
    'changing the setting rewrites config.json, changes the features and tells Agent Plus the conversations changed');
};
