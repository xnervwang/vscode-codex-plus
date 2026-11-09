// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The patch to Codex's own extension at run time: putting it in place, and using what it hands over.
 *
 * Codex is patched at start-up without asking, as Claude Code Plus patches Claude Code, and the patch takes effect after
 * a reload; a build of this extension that changes what the patch writes refreshes it the same way. "Remove the Patch
 * from Codex" puts Codex's files back and is remembered (PATCH_REMOVED_KEY) until "Patch Codex" is run, as Claude Code
 * Plus remembers its Remove; the uninstall hook restores Codex's files too (uninstall.js).
 *
 * What the patched host hands over (src/host.js), and what is done with it:
 *
 *   the provider          open a conversation in Codex's sidebar (navigateToRoute), and post to a panel
 *   each panel + thread   a dot on that tab's logo: green while a turn runs, red when one finished and is not read;
 *                         an answer from the Conversations tab put into that conversation's message box as a draft
 *                         (route state prefillPrompt, only if the box is empty), which its page then sends (deliver);
 *                         a chime when a turn there finishes; a strip with the last turn's
 *                         figures and the tool call running now; and the settings the page draws its time stamps, its
 *                         list of the user's own messages and their colouring from, with the times its rollout gives
 *                         for those messages (src/page/codex-extras-page.js draws all of it, src/user-times.js reads
 *                         the rollout)
 *   page requests and     which conversation a panel shows when its tab does not say: the one its own page started.
 *   responses             A page asks the app-server to start a thread (or to prewarm one), and the answer that comes
 *                         back to that page's webview carries the new thread's id. Such a thread counts once it is in
 *                         Codex's list of conversations, which is when its first message has been sent: a prewarmed
 *                         thread nobody typed into never gets there, and neither does a side chat, which is ephemeral
 *   window broadcasts     a thread this window starts following in a view that is not one of its tabs is taken to be
 *                         in front in the sidebar (onDidFocus). sidebarThread() is the last such thread, and nothing
 *                         is reported after it; whether the user is still looking at the sidebar is worked out by the
 *                         source from the active tab and whether a sidebar view is visible (sidebarShowing,
 *                         src/codex-source.js isFocused)
 *   page messages         the user's time zone, whether an approval card is on a page, and, when one was asked for, a
 *                         self-check of what the page script found and drew
 *   app-server traffic    which conversations are stopped waiting for the user, and how many of those owe an answer
 *                         (src/approvals.js): the tab dot, the state the Conversations view shows and a chime, none of
 *                         which need a tab to be open on the conversation
 */
const fs = require('fs');
const path = require('path');
const targets = require('./adapters');
const { activeThread } = require('./codex-tabs');
const { iconsFor } = require('./logo-dot');
const { createApprovals } = require('./approvals');

/* As Claude Code Extras draws them on its tabs: green working, red replied and unread, blue waiting for the user, at
   its size (radius 5.5 in a 24-unit box). */
const TAB_DOTS = { working: '#22c55e', unread: '#ef4444', prompt: '#3b82f6' };
const TAB_DOT_SIZE = { r: 5.5, gap: 1 };
/* As long a tab title as Claude Code Extras gives one; the tab bar cuts what does not fit. */
const TITLE_MAX = 200;
/* Set by "Remove the Patch from Codex" and cleared by "Patch Codex": while it is set nothing patches Codex. */
const PATCH_REMOVED_KEY = 'codexPlus.patchRemoved';
let state = { active: false, reason: 'not checked yet', provider: null };
/*
 * Every panel Codex handed over, whether or not its conversation is known: panel -> {
 *   thread    the conversation it shows now, or ''
 *   opened    the conversation its tab's URI named when Codex opened it, or ''
 *   route     the route Codex opened it on
 *   starts    ids of thread starts its page sent that have had no answer yet
 *   started   threads its page started that are not in Codex's list yet, oldest first
 * }
 * A page outside this map is one of the sidebar's: Codex opens every editor panel through one of the two places the
 * patch hands panels over from.
 */
const registry = new Map();
/* How many of either list a page keeps. A prewarmed thread that is never typed into stays in `started` for good. */
const PAGE_KEEP = 8;
let deps = null;
let last = new Map();
/* The thread Codex's sidebar last started following, as the broadcast says, or ''. It is never cleared: the broadcast
   only ever says a thread started being followed. */
let sidebar = '';
const approvals = createApprovals();
/* How many answers the user owed at the last redraw, per conversation, so a chime rings on a new one rather than on
   every pass while the same request is still waiting. */
const owed = new Map();
const onApprovals = new Set();

function codexPath(vscode) {
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  return ext ? ext.extensionPath : '';
}

function anchorsMissingLine(m) {
  const what = m.messages ? 'its message box, which the buttons below it are placed by'
    : `the messages in ${m.turns === 1 ? 'it' : 'them'}${m.scroller ? '' : ', nor the element the conversation scrolls in'}`
      + `${m.composer === false ? ', nor its message box' : ''}`;
  return `A Codex page showed ${m.turns} turn${m.turns === 1 ? '' : 's'} and the page script recognised none of ${what}: `
    + 'this Codex build has probably changed what the additions in its page are attached to. '
    + 'The page self-check at the end of "Codex Plus: Show Status" says which part was not found.';
}

function statusLines() {
  const lines = [`Patch to Codex: ${state.active ? 'in place and connected' : 'not in effect'} (${state.reason})`];
  if (deps) {
    const dir = codexPath(deps.vscode);
    for (const t of targets) lines.push(`  ${t.name}: ${dir ? t.status(dir) : 'Codex not found'}`);
  }
  if (state.anchorsMissing) lines.push(`  At ${new Date(state.anchorsMissing.at).toISOString()}: ${anchorsMissingLine(state.anchorsMissing)}`);
  const waiting = approvals.threads();
  const running = runningCommands();
  lines.push(`Commands running in this window's Codex: ${running.length ? running.map((c) => `${c.command.slice(0, 60)} `
    + `(since ${new Date(c.startedMs).toISOString().slice(11, 19)} UTC, in ${c.thread || 'an unknown conversation'})`).join('; ') : 'none'}`);
  lines.push(`Waiting for you: ${waiting.length ? waiting.map((t) => {
    const n = approvals.of(t);
    return `${t} (${n.decide} to decide${n.soon ? `, ${n.soon} Codex will answer itself` : ''})`;
  }).join(', ') : 'nothing'}`);
  return lines;
}

