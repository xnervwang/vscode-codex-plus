// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * An idle conversation shows as working while something it started is still running, and goes back to idle when that
 * ends: a sub-agent, a background command in Codex, a detached shell, a `codex exec` or `claude -p` worker, or a
 * `claude --bg` session. The row's hover names what is running.
 *
 * Nothing here reads the processes or the Claude Code sessions of the machine it runs on: /proc and the sessions
 * folder are made up for the test.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ ok, bad, eq, tmp, root }) => {
  const section = async (what, fn) => {
    try { await fn(); } catch (e) { bad(`${what}: ${(e && e.message) || e}`); }
  };
  const { vscode, control } = fake.create();
  fake.install(vscode);

  /* A made-up /proc: stat, cmdline and environ for each process. */
  const procDir = tmp('proc');
  const put = (pid, { comm, state = 'S', ppid = 1, start = 100, argv, env = {} }) => {
    const d = path.join(procDir, String(pid));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'stat'), `${pid} (${comm}) ${state} ${ppid} ${Array(17).fill(0).join(' ')} ${start} 0 0\n`);
    fs.writeFileSync(path.join(d, 'cmdline'), (argv || [comm]).join('\0') + '\0');
    fs.writeFileSync(path.join(d, 'environ'), Object.entries({ HOME: '/h', ...env }).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
  };
  const gone = (pid) => fs.rmSync(path.join(procDir, String(pid)), { recursive: true, force: true });
  const T = (k) => ID(100 + k);
  put(10, { comm: 'codex', argv: ['/x/codex', 'app-server'] });
  put(11, { comm: 'bash', ppid: 10, argv: ['/bin/bash', '-lc', 'npm run watch'], env: { CODEX_THREAD_ID: T(1) } });   // background terminal
  put(12, { comm: 'node', ppid: 10, argv: ['node', 'mcp.js'] });                                                    // an MCP server
  put(20, { comm: 'bash', argv: ['bash', '-c', 'make all'], env: { CODEX_THREAD_ID: T(2) } });                       // setsid nohup bash -c
  put(21, { comm: 'timeout', argv: ['timeout', '600', 'make'], env: { CODEX_THREAD_ID: T(3) } });
  put(30, { comm: 'tail', argv: ['tail', '-F', 'x.log'], env: { CODEX_THREAD_ID: T(4) } });
  put(31, { comm: 'java', argv: ['/jdk/bin/java', '-jar', 'server.jar'], env: { CODEX_THREAD_ID: T(4) } });
  put(32, { comm: 'bash', argv: ['mfns-holder:x', '-c', 'sleep infinity & wait'], env: { CODEX_THREAD_ID: T(4) } });
  put(33, { comm: 'bash', state: 'Z', argv: ['bash'], env: { CODEX_THREAD_ID: T(4) } });
  put(34, { comm: 'codex', argv: ['codex', 'amzn', '__otel-server'], env: { CODEX_THREAD_ID: T(4) } });
  put(35, { comm: 'Xvfb', argv: ['Xvfb', ':99'], env: { CODEX_THREAD_ID: T(4) } });
  put(36, { comm: 'bash', argv: ['bash', '-c', 'x'], env: { CODEX_THREAD_ID: 'not-an-id' } });                       // launcher not known
  put(37, { comm: 'bash', argv: ['bash', '-c', 'x'] });                                                               // no launcher at all
  put(40, { comm: 'codex', argv: ['codex', 'exec', '--json', '-'], env: { CODEX_THREAD_ID: T(5) } });                // a codex exec worker
  put(41, { comm: 'codex', ppid: 40, argv: ['codex', '-c', 'x=y'], env: { CODEX_THREAD_ID: T(5) } });                // its own helper
  put(42, { comm: 'sleep', ppid: 40, argv: ['sleep', '9'], env: { CODEX_THREAD_ID: ID(999) } });                    // its own command
  put(43, { comm: 'node', ppid: 40, argv: ['node', 'helper.js'], env: { CODEX_THREAD_ID: T(5) } });                  // inherited from it
  put(50, { comm: 'claude', start: 200, argv: ['claude', '-p', 'go'], env: { CODEX_THREAD_ID: T(6) } });             // a claude -p worker
  put(51, { comm: 'bash', ppid: 50, argv: ['/bin/bash', '-c', 'sleep 9'], env: { CODEX_THREAD_ID: T(6) } });         // its Bash tool's command
  put(52, { comm: 'claude', start: 200, argv: ['claude', '-p', 'go'], env: { CODEX_THREAD_ID: T(7) } });             // a worker waiting for input
  put(60, { comm: 'claude', argv: ['claude', 'bg-spare'] });                                                          // a claude --bg session
  const sessionsDir = tmp('claude-sessions');
  const record = (pid, o) => fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({ pid, procStart: '200', ...o }));
  record(50, { sessionId: ID(500), kind: 'interactive', entrypoint: 'sdk-cli', status: 'busy' });
  record(52, { sessionId: ID(502), kind: 'interactive', entrypoint: 'sdk-cli', status: 'idle' });
  record(60, { sessionId: ID(600), kind: 'bg', entrypoint: 'cli', status: 'busy', jobId: 'abcd1234', procStart: '100' });

  let left = null;
  await section('the /proc reading', async () => {
    left = require('../../src/left-running');
    const snap = left.snapshot({ proc: procDir, records: left.readRecords(sessionsDir, { proc: procDir }) });
    const got = Object.fromEntries([...snap.threads].map(([id, kinds]) => [id, [...kinds].sort()]));
    eq(snap.available, true, 'a /proc that can be read is reported as such');
    eq([got[T(1)], got[T(2)], got[T(3)], got[T(5)], got[T(6)]], [['command'], ['detached'], ['detached'], ['codexExec'], ['claudeWorker']],
      'a command under Codex, a detached shell, a timeout, a codex exec worker and a running claude -p worker each count for the conversation they carry');
    eq([got[T(4)], got[T(7)]], [undefined, undefined],
      'a forgotten tail -F, a Java server, an mfns holder, a zombie, codex\'s own OpenTelemetry server, Xvfb and a worker waiting for input do not');
    eq(got[ID(999)], ['command'], 'a codex exec\'s own command counts for its own thread, and its helpers not for the conversation that started it');
    eq(Object.keys(got).filter((id) => !/^01a1f0f0/.test(id)), [], 'a process whose launcher id is missing or not an id counts for nobody');
    const none = left.snapshot({ proc: path.join(procDir, 'none'), records: [] });
    eq([none.available, none.threads.size], [false, 0], 'where there is no /proc, nothing is found and that is said');
  });

  /* A rollout where one command launched a claude --bg session and another printed the output of an older launch. */
  const rolloutDir = tmp('launches');
  const rows = (list) => list.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const call = (id, cmd) => ({ timestamp: new Date().toISOString(), type: 'response_item',
    payload: { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd }) } });
  const output = (id, text) => ({ timestamp: new Date().toISOString(), type: 'response_item',
    payload: { type: 'function_call_output', call_id: id, output: `Chunk ID: 1\nWall time: 0.4 seconds\nProcess exited with code 0\nOutput:\n${text}` } });
  const launchFile = path.join(rolloutDir, 'rollout-launch.jsonl');
  fs.writeFileSync(launchFile, rows([
    call('c1', 'claude --bg "run the suite" 2>&1'), output('c1', 'backgrounded · abcd1234\n  claude attach abcd1234   open in this terminal\n'),
    call('c2', 'grep -h backgrounded old.log'), output('c2', 'backgrounded · eeee5555\n'),
  ]));
  await section('the claude --bg launches in a rollout', async () => {
    const cache = new Map();
    eq([...left.launches(launchFile, cache)], ['abcd1234'], 'a launch is read from the output of a command that ran claude --bg, and not from one that printed it back');
    fs.appendFileSync(launchFile, rows([call('c3', 'cd /w && claude --bg "second"'), output('c3', 'backgrounded · 1234abcd\n')]));
    eq([...left.launches(launchFile, cache)].sort(), ['1234abcd', 'abcd1234'], 'and the file is read on from where it was left');
  });

  await section('the worker\'s pass', async () => {
    const threads = [{ id: T(8), kind: 'user', rollout: launchFile, updatedMs: Date.now() }, { id: T(1), kind: 'user', rollout: '', updatedMs: Date.now() }];
    const r = left.leftRunning({ threads, proc: procDir, sessionsDir, cache: new Map() });
    eq([r.available, r.threads[T(8)], r.threads[T(1)]], [true, ['claudeBg'], ['command']], 'a busy claude --bg session counts for the conversation whose command launched it');
    record(60, { sessionId: ID(600), kind: 'bg', entrypoint: 'cli', status: 'idle', jobId: 'abcd1234', procStart: '100' });
    const later = left.leftRunning({ threads, proc: procDir, sessionsDir, cache: new Map() });
    eq(later.threads[T(8)], undefined, 'and stops counting once that session is idle');
    record(60, { sessionId: ID(600), kind: 'bg', entrypoint: 'cli', status: 'busy', jobId: 'abcd1234', procStart: '100' });
  });

  /* Codex's own background commands as the rollout records them, which is all a window without /proc has. */
  await section('the rollout\'s open commands', async () => {
    const files = require('../../src/codex-files');
    const f = path.join(rolloutDir, 'rollout-open.jsonl');
    const at = (ms) => new Date(Date.now() + ms).toISOString();
    const base = [
      { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: Math.floor(Date.now() / 1000) } },
      { timestamp: at(1), type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-test' } },
      call('w1', 'npm run watch'),
      { timestamp: at(2), type: 'response_item', payload: { type: 'function_call_output', call_id: 'w1', output: 'Chunk ID: 2\nWall time: 0.5 seconds\nProcess running with session ID 61\nOutput:\n' } },
      { timestamp: at(3), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', completed_at: Math.floor(Date.now() / 1000) } },
    ];
    fs.writeFileSync(f, rows(base));
    const open = files.rolloutState(f);
    fs.appendFileSync(f, rows([{ timestamp: at(9), type: 'event_msg', payload: { type: 'item_completed', thread_id: 'x', turn_id: 't1',
      item: { type: 'CommandExecution', id: 'w1', status: 'completed', exit_code: 0 } } }]));
    const closed = files.rolloutState(f);
    eq([open.working, open.openCommands, closed.openCommands], [false, 1, 0],
      'a command still running when its turn ended is open until Codex writes its item_completed, which it does after the turn as well');
  });

  /* Which state wins, in Claude Code Plus's order: waiting for the user, then running, then unread. */
  await section('the state with work left running', async () => {
    const { conversationOf } = require('../../src/codex-source');
    const thread = { id: T(9), title: 'x', updatedMs: Date.now() - 600e3 };
    const st = (o) => ({ working: false, startedMs: Date.now() - 700e3, endedMs: Date.now() - 600e3, lastActivityMs: Date.now() - 600e3, ...o });
    const of = (o, left2) => conversationOf(thread, { unread: new Set(o.unread ? [T(9)] : []), openHere: new Set(), state: st(o.st || {}),
      waiting: o.waiting || null, left: left2 });
    const idle = of({}, ['command']);
    eq([idle.state, idle.working, idle.left, idle.running, idle.ownState], ['working', false, ['command'], true, 'idle'],
      'an idle conversation with a background command still running is shown as working, while its own turn is still not running');
    const unread = of({ unread: true }, ['subagent']);
    eq([unread.state, unread.ownState], ['working', 'unread'], 'working wins over unread, which is kept for when the work ends');
    eq([of({ waiting: { decide: 1 } }, ['command']).state, of({ st: { askedMs: Date.now() - 650e3 } }, ['command']).state], ['prompt', 'prompt'],
      'waiting for the user wins over it');
    eq([of({}, []).state, of({ unread: true }, []).state, of({}, undefined).state], ['idle', 'unread', 'idle'], 'and with nothing left running, it is what it was');
  });

  /* The source with a real reader: a sub-agent still running under an idle conversation, then processes in the made-up
     /proc. */
  await section('the source', async () => {
    const home = tmp('home');
    const parent = fixture.threadId();
    const now = Date.now();
    const made = fixture.codexHome(home, [
      { id: parent, title: 'Parent', startMs: now - 300e3, turns: [{}] },
      { title: 'Sub', source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent, agent_nickname: 'scout' } } }), threadSource: 'subagent',
        startMs: now - 120e3, turns: [{ running: true }] },
      { title: 'Other', startMs: now - 200e3, turns: [{}] },
    ]);
    const files = require('../../src/codex-files');
    files.setCodexHome(home);
    process.env.CODEX_HOME = home;
    const { CodexReader } = require('../../src/codex-reader');
    const { createCodexSource } = require('../../src/codex-source');
    const reader = new CodexReader({ inline: true });
    let scan = true;
    let running = [];
    const patching = { panelThreads: () => [], approvalsOf: () => null, sidebarThread: () => '', runningCommands: (id) => running.filter((c) => !id || c.thread === id) };
    const source = createCodexSource(vscode, { reader, patching, scanLeft: () => scan, leftEveryMs: 0, procDir, claudeSessions: sessionsDir });
    try {
      const listed = async () => { await source._poll({ force: true }); await source._leftDone(); return new Map((await source.listConversations()).map((c) => [c.title, c])); };
      let by = await listed();
      eq([by.get('Parent').state, by.get('Parent').left, by.get('Other').state], ['working', ['subagent'], 'idle'],
        'a conversation whose sub-agent is still running is shown as working, and the others are not');
      const [, sub, other] = made;
      fs.appendFileSync(sub.rollout, rows([{ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'x', completed_at: Math.floor(Date.now() / 1000) } }]));
      put(70, { comm: 'bash', argv: ['bash', '-c', 'long job'], env: { CODEX_THREAD_ID: other.id } });
      running = [{ thread: parent, command: 'npm run watch', startedMs: now }];
      by = await listed();
      eq([by.get('Parent').state, by.get('Parent').left, by.get('Other').state, by.get('Other').left], ['working', ['command'], 'working', ['detached']],
        'once the sub-agent ends, a command still running in this window\'s Codex, and a shell detached by another conversation, keep each one working');
      put(71, { comm: 'bash', argv: ['bash', '-c', 'its own'], env: { CODEX_THREAD_ID: sub.id } });
      running = [];
      by = await listed();
      eq([by.get('Parent').state, by.get('Parent').left], ['working', ['detached']], 'a shell a sub-agent detached counts for the conversation above it');
      gone(70); gone(71);
      by = await listed();
      eq([by.get('Parent').state, by.get('Other').state], ['idle', 'idle'], 'and when they end, both are idle again');
      put(70, { comm: 'bash', argv: ['bash', '-c', 'long job'], env: { CODEX_THREAD_ID: other.id } });
      scan = false;
      by = await listed();
      eq(by.get('Other').state, 'idle', 'a window that must not scan, such as one replaced by a newer build, finds nothing');
      gone(70);
    } finally { source.dispose(); reader.dispose(); }
  });

  /* The session list draws a solid green dot for this. */
  await section('the session list', async () => {
    const { SessionsModel, lookKey } = require('../../src/sessions-view');
    const conv = { sessionId: ID(1), state: 'working', ownState: 'unread', working: false, left: ['command', 'subagent'] };
    eq([lookKey(conv, false), lookKey({ ...conv, left: [], working: true }, false)], ['working', 'workingElsewhere'],
      'work left running is drawn as a solid green dot, not as a turn running in another window');
    const threads = [{ id: ID(1), title: 'Busy after its turn', kind: 'user', parent: '', cwd: '/w', section: '', createdMs: 1, updatedMs: 2 }];
    const model = new SessionsModel(vscode, { memory: { openThreads: () => [], recentlyClosed: () => [], frontAt: () => 0 }, memento: fake.memento(),
      reader: { threads: () => threads, sections: () => new Map(), state: () => ({}), thread: () => null },
      stateOf: () => conv, settings: () => ({ recentClosedSessions: 10 }) }).model();
    const row = model.groups.flatMap((g) => g.rows).find((r) => r.id === ID(1));
    eq([row.dot, row.unread, row.running], ['working', true, 'A background command is still running\nA sub-agent is still running'],
      'its row is green, still marked unread for its menu, and names what is running');
    const { createDom } = require('../fake-dom');
    const dom = createDom();
    const page = dom.el('div', { attrs: { id: 'root' } });
    dom.setBody(dom.el('body', { kids: [page] }));
    const listeners = {};
    const sandbox = Object.assign({}, dom.sandbox, { window: { innerWidth: 400, innerHeight: 800, getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
      addEventListener: (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); } }, Map, Set, Proxy, Promise,
    acquireVsCodeApi: () => ({ postMessage() {}, getState: () => null, setState() {} }) });
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(root, 'src', 'page', 'sessions-page.js'), 'utf8'), sandbox);
    for (const fn of listeners.message) fn({ data: { type: 'model', model } });
    const r = page.querySelector(`.cp-row[data-id="${ID(1)}"]`);
    const hover = page.querySelector('.cp-hover');
    if (!r || !hover) { bad('the session page drew no row or no hover box'); return; }
    r.bubble('mouseover');
    dom.runTimers();
    eq(/A background command is still running\nA sub-agent is still running/.test(hover.textContent), true, 'and the hover box says so');
  });

  await section('the extension', async () => {
    const ext = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
    eq(/scanLeft: \(\) => !standsDown\(\)/.test(ext), true, 'a window that stands down for a newer build, or for an uninstall, does not scan');
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    eq(/still running after (its|the) turn/i.test(readme), true, 'the README says so in its features');
  });
  if (left) ok('the module that reads /proc for work left running loads');
};
