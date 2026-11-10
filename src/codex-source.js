// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex as a conversation source of Agent Plus (xnervwang.agent-plus, protocol 1; its docs/protocol.md), which
 * draws the work plan, Conversations and Answer views.
 *
 *   id, label, logo, extensionId   who the conversations belong to
 *   planPath, planDir              where their plans are (the companion plugin's data directory)
 *   sessionForTab, onDidFocus,     which conversation is in front, and whether a reported one still is
 *   isFocused
 *   listConversations              every conversation a person started, from the reader's latest snapshot
 *   reveal                         bring one to the front: only a tab already in this window
 *   canDeliver, deliverAnswer      typing an answer into one, through the patch to Codex (src/patching.js)
 *   planNotice, timeZone           the row above the plan (the plugin missing, no Python, its hooks not trusted), which
 *                                  the extension sets, and the reader's time zone, which Codex's page reports
 *
 * `working` comes from files: its rollout has a task_started with no task_complete after it, corrected by the turn
 * starts and ends this window's app-server reported since the last read, which arrive at once (turnOf). `unread` is a turn that
 * ended after the user last had the conversation in front of them in a focused window (src/seen.js; Codex's own read
 * receipts stay unread for good inside VS Code). `idle` is the rest. `prompt` comes from the patch instead
 * (src/approvals.js), because Codex writes no approval request to a file, and only for the conversations of this
 * window. One running in another window, or started by `codex exec`, never reports it.
 *
 * This module opens none of Codex's files; src/codex-reader.js has the snapshot its worker thread made.
 */
const path = require('path');
const files = require('./codex-files');
const tabs = require('./codex-tabs');
const install = require('./plugin-install');
const { createSeen } = require('./seen');

/* A turn whose rollout has been silent this long is no longer running, whatever its last line says: the process that
   was writing it is gone (a closed window, a crash). Long tool calls write nothing while they run, so this is generous. */
const STALE_WORKING_MS = 2 * 60 * 60 * 1000;
/* A conversation counts as running while it is working, open in a tab of this window, or was active this recently. */
const RECENT_MS = 15 * 60 * 1000;
const POLL_MS = 3000;
/* The protocol major this source implements; package.json repeats it under "agentPlus". */
const PROTOCOL = 1;
const EXTENSION_ID = 'xnervwang.codex-plus';

function logoOf(vscode, exists = require('fs').existsSync) {
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  if (!ext || !ext.extensionUri) return null;
  const light = vscode.Uri.joinPath(ext.extensionUri, 'resources', 'blossom-black.svg');
  const dark = vscode.Uri.joinPath(ext.extensionUri, 'resources', 'blossom-white.svg');
  return exists(light.fsPath) && exists(dark.fsPath) ? { light, dark } : null;
}

/*
 * The rollout is read only every POLL_MS, while this window's app-server notifies a turn start or end as it happens
 * (`heard`, src/patching.js turnHeard). After a turn/started the conversation is running, and after a turn/completed
 * the rollout's running turn counts as ended, unless the rollout shows a turn that started later.
 */
function turnOf(st, heard, now, last) {
  if (heard && heard.running) return { working: true, endedMs: 0 };
  const heardEnd = (heard && heard.endedMs) || 0;
  const overtaken = !!(st && st.working && heardEnd && !(st.startedMs > heardEnd));
  const working = !!(st && st.working && !overtaken && now - last < STALE_WORKING_MS);
  if (st && st.working && !overtaken) return { working, endedMs: 0 };
  return { working, endedMs: Math.max((st && !st.working && st.endedMs) || 0, heardEnd) };
}

/*
 * What Codex's files say about one thread, in the protocol's terms. `state` is the rollout state the reader has for it,
 * or null for a thread not touched lately; `now` and `openHere` are passed in so the same answer can be computed in a
 * test. `waiting` is what the patch knows about requests stopped on the user, which no file records.
 *
 * `prompt` wins over `working`: as far as its rollout goes a turn stopped on an approval is still running, but it is
 * the user who has to act.
 */
function conversationOf(thread, { unread, openHere, now = Date.now(), state = null, hasPlan = false, waiting = null, heard = null }) {
  const st = state;
  const last = Math.max(thread.updatedMs || 0, (st && st.lastActivityMs) || 0, (heard && Math.max(heard.startedMs || 0, heard.endedMs || 0)) || 0);
  const { working } = turnOf(st, heard, now, last);
  const decide = (waiting && waiting.decide) || 0;
  const soon = (waiting && waiting.soon) || 0;
  /* A question asked with request_user_input_async waits for the user once its turn has ended (src/codex-files.js). */
  const asking = !working && !!(st && st.askedMs);
  let word = 'idle';
  if (decide || soon) word = 'prompt';
  else if (working) word = 'working';
  else if (asking) word = 'prompt';
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
    /* The rollout's own answer, which `state` no longer carries once `prompt` wins it: what decides whether a request
       stopped on the user is still live (src/approvals.js prune) has to not be derived from those requests. */
    working,
    /* Set while this window's app-server runs the turn. The session list uses it to tell a conversation running here
       without a tab from one running in another window. */
    runningHere: !!(heard && heard.running),
    failed: !working && !!(st && st.error),
    decide,
    soon,
    asking,
    model: (st && st.model) || thread.model,
    effort: (st && st.effort) || thread.effort,
    context: st && st.context,
    tokens: st && st.tokens,
    lastTool: st && st.lastTool,
    lastTurnMs: st && st.durationMs,
    turnStartedMs: st && st.startedMs,
    archived: thread.archived,
  };
}

