// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Checks what a scan for work left running reads when nothing it finds has changed, and that it finds the same either
 * way. It makes one read call per stat file. It reads a process's environ only when the process is new, has exec'd or
 * reuses an old pid. A window that uses the scan another window wrote less than SHARE_MS ago reads no /proc at all.
 *
 * The /proc and the sessions folder are made up for the test. One entry links to this test's own process, so that a
 * file of the real /proc, which reports its size as 0, is read too. Times are passed in, so the test does not wait.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

/* Calls of `names` on fs during fn(), each with the path or descriptor it was given. */
function counting(names, fn) {
  const calls = [];
  const saved = {};
  for (const name of names) {
    saved[name] = fs[name];
    fs[name] = function (...a) { calls.push([name, a[0]]); return saved[name].apply(this, a); };
  }
  try { return { out: fn(), calls }; } finally { for (const name of names) fs[name] = saved[name]; }
}

module.exports = async ({ ok, bad, eq, note, tmp }) => {
  const section = async (what, fn) => {
    try { await fn(); } catch (e) { bad(`${what}: ${(e && e.message) || e}`); }
  };
  const left = require('../../src/left-running');
  const procDir = tmp('proc');
  const put = (pid, { comm, state = 'S', ppid = 1, start = 100, argv, env = {}, pad = 0 }) => {
    const d = path.join(procDir, String(pid));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'stat'), `${pid} (${comm}) ${state} ${ppid} ${Array(17).fill(0).join(' ')} ${start} 0 0${' 0'.repeat(pad)}\n`);
    fs.writeFileSync(path.join(d, 'cmdline'), (argv || [comm]).join('\0') + '\0');
    fs.writeFileSync(path.join(d, 'environ'), Object.entries({ HOME: '/h', ...env }).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
  };
  put(10, { comm: 'codex', argv: ['/x/codex', 'app-server'] });
  put(11, { comm: 'bash', ppid: 10, argv: ['/bin/bash', '-lc', 'npm run watch'], env: { CODEX_THREAD_ID: ID(1) } });
  put(20, { comm: 'bash', argv: ['bash', '-c', 'make all'], env: { CODEX_THREAD_ID: ID(2) } });
  put(21, { comm: 'timeout', argv: ['timeout', '600', 'make'], env: { CODEX_THREAD_ID: ID(3) } });
  put(30, { comm: 'bash', argv: ['bash', '-c', 'x'], env: { CODEX_THREAD_ID: ID(4) }, pad: 2100 });
  put(40, { comm: 'codex', argv: ['codex', 'exec', '--json', '-'], env: { CODEX_THREAD_ID: ID(5) } });
  const sessionsDir = tmp('claude-sessions');
  const environOf = (calls) => calls.filter(([, f]) => typeof f === 'string' && f.endsWith('/environ')).map(([, f]) => Number(path.basename(path.dirname(f)))).sort((a, b) => a - b);
  const kinds = (snap) => Object.fromEntries([...snap.threads].map(([id, k]) => [id, [...k]]));

  await section('reading stat', async () => {
    const r = counting(['readFileSync', 'readSync', 'openSync'], () => left.processes(procDir));
    const statPath = (pid) => path.join(procDir, String(pid), 'stat');
    const whole = r.calls.filter(([n, f]) => n === 'readFileSync' && typeof f === 'string' && f.endsWith('/stat'));
    eq(whole.map(([, f]) => f), [statPath(30)], 'a stat line is read into the shared buffer, and only one longer than it is read whole');
    eq([...r.out.keys()].sort((a, b) => a - b), [10, 11, 20, 21, 30, 40], 'every process is listed');
    eq([r.out.get(11), r.out.get(30)], [{ comm: 'bash', state: 'S', ppid: 10, sid: 0, start: '100' }, { comm: 'bash', state: 'S', ppid: 1, sid: 0, start: '100' }],
      'and each line gives the same comm, state, parent, session and start as read whole');
    const self = path.join('/proc', String(process.pid));
    if (!fs.existsSync(path.join(self, 'stat'))) { note('no /proc here, so a real stat file was not read'); return; }
    const real = tmp('real-proc');
    fs.symlinkSync(self, path.join(real, String(process.pid)));
    const ours = counting(['readSync', 'readFileSync'], () => left.processes(real));
    const want = fs.readFileSync(path.join(self, 'stat'), 'latin1');
    const fields = want.slice(want.lastIndexOf(')') + 2).split(' ');
    const got = ours.out.get(process.pid);
    eq([ours.calls.filter(([n]) => n === 'readSync').length, ours.calls.filter(([n]) => n === 'readFileSync').length], [1, 0],
      'a stat file of the real /proc, which gives its size as 0, takes one read call');
    eq(got && [got.comm, got.ppid, got.start], [want.slice(want.indexOf('(') + 1, want.lastIndexOf(')')), Number(fields[1]), fields[19]],
      'and gives what reading it whole gives');
  });

  await section('the environ of each process', async () => {
    const environs = new Map();
    const once = () => counting(['readFileSync'], () => left.snapshot({ proc: procDir, records: [], environs }));
    const first = once();
    const plain = left.snapshot({ proc: procDir, records: [] });
    eq(kinds(first.out), kinds(plain), 'a scan that keeps what it read finds what one that keeps nothing finds');
    eq(environOf(first.calls), [10, 11, 20, 21, 30, 40], 'the first scan reads the environ of every process it looks at');
    const second = once();
    eq([environOf(second.calls), kinds(second.out)], [[], kinds(plain)], 'the next one reads none of them and finds the same');
    /* pid 11 execs another program with another launcher; pid 21 exits and its pid goes to a new process; 30 exits. */
    put(11, { comm: 'node', ppid: 10, argv: ['node', 'job.js'], env: { CODEX_THREAD_ID: ID(6) } });
    put(21, { comm: 'timeout', start: 900, argv: ['timeout', '9', 'x'], env: { CODEX_THREAD_ID: ID(7) } });
    fs.rmSync(path.join(procDir, '30'), { recursive: true, force: true });
    const third = once();
    eq(environOf(third.calls), [11, 21], 'a process that exec\'d, and a new process holding an old pid, are read again');
    eq(kinds(third.out), kinds(left.snapshot({ proc: procDir, records: [] })), 'and the scan finds what one that kept nothing finds');
    eq([environs.has(30), environs.has(11), environs.get(21) && environs.get(21).start], [false, true, '900'],
      'a process that is gone is dropped from what is kept');
  });

  await section('the scan the windows share', async () => {
    const planDir = tmp('plans');
    const share = path.join(planDir, left.SHARE_DIR);
    const file = path.join(share, left.SHARE_FILE);
    const T0 = 1e12;
    const mine = left.scan({ proc: procDir, sessionsDir });
    const first = left.scan({ proc: procDir, sessionsDir, share, now: T0 });
    eq(first, mine, 'a window with no shared scan to take scans /proc itself');
    let d = null;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { d = null; }
    eq(d && [d.format, d.proc, d.sessions, d.available, d.threads, d.bg, d.running, typeof d.at],
      [left.SHARE_FORMAT, procDir, path.resolve(sessionsDir), true, mine.threads, mine.bg, mine.running, 'number'], 'and writes what it found for the others');
    eq([left.SHARE_FORMAT, (mine.running || []).map((x) => [x.kind, x.pid])], [2, [['command', 11], ['codexExec', 40]]],
      'which lists the rest of the work too, so its format is a new one');
    eq(fs.readdirSync(share), [left.SHARE_FILE], 'leaving no temporary file behind');
    const other = { format: left.SHARE_FORMAT, at: T0, proc: procDir, sessions: path.resolve(sessionsDir), available: true,
      threads: { [ID(42)]: ['detached'] }, detached: [],
      bg: [{ job: 'abcd1234', pid: 60, start: '100', startMs: 5, name: 'night suite', session: ID(600) }],
      running: [{ thread: ID(42), kind: 'command', pid: 77, start: '100', startMs: 0, cmd: 'make', name: '', session: '', job: '' }] };
    const write = (o) => fs.writeFileSync(file, typeof o === 'string' ? o : JSON.stringify(o));
    write(other);
    const taken = counting(['readdirSync', 'readFileSync'], () => left.scan({ proc: procDir, sessionsDir, share, now: T0 + left.SHARE_MS - 1 }));
    eq([taken.out.threads, taken.out.bg, taken.out.running], [other.threads, other.bg, other.running],
      'a scan another window wrote less than SHARE_MS ago is taken as it is');
    eq(taken.calls.filter(([, f]) => typeof f === 'string' && f.startsWith(procDir)).length, 0, 'without reading /proc');
    const passed = (why, o, now) => {
      write(o);
      eq(left.scan({ proc: procDir, sessionsDir, share, now }).threads, mine.threads, why);
    };
    passed('one SHARE_MS old is not', other, T0 + left.SHARE_MS);
    passed('one timed in the future is not', other, T0 - 1);
    passed('one of another format is not', { ...other, format: left.SHARE_FORMAT + 1 }, T0 + 1);
    passed('one that does not parse is not', '{"format": 1, "at": ', T0 + 1);
    passed('one written for another /proc is not', { ...other, proc: '/elsewhere' }, T0 + 1);
    passed('one written for another sessions folder is not', { ...other, sessions: '/elsewhere' }, T0 + 1);
    passed('one naming a kind no scan finds is not', { ...other, threads: { [ID(42)]: ['claudeBg'] } }, T0 + 1);
    passed('one with a thread that is not an id is not', { ...other, threads: { 'not-an-id': ['detached'] } }, T0 + 1);
    passed('one from a build that listed only the detached commands is not', { ...other, format: 1, jobs: ['abcd1234'], bg: undefined, running: undefined }, T0 + 1);
    passed('one listing work of a kind it cannot be is not', { ...other, running: [{ ...other.running[0], kind: 'subagent' }] }, T0 + 1);
    passed('one listing a claude --bg session with no job id is not', { ...other, bg: [{ ...other.bg[0], job: 'x' }] }, T0 + 1);

    /* A claude --bg launch is still read from this window's rollouts, against the busy jobs the shared scan names. */
    const rollout = path.join(tmp('rollouts'), 'rollout.jsonl');
    const row = (r) => JSON.stringify({ timestamp: new Date(T0).toISOString(), type: 'response_item', payload: r });
    fs.writeFileSync(rollout, [row({ type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'claude --bg "x"' }) }),
      row({ type: 'function_call_output', call_id: 'c1', output: 'backgrounded · abcd1234\n' })].join('\n') + '\n');
    write(other);
    const r = left.leftRunning({ threads: [{ id: ID(8), rollout }], proc: procDir, sessionsDir, cache: new Map(), share, now: T0 + 1 });
    eq([r.available, r.threads[ID(8)], r.threads[ID(42)]], [true, ['claudeBg'], ['detached']],
      'and a busy claude --bg session the shared scan names counts for the conversation whose rollout launched it');
    eq((r.running || []).map((x) => [x.thread, x.kind, x.job, x.name]), [[ID(42), 'command', '', ''], [ID(8), 'claudeBg', 'abcd1234', 'night suite']],
      'and is listed under it by the name the shared scan gives');

    const missing = path.join(tmp('no-plugin'), 'plans');
    left.scan({ proc: procDir, sessionsDir, share: path.join(missing, left.SHARE_DIR), now: T0 });
    eq(fs.existsSync(missing), false, 'without a plan directory, none is made');

    const workplan = require('../../src/workplan');
    const old = path.join(share, `${left.SHARE_FILE}.123.4.tmp`), fresh = path.join(share, `${left.SHARE_FILE}.123.5.tmp`);
    fs.writeFileSync(old, '{}');
    fs.writeFileSync(fresh, '{}');
    const day = Date.now() / 1000 - 2 * 24 * 3600;
    fs.utimesSync(old, day, day);
    fs.utimesSync(file, day, day);
    workplan.sweepOrphans({ dir: planDir, live: new Set() });
    eq([fs.existsSync(old), fs.existsSync(fresh), fs.existsSync(file)], [false, true, true],
      'the sweep removes a temporary file a killed writer left in that folder once it is a day old, and never the shared scan');
  });

  await section('which windows share', async () => {
    const { vscode } = fake.create();
    fake.install(vscode);
    const files = require('../../src/codex-files');
    const install = require('../../src/plugin-install');
    const { createCodexSource } = require('../../src/codex-source');
    const asked = [];
    const reader = { request: (op, args) => { asked.push([op, args]); return Promise.resolve({ available: true, threads: {} }); },
      refresh: () => Promise.resolve(false), threads: () => [], thread: () => null, state: () => null, hasPlan: () => false, busy: null };
    for (const procDir2 of ['/proc', procDir]) {
      const source = createCodexSource(vscode, { reader, scanLeft: () => true, leftEveryMs: 0, procDir: procDir2, claudeSessions: sessionsDir });
      await source._leftDone();
      source.dispose();
    }
    const shares = asked.filter(([op]) => op === 'leftRunning').map(([, a]) => a.share);
    eq(shares, [path.join(install.planDir(files.codexHome()), left.SHARE_DIR), ''],
      'a window shares its scan of the machine\'s own /proc, in a folder of the plan directory, and never one of a made-up /proc');
  });
  ok('the reads of a scan for work left running are checked');
};
