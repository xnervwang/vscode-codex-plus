// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Opening a Codex tab again when Codex has replaced its page with its recovery page ("ChatGPT hit a snag") because one
 * of its own modules failed to load. The page script finds that page and says so (lookForBroken in
 * src/page/codex-extras-page.js). The browser keeps a failed module load for the rest of the page's life, so only a
 * new page brings the conversation back: the tab is closed and the conversation opened again in the same editor group,
 * at the same position, in front only if it was in front.
 *
 * A tab whose conversation is not known yet (a New tab before its first message) has nothing to open again, and the
 * sidebar has no tab, so those are only logged. A conversation is opened again at most LIMIT times in WINDOW_MS; after
 * that it is left as it is, with a line in the log.
 *
 * VS Code has no call that puts a tab at a position or brings one to the front, so the tab opened again is moved with
 * moveActiveEditor while it is the group's active editor, the tab in front before is shown again with
 * workbench.action.openEditorAtIndex, and the group that had the focus gets it back by its own command, as
 * src/load-tabs.js does for the tabs it loads.
 */
const tabs = require('./codex-tabs');
const { FOCUS_GROUP } = require('./load-tabs');

/* How long to wait before closing the tab, which gives whatever made the load fail a moment to pass. */
const WAIT_MS = 2000;
const LIMIT = 2;
const WINDOW_MS = 10 * 60e3;

/* The tab showing `uri` (a tab URI as a string), as { group, tab, index }, or null. */
function tabAt(vscode, uri) {
  for (const group of vscode.window.tabGroups.all) {
    const index = group.tabs.findIndex((t) => { try { return !!t.input && !!t.input.uri && String(t.input.uri) === uri; } catch (_) { return false; } });
    if (index >= 0) return { group, tab: group.tabs[index], index };
  }
  return null;
}

/*
 * vscode; log(line); sleep(ms) -> Promise; now() -> ms. report({ thread, uri, file }) handles one page's report and
 * resolves to what was done: 'reopened', 'unknown' (no conversation), 'gone' (no such tab), 'limit', or 'failed'.
 * Reports are handled one at a time, since each one moves the focus between groups.
 */
function createBrokenTabs({ vscode, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, waitMs = WAIT_MS } = {}) {
  const recent = new Map();
  let chain = Promise.resolve();
  const exec = (command, ...args) => Promise.resolve(vscode.commands.executeCommand(command, ...args));

  async function reopen({ thread, uri, file }) {
    const what = `Codex's page for ${thread ? `conversation ${thread}` : 'a conversation not started yet'} could not load its code${file ? ` (${file})` : ''}`;
    if (!thread) { log(`${what}; its tab has no conversation to open again, so it is left for the user`); return 'unknown'; }
    const times = (recent.get(thread) || []).filter((t) => now() - t < WINDOW_MS);
    if (times.length >= LIMIT) { log(`${what} again; it was opened again ${times.length} times in the last ${WINDOW_MS / 60e3} minutes, so it is left for the user`); return 'limit'; }
    times.push(now());
    recent.set(thread, times);
    log(`${what}; opening its tab again`);
    await sleep(waitMs);
    const at = tabAt(vscode, uri);
    if (!at) { log(`the tab of conversation ${thread} was gone before it could be opened again`); return 'gone'; }
    const { group, index } = at;
    const wasFront = at.tab.isActive, focused = vscode.window.tabGroups.activeTabGroup;
    const frontIndex = group.tabs.findIndex((t) => t.isActive);
    try {
      await vscode.window.tabGroups.close(at.tab, true);
      const focus = FOCUS_GROUP[(group.viewColumn || 0) - 1];
      await exec('vscode.openWith', tabs.threadUri(vscode, thread), tabs.VIEW_TYPE, { viewColumn: group.viewColumn, preserveFocus: false, preview: false });
      /* The tab opened again is the active editor of the group now, where it can be moved; positions count from 1. */
      if (focus) await exec(focus);
      await exec('moveActiveEditor', { to: 'position', by: 'tab', value: index + 1 });
      if (!wasFront && frontIndex >= 0) await exec('workbench.action.openEditorAtIndex', frontIndex);
      const back = focused && FOCUS_GROUP[(focused.viewColumn || 0) - 1];
      if (back && focused.viewColumn !== group.viewColumn) await exec(back);
      log(`opened the tab of conversation ${thread} again, at position ${index + 1} of editor group ${group.viewColumn}${wasFront ? ', in front' : ''}`);
      return 'reopened';
    } catch (e) {
      log(`could not open the tab of conversation ${thread} again: ${(e && e.message) || e}`);
      return 'failed';
    }
  }

  return {
    report(r) {
      const next = chain.then(() => reopen(r));
      chain = next.catch(() => {});
      return next;
    },
  };
}

module.exports = { createBrokenTabs, tabAt, WAIT_MS, LIMIT, WINDOW_MS };
