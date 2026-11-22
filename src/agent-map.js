// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Builds the Agent map for one Codex conversation: the dialog Claude Code opens from its "N agents" button, plus the
 * timers Claude Code Plus adds to it. Here it lists the conversation's wake-up (src/wakeup.js), its goal, the
 * sub-agents it started, and the work still running that it or a sub-agent started (src/left-running.js): detached
 * commands, background terminals, codex exec runs, claude -p workers and claude --bg sessions, so the user can see why
 * its dot is green. Everything comes from the in-memory snapshot (src/codex-reader.js) and the last scan for work left
 * running; nothing here touches the disk. The page script draws the button and the dialog (src/page/codex-extras-page.js).
 *
 * A sub-agent's dot is its own activity, as on the tabs and in the session list: working, background (only work it
 * started is left), waiting (for the user) or stopped, and unknown while its rollout has not been read. `unseen` marks
 * a reply the user has not looked at, drawn as `envelope` after its name.
 */

/* What the dialog's buttons may ask the host to do. */
const ACTIONS = ['removeWakeup', 'pauseGoal', 'resumeGoal', 'clearGoal', 'openAgent'];
const DOTS = new Set(['working', 'background', 'waiting']);
const dotOf = (c) => (!c ? 'unknown' : DOTS.has(c.activity) ? c.activity : 'stopped');

/*
 * `reader` is the snapshot. `stateOf(id)` returns a thread's state as computed by threadState in src/codex-source.js,
 * or null when its rollout has not been read. `envelope` is the character src/envelope.js picks for the theme.
 */
function mapOf(thread, { reader, stateOf = () => null, detached = () => [], left = () => [], running = () => [], envelope = '' }) {
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
      return { id: t.id, name: String(t.nickname || '') || t.title || '(untitled)', title: t.title || '', dot: dotOf(c), unseen: !!(c && c.unseen),
        updatedMs: Math.max(t.updatedMs || 0, (c && c.lastActiveAt) || 0) };
    });
  const jobs = (thread ? detached(thread) || [] : []).map((d) => ({ pid: d.pid, startMs: +d.startMs || 0, cmd: String(d.cmd || '') }));
  const background = (thread ? running(thread) || [] : []).map((x) => ({ kind: String(x.kind || ''), pid: +x.pid || 0, startMs: +x.startMs || 0,
    cmd: String(x.cmd || ''), name: String(x.name || ''), job: String(x.job || '') }));
  const kinds = (thread ? left(thread) || [] : []).filter((k) => k !== 'subagent');
  return { type: 'codex-extras-agent-map',
    shown: wakeups.length > 0 || !!goal || agents.length > 0 || jobs.length > 0 || background.length > 0 || kinds.length > 0,
    wakeups, goal, agents, detached: jobs, background, kinds, envelope: String(envelope || '') };
}

/* What a page is sent while there is nothing to draw, or no conversation. */
const NO_MAP = { type: 'codex-extras-agent-map', shown: false, wakeups: [], goal: null, agents: [], detached: [], background: [], kinds: [], envelope: '' };

module.exports = { mapOf, ACTIONS, NO_MAP };
