// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The row above the work plan (planNotice in Agent Plus's protocol), modelled on Claude Code Plus's: the plugin that
 * writes plans could not be installed, there is no Python for its hooks, or Codex has not been told to trust them.
 * Each row carries the command that fixes the problem and disappears once it is fixed. Where python.org has a build
 * for the machine (Windows), the download is also offered once per version at start-up, as in Claude Code Plus.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

/* A codex program answering what the installer asks; its hooks/list says the plugin's one hook needs review while the
   file `untrusted` is in its CODEX_HOME. */
const FAKE_APP_SERVER = `'use strict';
const fs = require('fs');
const path = require('path');
const home = process.env.CODEX_HOME;
let buf = '';
const answer = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === 'marketplace/add') answer(msg.id, { installedRoot: msg.params.source });
    else if (msg.method === 'plugin/install') {
      const stage = path.dirname(path.dirname(path.dirname(msg.params.marketplacePath)));
      const plugin = path.join(stage, msg.params.pluginName);
      const version = JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), 'utf8')).version;
      const into = path.join(home, 'plugins', 'cache', 'codex-extras', msg.params.pluginName, version);
      fs.rmSync(into, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(into), { recursive: true });
      fs.cpSync(plugin, into, { recursive: true });
      answer(msg.id, {});
    } else if (msg.method === 'hooks/list') {
      const hooks = fs.existsSync(path.join(home, 'untrusted'))
        ? [{ key: 'k1', pluginId: 'agent-work-plan@codex-extras', eventName: 'UserPromptSubmit', command: 'python3 x', trustStatus: 'untrusted', currentHash: 'h' }] : [];
      answer(msg.id, { data: [{ hooks }] });
    } else answer(msg.id, {});
  }
});
`;

module.exports = async ({ eq, note, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  eq(pkg.contributes.menus.commandPalette.some((m) => m.command === 'codexPlus.downloadPython' && m.when === 'false'), true,
    'Download Python is reached from the row, not from the command palette, as in Claude Code Plus');
  if (process.platform === 'win32') { note('the stand-in codex is a shell script, so the plan notice is not run on Windows'); return; }
  const bin = tmp('fake-codex');
  fs.writeFileSync(path.join(bin, 'app-server.js'), FAKE_APP_SERVER);
  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, 'app-server.js'))}\n`);
  fs.chmodSync(codex, 0o755);

  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const codexHome = tmp('home');
  fixture.codexHome(codexHome, [{ title: 'One', cwd: codexHome, turns: [{}] }]);
  process.env.CODEX_HOME = codexHome;
  control.state.config = { reopenDroppedTabs: false };
  let source = null;
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: (s) => { source = s; return { accepted: true, code: '', reason: '', registration: { dispose() {} } }; } } } });
  const ext = require(path.join(root, 'extension.js'));
  const runtime = require(path.join(root, 'src', 'python-runtime.js'));
  const subs = [];
  const context = { subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root };
  await ext.activate(context);
  let told = 0;
  source.onDidChangePlanNotice(() => { told++; });
  const shown = () => { const n = source.planNotice(); return n ? [n.title, n.command] : null; };
  const realPath = process.env.PATH;
  const realBuild = runtime.build;
  try {
    eq(shown(), null, 'to begin with there is nothing above the plan');

    /* No codex program: the plugin cannot be installed. */
    await ext._ensurePlugin(context, () => {});
    eq(shown(), ['The plugin that writes work plans is not installed', 'codexPlus.installWorkPlanPlugin'],
      'with no codex program found, the row says the plugin is not installed, and clicking it tries again');
    eq([told > 0, /codex program/.test(source.planNotice().detail)], [true, true], 'and Agent Plus is told, with what failed in the detail');

    /* A codex program, and no Python on the PATH. */
    control.state.config.cliExecutable = codex;
    process.env.PATH = tmp('no-python-here');
    await ext._ensurePlugin(context, () => {});
    eq(shown(), ['Work plans need Python 3', 'codexPlus.installWorkPlanPlugin'],
      'installed with no Python, the row says the plan needs one, and on a machine python.org has no build for, clicking it installs again');

    /* Where there is a build to download, the row offers it, and so does a question once per version. */
    runtime.build = () => ({ name: 'amd64', sha256: '0', size: 1, url: 'https://www.python.org/x.zip' });
    control.state.said.length = 0;
    control.answer('Work plans need Python 3', 'Not now');
    await ext._ensurePlugin(context, () => {});
    const asked = control.state.said.filter((s) => /Download it from python\.org/.test(s.message)).length;
    eq([shown(), asked], [['Work plans need Python 3', 'codexPlus.downloadPython'], 1],
      'where python.org has a build, the row downloads it, and the download is offered once');
    await ext._ensurePlugin(context, () => {});
    eq(control.state.said.filter((s) => /Download it from python\.org/.test(s.message)).length, 1, 'and not again for the same version');
    runtime.build = realBuild;
    process.env.PATH = realPath;

    /* With Python, and the hooks not trusted. */
    const py = await runtime.findPython();
    if (!py) { note('no Python 3.7 here, so the row for hooks not yet trusted cannot be shown'); return; }
    fs.writeFileSync(path.join(codexHome, 'untrusted'), '');
    control.answer('Trust the work plan hooks', undefined);
    await ext._ensurePlugin(context, () => {});
    eq(shown(), ['Codex does not run the work plan hooks yet', 'codexPlus.trustWorkPlanHooks'],
      'with the hooks not trusted and the question dismissed, the row says so, and clicking it asks again');
    fs.unlinkSync(path.join(codexHome, 'untrusted'));
    await ext._ensurePlugin(context, () => {});
    eq(shown(), null, 'and once nothing is left to fix the row goes');
  } finally {
    process.env.PATH = realPath;
    runtime.build = realBuild;
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
