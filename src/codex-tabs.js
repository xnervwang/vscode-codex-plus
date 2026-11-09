// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex conversation tabs: which editor tabs are Codex conversations, which thread each shows, and opening a thread in
 * a tab of its own.
 *
 * A Codex conversation tab is a custom editor of view type chatgpt.conversationEditor whose resource is
 * openai-codex://route/local/<thread id> (or /remote/<id> for a cloud task). Codex reads that path as the tab's first
 * route, and restores its own tabs by opening the same URI with the same view type - which is what openInTab does.
 *
 * Not every Codex conversation tab names its thread. Codex opens a new one at openai-codex://route/extension/panel/new
 * and that URI never changes, so a conversation the user started with Codex's own New button has no id in its tab for
 * as long as the tab lives. The id for those comes from the patch, which is handed each panel with its thread
 * (src/patching.js panelThreads); from the URI alone such a tab is indistinguishable from an empty one.
 */
const VIEW_TYPE = 'chatgpt.conversationEditor';
const SCHEME = 'openai-codex';
const AUTHORITY = 'route';
/* Codex's route for a conversation that has not started yet; its URI never names a conversation. */
const NEW_PANEL_PATH = '/extension/panel/new';
/* Codex accepts any non-empty second segment as the id and checks its shape nowhere, so neither does this: the id is
   looked up in the thread list afterwards, and rejecting one Codex would have accepted loses a real tab. */
const ROUTE = /^\/?(local|remote)\/([^/?#]+)(?:[/?#]|$)/i;

/* VS Code may report a custom editor's view type with a prefix of its own; only the end is Codex's. */
const isCodexViewType = (viewType) => typeof viewType === 'string' && (viewType === VIEW_TYPE || viewType.endsWith('.' + VIEW_TYPE)
  || viewType.endsWith('-' + VIEW_TYPE));

/** The thread id a Codex resource names, or '' (a new-conversation tab, or not Codex at all). */
function threadOfUri(uri) {
  if (!uri || uri.scheme !== SCHEME || uri.authority !== AUTHORITY) return '';
  const m = ROUTE.exec(uri.path || '');
  return m && m[1].toLowerCase() === 'local' ? m[2].toLowerCase() : '';
}

/** The thread a tab shows, or '' when it is not a Codex conversation tab. `vscode` is passed for the input classes. */
function threadOfTab(vscode, tab) {
  const input = tab && tab.input;
  if (!input) return '';
  if (input instanceof vscode.TabInputCustom && isCodexViewType(input.viewType)) return threadOfUri(input.uri);
  // A tab restored before Codex's editor provider registered can come back as a plain text input on the same URI.
  if (input instanceof vscode.TabInputText && input.uri && input.uri.scheme === SCHEME) return threadOfUri(input.uri);
  return '';
}

/** Whether a tab is one of Codex's own, with a conversation in it or not (a new conversation has none yet). */
function isCodexTab(vscode, tab) {
  const input = tab && tab.input;
  return !!input && input instanceof vscode.TabInputCustom && isCodexViewType(input.viewType);
}

/*
 * A tab described for the log line about a Codex tab whose thread could not be read. The URI's query is left
 * out: Codex puts route state in it, which can carry what the user typed.
 */
function tabShape(tab) {
  const input = tab && tab.input;
  if (!input) return 'no input';
  const ctor = (input.constructor && input.constructor.name) || typeof input;
  const parts = [`input ${ctor}`];
  if (typeof input.viewType === 'string') parts.push(`viewType ${input.viewType}`);
  if (input.uri) parts.push(`uri ${input.uri.scheme || '?'}:${input.uri.path || ''}`);
  return parts.join(', ');
}

/** Every Codex conversation tab in this window: [{ thread, tab, group }], in tab-group order. */
function codexTabs(vscode) {
  const out = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const thread = threadOfTab(vscode, tab);
      if (thread) out.push({ thread, tab, group });
    }
  }
  return out;
}

/** The thread of the active tab, or '' when the active tab is not a Codex conversation. */
function activeThread(vscode) {
  const group = vscode.window.tabGroups.activeTabGroup;
  return group && group.activeTab ? threadOfTab(vscode, group.activeTab) : '';
}

function threadUri(vscode, thread) {
  return vscode.Uri.from({ scheme: SCHEME, authority: AUTHORITY, path: `/local/${thread}` });
}

/*
 * The route Codex opens a new conversation with. Codex's own createNewPanel() builds the same URI and hands it to
 * vscode.openWith asking for `window.activeTextEditor?.viewColumn`, which is the group of whichever text file was last
 * focused rather than the group in front, so a new conversation can land in a split the user was not looking at.
 * Opening the route here instead means the column can be given explicitly.
 */
function newPanelUri(vscode) {
  return vscode.Uri.from({ scheme: SCHEME, authority: AUTHORITY, path: NEW_PANEL_PATH });
}

/*
 * Open a new Codex conversation in a tab. `group` is 'main' for the first editor group, the wide one a split is made
 * from, or 'active' for the group the title bar button was pressed in, which with a split open is the narrow half.
 * Naming the first group keeps a conversation out of that half. False when Codex did not take the route.
 */
async function openNewInTab(vscode, { group = 'main' } = {}) {
  const viewColumn = group === 'active' ? vscode.ViewColumn.Active : vscode.ViewColumn.One;
  await vscode.commands.executeCommand('vscode.openWith', newPanelUri(vscode), VIEW_TYPE,
    { viewColumn, preserveFocus: false, preview: false });
  const tab = vscode.window.tabGroups.activeTabGroup;
  return !!(tab && tab.activeTab && isCodexTab(vscode, tab.activeTab));
}

/*
 * Bring a thread to the front in a tab: the tab that already shows it, or a new one. Resolves to true when a tab shows
 * it afterwards.
 */
async function openInTab(vscode, thread, { preserveFocus = false } = {}) {
  const open = codexTabs(vscode).find((t) => t.thread === thread);
  const options = { preserveFocus, preview: false };
  if (open) options.viewColumn = open.group.viewColumn;
  await vscode.commands.executeCommand('vscode.openWith', threadUri(vscode, thread), VIEW_TYPE, options);
  return codexTabs(vscode).some((t) => t.thread === thread);
}

module.exports = { VIEW_TYPE, SCHEME, AUTHORITY, NEW_PANEL_PATH, isCodexViewType, isCodexTab, tabShape, threadOfUri, threadOfTab, codexTabs,
  activeThread, threadUri, newPanelUri, openInTab, openNewInTab };
