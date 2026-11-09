// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The two coarse switches, and what each of them leaves alone.
 *
 *   the additions      codexPlus.enabled, thrown by three commands, over everything this extension draws in or
 *                      around Codex. Its whole point is what it does not touch: the settings of the things it turns
 *                      off keep their values, and an applied patch stays in Codex's files.
 *   the plugin         whether Codex loads the work plan plugin, which is a state apart from whether it is installed.
 *                      Read out of config.toml and written through the app-server's own config write. Stop Loading
 *                      turns it off, and the install command turns it back on (test/parts/22-plugin-update.js).
 *
 * The first is checked through activate() against a stand-in VS Code, since the switch is only real if the settings
 * every part reads come out of it already applied. What the app-server does with the second's write is not checked here
 * - nothing in this suite starts one, the same as for installing and trusting - so what is checked is the edit handed
 * to it, and reading the state back out of a file.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const THREAD = '01a1b8f2-fd2b-7e60-9ffc-16e5cb642e31';

/** activate() in a window whose settings are `config`, with the handlers and the log left to read. */
async function windowWith(root, tmp, config) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const { vscode, control } = fake.create();
  fake.install(vscode);
  vscode.workspace.isTrusted = true;
  vscode.workspace.onDidGrantWorkspaceTrust = () => ({ dispose() {} });
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false, ...config };
  /* The settings an update writes have to be read back by the next get, or a command that throws the switch would read
     as having done nothing. */
  vscode.workspace.getConfiguration = (section) => ({
    get: (k, d) => (control.state.config && k in control.state.config ? control.state.config[k] : d),
    update: async (k, v) => { control.state.config[section === 'codexPlus' ? k : `${section}.${k}`] = v; },
  });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento(),
    globalStorageUri: vscode.Uri.file(tmp('storage')), extensionPath: root });
  return { vscode, control, home, ext,
    stop() { for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } } ext.deactivate(); } };
}

