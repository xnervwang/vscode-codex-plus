// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A conversation renaming itself. The work plan's MCP tool set_title puts a request in retitle/ in the plugin's data
 * folder, through plan_common.request_retitle, and waits for the answer in the same folder:
 *
 *   <key>.json         { format: 1, key, agent, sessionId, title, at, via: 'tool' | 'command' }
 *   <key>.claimed      the request, once a window has taken it
 *   <key>.result.json  { format: 1, key, outcome: 'done' | 'refused' | 'failed', reason, title, at }
 *
 * The retitle.py command makes the same request, but Codex's sandbox lets it write there only with the user's approval.
 *
 * Only the window that renames <key>.json to <key>.claimed answers. A window that shows the conversation takes it at
 * once; any other takes it after OTHERS_WAIT_MS, in case no window shows the conversation.
 *
 * The request is believed only when the conversation's own rollout records the call that made it, with the same title,
 * so one conversation cannot rename another. Codex writes that record on its own schedule, which can be after the tool
 * has started, and the rollout is read again for up to VERIFY_MS until the call appears. The name is then set through
 * this window's app-server, as the session list's Rename does, without the marks Codex Plus draws after a title.
 */
const fs = require('fs');
const path = require('path');
const { withoutMarks } = require('./title-marks');

const FORMAT = 1;
const DIR = 'retitle';
const AGENT = 'Codex';
const KEY = /^[0-9a-z]{12,40}$/;
const THREAD = /^[0-9A-Fa-f][0-9A-Fa-f-]{7,}$/;
const ASKED_MAX = 500;
const TITLE_MAX = 80;
const OTHERS_WAIT_MS = 2000;
/* Within the requester's 15 seconds, leaving it time to read the answer. */
const VERIFY_MS = 8000;
const VERIFY_EVERY_MS = 500;
/* Codex can record a call before it runs the tool. */
const CALL_BEFORE_MS = 5 * 60e3;
const STALE_MS = 10 * 60e3;
const TAIL_BYTES = 1 << 20;
const TICK_MS = 500;
const MCP_NAMESPACE = 'mcp__work_plan';
const TOOL = 'set_title';
const SHELLS = new Set(['exec_command', 'shell', 'local_shell', 'container.exec']);

function cleanTitle(title) {
  const plain = withoutMarks(String(title == null ? '' : title)).replace(/\s+/g, ' ').trim();
  return [...plain].slice(0, TITLE_MAX).join('').trim();
}

function parse(text) {
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch (_) { return null; }
}

function requestOf(text, key) {
  const r = parse(text);
  if (!r || r.format !== FORMAT || r.key !== key || r.agent !== AGENT) return null;
  if (typeof r.sessionId !== 'string' || !THREAD.test(r.sessionId)) return null;
  if (typeof r.title !== 'string' || !r.title || r.title.length > ASKED_MAX || !Number.isFinite(+r.at)) return null;
  return { key, sessionId: r.sessionId, title: r.title, at: +r.at, via: r.via === 'command' ? 'command' : 'tool' };
}

function commandOf(args) {
  const c = args && (args.cmd !== undefined ? args.cmd : args.command);
  return Array.isArray(c) ? c.map(String).join(' ') : typeof c === 'string' ? c : '';
}

function askedIn(lines, req) {
  for (const line of lines) {
    if (!line.includes('function_call') || !line.includes(req.via === 'command' ? 'retitle' : TOOL)) continue;
    const row = parse(line);
    const p = row && row.type === 'response_item' && row.payload;
    if (!p || p.type !== 'function_call') continue;
    const at = Date.parse(row.timestamp);
    if (!(at >= req.at - CALL_BEFORE_MS)) continue;
    const args = parse(typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments || {})) || {};
    if (req.via === 'tool') {
      const named = (p.name === TOOL && p.namespace === MCP_NAMESPACE) || p.name === `${MCP_NAMESPACE}__${TOOL}`;
      if (named && args.title === req.title) return true;
    } else if (SHELLS.has(p.name)) {
      const cmd = commandOf(args);
      if (cmd.includes('retitle.py') && cmd.includes(req.title.trim())) return true;
    }
  }
  return false;
}

