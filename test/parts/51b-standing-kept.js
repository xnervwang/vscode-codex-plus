// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * keptStanding() reads its files again only when the extensions folder's .obsolete, the folder's list of copies or this
 * copy's manifest has changed, and its answer must match a fresh read. The test passes a time an hour later instead of
 * waiting for the files to settle.
 */
const fs = require('fs');
const path = require('path');

module.exports = ({ ok, bad, eq, tmp, root }) => {
  const plan = require('../../src/uninstall-plan');
  const dir = tmp('extensions');
  const own = path.join(dir, 'xnervwang.codex-plus-1.1.0');
  fs.mkdirSync(own);
  const manifest = path.join(own, 'package.json');
  const stamp = 1700000000001;
  const writeManifest = (n) => fs.writeFileSync(manifest, JSON.stringify({ name: 'codex-plus', __metadata: { installedTimestamp: n } }));
  writeManifest(stamp);
  let clock = () => Date.now() + 3600e3;
  const ids = [plan.ID, ...plan.FORMER_IDS];
  const fresh = () => plan.standing(own, ids, stamp);
  const reads = (fn) => {
    let n = 0;
    const { readFileSync, readdirSync } = fs;
    fs.readFileSync = function (p, ...a) { if (String(p).startsWith(dir)) n++; return readFileSync.call(this, p, ...a); };
    fs.readdirSync = function (p, ...a) { if (String(p).startsWith(dir)) n++; return readdirSync.call(this, p, ...a); };
    try { return { out: fn(), n }; } finally { Object.assign(fs, { readFileSync, readdirSync }); }
  };
  try {
    const kept = plan.keptStanding(own, ids, stamp, { now: () => clock() });
    eq(kept(), '', 'a copy nobody replaced does not stand down');
    eq(reads(kept).n, 0, 'and asked again with nothing changed, it reads nothing');

    const next = path.join(dir, 'xnervwang.codex-plus-1.2.0');
    fs.mkdirSync(next);
    fs.writeFileSync(path.join(dir, '.obsolete'), JSON.stringify({ 'xnervwang.codex-plus-1.1.0': true }));
    /* "Now" is the moment of that change, so it is less than SETTLED_MS old whatever the scheduler does. */
    const changedAt = fs.statSync(path.join(dir, '.obsolete')).ctimeMs;
    clock = () => changedAt;
    const marked = reads(kept);
    eq([marked.out, marked.n > 0], [fresh(), true], 'another version installed beside it, marking this one, is read and answered as afresh');
    eq(marked.out, 'replaced', 'which is that this copy was replaced');
    eq(reads(kept).n > 0, true, 'files changed less than SETTLED_MS ago are read again on the next call');
    clock = () => Date.now() + 3600e3;
    kept();
    eq(reads(kept).n, 0, 'until their change times are that old');

    fs.rmSync(next, { recursive: true, force: true });
    fs.unlinkSync(path.join(dir, '.obsolete'));
    eq(kept(), fresh(), 'with the new copy gone and nothing marked, the answer is read again');
    eq(kept(), '', 'and it no longer stands down');

    /* The same version installed over this one: a manifest of the same size with another `installedTimestamp`, its
       modification time put back, so that only its change time differs. The test pins the times stat gives for it, so
       the result does not depend on whether the two writes fall in different clock ticks. */
    const P = Date.parse('2026-01-01T00:00:00Z');
    const pinned = (over, fn) => {
      const statSync = fs.statSync;
      fs.statSync = function (p, ...a) { const s = statSync.call(this, p, ...a); return String(p) === manifest ? { ...s, ...over } : s; };
      try { return fn(); } finally { fs.statSync = statSync; }
    };
    pinned({ mtimeMs: P, ctimeMs: P }, () => kept());
    eq(pinned({ mtimeMs: P, ctimeMs: P }, () => reads(kept).n), 0, 'a settled manifest is not read again');
    writeManifest(stamp + 1);
    eq(pinned({ mtimeMs: P, ctimeMs: P + 1 }, () => [kept(), fresh()]), ['replaced', 'replaced'],
      'one rewritten in place with its modification time put back is read again, its change time having moved, and answered as afresh');

    const none = plan.keptStanding('', ids, stamp);
    eq(none(), '', 'a window that does not know its own folder does not stand down');
  } catch (e) { bad(`the kept answer to standing down: ${(e && e.stack) || e}`); }
  const ext = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  eq(/function standsDown\(\) \{[\s\S]{0,400}uninstallPlan\.keptStanding\(/.test(ext), true, 'the window asks through the kept answer');
  ok('the kept answer to standing down is checked');
};