/*
 * How many answers one conversation needs from the user, and how many requests Codex will answer by itself once its
 * countdown runs out. This covers only the conversations of this window, since each window runs its own app-server,
 * so a conversation running in another window or started by `codex exec` is not here (README says so).
 */
function approvalsOf(thread) { return approvals.of(thread); }
/** Told whenever the outstanding set changed, so the views redraw without waiting for the next poll. */
function onApprovalsChanged(fn) {
  onApprovals.add(fn);
  return { dispose: () => onApprovals.delete(fn) };
}
function approvalsChanged() {
  for (const fn of [...onApprovals]) { try { fn(); } catch (e) { if (deps && deps.log) deps.log(`approvals: ${e.message}`); } }
}

function canType() { return !!(state.active && state.provider); }
function sidebarThread() { return sidebar; }

/*
 * The conversation Codex's sidebar shows now: the one it last went to, while one of its sidebar views is visible; ''
 * otherwise. Visibility is Codex's own WebviewView's, whose changes are listened to once per view, so the session list
 * redraws on the event rather than on a poll.
 */
const onSidebar = new Set();
const heardViews = new WeakSet();
function sidebarViews() {
  const p = state.provider;
  if (!p) return [];
  return [p.sidebarView, ...(Array.isArray(p.sidebarViews) ? p.sidebarViews : [])].filter((v) => v && typeof v === 'object');
}
function sidebarChanged() {
  for (const fn of [...onSidebar]) { try { fn(); } catch (e) { if (deps && deps.log) deps.log(`sidebar: ${e.message}`); } }
}
function hearSidebar() {
  for (const v of sidebarViews()) {
    if (heardViews.has(v) || typeof v.onDidChangeVisibility !== 'function') continue;
    heardViews.add(v);
    try { v.onDidChangeVisibility(() => sidebarChanged()); } catch (_) { /* a view going away */ }
  }
}
function sidebarShowing() {
  hearSidebar();
  return sidebar && sidebarViews().some((v) => v.visible === true) ? sidebar : '';
}
function onSidebarChanged(fn) {
  onSidebar.add(fn);
  return { dispose: () => onSidebar.delete(fn) };
}
/** The panels showing `thread` now. */
function panelsOf(thread) {
  const out = [];
  if (thread) for (const [panel, rec] of registry) if (rec.thread === thread) out.push(panel);
  return out;
}
/** Conversation -> the panels showing it, for every panel whose conversation is known. */
function byThread() {
  const out = new Map();
  for (const [panel, rec] of registry) {
    if (!rec.thread) continue;
    if (!out.has(rec.thread)) out.set(rec.thread, []);
    out.get(rec.thread).push(panel);
  }
  return out;
}
function canDeliver(thread) { return canType() && (panelsOf(thread).length > 0 || (!!thread && sidebarShowing() === thread)); }

/*
 * The threads shown by Codex's own panels in this window. For a tab Codex opened with its New button this is the only
 * source: that tab's URI stays /extension/panel/new whatever conversation ends up in it (src/codex-tabs.js), and its
 * panel's conversation is the one its page started (installHooks). Empty without the patch, and then the tab URIs are
 * all there is.
 */
function panelThreads() { return [...byThread().keys()]; }

/* The panel record a page belongs to, for a message that came from one; null for the sidebar's views, which are the
   only Codex pages without a panel. */
function recordOfWebview(webview) {
  if (!webview) return null;
  for (const [panel, rec] of registry) { try { if (panel.webview === webview) return rec; } catch (_) { /* disposed */ } }
  return null;
}

/*
 * The conversation shown in front in an editor column: a webview panel is visible only while it is its group's active
 * tab, so exactly one handed-over panel visible in `viewColumn` is that tab's. { thread } with '' for a panel whose
 * conversation is not known, or null when no single handed-over panel is visible there.
 */
function shownIn(viewColumn) {
  let found = null, n = 0;
  for (const [panel, rec] of registry) {
    let here = false;
    try { here = !!panel.visible && panel.viewColumn === viewColumn; } catch (_) { /* disposed */ }
    if (here) { found = rec; n++; }
  }
  return n === 1 ? { thread: found.thread } : null;
}

/*
 * The conversation a tab whose URI names `thread` shows now: another one when every panel opened on that URI has since
 * started a conversation of its own in the same tab, which leaves the URI as it was.
 */
function nowShowing(thread) {
  const now = new Set();
  for (const rec of registry.values()) if (rec.opened === thread) now.add(rec.thread);
  return now.size === 1 ? [...now][0] : thread;
}

/*
 * Bring the panel showing `thread` to the front, for a conversation whose tab does not name it in its URI: opening it
 * by URI would leave a second tab on the same conversation. False when no panel here has it.
 */
function revealPanel(thread) {
  const panel = panelsOf(thread)[0];
  if (!panel) return false;
  try { panel.reveal(undefined, false); return true; } catch (_) { return false; }
}

/* What the information box of each page was last sent, so a value is copied from this side's own copy. */
const infoShown = new WeakMap();
function postToWebview(webview, msg) {
  const p = state.provider;
  try {
    if (p && typeof p.postMessageToWebview === 'function') p.postMessageToWebview(webview, msg);
    else webview.postMessage(msg);
  } catch (_) { /* the page is gone */ }
}
function postTo(panel, msg) {
  const p = state.provider;
  try {
    if (p && typeof p.postMessageToWebview === 'function') p.postMessageToWebview(panel.webview, msg);
    else panel.webview.postMessage(msg);
  } catch (_) { /* the panel is gone */ }
}

