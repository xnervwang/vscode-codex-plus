// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex as a source of conversations for the shared work plan sidebar and Conversations panel (the source interface of
 * the claude-code-extras workPlanHost, protocol major 3). The same object feeds that host when it is installed and this
 * extension's own views when it is not, so the two can never show Codex differently.
 *
 *   id, label, logo            who the conversations belong to
 *   planPath, planDir          where their plans are (the companion plugin's data directory)
 *   sessionForTab, onDidFocus  which conversation is in front
 *   listConversations          every conversation a person started, with what Codex's own files say about it
 *   reveal                     bring one to the front, in a tab
 *   canDeliver, deliverAnswer  typing an answer into one; not possible without a patch to Codex, so always refused
 *
 * What a conversation's state can be told from files alone: `working` while its rollout has a task_started with no
 * task_complete after it, `unread` while Codex's read receipts say so, `idle` otherwise. `prompt` (waiting on an
 * approval) is never reported: Codex does not write an approval request to any file, it lives only in the window that
 * shows it.
 */
const fs = require('fs');
const path = require('path');
const files = require('./codex-files');
const tabs = require('./codex-tabs');
const install = require('./plugin-install');

/* A turn whose rollout has been silent this long is no longer running, whatever its last line says: the process that
   was writing it is gone (a closed window, a crash). Long tool calls write nothing while they run, so this is generous. */
const STALE_WORKING_MS = 2 * 60 * 60 * 1000;
/* A conversation counts as running while it is working, open in a tab of this window, or was active this recently. */
const RECENT_MS = 15 * 60 * 1000;
const POLL_MS = 3000;
/* The shared-sidebar protocol major this source implements. */
const PROTOCOL = 3;

function logoOf(vscode) {
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  if (!ext || !ext.extensionUri) return null;
  const light = vscode.Uri.joinPath(ext.extensionUri, 'resources', 'blossom-black.svg');
  const dark = vscode.Uri.joinPath(ext.extensionUri, 'resources', 'blossom-white.svg');
  return fs.existsSync(light.fsPath) && fs.existsSync(dark.fsPath) ? { light, dark } : null;
}

/*
 * What Codex's files say about one thread, in the source interface's terms. `now` and `openHere` are passed in so the
 * same answer can be computed in a test.
 */
function conversationOf(thread, { unread, openHere, now = Date.now(), state = null }) {
  const st = state || (thread.rollout ? files.rolloutState(thread.rollout) : null);
  const last = Math.max(thread.updatedMs || 0, (st && st.lastActivityMs) || 0);
  const working = !!(st && st.working && now - last < STALE_WORKING_MS);
  let word = 'idle';
  if (working) word = 'working';
  else if (unread.has(thread.id)) word = 'unread';
  return {
    sessionId: thread.id,
    title: thread.title || '(untitled)',
    cwd: thread.cwd,
    state: word,
    running: working || openHere.has(thread.id) || now - last < RECENT_MS,
    lastActiveAt: last,
    hasPlan: fs.existsSync(path.join(install.planDir(files.codexHome()), `${thread.id}.json`)),
    // Beyond the interface: what this extension's own views draw.
    model: (st && st.model) || thread.model,
    effort: (st && st.effort) || thread.effort,
    context: st && st.context,
    lastTool: st && st.lastTool,
    turnStartedMs: st && st.startedMs,
    archived: thread.archived,
  };
}

function createCodexSource(vscode, { log = () => {} } = {}) {
  const changed = new vscode.EventEmitter();
  const focused = new vscode.EventEmitter();
  let signature = '';
  let timer = null;

  /* Cheap: the state database's and its write-ahead log's sizes and times, and the size of every rollout touched in the
     last day. Only when that moves is the list read again and the change announced. */
  function stamp() {
    const home = files.codexHome();
    const db = files.stateDbPath(home);
    const parts = [];
    for (const f of [db, db && db + '-wal']) {
      try { const s = fs.statSync(f); parts.push(s.size, s.mtimeMs); } catch (_) { parts.push(0); }
    }
    const day = Date.now() - 24 * 3600e3;
    for (const t of files.listThreads(home) || []) {
      if (t.kind !== 'user' || t.updatedMs < day || !t.rollout) continue;
      try { const s = fs.statSync(t.rollout); parts.push(t.id.slice(-6), s.size); } catch (_) { /* gone */ }
    }
    return parts.join(',');
  }

  function poll() {
    let next = '';
    try { next = stamp(); } catch (e) { log(`codex source: ${e.message}`); }
    if (next !== signature) { signature = next; changed.fire(); }
  }

  const source = {
    protocol: PROTOCOL,
    // Optional capabilities by name (protocol section 7): none beyond the interface yet.
    features: [],
    id: 'codex',
    label: 'Codex',
    get logo() { return logoOf(vscode); },
    planPath(sessionId) {
      return files.THREAD_ID.test(String(sessionId || '')) ? path.join(install.planDir(files.codexHome()), `${sessionId}.json`) : null;
    },
    planDir() { return install.planDir(files.codexHome()); },
    sessionForTab(tab) { return tabs.threadOfTab(vscode, tab) || null; },
    onDidFocus: focused.event,
    async listConversations() {
      const threads = (files.listThreads() || []).filter((t) => t.kind === 'user');
      const unread = files.unreadThreads();
      const openHere = new Set(tabs.codexTabs(vscode).map((t) => t.thread));
      return threads.map((t) => conversationOf(t, { unread, openHere }));
    },
    onDidChangeConversations: changed.event,
    async reveal(sessionId) {
      if (!files.THREAD_ID.test(String(sessionId || ''))) return false;
      try { return await tabs.openInTab(vscode, sessionId); } catch (e) { log(`reveal ${sessionId}: ${e.message}`); return false; }
    },
    canDeliver() { return false; },
    async deliverAnswer() {
      return { delivered: false, reason: 'Codex has no way for another extension to type into a conversation yet.' };
    },
    /* For the patch, when there is one: a conversation came to the front outside an editor tab (Codex's sidebar). */
    _focus(sessionId) { if (sessionId) focused.fire({ sessionId }); },
    _poll: poll,
    dispose() { if (timer) clearInterval(timer); changed.dispose(); focused.dispose(); },
  };
  timer = setInterval(poll, POLL_MS);
  poll();
  return source;
}

module.exports = { createCodexSource, conversationOf, logoOf, PROTOCOL, STALE_WORKING_MS, RECENT_MS };
