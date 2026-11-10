// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The command set matches Claude Code Plus's, with nothing extra: no Session Information (the information button in
 * the message box shows the same), no list of commands Codex is still running (Show Status has it), no command to
 * remove the work plan plugin (uninstalling the extension does that), and no Patch Codex, because Turn On and Toggle
 * reapply the patch after Remove, as in Claude Code Plus. Turning the additions on or off shows no message, also as in
 * Claude Code Plus.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

module.exports = async ({ eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const commands = pkg.contributes.commands.map((c) => c.command);
  const gone = ['codexPlus.sessionInfo', 'codexPlus.showRunningCommands', 'codexPlus.removeWorkPlanPlugin', 'codexPlus.applyPatch'];
  eq(gone.filter((c) => commands.includes(c)), [], 'Session Information, the running commands, Remove the Work Plan Plugin and Patch Codex are gone');
  const menus = JSON.stringify(pkg.contributes.menus);
  eq(gone.filter((c) => menus.includes(`"${c}"`)), [], 'and so are their entries in every menu');
  const title = (c) => (pkg.contributes.commands.find((x) => x.command === c) || {}).title;
  eq([title('codexPlus.toggle'), title('codexPlus.turnOn'), title('codexPlus.turnOff')],
    ['Codex Plus: Toggle On/Off', 'Codex Plus: Turn On', 'Codex Plus: Turn Off'], 'the switch\'s three commands are named as Claude Code Plus names its own');
  eq(fs.readFileSync(path.join(root, 'uninstall.js'), 'utf8').includes('plugin'), true, 'uninstalling the extension still takes the plugin out of Codex');

  /* ── on and off say nothing, and Turn On puts the patch back after Remove ── */
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  vscode.workspace.getConfiguration = (section) => ({
    get: (k, d) => (k in control.state.config ? control.state.config[k] : d),
    update: async (k, v) => { control.state.config[section === 'codexPlus' ? k : `${section}.${k}`] = v; },
  });
  const ext = require(path.join(root, 'extension.js'));
  const patching = require(path.join(root, 'src', 'patching.js'));
  const subs = [];
  const globalState = fake.memento();
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState, globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  try {
    control.state.said.length = 0;
    await control.state.handlers['codexPlus.turnOff']();
    await control.state.handlers['codexPlus.turnOn']();
    await control.state.handlers['codexPlus.toggle']();
    await control.state.handlers['codexPlus.toggle']();
    eq([control.state.config.enabled, control.state.said.map((s) => s.message)], [true, []], 'Turn Off, Turn On and Toggle change the switch and say nothing');
    await control.state.handlers['codexPlus.removePatch']();
    eq(ext._settings().patchCodex, 'off', 'after Remove nothing patches Codex');
    await control.state.handlers['codexPlus.turnOn']();
    eq([ext._settings().patchCodex, globalState.get(patching.PATCH_REMOVED_KEY)], ['on', false], 'and Turn On puts the patch back');
    await control.state.handlers['codexPlus.removePatch']();
    await control.state.handlers['codexPlus.toggle']();
    eq([ext._settings().patchCodex, control.state.config.enabled], ['on', true], 'and so does Toggle, which after Remove turns everything on');
    const said = (await patching.selfCheckPage()).error || '';
    eq([/Turn On/.test(said), /Patch Codex/.test(said)], [true, false], 'a page that cannot be asked names Turn On as what fixes it');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
