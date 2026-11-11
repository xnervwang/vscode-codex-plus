// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Agent map in Codex's page (src/page/codex-extras-page.js), on the stand-in DOM: Claude Code's pill, shown next to
 * this script's other controls while the conversation has a wake-up, a goal or a sub-agent, and the dialog it opens,
 * which has a section for each of the three and leaves out any that is empty. Each button sends one of the ACTIONS in
 * src/agent-map.js. The render check covers sizes, colours and where the pill ends up in a drawn page.
 */
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const FLEX = { display: 'flex' }, CONTENTS = { display: 'contents' };
const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

/* Codex's toolbar row, as test/parts/61b-context-meter.js draws it. */
function page(root) {
  const dom = createDom();
  const { el } = dom;
  const add = el('button', { attrs: { type: 'button', 'data-composer-navigation-target': 'add-context' }, rect: { top: 708, left: 16, width: 28, height: 28 } });
  const perm = el('button', { attrs: { type: 'button', 'data-composer-navigation-target': 'permissions' }, rect: { top: 708, left: 49, width: 119, height: 28 } });
  const left = el('div', { computed: FLEX, rect: { top: 708, left: 16, width: 152, height: 28 }, kids: [el('span', { computed: CONTENTS, kids: [add] }), perm] });
  const trigger = el('button', { attrs: { type: 'button', 'data-composer-navigation-target': 'reasoning', 'data-selected-reasoning-effort': 'medium' }, rect: { top: 708, left: 819, width: 121, height: 28 } });
  const modelSlot = el('span', { rect: { top: 708, left: 799, width: 121, height: 28 }, kids: [el('span', { computed: CONTENTS, kids: [trigger] })] });
  const right = el('div', { computed: FLEX, rect: { top: 708, left: 799, width: 250, height: 28 }, kids: [modelSlot] });
  const grid = el('div', { attrs: { 'data-composer-footer-responsive': '' }, kids: [el('div', { kids: [left] }), el('div', { kids: [right] })] });
  const box = el('div', { attrs: { 'data-codex-composer-root': '' }, rect: { top: 602, left: 8, width: 1084, height: 142 }, kids: [grid] });
  dom.setBody(dom.el('body', { kids: [box] }));
  const posted = [];
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerHeight: 760, innerWidth: 1100 };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const q = (sel) => dom.document.root.querySelectorAll(sel);
  return { dom, right, modelSlot, posted, q, send(m) { listeners.message({ data: m }); } };
}

const MAP = {
  type: 'codex-extras-agent-map', shown: true,
  wakeups: [{ everyMinutes: 10, prompt: 'Keep going with the open rows.', nextMs: Date.UTC(2026, 10, 10, 18, 40), expiresMs: Date.UTC(2026, 10, 17, 18), paused: false }],
  goal: { status: 'paused', objective: 'Make the export skip archived rows\nand say how many it skipped', tokensUsed: 120000, tokenBudget: 1000000 },
  agents: [{ id: ID(4), name: 'Fix the test', title: 'Fix the test', dot: 'unknown', updatedMs: Date.now() - 3 * 60e3 },
    { id: ID(3), name: 'scout', title: 'Look for the retry delay', dot: 'working', updatedMs: Date.now() }],
};
const click = (e, extra = {}) => e.dispatch('click', Object.assign({ stopPropagation() {}, preventDefault() {} }, extra));

