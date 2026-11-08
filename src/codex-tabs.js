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
 */
const VIEW_TYPE = 'chatgpt.conversationEditor';
const SCHEME = 'openai-codex';
const AUTHORITY = 'route';
const ROUTE = /^\/?(local|remote)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;

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

module.exports = { VIEW_TYPE, SCHEME, AUTHORITY, isCodexViewType, isCodexTab, threadOfUri, threadOfTab, codexTabs, activeThread, threadUri,
  openInTab };
