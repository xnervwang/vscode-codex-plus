// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A window keeps running the build it loaded until it reloads, even after another build of this extension is
 * installed. VS Code stamps every install into the manifest it writes (__metadata.installedTimestamp), and an update or
 * a downgrade marks the old folder in .obsolete while the new one stays unmarked. Either way the window must leave the
 * files every window shares alone. If it wrote the hooks' settings, every key only the newer build knows would be lost
 * until a reloaded window wrote them again.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const ID = 'xnervwang.codex-plus';

module.exports = async ({ eq, tmp, root }) => {
  const plan = require('../../src/uninstall-plan');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const copy = (ext, folder, stamp) => {
    const dir = path.join(ext, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(stamp ? { ...manifest, __metadata: { installedTimestamp: stamp } } : manifest));
    return dir;
  };

  /* ── where a copy stands ── */
  const ext = tmp('standing');
  const self = copy(ext, `${ID}-1.0.1`, 1000);
  eq([plan.installStamp(self), plan.standing(self, ID, 1000)], [1000, ''], 'a copy whose install stamp is the one it loaded with is the installed build');
  copy(ext, `${ID}-1.0.1`, 2000);
  eq(plan.standing(self, ID, 1000), 'replaced', 'the same version installed again over it changes the stamp, and it is replaced');
  eq([plan.standing(self, ID, 0), plan.standing(copy(tmp('no-stamp'), `${ID}-1.0.1`, 0), ID, 1000)], ['', ''],
    'with no stamp to compare, on either side, it is not taken for replaced');
  copy(ext, `${ID}-1.0.2`, 3000);
  fs.writeFileSync(path.join(ext, '.obsolete'), JSON.stringify({ [`${ID}-1.0.1`]: true }));
  eq(plan.standing(self, ID, 2000), 'replaced', 'a copy marked for deletion beside an unmarked newer one is replaced');
  fs.writeFileSync(path.join(ext, '.obsolete'), JSON.stringify({ [`${ID}-1.0.1`]: true, [`${ID}-1.0.2`]: true }));
  eq(plan.standing(self, ID, 2000), 'uninstalling', 'and one marked with none left beside it is being uninstalled');

  /* ── a replaced window writes none of the hooks' files ── */
  const { vscode, control } = fake.create();
  let changed = null;
  vscode.workspace.onDidChangeConfiguration = (fn) => { changed = fn; return { dispose() {} }; };
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  const mine = copy(tmp('window'), `${ID}-1.0.1`, 5000);
  const extension = require(path.join(root, 'extension.js'));
  const install = require(path.join(root, 'src', 'plugin-install.js'));
  const settingsFile = path.join(install.planDir(home), 'config.json');
  const zoneFile = path.join(install.planDir(home), 'client-time-zone.json');
  const subs = [];
  await extension.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: mine });
  try {
    eq(fs.existsSync(settingsFile), true, 'the window running the installed build writes the hooks\' settings');
    copy(path.dirname(mine), `${ID}-1.0.1`, 6000);
    const newer = { ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')), onlyTheNewerBuildKnows: true };
    fs.writeFileSync(settingsFile, JSON.stringify(newer, null, 2) + '\n');
    changed({ affectsConfiguration: (k) => k === 'codexPlus' });
    eq(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).onlyTheNewerBuildKnows, true,
      'once the same version is installed again over it, a settings change in that window leaves the newer build\'s settings as they are');
    globalThis.__codexExtrasMessage({}, { type: 'codex-extras', kind: 'tz', timeZone: 'Europe/Paris' }, {});
    await new Promise((r) => setTimeout(r, 20));
    eq(fs.existsSync(zoneFile), false, 'and a zone its page reports is not written for the hooks either');
    const said = [];
    await extension._ensurePlugin({ globalStorageUri: vscode.Uri.file(tmp('gs2')) }, (m) => said.push(m));
    eq(said, [], 'nor does it set about installing the plugin it carries into Codex');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    extension.deactivate();
  }
};
