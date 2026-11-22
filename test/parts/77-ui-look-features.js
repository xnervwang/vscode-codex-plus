// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The feature list of the look run (test/vscode/ui-look-features.json) against the scenes of test/vscode/ui-look.js and
 * this extension's package.json.
 *
 * The step names are taken from the look('<name>', ...) calls in the source, since loading ui-look.js needs Playwright.
 */
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, root }) => {
  const features = JSON.parse(fs.readFileSync(path.join(root, 'test', 'vscode', 'ui-look-features.json'), 'utf8'));
  const source = fs.readFileSync(path.join(root, 'test', 'vscode', 'ui-look.js'), 'utf8');
  const steps = new Set([...source.matchAll(/\blook\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const commands = pkg.contributes.commands.map((c) => c.command);
  const settings = (Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration])
    .flatMap((s) => Object.keys(s.properties));

  eq(features.filter((f) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.id) || typeof f.what !== 'string' || !f.what
    || !['steps', 'settings', 'commands'].every((k) => Array.isArray(f[k]))).map((f) => f.id), [],
  'every feature has a lower-case hyphenated id, a line saying what it is, and lists of steps, settings and commands');
  const ids = features.map((f) => f.id);
  eq(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'and no two features share an id');
  eq(features.filter((f) => !f.steps.length && !(typeof f.notInWindow === 'string' && f.notInWindow)).map((f) => f.id), [],
    'each feature is reached by at least one step, or says why the window cannot show it');
  eq(features.filter((f) => f.steps.length && f.notInWindow).map((f) => f.id), [], 'and none does both');
  eq(features.flatMap((f) => f.steps.filter((s) => !steps.has(s)).map((s) => `${f.id}: ${s}`)), [],
    'every step a feature names is a look step of ui-look.js');
  const named = new Set(features.flatMap((f) => f.steps));
  eq([...steps].filter((s) => !named.has(s)), [], 'and every look step of ui-look.js serves some feature');
  const listedSettings = new Set(features.flatMap((f) => f.settings));
  const listedCommands = new Set(features.flatMap((f) => f.commands));
  eq(settings.filter((s) => !listedSettings.has(s)), [], `each of the ${settings.length} settings in package.json is in a feature`);
  eq(commands.filter((c) => !listedCommands.has(c)), [], `each of the ${commands.length} commands in package.json is in a feature`);
  eq([...listedSettings].filter((s) => !settings.includes(s)).concat([...listedCommands].filter((c) => !commands.includes(c))), [],
    'and the list names no setting or command package.json does not have');
};
