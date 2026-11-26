// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A conversation's page and its tab offer rename and mark as unread, as Claude Code's do. Rename goes to the
 * app-server over Codex's own connection (src/patching.js hostRequest); the method name and parameters are the
 * ones an offline app-server of Codex 26.1021.22027 accepted. Mark as unread is kept in this extension's own read
 * record (src/seen.js), not in Codex. Agent Plus's session list does the rest.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];

  /* ── marking as unread, in the read record ── */
  const { createSeen } = require('../../src/seen');
  let now = 1000;
  const seen = createSeen(undefined, { now: () => now, setTimer: () => 1, clearTimer: () => {} });
  const A = '01a1f0f0-0000-7000-8000-00000000000a';
  now = 5000;
  seen.mark(A);
  eq(seen.unread(A, 4000), false, 'a reply that ended before the user last looked is read');
  seen.markUnread(A, true);
  eq(seen.unread(A, 4000), true, 'marked as unread, it is unread again');
  seen.mark(A);
  eq(seen.unread(A, 4000), true, 'and stays so while it is still the conversation in front, where it was marked');
  seen.left(A);
  seen.mark(A);
  eq(seen.unread(A, 4000), false, 'until the user leaves it and comes back to it');

  /* ── the extension ── */
  const home = tmp('home');
  const made = fixture.codexHome(home, [{ title: 'First', cwd: home, turns: [{}] }, { title: 'Second', cwd: home, turns: [{}] },
    { title: 'Put away', cwd: home, archived: true, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: (s) => { control.state.source = s; return { accepted: true, code: '', reason: '', registration: { dispose() {} } }; } } } });
  const ext = require(path.join(root, 'extension.js'));
  const patching = require(path.join(root, 'src', 'patching.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  await tick(300);
  const requests = [];
  let handler = null, answer = (r) => ({ id: r.id, result: {} });
  const conn = {
    registerProvider(name, h) { handler = Object.assign({ name }, h); return { dispose() { handler = null; } }; },
    sendRequest(name, id, method, params) { const r = { name, id, method, params }; requests.push(r); setTimeout(() => handler && handler.onResult(answer(r)), 1); },
  };
  const provider = { codexMcpConnection: conn, postMessageToWebview() {}, sendMessageToPanel() {} };
  const row = (t) => t.id;
  const run = async (cmd, ...args) => { requests.length = 0; await control.state.handlers[`codexPlus.${cmd}`](...args); await tick();
    return requests.filter((r) => r.method !== 'threadSection/list').map((r) => [r.method, r.params]); };
  try {
    /* Before the patch hands over the connection, a short-lived app-server is used instead. No codex program is
       found in this test, so that fails, and the user is told. */
    control.state.inputAnswer = 'No connection';
    control.state.said.length = 0;
    await control.state.handlers['codexPlus.renameThread'](row(made[0]));
    eq(control.state.said.some((s) => /could not rename/.test(s.message)), true, 'with nothing to send it on, renaming says it could not');

    globalThis.__codexExtrasMessage({}, { kind: 'none' }, provider);
    control.state.inputAnswer = (o) => (o.value === 'First' ? 'Renamed' : undefined);
    eq(await run('renameThread', row(made[0])), [['thread/name/set', { threadId: made[0].id, name: 'Renamed' }]],
      'Rename asks for the new title, starting from the old one, and sets it on Codex\'s connection');
    eq(!!handler && requests.length === 1 && requests.every((r) => r.name === handler.name) && handler.name.startsWith('CodexPlus'), true,
      'under a provider name of this extension\'s own');
    control.state.inputAnswer = undefined;
    eq(await run('renameThread', row(made[0])), [], 'and a dismissed box renames nothing');


    answer = (r) => ({ id: r.id, error: { code: -32600, message: 'thread not found' } });
    control.state.said.length = 0;
    control.state.inputAnswer = 'Refused';
    await run('renameThread', row(made[0]));
    eq(control.state.said.some((s) => /thread not found/.test(s.message)), true, 'a refusal from Codex is passed on');
    answer = (r) => ({ id: r.id, result: {} });
    control.state.inputAnswer = undefined;

    /* From the conversation page's own context menu, which names no conversation: it is the one in that tab. */
    control.setTabs([control.codexTab(made[0].id)], 0);
    control.fireTabs();
    await tick(100);
    const source = control.state.source;
    const stateOf = async (id) => (await source.listConversations()).find((c) => c.sessionId === id).state;
    eq(await stateOf(made[0].id), 'idle', 'the conversation in front is read');
    await control.state.handlers['codexPlus.markThreadUnread']({ webview: 'chatgpt.conversationEditor' });
    eq(await stateOf(made[0].id), 'unread', 'Mark as Unread from its page makes it unread, though it is in front');
    eq(await run('renameThread', { webview: 'chatgpt.conversationEditor' }).then((r) => r.length), 0,
      'and Rename from the page renames the conversation in that tab (here dismissed, so nothing is sent)');

    /* From the right-click menu of a tab: VS Code passes that tab's URI, even when the tab is not in front, and its
       place as the second argument. */
    const behind = control.codexTab(made[1].id);
    control.setTabs([control.codexTab(made[0].id), behind], 0);
    control.fireTabs();
    await tick(100);
    eq(await stateOf(made[1].id), 'idle', 'the conversation of the tab behind is read');
    await control.state.handlers['codexPlus.markThreadUnread'](behind.input.uri, { groupId: 1, editorIndex: 1 });
    eq(await stateOf(made[1].id), 'unread', 'Mark as Unread from a tab\'s own menu makes the conversation of that tab unread, not the one in front');
    control.state.inputAnswer = (o) => (o.value === 'Second' ? 'Second, renamed' : undefined);
    eq(await run('renameThread', behind.input.uri, { groupId: 1, editorIndex: 1 }), [['thread/name/set', { threadId: made[1].id, name: 'Second, renamed' }]],
      'and Rename from it renames that tab\'s conversation');
    control.state.inputAnswer = undefined;
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }

  /* ── the manifest ── */
  const menus = pkg.contributes.menus;
  const onPage = (menus['webview/context'] || []).filter((m) => m.when === "webviewId == 'chatgpt.conversationEditor'").map((m) => m.command).sort();
  eq(onPage, ['codexPlus.markThreadUnread', 'codexPlus.renameThread'],
    'the right-click menu of a conversation\'s page has Rename and Mark as Unread; groups are the session list\'s');
  const onTab = (menus['editor/title/context'] || []).filter((m) => /\bresourceScheme == 'openai-codex'/.test(m.when || '')).map((m) => m.command).sort();
  eq(onTab, ['codexPlus.markThreadUnread', 'codexPlus.renameThread'],
    'and so has the right-click menu of a Codex tab itself, as docs/tabs.md says');
  const hidden = (menus.commandPalette || []).filter((m) => m.when === 'false').map((m) => m.command);
  eq(['renameThread', 'markThreadUnread'].filter((c) => !hidden.includes(`codexPlus.${c}`)), [],
    'none of them is in the command palette, where Claude Code has none of them either');
};
