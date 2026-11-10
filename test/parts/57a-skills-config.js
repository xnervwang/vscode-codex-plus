// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Two settings that change how Codex lists skills, written into Codex's own config.toml through its app-server
 * (src/skills-config.js): codexPlus.skillsListBudget is skills.max_context_tokens, the tokens Codex may spend on its list
 * of skills each turn, and codexPlus.disabledSkills is a [[skills.config]] entry turning a skill off. Both are left
 * alone by default, and each change undoes only what this extension wrote: a value the user put in config.toml by hand
 * is never touched. The requests are the ones an offline app-server of Codex 26.1021.22027 took: a null value written
 * with mergeStrategy replace removes the key, and enabled: true removes the entry enabled: false had added.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const props = pkg.contributes.configuration.properties;
  eq([props['codexPlus.skillsListBudget'] && props['codexPlus.skillsListBudget'].default,
    props['codexPlus.skillsListBudget'] && props['codexPlus.skillsListBudget'].maximum,
    props['codexPlus.disabledSkills'] && props['codexPlus.disabledSkills'].default], [0, 10000, []],
  'the list budget defaults to Codex\'s own (0) and goes up to the 10,000 Codex takes; no skill is turned off by default');

  const { applySkillSettings, APPLIED_KEY } = require(path.join(root, 'src', 'skills-config.js'));
  const memento = fake.memento();
  const sent = [];
  let refuse = null;
  const ask = async (method, params) => {
    sent.push([method, params]);
    if (refuse && refuse(method, params)) return { outcome: 'failed', reason: 'no' };
    return { outcome: 'done', result: {} };
  };
  const apply = async (maxTokens, disabled) => { sent.length = 0; await applySkillSettings({ ask, memento, maxTokens, disabled }); return sent.slice(); };

  eq(await apply(0, []), [], 'with both settings at their defaults, nothing is asked');
  eq(await apply(10000, []), [['config/value/write', { keyPath: 'skills.max_context_tokens', value: 10000, mergeStrategy: 'upsert' }]],
    'a budget set here is written to skills.max_context_tokens');
  eq(await apply(10000, []), [], 'and not again while it is unchanged');
  eq(await apply(0, []), [['config/value/write', { keyPath: 'skills.max_context_tokens', value: null, mergeStrategy: 'replace' }]],
    'set back to 0, the value this extension wrote is taken out again');
  eq(await apply(0, []), [], 'and with nothing of its own written, a value the user set by hand is left alone');
  eq(await apply(0, ['Plug-all:alpha', ' Plug-all:beta ', '', 'Plug-all:alpha']),
    [['skills/config/write', { name: 'Plug-all:alpha', enabled: false }], ['skills/config/write', { name: 'Plug-all:beta', enabled: false }]],
    'each skill named is turned off once, by its full name');
  eq(await apply(0, ['Plug-all:beta']), [['skills/config/write', { name: 'Plug-all:alpha', enabled: true }]],
    'a name taken off the list has its entry removed, the others are left');
  refuse = (m, p) => p.name === 'Plug-all:gamma';
  await apply(0, ['Plug-all:beta', 'Plug-all:gamma']);
  refuse = null;
  eq(await apply(0, ['Plug-all:beta', 'Plug-all:gamma']), [['skills/config/write', { name: 'Plug-all:gamma', enabled: false }]],
    'one Codex refused is tried again next time');
  eq(memento.get(APPLIED_KEY), { maxTokens: 0, disabled: ['Plug-all:beta', 'Plug-all:gamma'] }, 'what was written is remembered');
  eq(await apply(99999, []).then((r) => r.filter((x) => x[0] === 'config/value/write')),
    [['config/value/write', { keyPath: 'skills.max_context_tokens', value: 10000, mergeStrategy: 'upsert' }]], 'a budget over 10,000 is written as 10,000');

  /* In the extension: a change of either setting is written on Codex's own connection. */
  const { vscode, control } = fake.create();
  let changed = null;
  vscode.workspace.onDidChangeConfiguration = (fn) => { changed = fn; return { dispose() {} }; };
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  const requests = [];
  let handler = null;
  const conn = {
    registerProvider(name, h) { handler = Object.assign({ name }, h); return { dispose() { handler = null; } }; },
    sendRequest(name, id, method, params) { requests.push([method, params]); setTimeout(() => handler && handler.onResult({ id, result: {} }), 1); },
  };
  globalThis.__codexExtrasMessage({}, { kind: 'none' }, { codexMcpConnection: conn, postMessageToWebview() {}, sendMessageToPanel() {} });
  try {
    control.state.config = { reopenDroppedTabs: false, skillsListBudget: 8000, disabledSkills: ['Plug-all:x'] };
    changed({ affectsConfiguration: (k) => k === 'codexPlus' || k === 'codexPlus.skillsListBudget' || k === 'codexPlus.disabledSkills' });
    await tick(100);
    eq(requests.filter((r) => /config/.test(r[0])), [['config/value/write', { keyPath: 'skills.max_context_tokens', value: 8000, mergeStrategy: 'upsert' }],
      ['skills/config/write', { name: 'Plug-all:x', enabled: false }]], 'changing the settings writes them into Codex\'s config');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
