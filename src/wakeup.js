// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Wake-ups, Claude Code's periodic alarm for Codex: an idle conversation is sent a message every few minutes, so
 * unfinished work goes on without the user.
 *
 * The model sets one with the work plan's MCP tool set_wakeup, which writes <thread>.wakeup into the plugin's data
 * folder: the interval, the prompt, when it was set and when it expires, seven days later. Each window runs one timer
 * here. When a wake-up is due for a conversation this window's app-server has loaded (thread/loaded/list), the timer
 * puts the prompt in that conversation's queue (thread/queue/add), and Codex sends it as soon as the conversation is
 * idle, after the turn running now if there is one. A wake-up still waiting in the queue is not queued a second time.
 *
 * Every request goes over Codex's own connection to this window's app-server. A conversation that no window has open is
 * not woken: a message queued for it would wait there and be sent the moment it was next opened, out of its time.
 *
 * When the user stops a turn (turn/completed with the status interrupted), Codex itself holds back what is queued until
 * they send something. The wake-up is taken out of the queue and paused as well, until a turn starts again, so a stopped
 * conversation is not restarted by the timer behind the user's back.
 *
 * <thread>.woke beside it says when it was last queued and whether it is paused. A lock folder keeps two windows that
 * find it due at the same moment from both queueing it.
 */
const fs = require('fs');
const path = require('path');

const SUFFIX = '.wakeup';
const STATE = '.woke';
const LOCK = '.wakeup.lock';
const LOCK_STALE_MS = 60e3;
/* The first line of every message a wake-up sends. */
const PREFIX = '[Wake-up set in this conversation: sent by its timer, not by the user, and not an answer to anything '
  + 'waiting for one.]\n';
const ID_PREFIX = 'codex-plus-wakeup-';
const THREAD = /^[0-9A-Fa-f][0-9A-Fa-f-]{7,}$/;
const TICK_MS = 30e3;

function readJson(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : null; } catch (_) { return null; }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, file); } catch (_) { try { fs.unlinkSync(tmp); } catch (e) { /* gone */ } }
}

/** The wake-ups set in `dir` and not expired, as { thread, everyMinutes, prompt, setMs, expiresMs }. */
function listed(dir, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(SUFFIX)); } catch (_) { return []; }
  const out = [];
  for (const n of names.sort()) {
    const thread = n.slice(0, -SUFFIX.length);
    const w = THREAD.test(thread) && readJson(path.join(dir, n));
    if (!w) continue;
    const every = Math.floor(+w.everyMinutes);
    const expiresMs = +w.expiresAt * 1000, setMs = +w.setAt * 1000;
    if (!(every >= 1) || typeof w.prompt !== 'string' || !w.prompt.trim() || !Number.isFinite(expiresMs) || !Number.isFinite(setMs)) continue;
    out.push({ thread, everyMinutes: every, prompt: w.prompt, setMs, expiresMs, expired: now >= expiresMs });
  }
  return out;
}

/*
 * `dir()` is the plugin's data folder, `ask(method, params)` a request on Codex's own connection resolving to
 * { outcome, result } (src/patching.js hostRequest), `now()` the clock.
 */
function createWakeups({ dir, ask, now = Date.now, log = () => {}, enabled = () => true }) {
  const own = (q) => q && typeof q.clientUserMessageId === 'string' && q.clientUserMessageId.startsWith(ID_PREFIX);
  const stateFile = (thread) => path.join(dir(), `${thread}${STATE}`);

  async function queued(thread) {
    const r = await ask('thread/queue/list', { threadId: thread });
    return r.outcome === 'done' && r.result && Array.isArray(r.result.data) ? r.result.data : null;
  }

  function lock(thread) {
    const p = path.join(dir(), `${thread}${LOCK}`);
    try { fs.mkdirSync(p); return () => { try { fs.rmdirSync(p); } catch (_) { /* gone */ } }; } catch (_) { /* held */ }
    try {
      if (now() - fs.statSync(p).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(p); fs.mkdirSync(p); return () => { try { fs.rmdirSync(p); } catch (_) { /* gone */ } }; }
    } catch (_) { /* someone else took it */ }
    return null;
  }

  async function fire(w) {
    const st = readJson(stateFile(w.thread)) || {};
    if (st.pausedAt) return false;
    if (now() < Math.max(w.setMs, +st.firedAt || 0) + w.everyMinutes * 60e3) return false;
    const release = lock(w.thread);
    if (!release) return false;
    try {
      const again = readJson(stateFile(w.thread)) || {};
      if (again.pausedAt || now() < Math.max(w.setMs, +again.firedAt || 0) + w.everyMinutes * 60e3) return false;
      const waiting = await queued(w.thread);
      if (!waiting || waiting.some(own)) return false;
      const r = await ask('thread/queue/add', { threadId: w.thread, clientUserMessageId: `${ID_PREFIX}${now()}`,
        input: [{ type: 'text', text: PREFIX + w.prompt, text_elements: [] }] });
      if (r.outcome !== 'done' && r.outcome !== 'sent') { log(`wake-up for ${w.thread}: ${r.reason || r.outcome}`); return false; }
      writeJson(stateFile(w.thread), { firedAt: now() });
      return true;
    } finally { release(); }
  }

  /** One pass: every due wake-up of a conversation this window has loaded is queued. */
  async function tick() {
    if (!enabled()) return 0;
    const all = listed(dir(), now());
    for (const w of all.filter((x) => x.expired)) {
      try { fs.unlinkSync(path.join(dir(), `${w.thread}${SUFFIX}`)); } catch (_) { /* gone */ }
    }
    const live = all.filter((x) => !x.expired);
    if (!live.length) return 0;
    const r = await ask('thread/loaded/list', {});
    const loaded = new Set(r.outcome === 'done' && r.result && Array.isArray(r.result.data) ? r.result.data : []);
    let n = 0;
    for (const w of live) if (loaded.has(w.thread) && await fire(w)) n++;
    return n;
  }

  /** An app-server notification: a stopped turn pauses its conversation's wake-up, a started one ends the pause. */
  async function heard(method, params) {
    if (!enabled()) return;
    const thread = params && typeof params.threadId === 'string' ? params.threadId : '';
    if (!THREAD.test(thread) || !fs.existsSync(path.join(dir(), `${thread}${SUFFIX}`))) return;
    if (method === 'turn/completed' && params.turn && params.turn.status === 'interrupted') {
      const st = readJson(stateFile(thread)) || {};
      writeJson(stateFile(thread), { ...st, pausedAt: now() });
      for (const q of (await queued(thread)) || []) {
        if (own(q)) await ask('thread/queue/delete', { threadId: thread, queuedSubmissionId: q.id });
      }
    } else if (method === 'turn/started') {
      const st = readJson(stateFile(thread));
      if (st && st.pausedAt) writeJson(stateFile(thread), { firedAt: +st.firedAt || 0 });
    }
  }

  /** A timer calling tick every TICK_MS, one pass at a time; dispose() stops it. */
  function start() {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      tick().catch((e) => log(`wake-ups: ${e.message}`)).finally(() => { busy = false; });
    }, TICK_MS);
    if (timer.unref) timer.unref();
    return { dispose: () => clearInterval(timer) };
  }

  return { tick, heard, start };
}

module.exports = { createWakeups, listed, PREFIX, ID_PREFIX, SUFFIX, STATE, TICK_MS };
