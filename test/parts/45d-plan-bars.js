// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The host's side of the plan bar (codexPlus.planBar, src/plan-bars.js) listens to Agent Plus's planSummary only while
 * the setting is on.
 */
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const X = '01a2f3f3-0000-7000-8000-0000000000d1';
const Y = '01a2f3f3-0000-7000-8000-0000000000d2';

const summaryFor = (id, open, questions) => ({ total: open + 1, done: 1, counts: { discussing: 0, todo: open - 1, doing: 1, waiting: 0, parked: 0, done: 1 },
  current: { number: '2', title: `Work of ${id.slice(-2)}`, state: 'doing', dim: false }, allDone: false, questions,
  open: [{ number: '2', title: `Work of ${id.slice(-2)}`, state: 'doing', depth: 1 }] });

function coreWith(plans) {
  const core = { features: ['allConversations', 'waitingFor', 'planSummary'], listeners: new Set(), disposed: 0, asked: [], plans,
    planSummary(sourceId, sessionId) { core.asked.push([sourceId, sessionId]); return sourceId === 'codex' && core.plans[sessionId] ? Object.freeze(core.plans[sessionId]) : null; },
    onDidChangePlanSummary(fn) { core.listeners.add(fn); return { dispose() { core.disposed++; core.listeners.delete(fn); } }; },
    fire(e) { for (const fn of [...core.listeners]) fn(e); } };
  return core;
}