/*
 * `dir()` is the plugin's data folder. `rename(id, name)` resolves to { outcome: 'done' } or { outcome: 'failed',
 * reason }. `trusted()` is false in Restricted Mode.
 */
function createRetitle({ dir, shownHere = () => [], rolloutOf, tail, rename, trusted = () => true, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const firstSeen = new Map();
  const busy = new Set();
  const folder = () => path.join(dir(), DIR);

  const write = (file, value) => {
    const tmp = `${file}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, file); } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* gone */ }
      log(`retitle: could not write the answer: ${e.message}`);
    }
  };

  async function verified(req) {
    const until = now() + VERIFY_MS;
    for (;;) {
      const file = rolloutOf(req.sessionId);
      let lines = [];
      try { lines = file ? tail(file, TAIL_BYTES) : []; } catch (_) { lines = []; }
      if (askedIn(lines, req)) return true;
      if (now() >= until) return false;
      await sleep(VERIFY_EVERY_MS);
    }
  }

  async function answer(req) {
    if (!await verified(req)) {
      return ['refused', `the conversation's record has no ${req.via === 'command' ? 'retitle.py command' : `${TOOL} call`} asking for this title`, ''];
    }
    const name = cleanTitle(req.title);
    if (!name) return ['refused', 'the title is empty without marks and extra spaces', ''];
    let r;
    try { r = await rename(req.sessionId, name); } catch (e) { r = { outcome: 'failed', reason: (e && e.message) || String(e) }; }
    return r && r.outcome === 'done' ? ['done', 'renamed', name] : ['failed', String((r && r.reason) || 'Codex did not rename it'), ''];
  }

  async function take(key) {
    const d = folder();
    const claimed = path.join(d, `${key}.claimed`);
    try { fs.renameSync(path.join(d, `${key}.json`), claimed); } catch (_) { return; }
    firstSeen.delete(key);
    let req = null;
    try { req = requestOf(fs.readFileSync(claimed, 'utf8'), key); } catch (_) { req = null; }
    const [outcome, reason, title] = req ? await answer(req) : ['refused', 'not a request this extension can read', ''];
    write(path.join(d, `${key}.result.json`), { format: FORMAT, key, outcome, reason, title, at: now() });
    try { fs.unlinkSync(claimed); } catch (_) { /* gone */ }
    log(`retitle: ${req ? req.sessionId : key} ${outcome}${outcome === 'done' ? ` as "${title}"` : `: ${reason}`}`);
  }

  function sweep(d, names) {
    const t = now();
    for (const n of names) {
      const f = path.join(d, n);
      try { if (t - fs.statSync(f).mtimeMs > STALE_MS) fs.unlinkSync(f); } catch (_) { /* gone */ }
    }
  }

  /* One look at the folder. */
  async function tick() {
    if (!trusted()) return;
    const d = folder();
    let names;
    try { names = fs.readdirSync(d); } catch (_) { return; }
    sweep(d, names);
    const here = new Set(shownHere() || []);
    const work = [];
    for (const n of names) {
      const key = n.endsWith('.json') && !n.endsWith('.result.json') ? n.slice(0, -5) : '';
      if (!KEY.test(key) || busy.has(key)) continue;
      let text;
      try { text = fs.readFileSync(path.join(d, n), 'utf8'); } catch (_) { continue; }
      const req = requestOf(text, key);
      if (!req) continue;
      if (!here.has(req.sessionId)) {
        if (!firstSeen.has(key)) firstSeen.set(key, now());
        if (now() - firstSeen.get(key) < OTHERS_WAIT_MS) continue;
      }
      busy.add(key);
      work.push(take(key).finally(() => busy.delete(key)));
    }
    for (const k of firstSeen.keys()) if (!names.includes(`${k}.json`)) firstSeen.delete(k);
    await Promise.all(work);
  }

  let timer = null;
  return {
    tick,
    start() {
      if (!timer) timer = setInterval(() => { tick().catch((e) => log(`retitle: ${e.message}`)); }, TICK_MS);
      return { dispose: () => { if (timer) clearInterval(timer); timer = null; } };
    },
  };
}

module.exports = { createRetitle, cleanTitle, askedIn, requestOf, DIR, FORMAT, OTHERS_WAIT_MS, VERIFY_MS, STALE_MS, TITLE_MAX };