/* The conversation a tab whose URI names `thread` shows now, which the patch knows when its panel started another one
   in the same tab (src/patching.js nowShowing). */
function namedNow(patching, thread) {
  if (!thread || !patching || typeof patching.nowShowing !== 'function') return thread;
  try { return patching.nowShowing(thread) || thread; } catch (_) { return thread; }
}

/*
 * The conversation of a Codex tab whose URI does not name one, found by elimination in the one case where it is
 * unambiguous: exactly one such tab in this window, and exactly one conversation the patch reports a panel for that no
 * other tab already shows. With two of either it stays '': which tab holds which conversation is then known only for
 * a tab in front (threadOfCodexTab), and a guess would hang one conversation's work plan on another.
 */
function unnamedTabThread(vscode, patching) {
  if (!patching || typeof patching.panelThreads !== 'function') return '';
  const groups = (vscode.window.tabGroups && vscode.window.tabGroups.all) || [];
  const claimed = new Set();
  let unnamed = 0;
  for (const group of groups) {
    for (const tab of group.tabs || []) {
      if (!tabs.isCodexTab(vscode, tab)) continue;
      const id = tabs.threadOfTab(vscode, tab);
      if (id) claimed.add(namedNow(patching, id)); else unnamed++;
    }
  }
  if (unnamed !== 1) return '';
  let free = [];
  try { free = patching.panelThreads().filter((t) => t && !claimed.has(t)); } catch (_) { return ''; }
  return free.length === 1 ? free[0] : '';
}

/*
 * The conversation a Codex tab shows, '' when that is not known (a conversation not started yet, or no way to tell).
 * A tab in front of its group is matched to the one panel visible in that column; any other goes by its URI, as the
 * patch has it now, and a tab whose URI names nothing by elimination.
 */
function threadOfCodexTab(vscode, patching, tab) {
  if (tab && tab.isActive && patching && typeof patching.shownIn === 'function') {
    const group = ((vscode.window.tabGroups && vscode.window.tabGroups.all) || []).find((g) => g.activeTab === tab);
    let shown = null;
    try { shown = group ? patching.shownIn(group.viewColumn) : null; } catch (_) { shown = null; }
    if (shown) return shown.thread;
  }
  const named = tabs.threadOfTab(vscode, tab);
  if (named) return namedNow(patching, named);
  return tabs.isCodexTab(vscode, tab) ? unnamedTabThread(vscode, patching) : '';
}

/*
 * `deps`: reader (src/codex-reader.js), patching (src/patching.js), enabled() (codexPlus.workPlan), trusted()
 * (not in Restricted Mode), seen (src/seen.js) and log.
 */