module.exports = async ({ eq, tmp, root }) => {
  const { createPlanBars, NO_BAR, PAGE_TYPE } = require('../../src/plan-bars');
  const core = coreWith({ [X]: summaryFor(X, 3, 0) });
  let on = true;
  const changed = [], ran = [];
  const bars = createPlanBars({ core, enabled: () => on, onChange: (id) => changed.push(id), exec: async (...a) => { ran.push(a); } });
  eq([bars.view(X), core.listeners.size, core.asked.length], [NO_BAR, 0, 0], 'nothing is listened to or asked for before it is started');
  bars.sync();
  eq([bars.on(), core.listeners.size, changed], [true, 1, [null]], 'with the setting on it listens to Agent Plus\'s plan summaries, and has every page sent its bar');
  eq(bars.view(X), { type: PAGE_TYPE, on: true, summary: summaryFor(X, 3, 0) }, 'a page showing a conversation is sent that conversation\'s summary');
  eq(core.asked, [['codex', X]], 'asked of Agent Plus with the Codex source\'s id');
  bars.view(X);
  bars.view(X);
  eq(core.asked.length, 1, 'and asked once: redrawing the pages reads the kept summary');
  eq(bars.view(Y).summary, null, 'a conversation with no plan gets no bar');
  bars.view(X, { fresh: true });
  eq(core.asked.length, 3, 'a page that loaded afresh has it asked for again');

  core.plans[X] = summaryFor(X, 4, 2);
  changed.length = 0;
  core.fire({ sourceId: 'codex', sessionId: X });
  eq([changed, bars.view(X).summary.questions, bars.view(X).summary.total], [[X], 2, 5], 'Agent Plus saying the summary changed has it asked for again and that conversation\'s pages told');
  changed.length = 0;
  core.fire({ sourceId: 'claude-code', sessionId: X });
  core.fire({ sourceId: 'codex', sessionId: '7c1e2d3f-2222-7000-8000-0000000000ff' });
  core.fire(null);
  eq(changed, [], 'and a change of another agent\'s conversation, of one no page here asked about, or no change at all, tells nobody');

  await bars.act(X, 'open');
  await bars.act(X, 'answer');
  eq(ran, [['agentPlus.showWorkPlanOf', { sourceId: 'codex', sessionId: X }], ['agentPlus.answerQuestionOf', { sourceId: 'codex', sessionId: X }]],
    'a click on the bar shows the plan in Agent Plus, and one on its red part opens the Answer view, each with the source and the conversation');
  ran.length = 0;
  await bars.act(X, 'toString');
  await bars.act('', 'open');
  await bars.act({}, 'open');
  eq(ran, [], 'and anything else runs nothing');

  on = false;
  changed.length = 0;
  bars.sync();
  eq([bars.view(X), core.listeners.size, core.disposed, changed], [NO_BAR, 0, 1, [null]], 'turned off, it stops listening and every page is told there is no bar');
  await bars.act(X, 'open');
  eq(ran, [], 'and a click that comes in after runs nothing');
  bars.dispose();

  const quiet = (agentPlus) => {
    let threw = null, view = null;
    try {
      const b = createPlanBars({ core: agentPlus, enabled: () => true, onChange: () => {}, exec: async () => { throw new Error('ran'); } });
      b.sync();
      view = b.view(X);
      b.act(X, 'open').catch((e) => { threw = e; });
    } catch (e) { threw = e; }
    return [threw, view];
  };
  eq(quiet({ features: ['allConversations', 'waitingFor'], registerSource() {} }), [null, NO_BAR], 'an Agent Plus without planSummary draws no bar, with no error');
  eq(quiet({ features: ['planSummary'] }), [null, NO_BAR], 'and so does one that names the feature without its functions');
  eq(quiet(null), [null, NO_BAR], 'and no Agent Plus at all');
  const throwing = coreWith({});
  throwing.planSummary = () => { throw new Error('broken'); };
  const said = [];
  const t = createPlanBars({ core: throwing, enabled: () => true, log: (m) => said.push(m) });
  t.sync();
  eq([t.view(X).summary, said.length], [null, 1], 'a summary that throws draws no bar and is logged');

  /* ── through the patch ── */
  const { vscode, control } = fake.create();
  fake.install(vscode);
  /* removePatch tells the open pages to drop the bar before it restores Codex's files, and only once it has found a
     Codex to restore, so the fake window is given one. */
  control.state.extensions.set('openai.chatgpt', { extensionPath: tmp('codex-of-this-window'), packageJSON: { version: '26.1021.22027' } });
  for (const k of Object.keys(require.cache)) if (/[/\\]src[/\\]patching\.js$/.test(k)) delete require.cache[k];
  const patching = require('../../src/patching');
  const sent = [];
  const provider = { sendMessageToPanel() {}, postMessageToWebview(webview, msg) { sent.push({ to: webview.id, msg }); },
    postMessageToSidebar(msg) { sent.push({ to: 'sidebar', msg }); }, navigateToRoute() {} };
  const conversations = [{ sessionId: X, title: 'One', activity: 'stopped' }, { sessionId: Y, title: 'Two', activity: 'stopped' }];
  const source = { listConversations: async () => conversations, onDidChangeConversations: new fake.EventEmitter().event, _focus() {} };
  const context = { subscriptions: [], globalState: fake.memento(), globalStorageUri: vscode.Uri.file(tmp('gs')) };
  const core2 = coreWith({ [X]: summaryFor(X, 3, 0), [Y]: summaryFor(Y, 1, 1) });
  let barOn = true, enabled = true;
  const opened = [];
  const bars2 = createPlanBars({ core: core2, enabled: () => barOn, onChange: (id) => patching.refreshPlanBars(id),
    exec: async (...a) => { opened.push(a); } });
  patching.installHooks();
  patching._approvals.clear();
  patching.activate(context, { vscode, log: () => {}, source, context,
    settings: () => ({ patchCodex: 'off', chime: false, figures: false, enabled, timestamps: false, planBar: barOn }),
    planBar: (id, opts) => bars2.view(id, opts), planBarAct: (id, action) => bars2.act(id, action) });
  const panelOf = (id) => ({ webview: { id }, title: 'Codex', visible: false, viewColumn: 1, active: false, iconPath: null,
    reveal() {}, onDidDispose(fn) { this.dispose = fn; } });
  const onX = panelOf('tab on X'), onY = panelOf('tab on Y'), fresh = panelOf('new tab');
  globalThis.__codexExtrasPanel(onX, X, provider, `/local/${X}`);
  globalThis.__codexExtrasPanel(onY, Y, provider, `/local/${Y}`);
  globalThis.__codexExtrasPanel(fresh, null, provider, '/extension/panel/new');
  bars2.sync();
  await patching.refreshPanels();
  const barsTo = (to) => sent.filter((s) => s.to === to && s.msg.type === PAGE_TYPE).map((s) => s.msg);
  const last = (to) => barsTo(to).pop() || null;
  eq([last('tab on X'), last('tab on Y') && last('tab on Y').summary.questions, last('new tab')],
    [{ type: PAGE_TYPE, on: true, summary: summaryFor(X, 3, 0) }, 1, { type: PAGE_TYPE, on: true, summary: null }],
    'each page gets the summary of the conversation it shows, and a page with no conversation yet none');
  const count = barsTo('tab on X').length, asked = core2.asked.length;
  await patching.refreshPanels();
  eq([barsTo('tab on X').length, core2.asked.length], [count, asked], 'a redraw sends a page its bar again only when it changed, and asks Agent Plus nothing');
  core2.plans[X] = summaryFor(X, 2, 3);
  const yBefore = barsTo('tab on Y').length;
  core2.fire({ sourceId: 'codex', sessionId: X });
  eq([last('tab on X').summary.questions, barsTo('tab on Y').length], [3, yBefore], 'a change Agent Plus tells of reaches that conversation\'s pages at once, and only those');

  globalThis.__codexExtrasMessage(onX.webview, { type: 'codex-extras', kind: 'planBar', action: 'open' }, provider);
  globalThis.__codexExtrasMessage(onY.webview, { type: 'codex-extras', kind: 'planBar', action: 'answer' }, provider);
  globalThis.__codexExtrasMessage(onY.webview, { type: 'codex-extras', kind: 'planBar', action: 'delete' }, provider);
  globalThis.__codexExtrasMessage(fresh.webview, { type: 'codex-extras', kind: 'planBar', action: 'open' }, provider);
  await new Promise((r) => setTimeout(r, 20));
  eq(opened, [['agentPlus.showWorkPlanOf', { sourceId: 'codex', sessionId: X }], ['agentPlus.answerQuestionOf', { sourceId: 'codex', sessionId: Y }]],
    'a click in a page runs the command for the conversation that page shows; an unknown action, or a page with no conversation, runs nothing');

  const asking = core2.asked.length, xSent = barsTo('tab on X').length;
  globalThis.__codexExtrasMessage(onX.webview, { type: 'codex-extras', kind: 'tz', timeZone: 'UTC' }, provider);
  eq([barsTo('tab on X').length, core2.asked.length], [xSent + 1, asking + 1], 'a page that loaded afresh is sent its bar again, asked of Agent Plus again');

  barOn = false;
  bars2.sync();
  eq([last('tab on X'), last('tab on Y'), last('new tab')], [NO_BAR, NO_BAR, NO_BAR], 'turned off, each page is told there is no bar');
  barOn = true;
  bars2.sync();
  eq(last('tab on X').summary.questions, 3, 'and turned on again, each gets its bar back');
  enabled = false;
  await patching.refreshPanels();
  eq(last('tab on X'), NO_BAR, 'Codex Plus turned off sends no bar either');
  enabled = true;
  await patching.refreshPanels();
  patching.removePatch(vscode);
  eq([last('tab on X'), last('tab on Y')], [NO_BAR, NO_BAR], 'removing the patch takes the bar out of the pages still open');
  for (const p of [onX, onY, fresh]) p.dispose();
  patching._approvals.clear();
  for (const d of context.subscriptions) { try { d.dispose(); } catch (_) { /* gone */ } }
  bars2.dispose();

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
  const core3 = coreWith({});
  const w = await activated(registerable({ features: core3.features, planSummary: core3.planSummary, onDidChangePlanSummary: core3.onDidChangePlanSummary,
    allConversations: () => [], onDidChangeAllConversations: () => ({ dispose() {} }) }), {});
  try {
    eq(core3.listeners.size, 1, 'once registered with an Agent Plus that offers it, Codex Plus listens for plan summaries, the setting being on by default');
    w.control.state.config.planBar = false;
    w.tell('planBar');
    eq([core3.listeners.size, core3.disposed], [0, 1], 'and stops when codexPlus.planBar is turned off');
    w.control.state.config.planBar = true;
    w.tell('planBar');
    eq(core3.listeners.size, 1, 'and starts again when it is turned back on');
    w.control.state.config.enabled = false;
    w.tell('enabled');
    eq(core3.listeners.size, 0, 'and Codex Plus turned off stops it as well');
  } finally { w.close(); }
  let threw = null, o = null;
  try {
    o = await activated(registerable({ features: ['allConversations', 'waitingFor'] }), {});
    o.tell('planBar');
  } catch (e) { threw = e; } finally { if (o) o.close(); }
  eq(threw, null, 'an older Agent Plus with no planSummary activates Codex Plus and takes the setting\'s changes with no error');
  await new Promise((r) => setTimeout(r, 50));
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
};
