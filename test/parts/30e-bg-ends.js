// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The news a conversation gets of the `claude --bg` sessions it launched (src/bg-ends.js): each change of state written
 * down once whichever window saw it, nothing on the first look, nothing for a session the conversation stopped itself or
 * did not launch, nothing while notices are off, and sent by one window that has the conversation loaded through
 * src/detached-ends.js deliver().
 */
const fs = require('fs');
const path = require('path');

const ID = (n) => `01a1bbbb-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, tmp, root }) => {
  const be = require(path.join(root, 'src', 'bg-ends.js'));
  const de = require(path.join(root, 'src', 'detached-ends.js'));
  const shared = tmp('shared'), jobs = tmp('jobs'), sessions = tmp('sessions'), proc = tmp('proc'), rollouts = tmp('rollouts');
  let clock = Date.UTC(2026, 10, 22, 6, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const A = ID(1), B = ID(2);

  const rows = (list) => list.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const call = (id, cmd) => ({ timestamp: iso(clock), type: 'response_item',
    payload: { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd }) } });
  const output = (id, text) => ({ timestamp: iso(clock), type: 'response_item',
    payload: { type: 'function_call_output', call_id: id, output: `Chunk ID: 1\nWall time: 0.4 seconds\nProcess exited with code 0\nOutput:\n${text}` } });
  const launch = (call_id, job) => [call(call_id, `claude --bg "job ${job}"`), output(call_id, `backgrounded · ${job}\n  claude logs ${job}   show recent output\n`)];
  const fileA = path.join(rollouts, 'a.jsonl'), fileB = path.join(rollouts, 'b.jsonl');
  fs.writeFileSync(fileA, rows([...launch('a1', 'aaaa0001'), ...launch('a2', 'aaaa0002'), ...launch('a3', 'aaaa0003'), ...launch('a4', 'aaaa0004'),
    ...launch('a5', 'aaaa0005'), ...launch('a6', 'aaaa0006'), call('a9', 'grep -h backgrounded old.log'), output('a9', 'backgrounded · cccc0001\n')]));
  fs.writeFileSync(fileB, rows([...launch('b1', 'bbbb0001'), ...launch('b2', 'bbbb0002')]));
  const threads = [{ id: A, rollout: fileA }, { id: B, rollout: fileB }];

  /* A session's record, written the way Claude Code's daemon writes it, with a file time that moves with the clock. */
  let stamp = 0;
  const state = (job, fields) => {
    const file = path.join(jobs, job, 'state.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ id: job, state: 'working', name: `suite ${job}`, createdAt: iso(clock - 600e3), updatedAt: iso(clock), ...fields }));
    const t = clock / 1000 + (++stamp);
    fs.utimesSync(file, t, t);
  };
  /* Claude Code's record of the process running a session, and that process's stat file under the made-up /proc. */
  const running = (pid, job, start = '777', recordStart = start) => {
    fs.writeFileSync(path.join(sessions, `${pid}.json`), JSON.stringify({ pid, kind: 'bg', jobId: job, status: 'idle', procStart: recordStart }));
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (claude) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0\n`);
  };
  const cacheOne = new Map(), cacheTwo = new Map();
  const look = (cache, opts = {}) => be.update({ dir: shared, threads, cache, jobs, sessions, proc, now: clock, tail: (f) => fs.readFileSync(f, 'utf8')
    .trim().split('\n').reverse(), ...opts }).map((e) => [e.thread === A ? 'A' : e.thread === B ? 'B' : e.thread, e.job, e.kind]);
  const seen = () => JSON.parse(fs.readFileSync(path.join(shared, be.SEEN_FILE), 'utf8')).jobs;
  const written = () => (fs.existsSync(path.join(shared, be.ENDS_DIR)) ? fs.readdirSync(path.join(shared, be.ENDS_DIR)).filter((n) => n.endsWith('.json')).length : 0);

  for (const j of ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004', 'aaaa0006', 'bbbb0001', 'bbbb0002', 'cccc0001']) state(j, {});
  state('aaaa0005', { state: 'done', lastTerminalAt: iso(clock - 3 * 3600e3) });
  running(4100, 'bbbb0002');
  eq([be.update({ dir: path.join(shared, 'none'), threads, cache: new Map(), jobs, sessions, proc, now: clock }), fs.existsSync(path.join(shared, 'none'))],
    [[], false], 'with no shared folder, the plugin is not installed: nothing is read or written');
  eq([look(cacheOne), written()], [[], 0], 'the first look reports nothing, the sessions that ended before it included');
  eq(seen(), { aaaa0001: 'working', aaaa0002: 'working', aaaa0003: 'working', aaaa0004: 'working', aaaa0005: `done@${clock - 3 * 3600e3}`,
    aaaa0006: 'working', bbbb0001: 'working', bbbb0002: 'working' },
  'it notes the state of each session the two conversations launched, and not of one a command only printed back');
  eq(look(cacheTwo), [], 'and a second window\'s first look, with the states unchanged, has nothing to report either');

  clock += 10e3;
  state('aaaa0001', { state: 'done', lastTerminalAt: iso(clock - 2e3), output: { result: 'All 12 suites passed.' } });
  eq([look(cacheOne), look(cacheTwo), written()], [[['A', 'aaaa0001', 'done']], [], 1],
    'a session that finished is written down once, by whichever window saw it first, under the conversation that launched it');

  clock += 10e3;
  state('aaaa0002', { state: 'failed', lastTerminalAt: iso(clock - 1e3), detail: 'exit 3: 2 suites failed' });
  state('aaaa0003', { state: 'stopped', lastTerminalAt: iso(clock - 1e3) });
  state('aaaa0004', { state: 'stopped', lastTerminalAt: iso(clock - 1e3) });
  fs.appendFileSync(fileA, rows([call('a7', 'claude stop aaaa0004'), output('a7', 'stopped aaaa0004\n')]));
  eq(look(cacheOne), [['A', 'aaaa0002', 'failed'], ['A', 'aaaa0003', 'stopped']],
    'one that failed and one stopped from elsewhere are written down; one the conversation stopped with its own command is not');

  clock += 10e3;
  state('bbbb0001', { state: 'blocked', needs: 'Which region should the suite run in?' });
  eq(look(cacheOne), [], 'a session that says it waits for an answer, with no process behind it yet, is not reported');
  running(4200, 'bbbb0001');
  eq(look(cacheOne), [['B', 'bbbb0001', 'blocked']], 'with its process running it is: it waits for an answer');
  clock += 10e3;
  eq(look(cacheOne), [], 'and is not reported again while it waits for the same answer');
  state('bbbb0001', { state: 'blocked', needs: 'Which account should it use?' });
  eq(look(cacheOne), [['B', 'bbbb0001', 'blocked']], 'but is when it asks something else');

  clock += be.DEAD_AFTER_MS + 1000;
  eq(look(cacheOne), [['A', 'aaaa0006', 'died']],
    'a session whose record still says working long after its last write, with no process behind it, has died');
  eq(look(cacheOne), [], 'and is reported once');
  running(4100, 'bbbb0002', '778', '777');
  eq(look(cacheOne), [['B', 'bbbb0002', 'died']], 'a process record whose pid now belongs to a process started at another time is not the session\'s');

  clock += 10e3;
  fs.appendFileSync(fileA, rows([...launch('a8', 'aaaa0007'), ...launch('a9b', 'aaaa0008')]));
  state('aaaa0007', { state: 'done', lastTerminalAt: iso(clock - 5e3) });
  state('aaaa0008', { state: 'done', lastTerminalAt: iso(clock - 3600e3) });
  eq(look(cacheOne), [['A', 'aaaa0007', 'done']],
    'a session first found already over is reported if it finished after the last look, and not if it finished long before');

  clock += 10e3;
  state('bbbb0001', { state: 'done', lastTerminalAt: iso(clock - 1e3) });
  eq([look(cacheOne, { claim: false }), seen().bbbb0001], [[], `done@${clock - 1e3}`], 'while notices are off nothing is written down, but the state is noted');
  eq(look(cacheOne), [], 'so turning them on does not report what changed in the meantime');

  /* Sending: the files under ENDS_DIR, by src/detached-ends.js. */
  const asked = [];
  let loaded = [A];
  const ask = async (method, params) => {
    asked.push([method, params]);
    if (method === 'thread/loaded/list') return { outcome: 'done', result: { data: loaded } };
    if (method === 'thread/queue/add') return { outcome: 'done', result: {} };
    return { outcome: 'failed' };
  };
  let on = true;
  const one = de.createDetachedEnds({ dir: () => shared, ask, now: () => clock, enabled: () => on });
  const two = de.createDetachedEnds({ dir: () => shared, ask, now: () => clock, enabled: () => on });
  const queued = () => asked.filter(([m]) => m === 'thread/queue/add').map(([, p]) => [p.threadId === A ? 'A' : 'B', p.input[0].text]);
  const opts = { sub: be.ENDS_DIR, text: be.noticeText };
  const sent = await one.deliver(opts);
  const lines = queued().map(([t, text]) => [t, text.split('\n')]);
  eq([sent, await two.deliver(opts), lines.length, lines[0] && lines[0][0]], [1, 0, 1, 'A'],
    'a window that has the conversation loaded sends one notice for all of its sessions\' news, and another window then has none to send');
  const at = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  eq(lines[0][1], [
    'Codex Plus notice, not a message from the user: news of `claude --bg` sessions this conversation started.',
    `- "suite aaaa0001" (aaaa0001) finished at ${at(Date.UTC(2026, 10, 22, 6, 0, 8))}. Its result: All 12 suites passed.`,
    `- "suite aaaa0002" (aaaa0002) failed at ${at(Date.UTC(2026, 10, 22, 6, 0, 19))}: exit 3: 2 suites failed`,
    `- "suite aaaa0003" (aaaa0003) was stopped at ${at(Date.UTC(2026, 10, 22, 6, 0, 19))}`,
    '- "suite aaaa0006" (aaaa0006) stopped running before it finished: its process is gone',
    `- "suite aaaa0007" (aaaa0007) finished at ${at(clock - 10e3 - 5e3)}`,
    '`claude logs <id>` shows a session\'s output, and `claude attach <id>` answers one that is waiting.'],
  'naming each session, what became of it, its result or error, and how to read its output or answer it');
  eq([written(), queued().length], [3, 1], 'the news of a conversation no window here has loaded waits');
  on = false;
  eq([await one.deliver(opts), written()], [0, 0], 'and is dropped once notices are off');

  const long = be.noticeText([{ job: 'dddd0001', kind: 'blocked', name: 'n'.repeat(100), needs: 'q'.repeat(400), goneAt: 1 }]);
  eq(/^- "n{77}\.\.\." \(dddd0001\) is waiting for an answer: q{297}\.\.\.$/.test(long.split('\n')[1]), true,
    'a name is cut at 80 characters and a question, result or error at 300');

  /* Which records say a session's process is running. */
  const live = tmp('live');
  fs.writeFileSync(path.join(live, `${process.pid}.json`), JSON.stringify({ pid: process.pid, kind: 'bg', jobId: 'eeee0001' }));
  fs.writeFileSync(path.join(live, '999999999.json'), JSON.stringify({ pid: 999999999, kind: 'bg', jobId: 'eeee0002' }));
  fs.writeFileSync(path.join(live, '1.json'), JSON.stringify({ pid: 1, kind: 'interactive', sessionId: ID(9) }));
  eq([...be.liveJobs(live, path.join(proc, 'none'))], ['eeee0001'],
    'where /proc cannot be read, a record counts while a process with its pid exists, and only a claude --bg session\'s');
};
