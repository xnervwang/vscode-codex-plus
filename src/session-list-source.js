// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex's part of Agent Plus's session list (Agent Plus docs/protocol.md, Session list): the members the Codex source
 * adds for it. Agent Plus draws the list and keeps its groups, archive, pins, colours and read marks; this lists Codex's
 * conversations of the window's folders, says what each one is doing, and carries out what the list asks.
 *
 * A conversation is listed from the reader's snapshot (src/codex-reader.js), archived ones included: those Codex has
 * moved to archived_sessions are listed too, and imported once as archived. Its activity comes from the source's own
 * reading of it (src/codex-source.js conversationOf). One whose rollout has not been read has `detail: false`, and the
 * list asks for it (wantSessionDetail) once its row is on screen. lastActiveAt is when it last had a message, not when
 * its row was last written: renaming it, moving it between Codex's sections or archiving it writes the row.
 *
 * A goal is a badge on the row, and Pause Goal, Resume Goal and Clear Goal are Codex's own actions in its menu.
 *
 * Where else a conversation is open comes from the processes holding Codex's writer lock on it (src/writer-locks.js),
 * leaving out this window's own Codex. Another VS Code window that writes a window entry is found by Agent Plus itself.
 */
const GOAL_WORD = { active: 'goal', paused: 'goal paused', blocked: 'goal blocked', usageLimited: 'goal: usage limit',
  budgetLimited: 'goal: budget spent', complete: 'goal done' };
/* The states Resume Goal can set going again: the ones Codex stopped it in, and the user's own pause. */
const RESUMABLE = ['paused', 'blocked', 'usageLimited', 'budgetLimited'];
const OWN = [{ id: 'goal.pause', title: 'Pause Goal' }, { id: 'goal.resume', title: 'Resume Goal' }, { id: 'goal.clear', title: 'Clear Goal' }];
/* What a row's hover says still runs after the conversation's turn, for each kind src/left-running.js names. */
const LEFT_WORDS = {
  subagent: 'A sub-agent is still running',
  command: 'A background command is still running',
  detached: 'A command it detached is still running',
  codexExec: 'A codex exec it started is still running',
  claudeWorker: 'A claude -p worker it started is still running',
  claudeBg: 'A claude --bg session it started is still busy',
};
const KIND = { user: 'user', subagent: 'subagent' };
/* Codex's built-in Pinned section, a section like the others in its state database. */
const PINNED_SECTION = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
/* Where Codex Plus kept the title colours of its own list, handed over once by the import. */
const COLOR_KEY = 'codexPlus.titleColors';

function goalText(g) {
  if (!g) return '';
  const n = (x) => Number(x).toLocaleString('en-US');
  const used = g.tokenBudget ? `${n(g.tokensUsed)} of ${n(g.tokenBudget)} tokens` : `${n(g.tokensUsed)} tokens, no budget`;
  return `Goal (${GOAL_WORD[g.status] || g.status}, ${used}): ${String(g.objective || '').slice(0, 240)}`;
}

/* The places a Session lists at most (Agent Plus docs/protocol.md, Limits). */
const PLACES_MAX = 8;

/*
 * A Session for thread `t`. `conv` is what the source made of it (conversationOf), or null when its rollout has not
 * been read; `goal` its goal, or null; `holders` the processes elsewhere holding it open (codex-source holdersOf). A
 * turn runs in such a place while the conversation runs, since only the holder can write it; a `codex exec` runs one.
 * `here` is whether a tab or the sidebar of this window shows it: with a holder elsewhere too, it is open in two
 * processes at once, and Codex shows this window's page as unable to write it.
 */
