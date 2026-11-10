// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The skill search the work plan plugin runs before each turn (codex-plugin/agent-work-plan/hooks/skill_route.py and
 * route-skills.py). Its cases are in test/route/test_skill_route.py, which needs nothing but Python; each of its lines is
 * reported here as one check.
 */
const cp = require('child_process');
const path = require('path');

function python() {
  for (const exe of ['python3', 'python']) {
    const r = cp.spawnSync(exe, ['-c', 'import sys; print(sys.version_info[:2] >= (3, 7))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return exe;
  }
  return null;
}

module.exports = async ({ ok, bad, note, root }) => {
  const py = python();
  if (!py) { note('no Python 3.7+ here: the skill search cases did not run'); return; }
  const script = path.join(root, 'test', 'route', 'test_skill_route.py');
  const r = cp.spawnSync(py, [script], { encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 64 << 20,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const lines = `${r.stdout || ''}`.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(ok|FAIL|note) +(.*)$/.exec(lines[i]);
    if (!m) continue;
    seen++;
    if (m[1] === 'ok') ok(m[2]);
    else if (m[1] === 'note') note(m[2]);
    else {
      const detail = [];
      for (let j = i + 1; j < lines.length && !/^(ok|FAIL|note)  /.test(lines[j]) && !/^\d+ passed/.test(lines[j]); j++) detail.push(lines[j]);
      bad(`${m[2]}\n${detail.join('\n').trim()}`);
    }
  }
  for (const l of lines) if (/^ {8}\S/.test(l)) console.log(`        ${l.trim()}`);
  if (!seen || r.status !== 0 && !lines.some((l) => /^FAIL  /.test(l))) {
    bad(`test_skill_route.py did not report its cases (exit ${r.status}${r.error ? `, ${r.error.message}` : ''}): `
      + `${`${r.stderr || ''}`.split('\n').slice(-5).join(' ')}`);
  }
};
