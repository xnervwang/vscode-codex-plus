// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Usage: node test/thread-archive-probe.js <codex program>
 *
 * test/parts/35v-thread-archive-codex.js runs this. It runs Codex's own app-server with no network
 * (test/render/lib/app-server.js) on a throwaway Codex home: a conversation, a conversation with a sub-agent, one loaded
 * on the connection and one with a turn running. It archives, unarchives and deletes them.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const render = require('./render/lib/fake-codex-home');
const appServer = require('./render/lib/app-server');

const BIN = process.argv[2];
const IDS = { A: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01', P: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c02', S: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c03',
  L: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c04', T: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c05' };
const letter = (id) => Object.keys(IDS).find((k) => IDS[k] === id) || id;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Writes render's made-up conversation as thread `id`. */
function writeThread(home, scratch, id, days, source) {
  const made = render.write(fs.mkdtempSync(path.join(scratch, 't-')), { days: [[days, render.FOUR.length]] });
  const sessions = path.join(made.codexHome, 'sessions');
  for (const rel of fs.readdirSync(sessions, { recursive: true })) {
    if (!rel.endsWith('.jsonl')) continue;
    const rows = fs.readFileSync(path.join(sessions, rel), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    for (const r of rows) {
      if (r.type !== 'session_meta') continue;
      r.payload.id = id;
      r.payload.session_id = id;
      if (source) { r.payload.source = source; r.payload.thread_source = 'subagent'; }
    }
    const to = path.join(home, 'sessions', path.dirname(rel), path.basename(rel).split(render.THREAD).join(id));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
}

/* Where each rollout is ('sessions/<y>/<m>/<d>' or 'archived_sessions'), and the state database's row of each thread. */
function onDisk(home) {
  const where = {};
  for (const top of ['sessions', 'archived_sessions']) {
    let names = [];
    try { names = fs.readdirSync(path.join(home, top), { recursive: true }); } catch (_) { names = []; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      where[letter(path.basename(n, '.jsonl').slice(-36))] = path.dirname(path.join(top, n)).replace(/\\/g, '/').replace(/^sessions\/\d{4}\/\d{2}\/\d{2}$/, 'sessions/<day>');
    }
  }
  const { DatabaseSync } = require('node:sqlite');
  const rows = {};
  const db = new DatabaseSync(path.join(home, fs.readdirSync(home).find((x) => /^state_\d+\.sqlite$/.test(x))), { readOnly: true });
  try {
    for (const r of db.prepare('select id, archived, archived_at, rollout_path, updated_at from threads').all()) {
      rows[letter(r.id)] = { archived: r.archived, archivedAt: r.archived_at, inArchive: String(r.rollout_path).includes(`${path.sep}archived_sessions${path.sep}`),
        updatedAt: r.updated_at };
    }
  } finally { db.close(); }
  return { where, rows };
}

(async () => {
  const out = {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cxa-'));
  const home = path.join(root, 'c');
  let server = null;
  const heard = [];
  /* The notifications about the probe's threads since the last call, as "<method> <letter>[ <status>]". */
  const took = () => heard.splice(0).filter((m) => m.params && IDS[letter(m.params.threadId)])
    .map((m) => `${m.method} ${letter(m.params.threadId)}${m.params.status ? ` ${m.params.status.type}` : ''}${m.params.turn ? ` ${m.params.turn.status}` : ''}`);
  const ask = async (method, threadId, extra = {}) => {
    took();
    const sentS = Date.now() / 1000;
    const r = await server.request(method, { threadId, ...extra });
    await wait(800);
    return { sentS, answer: r.error ? { error: r.error.message.replace(threadId, '<id>') } : r.result, heard: took(), disk: onDisk(home) };
  };
  const loadedNow = async () => {
    const r = await server.request('thread/loaded/list', {});
    return r.error ? { error: r.error.message } : ((r.result && r.result.data) || []).map(letter).filter((x) => IDS[x]).sort();
  };
  try {
    fs.mkdirSync(home, { recursive: true });
    writeThread(home, root, IDS.A, 3);
    writeThread(home, root, IDS.P, 2);
    writeThread(home, root, IDS.S, 1, { subagent: { thread_spawn: { parent_thread_id: IDS.P, depth: 1, agent_nickname: 'agent1', agent_role: 'explorer' } } });
    writeThread(home, root, IDS.L, 1);
    writeThread(home, root, IDS.T, 0);
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), Object.values(IDS)
      .map((id) => JSON.stringify({ id, thread_name: `Title ${letter(id)}`, updated_at: new Date().toISOString() })).join('\n') + '\n');
    fs.mkdirSync(path.join(root, 'h'));
    server = appServer.start({ binary: BIN, codexHome: home, home: path.join(root, 'h'), version: 'probe', log: path.join(root, 'app-server.log') });
    server.handlers.notification = (m) => heard.push(m);
    server.handlers.request = (m) => server.respond(m.id, {});
    const init = await server.ready;
    if (init.error) throw new Error(`initialize: ${JSON.stringify(init.error)}`);
    for (const id of [IDS.L, IDS.T]) {
      const r = await server.request('thread/resume', { threadId: id });
      if (r.error) throw new Error(`thread/resume: ${JSON.stringify(r.error)}`);
    }
    await wait(500);
    out.before = onDisk(home);
    out.loadedBefore = await loadedNow();

    out.archive = await ask('thread/archive', IDS.A);
    out.again = await ask('thread/archive', IDS.A);
    out.parent = await ask('thread/archive', IDS.P);
    out.resume = await ask('thread/resume', IDS.P);
    out.loaded = await ask('thread/archive', IDS.L);
    out.loaded.loadedAfter = await loadedNow();
    took();
    const turn = await server.request('turn/start', { threadId: IDS.T, input: [{ type: 'text', text: 'hello' }] });
    if (turn.error) throw new Error(`turn/start: ${JSON.stringify(turn.error)}`);
    await wait(2000);
    out.runningBefore = took().filter((h) => /^turn\/completed/.test(h));
    out.running = await ask('thread/archive', IDS.T);
    await wait(1000);
    out.running.heard.push(...took());
    out.unarchive = await ask('thread/unarchive', IDS.P);
    out.unarchive.answer = out.unarchive.answer && out.unarchive.answer.thread ? { thread: letter(out.unarchive.answer.thread.id) } : out.unarchive.answer;
    out.unarchiveAgain = await ask('thread/unarchive', IDS.P);
    out.deleteArchived = await ask('thread/delete', IDS.L);
  } catch (e) {
    out.error = e.stack || String(e);
  }
  if (server) server.stop();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* left for the OS */ }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
})();