function sessionOf(t, conv, goal, holders = [], { here = false } = {}) {
  const title = (t.kind === 'subagent' && String(t.nickname || '')) || (conv && conv.title) || t.title || '(untitled)';
  const s = {
    sessionId: t.id, title, cwd: t.cwd || '', createdAt: +t.createdMs || 0,
    lastActiveAt: (conv && conv.lastActiveAt) || +t.updatedMs || 0,
    kind: KIND[t.kind] || 'background', parentId: t.kind === 'subagent' ? t.parent || '' : '', branch: t.branch || '',
    detail: !!conv,
  };
  if (conv) {
    Object.assign(s, { state: conv.state, activity: conv.activity, running: conv.running, lastUserAt: conv.lastUserAt || 0 });
    if (conv.waitingFor) s.waitingFor = conv.waitingFor;
    if (conv.lastReplyAt) s.lastReplyAt = conv.lastReplyAt;
    const left = (Array.isArray(conv.left) ? conv.left : []).map((k) => LEFT_WORDS[k]).filter(Boolean);
    if (left.length) s.hover = left;
  } else Object.assign(s, { activity: 'stopped', running: false });
  const places = (Array.isArray(holders) ? holders : []).slice(0, PLACES_MAX);
  if (places.length) {
    s.elsewhere = places.map((h) => ({ kind: h.kind, label: h.label, detail: (h.detail || []).slice(), running: h.kind === 'exec' || !!(conv && conv.running) }));
    if (places.length + (here ? 1 : 0) > 1) s.processes = places.length + (here ? 1 : 0);
  }
  if (goal && goal.status && goal.status !== 'complete') {
    s.badges = [{ text: GOAL_WORD[goal.status] || 'goal', tooltip: goalText(goal), dim: goal.status !== 'active' }];
    s.actions = ['goal.clear'];
    if (goal.status === 'active') s.actions.unshift('goal.pause');
    if (RESUMABLE.includes(goal.status)) s.actions.unshift('goal.resume');
  }
  return s;
}

/* One page of `all` from `cursor` (a position, as a string), and the cursor of the next page or null. */
function pageOf(all, cursor, limit) {
  const from = Math.max(0, Number(cursor) || 0);
  const n = Math.max(1, Math.min(Number(limit) || 500, 1000));
  return { sessions: all.slice(from, from + n), cursor: from + n < all.length ? String(from + n) : null };
}

/*
 * What Codex's own list had for this project's `threads`, for the list's one import: the conversations Codex archived
 * (with when), its sections as groups, its Pinned section and pin mark as pinned, and Codex Plus's title colours.
 * `sections` is Codex's sections in order, as [id, name]; `pinnedSection` the id of its built-in Pinned section.
 */
function importOf(threads, { sections = [], pinnedSection = '', colors = {} } = {}) {
  const names = new Map(sections);
  const groups = new Map();
  const archived = [], pinned = [], colours = {};
  for (const t of threads) {
    if (t.archived) archived.push({ sessionId: t.id, at: +t.archivedMs || 0 });
    if (t.pinned || (pinnedSection && t.section === pinnedSection)) pinned.push(t.id);
    else if (t.section && names.has(t.section)) {
      const name = String(names.get(t.section) || '').trim();
      if (name) { if (!groups.has(name)) groups.set(name, []); groups.get(name).push(t.id); }
    }
    if (colors[t.id]) colours[t.id] = colors[t.id];
  }
  return { archived, groups: [...groups].map(([name, sessionIds]) => ({ name, sessionIds })), pinned, colors: colours };
}

/*
 * The Account & usage part from src/account-usage.js viewOf, with the conversation in front's tokens: rows, the rate
 * limits as bars with when they reset, and the token counts.
 */
function accountOf(view, conv) {
  if (!view) return null;
  const n = (x) => Number(x).toLocaleString('en-US');
  const out = {
    rows: [...(view.account || []), ...(view.tokens || []).map((k) => ({ label: k.label, value: n(k.value) }))],
    bars: (view.windows || []).map((w) => ({ label: w.name === 'Limit' ? 'Limit' : `${w.name} limit`, percent: w.usedPercent,
      resetsAt: w.resetsAt ? w.resetsAt * 1000 : 0 })),
  };
  const used = conv && conv.tokens;
  const total = used && (Number.isFinite(+used.total) ? +used.total : Number.isFinite(+used.totalTokens) ? +used.totalTokens : null);
  if (conv) out.conversation = { title: conv.title || '', rows: total !== null && total !== undefined ? [{ label: 'Tokens', value: n(total) }] : [] };
  return out;
}

module.exports = { sessionOf, pageOf, importOf, accountOf, goalText, GOAL_WORD, RESUMABLE, OWN, LEFT_WORDS, PINNED_SECTION, COLOR_KEY };