/* Put `text` into the conversation's message box as a draft. Codex's composer takes a draft from the route state it is
   navigated with, and leaves a box that already has text alone, and nothing reports back which of the two happened.
   So the outcome is uncertain (the protocol's word for it): the sender keeps the answer and tells the user to look. */
/*
 * An answer into a conversation shown here, in a tab or in the sidebar: Codex's own route state puts it in the message
 * box as a draft (into an empty box only), and the page script then sends it and reports what it saw
 * (src/page/codex-extras-page.js takeAnswer). A page with no such script, or one that does not answer in time, leaves
 * the outcome uncertain: the draft may still be there.
 */
const ANSWER_WAIT_MS = 6000;
const answering = new Map();
const ANSWER_OUTCOMES = {
  submitted: { outcome: 'submitted' },
  drafted: { outcome: 'drafted' },
  occupied: { outcome: 'notReceived', reason: 'the message box already holds a draft of yours, which Codex does not overwrite' },
};
async function deliver(thread, text, { waitMs = ANSWER_WAIT_MS } = {}) {
  const panel = panelsOf(thread)[0];
  const inSidebar = !panel && !!thread && sidebarShowing() === thread;
  if (!canType() || (!panel && !inSidebar)) {
    return { outcome: 'notReceived', reason: 'neither a Codex tab nor Codex\'s sidebar in this window shows the conversation' };
  }
  const path = `/local/${thread}`, route = { prefillPrompt: text, prefillPromptOnlyIfEmpty: true };
  try {
    if (panel) state.provider.sendMessageToPanel(panel, { type: 'navigate-to-route', path, state: route });
    else state.provider.navigateToRoute(path, route);
  } catch (e) { return { outcome: 'notReceived', reason: String((e && e.message) || e).slice(0, 200) }; }
  if (panel) { try { panel.reveal(undefined, false); } catch (_) { /* typed, just not brought forward */ } }
  if (pagePatchState() && pagePatchState() !== 'patched') return { outcome: 'uncertain' };
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const seen = await new Promise((resolve) => {
    const timer = setTimeout(() => { answering.delete(id); resolve(''); }, waitMs);
    answering.set(id, (word) => { clearTimeout(timer); answering.delete(id); resolve(word); });
    const msg = { type: 'codex-extras-answer', id, text };
    try {
      if (panel) postTo(panel, msg);
      else state.provider.postMessageToSidebar(msg);
    } catch (_) { /* the timer answers */ }
  });
  return ANSWER_OUTCOMES[seen] || { outcome: 'uncertain' };
}

async function openInSidebar(thread) {
  const p = state.provider;
  if (!state.active || !p || typeof p.navigateToRoute !== 'function') return false;
  try {
    p.navigateToRoute(`/local/${thread}`);
    await deps.vscode.commands.executeCommand('chatgpt.openSidebar');
    return true;
  } catch (_) { return false; }
}

/*
 * The question the page in front can be asked, answered once (src/page/codex-extras-page.js): how much of Codex's tree
 * the page script found and how much of its own it drew, as counts and flags. This is what makes the parts drawn in the
 * page checkable without a person looking at them.
 *
 * One question at a time per kind, identified by a nonce so a late answer to an abandoned question is dropped, and the
 * one timer involved is the timeout, cleared as soon as either side finishes.
 */
const ASK_MS = 5000;
const pending = new Map();

/* A panel on a conversation's route or on the route of one not started yet, as against Codex's diff, plan and settings
   panels. */
