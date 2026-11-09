// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The patch to Codex's own extension at run time: putting it in place, and using what it hands over.
 *
 * Patching is asked once per Codex version (codexExtras.patchCodex: ask, on or off) and takes effect after a reload.
 * Removing it is a command, and the uninstall hook restores Codex's files too (uninstall.js).
 *
 * What the patched host hands over (src/host.js), and what is done with it:
 *
 *   the provider          open a conversation in Codex's sidebar (navigateToRoute), and post to a panel
 *   each panel + thread   a dot on that tab's logo: green while a turn runs, red when one finished and is not read;
 *                         an answer from the Conversations tab put into that conversation's message box as a draft
 *                         (route state prefillPrompt, only if the box is empty), which the user sends with Enter;
 *                         a chime when a turn there finishes or its plan asks a question; a strip with the last turn's
 *                         figures and the tool call running now; and the settings the page draws its time stamps, its
 *                         list of the user's own messages and their colouring from, with the times its rollout gives
 *                         for those messages (src/page/codex-extras-page.js draws all of it, src/user-times.js reads
 *                         the rollout)
 *   window broadcasts     a thread this window starts following in a view that is not one of its tabs is taken to be
 *                         in front in the sidebar (onDidFocus). sidebarThread() is the last such thread, and nothing
 *                         is reported after it; whether the user is still looking at the sidebar is worked out by the
 *                         source from the active tab (src/codex-source.js isFocused)
 *   page messages         the user's time zone, whether an approval card is on a page, and, when one was asked for, a
 *                         sample of the conversation layout or a self-check of what the page script found and drew
 *   app-server traffic    which conversations are stopped waiting for the user, and how many of those owe an answer
 *                         (src/approvals.js): the tab dot, the state the Conversations view shows, the count in the
 *                         status bar and a chime, none of which need a tab to be open on the conversation
 */
const path = require('path');
const targets = require('./adapters');
const { activeThread } = require('./codex-tabs');
const { iconsFor } = require('./logo-dot');
const { createApprovals } = require('./approvals');

const TAB_DOTS = { working: '#22c55e', unread: '#ef4444', prompt: '#f59e0b' };
let state = { active: false, reason: 'not checked yet', provider: null };
const panels = new Map();
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

