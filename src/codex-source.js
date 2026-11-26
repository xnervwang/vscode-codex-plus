// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex as a conversation source of Agent Plus (xnervwang.agent-plus, protocol 1; its docs/protocol.md), which draws
 * the work plan, Conversations and Answer views.
 *
 *   id, label, logo, extensionId   who the conversations belong to
 *   planPath, planDir              where their plans are (the companion plugin's data directory)
 *   sessionForTab, onDidFocus,     which conversation is in front, and whether a reported one still is, which
 *   isFocused, front               Agent Plus's work plan view and session list follow; front, that one
 *   listConversations              every conversation a person started, from the reader's latest snapshot
 *   listAllConversations           the same without the archived ones, for Agent Plus's notices
 *   reveal                         bring one to the front: only a tab already in this window
 *   canDeliver, deliverAnswer      typing an answer into one, through the patch to Codex (src/patching.js)
 *   planNotice, timeZone           the row above the plan (the plugin missing, no Python, its hooks not trusted), which
 *                                  the extension sets, and the reader's time zone, which Codex's page reports
 *
 * `working` comes from files: its rollout has a task_started with no task_complete after it, corrected by the turn
 * starts and ends this window's app-server reported since the last read, which arrive at once (turnOf). A conversation
 * whose turn has ended still counts as working while something it started is running (leftOf). `unread` is a turn that
 * ended after the user last had the conversation in front of them in a focused window (src/seen.js; Codex's own read
 * receipts stay unread for good inside VS Code). `idle` is the rest. `prompt` comes from the patch instead
 * (src/approvals.js), because Codex writes no approval request to a file, and only for the conversations of this
 * window. For one running in another window or in Codex's terminal interface it comes from the marks the plugin's
 * PermissionRequest hook leaves (src/waiting-marks.js). One started by `codex exec` never waits: exec refuses every
 * approval request at once.
 *
 * Each conversation also reports `activity`, `unseen`, `lastUserAt` and `lastReplyAt`; `state` stays for an older Agent
 * Plus. `lastReplyAt` is when its latest turn ended.
 * `activity` is `working` during a turn, `background` after the turn while work it started still runs, `waiting` for
 * `prompt` and for a question its work plan put to the user after the user's last message, and `stopped` otherwise.
 * `unseen` marks a reply the user has not looked at; it is measured from the latest finished turn, so a later turn does
 * not clear it. `lastUserAt` is when the user last typed a message. A waiting one carries `waitingFor` when its reason
 * is known: the approval named by this window's request or by another window's mark, a question asked with
 * request_user_input_async, or a question in its plan.
 *
 * This module opens none of Codex's files; src/codex-reader.js has the snapshot its worker thread made.
 */
const path = require('path');
const files = require('./codex-files');
const tabs = require('./codex-tabs');
const install = require('./plugin-install');
const { createSeen } = require('./seen');
const { oncePerDelivery } = require('./core-link');
const { KINDS, LEFT_EVERY_MS, SHARE_DIR } = require('./left-running');
const { withoutEnvelope } = require('./title-marks');
const waitingMarks = require('./waiting-marks');

/* A turn whose rollout has been silent this long is no longer running, whatever its last line says: the process that
   was writing it is gone (a closed window, a crash). Long tool calls write nothing while they run, so this is generous. */
const STALE_WORKING_MS = 2 * 60 * 60 * 1000;
/* A conversation counts as running while it is working, open in a tab of this window, or was active this recently. */
const RECENT_MS = 15 * 60 * 1000;
const POLL_MS = 3000;
/* Agent Plus's pen: how long a conversation not shown here may take to open in a tab, and how long the whole of putting
   the text in its message box may take, both short of the ten seconds Agent Plus waits. */
const PREFILL_OPEN_MS = 4000;
const PREFILL_MS = 9000;
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
 * the rollout's running turn counts as ended, unless the rollout shows a turn that started later. `lastEndedMs` is the
 * latest turn end either source has seen, even after another turn has started.
 */
function turnOf(st, heard, now, last) {
  const heardEnd = (heard && heard.endedMs) || 0;
  const lastEndedMs = Math.max((st && st.lastEndedMs) || 0, (st && !st.working && st.endedMs) || 0, heardEnd);
  if (heard && heard.running) return { working: true, endedMs: 0, lastEndedMs };
  const overtaken = !!(st && st.working && heardEnd && !(st.startedMs > heardEnd));
  const working = !!(st && st.working && !overtaken && now - last < STALE_WORKING_MS);
  if (st && st.working && !overtaken) return { working, endedMs: 0, lastEndedMs };
  return { working, endedMs: Math.max((st && !st.working && st.endedMs) || 0, heardEnd), lastEndedMs };
}

/* A reason as Agent Plus's protocol has it (waitingFor), or null for anything else. */
const REASONS = ['permission', 'question', 'plan', 'choice', 'planQuestion'];
function reasonOf(r) {
  if (!r || typeof r !== 'object' || !REASONS.includes(r.kind)) return null;
  if (r.kind !== 'permission') return { kind: r.kind };
  const tool = typeof r.tool === 'string' ? r.tool.trim() : '';
  return tool ? { kind: 'permission', tool } : { kind: 'permission' };
}

/* The latest sign of activity in a thread. A turn the rollout shows as running stops counting once this is too old. */
const lastOf = (thread, st, heard) => Math.max((thread && thread.updatedMs) || 0, (st && st.lastActivityMs) || 0,
  (heard && Math.max(heard.startedMs || 0, heard.endedMs || 0)) || 0);

/*
 * What Codex's files say about one thread, in the protocol's terms. `state` is the rollout state the reader has for it,
 * or null for a thread not touched lately; `now` and `openHere` are passed in so the same answer can be computed in a
 * test. `waiting` is what the patch knows about requests stopped on the user, which no file records.
 *
 * `prompt` wins over `working`: as far as its rollout goes a turn stopped on an approval is still running, but it is
 * the user who has to act. `left` lists what the conversation started that is still running (the kinds in
 * src/left-running.js). While it is not empty, an idle or unread conversation's `state` is working, as Claude Code Plus
 * reported it, and `ownState` keeps the state it would otherwise have; its `activity` is background.
 *
 * `planAsked` is when its work plan last put a question to the user (src/workplan.js latestQuestionAt). If that is
 * later than the user's last message, the activity is waiting once the turn has ended, because the question reaches
 * the user in that turn's reply. Agent Plus's Conversations panel decides the same way (activityOf in its
 * src/conversations.js), so the tab and the session list show the panel's red dot. `state` is left alone: an older
 * Agent Plus reads its `prompt` as a permission prompt, and finds the question in the plan itself.
 *
 * `waiting.reason` is the reason those requests give (waitingFor). A conversation waiting on a request takes its reason
 * from the request, not from its rollout or plan.
 */
function conversationOf(thread, { unread, openHere, now = Date.now(), state = null, hasPlan = false, waiting = null, heard = null, left = [],
  planAsked = 0 }) {
  const st = state;
  const last = lastOf(thread, st, heard);
  const { working, lastEndedMs } = turnOf(st, heard, now, last);
  const decide = (waiting && waiting.decide) || 0;
  const soon = (waiting && waiting.soon) || 0;
  /* A question asked with request_user_input_async waits for the user once its turn has ended (src/codex-files.js). */
  const asking = !working && !!(st && st.askedMs);
  const lastUser = (st && st.lastUserMs) || 0;
  const planned = !working && !!(lastUser && planAsked > lastUser);
  let word = 'idle';
  if (decide || soon) word = 'prompt';
  else if (working) word = 'working';
  else if (asking) word = 'prompt';
  else if (unread.has(thread.id)) word = 'unread';
  const after = !working && Array.isArray(left) ? left.slice() : [];
  const own = word;
  if (after.length && (word === 'idle' || word === 'unread')) word = 'working';
  const waits = !!(decide || soon || asking || planned);
  const why = decide || soon ? reasonOf(waiting && waiting.reason) : asking ? { kind: 'question' } : planned ? { kind: 'planQuestion' } : null;
  return {
    sessionId: thread.id,
    title: withoutEnvelope(thread.title) || '(untitled)',
    cwd: thread.cwd,
    state: word,
    activity: waits ? 'waiting' : working ? 'working' : after.length ? 'background' : 'stopped',
    ...(waits && why ? { waitingFor: why } : {}),
    unseen: unread.has(thread.id),
    lastUserAt: (st && st.lastUserMs) || 0,
    running: working || after.length > 0 || openHere.has(thread.id) || now - last < RECENT_MS,
    lastActiveAt: last,
    /* Opening a conversation, setting its goal or unarchiving it writes its rollout or its row without a reply, and
       Agent Plus would take the newer lastActiveAt for a turn that ran between two reads. */
    ...(lastEndedMs > 0 ? { lastReplyAt: lastEndedMs } : {}),
    hasPlan,
    // Beyond the protocol: what this extension's own parts draw (the tab figures).
    /* The rollout's own answer, which `state` no longer carries once `prompt` wins it: what decides whether a request
       stopped on the user is still live (src/approvals.js prune) has to not be derived from those requests. */
    working,
    /* Set while this window's app-server runs the turn. The session list uses it to tell a conversation running here
       without a tab from one running in another window. */
    runningHere: !!(heard && heard.running),
    ownState: own,
    left: after,
    failed: !working && !!(st && st.error),
    decide,
    soon,
    asking,
    planAsks: planned,
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

/* What the patch answers, or `none` without that answer. */
const ask = (patching, name, args, none) => {
  if (!patching || typeof patching[name] !== 'function') return none;
  try { return patching[name](...args); } catch (_) { return none; }
};

/*
 * The conversation a Codex tab shows, '' when that is not known (a conversation not started yet, or no way to tell).
 * When the tab's URI has a conversation id, that is the conversation, as the patch has it now: Codex opens one editor
 * per URI, so no other panel can be that tab's. A New tab's URI has none; its conversation is that of the panel this
 * extension gave the tab's title, else, in front of its group, the one panel visible in that column, else whatever
 * elimination leaves.
 *
 * The visible panel counts only if it is a New tab's panel titled like the tab: VS Code reports a tab coming to the
 * front before it updates which panel is visible, so for that moment the visible one is the panel of the tab that was
 * in front.
 */
function threadOfCodexTab(vscode, patching, tab) {
  const named = tabs.threadOfTab(vscode, tab);
  /* The patch knows a panel by its tab's whole URI, and a restored tab by what it showed (src/patching.js threadOfTabUri). */
  const input = tab && tab.input;
  const byUri = (named || tabs.isCodexTab(vscode, tab)) && input && input.uri ? ask(patching, 'threadOfTabUri', [String(input.uri)], null) : null;
  if (typeof byUri === 'string') return byUri;
  if (named) return namedNow(patching, named);
  if (!tabs.isCodexTab(vscode, tab)) return '';
  const label = typeof tab.label === 'string' ? tab.label : '';
  const titled = ask(patching, 'newPanelThreadsTitled', [label], []);
  if (Array.isArray(titled) && titled.length === 1) return titled[0];
  if (tab.isActive) {
    const group = ((vscode.window.tabGroups && vscode.window.tabGroups.all) || []).find((g) => g.activeTab === tab);
    const shown = group ? ask(patching, 'shownIn', [group.viewColumn], null) : null;
    if (shown && shown.fresh && withoutEnvelope(shown.title) === withoutEnvelope(label)) return shown.thread;
  }
  return unnamedTabThread(vscode, patching);
}

/*
 * `deps`: reader (src/codex-reader.js), patching (src/patching.js), enabled() (codexPlus.workPlan as the token mode
 * has it), trusted() (not in Restricted Mode), seen (src/seen.js) and log. scanLeft() says whether this window scans
 * for what conversations left running after their turn (src/left-running.js): no more often than leftEveryMs, in
 * procDir and in the Claude Code session records under claudeSessions. A window that stands down for a newer build
 * does not scan. While holdSeen() is true, the conversation in front is not marked as read.
 */
function createCodexSource(vscode, { log = () => {}, reader, patching = null, enabled = () => true, trusted = () => true,
  briefs = () => true, seen = createSeen(), scanLeft = () => false, leftEveryMs = LEFT_EVERY_MS, procDir = '/proc',
  claudeSessions = undefined, onPoll = () => {}, onScan = () => {}, holdSeen = () => false } = {}) {
  const changed = new vscode.EventEmitter();
  const focused = new vscode.EventEmitter();
  /* The row above the work plan, set by the extension (_setNotice): { title, description, detail, command, arguments }. */
  const noticeChanged = new vscode.EventEmitter();
  let notice = null;
  let timer = null;
  /* An answer handed over twice under one delivery id is typed once, including a second request that arrives while the
     first is still running (src/core-link.js). */
  const deliverOnce = oncePerDelivery(async (sessionId, text) => {
    if (!trusted() || !patching) return { outcome: 'notReceived', reason: 'this window cannot type into Codex' };
    return patching.deliver(sessionId, text);
  });
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
  /*
   * `sidebarLast`: whether Codex's sidebar came to the front after the active editor tab did, by starting to follow a
   * conversation or by being shown again with one. Agent Plus's work plan view and its session list's current row both
   * go by it (isFocused). In Claude Code Plus the two follow Claude Code's own activeSessionId, the
   * conversation of whichever of its panels became active last. `sidebarSeen` is the conversation the sidebar showed at
   * its last change.
   */
  let sidebarLast = false, sidebarSeen = '';
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
    sidebarLast = false;
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
    /* An approval request and its answer change `activity` without writing anything the poll could find. The marks are
       read again too, so the mark of a request answered here clears at once. */
    if (patching && typeof patching.onApprovalsChanged === 'function') {
      try { subs.push(patching.onApprovalsChanged(() => { readMarks(); changed.fire(); })); } catch (_) { /* no patch */ }
    }
    /* Showing Codex's sidebar again brings its conversation to the front without any tab change, and nothing else
       would mark it read until the next tab change or read of the list. */
    if (patching && typeof patching.onSidebarChanged === 'function') {
      try { subs.push(patching.onSidebarChanged(() => { sidebarMoved(); if (markFront()) changed.fire(); })); } catch (_) { /* no patch */ }
    }
  }

  /* Codex's sidebar came to the front with `id`: it is where the user is looking until a tab says otherwise. */
  function sidebarForward(id) {
    leftSidebar = false;
    frontTab = activeTab();
    sidebarLast = true;
    sidebarSeen = id;
    focused.fire({ sessionId: id });
  }
  /*
   * Codex's sidebar was shown, hidden or moved to another conversation. If it now shows a conversation other than the
   * one it showed at its last change, it comes to the front. If it is hidden or shows no conversation while it is the
   * last to have come forward, the front goes back to the active tab's conversation, and Agent Plus is told so: it
   * would otherwise keep showing the plan of a conversation no longer in view.
   */
  function sidebarMoved() {
    const now = sidebarInFront(), was = sidebarSeen;
    sidebarSeen = now;
    if (now && now !== was) { sidebarForward(now); return; }
    if (now || !sidebarLast) return;
    sidebarLast = false;
    const tab = activeTab(), id = tab ? threadOfCodexTab(vscode, patching, tab) : '';
    if (id) focused.fire({ sessionId: id });
  }
  /* The conversation in front by the latest signal. It is the one Codex's sidebar shows if the sidebar came forward
     after the active tab did and the user has not gone to a tab of something else since. Otherwise it is the active
     tab's conversation if that tab is Codex's ('' for one with no conversation yet), and otherwise the one Codex's
     sidebar shows, or ''. */
  function frontOne() {
    const side = sidebarInFront();
    if (sidebarLast && !leftSidebar && side) return side;
    const tab = activeTab();
    const id = tab ? source.sessionForTab(tab) : null;
    return typeof id === 'string' ? id : side;
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
  const endedOf = (id) => turnOf(reader.state(id), heardOf(id), Date.now(), 0).lastEndedMs;
  /* Marks what is in front as seen now, and returns true when that cleared an unread state, so the views redraw at
     once. */
  let wasFront = [];
  function markFront() {
    /* While codexPlus.loadRestoredTabs brings each background tab forward for a moment, no one has read it. */
    if (holdSeen()) return false;
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
  /* With the work plan off, its questions are not shown anywhere, so they do not turn a dot red either. */
  const planAskedOf = (id) => (enabled() && typeof reader.planAsked === 'function' ? reader.planAsked(id) : 0);
  /* What the patch knows about requests this conversation is stopped on, or null without the patch. */
  const askedHere = (id) => {
    if (!patching || typeof patching.approvalsOf !== 'function') return null;
    try { return patching.approvalsOf(id); } catch (_) { return null; }
  };
  /*
   * The marks left for every approval Codex asks for, in any window (src/waiting-marks.js), read on every poll and
   * whenever this window's requests change. `askedAt` keeps, for each marked thread, the last time this window's
   * app-server had an approval of it outstanding.
   */
  let marks = new Map(), marksKey = '[]';
  const askedAt = new Map();
  const marksDir = () => install.planDir(files.codexHome());
  const rootOf = (id) => {
    let t = reader.thread(id);
    for (let i = 0; t && t.parent && i < 20; i++) t = reader.thread(t.parent) || null;
    return t;
  };
  /* Counts the approvals of `id` that its marks still stand for, and removes the marks that are over. */
  const markedFor = (id) => {
    const list = marks.get(String(id || '').toLowerCase());
    if (!list || !list.length) return { count: 0, tool: '' };
    const root = rootOf(id);
    if (root && root.origin === 'exec') return { count: 0, tool: '' };
    const own = askedHere(id);
    const { count, over, tool } = waitingMarks.counted(list, { state: reader.state(id), askedHereAt: askedAt.get(id) || 0,
      askedHere: !!(own && (own.decide || own.soon)) });
    if (over.length) {
      waitingMarks.remove(over);
      marks.set(String(id).toLowerCase(), list.filter((m) => !over.includes(m.file)));
    }
    return { count, tool: tool || '' };
  };
  function readMarks(now = Date.now()) {
    marks = waitingMarks.read(marksDir(), { now });
    for (const id of marks.keys()) {
      const own = askedHere(id);
      if (own && (own.decide || own.soon)) askedAt.set(id, now);
    }
    for (const id of [...askedAt.keys()]) if (!marks.has(id)) askedAt.delete(id);
    for (const id of [...marks.keys()]) markedFor(id);
    const key = waitingMarks.keyOf(marks);
    const moved = key !== marksKey;
    marksKey = key;
    return moved;
  }
  /* The reason this window's requests give for `id` waiting, or null without the patch. */
  const reasonHere = (id) => {
    if (!patching || typeof patching.waitReasonOf !== 'function') return null;
    try { return patching.waitReasonOf(id) || null; } catch (_) { return null; }
  };
  /*
   * What `id` is stopped on, and why the user is needed. The count is this window's own requests, raised to what the
   * marks count. The reason comes from a request the user has to answer here; else from a mark; else from a request
   * Codex will answer by itself.
   */
  const waitingOn = (id) => {
    const own = askedHere(id);
    const why = reasonHere(id);
    const { count: marked, tool } = markedFor(id);
    const byMark = marked ? (tool ? { kind: 'permission', tool } : { kind: 'permission' }) : null;
    const reason = (own && own.decide > 0 && why) || byMark || why || null;
    if (!marked) return own ? { ...own, reason } : own;
    return { ...(own || { decide: 0, soon: 0 }), decide: Math.max((own && own.decide) || 0, marked), reason };
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
  /* The sub-agents of conversations shown here, in a tab or in Codex's sidebar. Each page's Agent map draws their states
     (src/agent-map.js). */
  const kidsOf = (ids) => {
    const shown = new Set(ids.filter(Boolean));
    return (reader.threads() || []).filter((t) => t.kind === 'subagent' && shown.has(t.parent)).map((t) => t.id);
  };
  /*
   * The worker's last scan for what conversations left running: { available, threads: { [id]: [kinds] }, detached,
   * running }, or null before the first one. Scans run from the poll, one at a time and no more often than leftEveryMs,
   * and the views are told only when the result for a known thread changes.
   */
  let leftSeen = null, leftKey = '', leftAt = 0, leftRun = null;
  const leftKeyOf = (seenNow) => {
    if (!seenNow) return '';
    const known = new Set((reader.threads() || []).map((t) => t.id));
    return JSON.stringify([Object.keys(seenNow.threads).filter((id) => known.has(id)).sort().map((id) => [id, seenNow.threads[id]]),
      (seenNow.detached || []).filter((d) => known.has(d.thread)).map((d) => `${d.thread}.${d.pid}.${d.start}`),
      (seenNow.running || []).filter((d) => known.has(d.thread)).map((d) => `${d.thread}.${d.kind}.${d.pid}.${d.start}.${d.name}`),
      (seenNow.holders || []).filter((d) => known.has(d.thread)).map((d) => `${d.thread}.${d.pid}.${d.start}.${d.label}`)]);
  };
  function pollLeft() {
    if (leftRun || Date.now() - leftAt < leftEveryMs) return;
    leftAt = Date.now();
    let on = false;
    try { on = !!scanLeft(); } catch (_) { on = false; }
    if (!on) {
      if (leftSeen) { leftSeen = null; if (leftKey) { leftKey = ''; changed.fire(); } }
      return;
    }
    /* Only the machine's own /proc is shared with the other windows, never a made-up one. */
    const share = procDir === '/proc' ? path.join(install.planDir(files.codexHome()), SHARE_DIR) : '';
    leftRun = reader.request('leftRunning', { home: files.codexHome(), proc: procDir, sessionsDir: claudeSessions, share }).then((r) => {
      leftSeen = r && r.threads && typeof r.threads === 'object' ? r : null;
      const key = leftKeyOf(leftSeen);
      if (key !== leftKey) { leftKey = key; changed.fire(); }
      try { onScan(leftSeen); } catch (e) { log(`work left running: ${(e && e.message) || e}`); }
    }).catch((e) => log(`work left running: ${(e && e.message) || e}`)).finally(() => { leftRun = null; });
  }
  /* The kinds still running for `id` and its sub-agents, in KINDS order. They come from the worker's last scan, from
     sub-agents with a turn in progress, from commands this window's app-server is still running, and, when /proc
     could not be read, from commands the rollout shows as not yet finished that this window's app-server has not
     reported on. */
  const turnRunning = (id, now) => {
    const t = reader.thread(id), st = reader.state(id);
    if (!t || !st) return false;
    const heard = heardOf(id);
    return turnOf(st, heard, now, lastOf(t, st, heard)).working;
  };
  const commandsOf = (id) => {
    if (!patching || typeof patching.runningCommands !== 'function') return [];
    try { return patching.runningCommands(id) || []; } catch (_) { return []; }
  };
  const commandsHere = (id) => commandsOf(id).length > 0;
  const heardHere = (call) => {
    try { return !!(patching && typeof patching.heardCommand === 'function' && patching.heardCommand(call)); } catch (_) { return false; }
  };
  /*
   * Without /proc, the item ids of the background terminals this window's app-server still runs for each conversation,
   * kept as { ids, at }. ids is null when the app-server did not answer, as for a conversation it has not loaded. The
   * rollout records no end for a background command on macOS and Windows, and a window reloaded while one ran has lost
   * its notifications, so wherever the app-server answers, its list decides. Each conversation is asked at most once
   * every TERMINALS_MS.
   */
  const terminals = new Map();
  const TERMINALS_MS = 5000;
  const openInRollout = (x) => {
    const st = reader.state(x);
    return st && Array.isArray(st.openCommandIds) ? st.openCommandIds.filter((c) => !heardHere(c)) : [];
  };
  function askTerminals(ids, now = Date.now()) {
    if (!patching || typeof patching.hostRequest !== 'function') return;
    for (const x of ids) {
      const had = terminals.get(x);
      if (had && (had.asking || now - had.at < TERMINALS_MS)) continue;
      terminals.set(x, { ids: had ? had.ids : null, at: now, asking: true });
      Promise.resolve(patching.hostRequest('thread/backgroundTerminals/list', { threadId: x })).then((r) => {
        const data = r && r.outcome === 'done' && r.result && Array.isArray(r.result.data) ? r.result.data : null;
        const next = data ? new Set(data.map((d) => String((d && d.itemId) || ''))) : null;
        const before = terminals.get(x);
        terminals.set(x, { ids: next, at: Date.now(), asking: false });
        if (JSON.stringify(before && before.ids ? [...before.ids] : null) !== JSON.stringify(next ? [...next] : null)) changed.fire();
      }, () => { terminals.set(x, { ids: null, at: Date.now(), asking: false }); });
    }
    for (const x of [...terminals.keys()]) if (!ids.includes(x)) terminals.delete(x);
  }
  function familyOf(id, kids) {
    const out = [id];
    for (let i = 0; i < out.length && out.length < 200; i++) for (const k of kids.get(out[i]) || []) if (!out.includes(k)) out.push(k);
    return out;
  }
  function childIndex() {
    const kids = new Map();
    for (const t of reader.threads() || []) {
      if (t.kind !== 'subagent' || !t.parent) continue;
      if (!kids.has(t.parent)) kids.set(t.parent, []);
      kids.get(t.parent).push(t.id);
    }
    return kids;
  }
  function leftOf(id, kids = childIndex(), now = Date.now()) {
    const kinds = new Set();
    for (const x of familyOf(id, kids)) {
      for (const k of (leftSeen && leftSeen.threads[String(x).toLowerCase()]) || []) kinds.add(k);
      if (x !== id && turnRunning(x, now)) kinds.add('subagent');
      if (commandsHere(x)) kinds.add('command');
      if (leftSeen && leftSeen.available === false) {
        const st = reader.state(x), t = reader.thread(x);
        const here = (terminals.get(x) || {}).ids;
        const open = openInRollout(x).filter((c) => !here || here.has(c));
        if (open.length && now - lastOf(t, st, null) < STALE_WORKING_MS) kinds.add('command');
      }
    }
    return KINDS.filter((k) => kinds.has(k));
  }
  function poll({ force = false, tell = false } = {}) {
    pollLeft();
    if (leftSeen && leftSeen.available === false) {
      askTerminals((reader.threads() || []).filter((t) => openInRollout(t.id).length).map((t) => t.id));
    }
    /* Other repeating work is done on this poll rather than on a timer of its own (src/archive-sweep.js tick). */
    try { onPoll(); } catch (e) { log(`codex source: ${(e && e.message) || e}`); }
    const here = openThreads();
    let marked = false;
    try { marked = readMarks(); } catch (e) { log(`approval marks: ${(e && e.message) || e}`); }
    const extra = [...new Set([...here, ...kidsOf([...here, sidebarInFront()]), ...wanted, ...marks.keys()])];
    return reader.refresh({ home: files.codexHome(), extra, force }).then((moved) => {
      // An answered request is dropped: the reader keeps that state, so asking again would read the rollout afresh
      // every pass for a row that has not changed.
      for (const id of [...wanted]) if (reader.state(id)) wanted.delete(id);
      const cleared = markFront();
      if (tell || cleared || moved || marked) changed.fire();
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

  /* The conversations a person started, filtered by `keep`, from the reader's latest snapshot and in the protocol's shape. */
  async function listed(keep) {
    const snap = await reader.ready(files.codexHome());
    const threads = ((snap && snap.threads) || []).filter((t) => t.kind === 'user' && keep(t));
    markFront();
    const unread = new Set(threads.filter((t) => seen.unread(t.id, endedOf(t.id))).map((t) => t.id));
    const openHere = new Set(openThreads());
    const kids = childIndex(), now = Date.now();
    const out = threads.map((t) => conversationOf(t, { unread, openHere, state: reader.state(t.id),
      hasPlan: enabled() && reader.hasPlan(t.id), waiting: waitingOn(t.id), heard: heardOf(t.id), left: leftOf(t.id, kids, now),
      planAsked: planAskedOf(t.id) }));
    if (snap && !snap.readable) out.problem = 'Codex\'s list of conversations could not be read from ' + files.codexHome();
    return out;
  }

  const source = {
    protocol: PROTOCOL,
    /* ['brief'] while the conversation brief and the work plan both run. */
    get features() { return (enabled() && briefs() ? ['brief'] : []).concat(['openHere', 'shows', 'prefill']); },
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
    listConversations() { return listed(() => true); },
    /* Every conversation not archived, from every folder, for Agent Plus's notices and for the extensions that link to
       conversations through it. Read receipts and plan questions are shared by every window; what only this window
       knows (an approval request it received, a tab it shows) can only add to them. */
    listAllConversations() { return listed((t) => !t.archived); },
    /* Any thread's state, sub-agents included, computed the same way listConversations computes a conversation's;
       null when the thread is not in the snapshot or its rollout has not been read. */
    threadState(id) {
      const t = reader.thread(id), st = reader.state(id);
      if (!t || !st) return null;
      const unread = new Set(seen.unread(id, endedOf(id)) ? [id] : []);
      return conversationOf(t, { unread, openHere: new Set(), state: st, waiting: waitingOn(id), heard: heardOf(id), left: leftOf(id),
        planAsked: planAskedOf(id) });
    },
    leftOf: (id) => (id ? leftOf(id) : []),
    /* When the user last had `id` in front of them in any window (src/seen.js), for the session list's read marks. */
    viewedAt: (id) => { try { return id && typeof seen.seenAt === 'function' ? seen.seenAt(id) || 0 : 0; } catch (_) { return 0; } },
    /*
     * The entries of kind command, codexExec, claudeWorker and claudeBg still running for `id` and its sub-agents,
     * oldest first, as { thread, kind, pid, start, startMs, cmd, name, session, job }. A conversation's background terminals are the ones
     * this window's Codex reports, by the command the model gave, wherever it reports any; elsewhere the processes the
     * scan found under Codex. A terminal of this window has no pid.
     */
    runningOf(id) {
      if (!id) return [];
      const listed = leftSeen && Array.isArray(leftSeen.running) ? leftSeen.running : [];
      const out = [];
      for (const x of familyOf(id, childIndex())) {
        const key = String(x).toLowerCase();
        const here = commandsOf(x);
        for (const w of listed) if (w.thread === key && !(here.length && w.kind === 'command')) out.push(w);
        for (const c of here) {
          out.push({ thread: key, kind: 'command', pid: 0, start: '', startMs: +c.startedMs || 0, cmd: String(c.command || '').slice(0, 1000),
            name: '', session: '', job: '' });
        }
      }
      return out.sort((a, b) => (a.startMs - b.startMs) || (a.pid - b.pid));
    },
    /* The detached commands still running for `id` and its sub-agents, as the last scan listed them (src/left-running.js),
       oldest first. */
    detachedOf(id) {
      if (!leftSeen || !Array.isArray(leftSeen.detached) || !id) return [];
      const family = new Set(familyOf(String(id).toLowerCase(), childIndex()).map((x) => String(x).toLowerCase()));
      return leftSeen.detached.filter((d) => family.has(d.thread)).sort((a, b) => (a.startMs - b.startMs) || (a.pid - b.pid));
    },
    /* The processes other than this window's Codex that hold `id` open, as the last scan listed them
       (src/writer-locks.js): [{ pid, kind, label, detail }]. This window's own app-server is a process under this
       extension host. */
    holdersOf(id) {
      if (!leftSeen || !Array.isArray(leftSeen.holders) || !id) return [];
      const key = String(id).toLowerCase();
      return leftSeen.holders.filter((h) => h.thread === key && h.pid !== process.pid && !(h.ancestors || []).includes(process.pid))
        .map((h) => ({ pid: h.pid, kind: h.kind, label: h.label, detail: h.detail.slice() }));
    },
    onDidChangeConversations: changed.event,
    planNotice() { return notice; },
    onDidChangePlanNotice: noticeChanged.event,
    _setNotice(next) {
      const was = JSON.stringify(notice);
      notice = next || null;
      if (JSON.stringify(notice) !== was) noticeChanged.fire();
    },
    /* Brings the conversation to the front when this window shows it. Otherwise it returns false, and Agent Plus asks
       the window that does. */
    async reveal(sessionId) {
      if (!files.THREAD_ID.test(String(sessionId || ''))) return false;
      if (tabs.codexTabs(vscode).some((t) => t.thread === sessionId)) {
        try { return await tabs.openInTab(vscode, sessionId); } catch (e) { log(`reveal ${sessionId}: ${e.message}`); return false; }
      }
      // A tab whose URI does not name it: the patch can raise that panel, where opening the URI would leave a second
      // tab on the same conversation.
      if (patching && typeof patching.revealPanel === 'function') {
        try { if (patching.revealPanel(sessionId)) return true; } catch (_) { /* no panel here */ }
      }
      if (sidebarInFront() === sessionId && patching && typeof patching.openInSidebar === 'function') {
        try { return (await patching.openInSidebar(sessionId)) === true; } catch (_) { return false; }
      }
      return false;
    },
    shows(sessionId) { return !!sessionId && (openThreads().includes(sessionId) || sidebarInFront() === sessionId); },
    async openHere(sessionId) {
      if (!files.THREAD_ID.test(String(sessionId || ''))) return false;
      try { return await tabs.openInTab(vscode, sessionId); } catch (e) { log(`open ${sessionId}: ${e.message}`); return false; }
    },
    canDeliver(sessionId) { return trusted() && !!patching && patching.canDeliver(sessionId); },
    /*
     * Codex fills its message box from the route it is navigated with, only when the box is empty, and nothing reports
     * back which happened, so the outcome is uncertain. Asked again with a delivery id it has seen, it types nothing.
     */
    deliverAnswer(sessionId, text, opts) { return deliverOnce(sessionId, text, opts); },
    /*
     * Agent Plus's pen on a plan row: the conversation comes to the front here with `text` at the end of its message
     * box, not sent (src/patching.js prefill). A conversation this window does not show is opened in a tab first, and
     * the whole of it is kept to about PREFILL_MS.
     */
    async prefill(sessionId, text) {
      const started = Date.now();
      if (!files.THREAD_ID.test(String(sessionId || '')) || typeof text !== 'string') return { outcome: 'notReceived', reason: 'not a Codex conversation' };
      if (!patching || typeof patching.prefill !== 'function' || !patching.canType()) {
        return { outcome: 'notReceived', reason: 'Codex Plus\'s patch to Codex is not in use in this window' };
      }
      if (!patching.canDeliver(sessionId)) {
        let opened = false;
        try { opened = await tabs.openInTab(vscode, sessionId); } catch (e) { log(`prefill ${sessionId}: ${e.message}`); }
        if (!opened) return { outcome: 'notReceived', reason: 'it could not be opened in this window' };
        while (!patching.canDeliver(sessionId) && Date.now() - started < PREFILL_OPEN_MS) await new Promise((r) => setTimeout(r, 200));
        if (!patching.canDeliver(sessionId)) return { outcome: 'notReceived', reason: 'its tab did not open in time' };
      }
      return patching.prefill(sessionId, text, { waitMs: Math.max(1000, PREFILL_MS - (Date.now() - started)) });
    },
    /* For the patch: a conversation came to the front outside an editor tab (Codex's sidebar). The user acted in the
       sidebar to make that happen, so this is where they are looking until a tab says otherwise. */
    _focus(sessionId) {
      if (!sessionId) return;
      sidebarForward(sessionId);
      if (markFront()) changed.fire();
    },
    front() { return frontOne(); },
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
    markRead(sessionId) {
      if (!sessionId || typeof seen.markRead !== 'function') return;
      seen.markRead(sessionId);
      changed.fire();
    },
    /* Called when codexPlus.conversationBrief, codexPlus.workPlan or the token mode changes, so that Agent Plus lists
       the conversations again and reads `features`. */
    featuresChanged() { changed.fire(); },
    _poll: poll,
    /* For tests: resolves when the scan in progress, if there is one, has finished. */
    _leftDone: () => Promise.resolve(leftRun),
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
