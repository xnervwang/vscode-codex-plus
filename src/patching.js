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
 *                         (route state prefillPrompt, only if the box is empty), which the reader sends with Enter;
 *                         a chime when a turn there finishes or its plan asks a question; and a strip with the last
 *                         turn's figures and the tool call running now (src/page/codex-extras-page.js draws both)
 *   window broadcasts     a thread this window starts following in a view that is not one of its tabs is taken to be
 *                         in front in the sidebar (onDidFocus); Agent Work Plan checks that with sidebarThread()
 *                         before it takes the report
 *   page messages         the reader's time zone, from the page
 */
const path = require('path');
const targets = require('./adapters');
const { iconsFor } = require('./logo-dot');

const TAB_DOTS = { working: '#22c55e', unread: '#ef4444' };
let state = { active: false, reason: 'not checked yet', provider: null };
const panels = new Map();
let deps = null;
let last = new Map();
/* The thread Codex's sidebar last started following, as the broadcast says, or ''. */
let sidebar = '';

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
  return lines;
}

function canType() { return !!(state.active && state.provider); }
function sidebarThread() { return sidebar; }
function canDeliver(thread) { return canType() && (panels.get(thread) || new Set()).size > 0; }

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

function figuresOf(c) {
  if (!c) return null;
  const parts = [];
  if (c.lastTurnMs) parts.push(c.lastTurnMs >= 60000 ? `${Math.floor(c.lastTurnMs / 60000)}m${Math.round(c.lastTurnMs % 60000 / 1000)}s` : `${Math.round(c.lastTurnMs / 1000)}s`);
  if (c.context && c.context.window) parts.push(`ctx ${Math.round(100 * c.context.used / c.context.window)}%`);
  if (c.model) parts.push([String(c.model).replace(/^openai\./, ''), c.effort].filter(Boolean).join(' '));
  const running = c.state === 'working' && c.lastTool && !c.lastTool.endedMs;
  return { type: 'codex-extras-figures', text: parts.join(' · '), tool: running ? c.lastTool.name : '', toolSince: running ? c.lastTool.startedMs : 0 };
}

/* Redraw what the panels show after the conversations changed: tab dots, figures, and a chime on a finished turn. */
async function refreshPanels() {
  if (!deps || !state.active || !panels.size) return;
  const { vscode, source, context, planQuestions } = deps;
  let list = [];
  try { list = await source.listConversations(); } catch (_) { return; }
  const now = new Map(list.map((c) => [c.sessionId, c]));
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
      if (deps.settings().chime && was) {
        if (was.state === 'working' && c && c.state !== 'working') postTo(panel, { type: 'codex-extras-chime', kind: 'done' });
        else if (planQuestions(thread) > (was.questions || 0)) postTo(panel, { type: 'codex-extras-chime', kind: 'question' });
      }
      if (deps.settings().figures) postTo(panel, figuresOf(c) || { type: 'codex-extras-figures', text: '' });
    }
    if (c) last.set(thread, { state: c.state, questions: planQuestions(thread) });
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
    panel.onDidDispose(() => { const s = panels.get(thread); if (s) { s.delete(panel); if (!s.size) panels.delete(thread); } });
    setTimeout(refreshPanels, 500);
  };
  globalThis.__codexExtrasMessage = (webview, msg, provider) => {
    if (provider) state.provider = provider;
    state.active = true;
    if (msg && msg.kind === 'tz' && typeof msg.timeZone === 'string' && deps && deps.onTimeZone) deps.onTimeZone(msg.timeZone);
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
        + 'message box, chimes, and a line with each conversation\'s last turn figures. Codex\'s files are kept and put '
        + 'back by "Codex Extras: Remove the Patch from Codex" or on uninstall. A window reload applies it.' }, go, 'Not now');
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
  return [...targets].reverse().map((t) => { try { return `${t.name}: ${t.restore(dir).message}`; } catch (e) { return `${t.name}: ${e.message}`; } });
}

function activate(context, opts) {
  deps = opts;
  installHooks();
  context.subscriptions.push(opts.source.onDidChangeConversations(() => refreshPanels()));
  context.subscriptions.push({ dispose: () => {
    for (const k of ['__codexExtrasPanel', '__codexExtrasMessage', '__codexExtrasBroadcast']) delete globalThis[k];
  } });
  setTimeout(() => ensurePatched(opts.vscode, context, opts.log, opts.settings().patchCodex).catch((e) => opts.log(`patch: ${e.message}`)), 5000);
  return state;
}

module.exports = { activate, statusLines, openInSidebar, canType, canDeliver, deliver, sidebarThread, removePatch, figuresOf, installHooks,
  refreshPanels, _state: () => state, _panels: panels, TAB_DOTS };