function createCodexSource(vscode, { log = () => {}, reader, patching = null, enabled = () => true, trusted = () => true,
  seen = createSeen() } = {}) {
  const changed = new vscode.EventEmitter();
  const focused = new vscode.EventEmitter();
  /* The row above the work plan, set by the extension (_setNotice): { title, description, detail, command, arguments }. */
  const noticeChanged = new vscode.EventEmitter();
  let notice = null;
  let timer = null;
  /* Delivery ids already handled, so an answer handed over twice is typed once. Never trimmed: an id that fell off the
     end would be typed a second time, which is the one thing it is here to prevent. */
  const delivered = new Set();
  const subs = [];
  /*
   * Whether the user has gone somewhere else since Codex's sidebar last came to the front. The sidebar has no signal
   * of its own for still being where they are looking: the broadcast behind it (src/patching.js,
   * thread-stream-following-changed) says which conversation it started following and nothing after that, and VS Code
   * tells an extension nothing about which view has keyboard focus. The active editor tab becoming a tab that is not
   * Codex's is as close as it gets, and it is what Agent Plus's question a moment later turns on.
   */
  let leftSidebar = false;
  /* The conversation Codex's sidebar shows while one of its views is visible: a hidden sidebar is not in front, whatever
     it last went to. A stand-in patch without that answer is taken at its last conversation. */
  const sidebarInFront = () => {
    if (!patching) return '';
    try {
      if (typeof patching.sidebarShowing === 'function') return patching.sidebarShowing() || '';
      return typeof patching.sidebarThread === 'function' ? patching.sidebarThread() || '' : '';
    } catch (_) { return ''; }
  };
  let frontTab;
  const activeTab = () => {
    const groups = vscode.window.tabGroups;
    const group = groups && groups.activeTabGroup;
    return group ? group.activeTab : undefined;
  };
  const tabsChanged = () => {
    const tab = activeTab();
    if (tab === frontTab) return;
    frontTab = tab;
    if (tab && !tabs.isCodexTab(vscode, tab)) leftSidebar = true;
    if (markFront()) changed.fire();
  };
  {
    const groups = vscode.window.tabGroups;
    for (const name of ['onDidChangeTabs', 'onDidChangeTabGroups']) {
      if (groups && typeof groups[name] === 'function') { try { subs.push(groups[name](tabsChanged)); } catch (_) { /* no tab events here */ } }
    }
    if (typeof vscode.window.onDidChangeWindowState === 'function') {
      try { subs.push(vscode.window.onDidChangeWindowState((s) => { if (s && s.focused && markFront()) changed.fire(); })); } catch (_) { /* none */ }
    }
  }

  /* The conversations in front of the user: the active tab's, and Codex's sidebar's while isFocused() still counts it.
     None while the window itself is not focused, since a reply that arrives then has not been looked at. */
  function frontThreads() {
    if (vscode.window.state && vscode.window.state.focused === false) return [];
    const out = [];
    const tab = activeTab();
    if (tab) {
      const id = threadOfCodexTab(vscode, patching, tab);
      if (id) out.push(id);
    }
    if (!leftSidebar) {
      const id = sidebarInFront();
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  }
  /* What this window's app-server said of a conversation's turns, or null without the patch. */
  const heardOf = (id) => {
    if (!patching || typeof patching.turnHeard !== 'function') return null;
    try { return patching.turnHeard(id); } catch (_) { return null; }
  };
  const endedOf = (id) => turnOf(reader.state(id), heardOf(id), Date.now(), 0).endedMs;
  /* Marks what is in front as seen now, and returns true when that cleared an unread state, so the views redraw at
     once. Conversations that were in front on the previous call and are not now are reported to seen.left(). */
  let wasFront = [];
  function markFront() {
    let cleared = false;
    const front = frontThreads();
    for (const id of wasFront) if (!front.includes(id) && typeof seen.left === 'function') seen.left(id);
    wasFront = front;
    for (const id of front) {
      const was = seen.unread(id, endedOf(id));
      seen.mark(id);
      if (was && !seen.unread(id, endedOf(id))) cleared = true;
    }
    return cleared;
  }

  /*
   * The conversations open in this window: the ones named by their tab's URI, and the ones only the patch can name.
   * A tab Codex opened with its New button keeps the URI /extension/panel/new whatever conversation goes into it, so
   * the URIs alone miss every conversation the user started that way (src/codex-tabs.js); the patch learns those from
   * the thread start of the tab's own page.
   */
  const openThreads = () => {
    const out = tabs.codexTabs(vscode).map((t) => t.thread);
    if (patching && typeof patching.panelThreads === 'function') {
      try { for (const t of patching.panelThreads()) if (t && !out.includes(t)) out.push(t); } catch (_) { /* no patch */ }
    }
    return out;
  };
  /* What the patch knows about requests this conversation is stopped on, or null without the patch. */
  const waitingOn = (id) => {
    if (!patching || typeof patching.approvalsOf !== 'function') return null;
    try { return patching.approvalsOf(id); } catch (_) { return null; }
  };
  /* Shapes of Codex tabs whose thread could not be read, already said once. */
  const unreadable = new Set();
  function noteUnreadableTab(tab) {
    const shape = tabs.tabShape(tab);
    if (unreadable.has(shape)) return;
    unreadable.add(shape);
    log(`a Codex tab does not name its conversation and the patch could not say which it is: ${shape}`);
  }
  /*
   * Conversations whose rollout state was asked for beyond the ones read on every pass: the rows of a history group
   * somebody expanded. They are read on the next scheduled poll, without a timer of their own, and they stay in
   * the set so the state is cached rather than read again every pass.
   */
  const wanted = new Set();
  /* `tell` fires the change whatever the read found: a turn the app-server reported has moved the state already. */
  function poll({ force = false, tell = false } = {}) {
    const extra = [...new Set([...openThreads(), ...wanted])];
    return reader.refresh({ home: files.codexHome(), extra, force }).then((moved) => {
      // An answered request is dropped: the reader keeps that state, so asking again would read the rollout afresh
      // every pass for a row that has not changed.
      for (const id of [...wanted]) if (reader.state(id)) wanted.delete(id);
      const cleared = markFront();
      if (tell || cleared || moved) changed.fire();
    }).catch((e) => log(`codex source: ${(e && e.message) || e}`));
  }
  /*
   * Ask for the rollout state of conversations the reader passes over, for rows now on screen. One pass is made at
   * once, because the stamp has not moved and the next poll would answer "nothing changed" and read nothing; after
   * that the ordinary poll covers them.
   */
  function wantState(ids) {
    let added = false;
    for (const id of ids || []) if (id && !wanted.has(id) && !reader.state(id)) { wanted.add(id); added = true; }
    if (!added) return Promise.resolve(false);
    const go = () => poll({ force: true });
    return reader.busy ? Promise.resolve(reader.busy).then(go, go) : go();
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
      if (!tabs.threadOfTab(vscode, tab) && !tabs.isCodexTab(vscode, tab)) return null;
      const id = threadOfCodexTab(vscode, patching, tab);
      if (id) return id;
      noteUnreadableTab(tab);
      return '';
    },
    onDidFocus: focused.event,
    /*
     * Whether `sessionId` is still in front: its own tab is the active one, or Codex's sidebar came to the front with
     * it, is still showing, and the user has not gone to a tab of something else since. Without that second condition the sidebar would
     * answer for a conversation the user left, and the work plan view would be pulled back to it.
     */
    isFocused(sessionId) {
      if (!sessionId) return false;
      const tab = activeTab();
      if (tab && threadOfCodexTab(vscode, patching, tab) === sessionId) return true;
      return !leftSidebar && sidebarInFront() === sessionId;
    },
    async listConversations() {
      const snap = await reader.ready(files.codexHome());
      const threads = ((snap && snap.threads) || []).filter((t) => t.kind === 'user');
      markFront();
      const unread = new Set(threads.filter((t) => seen.unread(t.id, endedOf(t.id))).map((t) => t.id));
      const openHere = new Set(openThreads());
      const out = threads.map((t) => conversationOf(t, { unread, openHere, state: reader.state(t.id),
        hasPlan: enabled() && reader.hasPlan(t.id), waiting: waitingOn(t.id), heard: heardOf(t.id) }));
      if (snap && !snap.readable) out.problem = 'Codex\'s list of conversations could not be read from ' + files.codexHome();
      return out;
    },
    onDidChangeConversations: changed.event,
    planNotice() { return notice; },
    onDidChangePlanNotice: noticeChanged.event,
    _setNotice(next) {
      const was = JSON.stringify(notice);
      notice = next || null;
      if (JSON.stringify(notice) !== was) noticeChanged.fire();
    },
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
      // A tab whose URI does not name it: the patch can raise that panel, where opening the URI would leave a second
      // tab on the same conversation.
      if (patching && typeof patching.revealPanel === 'function') {
        try { if (patching.revealPanel(sessionId)) return true; } catch (_) { /* no panel here */ }
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
      if (id && r.outcome !== 'notReceived') delivered.add(id);
      return r;
    },
    /* For the patch: a conversation came to the front outside an editor tab (Codex's sidebar). The user acted in the
       sidebar to make that happen, so this is where they are looking until a tab says otherwise. */
    _focus(sessionId) {
      if (!sessionId) return;
      leftSidebar = false;
      frontTab = activeTab();
      focused.fire({ sessionId });
      if (markFront()) changed.fire();
    },
    /* Called by the patch when the app-server reports that a turn of `sessionId` started or ended. */
    _heard(sessionId) {
      if (sessionId) poll({ tell: true });
    },
    /* Claude Code's Mark as Unread: the conversation stays unread until the user looks at it again. For the one in
       front, that means switching away and coming back. */
    markUnread(sessionId) {
      if (!sessionId || typeof seen.markUnread !== 'function') return;
      seen.markUnread(sessionId, frontThreads().includes(sessionId));
      changed.fire();
    },
    _poll: poll,
    wantState,
    /* For tests: the tab listener this source installed, without an editor to fire it. */
    _tabsChanged: tabsChanged,
    _wanted: wanted,
    dispose() {
      if (timer) clearInterval(timer);
      seen.flush();
      for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* already disposed */ } }
      changed.dispose();
      focused.dispose();
      noticeChanged.dispose();
    },
  };
  timer = setInterval(() => poll(), POLL_MS);
  poll();
  return source;
}

module.exports = { createCodexSource, conversationOf, logoOf, unnamedTabThread, threadOfCodexTab, PROTOCOL, EXTENSION_ID, STALE_WORKING_MS, RECENT_MS };
