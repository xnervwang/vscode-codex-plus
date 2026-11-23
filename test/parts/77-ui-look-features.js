// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The feature list of the look run (test/vscode/ui-look-features.json) against the scenes of test/vscode/ui-look.js and
 * this extension's package.json.
 *
 * The step names are taken from the look('<name>', ...) calls in the source, since loading ui-look.js needs Playwright,
 * and a feature's `checks` from the step('<name>', ...) calls of ui.js, the window test that CI runs.
 */
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, note, root }) => {
  const list = require(path.join(root, 'test', 'vscode', 'lib', 'feature-list')).load();
  const { features } = list;
  const source = fs.readFileSync(path.join(root, 'test', 'vscode', 'ui-look.js'), 'utf8');
  const steps = new Set([...source.matchAll(/\blook\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const commands = pkg.contributes.commands.map((c) => c.command);
  const settings = (Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration])
    .flatMap((s) => Object.keys(s.properties));

  const windowTest = fs.readFileSync(path.join(root, 'test', 'vscode', 'ui.js'), 'utf8');
  const checked = new Set([...windowTest.matchAll(/\bstep\(\s*'((?:[^'\\]|\\.)+)'/g)].map((m) => m[1].replace(/\\'/g, "'")));
  eq(features.filter((f) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.id) || typeof f.what !== 'string' || !f.what
    || !['steps', 'settings', 'commands'].every((k) => Array.isArray(f[k])) || (f.checks !== undefined && !Array.isArray(f.checks))).map((f) => f.id), [],
  'every feature has a lower-case hyphenated id, a line saying what it is, and lists of steps, settings and commands');
  const ids = features.map((f) => f.id);
  eq(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'and no two features share an id');
  const reached = (f) => f.steps.length || (f.checks || []).length;
  eq(features.filter((f) => !reached(f) && !(typeof f.notInWindow === 'string' && f.notInWindow)).map((f) => f.id), [],
    'each feature is reached by at least one look step or window test step, or says why the window cannot show it');
  eq(features.filter((f) => reached(f) && f.notInWindow).map((f) => f.id), [], 'and none does both');
  eq(features.flatMap((f) => f.steps.filter((s) => !steps.has(s)).map((s) => `${f.id}: ${s}`)), [],
    'every step a feature names is a look step of ui-look.js');
  eq(features.flatMap((f) => (f.checks || []).filter((s) => !checked.has(s)).map((s) => `${f.id}: ${s}`)), [],
    'and every check it names is a step of the window test, ui.js');
  const named = new Set(features.flatMap((f) => f.steps));
  eq([...steps].filter((s) => !named.has(s)), [], 'and every look step of ui-look.js serves some feature');
  const listedSettings = new Set(features.flatMap((f) => f.settings));
  const listedCommands = new Set(features.flatMap((f) => f.commands));
  eq(settings.filter((s) => !listedSettings.has(s)), [], `each of the ${settings.length} settings in package.json is in a feature`);
  eq(commands.filter((c) => !listedCommands.has(c)), [], `each of the ${commands.length} commands in package.json is in a feature`);
  eq([...listedSettings].filter((s) => !settings.includes(s)).concat([...listedCommands].filter((c) => !commands.includes(c))), [],
    'and the list names no setting or command package.json does not have');
  /* Given a value through a setting() helper of either test, one whose name ends in "setting" or "Setting" and whose first
     argument is the setting's name, or among the settings a window starts with. */
  const both = windowTest + source;
  const changed = new Set([...both.matchAll(/\b\w*[sS]etting\(\s*'([A-Za-z]+)'/g)].map((m) => `codexPlus.${m[1]}`)
    .concat([...both.matchAll(/'(codexPlus\.[A-Za-z]+)'\s*:/g)].map((m) => m[1])));
  eq(features.filter((f) => !f.notInWindow).flatMap((f) => f.settings.filter((s) => !changed.has(s)).map((s) => `${f.id}: ${s}`)), [],
    'every setting of a feature the window shows is given a value other than its default by some step of ui.js or ui-look.js');

  /* Agent Plus's settings, commands and views, against the Agent Plus found: the copy installed beside this one
     (VSCODE_EXTENSIONS), AGENT_WORK_PLAN_DIR, or its checkout beside this repository. */
  const { agentPlusGaps } = require(path.join(root, 'test', 'vscode', 'lib', 'feature-list'));
  const installed = (() => {
    try { const d = fs.readdirSync(process.env.VSCODE_EXTENSIONS || '').filter((n) => /^xnervwang\.agent-plus-\d/.test(n)).sort().pop(); return d ? path.join(process.env.VSCODE_EXTENSIONS, d) : ''; } catch (_) { return ''; }
  })();
  const apDir = [installed, process.env.AGENT_WORK_PLAN_DIR, path.join(root, '..', 'vscode-agent-plus')].find((d) => d && fs.existsSync(path.join(d, 'package.json')));
  if (!apDir) { note('no Agent Plus found to hold the feature list\'s Agent Plus settings, commands and views against'); return; }
  const apPkg = JSON.parse(fs.readFileSync(path.join(apDir, 'package.json'), 'utf8'));
  eq(agentPlusGaps(list, apPkg), [], `and every setting, command and view of Agent Plus ${apPkg.version} is listed once: under a feature that uses it, `
    + 'or in agentPlusOther with why it is not this extension\'s');
};
