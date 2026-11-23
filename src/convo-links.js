// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Links in Codex's page to the other conversations a reply names (codexPlus.conversationLinks). The page script finds
 * the names and draws the links (src/page/codex-extras-page.js); this side gives it the conversations to look for and
 * opens the one a link names.
 *
 * The list is every agent's conversations, from Agent Plus's allConversations (its docs/protocol.md). Agent Plus
 * gathers it only while something listens, so this listens only while the setting is on. A page is sent only what it
 * matches and labels by: the agent, the id, the title and when it was last active. A click comes back as an agent and
 * an id, and the folder Agent Plus opens the conversation in is taken from this side's own copy of the list.
 */
const { coreHas } = require('./core-link');

const FEATURE = 'allConversations';
const OPEN = 'agentPlus.openConversation';
/* As many as Agent Plus lists for one source, for a few sources. */
const MAX_LIST = 8000;
const MAX_TITLE = 300;
const MAX_ID = 200;

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function createConversationLinks({ core = null, enabled = () => false, onChange = () => {}, exec = async () => {}, log = () => {} } = {}) {
  let sub = null, full = [], list = [], version = 0;
  const offered = () => coreHas(core, FEATURE) && typeof core.allConversations === 'function'
    && typeof core.onDidChangeAllConversations === 'function';

  function read() {
    let got = [];
    try { got = core.allConversations(); } catch (e) { log(`reading Agent Plus's conversations: ${(e && e.message) || e}`); }
    full = (Array.isArray(got) ? got : []).filter((c) => c && typeof c.sessionId === 'string' && c.sessionId && c.sessionId.length <= MAX_ID)
      .slice(0, MAX_LIST).map((c) => ({ sourceId: text(c.sourceId, MAX_ID), label: text(c.label, MAX_ID), sessionId: c.sessionId,
        title: text(c.title, MAX_TITLE), cwd: text(c.cwd, 4096), lastActiveAt: Number.isFinite(+c.lastActiveAt) ? +c.lastActiveAt : 0 }));
    list = full.map((c) => ({ sourceId: c.sourceId, label: c.label, sessionId: c.sessionId, title: c.title, lastActiveAt: c.lastActiveAt }));
    version++;
  }

  /* Starts or stops listening as the setting now says. */
  function sync() {
    const want = !!enabled() && offered();
    if (want && !sub) {
      try {
        sub = core.onDidChangeAllConversations(() => { read(); onChange(); });
      } catch (e) {
        log(`listening for Agent Plus's conversations: ${(e && e.message) || e}`);
        sub = null;
        return;
      }
      read();
      onChange();
    } else if (!want && sub) {
      try { sub.dispose(); } catch (_) { /* gone */ }
      sub = null;
      full = [];
      list = [];
      version++;
      onChange();
    }
  }

  /* `version` changes whenever `list` or `on` does, so a page is sent the list again only then. */
  const view = () => ({ on: !!sub, version, list });

  async function open(sourceId, sessionId) {
    if (!sub || typeof sourceId !== 'string' || typeof sessionId !== 'string') return false;
    const c = full.find((x) => x.sourceId === sourceId && x.sessionId === sessionId);
    if (!c) return false;
    await exec(OPEN, { sourceId: c.sourceId, sessionId: c.sessionId, title: c.title, cwd: c.cwd });
    return true;
  }

  function dispose() {
    if (sub) { try { sub.dispose(); } catch (_) { /* gone */ } }
    sub = null;
    full = [];
    list = [];
  }

  return { sync, view, open, dispose };
}

module.exports = { createConversationLinks, FEATURE, OPEN };
