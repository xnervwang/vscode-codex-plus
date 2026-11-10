// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Builds the Agent map for one Codex conversation: the dialog Claude Code opens from its "N agents" button, plus the
 * timers Claude Code Plus adds to it. Here it lists the conversation's wake-up (src/wakeup.js), its goal and the
 * sub-agents it started. Everything comes from the in-memory snapshot (src/codex-reader.js); the worker reads the
 * wake-up files along with the plan files, so nothing here touches the disk. The page script draws the button and the
 * dialog (src/page/codex-extras-page.js) and shows the button only while `shown` is true.
 */
const { lookKey } = require('./sessions-view');

/* What the dialog's buttons may ask the host to do. */
const ACTIONS = ['removeWakeup', 'pauseGoal', 'resumeGoal', 'clearGoal', 'setGoal', 'openAgent'];

/*
 * `reader` is the snapshot. `stateOf(id)` returns a thread's state as computed by threadState in src/codex-source.js,
 * or null when its rollout has not been read; such a sub-agent is drawn without a dot.
 */
function mapOf(thread, { reader, stateOf = () => null }) {
  const w = thread ? reader.wakeup(thread) : null;
  const wakeups = w ? [{ everyMinutes: w.everyMinutes, prompt: w.prompt, expiresMs: w.expiresMs, paused: !!w.paused,
    nextMs: w.paused ? 0 : Math.max(w.setMs, w.firedMs || 0) + w.everyMinutes * 60e3 }] : [];
  const g = thread ? reader.goal(thread) : null;
  const goal = g ? { status: String(g.status || ''), objective: String(g.objective || ''), tokensUsed: +g.tokensUsed || 0,
    tokenBudget: +g.tokenBudget || 0 } : null;
  const agents = (thread ? reader.threads() || [] : []).filter((t) => t.kind === 'subagent' && t.parent === thread && t.id !== thread && !t.archived)
    .sort((a, b) => (a.createdMs - b.createdMs) || a.id.localeCompare(b.id))
    .map((t) => {
      const c = stateOf(t.id);
      return { id: t.id, name: String(t.nickname || '') || t.title || '(untitled)', title: t.title || '', dot: c ? lookKey(c, true) : 'unknown',
        updatedMs: Math.max(t.updatedMs || 0, (c && c.lastActiveAt) || 0) };
    });
  return { type: 'codex-extras-agent-map', shown: wakeups.length > 0 || !!goal || agents.length > 0, wakeups, goal, agents };
}

/* What a page is sent while there is nothing to draw, or no conversation. */
const NO_MAP = { type: 'codex-extras-agent-map', shown: false, wakeups: [], goal: null, agents: [] };

module.exports = { mapOf, ACTIONS, NO_MAP };
