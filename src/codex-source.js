// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex as a conversation source of Agent Work Plan (xnervwang.agent-work-plan, protocol 1; its docs/protocol.md), which
 * draws the work plan, Conversations and Answer views.
 *
 *   id, label, logo, extensionId   who the conversations belong to
 *   planPath, planDir              where their plans are (the companion plugin's data directory)
 *   sessionForTab, onDidFocus,     which conversation is in front, and whether a reported one still is
 *   isFocused
 *   listConversations              every conversation a person started, from the reader's latest snapshot
 *   reveal                         bring one to the front: only a tab already in this window
 *   canDeliver, deliverAnswer      typing an answer into one, through the patch to Codex (src/patching.js)
 *
 * What a conversation's state can be told from files alone: `working` while its rollout has a task_started with no
 * task_complete after it, `unread` while Codex's read receipts say so, `idle` otherwise. `prompt` (waiting on an
 * approval) is never reported: Codex does not write an approval request to any file.
 *
 * Nothing here reads a file of Codex's: src/codex-reader.js has the snapshot its worker thread made.
 */
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
/* The protocol major this source implements; package.json repeats it under "agentWorkPlan". */
const PROTOCOL = 1;
const EXTENSION_ID = 'xnervwang.codex-extras';
/* Delivery ids already handled, so an answer handed over twice is typed once. */
const REMEMBERED = 200;

function logoOf(vscode, exists = require('fs').existsSync) {
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  if (!ext || !ext.extensionUri) return null;
  const light = vscode.Uri.joinPath(ext.extensionUri, 'resources', 'blossom-black.svg');
  const dark = vscode.Uri.joinPath(ext.extensionUri, 'resources', 'blossom-white.svg');
  return exists(light.fsPath) && exists(dark.fsPath) ? { light, dark } : null;
}

/*
 * What Codex's files say about one thread, in the protocol's terms. `state` is the rollout state the reader has for it,
 * or null for a thread not touched lately; `now` and `openHere` are passed in so the same answer can be computed in a
 * test.
 */
function conversationOf(thread, { unread, openHere, now = Date.now(), state = null, hasPlan = false }) {
  const st = state;
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
    hasPlan,
    // Beyond the protocol: what this extension's own parts draw (the tab figures).
    model: (st && st.model) || thread.model,
    effort: (st && st.effort) || thread.effort,
    context: st && st.context,
    lastTool: st && st.lastTool,
    lastTurnMs: st && st.durationMs,
    turnStartedMs: st && st.startedMs,
    archived: thread.archived,
  };
}

/*
 * `deps`: reader (src/codex-reader.js), patching (src/patching.js), enabled() (codexExtras.workPlan), trusted()
 * (not in Restricted Mode) and log.
 */
function createCodexSource(vscode, { log = () => {}, reader, patching = null, enabled = () => true, trusted = () => true } = {}) {
  const changed = new vscode.EventEmitter();
  const focused = new vscode.EventEmitter();
  let timer = null;
  const delivered = new Set();

  const openThreads = () => tabs.codexTabs(vscode).map((t) => t.thread);
  function poll() {
    reader.refresh({ home: files.codexHome(), extra: openThreads() }).then((moved) => { if (moved) changed.fire(); })
      .catch((e) => log(`codex source: ${(e && e.message) || e}`));
  }

  const source = {
    protocol: PROTOCOL,
    features: [],
    id: 'codex',
    label: 'Codex',
    extensionId: EXTENSION_ID,
    get logo() { return logoOf(vscode); },
    planPath(sessionId) {
      if (!enabled() || !files.THREAD_ID.test(String(sessionId || ''))) return null;
      return path.join(install.planDir(files.codexHome()), `${sessionId}.json`);
    },
    planDir() { return install.planDir(files.codexHome()); },
    /* A thread id for a conversation tab, '' for a Codex tab with no conversation yet (a new one), null otherwise. */
    sessionForTab(tab) {
      const id = tabs.threadOfTab(vscode, tab);
      if (id) return id;
      return tabs.isCodexTab(vscode, tab) ? '' : null;
    },
    onDidFocus: focused.event,
    /* Whether `sessionId` is still in front: its tab is the active one, or Codex's sidebar follows it (the patch says). */
    isFocused(sessionId) {
      if (tabs.activeThread(vscode) === sessionId) return true;
      return !!(patching && patching.sidebarThread() === sessionId);
    },
    async listConversations() {
      const snap = await reader.ready(files.codexHome());
      const threads = ((snap && snap.threads) || []).filter((t) => t.kind === 'user');
      const unread = reader.unread();
      const openHere = new Set(openThreads());
      const out = threads.map((t) => conversationOf(t, { unread, openHere, state: reader.state(t.id), hasPlan: enabled() && reader.hasPlan(t.id) }));
      if (snap && !snap.readable) out.problem = 'Codex\'s list of conversations could not be read from ' + files.codexHome();
      return out;
    },
    onDidChangeConversations: changed.event,
    /*
     * Brings a conversation to the front in this window, if a tab here shows it. A conversation running with no tab here
     * is running in another window, which an extension cannot raise, so that is false. One with no tab and not running
     * is offered for opening here, by the person: opening it unasked could make a second copy of a conversation that is
     * open in another window after all.
     */
    async reveal(sessionId, row) {
      if (!files.THREAD_ID.test(String(sessionId || ''))) return false;
      if (tabs.codexTabs(vscode).some((t) => t.thread === sessionId)) {
        try { return await tabs.openInTab(vscode, sessionId); } catch (e) { log(`reveal ${sessionId}: ${e.message}`); return false; }
      }
      const t = reader.thread(sessionId);
      const st = reader.state(sessionId);
      const last = Math.max((t && t.updatedMs) || 0, (st && st.lastActivityMs) || 0);
      if (st && st.working && Date.now() - last < STALE_WORKING_MS) return false;
      const title = (row && row.title) || (t && t.title) || sessionId;
      const open = 'Open it here';
      Promise.resolve(vscode.window.showInformationMessage(`"${title}" is not open in this window.`, open)).then((pick) => {
        if (pick === open) return tabs.openInTab(vscode, sessionId);
        return undefined;
      }).catch((e) => log(`reveal ${sessionId}: ${e.message}`));
      return true;
    },
    canDeliver(sessionId) { return trusted() && !!patching && patching.canDeliver(sessionId); },
    /*
     * Codex fills its message box from the route it is navigated with, only when the box is empty, and nothing reports
     * back which happened, so the outcome is uncertain. Asked again with a delivery id it has seen, it types nothing.
     */
    async deliverAnswer(sessionId, text, opts) {
      const id = opts && typeof opts.deliveryId === 'string' ? opts.deliveryId : '';
      if (id && delivered.has(id)) return { outcome: 'uncertain' };
      if (!trusted() || !patching) return { outcome: 'notReceived', reason: 'this window cannot type into Codex' };
      const r = await patching.deliver(sessionId, text);
      if (id && r.outcome !== 'notReceived') {
        delivered.add(id);
        if (delivered.size > REMEMBERED) delivered.delete(delivered.values().next().value);
      }
      return r;
    },
    /* For the patch: a conversation came to the front outside an editor tab (Codex's sidebar). */
    _focus(sessionId) { if (sessionId) focused.fire({ sessionId }); },
    _poll: poll,
    dispose() { if (timer) clearInterval(timer); changed.dispose(); focused.dispose(); },
  };
  timer = setInterval(poll, POLL_MS);
  poll();
  return source;
}

module.exports = { createCodexSource, conversationOf, logoOf, PROTOCOL, EXTENSION_ID, STALE_WORKING_MS, RECENT_MS };
