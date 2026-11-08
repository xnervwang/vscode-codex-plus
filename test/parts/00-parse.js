// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* Everything shipped parses, and the manifest says what the task fixed it to say. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function jsFiles(root) {
  const out = ['extension.js', 'uninstall.js'];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.name.endsWith('.js')) out.push(r);
    }
  };
  for (const d of ['src', 'build', 'test']) if (fs.existsSync(path.join(root, d))) walk(d);
  return out;
}

module.exports = ({ ok, bad, eq, root }) => {
  for (const f of jsFiles(root)) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    try {
      // Wrapped the way Node wraps a CommonJS module, so a top-level `return` parses as it does at run time.
      new vm.Script(`(function (exports, require, module, __filename, __dirname) {${text}\n})`, { filename: f });
      ok(`${f} parses`);
    } catch (e) { bad(`${f}: ${e.message}`); }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  eq([pkg.publisher, pkg.name, pkg.displayName], ['xnervwang', 'codex-extras', 'Codex Extras'], 'extension identity');
  eq(pkg.version, '0.1.0', 'version stays 0.1.0');
  eq(pkg.extensionDependencies, ['openai.chatgpt', 'xnervwang.agent-work-plan'], 'depends on the Codex extension and on Agent Work Plan');
  eq(pkg.agentWorkPlan, { protocol: require(path.join(root, 'src', 'codex-source.js')).PROTOCOL }, 'the manifest states the protocol the source implements');
  eq(pkg.capabilities && pkg.capabilities.untrustedWorkspaces && pkg.capabilities.untrustedWorkspaces.supported, 'limited', 'it runs, limited, in Restricted Mode');
  const c = pkg.contributes;
  eq([c.viewsContainers.activitybar, Object.keys(c.views), c.views.codexExtras],
    [[{ id: 'codexExtras', title: 'Codex Extras', icon: 'images/sidebar.svg' }], ['codexExtras'],
      [{ id: 'codexExtras.sessions', name: 'Codex sessions', when: 'config.codexExtras.sessionList' }]],
  'the session list has its own activity bar container, so it does not sit in the work plan sidebar of whichever agent is in front');
  eq(fs.existsSync(path.join(root, 'images', 'sidebar.svg')), true, 'that container icon is in the repository');
  const commands = c.commands.map((x) => x.command);
  const gone = ['refreshWorkPlan', 'openWorkPlanFile', 'showWorkPlanDetail', 'showConversations', 'answerQuestion', 'openConversation',
    'restoreWebviewRequestLimit'].map((n) => 'codexExtras.' + n);
  eq(gone.filter((g) => commands.includes(g) || JSON.stringify(c).includes(`"${g}"`)), [], 'the commands of the views Agent Work Plan draws are gone');
  eq(['codexExtras.conversations', 'codexExtras.webviewRequestLimit'].filter((k) => k in c.configuration.properties), [], 'and so are their settings');
  eq(/claudeCodeExtras|codexExtras\.(standalone|hosted|answer"|sessionsHosted|conversations")/.test(JSON.stringify(c)), false, 'nothing names the old host or the standalone views');
  const open = c.commands.find((x) => x.command === 'codexExtras.openCodex');
  eq([c.menus['editor/title'], open && open.icon, ['codex-light.svg', 'codex-dark.svg'].every((f) => fs.existsSync(path.join(root, 'images', f)))],
    [[{ command: 'codexExtras.openCodex', group: 'navigation' }], { light: 'images/codex-light.svg', dark: 'images/codex-dark.svg' }, true],
    'the tab bar has the Codex button, with its icons');
  const target = c.configuration.properties['codexExtras.openButtonTarget'];
  eq([target.enum, target.default], [['tab', 'sidebar'], 'tab'], 'the button opens a tab unless set to the sidebar');
  eq(['icon.png', 'icon.svg'].every((f) => fs.existsSync(path.join(root, 'images', f))) && pkg.icon === 'images/icon.png', true, 'the marketplace icon is there');
  const header = /^(\/\/|#) BSD 3-Clause License\n\1 Copyright \(c\) 2026, Xnerv Wang\n\1 All rights reserved\./;
  const missing = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { if (e.name !== '__pycache__' && !e.name.startsWith('.')) walk(r); continue; }
      if (!/\.(js|py|sh)$/.test(e.name)) continue;
      let text = fs.readFileSync(path.join(root, r), 'utf8');
      text = text.replace(/^#!.*\n/, '');
      if (!header.test(text)) missing.push(r);
    }
  };
  walk('.');
  if (missing.length) bad(`missing copyright header: ${missing.join(', ')}`);
  else ok('every source file carries the copyright header');
};
