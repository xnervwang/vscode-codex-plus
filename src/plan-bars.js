// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The plan bar above the message box in Codex's page (codexPlus.planBar): one line saying where the conversation's work
 * plan stands. The page script draws and positions the bar using Agent Plus's shared fragment in src/page/plan-bar.js;
 * this file gets each conversation's summary from Agent Plus and runs one of its two commands when the bar is clicked.
 *
 * The summary, the change event and the two commands are Agent Plus's planSummary feature (docs/protocol.md there). An
 * Agent Plus without it gives no summaries, so no page draws a bar. Each request for a summary makes Agent Plus follow
 * the conversation and stat its plan files, so this file requests the summary once per conversation, caches it for page
 * redraws, and requests it again only when Agent Plus reports a change to that summary or a page loads afresh.
 * Requesting the summary on a fresh page makes Agent Plus resume following the conversation if requests from other
 * extensions have pushed it out of the KEPT limit.
 */
const { coreHas } = require('./core-link');

const FEATURE = 'planSummary';
/* The id the Codex source registers with Agent Plus (src/codex-source.js). */
const SOURCE_ID = 'codex';
const COMMANDS = { open: 'agentPlus.showWorkPlanOf', answer: 'agentPlus.answerQuestionOf' };
/* As many conversations as Agent Plus follows for changes. */
const KEPT = 200;
const MAX_ID = 200;
/* What a page is sent: whether the bar is on at all, and the summary of the page's conversation, null for no bar. */
const PAGE_TYPE = 'codex-extras-plan-bar';
const NO_BAR = Object.freeze({ type: PAGE_TYPE, on: false, summary: null });

const usableId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;

/*
 * `onChange(sessionId)` is called when a kept summary changed, and `onChange(null)` when the bar was turned on or off,
 * so the caller can send the pages their bars again.
 */
function createPlanBars({ core = null, enabled = () => false, onChange = () => {}, exec = async () => {}, log = () => {} } = {}) {
  let sub = null;
  const kept = new Map();
  const offered = () => coreHas(core, FEATURE) && typeof core.planSummary === 'function' && typeof core.onDidChangePlanSummary === 'function';

  function ask(sessionId) {
    let s = null;
    try { s = core.planSummary(SOURCE_ID, sessionId); } catch (e) { log(`reading the plan summary from Agent Plus: ${(e && e.message) || e}`); }
    const summary = s && typeof s === 'object' ? s : null;
    kept.delete(sessionId);
    kept.set(sessionId, summary);
    while (kept.size > KEPT) kept.delete(kept.keys().next().value);
    return summary;
  }

  function heard(e) {
    if (!sub || !e || e.sourceId !== SOURCE_ID || !usableId(e.sessionId) || !kept.has(e.sessionId)) return;
    ask(e.sessionId);
    onChange(e.sessionId);
  }

  /* Listens while the setting is on and Agent Plus offers the summaries. */
  function sync() {
    const want = !!enabled() && offered();
    if (want && !sub) {
      try { sub = core.onDidChangePlanSummary(heard); } catch (e) {
        log(`listening for Agent Plus's plan summaries: ${(e && e.message) || e}`);
        sub = null;
        return;
      }
      onChange(null);
    } else if (!want && sub) {
      try { sub.dispose(); } catch (_) { /* gone */ }
      sub = null;
      kept.clear();
      onChange(null);
    }
  }

  /* The summary to draw for `sessionId`, or null. */
  function summaryOf(sessionId, { fresh = false } = {}) {
    if (!sub || !usableId(sessionId)) return null;
    return kept.has(sessionId) && !fresh ? kept.get(sessionId) : ask(sessionId);
  }

  /* The message for the page showing `sessionId`, which is '' while the page has no conversation yet. */
  const view = (sessionId, opts) => (sub ? { type: PAGE_TYPE, on: true, summary: summaryOf(sessionId, opts) } : NO_BAR);

  /* A click on the bar ('open') or on its questions part ('answer'). */
  async function act(sessionId, action) {
    const command = Object.prototype.hasOwnProperty.call(COMMANDS, action) ? COMMANDS[action] : '';
    if (!sub || !command || !usableId(sessionId)) return false;
    await exec(command, { sourceId: SOURCE_ID, sessionId });
    return true;
  }

  function dispose() {
    if (sub) { try { sub.dispose(); } catch (_) { /* gone */ } }
    sub = null;
    kept.clear();
  }

  return { sync, summaryOf, view, act, on: () => !!sub, dispose };
}

module.exports = { createPlanBars, FEATURE, SOURCE_ID, COMMANDS, KEPT, PAGE_TYPE, NO_BAR };
