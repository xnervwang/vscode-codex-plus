// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The members the Codex source gives Agent Plus's session list, in the running extension: the features it lists, the
 * conversations of the window's folders with Codex's archived ones, the one import, what the list asks it to do (rename,
 * a goal, delete) sent to Codex's app-server, what deleting removes, the read marks, and Account & usage.
 */
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  const other = tmp('elsewhere');
  const made = fixture.codexHome(home, [{ title: 'First', cwd: home, section: 'sec-1', turns: [{}] }, { title: 'Second', cwd: home, pinned: true, turns: [{}] },
    { title: 'Put away', cwd: home, archived: true, archivedAt: 1000, turns: [{}] }, { title: 'Not here', cwd: other, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  let manages = true;
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: ['sessionList'],
    sessionListManages: () => manages,
    registerSource: (s) => { control.state.source = s; return { accepted: true, code: '', reason: '', registration: { dispose() {} } }; } } } });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  const colors = { [made[0].id]: 'green' };
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true, 'codexPlus.titleColors': colors }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  await tick(300);
  const requests = [];
  let handler = null;
  const conn = {
    registerProvider(name, h) { handler = Object.assign({ name }, h); return { dispose() { handler = null; } }; },
    sendRequest(name, id, method, params) { requests.push({ method, params }); setTimeout(() => handler && handler.onResult({ id, result: {} }), 1); },
  };
  globalThis.__codexExtrasMessage({}, { kind: 'none' }, { codexMcpConnection: conn, postMessageToWebview() {}, sendMessageToPanel() {} });
  const src = control.state.source;
  const sent = () => requests.filter((r) => r.method !== 'threadSection/list').map((r) => [r.method, r.params]);
  try {
    eq(['sessions', 'sessionImport', 'sessionSeen', 'accountInfo'].every((f) => src.features.includes(f)), true, 'the source lists the session list\'s features');
    const page = await src.listSessions({ folders: [home], cursor: null, limit: 500 });
    const byTitle = Object.fromEntries(page.sessions.map((s) => [s.title, s]));
    eq([Object.keys(byTitle).sort(), page.cursor, byTitle.First.kind, byTitle.First.createdAt > 0, typeof byTitle.First.detail],
      [['First', 'Put away', 'Second'], null, 'user', true, 'boolean'],
      'it lists the conversations of the window\'s folders, the ones Codex archived among them, and none of another folder');
    const two = await src.listSessions({ folders: [home], cursor: null, limit: 2 });
    eq([two.sessions.length, two.cursor], [2, '2'], 'a page at a time');
    eq(await src.importSessions({ folders: [home] }), { archived: [{ sessionId: made[2].id, at: 1000000 }], groups: [{ name: 'Pinned', sessionIds: [made[0].id] }],
      pinned: [made[1].id], colors: { [made[0].id]: 'green' } },
    'the import hands over what Codex archived, its sections as groups, what it pinned, and the title colours');

    requests.length = 0;
    eq(await src.runSessionAction('rename', [made[0].id], { title: '  Renamed   one ' }), { results: [{ sessionId: made[0].id, outcome: 'done' }] }, 'a rename is done');
    await tick();
    eq(sent(), [['thread/name/set', { threadId: made[0].id, name: 'Renamed one' }]], 'and sent to Codex, tidied');
    requests.length = 0;
    await src.runSessionAction('goal.pause', [made[0].id], {});
    await src.runSessionAction('goal.clear', [made[0].id], {});
    await tick();
    eq(sent(), [['thread/goal/set', { threadId: made[0].id, origin: 'user', status: 'paused' }], ['thread/goal/clear', { threadId: made[0].id, origin: 'user' }]],
      'Pause Goal and Clear Goal go to Codex as the user\'s');
    eq((await src.runSessionAction('fly', [made[0].id], {})).results[0].outcome, 'refused', 'an action it does not have is refused');

    const what = await src.describeDeletion([made[2].id]);
    eq([what.length, /^the rollout \(\d/.test(what[0].what)], [1, true], 'deleting says what goes: the rollout and its size');
    requests.length = 0;
    const del = await src.runSessionAction('delete', [made[2].id], {});
    await tick();
    eq([del.results[0].outcome, sent()], ['done', [['thread/delete', { threadId: made[2].id }]]], 'and a delete goes to Codex');

    src.noteSeen([made[1].id], false);
    const unread = (await src.listConversations()).find((c) => c.sessionId === made[1].id);
    src.noteSeen([made[1].id], true);
    const read = (await src.listConversations()).find((c) => c.sessionId === made[1].id);
    eq([unread.unseen, read.unseen], [true, false], 'the list\'s read marks go to Codex Plus\'s own record');
    eq(src.accountInfo({ sessionId: '' }), null, 'with no account known yet there is no Account & usage part');
    eq(ext._sweepArchived ? typeof ext._sweepArchived : 'function', 'function', 'the extension keeps its own pass over archived conversations');
    manages = true;
    const swept = await ext._sweepArchived();
    eq(swept === null || (swept && swept.ran === false) || (swept && /session list/.test(String(swept.why || ''))), true,
      'which it leaves to the session list while the list archives and deletes here');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