module.exports = async ({ ok, bad, eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  /* ── the master switch is a setting of its own, which every part reads through ── */
  eq(pkg.contributes.configuration.properties['codexPlus.enabled'].default, true,
    'the additions are on until somebody turns them off');
  const described = pkg.contributes.configuration.properties['codexPlus.enabled'].markdownDescription;
  eq([/does \*\*not\*\*/.test(described), /Remove the Patch from Codex/.test(described)], [true, true],
    'and its own description says it leaves Codex\'s files alone, naming the command that does not');
  for (const name of ['codexPlus.toggle', 'codexPlus.turnOn', 'codexPlus.turnOff']) {
    const c = pkg.contributes.commands.find((x) => x.command === name);
    if (c) ok(`${name} is declared, as "${c.title}"`);
    else bad(`${name} is not declared`);
  }
  /* The two that turn things off say so in their own titles: a "Turn Off" taken for one that restores Codex's files
     would be found out only much later, when the files turned out still to be patched. */
  for (const name of ['codexPlus.toggle', 'codexPlus.turnOff']) {
    const title = (pkg.contributes.commands.find((x) => x.command === name) || {}).title || '';
    eq(/leaves Codex's files alone/.test(title), true, `${name} says in its title that it leaves Codex's files alone`);
  }

  /*
   * What the switch covers, and what it does not. Read through activate(), because the switch only works if it has
   * already been applied by the time any part asks: the one place that happens is settings().
   */
  const off = await windowWith(root, tmp, { enabled: false, chime: true, turnFigures: true,
    timestamps: true, conversationNavigation: true, userMessageColor: '#90EE90', userMessageEdge: true,
    workPlan: true, hideBackgroundSessions: true });
  const gated = off.ext._settings();
  eq([gated.enabled, gated.timestamps, gated.conversationNavigation, gated.userMessageColor, gated.userMessageEdge,
    gated.chime, gated.figures],
  [false, false, false, '', false, false, false],
    'with it off, every part that asks for one of the additions is told it is off');
  eq(gated.patchCodex, 'off',
    'and the patch is neither applied nor kept up to date, which is not the same as being taken out of Codex');
  eq([gated.workPlan, gated.hideBackgroundSessions], [true, true],
    'while the work plan and the session list are not covered by it and read as they were set');
  off.control.state.log.length = 0;
  await off.control.state.handlers['codexPlus.status']();
  eq(/Additions: OFF \(codexPlus\.enabled\); the patch to Codex is left as it is/.test(off.control.state.log.join('\n')), true,
    'the status says the additions are off, and that the patch is left where it is');
  off.stop();

  /* The same table with the switch on, so that the one above is read as the switch working and not as the settings
     having been off anyway. */
  const lit0 = await windowWith(root, tmp, { enabled: true, chime: true, turnFigures: true,
    timestamps: true, conversationNavigation: true, userMessageColor: '#90EE90', userMessageEdge: true });
  const open = lit0.ext._settings();
  eq([open.timestamps, open.conversationNavigation, open.userMessageColor, open.userMessageEdge, open.chime,
    open.figures, open.patchCodex],
  [true, true, '#90EE90', true, true, true, 'on'],
    'and with it on each of them reads as that setting says, the switch adding nothing of its own');
  lit0.stop();

  /*
   * Turning it off and on again. The settings it covers are not written over, so what comes back is what the user had
   * rather than every default - which is the reason it is a setting of its own and not a command that writes six.
   */
  const mine = { enabled: true, chime: false, timestamps: false, conversationNavigation: true,
    userMessageColor: 'lightgreen', userMessageEdge: false };
  const w = await windowWith(root, tmp, { ...mine });
  await w.control.state.handlers['codexPlus.turnOff']();
  eq(w.control.state.config.enabled, false, 'Turn Off writes the one setting');
  eq([w.control.state.config.chime, w.control.state.config.timestamps, w.control.state.config.userMessageColor],
  [false, false, 'lightgreen'], 'and writes over none of the settings of the things it turned off');
  await w.control.state.handlers['codexPlus.turnOn']();
  eq(w.control.state.config.enabled, true, 'Turn On writes it back');
  const back = Object.fromEntries(Object.keys(mine).map((k) => [k, w.control.state.config[k]]));
  eq(back, mine, 'and every one of them is as the user had set it, rather than back at its default');
  await w.control.state.handlers['codexPlus.toggle']();
  eq(w.control.state.config.enabled, false, 'Toggle turns it off from on');
  await w.control.state.handlers['codexPlus.toggle']();
  eq(w.control.state.config.enabled, true, 'and on again from off');
  /* Asking for the patch while the additions are off would leave a patched Codex with nothing drawing through it. */
  await w.control.state.handlers['codexPlus.turnOff']();
  await w.control.state.handlers['codexPlus.applyPatch']();
  eq(w.control.state.config.enabled, true,
    'and asking for the patch turns them back on, since the patch is of no use to anything else');
  /* Remove the Patch is remembered as Claude Code Plus remembers its Remove, until Patch Codex is run again. */
  await w.control.state.handlers['codexPlus.removePatch']();
  const afterRemove = w.ext._settings().patchCodex;
  await w.control.state.handlers['codexPlus.applyPatch']();
  eq([afterRemove, w.ext._settings().patchCodex], ['off', 'on'],
    'after Remove the Patch nothing patches Codex, with the additions still on, until Patch Codex is run');
  w.stop();

  /* ── the switch reaches the pages and the tabs, which is the half of it that is not a setting ── */
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const codexDir = tmp('codex-of-this-window');
  control.state.extensions.set('openai.chatgpt', { extensionPath: codexDir, packageJSON: { version: '26.1021.22027' } });
  const patching = require('../../src/patching');
  const posted = [];
  const provider = { postMessageToWebview: (p, m) => posted.push(m) };
  /* A real logo, since the dot is that logo composited with a circle and a logo that cannot be wrapped leaves the tab
     its plain one - which is the very thing the switch is supposed to do, and would pass for it here. */
  const logoDir = tmp('codex-logo');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 2h12v12H2z"/></svg>';
  for (const n of ['light.svg', 'dark.svg']) fs.writeFileSync(path.join(logoDir, n), svg);
  const logo = { light: vscode.Uri.file(path.join(logoDir, 'light.svg')), dark: vscode.Uri.file(path.join(logoDir, 'dark.svg')) };
  const panel = { webview: {}, active: true, reveal() {}, onDidDispose() {}, iconPath: null };
  let on = true;
  patching.installHooks();
  globalThis.__codexExtrasPanel(panel, THREAD, provider);
  patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
    vscode, log: () => {},
    settings: () => (on
      ? { enabled: true, patchCodex: 'off', chime: true, figures: true, timestamps: true, conversationNavigation: true,
        userMessageColor: 'lightgreen', userMessageEdge: true }
      : { enabled: false, patchCodex: 'off', chime: false, figures: false, timestamps: false,
        conversationNavigation: false, userMessageColor: '', userMessageEdge: false }),
    userTimes: async () => ({ times: [111] }),
    source: { onDidChangeConversations: () => ({ dispose() {} }), _focus() {},
      listConversations: async () => [{ sessionId: THREAD, state: 'working', working: true }], logo },
    context: { globalStorageUri: vscode.Uri.file(tmp('gs')) } });

  await patching.refreshPanels();
  const lit = posted.filter((m) => m.type === 'codex-extras-view').pop();
  eq([lit.timestamps, lit.navigation, lit.userColor, lit.userEdge], [true, true, 'lightgreen', true],
    'with the additions on, a page is sent what each of their settings says');
  eq(panel.iconPath !== logo, true, 'and a working conversation\'s tab carries a dot rather than Codex\'s plain logo');
  on = false;
  await patching.refreshPanels();
  const dark = posted.filter((m) => m.type === 'codex-extras-view').pop();
  eq([dark.timestamps, dark.navigation, dark.userColor, dark.userEdge], [false, false, '', false],
    'with them off the page is told to clear everything of this extension\'s off Codex\'s tree');
  eq(panel.iconPath, logo, 'and the tab gets Codex\'s own logo back rather than keeping the dot it had');
  eq(posted.filter((m) => m.type === 'codex-extras-figures').pop().text, '',
    'the figures strip is sent nothing to show');
  /* The patch is a file on disk and the switch never writes one: whether it is in place is the patch commands' business. */
  eq(typeof patching.removePatch, 'function',
    'and putting Codex\'s files back is a different act, with a command of its own');

  /* ── whether Codex loads the plugin ── */
  const install = require('../../src/plugin-install');
  const homes = tmp('codex-homes');
  const write = (name, text) => { const d = path.join(homes, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'config.toml'), text); return d; };
  const SECTION = `[plugins.${JSON.stringify(install.PLUGIN_ID)}]`;
  eq(install.pluginLoadState(write('loaded', `${SECTION}\nenabled = true\n`)), 'loaded',
    'a plugin Codex is set to load reads as loaded');
  eq(install.pluginLoadState(write('skipped', `${SECTION}\nenabled = false\n`)), 'not loaded',
    'and one it is set to skip reads as not loaded, which is the state nothing else in Codex shows');
  eq(install.pluginLoadState(write('absent', '[plugins."something-else@aim"]\nenabled = false\n')), 'no entry',
    'another plugin\'s section of the very same shape is passed over rather than read as this one');
  eq(install.pluginLoadState(write('byhand', `${SECTION}\n`)), 'loaded',
    'a section somebody edited the key out of reads as loaded, which is what Codex does with one');
  eq(install.pluginLoadState(write('after', `${SECTION}\n\n[hooks.state."x"]\nenabled = false\n`)), 'loaded',
    'and a key of that name in the next section along does not count as this plugin\'s');
  eq(install.pluginLoadState(path.join(homes, 'no-such-home')), 'no entry',
    'a Codex home with no config.toml at all reads as no entry rather than throwing');
  /* Preceded by the user's own sections, which is what the file looks like: the section is found by its header and not
     by where in the file it is. */
  eq(install.pluginLoadState(write('real', `model = "gpt-5"\n\n[analytics]\nenabled = true\n\n${SECTION}\nenabled = false\n\n`
    + '[marketplaces.codex-extras]\nsource_type = "local"\n')), 'not loaded',
  'and it is found among the user\'s own sections, with one of the same key name before it');

  eq(install.pluginEnabledEdits(false), [{ keyPath: 'plugins."agent-work-plan@codex-extras".enabled', value: false,
    mergeStrategy: 'upsert' }], 'the write is one key of one section, upserted, so the rest of config.toml stands');
  eq(install.pluginEnabledEdits(true)[0].value, true, 'and the same key the other way to have Codex load it again');

  for (const name of ['codexPlus.stopLoadingWorkPlanPlugin', 'codexPlus.installWorkPlanPlugin']) {
    const c = pkg.contributes.commands.find((x) => x.command === name);
    if (c) ok(`${name} is declared, as "${c.title}"`);
    else bad(`${name} is not declared`);
  }
  eq(/keeps it installed/.test((pkg.contributes.commands.find((x) => x.command === 'codexPlus.stopLoadingWorkPlanPlugin') || {}).title || ''),
    true, 'and the one that stops it says in its title that the plugin stays where it is');

  /* Show Status tells the two states apart, which is the whole reason for reading config.toml. */
  const skipped = await windowWith(root, tmp, { enabled: false });
  const cache = path.join(skipped.home, 'plugins', 'cache', install.MARKETPLACE, install.PLUGIN, '9.9.9', '.codex-plugin');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(skipped.home, 'config.toml'), `${SECTION}\nenabled = false\n`);
  skipped.control.state.log.length = 0;
  await skipped.control.state.handlers['codexPlus.status']();
  const statusOff = skipped.control.state.log.join('\n');
  eq(/Work plan plugin: 9\.9\.9, INSTALLED BUT NOT LOADED \(Codex is set to skip it\)/.test(statusOff), true,
    'a plugin Codex holds but will not load is reported as exactly that, rather than as installed');
  fs.writeFileSync(path.join(skipped.home, 'config.toml'), `${SECTION}\nenabled = true\n`);
  skipped.control.state.log.length = 0;
  await skipped.control.state.handlers['codexPlus.status']();
  eq(/Work plan plugin: 9\.9\.9, loaded/.test(skipped.control.state.log.join('\n')), true,
    'and one it will load is reported as loaded');
  skipped.stop();
};
