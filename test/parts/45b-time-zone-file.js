// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The plugin's time-zone hook reads the reader's zone from client-time-zone.json beside the plans, and leaves the zone
 * out of a turn in which it reads that file half-written. So the file is replaced by a rename instead of being rewritten
 * in place.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

module.exports = async ({ eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  let changed = null;
  vscode.workspace.onDidChangeConfiguration = (fn) => { changed = fn; return { dispose() {} }; };
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  const ext = require(path.join(root, 'extension.js'));
  const install = require(path.join(root, 'src', 'plugin-install.js'));
  const file = path.join(install.planDir(home), 'client-time-zone.json');
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  const report = async (zone) => {
    globalThis.__codexExtrasMessage({}, { type: 'codex-extras', kind: 'tz', timeZone: zone }, {});
    await new Promise((r) => setTimeout(r, 20));
  };
  const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; } };
  try {
    await report('America/Los_Angeles');
    eq(read(), '{"timeZone":"America/Los_Angeles"}\n', 'the zone Codex\'s page reports is left for the hooks');
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, old, old);
    const before = fs.statSync(file);
    changed({ affectsConfiguration: (k) => k === 'codexPlus' });
    const after = fs.statSync(file);
    eq([after.ino, after.mtimeMs], [before.ino, before.mtimeMs], 'a settings change that leaves the zone as it was does not write the file again');
    await report('Europe/Paris');
    const now = fs.statSync(file);
    eq([read(), now.ino !== before.ino], ['{"timeZone":"Europe/Paris"}\n', true],
      'a new zone replaces the file with a new one by a rename, so a hook reading it never sees it half-written');
    eq(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), [], 'and no temporary file is left beside it');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
