// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The host's side of the links to other conversations (codexPlus.conversationLinks): it listens to Agent Plus's
 * allConversations only while the setting is on, hands the list to each Codex page with the conversation that page
 * shows, and opens the conversation behind a page's link through agentPlus.openConversation. An Agent Plus without the
 * feature leaves it all off without an error.
 */
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const X = '01a2f3f3-0000-7000-8000-0000000000c1';
const Y = '01a2f3f3-0000-7000-8000-0000000000c2';
const Z = '7c1e2d3f-2222-7000-8000-0000000000c3';

function coreWith(list) {
  const core = { features: ['allConversations'], listeners: new Set(), disposed: 0, list,
    allConversations() { return core.list; },
    onDidChangeAllConversations(fn) { core.listeners.add(fn); return { dispose() { core.disposed++; core.listeners.delete(fn); } }; },
    fire() { for (const fn of [...core.listeners]) fn(); } };
  return core;
}

module.exports = async ({ eq, tmp, root }) => {
  const { createConversationLinks } = require('../../src/convo-links');
  const everyone = [
    { sourceId: 'codex', label: 'Codex', sessionId: X, title: 'Fix the retry delay', steward: false, cwd: '/w/a', lastActiveAt: 5 },
    { sourceId: 'claude-code', label: 'Claude Code', sessionId: Z, title: '回归测试 CSV和 JSON', steward: true, cwd: '/w/z', lastActiveAt: 7 },
  ];
  const core = coreWith(everyone);
  let on = true, changed = 0;
  const ran = [];
  const links = createConversationLinks({ core, enabled: () => on, onChange: () => { changed++; },
    exec: async (...a) => { ran.push(a); } });
  eq([links.view().on, core.listeners.size], [false, 0], 'nothing is listened to before it is started');
  links.sync();
  eq([links.view().on, core.listeners.size, changed > 0], [true, 1, true], 'with the setting on it listens to Agent Plus\'s list of every conversation');
  eq(links.view().list, [
    { sourceId: 'codex', label: 'Codex', sessionId: X, title: 'Fix the retry delay', lastActiveAt: 5 },
    { sourceId: 'claude-code', label: 'Claude Code', sessionId: Z, title: '回归测试 CSV和 JSON', lastActiveAt: 7 }],
  'and keeps what a page needs of it: the agent, the id, the title and when it was last active, and not the folder');
  links.sync();
  eq(core.listeners.size, 1, 'a second sync does not listen twice');

  const before = links.view().version;
  core.list = everyone.concat([{ sourceId: 'codex', label: 'Codex', sessionId: Y, title: 'Draft the release notes', cwd: '/w/b', lastActiveAt: 9 }]);
  const told = changed;
  core.fire();
  eq([links.view().list.length, links.view().version !== before, changed > told], [3, true, true], 'a change Agent Plus tells of reaches the pages');

  await links.open('claude-code', Z);
  eq(ran.pop(), ['agentPlus.openConversation', { sourceId: 'claude-code', sessionId: Z, title: '回归测试 CSV和 JSON', cwd: '/w/z' }],
    'opening a conversation a link names runs Agent Plus\'s Open with its agent, id, title and folder from the host\'s own list');
  await links.open('codex', 'not-a-conversation');
  await links.open('claude-code', X);
  eq(ran.length, 0, 'and a conversation not in that list, or under another agent, is not opened');

  on = false;
  links.sync();
  eq([links.view().on, links.view().list, core.listeners.size, core.disposed], [false, [], 0, 1], 'turned off, it stops listening and hands the pages no list');
  links.dispose();

  const old = { features: [], registerSource() {} };
  const quiet = createConversationLinks({ core: old, enabled: () => true, onChange: () => {}, exec: async () => {} });
  let threw = null;
  try { quiet.sync(); await quiet.open('codex', X); } catch (e) { threw = e; }
  eq([threw, quiet.view().on], [null, false], 'an Agent Plus without allConversations leaves it off, with no error');
  const broken = createConversationLinks({ core: { features: ['allConversations'] }, enabled: () => true, onChange: () => {}, exec: async () => {} });
  threw = null;
  try { broken.sync(); } catch (e) { threw = e; }
  eq([threw, broken.view().on], [null, false], 'and so does one that names the feature without its functions');
  const none = createConversationLinks({ core: null, enabled: () => true, onChange: () => {}, exec: async () => {} });
  none.sync();
  eq(none.view().on, false, 'and no Agent Plus at all');

  /* ── through the patch ── */
  const { vscode } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (/[/\\]src[/\\]patching\.js$/.test(k)) delete require.cache[k];
  const patching = require('../../src/patching');
  const sent = [];
  const provider = { sendMessageToPanel() {}, postMessageToWebview(webview, msg) { sent.push({ to: webview.id, msg }); },
    postMessageToSidebar(msg) { sent.push({ to: 'sidebar', msg }); }, navigateToRoute() {} };
  let conversations = [{ sessionId: X, title: 'Fix the retry delay', activity: 'stopped' }, { sessionId: Y, title: 'Draft the release notes', activity: 'stopped' }];
  const source = { listConversations: async () => conversations, onDidChangeConversations: new fake.EventEmitter().event, _focus() {} };
  const context = { subscriptions: [], globalState: fake.memento(), globalStorageUri: vscode.Uri.file(tmp('gs')) };
  const core2 = coreWith(everyone);
  let linksOn = true;
  const opened = [];
  const links2 = createConversationLinks({ core: core2, enabled: () => linksOn, onChange: () => patching.refreshConversationLinks(),
    exec: async (...a) => { opened.push(a); } });
  patching.installHooks();
  patching._approvals.clear();
  patching.activate(context, { vscode, log: () => {}, source, context,
    settings: () => ({ patchCodex: 'off', chime: false, figures: false, enabled: true, timestamps: false, conversationLinks: linksOn }),
    conversations: () => links2.view(), openConversation: (s, id) => links2.open(s, id) });
  const panelOf = (id) => ({ webview: { id }, title: 'Codex', visible: false, viewColumn: 1, active: false, iconPath: null,
    reveal() {}, onDidDispose(fn) { this.dispose = fn; } });
  const onX = panelOf('tab on X'), onY = panelOf('tab on Y');
  globalThis.__codexExtrasPanel(onX, X, provider, `/local/${X}`);
  globalThis.__codexExtrasPanel(onY, Y, provider, `/local/${Y}`);
  links2.sync();
  await patching.refreshPanels();
  const lists = (to) => sent.filter((s) => s.to === to && s.msg.type === 'codex-extras-conversations').map((s) => s.msg);
  const last = (to) => lists(to).pop();
  eq([last('tab on X') && last('tab on X').on, last('tab on X') && last('tab on X').self, last('tab on X') && last('tab on X').list.length],
    [true, { sessionId: X, title: 'Fix the retry delay' }, 2], 'a page gets the list of every conversation, and which one it shows itself');
  eq(last('tab on Y') && last('tab on Y').self, { sessionId: Y, title: 'Draft the release notes' }, 'and each page its own');
  const count = lists('tab on X').length;
  await patching.refreshPanels();
  eq(lists('tab on X').length, count, 'the list is sent again only when it, the page\'s conversation or the setting changed');
  core2.list = everyone.slice(0, 1);
  core2.fire();
  eq(last('tab on X').list.length, 1, 'a change of the list reaches the open pages at once');

  globalThis.__codexExtrasMessage(onX.webview, { type: 'codex-extras', kind: 'openConversation', sourceId: 'codex', sessionId: X }, provider);
  globalThis.__codexExtrasMessage(onY.webview, { type: 'codex-extras', kind: 'openConversation', sourceId: 7, sessionId: {} }, provider);
  await new Promise((r) => setTimeout(r, 20));
  eq(opened, [['agentPlus.openConversation', { sourceId: 'codex', sessionId: X, title: 'Fix the retry delay', cwd: '/w/a' }]],
    'a click on a link in a page opens that conversation through Agent Plus, and a message that names none is dropped');

  linksOn = false;
  links2.sync();
  await patching.refreshPanels();
  eq([last('tab on X').on, last('tab on X').list], [false, []], 'turned off, each page is told so, which takes its links away');
  for (const p of [onX, onY]) p.dispose();
  patching._approvals.clear();
  for (const d of context.subscriptions) { try { d.dispose(); } catch (_) { /* gone */ } }

  /* ── the extension itself, with an Agent Plus that has the feature and one that has not ── */
  const activated = async (agentPlus, config) => {
    const made = fake.create();
    const heard = [];
    made.vscode.workspace.onDidChangeConfiguration = (fn) => { heard.push(fn); return { dispose() {} }; };
    fake.install(made.vscode);
    for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
    const home = tmp('home');
    fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
    process.env.CODEX_HOME = home;
    made.control.state.config = Object.assign({ reopenDroppedTabs: false }, config);
    made.control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus } });
    const ext = require(path.join(root, 'extension.js'));
    const subs = [];
    await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
      globalStorageUri: made.vscode.Uri.file(tmp('gs')), extensionPath: root });
    const tell = (key) => { for (const fn of heard) fn({ affectsConfiguration: (k) => k === 'codexPlus' || k === `codexPlus.${key}` }); };
    return { control: made.control, tell, close: () => { for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } } ext.deactivate(); } };
  };
  const registerable = (extra) => Object.assign({ protocol: 1, accepts: [1],
    registerSource: () => ({ accepted: true, code: '', reason: '', registration: { dispose() {} } }) }, extra);
  const core3 = coreWith(everyone);
  const w = await activated(registerable({ features: core3.features, allConversations: core3.allConversations, onDidChangeAllConversations: core3.onDidChangeAllConversations }), {});
  try {
    eq(core3.listeners.size, 1, 'once registered with an Agent Plus that offers it, Codex Plus listens for every conversation, the setting being on by default');
    w.control.state.config.conversationLinks = false;
    w.tell('conversationLinks');
    eq([core3.listeners.size, core3.disposed], [0, 1], 'and stops when codexPlus.conversationLinks is turned off');
    w.control.state.config.conversationLinks = true;
    w.tell('conversationLinks');
    eq(core3.listeners.size, 1, 'and starts again when it is turned back on');
    w.control.state.config.enabled = false;
    w.tell('enabled');
    eq(core3.listeners.size, 0, 'and Codex Plus turned off stops it as well');
  } finally { w.close(); }
  threw = null;
  let o = null;
  try {
    o = await activated(registerable({ features: [] }), {});
    o.tell('conversationLinks');
  } catch (e) { threw = e; } finally { if (o) o.close(); }
  eq(threw, null, 'an older Agent Plus with no allConversations activates Codex Plus and takes the setting\'s changes with no error');
  /* Drops the extension's modules from the require cache, so the next part does not get them with what these
     activations left in them. */
  await new Promise((r) => setTimeout(r, 50));
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
};
