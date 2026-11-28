// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A conversation renaming itself (src/retitle.js): the work plan's set_title puts <key>.json in retitle/, one window
 * renames it to <key>.claimed, checks the call in the conversation's own rollout, sets the name and writes
 * <key>.result.json.
 */
const fs = require('fs');
const path = require('path');

const A = '01a1b8e8-f7e2-7251-95a9-a95b65992841';
const B = '01a1b8e8-f7e2-7251-95a9-a95b65992842';

module.exports = async ({ eq, tmp, root }) => {
  const rt = require(path.join(root, 'src', 'retitle.js'));
  const data = tmp('retitle-data');
  const folder = path.join(data, rt.DIR);
  fs.mkdirSync(folder, { recursive: true });
  let now = Date.UTC(2026, 10, 27, 12, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const rollouts = { [A]: path.join(data, 'a.jsonl'), [B]: path.join(data, 'b.jsonl') };
  for (const f of Object.values(rollouts)) fs.writeFileSync(f, '');
  const call = (id, title, at, extra = {}) => fs.appendFileSync(rollouts[id], JSON.stringify({ timestamp: iso(at), type: 'response_item',
    payload: { type: 'function_call', name: 'set_title', namespace: 'mcp__work_plan', arguments: JSON.stringify({ plan: `/p/${id}.json`, title }),
      call_id: 'call_1', ...extra } }) + '\n');
  const shell = (id, cmd, at) => fs.appendFileSync(rollouts[id], JSON.stringify({ timestamp: iso(at), type: 'response_item',
    payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }), call_id: 'call_2' } }) + '\n');
  let keyN = 0;
  const ask = (id, title, { via = 'tool', agent = 'Codex' } = {}) => {
    const key = `k${String(++keyN).padStart(12, '0')}`;
    fs.writeFileSync(path.join(folder, `${key}.json`), JSON.stringify({ format: 1, key, agent, sessionId: id, title, at: now, via }));
    return key;
  };
  const result = (key) => { try { return JSON.parse(fs.readFileSync(path.join(folder, `${key}.result.json`), 'utf8')); } catch (_) { return null; } };
  const left = () => fs.readdirSync(folder).sort();
  const renamed = [];
  let renameAnswer = { outcome: 'done' };
  let shown = [A], trusted = true;
  const tail = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).reverse();
  let slept = 0;
  const host = rt.createRetitle({ dir: () => data, shownHere: () => shown, rolloutOf: (id) => rollouts[id] || '', tail,
    rename: async (id, name) => { renamed.push([id, name]); return renameAnswer; }, trusted: () => trusted, now: () => now,
    sleep: async (ms) => { slept += ms; now += ms; } });

  /* Shown here: taken at once. */
  call(A, '  Fix the  retry delay 📩 ', now - 1000);
  let k = ask(A, '  Fix the  retry delay 📩 ');
  await host.tick();
  let r = result(k);
  eq([r && r.outcome, r && r.title, renamed, left()], ['done', 'Fix the retry delay', [[A, 'Fix the retry delay']], [`${k}.result.json`]],
    'the window showing the conversation takes its request at once and sets the name without the envelope or extra spaces, leaving only the answer file');
  eq([r.format, r.key, typeof r.reason, r.at], [1, k, 'string', now], 'the answer has the format, the key, a reason and the time it was written');
  fs.unlinkSync(path.join(folder, `${k}.result.json`));

  /* Not shown here: taken after OTHERS_WAIT_MS. */
  renamed.length = 0;
  call(B, 'Export archived rows', now);
  k = ask(B, 'Export archived rows');
  await host.tick();
  eq([left(), renamed.length], [[`${k}.json`], 0], 'this window first leaves alone a request for a conversation it does not show');
  now += rt.OTHERS_WAIT_MS;
  await host.tick();
  eq([result(k) && result(k).outcome, renamed], ['done', [[B, 'Export archived rows']]], `and takes it once the request has waited ${rt.OTHERS_WAIT_MS} ms`);
  fs.unlinkSync(path.join(folder, `${k}.result.json`));

  /* The call is not in the conversation's own rollout: refused, after reading it again for a while. */
  renamed.length = 0; slept = 0;
  call(B, 'A title asked by B', now);
  k = ask(A, 'A title asked by B');
  await host.tick();
  r = result(k);
  eq([r && r.outcome, renamed.length, slept >= rt.VERIFY_MS], ['refused', 0, true],
    'a request whose call is not in that conversation\'s own rollout is refused, but only after the window has kept reading the rollout for as long as Codex may take to write the call');
  fs.unlinkSync(path.join(folder, `${k}.result.json`));

  /* The call is written after the request was taken. */
  renamed.length = 0;
  const late = ask(A, 'Written late');
  const t0 = now;
  const host2 = rt.createRetitle({ dir: () => data, shownHere: () => [A], rolloutOf: (id) => rollouts[id], tail,
    rename: async (id, name) => { renamed.push([id, name]); return { outcome: 'done' }; }, now: () => now,
    sleep: async (ms) => { now += ms; if (now - t0 >= 1500 && !fs.readFileSync(rollouts[A], 'utf8').includes('Written late')) call(A, 'Written late', t0); } });
  await host2.tick();
  eq([result(late) && result(late).outcome, renamed], ['done', [[A, 'Written late']]], 'the window reads the rollout again and finds a call that Codex records only after the request was taken');
  fs.unlinkSync(path.join(folder, `${late}.result.json`));

  /* An old call with the same title does not count. */
  renamed.length = 0;
  call(A, 'Asked long ago', now - 10 * 60e3);
  k = ask(A, 'Asked long ago');
  await host.tick();
  eq([result(k) && result(k).outcome, renamed.length], ['refused', 0], 'a request is refused when the only call asking for its title was recorded long before it');
  fs.unlinkSync(path.join(folder, `${k}.result.json`));

  /* Marks only, and a long title. */
  call(A, '📩 👑', now);
  k = ask(A, '📩 👑');
  await host.tick();
  eq(result(k) && result(k).outcome, 'refused', 'a title that is nothing but marks is refused');
  fs.unlinkSync(path.join(folder, `${k}.result.json`));
  renamed.length = 0;
  const long = 'x'.repeat(200);
  call(A, long, now);
  k = ask(A, long);
  await host.tick();
  eq([result(k) && result(k).title.length, renamed[0] && renamed[0][1].length], [rt.TITLE_MAX, rt.TITLE_MAX], `a long title is cut to ${rt.TITLE_MAX} characters`);
  fs.unlinkSync(path.join(folder, `${k}.result.json`));

  /* Codex refuses. */
  renameAnswer = { outcome: 'failed', reason: 'no such thread' };
  call(A, 'Refused by Codex', now);
  k = ask(A, 'Refused by Codex');
  await host.tick();
  r = result(k);
  eq([r && r.outcome, r && r.reason, r && r.title], ['failed', 'no such thread', ''], 'when Codex does not rename it, the answer says failed and why');
  fs.unlinkSync(path.join(folder, `${k}.result.json`));
  renameAnswer = { outcome: 'done' };

  /* The shell command, approved by the user. */
  renamed.length = 0;
  shell(A, "python3 /x/hooks/retitle.py <<'EOF'\nBy the command\nEOF", now);
  k = ask(A, 'By the command\n', { via: 'command' });
  await host.tick();
  eq([result(k) && result(k).outcome, renamed], ['done', [[A, 'By the command']]], 'a request from the retitle.py command is believed when the conversation ran it with that title');
  fs.unlinkSync(path.join(folder, `${k}.result.json`));

  /* Not this window's to answer. */
  renamed.length = 0;
  call(A, 'For OpenCode', now);
  k = ask(A, 'For OpenCode', { agent: 'OpenCode' });
  await host.tick();
  eq([left(), renamed.length], [[`${k}.json`], 0], 'a request naming another agent is left alone');
  fs.unlinkSync(path.join(folder, `${k}.json`));
  trusted = false;
  call(A, 'In Restricted Mode', now);
  k = ask(A, 'In Restricted Mode');
  await host.tick();
  eq([left(), renamed.length], [[`${k}.json`], 0], 'in Restricted Mode no request is taken');
  trusted = true;

  /* Another window took it first. */
  const claimed = path.join(folder, `${k}.claimed`);
  fs.renameSync(path.join(folder, `${k}.json`), claimed);
  await host.tick();
  eq([left(), renamed.length], [[`${k}.claimed`], 0], 'this window leaves alone a request another window has taken');

  /* Old files go. */
  const old = (Date.now() - rt.STALE_MS - 60e3) / 1000;
  fs.utimesSync(claimed, old, old);
  const realNow = now;
  now = Date.now();
  await host.tick();
  eq(left(), [], `files in retitle/ older than ${rt.STALE_MS / 60e3} minutes are removed`);
  now = realNow;

  eq([rt.cleanTitle('  a\tb  📩'), rt.cleanTitle('✉️ c 👑'), rt.cleanTitle('')], ['a b', 'c', ''], 'cleanTitle takes out the marks and extra spaces');
};
