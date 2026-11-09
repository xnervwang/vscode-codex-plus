// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The settings the plugin's hooks are given. They are written into one file under CODEX_HOME that every window and
 * every `codex` run on the machine reads (src/plugin-install.js writeHookSettings), so a value that one workspace could
 * set would reach every other conversation, whichever window wrote last. Each of them is therefore declared an
 * application setting, which VS Code reads from user settings alone: workspace and folder settings are parsed with
 * scopes that leave application settings out (WORKSPACE_SCOPES, FOLDER_SCOPES in VS Code's
 * workbench/services/configuration/common/configuration.ts). Claude Code Plus declares its own the same way.
 *
 * The names are read out of extension.js's writeHookSettings, so a setting added there is checked without being listed
 * here.
 */
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const props = Object.assign({}, ...[].concat(pkg.contributes.configuration).map((c) => c.properties || {}));
  const src = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const body = (/function writeHookSettings\(context\) \{([\s\S]*?)\n\}/.exec(src) || ['', ''])[1];
  const names = [...new Set([...body.matchAll(/c\.get\('(\w+)'/g)].map((m) => m[1]))];
  eq(names.length >= 5, true, `writeHookSettings reads the hooks' settings (${names.join(', ')})`);
  eq(names.filter((n) => !props[`codexPlus.${n}`] || props[`codexPlus.${n}`].scope !== 'application').map((n) => `codexPlus.${n}`), [],
    'every setting the hooks are given is an application setting, so no workspace can set it for the whole machine');
};
