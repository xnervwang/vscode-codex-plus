// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which conversations are stopped waiting for the reader, and which of those really need a decision.
 *
 * Codex's app-server asks its client for an approval as a request, not as a notification, and writes nothing about it to
 * any file: not to the rollout, not to any of its databases, not to its own log. So the one place it can be read is the
 * stream of requests going through the extension host, which the patch hands over (src/host.js, src/patching.js).
 *
 * Seven methods stop and wait. Five always wait for the person. The other two Codex answers by itself once a countdown
 * runs out - an empty input, or a declined elicitation - so counting those as something to decide would ring for
 * something that is about to go away on its own. Both are tracked, only the first kind is counted.
 *
 * A request is finished by the answer this window sent, by the notification saying somebody else answered it, or - the
 * net under both - by its conversation no longer running. That last one needs two passes to fire, because the reader's
 * snapshot of a conversation can be a poll behind the request that just arrived.
 */

/* The requests that always wait for the person, and the parameter each carries its conversation in. The two
   conversationId ones are the older protocol's. Codex's own tracker classifies the same five. */
const APPROVALS = {
  'item/commandExecution/requestApproval': 'threadId',
  'item/fileChange/requestApproval': 'threadId',
  'item/permissions/requestApproval': 'threadId',
  execCommandApproval: 'conversationId',
  applyPatchApproval: 'conversationId',
};

/* The two Codex answers by itself, in all but the cases below. */
const ASKS = new Set(['item/tool/requestUserInput', 'mcpServer/elicitation/request']);

/* The bounds Codex accepts a countdown from the request's own _meta in; outside them, and when _meta says nothing, an
   elicitation gets no countdown at all and so waits for the person after all. An input request gets Codex's own
   countdown whatever _meta says, and only isBlocking takes it out of that. */
const COUNTDOWN_MS = { min: 5000, max: 5 * 60 * 1000 };
function hasCountdown(meta) {
  const ms = meta && meta.autoResolutionMs;
  return Number.isInteger(ms) && ms >= COUNTDOWN_MS.min && ms <= COUNTDOWN_MS.max;
}

/* A conversation that stopped running has nothing outstanding: an approval request only exists inside a turn. The
   second pass rather than the first, because a request can arrive before the poll that would show its turn started. */
const STRIKES = 2;

/** What a request is: null when it does not wait for anybody, else { thread, method, decides }. */
function waitOf(msg) {
  const method = msg && typeof msg.method === 'string' ? msg.method : '';
  const params = (msg && msg.params) || {};
  const where = APPROVALS[method];
  if (where) {
    const thread = String(params[where] || '');
    return thread ? { thread, method, decides: true } : null;
  }
  if (!ASKS.has(method)) return null;
  const thread = String(params.threadId || '');
  if (!thread) return null;
  const decides = method === 'item/tool/requestUserInput'
    ? params.isBlocking === true
    : params.mode === 'openai/userVerification' || !hasCountdown(params._meta);
  return { thread, method, decides };
}

/*
 * The book of what is outstanding.
 *
 * Request ids are kept as the protocol sent them, the way Codex keeps its own, so an id is matched by the same value
 * that arrived. A conversation can have several outstanding at once; what the page reports is one flag per
 * conversation, since all a page can say is whether a card is on screen.
 */
function createApprovals({ now = () => Date.now() } = {}) {
  const pending = new Map();
  const pages = new Map();

  const hostOf = (thread) => {
    let decide = 0, soon = 0;
    for (const e of pending.values()) {
      if (e.thread !== thread) continue;
      if (e.decides) decide++; else soon++;
    }
    return { decide, soon };
  };

  return {
    /** Record a request that waits. Returns what was recorded, or null for one that does not wait. */
    request(msg) {
      const w = waitOf(msg);
      if (!w || !msg || msg.id === undefined || msg.id === null) return null;
      pending.set(msg.id, { thread: w.thread, method: w.method, decides: w.decides, atMs: now(), strikes: 0 });
      return { ...w };
    },
    /** Forget a request, by the id of the answer or of the notification that it was answered. Returns its conversation. */
    resolve(id) {
      const e = pending.get(id);
      if (!e) return '';
      pending.delete(id);
      return e.thread;
    },
    /*
     * What a conversation's page says: whether an approval card is on its screen. Kept apart from the requests above so
     * that a conversation seen both ways counts once, and so that a page going quiet cannot take a request away.
     */
    pageSays(thread, on) {
      if (!thread) return;
      if (on) { if (!pages.has(thread)) pages.set(thread, { atMs: now(), strikes: 0 }); }
      else pages.delete(thread);
    },
    /** Drop what a page said about a conversation, for a page that is gone rather than one that said the card went. */
    forgetPage(thread) { pages.delete(thread); },
    /*
     * One conversation: how many answers it needs from the reader, and how many requests Codex will answer by itself.
     * A page's flag counts as one needed answer, and only when no request of this window already says so.
     */
    of(thread) {
      const h = hostOf(thread);
      return { decide: h.decide || (pages.has(thread) ? 1 : 0), soon: h.soon };
    },
    /** How many answers the reader owes, across every conversation of this window. */
    decideCount() {
      let n = 0;
      for (const t of this.threads()) n += this.of(t).decide;
      return n;
    },
    /** Every conversation with something outstanding, whether the reader has to answer it or not. */
    threads() {
      const out = [];
      for (const e of pending.values()) if (!out.includes(e.thread)) out.push(e.thread);
      for (const t of pages.keys()) if (!out.includes(t)) out.push(t);
      return out;
    },
    /*
     * The net: forget what belongs to a conversation that `running` says is no longer going, after two passes. Returns
     * the conversations it forgot something of, so the caller can redraw them.
     */
    prune(running) {
      const dropped = [];
      const mark = (key, entry, map) => {
        if (running(entry.thread)) { entry.strikes = 0; return; }
        entry.strikes++;
        if (entry.strikes < STRIKES) return;
        map.delete(key);
        if (!dropped.includes(entry.thread)) dropped.push(entry.thread);
      };
      for (const [id, e] of [...pending]) mark(id, e, pending);
      for (const [t, e] of [...pages]) mark(t, e, pages);
      return dropped;
    },
    clear() { pending.clear(); pages.clear(); },
    /* For the tests and the status report: what is on the books, in the order it arrived. */
    _entries() { return [...pending].map(([id, e]) => ({ id, ...e })); },
    _pages() { return [...pages.keys()]; },
  };
}

module.exports = { createApprovals, waitOf, APPROVALS, ASKS, COUNTDOWN_MS, STRIKES };
