// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What becomes of the work plan plugin when this extension is uninstalled.
 *
 * VS Code deletes an extension's folder, runs its vscode:uninstall script and then deletes its global storage
 * directory, all when it cleans up the extensions marked for removal, which in remote development is the next start of
 * the remote server; before that the extension host restarts and deactivate runs. Three things follow from that, each
 * checked here:
 *
 *   deactivate on an uninstall  starts the uninstall script in a process of its own, as Claude Code Plus does, so the
 *                               plugin goes when the extension goes rather than at the next server start
 *   the uninstall script        removes the plugin through Codex's app-server once no editor on the machine holds a
 *                               copy of this extension, copying the plans out first, and does nothing when the plugin
 *                               is already gone
 *   the hooks                   do nothing once every editor's global storage that registered with the plugin is gone,
 *                               for a plugin the script could not remove
 *
 * The editors are laid out under a home of the test's own, the codex program is a stand-in whose app-server answers as
 * Codex's does and writes down each request, and the Codex install is shaped as 26.1021 is (bin/<platform>-<arch>/codex).
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ID = 'xnervwang.codex-plus';
const PLAN = '01a1c0c0-0000-7000-8000-0000000000c1';

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
    fs.appendFileSync(log, JSON.stringify({ method: msg.method, params: msg.params || null }) + '\\n');
    if (msg.method === 'plugin/uninstall') fs.rmSync(path.join(home, 'plugins', 'cache', 'codex-extras'), { recursive: true, force: true });
    answer(msg.id, msg.method === 'config/batchWrite' ? { status: 'ok' } : {});
  }
});
`;

const python = () => {
  for (const exe of ['python3', 'python']) {
    const r = cp.spawnSync(exe, ['-c', 'import sys; print(sys.version_info[:2] >= (3, 7))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return exe;
  }
  return '';
};

module.exports = async ({ eq, note, tmp, root }) => {
  const install = require('../../src/plugin-install');
  const plan = require('../../src/uninstall-plan');

  /* ── the hooks' side: the global storage directories that registered with the plugin ── */
  const codexHome = tmp('marker-home');
  const storageA = tmp('editor-a-storage');
  const storageB = tmp('editor-b-storage');
  install.writeHookSettings(codexHome, { enabled: true, tellTimeZone: true }, { marker: storageA });
  install.writeHookSettings(codexHome, { enabled: true, tellTimeZone: true }, { marker: storageB });
  const written = () => JSON.parse(fs.readFileSync(path.join(install.planDir(codexHome), 'config.json'), 'utf8'));
  eq((written().extensionMarkers || []).slice().sort(), [storageA, storageB].sort(),
    'each editor that writes the hooks\' settings adds its own global storage to the ones already registered');
  fs.rmdirSync(storageA);
  install.writeHookSettings(codexHome, { enabled: true, tellTimeZone: true }, { marker: storageB });
  eq(written().extensionMarkers, [storageB], 'and one that is gone is dropped the next time they are written');

  const py = python();
  if (!py) {
    note('no Python 3.7 here: the hooks\' reading of the registered directories is not run');
  } else {
    const hooks = path.join(root, 'codex-plugin', 'agent-work-plan', 'hooks');
    const data = install.planDir(codexHome);
    const settingsWith = (markers) => {
      const cfg = { enabled: true, tellTimeZone: true };
      if (markers) cfg.extensionMarkers = markers;
      fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(cfg));
      const r = cp.spawnSync(py, ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(hooks)}); import plan_path; `
        + `s = plan_path.settings(${JSON.stringify(data)}); print(json.dumps([s["enabled"], s["tellTimeZone"]]))`],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      try { return JSON.parse(r.stdout); } catch (_) { return r.stderr.slice(0, 200); }
    };
    eq(settingsWith([storageA]), [false, false],
      'with every registered editor\'s global storage gone, the plan and the time zone are both off');
    eq(settingsWith([storageA, storageB]), [true, true], 'with one of them still there, the hooks go on as set');
    eq(settingsWith(null), [true, true], 'and settings that register no editor, as a plugin set up by hand has, leave them on');
    const planFile = path.join(data, `${PLAN}.json`);
    fs.writeFileSync(planFile, JSON.stringify({ nodes: [{ title: 'T', state: 'doing' }] }));
    const inject = () => cp.spawnSync(py, [path.join(hooks, 'inject-work-plan.py'), data], { encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: PLAN, turn_id: 't1', transcript_path: null,
        cwd: data, model: 'm', permission_mode: 'default', prompt: 'p' }), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).stdout.trim();
    settingsWith([storageB]);
    const shown = inject();
    settingsWith([storageA]);
    eq([shown.includes('additionalContext'), inject()], [true, ''],
      'so the plan is put in front of the model while an editor still has this extension, and nothing is once none has');
  }

  /* ── the uninstall script ── */
  if (process.platform === 'win32') { note('the stand-in codex is a shell script, so the uninstall script is not run here'); return; }
  const lay = (label) => {
    const home = tmp(`uninstall-${label}`);
    const ext = path.join(home, '.vscode-server', 'extensions');
    const self = path.join(ext, `${ID}-1.0.1`);
    fs.mkdirSync(self, { recursive: true });
    for (const f of ['uninstall.js', 'package.json']) fs.copyFileSync(path.join(root, f), path.join(self, f));
    for (const d of ['src', 'codex-plugin']) fs.cpSync(path.join(root, d), path.join(self, d), { recursive: true });
    fs.writeFileSync(path.join(ext, '.obsolete'), JSON.stringify({ [`${ID}-1.0.1`]: true }));
    const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch] || process.arch;
    const plat = { linux: 'linux', darwin: 'macos' }[process.platform] || process.platform;
    const bin = path.join(ext, 'openai.chatgpt-26.1021.22027-linux-x64', 'bin', `${plat}-${arch}`);
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'app-server.js'), FAKE_APP_SERVER);
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, 'app-server.js'))}\n`);
    fs.chmodSync(path.join(bin, 'codex'), 0o755);
    const codex = path.join(home, '.codex');
    const cached = path.join(install.cacheDir(codex), install.pluginVersion(), '.codex-plugin');
    fs.mkdirSync(cached, { recursive: true });
    fs.mkdirSync(install.planDir(codex), { recursive: true });
    fs.writeFileSync(path.join(install.planDir(codex), `${PLAN}.json`), JSON.stringify({ nodes: [] }));
    const run = () => cp.spawnSync(process.execPath, [path.join(self, 'uninstall.js')], { encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codex } });
    const requests = () => {
      let lines = [];
      try { lines = fs.readFileSync(path.join(codex, 'fake-codex-requests.jsonl'), 'utf8').split('\n').filter(Boolean); } catch (_) { return []; }
      return lines.map((l) => JSON.parse(l).method).filter((m) => m !== 'initialize');
    };
    const kept = () => fs.readdirSync(codex).filter((n) => n.startsWith('agent-work-plan-plans-'));
    return { home, ext, self, codex, run, requests, kept };
  };

  const last = lay('last-copy');
  last.run();
  eq(last.requests(), ['plugin/uninstall', 'marketplace/remove', 'config/batchWrite'],
    'with no copy of this extension left in any editor, the uninstall script removes the plugin, its marketplace and the trust given to its hooks');
  const saved = last.kept();
  eq([saved.length, saved.length ? fs.readdirSync(path.join(last.codex, saved[0])) : []], [1, [`${PLAN}.json`]],
    'having copied the plans out first');
  last.run();
  eq([last.requests().length, last.kept().length], [3, 1],
    'run a second time, as it is when deactivate started it and VS Code then runs it again, it finds the plugin gone and does nothing');

  const shared = lay('another-editor');
  fs.mkdirSync(path.join(shared.home, '.vscode', 'extensions', `${ID}-1.0.1`), { recursive: true });
  shared.run();
  eq([shared.requests(), shared.kept()], [[], []], 'while another editor on the machine still holds a copy, the plugin and the plans stay');

  /* ── deactivate ── */
  eq([plan.beingUninstalled(last.self, ID), plan.beingUninstalled(shared.self, ID)], [true, true],
    'a copy whose folder its editor marked for deletion, with no other copy beside it, is being uninstalled');
  const updated = lay('update');
  fs.mkdirSync(path.join(updated.ext, `${ID}-1.0.2`));
  eq(plan.beingUninstalled(updated.self, ID), false, 'one replaced by a newer copy in the same folder is being updated, not uninstalled');
  const reloading = lay('reload');
  fs.unlinkSync(path.join(reloading.ext, '.obsolete'));
  eq(plan.beingUninstalled(reloading.self, ID), false, 'and one that is not marked is a reload or a closing window');
  const spawned = [];
  const fakeSpawn = (exe, args, opts) => { spawned.push({ exe, args, detached: opts && opts.detached }); return { unref() {} }; };
  eq([plan.finishUninstall(last.self, ID, fakeSpawn), plan.finishUninstall(updated.self, ID, fakeSpawn), plan.finishUninstall(reloading.self, ID, fakeSpawn)],
    [true, false, false], 'deactivate hands an uninstall on, and nothing else');
  eq(spawned.map((s) => [s.args, s.detached]), [[[path.join(last.self, 'uninstall.js')], true]],
    'to the uninstall script, in a process that outlives the extension host');
};
