// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What the extension host knows of Codex's files: the latest snapshot src/codex-worker.js read in its worker thread.
 * Everything that needs a thread list, an unread mark or a rollout's state reads it from here, synchronously and from
 * memory; refresh() asks the worker for a new one.
 *
 * One request of a kind is in flight at a time, so a slow read is never piled on. When the worker cannot be started, or
 * dies, the same operations run in this thread instead, and the log says so once.
 */
const path = require('path');

const TIMEOUT_MS = 60000;
/* How many states read on request to keep. One is a turn's figures, so this is kilobytes, and a list nobody could
   scroll through in one sitting. */
const HELD_MAX = 200;

class CodexReader {
  constructor({ log = () => {}, inline = false, workerFile = path.join(__dirname, 'codex-worker.js') } = {}) {
    this.log = log;
    this.workerFile = workerFile;
    this.inline = inline;
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
    this.snap = null;
    this.busy = null;
    this.closed = false;
    this.listeners = new Set();
    /*
     * Rollout states read on request, for threads too old for a snapshot to cover (the history group's rows). Each is
     * stored with the thread's last-updated time and used only while that time is unchanged,
     * and the caller need not ask again on every pass.
     */
    this.held = new Map();
    if (!inline) this.start();
  }

  start() {
    let Worker;
    try { ({ Worker } = require('worker_threads')); } catch (e) { this.fallBack(`worker threads are not available (${e.message})`); return; }
    try {
      this.worker = new Worker(this.workerFile);
      this.worker.on('message', (m) => this.reply(m));
      this.worker.on('error', (e) => this.fallBack(`the reader thread failed: ${(e && e.message) || e}`));
      this.worker.on('exit', (code) => { if (!this.closed) this.fallBack(`the reader thread exited (${code})`); });
      this.idle();
    } catch (e) { this.fallBack(`the reader thread could not start (${e.message})`); }
  }

  fallBack(why) {
    if (this.inline) return;
    this.inline = true;
    this.log(`codex reader: ${why}; reading Codex's files in the extension host's own thread from now on`);
    const w = this.worker;
    this.worker = null;
    if (w) { try { w.terminate(); } catch (_) { /* gone */ } }
    for (const [id, p] of this.pending) { clearTimeout(p.timer); this.pending.delete(id); this.runInline(p.op, p.args).then(p.resolve, p.reject); }
  }

  runInline(op, args) {
    return new Promise((resolve, reject) => setImmediate(() => {
      try { resolve(require('./codex-worker').ops[op](args)); } catch (e) { reject(e); }
    }));
  }

  /* The worker keeps the process alive only while a request is in flight, so an idle one never holds up an exit. */
  idle() {
    const w = this.worker;
    if (!w) return;
    try { if (this.pending.size) w.ref(); else w.unref(); } catch (_) { /* gone */ }
  }

  reply(m) {
    const p = m && this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    this.idle();
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  }

  /** Runs an operation of src/codex-worker.js and resolves to its result. */
  request(op, args) {
    if (this.closed) return Promise.reject(new Error('closed'));
    if (this.inline || !this.worker) return this.runInline(op, args);
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); this.idle(); reject(new Error(`${op} took over ${TIMEOUT_MS / 1000} seconds`)); }, TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { op, args, resolve, reject, timer });
      this.idle();
      try { this.worker.postMessage({ id, op, args }); } catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  /*
   * Asks for a new snapshot of `home`, with the rollout states of `extra` threads too. Resolves to whether anything
   * changed. While one is in flight a second call shares it.
   */
  refresh({ home, extra = [], force = false } = {}) {
    if (this.busy) return this.busy;
    /* `force` is for a request for states the last stamp cannot have moved for: a snapshot asked to compare stamps
       would answer "nothing changed" and read no rollout, and the rows that asked would stay blank. */
    const previous = !force && this.snap && this.snap.home === home ? this.snap.stamp : '';
    this.busy = this.request('snapshot', { home, previous, extra }).then((r) => {
      if (!r || r.same) return false;
      this.snap = {
        home, stamp: r.stamp, readable: r.readable, threads: r.threads, byId: new Map(r.threads.map((t) => [t.id, t])),
        unread: new Map(r.unread), sections: new Map(r.sections), states: r.states || {}, plans: new Set(r.plans || []), at: Date.now(),
      };
      this.hold(extra);
      for (const fn of [...this.listeners]) { try { fn(); } catch (_) { /* the others still hear it */ } }
      return true;
    }).catch((e) => { this.log(`codex reader: ${(e && e.message) || e}`); return false; })
      .finally(() => { this.busy = null; });
    return this.busy;
  }

  /** The first snapshot, waiting for it if none is in yet. */
  async ready(home) {
    if (!this.snap || this.snap.home !== home) await this.refresh({ home });
    return this.snap;
  }

  onDidChange(fn) { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }

  /* Keep the states just read for the threads that were asked for, so the next pass need not read them again. */
  hold(extra) {
    for (const id of extra || []) {
      const st = this.snap.states[id];
      const t = this.snap.byId.get(id);
      if (st && t) this.held.set(id, { at: t.updatedMs, state: st });
    }
    while (this.held.size > HELD_MAX) this.held.delete(this.held.keys().next().value);
  }

  threads() { return this.snap ? this.snap.threads : null; }
  thread(id) { return (this.snap && this.snap.byId.get(id)) || null; }
  unread() { return this.snap ? this.snap.unread : new Map(); }
  sections() { return this.snap ? this.snap.sections : new Map(); }
  /* The snapshot's state, else one read on request while that thread's last-updated time is unchanged. */
  state(id) {
    const direct = this.snap && this.snap.states[id];
    if (direct) return direct;
    const h = this.held.get(id);
    if (!h) return null;
    const t = this.thread(id);
    return t && t.updatedMs === h.at ? h.state : null;
  }
  hasPlan(id) { return !!(this.snap && this.snap.plans.has(id)); }
  /* Whether the thread's rollout exists, as of the last snapshot; a thread the database does not know is not. */
  present(id) { const t = this.thread(id); return !!(t && t.present); }

  dispose() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('closed')); }
    this.pending.clear();
    if (this.worker) { try { this.worker.terminate(); } catch (_) { /* gone */ } this.worker = null; }
    this.listeners.clear();
    this.held.clear();
  }
}

module.exports = { CodexReader, TIMEOUT_MS, HELD_MAX };
