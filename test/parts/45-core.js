// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Both extensions together: Agent Plus from its own checkout (AGENT_WORK_PLAN_DIR, or vscode-agent-plus beside
 * this repository) activated first, as VS Code activates a dependency, then this one, in one stand-in VS Code. The Codex
 * source has to be taken, its conversations drawn in the Conversations tree, its tab followed by the work plan view, and
 * an answer to one of its questions handed to it.
 *
 * The stand-in is Agent Plus's own test/fake-vscode.js, with the few members this extension needs added.
 */
const fs = require('fs');
const path = require('path');
const fixture = require('../fixture');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, note, tmp, root }) => {
  const core = process.env.AGENT_WORK_PLAN_DIR || path.join(root, '..', 'vscode-agent-plus');
  if (!fs.existsSync(path.join(core, 'src', 'host.js'))) { note(`no Agent Plus checkout at ${core}: the two were not run together`); return; }
  const fake = require(path.join(core, 'test', 'fake-vscode.js'));
  const { vscode, control } = fake.create();
  vscode.window.registerTreeDataProvider = (id, provider) => { control.state.views[id] = { id, provider }; return { dispose() {} }; };
  /* The session list follows the conversation in front through its tree view's reveal. */
  const plainTree = vscode.window.createTreeView;
  vscode.window.createTreeView = (id, opts) => {
    const view = plainTree(id, opts);
    if (typeof view.reveal !== 'function') view.reveal = async () => {};
    return view;
  };
  vscode.window.registerFileDecorationProvider = () => ({ dispose() {} });
  vscode.FileDecoration = class { constructor(badge, tooltip, color) { Object.assign(this, { badge, tooltip, color }); } };
  vscode.MarkdownString.prototype.appendCodeblock = function (s) { this.value += '\n```\n' + s + '\n```\n'; return this; };
  const undo = fake.install(vscode);
  for (const dir of [root, core]) fake.fresh(dir);
  const shared = tmp('shared');
  const saved = process.env.AGENT_WORK_PLAN_HOME;
  process.env.AGENT_WORK_PLAN_HOME = shared;

  const home = tmp('codex-home');
  const ws = tmp('ws');
  const [asking, other] = fixture.codexHome(home, [
    { title: 'Asks a question', cwd: ws, startMs: Date.now() - 60e3, turns: [{}] },
    { title: 'Elsewhere', cwd: tmp('elsewhere'), turns: [{}] },
  ]);
  const plans = path.join(home, 'plugins', 'data', 'agent-work-plan-codex-extras');
  fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(path.join(plans, asking.id + '.json'), JSON.stringify({ nodes: [{ title: 'Merge', state: 'waiting', waitingOn: 'user', question: 'Merge it?' }] }));
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws) }];
  process.env.CODEX_HOME = home;
  Object.assign(control.state.config, {
    'codexPlus.reopenDroppedTabs': false, 'agentPlus.workPlanView': true, 'agentPlus.conversationsView': true,
  });
  const corePkg = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8'));
  const selfPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const coreEntry = { id: 'xnervwang.agent-plus', packageJSON: corePkg, isActive: false, exports: undefined, extensionPath: core };
  control.state.extensions = [coreEntry, { id: 'xnervwang.codex-plus', packageJSON: selfPkg, extensionPath: root }];
  const context = (name) => ({ subscriptions: [], globalState: fake.memento({ 'codexPlus.patchRemoved': true }), workspaceState: fake.memento(),
    globalStorageUri: vscode.Uri.file(tmp(name)), extensionPath: name === 'core' ? core : root });
  const coreContext = context('core'), selfContext = context('codex');
  try {
    const exported = require(path.join(core, 'extension.js')).activate(coreContext);
    Object.assign(coreEntry, { isActive: true, exports: exported });
    /* The core hides its views by one key that reads the other way round: it is set only once the core has worked out
       that nothing uses it. */
    eq([control.state.context['agentPlus.alone'], exported.agentPlus.protocol], [false, 1],
      'Agent Plus sees Codex Plus depends on it, and speaks protocol 1');
    await require(path.join(root, 'extension.js')).activate(selfContext);
    await wait(400);
    eq([control.state.context['codexPlus.registered'], control.state.log.some((l) => /conversation source registered: Codex \(codex\)/.test(l))],
      [true, true], 'the Codex source is registered with Agent Plus');
    const tree = control.state.views['agentPlus.conversations'].provider;
    const rows = tree.getChildren().filter((e) => e.kind === 'conversation').map((e) => tree.getTreeItem(e));
    const status = control.state.status.find((i) => i.id === 'agentPlus.conversations');
    eq([rows.map((r) => r.id), rows[0] && rows[0].description.split(' · ')[0], status && status.text.endsWith('1 to decide')],
      [[`conversations/codex/${asking.id}`], 'needs you', true],
      'the Codex conversation in this workspace is drawn, needing an answer; the other folder\'s is not');
    eq(!!control.state.views['codexPlus.sessions'], true, 'the Codex session list is there too');

    const tab = { label: 'Codex', input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: `/local/${asking.id}` }),
      'chatgpt.conversationEditor') };
    control.setTabs([tab]);
    control.fireTabs();
    await wait(30);
    const plan = control.state.views['agentPlus.workPlan'];
    eq([plan.provider.shown() && plan.provider.shown().file, plan.description], [path.join(plans, asking.id + '.json'), 'Codex'],
      'the work plan view follows the Codex tab');

    const qrow = tree.getChildren(tree.getChildren().find((e) => e.kind === 'conversation'))[0];
    await control.state.handlers['agentPlus.answerQuestion'](tree.getTreeItem(qrow).command.arguments[0]);
    const view = control.state.webviews['agentPlus.answer'];
    view.receive({ type: 'send', key: view.current.key, text: 'Yes.' });
    await wait(200);
    const st = view.states.get(view.current.key);
    eq([st && st.kind, fs.existsSync(path.join(shared, 'answers'))], ['waiting', true],
      'an answer goes into the shared folder; without the patch no window can type it, so it waits to be taken');
    /* With the patch handing over the Codex panel of that conversation, this window can type the answer into it. */
    const posted = [];
    /* The page script answers what it saw; this stand-in says the box let go of the text, as it does once sent. */
    const provider = { sendMessageToPanel: (panel, msg) => posted.push(msg), postMessageToWebview: (webview, msg) => {
      if (msg && msg.type === 'codex-extras-answer') setImmediate(() => globalThis.__codexExtrasMessage(webview, { kind: 'answer', id: msg.id, outcome: 'submitted' }, provider));
    } };
    const panel = { webview: {}, reveal() {}, onDidDispose() {}, iconPath: null };
    globalThis.__codexExtrasPanel(panel, asking.id, provider);
    const view2 = control.state.webviews['agentPlus.answer'];
    const qrow2 = tree.getChildren(tree.getChildren().find((e) => e.kind === 'conversation'))[0];
    await control.state.handlers['agentPlus.answerQuestion'](Object.assign({}, tree.getTreeItem(qrow2).command.arguments[0], { row: '1' }));
    view2.states.delete(view2.current.key);
    view2.receive({ type: 'send', key: view2.current.key, text: 'Yes, now.' });
    await wait(400);
    const typed = posted.filter((m) => m.type === 'navigate-to-route');
    eq([typed.map((m) => m.path), typed.map((m) => m.state.prefillPrompt.split('\n').pop()), view2.states.get(view2.current.key).kind],
      [[`/local/${asking.id}`, `/local/${asking.id}`], ['Yes.', 'Yes, now.'], 'submitted'],
      'once the patch hands over the panel, the answer still waiting is taken too; each is drafted there and sent by its page, which says so');
    eq(other.id.length, 36, 'the other thread exists');
  } finally {
    for (const c of [selfContext, coreContext]) for (const d of c.subscriptions.splice(0)) { try { d.dispose(); } catch (_) { /* gone */ } }
    try { require(path.join(root, 'extension.js')).deactivate(); } catch (_) { /* closing */ }
    if (saved === undefined) delete process.env.AGENT_WORK_PLAN_HOME; else process.env.AGENT_WORK_PLAN_HOME = saved;
    undo();
  }
};
