// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Where else a conversation is open, from the processes holding Codex's writer lock on it (src/writer-locks.js): the
 * held locks /proc/locks lists, what each holder is (another VS Code window's app-server, a terminal, a codex exec),
 * and the source leaving out this window's own app-server.
 *
 * /proc is made up for the test; the lock files are real, so that their device and inode are the ones /proc/locks
 * would give.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const ID = (n) => `01a1e1e1-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ bad, eq, note, tmp }) => {
  const section = async (what, fn) => {
    try { await fn(); } catch (e) { bad(`${what}: ${(e && e.message) || e}`); }
  };
  const locks = require('../../src/writer-locks');
  const left = require('../../src/left-running');

  await section('the locks held', async () => {
    const held = locks.heldLocks([
      '1: FLOCK  ADVISORY  WRITE 42269 103:01:282607526 0 EOF',
      '2: -> FLOCK  ADVISORY  WRITE 5000 103:01:282607526 0 EOF',
      '3: FLOCK  ADVISORY  READ  56937 103:01:548274868 0 EOF',
      '4: POSIX  ADVISORY  WRITE 90341 fd:00:92943043 0 EOF',
      '5: OFDLCK ADVISORY  WRITE -1 103:01:777 0 EOF',
      'not a lock line',
    ].join('\n'));
    eq([...held], [['259:1:282607526', [42269]], ['253:0:92943043', [90341]]],
      'a write lock held is listed under its device and inode, and one waited for, a read lock, or one with no process is not');
  });

  /* The made-up /proc gives a process's folder and terminal as symbolic links, which a test on Windows may not make;
     no Windows has /proc anyway. */
  if (process.platform === 'win32') { note('holders of the writer locks: a made-up /proc needs symbolic links, and Windows has no /proc'); return; }

  /* A made-up /proc: stat, cmdline, environ, cwd and the terminal on fd 0 for each process. */
  const procDir = tmp('proc');
  const put = (pid, { comm, ppid = 1, start = 100, argv, env = {}, cwd = '', tty = '' }) => {
    const d = path.join(procDir, String(pid));
    fs.mkdirSync(path.join(d, 'fd'), { recursive: true });
    fs.writeFileSync(path.join(d, 'stat'), `${pid} (${comm}) S ${ppid} 0 0 ${Array(15).fill(0).join(' ')} ${start} 0 0\n`);
    fs.writeFileSync(path.join(d, 'cmdline'), (argv || [comm]).join('\0') + '\0');
    fs.writeFileSync(path.join(d, 'environ'), Object.entries({ HOME: '/h', ...env }).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
    if (cwd) fs.symlinkSync(cwd, path.join(d, 'cwd'));
    if (tty) fs.symlinkSync(tty, path.join(d, 'fd', '0'));
  };
  const home = tmp('codex-home');
  const lockDir = path.join(home, locks.LOCK_DIR);
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = (name) => { const f = path.join(lockDir, name); fs.writeFileSync(f, ''); return f; };
  /* A /proc/locks line for `file` held by `pid`, with the device in hex as Linux writes it. */
  const line = (n, pid, file, waiting = false) => {
    const [major, minor, ino] = locks.keyOf(file).split(':');
    const dev = `${Number(major).toString(16).padStart(2, '0')}:${Number(minor).toString(16).padStart(2, '0')}`;
    return `${n}: ${waiting ? '-> ' : ''}FLOCK  ADVISORY  WRITE ${pid} ${dev}:${ino} 0 EOF`;
  };
  const w = path.join(os.homedir(), 'w');
  put(90, { comm: 'node', argv: [path.join(os.homedir(), '.vscode-server/cli/servers/Stable-x/server/node'), '--dns-result-order=ipv4first', 'out/bootstrap-fork', '--type=extensionHost'] });
  put(100, { comm: 'codex', ppid: 90, argv: ['/ext/bin/codex', 'app-server', '--analytics-default-enabled'], cwd: w });
  put(200, { comm: 'codex', argv: ['codex', 'resume', ID(2)], cwd: w, tty: '/dev/pts/3', env: { TMUX: '/tmp/tmux-1/default,1,0' } });
  put(210, { comm: 'codex', argv: ['codex'], cwd: '/srv/x', tty: '/dev/pts/4', env: { TERM_PROGRAM: 'vscode' } });
  put(300, { comm: 'codex', argv: ['codex', 'exec', '--json', '-'], cwd: '/srv/x' });
  put(310, { comm: 'codex', argv: ['codex', 'mcp-server'] });
  const files = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => lockFile(`${ID(n)}.lock`));
  const coordination = lockFile('.coordination.lock');
  fs.writeFileSync(path.join(procDir, 'locks'), [
    line(1, 100, files[0]), line(2, 200, files[1]), line(3, 210, files[2]), line(4, 300, files[3]), line(5, 310, files[4]),
    line(6, 999, files[5]), line(7, 200, files[6], true), line(8, 300, coordination),
  ].join('\n') + '\n');

  await section('who holds them', async () => {
    const all = left.processes(procDir);
    const argvOf = (pid) => { try { return fs.readFileSync(path.join(procDir, String(pid), 'cmdline'), 'latin1').split('\0'); } catch (_) { return []; } };
    const found = locks.holders({ codexHome: home, proc: procDir, all, argvOf, isExec: left.isCodexExec });
    eq(found.map((h) => [h.thread, h.pid, h.kind, h.label]), [
      [ID(1), 100, 'vscode', 'another VS Code window in ~/w'],
      [ID(2), 200, 'terminal', 'terminal pts/3 in ~/w'],
      [ID(3), 210, 'terminal', 'terminal pts/4 in /srv/x'],
      [ID(4), 300, 'exec', 'codex exec in /srv/x'],
      [ID(5), 310, 'other', 'codex process 310'],
    ], 'an app-server under a VS Code extension host, the terminal interface, a codex exec and anything else that holds one are each told apart; a lock file nobody holds, one whose holder is gone, one only waited for and Codex\'s own coordination lock are not listed');
    const by = new Map(found.map((h) => [h.thread, h]));
    eq([by.get(ID(2)).detail, by.get(ID(3)).detail.slice(-1), by.get(ID(1)).ancestors],
      [['process 200', `folder ${w}`, `command codex resume ${ID(2)}`, 'in tmux'], ['in a terminal of VS Code'], [90]],
      'the hover lines name the process, its folder, its command and the terminal it runs in, and the ancestors are kept');
    eq(found.every(locks.isHolder), true, 'each holder is one a window accepts from a shared scan');
    eq(locks.holders({ codexHome: home, proc: tmp('no-proc'), all, argvOf, isExec: left.isCodexExec }), [], 'without /proc/locks nothing is found');
    eq(locks.holders({ codexHome: tmp('no-locks'), proc: procDir, all, argvOf, isExec: left.isCodexExec }), [], 'and nothing for a Codex home with no lock folder');
  });

  await section('the scan lists them', async () => {
    const sessionsDir = tmp('claude-sessions');
    const scan = left.scan({ proc: procDir, sessionsDir, codexHome: home });
    eq(scan.holders.map((h) => [h.thread, h.kind]), [[ID(1), 'vscode'], [ID(2), 'terminal'], [ID(3), 'terminal'], [ID(4), 'exec'], [ID(5), 'other']],
      'a scan given the Codex home lists who holds its conversations open');
    eq(left.scan({ proc: procDir, sessionsDir }).holders, [], 'and one given none lists nobody');
  });

  /* The source: this window's own app-server is a process under this extension host, and is left out. */
  await section('the source', async () => {
    const { vscode } = fake.create();
    fake.install(vscode);
    const chome = tmp('home-source');
    const now = Date.now();
    const made = fixture.codexHome(chome, [{ title: 'Here', startMs: now - 300e3, turns: [{}] }, { title: 'In a terminal', startMs: now - 200e3, turns: [{}] }]);
    const sdir = path.join(chome, locks.LOCK_DIR);
    fs.mkdirSync(sdir, { recursive: true });
    const [here, there] = made.map((m) => { const f = path.join(sdir, `${m.id}.lock`); fs.writeFileSync(f, ''); return f; });
    put(400, { comm: 'codex', ppid: process.pid, argv: ['/ext/bin/codex', 'app-server'], cwd: w });
    put(410, { comm: 'codex', argv: ['codex', 'resume'], cwd: w, tty: '/dev/pts/7' });
    fs.writeFileSync(path.join(procDir, 'locks'), [line(1, 400, here), line(2, 410, there)].join('\n') + '\n');
    const cf = require('../../src/codex-files');
    cf.setCodexHome(chome);
    process.env.CODEX_HOME = chome;
    const { CodexReader } = require('../../src/codex-reader');
    const { createCodexSource } = require('../../src/codex-source');
    const reader = new CodexReader({ inline: true });
    const patching = { panelThreads: () => [], approvalsOf: () => null, sidebarThread: () => '', runningCommands: () => [] };
    const source = createCodexSource(vscode, { reader, patching, scanLeft: () => true, leftEveryMs: 0, procDir, claudeSessions: tmp('cs') });
    try {
      let changes = 0;
      const sub = source.onDidChangeConversations(() => { changes += 1; });
      await source._poll({ force: true });
      await source._leftDone();
      eq([source.holdersOf(made[0].id), source.holdersOf(made[1].id).map((h) => [h.pid, h.kind, h.label])],
        [[], [[410, 'terminal', 'terminal pts/7 in ~/w']]],
        'the app-server under this extension host is this window\'s own and is left out; the terminal interface holding the other is listed');
      fs.writeFileSync(path.join(procDir, 'locks'), line(1, 400, here) + '\n');
      changes = 0;
      await source._poll({ force: true });
      await source._leftDone();
      eq([source.holdersOf(made[1].id), changes > 0], [[], true], 'once the terminal lets go, nobody else holds it, and the views are told');
      sub.dispose();
    } finally { source.dispose(); reader.dispose(); }
  });
};
