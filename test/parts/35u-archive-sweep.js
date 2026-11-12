// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The deletion of conversations kept in Archived sessions longer than codexPlus.deleteArchivedAfterDays days
 * (src/archive-sweep.js).
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const ID = (n) => `01a1acac-0000-7000-8000-${String(n).padStart(12, '0')}`;
const DAY = 864e5;

module.exports = async ({ eq, tmp, root }) => {
  let sweep = null;
  try { sweep = require(path.join(root, 'src', 'archive-sweep.js')); } catch (_) { sweep = null; }
  eq(!!(sweep && typeof sweep.dueThreads === 'function' && typeof sweep.createArchiveSweep === 'function'), true,
    'src/archive-sweep.js says which archived conversations are due and runs the pass');
  if (!sweep) return;
  const { dueThreads, createArchiveSweep } = sweep;

  /* ── which are due ── */
  const NOW = 400 * DAY;
  const a = (n, extra = {}) => ({ id: ID(n), title: `a${n}`, kind: 'user', archived: true, archivedMs: NOW - n * DAY, ...extra });
  const ids = (list) => list.map((x) => x.id.slice(-2));
  eq(ids(dueThreads([a(31), a(29), a(30), a(40, { archived: false }), a(45, { archivedMs: 0 }), a(50, { archivedMs: 0 }),
    a(33, { kind: 'subagent', parent: ID(31) }), a(34, { kind: 'subagent', parent: ID(29) })],
  { days: 30, now: NOW, seen: { [ID(45)]: NOW - 45 * DAY } })), ['31', '30', '45', '34'],
  'due: archived 30 days ago or more, by Codex\'s archive time, or for one Codex gave none by when a pass first saw it archived; one with neither '
    + 'is not due, one not archived never is, and a sub-agent goes with its parent rather than on its own');
  eq(dueThreads([a(31)], { days: 0, now: NOW }), [], 'with the setting at 0 nothing is due');

  /* ── a pass ── */
  const dir = tmp('sweep');
  let now = NOW;
  let threads = [a(31), a(10), a(45, { archivedMs: 0 }), a(35)];
  let held = new Set([ID(35)]);
  const removed = [], logs = [];
  const make = (over = {}) => createArchiveSweep({ dir: () => dir, home: () => '/codex/home', days: () => 30, threads: () => threads,
    check: () => '', hold: async (list) => new Set(list.filter((id) => held.has(id))), log: (m) => logs.push(m), now: () => now,
    remove: async (list) => {
      removed.push(ids(list));
      threads = threads.filter((x) => !list.some((y) => y.id === x.id));
      return { deleted: list.map((x) => ({ id: x.id, title: x.title })), failed: [] };
    }, ...over });
  const first = make();
  const r1 = await first.run();
  eq([r1.ran, removed], [true, [['31']]], 'a pass deletes those due and leaves out one open or running');
  eq([logs.some((l) => /deleted 1 conversation archived 30 or more days ago: "a31"/.test(l)), logs.some((l) => /left alone 1 conversation archived 30 or more days ago, as open or running: "a35"/.test(l))],
    [true, true], 'the output says what it deleted and what it left alone');
  removed.length = 0;
  const second = make();
  eq([(await second.run()).ran, (await first.run()).ran, removed], [false, false, []],
    'a second window, or this one again, within a day of that pass deletes nothing');
  now = NOW + DAY + 1;
  held = new Set();
  await second.run();
  eq(removed, [['35']], 'a day later the next pass deletes the one that was open, now that it is not');
  removed.length = 0;
  now = NOW + 31 * DAY;
  await second.run();
  eq(removed, [['10', '45']], 'and later, the one Codex gave no archive time goes 30 days after the first pass saw it, not by its file\'s time');

  /* ── one window at a time ── */
  removed.length = 0;
  now += 2 * DAY;
  threads = [a(31), a(32)].map((x) => ({ ...x, archivedMs: now - 40 * DAY }));
  let release = null;
  const slow = make({ remove: async (list) => { removed.push(ids(list)); await new Promise((r) => { release = r; }); return { deleted: [], failed: [] }; } });
  const busy = slow.run();
  await tick();
  const other = await make().run();
  if (release) release();
  await busy;
  eq([removed.length, other.ran], [1, false], 'two windows starting together: the one holding the lock deletes, the other does nothing');

  /* ── when it does not run ── */
  removed.length = 0;
  now += 2 * DAY;
  eq([(await make({ days: () => 0 }).run()).ran, (await make({ check: () => 'the workspace is not trusted' }).run()).ran, removed],
    [false, false, []], 'nothing is deleted with the setting at 0, nor in a window that may not, as an untrusted or a replaced one');
  logs.length = 0;
  eq([(await make({ hold: async () => null }).run()).ran, removed, logs.some((l) => /could not tell which conversations are open/.test(l))],
    [false, [], true], 'nor when this window cannot tell which conversations are open, which the output says');
  await make().run();
  eq(removed, [['31', '32']], 'and a pass after that one still deletes them');

  /* ── the timing ── */
  removed.length = 0;
  now += 2 * DAY;
  threads = [a(31)].map((x) => ({ ...x, archivedMs: now - 40 * DAY }));
  const timed = make();
  timed.tick();
  await tick();
  eq(removed, [], 'nothing runs from the poll before the start-up pass');
  timed.start();
  await tick();
  removed.length = 0;
  threads = [a(31), a(36)].map((x) => ({ ...x, archivedMs: now - 40 * DAY }));
  now += 3600e3;
  timed.tick();
  await tick();
  eq(removed, [], 'after the start-up pass, the poll does not run another the same day');
  now += DAY;
  timed.tick();
  await tick();
  eq(removed, [['31', '36']], 'and runs one once a day has passed');

  /* ── the extension ── */
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  const sec = (ms) => Math.floor(ms / 1000);
  const real = Date.now();
  fixture.codexHome(home, [
    { id: ID(1), title: 'Old', cwd: home, archived: true, archivedAt: sec(real - 40 * DAY), turns: [{}] },
    { id: ID(2), title: 'Recent', cwd: home, archived: true, archivedAt: sec(real - 5 * DAY), turns: [{}] },
    { id: ID(3), title: 'Old, open', cwd: home, archived: true, archivedAt: sec(real - 40 * DAY), turns: [{}] },
    { id: ID(4), title: 'No time', cwd: home, archived: true, archivedAt: null, turns: [{}] },
    { id: ID(5), title: 'Kept', cwd: home, turns: [{}] },
  ]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const self = path.join(tmp('window'), 'xnervwang.codex-plus-1.0.1');
  fs.mkdirSync(self, { recursive: true });
  const stamp = (n) => fs.writeFileSync(path.join(self, 'package.json'), JSON.stringify({ ...manifest, __metadata: { installedTimestamp: n } }));
  stamp(5000);
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: self });
  await tick(300);
  const requests = [];
  let handler = null;
  const conn = {
    registerProvider(name, h) { handler = Object.assign({ name }, h); return { dispose() { handler = null; } }; },
    sendRequest(name, id, method, params) { requests.push({ method, params }); setTimeout(() => handler && handler.onResult({ id, result: {} }), 1); },
  };
  globalThis.__codexExtrasMessage({}, { kind: 'none' }, { codexMcpConnection: conn, postMessageToWebview() {}, sendMessageToPanel() {} });
  control.setTabs([control.codexTab(ID(3))], 0);
  control.fireTabs();
  await tick(100);
  const deletes = () => requests.filter((r) => r.method === 'thread/delete').map((r) => r.params.threadId.slice(-2));
  const pass = async () => {
    requests.length = 0;
    control.state.said.length = 0;
    for (let i = 0; i < 100 && typeof ext._sweepArchived === 'function'; i++) {
      const r = await ext._sweepArchived();
      if (!r || r.why !== 'no snapshot') break;
      await tick(100);
    }
    await tick();
    return deletes();
  };
  try {
    vscode.workspace.isTrusted = false;
    eq(await pass(), [], 'in an untrusted workspace no archived conversation is deleted');
    vscode.workspace.isTrusted = true;
    stamp(6000);
    eq(await pass(), [], 'nor in a window running a build that has since been replaced');
    stamp(5000);
    control.state.log.length = 0;
    eq([await pass(), control.state.said], [['01'], []],
      'otherwise the pass deletes the one archived 40 days ago, leaves the one open here, the recent one and the one with no archive time, '
        + 'and shows no notification');
    eq(control.state.log.some((l) => /deleted 1 conversation archived 30 or more days ago: "Old"/.test(l)), true, 'it says so in the output');
    eq(await pass(), [], 'and the next pass the same day deletes nothing');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
