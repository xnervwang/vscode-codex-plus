// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The plan cleanup's last check before it deletes a plan: whether a rollout of that conversation is still anywhere
 * under sessions/ or archived_sessions/ (src/codex-files.js rolloutExists). A folder there that cannot be read can
 * hold that rollout, so it does not count as the rollout being gone. A folder that is not there at all does.
 *
 * Codex files a rollout as sessions/<year>/<month>/<day>/rollout-<time>-<thread id>.jsonl; one day's folder is made
 * unreadable here, as a permission error would leave it.
 */
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, note, tmp }) => {
  if (!process.getuid || process.getuid() === 0) { note('folder permissions are not enforced for this user, so an unreadable folder cannot be made'); return; }
  const files = require('../../src/codex-files');
  const workplan = require('../../src/workplan');
  const ID = '01a1abcd-0000-7000-8000-00000000ab01';
  const home = tmp('home-unreadable');
  const day = path.join(home, 'sessions', '2026', '11', '01');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-11-01T10-00-00-${ID}.jsonl`), '{}\n');
  const plans = path.join(home, 'plugins', 'data', 'agent-work-plan-codex-extras');
  fs.mkdirSync(plans, { recursive: true });
  const plan = path.join(plans, `${ID}.json`);
  fs.writeFileSync(plan, '{"nodes":[]}');
  const old = (Date.now() - 30 * 86400e3) / 1000;
  fs.utimesSync(plan, old, old);
  eq(files.rolloutExists(ID, home), true, 'a rollout in a folder that can be read is found');
  fs.chmodSync(day, 0);
  try {
    eq(files.rolloutExists(ID, home), true, 'one in a folder that cannot be read is not taken to be gone');
    const r = workplan.sweepOrphans({ dir: plans, home, live: new Set() });
    eq([r.deleted, fs.existsSync(plan)], [0, true], 'so the cleanup keeps a month-old plan whose conversation it cannot rule out');
  } finally { fs.chmodSync(day, 0o700); }
  eq(files.rolloutExists('01a1abcd-0000-7000-8000-00000000ab02', home), false, 'while a conversation with no rollout anywhere is gone');
  eq(files.rolloutExists(ID, tmp('home-without-sessions')), false, 'and a Codex home with no sessions folder at all holds none');
};
