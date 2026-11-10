// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Codex session list as a webview view: what the host posts to the page, and when. The page gets the model when it
 * sends `ready` (again after VS Code dropped it while hidden), then only when the model changed and the view is
 * visible. As in Claude Code's list, the model names the conversation in front for the page to highlight. Clicks and
 * drops come in as messages and run the matching commands.
 */
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const { SessionsModel, SessionsView } = require('../../src/sessions-view');

  /* ── the model names the conversation in front, and changes only when something did ── */
  const threads = [1, 2].map((n) => ({ id: ID(n), title: `t${n}`, kind: 'user', cwd: '/w', updatedMs: Date.now(), createdMs: Date.now() }));
  let front = ID(1);
  const model = new SessionsModel(vscode, { memento: fake.memento(), stateOf: () => null,
    memory: { openThreads: () => [ID(1), ID(2)], recentlyClosed: () => [], frontAt: () => 0 },
    reader: { threads: () => threads, sections: () => new Map(), state: () => null, thread: () => null },
    settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }), front: () => front });
  let changes = 0;
  model.onDidChange(() => changes++);
  eq([model.refresh(), model.model().front, changes], [true, ID(1), 1], 'the model names the conversation in front');
  eq([model.refresh(), changes], [false, 1], 'worked out again with nothing changed, it is not sent again');
  front = ID(2);
  eq([model.refresh(), model.model().front, changes], [true, ID(2), 2], 'and a new conversation in front is a change');

  /* ── the view: sent on request, then on change while visible ── */
  const said = [];
  const view = new SessionsView(vscode, { model, extensionUri: vscode.Uri.file(root), receive: (m) => said.push(m) });
  control.state.webviewViews.direct = view;
  const shown = control.showWebviewView('direct');
  eq([shown.webview.options.enableScripts, shown.webview.options.retainContextWhenHidden,
    /script-src 'nonce-[A-Za-z0-9]{32}'/.test(shown.webview.html), /sessions-page\.js/.test(shown.webview.html)], [true, undefined, true, true],
  'the page is this extension\'s own script under a content policy with a nonce, and keeps no page while hidden');
  await shown.fromPage({ kind: 'ready' });
  eq(shown.posted.map((m) => m.type), ['model'], 'a page that says it is ready is sent the model');
  model.refresh();
  eq(shown.posted.length, 1, 'nothing more is sent while nothing changed');
  shown.setVisible(false);
  front = ID(1);
  model.refresh();
  eq(shown.posted.length, 1, 'nor while the view is hidden');
  shown.setVisible(true);
  eq([shown.posted.length, shown.posted[1].model.front], [2, ID(1)], 'and coming back into view sends the model it missed');
  await shown.fromPage({ kind: 'select', ids: [ID(1), 7, ID(2)] });
  eq(view.selection, [ID(1), ID(2)], 'the page\'s selection is kept for the right-click commands, ids only');

  /* ── the extension registers it that way, and acts on what its page sends ── */
  const home = tmp('home');
  const made = fixture.codexHome(home, [{ title: 'Kept', cwd: home, turns: [{}] }, { title: 'Also kept', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: () => ({ accepted: true, code: '', reason: '', registration: { dispose() {} } }) } } });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  try {
    eq(control.state.webviewViews['codexPlus.sessions'] instanceof SessionsView, true, 'the session list is the extension\'s webview view');
    await tick(300);
    const page = control.showWebviewView('codexPlus.sessions');
    await page.fromPage({ kind: 'ready' });
    const m = page.posted.find((x) => x.type === 'model');
    eq(m && m.model.groups.flatMap((g) => g.rows).map((r) => r.title).sort(), ['Also kept', 'Kept'], 'and its page is sent this workspace\'s conversations');
    const ran = [];
    for (const c of ['codexPlus.openThreadInTab', 'codexPlus.openThreadInSidebar', 'codexPlus.newInTab', 'codexPlus.newInSidebar']) {
      control.state.handlers[c] = (...a) => { ran.push([c, ...a]); };
    }
    await page.fromPage({ kind: 'open', id: made[0].id, where: 'tab' });
    await page.fromPage({ kind: 'open', id: made[1].id, where: 'sidebar' });
    await page.fromPage({ kind: 'newInTab' });
    await page.fromPage({ kind: 'newInSidebar' });
    eq(ran, [['codexPlus.openThreadInTab', made[0].id], ['codexPlus.openThreadInSidebar', made[1].id], ['codexPlus.newInTab'], ['codexPlus.newInSidebar']],
      'a click on a row opens it, in a tab or in the sidebar as the row says, and the two buttons start a conversation');
    await page.fromPage({ kind: 'select', ids: [made[0].id, made[1].id] });
    page.posted.length = 0;
    await control.state.handlers['codexPlus.renameThread']({ webview: 'codexPlus.sessions', webviewSection: 'thread', threadId: made[1].id });
    eq(page.posted.filter((x) => x.type === 'startRename'), [{ type: 'startRename', id: made[1].id }],
      'Rename from a row\'s right-click menu edits that row\'s title, even with other rows selected too');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
