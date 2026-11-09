// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Whether the plugin in Codex's cache is the one this extension carries, which turns on its files and not on its
 * version: the version goes up only at a release, and the hooks change between releases.
 *
 * The start-up decision is run as activation runs it, against a stand-in codex program whose app-server does what
 * Codex's does with an install, which is to copy the staged plugin into its cache, and writes down every request it was
 * sent. Whether the extension installed is read from that list.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

/* A codex program that answers the app-server requests the installer sends. */
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
    fs.appendFileSync(log, JSON.stringify({ method: msg.method }) + '\\n');
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

module.exports = async ({ note, eq, tmp, root }) => {
  const install = require('../../src/plugin-install');

  /* ── the digest, and the three answers about Codex's copy ── */
  const stage = tmp('stage');
  install.stageMarketplace(stage, install.SOURCE, install.SHIPPED_PYTHON);
  const staged = path.join(stage, install.PLUGIN, install.DIGEST_FILE);
  eq(fs.readFileSync(staged, 'utf8').trim(), install.sourceDigest(), 'the staged plugin carries the digest of the plugin\'s files');
  const fitted = tmp('stage-fitted');
  install.stageMarketplace(fitted, install.SOURCE, { launcher: ['python'], executable: '/usr/bin/python', version: '3.12' });
  eq(fs.readFileSync(path.join(fitted, install.PLUGIN, install.DIGEST_FILE), 'utf8').trim(), install.sourceDigest(),
    'and the same one when it was fitted to another Python, since that is this machine and not a change of the plugin');

  const home = tmp('codex-home');
  const cached = (version) => path.join(install.cacheDir(home), version);
  const copyIntoCache = (from, version) => {
    fs.rmSync(cached(version), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(cached(version)), { recursive: true });
    fs.cpSync(path.join(from, install.PLUGIN), cached(version), { recursive: true });
  };
  const want = install.pluginVersion();
  eq(install.installState(home).why, 'not installed', 'an empty cache holds nothing');
  copyIntoCache(stage, want);
  eq([install.installState(home).current, install.installState(home).why], [true, 'current'],
    'a copy made from these very files is current: nothing to install');
  const changed = tmp('source-changed');
  fs.cpSync(install.SOURCE, changed, { recursive: true });
  fs.appendFileSync(path.join(changed, install.PLUGIN, 'hooks', 'remind-work-plan.py'), '\n# one more line\n');
  eq([install.pluginVersion(changed), install.installState(home, changed).current, install.installState(home, changed).why],
    [want, false, 'files differ'], 'a hook changed under the same version is not current');
  fs.unlinkSync(path.join(cached(want), install.DIGEST_FILE));
  eq([install.installState(home).current, install.installState(home).why], [false, 'no digest'],
    'a copy with no digest, from a build that wrote none, is taken to differ');
  fs.rmSync(cached(want), { recursive: true, force: true });
  copyIntoCache(stage, '0.9.0');
  eq(install.installState(home).why, 'other version', 'and another version is another version');

  /* ── the start-up decision, against a stand-in codex ── */
  if (process.platform === 'win32') { note('the stand-in codex is a shell script, so the start-up decision is not run on Windows'); return; }
  const bin = tmp('fake-codex');
  fs.writeFileSync(path.join(bin, 'app-server.js'), FAKE_APP_SERVER);
  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, 'app-server.js'))}\n`);
  fs.chmodSync(codex, 0o755);

  const { vscode, control } = fake.create();
  /* Activated untrusted, so that activation schedules none of its delayed work (the offer among it) and the only
     offers made are the ones below. */
  vscode.workspace.isTrusted = false;
  vscode.workspace.onDidGrantWorkspaceTrust = () => ({ dispose() {} });
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const codexHome = tmp('home-for-start-up');
  fixture.codexHome(codexHome, [{ title: 'One', cwd: codexHome, turns: [{}] }]);
  control.state.config = { codexHome, installWorkPlanPlugin: 'never', reopenDroppedTabs: false, patchCodex: 'off', cliExecutable: codex };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: () => ({ accepted: true, code: '', reason: '', registration: { dispose() {} } }) } } });
  const ext = require(path.join(root, 'extension.js'));
  const pi = require(path.join(root, 'src', 'plugin-install.js'));
  const subs = [];
  const context = { subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento(),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root };
  await ext.activate(context);
  vscode.workspace.isTrusted = true;
  control.state.config.installWorkPlanPlugin = 'auto';
  const requests = path.join(codexHome, 'fake-codex-requests.jsonl');
  const installs = () => {
    let text = '';
    try { text = fs.readFileSync(requests, 'utf8'); } catch (_) { return 0; }
    return text.split('\n').filter((l) => l.includes('"plugin/install"')).length;
  };
  const said = [];
  const offer = () => ext._offerPlugin(context, (m) => said.push(m));
  try {
    await offer();
    eq([installs(), pi.installState(codexHome).why], [1, 'current'], 'with nothing in Codex, starting up installs the plugin');
    await offer();
    eq(installs(), 1, 'the same files in Codex\'s cache: starting up again installs nothing');

    /* What a user who installed before the plugin's files last changed has in Codex: the same version, older files. */
    await pi.install({ binary: codex, home: codexHome, stage: tmp('stage-older'), source: changed });
    const before = installs();
    eq(pi.installState(codexHome).why, 'files differ', 'Codex now holds the plugin as it was before a change of its files');
    await offer();
    eq([installs() - before, pi.installedDigest(codexHome, want) === pi.sourceDigest()], [1, true],
      'so starting up installs it again, and Codex then holds the files this extension carries');

    fs.unlinkSync(path.join(install.cacheDir(codexHome), want, install.DIGEST_FILE));
    const old = installs();
    await offer();
    eq([installs() - old, pi.installState(codexHome).why], [1, 'current'],
      'a copy installed by a build that recorded no digest is installed again too');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
