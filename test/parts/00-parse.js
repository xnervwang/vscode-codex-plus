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
  eq([pkg.publisher, pkg.name, pkg.displayName], ['xnervwang', 'codex-plus', 'Codex Plus'], 'extension identity');
  eq(pkg.version, '1.0.1', 'the version is the one after the release on the marketplaces, 1.0.0');
  eq(pkg.extensionDependencies, ['openai.chatgpt', 'xnervwang.agent-plus'], 'depends on the Codex extension and on Agent Plus');
  eq(pkg.agentPlus, { protocol: require(path.join(root, 'src', 'codex-source.js')).PROTOCOL }, 'the manifest states the protocol the source implements');
  eq(pkg.capabilities && pkg.capabilities.untrustedWorkspaces && pkg.capabilities.untrustedWorkspaces.supported, 'limited', 'it runs, limited, in Restricted Mode');
  const c = pkg.contributes;
  eq([c.viewsContainers.activitybar, Object.keys(c.views), c.views.codexPlus],
    [[{ id: 'codexPlus', title: 'Codex Plus', icon: 'images/sidebar.svg' }], ['codexPlus'],
      [{ id: 'codexPlus.sessions', name: 'Codex sessions', when: 'config.codexPlus.sessionList' }]],
  'the session list has its own activity bar container, so it does not sit in the work plan sidebar of whichever agent is in front');
  eq(fs.existsSync(path.join(root, 'images', 'sidebar.svg')), true, 'that container icon is in the repository');
  const commands = c.commands.map((x) => x.command);
  const gone = ['refreshWorkPlan', 'openWorkPlanFile', 'showWorkPlanDetail', 'showConversations', 'answerQuestion', 'openConversation',
    'restoreWebviewRequestLimit'].map((n) => 'codexPlus.' + n);
  eq(gone.filter((g) => commands.includes(g) || JSON.stringify(c).includes(`"${g}"`)), [], 'the commands of the views Agent Plus draws are gone');
  eq(['codexPlus.conversations', 'codexPlus.webviewRequestLimit'].filter((k) => k in c.configuration.properties), [], 'and so are their settings');
  eq(/claudeCodeExtras|codexPlus\.(standalone|hosted|answer"|sessionsHosted|conversations")/.test(JSON.stringify(c)), false, 'nothing names the old host or the standalone views');
  const open = c.commands.find((x) => x.command === 'codexPlus.openCodex');
  eq([c.menus['editor/title'], open && open.icon, ['codex-light.svg', 'codex-dark.svg'].every((f) => fs.existsSync(path.join(root, 'images', f)))],
    [[{ command: 'codexPlus.openCodex', group: 'navigation' }], { light: 'images/codex-light.svg', dark: 'images/codex-dark.svg' }, true],
    'the tab bar has the one Codex button, with its icons, and nothing else of this extension\'s');
  /* What the Claude side has no counterpart of, and so is not here either. */
  const trimmed = ['goToWaiting', 'refreshSessions', 'copyThreadId', 'loadWorkPlanPlugin', 'sampleConversationDom', 'pageSelfCheck']
    .map((n) => 'codexPlus.' + n);
  eq(trimmed.filter((g) => commands.includes(g) || JSON.stringify(c.menus).includes(`"${g}"`)), [],
    'no status bar count, Refresh, Copy Thread ID, Load the plugin, layout sample or page self-check command is declared');
  eq(['waitingInStatusBar', 'sessionsInWorkspaceOnly', 'newConversationGroup', 'sendAnswers', 'codexHome', 'openButtonTarget',
    'installWorkPlanPlugin', 'patchCodex'].map((k) => 'codexPlus.' + k).filter((k) => k in c.configuration.properties), [],
  'and none of the settings for things Claude Code and Claude Code Plus do one fixed way');
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