module.exports = async ({ eq, root }) => {
  const p = page(root);
  p.send({ type: 'codex-extras-view', timestamps: true, navigation: false, userColor: '', userEdge: true });
  const pill = () => p.q('[data-codex-extras="agents"]')[0];
  eq(!!pill(), false, 'with no map from the host there is no Agent map button');
  p.send(MAP);
  eq([!!pill(), pill() && pill().parentNode === p.right, pill() && pill().nextElementSibling === p.modelSlot, pill() && pill().textContent],
    [true, true, true, '2 agents · 1 timer · goal paused'],
    'the pill goes into Codex\'s toolbar row with this script\'s other controls, labelled as Claude Code Plus labels it');
  eq((pill().querySelectorAll('[data-codex-extras-dot]')[0] || { getAttribute: () => '' }).getAttribute('data-codex-extras-dot'), 'working',
    'and its dot follows the agents, as Claude Code\'s does');
  p.send({ type: 'codex-extras-usage', usage: { used: 1000, window: 400000, line: 378947, lineFrom: 'default', model: 'm', effort: 'low', total: null } });
  const meter = p.q('[data-codex-extras="meter"]')[0];
  eq([!!meter, meter && meter.nextElementSibling === pill(), pill().nextElementSibling === p.modelSlot], [true, true, true],
    'with the context meter drawn too, the pill stands just right of it and before the model picker, as Claude Code\'s pill follows its meter');

  const waiting = p.dom.waiting();
  click(pill());
  const dlg = () => p.q('[data-codex-extras="agent-map"]')[0];
  const sections = () => p.q('[data-codex-extras="agent-map"] [data-codex-extras^="map-"]').map((s) => s.getAttribute('data-codex-extras'))
    .filter((k) => /^map-(wakeups|goal|agents)$/.test(k));
  eq([!!dlg(), p.q('[data-codex-extras="map-dialog"] h3')[0].textContent, sections(), p.dom.waiting() <= waiting],
    [true, 'Agent map', ['map-wakeups', 'map-goal', 'map-agents'], true],
    'a click opens the Agent map with a section each for the wake-up, the goal and the sub-agents, and starts no timer');
  const text = (sel) => (p.q(sel)[0] || { textContent: '' }).textContent;
  eq([/^every 10 min · next (\d\d\/\d\d )?\d\d:\d\d · until (\d\d\/\d\d )?\d\d:\d\d$/.test(text('[data-codex-extras="map-wakeups"] summary')),
    text('[data-codex-extras="map-wakeups"] pre'), text('[data-codex-extras="map-goal"] summary'),
    p.q('[data-codex-extras="map-goal"] [data-codex-extras="map-act"]').map((b) => b.textContent)],
  [true, 'Keep going with the open rows.', 'Make the export skip archived rows · paused · 120,000 of 1,000,000 tokens', ['Resume', 'Clear']],
  'the wake-up says how often, when next and until when, with its prompt under it; the goal its state and its tokens, with Resume and Clear for a paused one');
  eq(p.q('[data-codex-extras="map-agent"]').map((b) => [b.getAttribute('data-codex-extras-id'), b.textContent.slice(0, 12)]),
    [[ID(4), 'Fix the test'], [ID(3), 'scoutactive ']], 'each sub-agent is a row with its name and when it was last active');
  p.posted.length = 0;
  click(p.q('[data-codex-extras="map-wakeups"] [data-codex-extras="map-act"]')[0]);
  click(p.q('[data-codex-extras="map-goal"] [data-codex-extras-act="resumeGoal"]')[0]);
  click(p.q('[data-codex-extras="map-goal"] [data-codex-extras-act="resumeGoal"]')[0]);
  eq(p.posted.map((m) => [m.kind, m.action, m.id]), [['agentMap', 'removeWakeup', ''], ['agentMap', 'resumeGoal', '']],
    'Remove and Resume each send their word once, however often they are clicked');
  p.posted.length = 0;
  click(p.q('[data-codex-extras="map-agent"]')[1]);
  eq([p.posted.map((m) => [m.action, m.id]), !!dlg()], [[['openAgent', ID(3)]], false], 'a sub-agent clicked is opened in a tab, and the dialog closes');

  click(pill());
  p.dom.document.dispatch('keydown', { key: 'Escape', stopPropagation() {}, preventDefault() {} });
  eq([!!dlg(), p.q('[data-codex-extras="map-dialog"]').length], [false, 0], 'Esc closes it, wherever the focus is, and takes it off the page');
  click(pill());
  click(dlg(), { target: dlg() });
  eq(!!dlg(), false, 'and so does a click outside it');

  p.send(Object.assign({}, MAP, { goal: Object.assign({}, MAP.goal, { status: 'active' }) }));
  click(pill());
  eq([pill().textContent, text('[data-codex-extras="map-goal"] summary'),
    p.q('[data-codex-extras="map-goal"] [data-codex-extras="map-act"]').map((b) => [b.textContent, b.getAttribute('data-codex-extras-act')])],
  ['2 agents · 1 timer · goal', 'Make the export skip archived rows · in progress · 120,000 of 1,000,000 tokens', [['Pause', 'pauseGoal'], ['Clear', 'clearGoal']]],
  'a running goal says so, with Pause and Clear');
  click(pill());

  p.send(Object.assign({}, MAP, { goal: null, agents: [], wakeups: MAP.wakeups }));
  eq(pill().textContent, '1 timer', 'with only a wake-up the pill says so, rather than 0 agents');
  click(pill());
  eq([sections(), p.q('[data-codex-extras="agent-map"] [data-codex-extras-act]').map((b) => b.getAttribute('data-codex-extras-act')),
    /goal/i.test(dlg() ? dlg().textContent : '')], [['map-wakeups'], ['removeWakeup'], false],
  'empty sections are left out: with no goal the dialog has no goal section and no button that sets one');
  p.send({ type: 'codex-extras-agent-map', shown: false, wakeups: [], goal: null, agents: [] });
  eq([!!pill(), !!dlg()], [false, false], 'once there is nothing to show the pill goes, and an open dialog with it');
};