const CONVERSATION_ROUTE = /^\/(local\/|extension\/panel\/new(?:[/?#]|$))/;
const isConversationPanel = (rec) => !!rec.thread || CONVERSATION_ROUTE.test(rec.route);

/*
 * The conversation panel the user is looking at: the one reporting itself active, or else the one opened on the
 * conversation the active tab names, which is how a tab whose webview is not focused is still found.
 */
function activePanel() {
  for (const [panel, rec] of registry) {
    if (!isConversationPanel(rec)) continue;
    try { if (panel.active) return panel; } catch (_) { /* disposed */ }
  }
  const thread = deps ? activeThread(deps.vscode) : '';
  if (!thread) return null;
  for (const [panel, rec] of registry) if (rec.opened === thread) return panel;
  return panelsOf(thread)[0] || null;
}

/* A page runs the script as it was when the page was built, so a page carrying an older one answers nothing at all.
   Said here rather than left to the timeout, since this is what a page looks like right after the script changed. */
function pagePatchState() {
  const dir = deps ? codexPath(deps.vscode) : '';
  const page = targets.find((t) => t.name === 'Codex page');
  return dir && page ? page.status(dir) : '';
}

/*
 * Ask the page in front one question. `kind` is both the reply's kind and the request's type (codex-extras-<kind>);
 * `field` is the key the page puts its answer under, and the three sentences are what the user reads.
 *
 * The refusals before anything is sent are what a user meets most often, so each names the command that fixes it: a
 * page that cannot answer looks exactly like a page that is slow to answer.
 */
async function askPage(kind, { field, doing, noun, busy, failed, timeoutMs = ASK_MS }) {
  if (!state.active) {
    return { error: 'the patch to Codex is not in effect, so its page cannot be asked. Run "Codex Plus: Patch Codex" '
      + 'and reload the window.' };
  }
  const pageState = pagePatchState();
  if (pageState && pageState !== 'patched') {
    return { error: `Codex's page carries ${pageState === 'outdated' ? 'an older version of' : 'none of'} this extension's `
      + `page script, so it does not know how to ${doing}. Run "Codex Plus: Patch Codex" and reload the window.` };
  }
  const panel = activePanel();
  if (!panel) return { error: `bring a Codex conversation tab to the front first: the ${noun} is of the page in front.` };
  if (pending.has(kind)) return { error: busy };
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reply = new Promise((resolve) => { pending.set(kind, { id, field, failed, resolve }); });
  const settle = (r) => {
    const p = pending.get(kind);
    if (p && p.id === id) { pending.delete(kind); p.resolve(r); }
  };
  const timer = setTimeout(() => settle({ error: 'Codex\'s page did not answer. It runs the script as it was when the '
    + 'page was built, so reload the window after a patch and try again.' }), timeoutMs);
  postTo(panel, { type: `codex-extras-${kind}`, id });
  const r = await reply;
  clearTimeout(timer);
  return r;
}

/** { report } or { error }: what the page in front makes of the conversation it is showing. The error is a sentence for
    the user, saying what to do about it. */
const selfCheckPage = (opts = {}) => askPage('selfcheck', { field: 'report', doing: 'answer a self-check',
  noun: 'self-check', busy: 'a self-check is already running', failed: 'finish its self-check', ...opts });

/*
 * The self-check as lines for a person to read and to paste back. The same lines go into Show Status and into the
 * command that offers to copy them, so the two can never drift apart.
 *
 * An answer that did not arrive is one line and not a throw: much the commonest reason for one is a window where Codex
 * is not patched at all, which is a state to report rather than a fault. Each count is labelled with what it counts,
 * because a bare number here would have to be looked up in the source to be read at all.
 */
const count = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
const onOff = (on) => (on ? 'on' : 'off');
const yesNo = (yes) => (yes ? 'yes' : 'no');

function selfCheckLines(answer) {
  if (!answer || answer.error) return [`Page self-check: ${(answer && answer.error) || 'the page sent no answer'}`];
  const r = answer.report || {};
  const s = r.settings || {}, c = r.codex || {}, t = r.times || {}, nav = r.navigation || {};
  const col = r.colour || {}, ap = r.approval || {}, fig = r.figures || {}, pg = r.page || {};
  const sc = c.scroller || {}, w = ap.watching || {};
  const lines = [
    `Page self-check: page script ${(r.script || {}).version || 'of an unknown version'}, report format ${r.format || '?'}`,
    `  Settings it has: times ${onOff(s.timestamps)}, navigation ${onOff(s.navigation)}, `
      + `colour ${s.userColor ? 'set' : 'unset'}, edge ${onOff(s.userEdge)}`,
    `  Codex's own tree: scroller ${sc.found ? 'found' : 'NOT FOUND'} (${sc.selector || '?'}), `
      + `${count(c.turns || 0, 'turn')}, ${count(c.userAnchors || 0, 'message of yours', 'messages of yours')}, `
      + `${count(c.assistantBlocks || 0, 'reply block')}, ${count(c.sentTimeElements || 0, 'sent-time element')}, `
      + `${count(c.bubbles || 0, 'bubble')}, ${count(c.dayDividers || 0, 'day divider')}`,
  ];
  /* entries() returning nothing at all is the one failure that stops every part below it, so it is said in its own
     line rather than as a zero among the counts. */
  lines.push(c.entries
    ? `  Read as a conversation: ${count(c.entries.user || 0, 'message of yours', 'messages of yours')} and `
      + `${count(c.entries.assistant || 0, 'reply', 'replies')}`
    : '  Read as a conversation: NO - the scroller was not found, so nothing below was drawn');
  lines.push(`  Times drawn: ${t.assistant || 0} on replies, ${t.user || 0} on messages of yours`);
  lines.push(`    your side came from: ${t.userSource || 'none'} `
    + `(${t.userFromClock || 0} from the clock Codex rendered, ${t.userFromRollout || 0} from the rollout, `
    + `${t.userUnstamped || 0} left unstamped)`);
  /* With no times at all there is nothing for "lined up" to be about, so that clause is left off rather than reading
     as a disagreement between the page and the rollout. */
  lines.push(t.hostTimes
    ? `    the host sent ${count(t.hostTimes, 'time')}, which `
      + `${t.hostTimesLinedUp ? 'lined up with the page' : 'did not line up with the page and went unused'}`
    : '    the host has sent no times for this conversation');
  lines.push(`    forms of a sent time it could not read: ${t.unreadableForms || 0}`);
  lines.push(`  Navigation: ${count(nav.railButtons || 0, 'rail button')}, ${count(nav.rows || 0, 'row')}, `
    + `${count(nav.compactions || 0, 'compaction point')} drawn of ${nav.compactionsFromHost || 0} in the rollout, `
    + `list ${nav.listOpen ? 'open' : 'shut'}, scrolls ${(nav.scrolls || {}).selector || '?'}`);
  lines.push(`  Your messages marked: ${col.inked || 0} coloured, ${col.edged || 0} given a bar; `
    + `colour accepted: ${yesNo(col.colourAccepted)}; stylesheet in place: ${yesNo(col.styleSheet)}`);
  lines.push(`  Approval card: ${ap.onScreen ? 'ON SCREEN' : 'not on screen'} `
    + `(what the host was last told: ${ap.told === null || ap.told === undefined ? 'nothing yet' : String(ap.told)})`);
  lines.push(`    watcher on ${w.selector || '(nothing)'}, activity root found: ${yesNo(w.activityRootFound)}, `
    + `observing: ${yesNo(w.observing)}`);
  lines.push(`    card selector: ${ap.cardSelector || '?'}`);
  const rf = r.replyFigures || {};
  lines.push(`  Line under each reply: ${rf.setting === false ? 'turned off' : `drawn on ${count(rf.drawn || 0, 'reply', 'replies')}`}; `
    + `${rf.matched || 0} of the ${count(rf.turnsKeyed || 0, 'turn')} with an id on the page matched the host's, which sent ${rf.fromHost || 0}`);
  const cx = r.context || {};
  lines.push(`  Codex's context meter: ${cx.meterFound ? `found, ${cx.percentUsed}% used` : 'not found (Codex shows it only with its own setting on)'}`
    + `; outlined at ${cx.outlineAt || 80}% or more: ${cx.outlineSetting === false ? 'turned off' : yesNo(cx.outlined)}`);
  lines.push(`  Figures strip: ${fig.present ? 'in the page' : 'not in the page'}, `
    + `${fig.showing ? 'showing' : 'hidden'}, ${fig.hasText ? 'with text' : 'with no text'}, `
    + `${fig.toolRunning ? 'a tool call running' : 'no tool call running'}`);
  lines.push(`  Its own elements in the page: ${(r.marks || {}).total || 0}`);
  /* Said last because it changes how the two watchers above are to be read: on a hidden page the marks watcher is
     meant to be gone and the card's is meant to have stayed. */
  lines.push(`  Page hidden when asked: ${yesNo(pg.hidden)}; marks watcher observing: ${yesNo(pg.marksObserving)}`);
  return lines;
}

/** A CSS colour the user typed, or '' for anything else: nothing but a colour may reach the page's stylesheet. */
function safeColor(value) {
  const v = String(value || '').trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(v) || /^[a-zA-Z]{3,30}$/.test(v) || /^(rgb|rgba|hsl|hsla)\([0-9.,%\s/deg]+\)$/.test(v)) return v;
  return '';
}

/* The three settings the page draws from, as the message that carries them. The page has the same defaults, so a page
   the host has not spoken to yet shows what the settings say rather than nothing. */
function viewOf(s = {}) {
  return { type: 'codex-extras-view', timestamps: s.timestamps !== false, navigation: s.conversationNavigation !== false,
    userColor: safeColor(s.userMessageColor), userEdge: s.userMessageEdge !== false, lowContext: s.lowContextOutline !== false,
    replyFigures: s.figures !== false, buttons: s.enabled !== false, chime: s.chime !== false };
}

/*
 * Commands still running in this window's Codex, by item id: a command the model started through Codex's unified exec
 * (item source unifiedExecStartup) is started with item/started and ended with item/completed, and Codex sends the end
 * from a watcher of its own when the process exits or is stopped, whether or not the model asks after it again
 * (core/src/unified_exec/async_watcher.rs, spawn_exit_watcher). A window reloaded while one runs learns of it only from
 * its end.
 */
const COMMANDS_KEPT = 100;
const commands = new Map();
function noteCommand(msg) {
  const method = msg && msg.method, p = (msg && msg.params) || {}, item = p.item || {};
  if ((method !== 'item/started' && method !== 'item/completed') || item.type !== 'commandExecution' || !item.id) return false;
  if (method === 'item/completed') return commands.delete(item.id);
  if (item.source !== 'unifiedExecStartup') return false;
  commands.set(item.id, { thread: String(p.threadId || ''), command: String(item.command || ''), cwd: String(item.cwd || ''),
    startedMs: Number.isFinite(+p.startedAtMs) && +p.startedAtMs > 0 ? +p.startedAtMs : Date.now() });
  while (commands.size > COMMANDS_KEPT) commands.delete(commands.keys().next().value);
  return true;
}
/** The commands still running, oldest first, for one conversation or for all of this window's. */
function runningCommands(thread) {
  return [...commands.values()].filter((c) => !thread || c.thread === thread).sort((a, b) => a.startedMs - b.startedMs);
}

/*
 * The strip's figures: only what is said nowhere else. A turn's duration is Codex's own "Worked for", and the context,
 * model and effort are on the line beside each reply's time, so the strip has the tool call running now, with when it
 * began, and the commands still running. The call's id goes with it: a page that shows that call's own row leaves it
 * to Codex (src/page/codex-extras-page.js codexShowsCall). The id is the rollout's call_id, which is taken to be the id
 * Codex's page puts on the call's row.
 */
function figuresOf(c, commandsRunning = 0) {
  if (!c) return null;
  const parts = [];
  if (commandsRunning) parts.push(`${commandsRunning} command${commandsRunning === 1 ? '' : 's'} running`);
  const running = c.state === 'working' && c.lastTool && !c.lastTool.endedMs;
  return { type: 'codex-extras-figures', text: parts.join(' · '), tool: running ? c.lastTool.name : '', toolSince: running ? c.lastTool.startedMs : 0,
    toolCall: running ? String(c.lastTool.callId || '') : '' };
}

/*
 * A panel stops showing a conversation: the page that said whether that conversation's card was up no longer shows it,
 * so what it said is dropped once no other panel here shows it. The requests of this window are left alone: they do
 * not depend on a tab being open.
 */
function leave(thread) {
  if (!thread || panelsOf(thread).length) return;
  approvals.forgetPage(thread);
  approvalsChanged();
}

/*
 * Each page's newest started thread that has reached Codex's list (`now`, by id) becomes what its panel shows, and the
 * older ones it supersedes are dropped. One not in the list yet waits, and so does every thread of a page that started
 * none: a page is never matched to a conversation by anything but its own thread start.
 */
function settle(now) {
  for (const rec of registry.values()) {
    for (let i = rec.started.length - 1; i >= 0; i--) {
      const id = rec.started[i];
      if (!now.has(id)) continue;
      rec.started = rec.started.slice(i + 1);
      if (id !== rec.thread) {
        const was = rec.thread;
        rec.thread = id;
        leave(was);
      }
      break;
    }
  }
}

/*
 * Redraw what the panels show after the conversations changed: tab dots, figures, a chime on a finished turn, and the
 * settings and message times that the page uses for its stamps, its list and its colours.
 *
 * This is also the one place those settings reach a page, so a change to one of them calls this rather than adding a
 * watcher of its own. It runs on a conversation change and when a panel appears, and reads nothing that drawing the
 * figures did not already read.
 */
async function refreshPanels() {
  if (!deps || !state.active) return;
  const { vscode, source, context } = deps;
  let list = [];
  try { list = await source.listConversations(); } catch (_) { return; }
  const now = new Map(list.map((c) => [c.sessionId, c]));
  settle(now);
  const panels = byThread();
  /* The net under the two signals that end a request. It is weighed against the rollout's own answer rather than
     against `state`, which `prompt` has already won by the time it gets here. */
  if (approvals.prune((t) => { const c = now.get(t); return !!(c && c.working); }).length) approvalsChanged();
  /* A chime for a conversation that now owes the user an answer, whether a tab here shows it or not - but the sound
     can only be made in a page, so one with no tab in this window goes unheard (README says so). */
  if (deps.settings().chime) {
    for (const thread of approvals.threads()) {
      const n = approvals.of(thread).decide;
      const was = owed.get(thread) || { decide: 0, asking: 0 };
      if (n <= was.decide) continue;
      /* The question chime only when every new answer owed is the model asking something; a permission among them
         rings the permission chime. */
      const kind = approvals.asking(thread) - was.asking >= n - was.decide ? 'question' : 'approval';
      for (const panel of panels.get(thread) || []) postTo(panel, { type: 'codex-extras-chime', kind });
    }
  }
  owed.clear();
  for (const thread of approvals.threads()) owed.set(thread, { decide: approvals.of(thread).decide, asking: approvals.asking(thread) });
  if (!registry.size) return;
  const view = viewOf(deps.settings());
  /* The settings reach a page whose conversation is not known yet as well: it draws from them as soon as one starts. */
  for (const [panel, rec] of registry) if (!rec.thread && isConversationPanel(rec)) postTo(panel, view);
  /* Only while the stamps, the list or the line under each reply is on, and only for the conversations a panel here
     shows: the stamps use the times, the list places the compaction points by them, and the line is each turn's model,
     effort and context, keyed by turn id. */
  const whens = new Map();
  if ((view.timestamps || view.navigation || view.replyFigures) && typeof deps.userTimes === 'function') {
    for (const thread of panels.keys()) {
      try {
        const r = await deps.userTimes(thread);
        if (r) whens.set(thread, { times: Array.isArray(r.times) ? r.times : null, compactions: Array.isArray(r.compactions) ? r.compactions : [],
          turns: r.turns && typeof r.turns === 'object' ? r.turns : {} });
      } catch (_) { /* the page falls back to what Codex itself rendered */ }
    }
  }
  const logo = source.logo;
  /* The dot on a tab's logo is one of the things the master switch covers, so with it off a tab gets Codex's own logo
     back rather than keeping whichever dot it had when the switch was thrown. */
  const dots = deps.settings().enabled !== false;
  const icons = logo && dots ? iconsFor({ light: logo.light.fsPath, dark: logo.dark.fsPath }, path.join(context.globalStorageUri.fsPath, 'tab-icons'),
    undefined, TAB_DOTS, TAB_DOT_SIZE) : null;
  for (const [thread, set] of panels) {
    const c = now.get(thread);
    const was = last.get(thread);
    const pair = c && icons && icons[c.state];
    for (const panel of set) {
      try {
        panel.iconPath = pair ? { light: vscode.Uri.file(pair.light), dark: vscode.Uri.file(pair.dark) } : (logo || panel.iconPath);
      } catch (_) { /* disposed */ }
      /* The tab is titled by its conversation, kept in step as Codex names or renames it: Codex itself titles only a
         tab opened on an existing conversation, once, so one started in a tab stays "Codex". */
      const title = c && c.title && c.title !== '(untitled)' ? String(c.title).slice(0, TITLE_MAX) : '';
      if (title) { try { if (panel.title !== title) panel.title = title; } catch (_) { /* disposed */ } }
      /* Against the rollout's own answer, not against `state`: a turn that stopped on an approval has not finished, and
         `state` reads `prompt` for it, which would otherwise ring the finished-turn chime. */
      if (deps.settings().chime && was && was.working && c && !c.working) postTo(panel, { type: 'codex-extras-chime', kind: 'done' });
      if (deps.settings().figures) postTo(panel, figuresOf(c, runningCommands(thread).length) || { type: 'codex-extras-figures', text: '' });
      postTo(panel, view);
      if (whens.has(thread)) postTo(panel, { type: 'codex-extras-user-times', ...whens.get(thread) });
    }
    if (c) last.set(thread, { state: c.state, working: !!c.working });
  }
}

/* `thread` is the one the tab's URI names, null for any other panel; `route` is the route Codex opened it on. */
function adoptPanel(panel, thread, provider, route) {
  if (provider) state.provider = provider;
  if (!panel || registry.has(panel)) return;
  const id = thread ? String(thread) : '';
  registry.set(panel, { thread: id, opened: id, route: typeof route === 'string' ? route : '', starts: new Set(), started: [] });
  state.active = true;
  state.reason = 'Codex handed over its panels';
  /* A page that is gone cannot say its card went with it (leave). */
  try {
    panel.onDidDispose(() => {
      const rec = registry.get(panel);
      if (!rec) return;
      registry.delete(panel);
      leave(rec.thread);
    });
  } catch (_) { registry.delete(panel); return; }
  setTimeout(refreshPanels, 500);
}

/*
 * The panels Codex built before the hooks existed. A Codex tab restored at a reload activates Codex on its custom editor,
 * ahead of this extension's start-up event, so its call into adoptPanel found nothing to call. Codex's own map holds
 * them with the route each opened on; a conversation tab's names its conversation as its URI did, and a panel of the
 * other kind is handed over with none, as the live hook hands it over.
 */
function adoptEarlierPanels(provider) {
  let held = [];
  try { held = provider.editorPanels instanceof Map ? [...provider.editorPanels] : []; } catch (_) { return; }
  const plain = provider.constructor && provider.constructor.panelViewType;
  for (const [panel, entry] of held) {
    const route = entry && typeof entry.initialRoute === 'string' ? entry.initialRoute : '';
    let editor = false;
    try { editor = !!panel && (!plain || panel.viewType !== plain); } catch (_) { continue; }
    const m = editor ? /^\/(?:local|remote)\/([^/?#]+)/.exec(route) : null;
    adoptPanel(panel, m ? m[1] : null, provider, route);
  }
}

function installHooks() {
  globalThis.__codexExtrasPanel = adoptPanel;
  /*
   * A page starting a thread, and the answer that names it. Only a panel's own page is followed: the sidebar's pages
   * are not in the registry, and a page's request is tied to its answer by the request id Codex itself routes the
   * answer back by. A thread the answer marks ephemeral is a side chat drawn beside the conversation, never the
   * conversation the tab shows.
   */
  globalThis.__codexExtrasPageRequest = (webview, request, kind) => {
    const rec = recordOfWebview(webview);
    if (!rec || !request || request.id === undefined || request.id === null) return;
    if (kind !== 'prewarm' && request.method !== 'thread/start') return;
    rec.starts.add(String(request.id));
    while (rec.starts.size > PAGE_KEEP) rec.starts.delete(rec.starts.values().next().value);
  };
  globalThis.__codexExtrasPageResponse = (webview, response) => {
    const rec = recordOfWebview(webview);
    if (!rec || !response || !rec.starts.delete(String(response.id))) return;
    const t = response.result && response.result.thread;
    if (!t || typeof t.id !== 'string' || !t.id || t.ephemeral === true) return;
    rec.started = rec.started.filter((id) => id !== t.id).concat(t.id).slice(-PAGE_KEEP);
    refreshPanels().catch(() => { /* the next poll settles it */ });
  };
  globalThis.__codexExtrasMessage = (webview, msg, provider) => {
    if (provider) state.provider = provider;
    state.active = true;
    if (msg && msg.kind === 'tz' && typeof msg.timeZone === 'string' && deps && deps.onTimeZone) deps.onTimeZone(msg.timeZone);
    /* A sent time in a form the page's parser does not know. The page sends its shape and never its value, so this is
       the whole of what can be said about it - and it is what writing the next parser needs. */
    if (msg && msg.kind === 'stampShape' && deps && deps.log) {
      deps.log(`Codex's sent time is in a form this extension cannot read: ${+msg.len || 0} characters, the first a `
        + `${msg.first === 'digit' || msg.first === 'letter' ? msg.first : 'character that is neither'}`
        + `, ${msg.digits ? 'all digits' : 'not all digits'}. No time is shown on replies.`);
    }
    /* What a page saw of an answer it was asked to send: one word of its own vocabulary. */
    if (msg && msg.kind === 'answer' && answering.has(msg.id)) answering.get(msg.id)(String(msg.outcome || ''));
    /* The buttons below the message box: the conversation's information, a value of it copied by its position in
       the list this side sent, and the chime switched. */
    if (msg && msg.kind === 'infoAsk' && deps && typeof deps.sessionInfo === 'function') {
      const rec = recordOfWebview(webview);
      const thread = rec ? rec.thread : sidebar;
      Promise.resolve(thread ? deps.sessionInfo(thread) : [{ label: 'Thread id', value: 'no conversation started in this page yet' }])
        .then((rows) => {
          const list = (Array.isArray(rows) ? rows : []).map((r) => ({ label: String(r.label || ''), value: String(r.value == null ? '' : r.value) }));
          infoShown.set(webview, { id: msg.id, rows: list });
          postToWebview(webview, { type: 'codex-extras-info', id: msg.id, rows: list });
        }).catch(() => { /* the box stays shut */ });
    }
    if (msg && msg.kind === 'infoCopy' && deps && typeof deps.copy === 'function') {
      const shown = infoShown.get(webview);
      const row = shown && shown.id === msg.id ? shown.rows[Math.floor(+msg.index)] : null;
      if (row) deps.copy(row.value, row.label);
    }
    if (msg && msg.kind === 'toggleChime' && deps && typeof deps.toggleChime === 'function') deps.toggleChime();
    /* A page that has turns and recognised none of the messages in them, or no message box. Only numbers and flags
       come with it. */
    if (msg && msg.kind === 'anchorsMissing') {
      const turns = Math.max(0, Math.floor(+msg.turns || 0));
      state.anchorsMissing = { at: Date.now(), turns, scroller: msg.scroller === true,
        messages: Math.max(0, Math.floor(+msg.messages || 0)), composer: msg.composer !== false };
      if (deps && deps.log) deps.log(anchorsMissingLine(state.anchorsMissing));
    }
    /* Whether an approval card is on this page's screen. A tab's page says it for the conversation that tab holds, and
       says nothing while that is not known; the sidebar's page says it for the conversation the sidebar last went to,
       which is the only one it can be showing. */
    if (msg && msg.kind === 'approval') {
      const rec = recordOfWebview(webview);
      const thread = rec ? rec.thread : sidebar;
      if (thread) {
        approvals.pageSays(thread, msg.on === true);
        approvalsChanged();
        refreshPanels().catch(() => { /* the next poll draws it */ });
      }
    }
    /* An answer to a question this window asked, matched by the nonce it was asked with: an answer carrying another
       nonce belongs to a question already abandoned, and is dropped so that question times out rather than being
       settled by the wrong page. */
    const asked = msg && msg.kind && pending.get(msg.kind);
    if (asked && msg.id === asked.id) {
      pending.delete(msg.kind);
      asked.resolve(msg.error ? { error: `Codex's page could not ${asked.failed}: ${msg.error}` }
        : { [asked.field]: msg[asked.field] });
    }
  };
  /*
   * Codex's app-server traffic: a request that may be waiting for the user, the notification that one was answered
   * somewhere, and the answer this window sent. The last covers Codex answering one itself when its countdown runs
   * out, which it does by sending a response like any other.
   */
  globalThis.__codexExtrasAppServer = (kind, msg) => {
    state.active = true;
    let moved = false;
    if (kind === 'request') moved = !!approvals.request(msg);
    else if (kind === 'answer') moved = !!approvals.resolve(msg && msg.id);
    else if (kind === 'notification' && msg && msg.method === 'serverRequest/resolved') {
      moved = !!approvals.resolve(msg.params && msg.params.requestId);
    } else if (kind === 'notification' && noteCommand(msg)) {
      refreshPanels().catch(() => { /* the next poll draws it */ });
      return;
    }
    if (!moved) return;
    approvalsChanged();
    refreshPanels().catch(() => { /* the next poll draws it */ });
  };
  globalThis.__codexExtrasBroadcast = (method, params) => {
    if (!deps || method !== 'thread-stream-following-changed' || !params || !params.following) return;
    const thread = String(params.conversationId || '');
    if (thread && !panelsOf(thread).length) { sidebar = thread; deps.source._focus(thread); sidebarChanged(); }
  };
  if (globalThis.__codexExtrasProvider) {
    state.provider = globalThis.__codexExtrasProvider;
    state.active = true;
    state.reason = 'connected';
    adoptEarlierPanels(state.provider);
  }
}

/*
 * `mode` is 'on' or 'off' (extension.js settings): off while the master switch is off or after "Remove the Patch from
 * Codex", on otherwise. A Codex that carries an older copy of the patch gets this build's (`refresh`), and a clean one
 * gets the patch, both without asking.
 */
async function ensurePatched(vscode, context, log, mode) {
  const dir = codexPath(vscode);
  if (!dir) { state.reason = 'the Codex extension is not installed'; return; }
  const states = targets.map((t) => t.status(dir));
  if (states.every((s) => s === 'patched')) { state.reason = state.active ? 'connected' : 'patched; reload to connect'; return; }
  if (mode === 'off') {
    state.reason = context.globalState.get(PATCH_REMOVED_KEY) === true
      ? 'removed by "Remove the Patch from Codex"; "Patch Codex" puts it back' : 'the additions are off (codexPlus.enabled)';
    return;
  }
  const refresh = states.every((s) => s === 'patched' || s === 'outdated');
  const results = [];
  for (const t of targets) {
    try { results.push([t.name, t.apply(dir)]); } catch (e) { results.push([t.name, { current: false, message: e.message }]); }
  }
  for (const [name, r] of results) log(`patch ${name}: ${r.message}`);
  const failed = results.filter(([, r]) => !r.current);
  if (failed.length) {
    // All or nothing across the targets: a page patch without the host patch would post to nobody.
    for (const t of targets) { try { t.restore(dir); } catch (_) { /* nothing to restore */ } }
    state.reason = `not patched: ${failed.map(([n, r]) => `${n}: ${r.message}`).join('; ')}`;
    return;
  }
  state.reason = 'patched; reload the window to connect';
  reloadOffered = true;
  const reload = 'Reload Window';
  /* Codex reads these files when its extension starts and when it builds a page, so neither half of what was just
     written runs until the window is reloaded. There is no way to hand it over without one. */
  const pick = await vscode.window.showInformationMessage(refresh
    ? 'Codex Plus brought its patch of Codex up to this version. Reload the window for it to take effect.'
    : 'Codex is patched. Reload the window for it to take effect.', reload);
  if (pick === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

function removePatch(vscode) {
  const dir = codexPath(vscode);
  if (!dir) return [];
  /* Restoring the files leaves the pages already built still running this extension's script, until the window is
     reloaded. Told that everything is off, each of them takes its own stamps, list and classes back off Codex's tree,
     so a reader who does not reload at once is not left with marks nothing maintains. */
  const off = { type: 'codex-extras-view', timestamps: false, navigation: false, userColor: '', userEdge: false };
  for (const panel of registry.keys()) postTo(panel, off);
  return [...targets].reverse().map((t) => { try { return `${t.name}: ${t.restore(dir).message}`; } catch (e) { return `${t.name}: ${e.message}`; } });
}

/*
 * A window whose Codex started before the patch was written runs Codex's own code until it is reloaded, so it hands
 * nothing over: no dots, no answers delivered, no chimes. Patching is done once on disk for every window, and only the
 * window that wrote it offers the reload, so the others are told here, when they get the focus. One stat per focus; the
 * file is read only when its modification time moved, and the offer is made once per window.
 */
let reloadOffered = false;
let seenMtime = null;
async function offerReloadIfStale() {
  if (!deps || state.active || reloadOffered) return false;
  const { vscode } = deps;
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  if (!ext || !ext.isActive || deps.settings().patchCodex === 'off') return false;
  const dir = ext.extensionPath;
  let mtime;
  try { mtime = (await fs.promises.stat(path.join(dir, 'out', 'extension.js'))).mtimeMs; } catch (_) { return false; }
  if (mtime === seenMtime) return false;
  seenMtime = mtime;
  if (!targets.every((t) => t.status(dir) === 'patched')) return false;
  reloadOffered = true;
  state.reason = 'patched after this window\'s Codex started; reload to connect';
  const reload = 'Reload Window';
  const pick = await vscode.window.showInformationMessage('Codex was patched after this window\'s Codex started, so here it '
    + 'still runs its own code: no tab dots, no answers delivered, no chimes. Reload this window to connect it.', reload);
  if (pick === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  return true;
}

function activate(context, opts) {
  deps = opts;
  installHooks();
  context.subscriptions.push(opts.source.onDidChangeConversations(() => refreshPanels()));
  if (typeof opts.vscode.window.onDidChangeWindowState === 'function') {
    context.subscriptions.push(opts.vscode.window.onDidChangeWindowState((w) => {
      if (w && w.focused) offerReloadIfStale().catch((e) => opts.log(`patch: ${e.message}`));
    }));
  }
  context.subscriptions.push({ dispose: () => {
    for (const k of ['__codexExtrasPanel', '__codexExtrasPageRequest', '__codexExtrasPageResponse', '__codexExtrasMessage', '__codexExtrasBroadcast',
      '__codexExtrasAppServer']) delete globalThis[k];
    approvals.clear();
    onApprovals.clear();
    commands.clear();
  } });
  /* Straight after activation rather than after a pause: Codex starts on the same event as this extension, in no set
     order, and every moment waited is one more in which it reads the copy of its files that is about to be replaced. */
  setImmediate(() => ensurePatched(opts.vscode, context, opts.log, opts.settings().patchCodex).catch((e) => opts.log(`patch: ${e.message}`)));
  return state;
}

module.exports = { activate, ensurePatched, statusLines, openInSidebar, canType, canDeliver, deliver, sidebarThread, panelThreads, shownIn,
  nowShowing, revealPanel, removePatch,
  figuresOf, safeColor, viewOf, selfCheckPage, selfCheckLines, installHooks, refreshPanels, approvalsOf,
  onApprovalsChanged, offerReloadIfStale, sidebarShowing, onSidebarChanged, runningCommands, _state: () => state, _registry: registry, _approvals: approvals,
  TAB_DOTS, ASK_MS, PATCH_REMOVED_KEY };
