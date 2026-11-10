// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Time limits on the session list's host-side work, set far above the measured times, so a change that starts scanning
 * too much fails here (CONTRIBUTING.md, Cost budget). Drawing and searching in the page are timed in a real browser by
 * the render check (test/render/lib/sessions-scene.js).
 */
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const ms = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

module.exports = async ({ eq, ok, tmp }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  const { SessionsModel } = require('../../src/sessions-view');

  /* ── the model for 1000 conversations, on the extension host's own thread ── */
  const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const threads = Array.from({ length: 1000 }, (_, i) => ({ id: ID(i), title: `Conversation ${i}`, kind: 'user', cwd: '/w', section: i % 5 === 1 ? 'a' : '',
    createdMs: Date.now() - (i + 1) * 3600e3, updatedMs: Date.now() - i * 3600e3, branch: '' }));
  const model = new SessionsModel(vscode, { memento: fake.memento(), stateOf: () => ({ state: 'idle' }),
    memory: { openThreads: () => [ID(0), ID(1)], recentlyClosed: () => [], frontAt: () => 0 },
    reader: { threads: () => threads, sections: () => new Map([['a', 'Alpha']]), state: (id) => (id < ID(40) ? { working: false } : null), thread: () => null },
    settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }) });
  const builds = [];
  for (let i = 0; i < 7; i++) { model.json = ''; builds.push(ms(() => model.refresh())); }
  eq(model.model().groups.reduce((n, g) => n + g.rows.length, 0), 1000, 'the model holds all 1000 conversations');
  const b = median(builds);
  if (b < 100) ok(`working the list out for 1000 conversations takes ${b.toFixed(1)} ms, under the 100 ms any action may take`);
  else eq(b, '< 100 ms', 'working the list out for 1000 conversations');
  const asked = [];
  model.wantState = (ids) => asked.push(...ids);
  const e = ms(() => model.expanded(['ungrouped', 'section:a']));
  eq([asked.length, e < 50], [960, true], 'expanding every group asks once for the rollouts not yet read, quickly, and reads none itself');

  /* ── a pass of the 3-second poll, in the worker, with nothing changed ── */
  const home = tmp('cost-home');
  fixture.codexHome(home, Array.from({ length: 300 }, (_, i) => ({ title: `t${i}`, cwd: home, turns: [{}],
    startMs: Date.now() - (i < 20 ? i * 600e3 : 3 * 86400e3 + i * 3600e3) })));
  const { ops } = require('../../src/codex-worker');
  const first = ops.snapshot({ home: path.resolve(home), previous: '', extra: [] });
  const same = [];
  for (let i = 0; i < 5; i++) same.push(ms(() => ops.snapshot({ home: path.resolve(home), previous: first.stamp, extra: [] })));
  const s = median(same);
  eq([first.threads.length, Object.keys(first.states).length], [300, 20], 'a full pass reads the rollouts of the last two days only');
  if (s < 100) ok(`a pass of the poll with nothing changed takes ${s.toFixed(1)} ms for 300 conversations, and parses no rollout`);
  else eq(s, '< 100 ms', 'a pass of the poll with nothing changed, for 300 conversations');
};