function statusLines() {
  const lines = [`Patch to Codex: ${state.active ? 'in place and connected' : 'not in effect'} (${state.reason})`];
  if (deps) {
    const dir = codexPath(deps.vscode);
    for (const t of targets) lines.push(`  ${t.name}: ${dir ? t.status(dir) : 'Codex not found'}`);
  }
  const waiting = approvals.threads();
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
/** How many answers the user owes across this window, for the status bar. */
function decideCount() { return approvals.decideCount(); }
/** Conversations with anything outstanding, whether the user has to answer it or not. */
function waitingThreads() { return approvals.threads(); }
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
function canDeliver(thread) { return canType() && (panels.get(thread) || new Set()).size > 0; }

/*
 * The threads shown by Codex's own panels in this window, as Codex handed each panel over. This is the only way to learn the
 * thread of a tab Codex opened with its New button: that tab's URI stays /extension/panel/new whatever conversation
 * ends up in it (src/codex-tabs.js). Empty without the patch, and then the tab URIs are all there is.
 */
function panelThreads() { return [...panels.keys()]; }

/* Which conversation a page belongs to, for a message that came from one: Codex hands over the panel, and a page's
   webview is that panel's. '' for the sidebar and its other views, which have no panel. */
function threadOfWebview(webview) {
  if (!webview) return '';
  for (const [thread, set] of panels) {
    for (const panel of set) { try { if (panel.webview === webview) return thread; } catch (_) { /* disposed */ } }
  }
  return '';
}

/*
 * Bring the panel showing `thread` to the front, for a conversation whose tab does not name it in its URI: opening it
 * by URI would leave a second tab on the same conversation. False when no panel here has it.
 */
function revealPanel(thread) {
  const set = panels.get(thread);
  const panel = set && [...set][0];
  if (!panel) return false;
  try { panel.reveal(undefined, false); return true; } catch (_) { return false; }
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
   So the outcome is uncertain (the protocol's word for it): the sender keeps the answer and tells the reader to look. */
async function deliver(thread, text) {
  const set = panels.get(thread);
  const panel = set && [...set][0];
  if (!canType() || !panel) return { outcome: 'notReceived', reason: 'no Codex tab in this window shows the conversation' };
  try {
    state.provider.sendMessageToPanel(panel, { type: 'navigate-to-route', path: `/local/${thread}`,
      state: { prefillPrompt: text, prefillPromptOnlyIfEmpty: true } });
  } catch (e) { return { outcome: 'notReceived', reason: String((e && e.message) || e).slice(0, 200) }; }
  try { panel.reveal(undefined, false); } catch (_) { /* typed, just not brought forward */ }
  return { outcome: 'uncertain' };
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
 * The two questions the page in front can be asked, both answered once (src/page/codex-extras-page.js):
 *
 *   sample     the conversation's layout, for writing selectors against what Codex draws at run time. Structure only,
 *              and nothing the conversation says.
 *   selfcheck  how much of Codex's tree the page script found and how much of its own it drew, as counts and flags.
 *              This is what makes the parts drawn in the page checkable without a person looking at them.
 *
 * One question at a time per kind, identified by a nonce so a late answer to an abandoned question is dropped, and the
 * one timer involved is the timeout, cleared as soon as either side finishes.
 */
const ASK_MS = 5000;
const pending = new Map();

/*
 * The conversation panel the user is looking at: the one reporting itself active, or else the one holding the
 * conversation the active tab names, which is how a tab whose webview is not focused is still found.
 */
function activePanel() {
  for (const set of panels.values()) {
    for (const panel of set) { try { if (panel.active) return panel; } catch (_) { /* disposed */ } }
  }
  const thread = deps ? activeThread(deps.vscode) : '';
  const set = thread && panels.get(thread);
  return set && set.size ? [...set][0] : null;
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
    return { error: 'the patch to Codex is not in effect, so its page cannot be asked. Run "Codex Extras: Patch Codex" '
      + 'and reload the window.' };
  }
  const pageState = pagePatchState();
  if (pageState && pageState !== 'patched') {
    return { error: `Codex's page carries ${pageState === 'outdated' ? 'an older version of' : 'none of'} this extension's `
      + `page script, so it does not know how to ${doing}. Run "Codex Extras: Patch Codex" and reload the window.` };
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

/** { sample } or { error } - the error is a sentence for the user, saying what to do about it. */
const sampleLayout = (opts = {}) => askPage('sample', { field: 'sample', doing: 'take a sample', noun: 'sample',
  busy: 'a sample is already being taken', failed: 'take a sample', ...opts });

/** { report } or { error }: what the page in front makes of the conversation it is showing. */
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
    + `list ${nav.listOpen ? 'open' : 'shut'}, scrolls ${(nav.scrolls || {}).selector || '?'}`);
  lines.push(`  Your messages marked: ${col.inked || 0} coloured, ${col.edged || 0} given a bar; `
    + `colour accepted: ${yesNo(col.colourAccepted)}; stylesheet in place: ${yesNo(col.styleSheet)}`);
  lines.push(`  Approval card: ${ap.onScreen ? 'ON SCREEN' : 'not on screen'} `
    + `(what the host was last told: ${ap.told === null || ap.told === undefined ? 'nothing yet' : String(ap.told)})`);
  lines.push(`    watcher on ${w.selector || '(nothing)'}, activity root found: ${yesNo(w.activityRootFound)}, `
    + `observing: ${yesNo(w.observing)}`);
  lines.push(`    card selector: ${ap.cardSelector || '?'}`);
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
    userColor: safeColor(s.userMessageColor), userEdge: s.userMessageEdge !== false };
}

function figuresOf(c) {
  if (!c) return null;
  const parts = [];
  if (c.lastTurnMs) parts.push(c.lastTurnMs >= 60000 ? `${Math.floor(c.lastTurnMs / 60000)}m${Math.round(c.lastTurnMs % 60000 / 1000)}s` : `${Math.round(c.lastTurnMs / 1000)}s`);
  if (c.context && c.context.window) parts.push(`ctx ${Math.round(100 * c.context.used / c.context.window)}%`);
  if (c.model) parts.push([String(c.model).replace(/^openai\./, ''), c.effort].filter(Boolean).join(' '));
  const running = c.state === 'working' && c.lastTool && !c.lastTool.endedMs;
  return { type: 'codex-extras-figures', text: parts.join(' · '), tool: running ? c.lastTool.name : '', toolSince: running ? c.lastTool.startedMs : 0 };
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
  const { vscode, source, context, planQuestions } = deps;
  let list = [];
  try { list = await source.listConversations(); } catch (_) { return; }
  const now = new Map(list.map((c) => [c.sessionId, c]));
  /* The net under the two signals that end a request. It is weighed against the rollout's own answer rather than
     against `state`, which `prompt` has already won by the time it gets here. */
  if (approvals.prune((t) => { const c = now.get(t); return !!(c && c.working); }).length) approvalsChanged();
  /* A chime for a conversation that now owes the user an answer, whether a tab here shows it or not - but the sound
     can only be made in a page, so one with no tab in this window goes unheard (README says so). */
  if (deps.settings().chime) {
    for (const thread of approvals.threads()) {
      const n = approvals.of(thread).decide;
      if (n > (owed.get(thread) || 0)) for (const panel of panels.get(thread) || []) postTo(panel, { type: 'codex-extras-chime', kind: 'approval' });
    }
  }
  owed.clear();
  for (const thread of approvals.threads()) owed.set(thread, approvals.of(thread).decide);
  if (!panels.size) return;
  const view = viewOf(deps.settings());
  /* Only while the stamps are on, and only for the conversations a panel here shows. */
  const whens = new Map();
  if (view.timestamps && typeof deps.userTimes === 'function') {
    for (const thread of panels.keys()) {
      try {
        const r = await deps.userTimes(thread);
        if (r && Array.isArray(r.times)) whens.set(thread, r.times);
      } catch (_) { /* the page falls back to what Codex itself rendered */ }
    }
  }
  const logo = source.logo;
  const icons = logo ? iconsFor({ light: logo.light.fsPath, dark: logo.dark.fsPath }, path.join(context.globalStorageUri.fsPath, 'tab-icons'),
    undefined, TAB_DOTS) : null;
  for (const [thread, set] of panels) {
    const c = now.get(thread);
    const was = last.get(thread);
    const pair = c && icons && icons[c.state];
    for (const panel of set) {
      try {
        panel.iconPath = pair ? { light: vscode.Uri.file(pair.light), dark: vscode.Uri.file(pair.dark) } : (logo || panel.iconPath);
      } catch (_) { /* disposed */ }
      /* Against the rollout's own answer, not against `state`: a turn that stopped on an approval has not finished, and
         `state` reads `prompt` for it, which would otherwise ring the finished-turn chime. */
      if (deps.settings().chime && was) {
        if (was.working && c && !c.working) postTo(panel, { type: 'codex-extras-chime', kind: 'done' });
        else if (planQuestions(thread) > (was.questions || 0)) postTo(panel, { type: 'codex-extras-chime', kind: 'question' });
      }
      if (deps.settings().figures) postTo(panel, figuresOf(c) || { type: 'codex-extras-figures', text: '' });
      postTo(panel, view);
      if (whens.has(thread)) postTo(panel, { type: 'codex-extras-user-times', times: whens.get(thread) });
    }
    if (c) last.set(thread, { state: c.state, working: !!c.working, questions: planQuestions(thread) });
  }
}

function installHooks() {
  globalThis.__codexExtrasPanel = (panel, thread, provider) => {
    if (provider) state.provider = provider;
    if (!thread || !panel) return;
    if (!panels.has(thread)) panels.set(thread, new Set());
    panels.get(thread).add(panel);
    state.active = true;
    state.reason = 'Codex handed over its panels';
    /* A page that is gone cannot say its card went with it, so what the last page of this conversation said is
       dropped here. The requests of this window are left alone: they do not depend on a tab being open. */
    panel.onDidDispose(() => {
      const s = panels.get(thread);
      if (!s) return;
      s.delete(panel);
      if (s.size) return;
      panels.delete(thread);
      approvals.forgetPage(thread);
      approvalsChanged();
    });
    setTimeout(refreshPanels, 500);
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
    /* Whether an approval card is on this page's screen. A tab's page says it for the conversation that tab holds; the
       sidebar's page says it for the conversation the sidebar last went to, which is the only one it can be showing. */
    if (msg && msg.kind === 'approval') {
      const thread = threadOfWebview(webview) || sidebar;
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
    }
    if (!moved) return;
    approvalsChanged();
    refreshPanels().catch(() => { /* the next poll draws it */ });
  };
  globalThis.__codexExtrasBroadcast = (method, params) => {
    if (!deps || method !== 'thread-stream-following-changed' || !params || !params.following) return;
    const thread = String(params.conversationId || '');
    if (thread && !panels.has(thread)) { sidebar = thread; deps.source._focus(thread); }
  };
  if (globalThis.__codexExtrasProvider) { state.provider = globalThis.__codexExtrasProvider; state.active = true; state.reason = 'connected'; }
}

async function ensurePatched(vscode, context, log, mode) {
  const dir = codexPath(vscode);
  if (!dir) { state.reason = 'the Codex extension is not installed'; return; }
  const states = targets.map((t) => t.status(dir));
  if (states.every((s) => s === 'patched')) { state.reason = state.active ? 'connected' : 'patched; reload to connect'; return; }
  if (mode === 'off') { state.reason = 'turned off (codexExtras.patchCodex)'; return; }
  const version = (vscode.extensions.getExtension('openai.chatgpt').packageJSON || {}).version || '';
  if (mode === 'ask') {
    const key = `codexExtras.patchAsked:${version}`;
    if (context.globalState.get(key)) { state.reason = 'not patched: declined for this Codex version'; return; }
    await context.globalState.update(key, true);
    const go = 'Patch Codex';
    const pick = await vscode.window.showInformationMessage(`Patch the Codex extension ${version}?`, {
      detail: 'It adds status dots to Codex tabs, opening a conversation in the sidebar, answers into a conversation\'s '
        + 'message box, chimes, a line with each conversation\'s last turn figures, a time on every message and reply, '
        + 'a list of your own messages on the right edge, and your own messages marked out. Codex\'s files are kept and '
        + 'put back by "Codex Extras: Remove the Patch from Codex" or on uninstall. A window reload applies it.' }, go, 'Not now');
    if (pick !== go) { state.reason = 'not patched: declined for this Codex version'; return; }
  }
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
  const reload = 'Reload Window';
  const pick = await vscode.window.showInformationMessage('Codex is patched. Reload the window for it to take effect.', reload);
  if (pick === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

function removePatch(vscode) {
  const dir = codexPath(vscode);
  if (!dir) return [];
  /* Restoring the files leaves the pages already built still running this extension's script, until the window is
     reloaded. Told that everything is off, each of them takes its own stamps, list and classes back off Codex's tree,
     so a reader who does not reload at once is not left with marks nothing maintains. */
  const off = { type: 'codex-extras-view', timestamps: false, navigation: false, userColor: '', userEdge: false };
  for (const set of panels.values()) for (const panel of set) postTo(panel, off);
  return [...targets].reverse().map((t) => { try { return `${t.name}: ${t.restore(dir).message}`; } catch (e) { return `${t.name}: ${e.message}`; } });
}

function activate(context, opts) {
  deps = opts;
  installHooks();
  context.subscriptions.push(opts.source.onDidChangeConversations(() => refreshPanels()));
  context.subscriptions.push({ dispose: () => {
    for (const k of ['__codexExtrasPanel', '__codexExtrasMessage', '__codexExtrasBroadcast', '__codexExtrasAppServer']) delete globalThis[k];
    approvals.clear();
    onApprovals.clear();
  } });
  setTimeout(() => ensurePatched(opts.vscode, context, opts.log, opts.settings().patchCodex).catch((e) => opts.log(`patch: ${e.message}`)), 5000);
  return state;
}

module.exports = { activate, statusLines, openInSidebar, canType, canDeliver, deliver, sidebarThread, panelThreads, revealPanel, removePatch,
  figuresOf, safeColor, viewOf, sampleLayout, selfCheckPage, selfCheckLines, installHooks, refreshPanels, approvalsOf,
  decideCount, waitingThreads, onApprovalsChanged, _state: () => state, _panels: panels, _approvals: approvals,
  TAB_DOTS, ASK_MS };
