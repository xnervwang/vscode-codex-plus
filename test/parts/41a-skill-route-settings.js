// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * writeHookSettings writes the skill search's settings into the plugin's config.json under CODEX_HOME, as it does the
 * work plan's, under the keys codex-plugin/agent-work-plan/hooks/plan_path.py reads. With nothing set, the extension
 * must write the plugin's own defaults, or the plugin would act differently with and without this extension.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const KEYS = {
  skillRouting: 'skillRoute', skillRoutingVectorSearch: 'skillRouteVector', skillRoutingCount: 'skillRouteCount',
  skillRoutingExtraFolders: 'skillRouteExtraDirs', skillRoutingClaudePlugins: 'skillRouteClaudePlugins',
};

module.exports = async ({ eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const props = Object.assign({}, ...[].concat(pkg.contributes.configuration).map((c) => c.properties || {}));
  const planPath = ['plan_path.py', 'plan_common.py', 'plan_agent.py']
    .map((f) => fs.readFileSync(path.join(root, 'codex-plugin', 'agent-work-plan', 'hooks', f), 'utf8')).join('\n');
  const pyDefault = (key) => {
    const m = new RegExp(`^\\s*"${key}": (.*),$`, 'm').exec(planPath);
    return m ? JSON.parse(m[1].replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false')) : undefined;
  };
  eq(Object.keys(KEYS).map((k) => props[`codexPlus.${k}`] && props[`codexPlus.${k}`].default),
    Object.values(KEYS).map(pyDefault), 'each skill search setting has the default the plugin uses when nothing is written');
  eq(props['codexPlus.skillRoutingVectorSearch'] && props['codexPlus.skillRoutingVectorSearch'].default, false,
    'the search by meaning is off unless the user turns it on');
  eq(/Amazon Bedrock/.test((props['codexPlus.skillRoutingVectorSearch'] || {}).markdownDescription || ''), true,
    'and its description says it is used only with Amazon Bedrock');

  const run = async (config) => {
    const { vscode, control } = fake.create();
    fake.install(vscode);
    for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
    const home = tmp('home');
    fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
    process.env.CODEX_HOME = home;
    control.state.config = Object.assign({ reopenDroppedTabs: false }, config);
    const ext = require(path.join(root, 'extension.js'));
    const install = require(path.join(root, 'src', 'plugin-install.js'));
    const subs = [];
    await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
      globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
    try {
      const got = JSON.parse(fs.readFileSync(path.join(install.planDir(home), 'config.json'), 'utf8'));
      return Object.values(KEYS).map((k) => got[k]);
    } finally {
      for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
      ext.deactivate();
    }
  };
  eq(await run({}), Object.values(KEYS).map(pyDefault), 'with nothing set, the hooks are given the defaults');
  eq(await run({ skillRouting: false, skillRoutingVectorSearch: true, skillRoutingCount: 8, skillRoutingExtraFolders: ['/a'],
    skillRoutingClaudePlugins: ['*'] }), [false, true, 8, ['/a'], ['*']], 'and what the user sets is handed on as it is');
};
