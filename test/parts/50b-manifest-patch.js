// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The patch to Codex's package.json (src/manifest.js), which adds a "when" to Codex's tab bar button so that it is
 * hidden while this extension's own button is shown.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function codexManifests() {
  const out = [];
  for (const root of [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const n of names) if (/^openai\.chatgpt-/.test(n) && fs.existsSync(path.join(root, n, 'package.json'))) out.push(path.join(root, n));
  }
  return out;
}

const STAND_IN = JSON.stringify({
  name: 'chatgpt', publisher: 'openai', version: '26.1021.22027',
  contributes: {
    commands: [{ command: 'chatgpt.openSidebar', title: 'Open Codex Sidebar', category: 'Codex',
      icon: { light: 'resources/blossom-black.svg', dark: 'resources/blossom-white.svg' } }],
    menus: { 'editor/title': [{ command: 'chatgpt.openSidebar', group: 'navigation' }],
      'editor/context': [{ command: 'chatgpt.addToThread', group: 'navigation' }] },
  },
  __metadata: { installedTimestamp: 1792795498250, targetPlatform: 'linux-x64', size: 1 },
}, null, '\t');

module.exports = async ({ ok, bad, note, eq, tmp }) => {
  let manifest = null;
  try { manifest = require('../../src/manifest'); } catch (e) { bad(`src/manifest.js cannot be loaded: ${e.message}`); return; }
  const adapters = require('../../src/adapters');
  const listed = adapters.find((t) => t.name === 'Codex manifest');
  eq([!!listed, listed && listed.standsAlone, adapters.filter((t) => !t.standsAlone).map((t) => t.name)], [true, true, ['Codex host', 'Codex page']],
    'the manifest is one of the patch targets, restored with the others, and applied on its own rather than all or nothing with them');

  const originals = [['a stand-in manifest', STAND_IN]];
  for (const dir of codexManifests()) {
    const file = manifest.targetFile(dir);
    const backup = file + manifest.BACKUP_SUFFIX;
    originals.push([path.basename(dir), fs.readFileSync(fs.existsSync(backup) ? backup : file, 'utf8')]);
  }
  if (originals.length === 1) note('no Codex is installed here; the manifest patch is checked on the stand-in alone');

  for (const [label, original] of originals) {
    /* ── the transform ── */
    const matches = [...original.matchAll(manifest.EDITS[0].re)].length;
    const r = manifest.patchSource(original);
    let parsed = null;
    try { parsed = r.out ? JSON.parse(r.out) : null; } catch (e) { bad(`${label}: the patched manifest is not JSON: ${e.message}`); }
    const item = parsed && parsed.contributes.menus['editor/title'].find((m) => m.command === 'chatgpt.openSidebar');
    eq([matches, r.error || '', !!parsed, item && item.when], [1, '', true, manifest.WHEN],
      `${label}: the edit matches exactly once, the result is JSON, and Codex's tab bar button carries the "when"`);
    if (parsed) {
      const back = JSON.parse(JSON.stringify(parsed));
      const it = back.contributes.menus['editor/title'].find((m) => m.command === 'chatgpt.openSidebar');
      delete it.when;
      delete it[manifest.MARK_KEY];
      eq([JSON.stringify(back) === JSON.stringify(JSON.parse(original)), it && Object.keys(item).filter((k) => !['command', 'group'].includes(k)).sort()],
        [true, ['when', manifest.MARK_KEY].sort()], `${label}: and nothing else in the manifest is changed`);
      eq([manifest.carries(parsed), manifest.carries(JSON.parse(original)), manifest.carries(undefined), manifest.carries({})], [true, false, false, false],
        `${label}: a manifest is known to carry the change by its "when" on that button, and an unpatched or absent one is not`);
    }
    eq(manifest.patchSource(r.out || '').error ? 'refused' : 'patched twice', 'refused', `${label}: an already patched manifest is not patched again`);

    /* ── apply and restore on a copy, next to a profile's extensions.json ── */
    const exts = tmp(`exts-${label.replace(/\W+/g, '-')}`);
    const dir = path.join(exts, 'openai.chatgpt-copy');
    fs.mkdirSync(dir, { recursive: true });
    const profile = path.join(exts, 'extensions.json');
    fs.writeFileSync(profile, '[]');
    const old = new Date(Date.now() - 86400e3);
    fs.utimesSync(profile, old, old);
    const file = manifest.targetFile(dir);
    fs.writeFileSync(file, original);
    const applied = manifest.apply(dir);
    const touched = fs.statSync(profile).mtimeMs;
    eq([applied.changed, applied.current, manifest.status(dir), manifest.apply(dir).changed, touched > old.getTime() + 1000, fs.readFileSync(profile, 'utf8')],
      [true, true, 'patched', false, true, '[]'],
      `${label}: applied to a copy it reads as patched, a second apply changes nothing, and extensions.json is given a new modification time and keeps its contents`);
    fs.utimesSync(profile, old, old);
    const restored = manifest.restore(dir);
    eq([restored.changed, fs.readFileSync(file, 'utf8') === original, fs.existsSync(file + manifest.BACKUP_SUFFIX), manifest.status(dir),
      fs.statSync(profile).mtimeMs > old.getTime() + 1000], [true, true, false, 'clean', true],
    `${label}: restoring puts the manifest back byte for byte, takes the backup away, and moves extensions.json's time again`);
  }

  /* ── what the patch refuses ── */
  const twice = STAND_IN.replace('"editor/context": [', '"view/title": [\n\t\t\t\t{\n\t\t\t\t\t"command": "chatgpt.openSidebar",\n\t\t\t\t\t"group": "navigation"\n\t\t\t\t}\n\t\t\t],\n\t\t\t"editor/context": [');
  const ruled = STAND_IN.replace('"group": "navigation"\n', '"group": "navigation",\n\t\t\t\t\t"when": "isWeb"\n');
  eq([!!manifest.patchSource(twice).error, !!manifest.patchSource(ruled).error, !!manifest.patchSource('{ not json').error],
    [true, true, true], 'a manifest where the button is found twice, already has a "when" of its own, or that is not JSON is left alone');
  const lone = tmp('manifest-lone');
  fs.writeFileSync(manifest.targetFile(lone), STAND_IN);
  manifest.apply(lone);
  fs.writeFileSync(manifest.targetFile(lone) + manifest.BACKUP_SUFFIX, '{ cut short');
  const refused = manifest.restore(lone);
  eq([refused.changed, manifest.status(lone)], [false, 'patched'], 'a backup that is not a Codex manifest is not put back over it');
  eq(manifest.status(tmp('manifest-none')), 'missing', 'and a folder with no package.json reads as missing');
  ok('the manifest patch was checked');
};
