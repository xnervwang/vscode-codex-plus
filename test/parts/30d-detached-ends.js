// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The notice a conversation gets once a command it left running detached is no longer running (src/detached-ends.js):
 * written down once whichever window saw it go, sent by a window that has the conversation loaded, several ends in one
 * notice, kept for a day for a conversation loaded nowhere, and not at all while notices are off; and only for a program a
 * command of the conversation names (ranBy).
 */
const fs = require('fs');
const path = require('path');

const ID = (n) => `01a1dede-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, tmp, root }) => {
  const de = require(path.join(root, 'src', 'detached-ends.js'));
  const shared = tmp('shared');
  let clock = Date.UTC(2026, 10, 18, 6, 0, 0);
  const asked = [];
  let loaded = [ID(1)];
  let queueAnswer = { outcome: 'done', result: {} };
  const ask = async (method, params) => {
    asked.push([method, params]);
    if (method === 'thread/loaded/list') return { outcome: 'done', result: { data: loaded } };
    if (method === 'thread/queue/add') return queueAnswer;
    return { outcome: 'failed', reason: 'not served' };
  };
  let on = true;
  const make = () => de.createDetachedEnds({ dir: () => shared, ask, now: () => clock, enabled: () => on });
  const a = make(), b = make();
  const job = (thread, pid, cmd, startMs = clock - 300e3) => ({ thread, pid, start: String(pid * 10), startMs, cmd });
  const scan = (list, available = true) => ({ available, threads: {}, detached: list });
  const written = () => (fs.existsSync(path.join(shared, de.DIR)) ? fs.readdirSync(path.join(shared, de.DIR)).filter((n) => n.endsWith('.json')).sort() : []);
  const queued = () => asked.filter(([m]) => m === 'thread/queue/add').map(([, p]) => [p.threadId, p.input[0].text]);

  const one = job(ID(1), 4100, 'python3 driver.py --all');
  const two = job(ID(1), 4200, '/jdk/bin/java -jar server.jar');
  const other = job(ID(2), 4300, 'make release');
  a.observe(scan([one, two, other]));
  b.observe(scan([one, two, other]));
  eq([a.observe(scan([one, two, other])), written()], [0, []], 'a command still listed is not an end');
  eq(a.observe(scan([two, other], false)), 0, 'a scan that could not read /proc ends nothing');
  clock += 10e3;
  eq([a.observe(scan([two, other])), b.observe(scan([two, other])), written()], [1, 0, [`${ID(1)}.4100.41000.json`]],
    'one gone from a later scan is written down once, by whichever window saw it first');

  asked.length = 0;
  eq([await a.deliver(), queued()], [1, [[ID(1), 'Codex Plus notice, not a message from the user: a command this conversation left running detached '
    + 'is no longer running. Its exit code cannot be known; look at its output if you need the result.\n'
    + '- python3 driver.py --all (pid 4100, started 2026-11-18 05:55 UTC, ran for about 5m 10s)']]],
  'a window that has the conversation loaded queues one notice, naming the command, its pid and when it started, and saying the exit code '
    + 'cannot be known');
  eq([written(), await b.deliver()], [[], 0], 'and the end is gone once sent, so another window sends nothing');

  clock += 10e3;
  a.observe(scan([other]));
  asked.length = 0;
  eq([await a.deliver(), queued(), written()], [0, [], [`${ID(1)}.4200.42000.json`]],
    'an end within a minute of the last notice to that conversation waits');
  a.observe(scan([other, job(ID(1), 4400, 'sleep 600')]));
  clock += 30e3;
  a.observe(scan([other]));
  clock += 30e3;
  asked.length = 0;
  eq([await a.deliver(), queued().map(([t, text]) => [t, text.split('\n')])], [1, [[ID(1), [
    'Codex Plus notice, not a message from the user: 2 commands this conversation left running detached are no longer running. Their exit '
      + 'codes cannot be known; look at their output if you need the results.',
    '- /jdk/bin/java -jar server.jar (pid 4200, started 2026-11-18 05:55 UTC, ran for about 5m 20s)',
    '- sleep 600 (pid 4400, started 2026-11-18 05:55 UTC, ran for about 5m 30s)']]]],
  'and goes in the next one, with every other end written meanwhile');

  a.observe(scan([]));
  clock += 120e3;
  asked.length = 0;
  eq([await a.deliver(), queued(), written()], [0, [], [`${ID(2)}.4300.43000.json`]],
    'a conversation loaded in no window here keeps its notice');
  loaded = [ID(2)];
  queueAnswer = { outcome: 'failed', reason: 'busy' };
  eq([await a.deliver(), written()], [0, [`${ID(2)}.4300.43000.json`]], 'one Codex refuses is put back for the next pass');
  queueAnswer = { outcome: 'done', result: {} };
  clock += de.KEEP_MS + 1;
  eq([await a.deliver(), written()], [0, []], 'and after a day it is dropped');

  a.observe(scan([job(ID(1), 4500, 'sleep 9')]));
  on = false;
  eq([a.observe(scan([])), written()], [0, []], 'with notices off, an end is not written down');
  on = true;

  /* ranBy reads a rollout's lines newest first, as files.tailLines gives them. */
  const started = Date.UTC(2026, 10, 18, 7, 0, 0);
  const call = (cmd, ms) => JSON.stringify({ timestamp: new Date(ms).toISOString(), type: 'response_item',
    payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }), call_id: `c${ms}` } });
  const meta = JSON.stringify({ timestamp: new Date(started - 3600e3).toISOString(), type: 'session_meta', payload: {} });
  const lines = [call('brazil-build release', started - 60e3), call('setsid ./serve.sh --port 9000 &', started - 120e3),
    call('python3 driver.py --all &', started - 40 * 60e3), meta];
  const telemetry = '/home/u/.toolbox/tools/toolbox/2.1/toolbox-telemetry -t brazilcli --payload x';
  eq([de.ranBy(lines, telemetry, started), de.ranBy(lines, 'bash ./serve.sh --port 9000', started),
    de.ranBy(lines, 'setsid -f timeout 300 ./serve.sh', started)], [false, true, true],
  'a program no command names, such as the usage uploader Builder Toolbox leaves after a brazil command, is not the conversation\'s, '
    + 'and one a command names is, past launchers and their flags');
  eq([de.ranBy(lines, 'python3 driver.py --all', started), de.ranBy(lines, 'python3 driver.py --all', 0)], [false, true],
    'a command from more than half an hour before the program started does not count, unless the start time is unknown');
  eq([de.ranBy(null, 'sleep 600', started), de.ranBy([], 'sleep 600', started), de.ranBy(lines, 'bash', started)], [false, true, true],
    'a conversation with no rollout yet has started nothing; one whose rollout cannot be read, or a bare shell, is given the notice');

  const quiet = de.createDetachedEnds({ dir: () => shared, ask, now: () => clock, ran: (thread, cmd) => !cmd.includes('telemetry') });
  quiet.observe(scan([job(ID(1), 4600, telemetry), job(ID(1), 4700, 'sleep 60')]));
  eq([quiet.observe(scan([])), written()], [1, [`${ID(1)}.4700.47000.json`]], 'and only an end ranBy accepts is written down');
};
