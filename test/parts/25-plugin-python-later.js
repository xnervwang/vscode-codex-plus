// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A plugin installed while no Python was found, and Python installed afterwards. With no Python the copy goes into
 * Codex without its hooks, MCP server and skill (plugin-install fitHooks), so the copy in Codex's cache stands for the
 * plugin as fitted to what was found, not for the plugin alone: once a Python is found the start-up install has to
 * stage it again, as Claude Code Plus stages its plugin again when the Python in its stamp changes.
 *
 * Codex's cache is filled the way Codex's plugin/install fills it, by copying the staged plugin directory, digest file
 * included; the stand-in codex program is the one test/parts/22-plugin-update.js describes.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

/* A codex program that answers the app-server requests the installer sends, as in test/parts/22-plugin-update.js. */
const FAKE_APP_SERVER = `'use strict';
const fs = require('fs');
const path = require('path');
const home = process.env.CODEX_HOME;
const log = path.join(home, 'fake-codex-requests.jsonl');
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
    fs.appendFileSync(log, JSON.stringify({ method: msg.method, edits: (msg.params && msg.params.edits) || null }) + '\\n');
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
    } else if (msg.method === 'hooks/list') answer(msg.id, { data: [] });
    else if (msg.method === 'config/batchWrite') answer(msg.id, { status: 'ok' });
    else answer(msg.id, {});
  }
});
`;

module.exports = async ({ eq, note, tmp, root }) => {
  const install = require('../../src/plugin-install');
  const want = install.pluginVersion();
  const found = { launcher: ['python3'], executable: '/usr/bin/python3', version: '3.12.3' };
  const fittedPy = { launcher: ['py', '-3'], executable: 'C:\\Python312\\python.exe', version: '3.12.3' };

  const intoCache = (home, python) => {
    const stage = tmp('stage');
    install.stageMarketplace(stage, install.SOURCE, python);
    const to = path.join(install.cacheDir(home), want);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(path.join(stage, install.PLUGIN), to, { recursive: true });
  };

  const home = tmp('codex-home');
  intoCache(home, null);
  const without = install.installState(home, install.SOURCE, null);
  const later = install.installState(home, install.SOURCE, found);
  eq([without.current, later.current, later.why], [true, false, 'python differs'],
    'a copy installed with no Python is current while there is still none, and not once one is found');
  intoCache(home, found);
  eq([install.installState(home, install.SOURCE, found).current, install.installState(home, install.SOURCE, null).why],
    [true, 'python differs'], 'and the other way round: a copy fitted to a Python is not current once that Python is gone');
  intoCache(home, fittedPy);
  eq([install.installState(home, install.SOURCE, fittedPy).current,
    install.installState(home, install.SOURCE, { ...fittedPy, executable: 'C:\\Python313\\python.exe' }).why],
  [true, 'python differs'], 'a copy fitted to an interpreter by its path is not current once another interpreter answers to that name');

  /* ── at start-up, against the stand-in codex ── */
  if (process.platform === 'win32') { note('the stand-in codex is a shell script, so the start-up install is not run on Windows'); return; }
  const py = await require('../../src/python-runtime').findPython();
  if (!py) { note('no Python 3.7 here, so the start-up install cannot be shown finding one'); return; }
  const bin = tmp('fake-codex');
  fs.writeFileSync(path.join(bin, 'app-server.js'), FAKE_APP_SERVER);
  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, 'app-server.js'))}\n`);
  fs.chmodSync(codex, 0o755);

  const { vscode, control } = fake.create();
  vscode.workspace.isTrusted = false;
  vscode.workspace.onDidGrantWorkspaceTrust = () => ({ dispose() {} });
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const codexHome = tmp('home-python-later');
  fixture.codexHome(codexHome, [{ title: 'One', cwd: codexHome, turns: [{}] }]);
  process.env.CODEX_HOME = codexHome;
  control.state.config = { reopenDroppedTabs: false, cliExecutable: codex };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: () => ({ accepted: true, code: '', reason: '', registration: { dispose() {} } }) } } });
  const ext = require(path.join(root, 'extension.js'));
  const pi = require(path.join(root, 'src', 'plugin-install.js'));
  const subs = [];
  const context = { subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root };
  await ext.activate(context);
  vscode.workspace.isTrusted = true;
  const installs = () => {
    try { return fs.readFileSync(path.join(codexHome, 'fake-codex-requests.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"plugin/install"')).length; } catch (_) { return 0; }
  };
  try {
    await pi.install({ binary: codex, home: codexHome, stage: tmp('stage-no-python'), python: null });
    const hooksIn = () => Object.keys(JSON.parse(fs.readFileSync(path.join(pi.cacheDir(codexHome), want, 'hooks', 'hooks.json'), 'utf8')).hooks || {}).length;
    eq([installs(), hooksIn()], [1, 0], 'installed while no Python was found, Codex holds the plugin with no hooks');
    await ext._ensurePlugin(context, () => {});
    eq([installs(), hooksIn() > 0], [2, true],
      'so with a Python found now, starting up installs it again, and Codex then holds the hooks');
    await ext._ensurePlugin(context, () => {});
    eq(installs(), 2, 'after which starting up again installs nothing');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
