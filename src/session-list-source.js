// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex's part of Agent Plus's session list (Agent Plus docs/protocol.md, Session list): the members the Codex source
 * adds for it. Agent Plus draws the list and keeps its groups, archive, pins, colours and read marks; the Codex source
 * lists Codex's conversations in the window's folders, says what each one is doing, and carries out what the list asks.
 *
 * A conversation is listed from the reader's snapshot (src/codex-reader.js), including those Codex has moved to its
 * archived_sessions folder; the list imports those once as archived. A conversation's activity comes from the source's
 * own reading of it (src/codex-source.js conversationOf). One whose rollout (its log file) has not been read has
 * `detail: false`, and the list asks for its detail (wantSessionDetail) once its row is on screen. lastActiveAt is when
 * it last had a message, not when its database row was last written: renaming it, moving it between sections of Codex's
 * own list or archiving it writes that row.
 *
 * A goal is a badge on the row, and Pause Goal, Resume Goal and Clear Goal are Codex's own actions in the row's menu.
 *
 * Where else a conversation is open comes from the processes holding Codex's writer lock on it (src/writer-locks.js),
 * leaving out this window's own Codex. Agent Plus itself finds the conversation open in another VS Code window from the
 * record of open conversations that window writes.
 */
const GOAL_WORD = { active: 'goal', paused: 'goal paused', blocked: 'goal blocked', usageLimited: 'goal: usage limit',
  budgetLimited: 'goal: budget spent', complete: 'goal done' };
/* The goal states Resume Goal restarts from: the ones Codex stopped it in, and the user's own pause. */
const RESUMABLE = ['paused', 'blocked', 'usageLimited', 'budgetLimited'];
const OWN = [{ id: 'goal.pause', title: 'Pause Goal' }, { id: 'goal.resume', title: 'Resume Goal' }, { id: 'goal.clear', title: 'Clear Goal' }];
/* The hover line for each kind of work src/left-running.js finds still running after a turn. */
const LEFT_WORDS = {
  subagent: 'A sub-agent is still running',
  command: 'A background command is still running',
  detached: 'A command it detached is still running',
  codexExec: 'A codex exec it started is still running',
  claudeWorker: 'A claude -p worker it started is still running',
  claudeBg: 'A claude --bg session it started is still busy',
};
const KIND = { user: 'user', subagent: 'subagent' };
/* The id of Codex's built-in Pinned section, which its state database keeps like any other section. */
const PINNED_SECTION = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
/* Where Codex Plus kept the title colours of its own list, handed over once by the import. */
const COLOR_KEY = 'codexPlus.titleColors';

function goalText(g) {
  if (!g) return '';
  const n = (x) => Number(x).toLocaleString('en-US');
  const used = g.tokenBudget ? `${n(g.tokensUsed)} of ${n(g.tokenBudget)} tokens` : `${n(g.tokensUsed)} tokens, no budget`;
  return `Goal (${GOAL_WORD[g.status] || g.status}, ${used}): ${String(g.objective || '').slice(0, 240)}`;
}

/* The protocol's limit on how many places one Session lists (Agent Plus docs/protocol.md, Limits). */
const PLACES_MAX = 8;

/*
 * A Session for thread `t`. `conv` is the source's reading of it (conversationOf), or null when its rollout has not
 * been read; `goal` is null when it has none; `holders` the processes elsewhere holding it open (codex-source
 * holdersOf). A place (one holder, as an entry of the Session's `elsewhere`) counts as running while the conversation's
 * activity is working, since only the holder can write it, and a `codex exec` place always counts as running. `here` is
 * whether a tab or the sidebar of this window shows it: with a holder elsewhere too, it is open in two processes at
 * once, and Codex shows this window's page as unable to write it.
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
    /* Codex Plus's own record of what was read, which a tab's Mark as Unread also sets. */
    if (conv.unseen) s.unseen = true;
    const left = (Array.isArray(conv.left) ? conv.left : []).map((k) => LEFT_WORDS[k]).filter(Boolean);
    if (left.length) s.hover = left;
  } else Object.assign(s, { activity: 'stopped', running: false });
  const places = (Array.isArray(holders) ? holders : []).slice(0, PLACES_MAX);
  if (places.length) {
    s.elsewhere = places.map((h) => ({ kind: h.kind, label: h.label, detail: (h.detail || []).slice(), running: h.kind === 'exec' || !!(conv && conv.activity === 'working') }));
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

/* The page of `all` that starts at `cursor`, a position written as a string, with the next page's cursor or null. */
function pageOf(all, cursor, limit) {
  const from = Math.max(0, Number(cursor) || 0);
  const n = Math.max(1, Math.min(Number(limit) || 500, 1000));
  return { sessions: all.slice(from, from + n), cursor: from + n < all.length ? String(from + n) : null };
}

/*
 * The list's one-time import, from what Codex's own list had for this project's `threads`: the conversations Codex
 * archived and when, its sections, which become groups, the conversations Codex pinned (in its Pinned section or by its
 * pin mark), and Codex Plus's title colours. `sections` lists Codex's sections in order as [id, name] pairs.
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
 * The Account & usage part from src/account-usage.js viewOf, plus the token count of the conversation in front: rows,
 * a bar for each rate limit with its reset time, and the token counts.
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
