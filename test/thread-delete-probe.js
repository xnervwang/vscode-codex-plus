// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Usage: node test/thread-delete-probe.js <codex program>
 *
 * test/parts/35r-thread-delete-codex.js runs this. It runs Codex's own app-server with no network
 * (test/render/lib/app-server.js) on a throwaway Codex home: a conversation, its sub-agent, that sub-agent's own
 * sub-agent, and two other conversations.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const render = require('./render/lib/fake-codex-home');
const appServer = require('./render/lib/app-server');

const BIN = process.argv[2];
const IDS = { P: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01', S: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02', G: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b05',
  U: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b03', L: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b04' };
const MISSING = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4bff';
const letter = (id) => Object.keys(IDS).find((k) => IDS[k] === id) || id;

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

const spawned = (parent, depth) => ({ subagent: { thread_spawn: { parent_thread_id: parent, depth, agent_nickname: `agent${depth}`, agent_role: 'explorer' } } });

function onDisk(home) {
  const rollouts = fs.readdirSync(path.join(home, 'sessions'), { recursive: true }).filter((n) => n.endsWith('.jsonl'))
    .map((n) => letter(path.basename(n, '.jsonl').slice(-36))).sort();
  const { DatabaseSync } = require('node:sqlite');
  const tables = {};
  for (const n of fs.readdirSync(home).filter((x) => /^(state|goals)_\d+\.sqlite$/.test(x))) {
    const db = new DatabaseSync(path.join(home, n), { readOnly: true });
    try {
      for (const { name } of db.prepare("select name from sqlite_master where type = 'table'").all()) {
        const cols = db.prepare(`pragma table_info("${name}")`).all().map((c) => c.name);
        const col = cols.includes('thread_id') ? 'thread_id' : cols.includes('parent_thread_id') ? 'parent_thread_id' : cols.includes('id') ? 'id' : '';
        if (!col) continue;
        const named = db.prepare(`select "${col}" as v from "${name}"`).all().map((r) => letter(String(r.v))).filter((v) => IDS[v]);
        if (named.length) tables[`${n.replace(/_\d+\.sqlite$/, '')}.${name}`] = named.sort();
      }
    } finally { db.close(); }
  }
  let index = [];
  try { index = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => letter(JSON.parse(l).id)).sort(); } catch (_) { index = []; }
  return { rollouts, tables: Object.fromEntries(Object.entries(tables).sort()), index };
}

(async () => {
  const out = {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cxd-'));
  const home = path.join(root, 'c');
  let server = null;
  try {
    fs.mkdirSync(home, { recursive: true });
    writeThread(home, root, IDS.P, 2);
    writeThread(home, root, IDS.S, 1, spawned(IDS.P, 1));
    writeThread(home, root, IDS.G, 1, spawned(IDS.S, 2));
    writeThread(home, root, IDS.U, 0);
    writeThread(home, root, IDS.L, 0);
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), Object.values(IDS)
      .map((id) => JSON.stringify({ id, thread_name: `Title ${letter(id)}`, updated_at: new Date().toISOString() })).join('\n') + '\n');
    fs.mkdirSync(path.join(root, 'h'));
    server = appServer.start({ binary: BIN, codexHome: home, home: path.join(root, 'h'), version: 'probe', log: path.join(root, 'app-server.log') });
    const heard = [];
    server.handlers.notification = (m) => heard.push(m);
    server.handlers.request = (m) => server.respond(m.id, {});
    const init = await server.ready;
    if (init.error) throw new Error(`initialize: ${JSON.stringify(init.error)}`);
    const goal = await server.request('thread/goal/set', { threadId: IDS.P, objective: 'Finish the probe', status: 'paused', origin: 'user' });
    if (goal.error) throw new Error(`thread/goal/set: ${JSON.stringify(goal.error)}`);
    const resumed = await server.request('thread/resume', { threadId: IDS.L });
    if (resumed.error) throw new Error(`thread/resume: ${JSON.stringify(resumed.error)}`);
    await new Promise((r) => setTimeout(r, 500));
    out.before = onDisk(home);

    heard.length = 0;
    const del = await server.request('thread/delete', { threadId: IDS.P });
    await new Promise((r) => setTimeout(r, 1000));
    out.parent = { result: del.error ? { error: del.error.message } : del.result,
      deleted: heard.filter((m) => m.method === 'thread/deleted').map((m) => letter(m.params.threadId)), after: onDisk(home) };
    const again = await server.request('thread/delete', { threadId: IDS.P });
    out.again = again.error ? again.error.message.replace(IDS.P, '<id>') : 'accepted';
    const missing = await server.request('thread/delete', { threadId: MISSING });
    out.missing = missing.error ? { code: missing.error.code, message: missing.error.message.replace(MISSING, '<id>') } : 'accepted';

    heard.length = 0;
    const loaded = await server.request('thread/delete', { threadId: IDS.L });
    await new Promise((r) => setTimeout(r, 1000));
    out.loaded = { result: loaded.error ? { error: loaded.error.message } : loaded.result,
      heard: [...new Set(heard.filter((m) => m.params && m.params.threadId === IDS.L)
        .map((m) => (m.method === 'thread/status/changed' ? `${m.method} ${m.params.status.type}` : m.method)))],
      after: onDisk(home) };
  } catch (e) {
    out.error = e.stack || String(e);
  }
  if (server) server.stop();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* left for the OS */ }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
})();
