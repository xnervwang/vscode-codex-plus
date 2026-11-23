// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Agent map in Codex's page (src/page/codex-extras-page.js), on the stand-in DOM: Claude Code's pill, shown next to
 * this script's other controls while the conversation has a wake-up, a goal or a sub-agent, and the dialog it opens:
 * the conversation's own row first under a heading of its own, then a section for each of the three under a heading
 * with its count, leaving out any that is empty, each row a card of two lines. Each button sends one of the ACTIONS in
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
  const trigger = el('button', { attrs: { type: 'button', 'data-composer-navigation-target': 'reasoning', 'data-selected-reasoning-effort': 'medium' }, rect: { top: 708, left: 819, width: 121, height: 28 }, texts: ['5.5 Medium'] });
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
  return { dom, win, right, modelSlot, posted, q, send(m) { listeners.message({ data: m }); } };
}

const MAP = {
  type: 'codex-extras-agent-map', shown: true, me: { title: 'Find where the retry delay is set', dot: 'background' },
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
    .filter((k) => /^map-(me|agents|work|wakeups|goal)$/.test(k));
  eq([!!dlg(), p.q('[data-codex-extras="map-dialog"] h3')[0].textContent, sections(), p.dom.waiting() <= waiting],
    [true, 'Agent map', ['map-me', 'map-agents', 'map-wakeups', 'map-goal'], true],
    'a click opens the Agent map with the conversation\'s own row first, then a section each for the sub-agents, the wake-up and the goal, '
    + 'in Claude Code Plus\'s order, and starts no timer');
  const heads = () => p.q('[data-codex-extras="map-dialog"] [data-codex-extras-head]').map((h) => {
    const label = h.childNodes[0], count = h.querySelectorAll('[data-codex-extras-count]')[0];
    return [h.getAttribute('data-codex-extras-head'), count ? count.textContent : null, /text-transform:\s*uppercase/.test(label.style.cssText),
      /border-top:\s*1px solid/.test(h.style.cssText) && !/border-top:\s*0/.test(h.style.cssText)];
  });
  eq(heads(), [['This conversation', null, true, false], ['Sub-agents', '2', true, true], ['Wake-ups', '1', true, true], ['Goal', '1', true, true]],
    'each section has a heading in capitals with a count beside it and a thin line above it; the conversation\'s own heading has neither');
  const section = (k) => p.q(`[data-codex-extras="${k}"]`)[0];
  eq(sections().map((k) => section(k).childNodes[0].getAttribute('data-codex-extras-head') !== null), [true, true, true, true],
    'and each heading is the first thing in its section');
  const card = (k) => {
    const c = p.q(`[data-codex-extras="${k}"] [data-codex-extras-card]`)[0];
    const one = (sel) => (c.querySelectorAll(sel)[0] || { textContent: null }).textContent;
    return c && [c.getAttribute('data-codex-extras-card'), c.tagName.toLowerCase(), one('[data-codex-extras-name]'), one('[data-codex-extras-meta]'),
      (c.querySelectorAll('[data-codex-extras-dot]')[0] || { getAttribute: () => '' }).getAttribute('data-codex-extras-dot')];
  };
  eq(card('map-me'), ['me', 'div', 'Find where the retry delay is set', 'm · 1.0k tokens in context', 'background'],
    'the conversation\'s own card has its title and the dot its tab has, and under it the model and the context in use, as the meter has them');
  p.send({ type: 'codex-extras-usage', usage: { used: 57700, window: 400000, line: 378947, lineFrom: 'default', model: 'openai.gpt-6.1-sol', effort: 'ultra', total: null } });
  eq(card('map-me')[3], 'gpt-6.1-sol · 57.7k tokens in context', 'with the model named the way the reply stamps name it, without the provider in front, and redrawn as the figures change');
  p.send({ type: 'codex-extras-usage', usage: { used: 1000, window: 400000, line: 378947, lineFrom: 'default', model: 'm', effort: 'low', total: null } });
  const text = (sel) => (p.q(sel)[0] || { textContent: '' }).textContent;
  const wake = card('map-wakeups');
  eq([wake.slice(0, 3), /^every 10 min · next (\d\d\/\d\d )?\d\d:\d\d · until (\d\d\/\d\d )?\d\d:\d\d$/.test(wake[3]), wake[4],
    text('[data-codex-extras="map-wakeups"] pre'), card('map-goal'),
    p.q('[data-codex-extras="map-goal"] [data-codex-extras="map-act"]').map((b) => b.textContent)],
  [['wakeup', 'summary', 'Keep going with the open rows.'], true, 'idle', 'Keep going with the open rows.',
    ['goal', 'summary', 'Make the export skip archived rows', 'paused · 120,000 of 1,000,000 tokens', 'idle'], ['Resume', 'Clear']],
  'the wake-up\'s card is its prompt\'s first line over how often, when next and until when, and opens to the prompt; the goal\'s its first '
  + 'line over its state and its tokens, with Resume and Clear for a paused one; both with a grey dot, as Claude Code Plus\'s scheduled prompts');
  const hover = (el) => { el.dispatch('mouseenter', {}); const l = p.q('[data-codex-extras="map-label"]')[0]; const t = l ? l.textContent : null; el.dispatch('mouseleave', {}); return t; };
  const overlayZ = Number((/z-index:\s*(\d+)/.exec(dlg().style.cssText) || [])[1]);
  p.q('[data-codex-extras="map-wakeups"] [data-codex-extras-card]')[0].dispatch('mouseenter', {});
  const label = p.q('[data-codex-extras="map-label"]')[0];
  eq([label ? label.textContent : null, label && Number((/z-index:\s*(\d+)/.exec(label.style.cssText) || [])[1]) > overlayZ],
    [wake[3], true], 'a card\'s hover text ends with its second line, which a narrow side bar cuts short, and is drawn above the map\'s overlay');
  p.q('[data-codex-extras="map-wakeups"] [data-codex-extras-card]')[0].dispatch('mouseleave', {});
  eq(/idle/.test(hover(p.q('[data-codex-extras="map-wakeups"] [data-codex-extras-head]')[0]) || ''), true, 'and a heading\'s says what the section lists');
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
  eq([pill().textContent, card('map-goal').slice(2, 4),
    p.q('[data-codex-extras="map-goal"] [data-codex-extras="map-act"]').map((b) => [b.textContent, b.getAttribute('data-codex-extras-act')])],
  ['2 agents · 1 timer · goal', ['Make the export skip archived rows', 'in progress · 120,000 of 1,000,000 tokens'], [['Pause', 'pauseGoal'], ['Clear', 'clearGoal']]],
  'a running goal says so, with Pause and Clear');
  click(pill());

  const started = Date.now() - 4 * 60e3;
  const long = 'python3 -I scripts/driver.py --suite nightly ' + 'x'.repeat(120);
  p.send(Object.assign({}, MAP, { detached: [{ pid: 4100, startMs: started, cmd: long }, { pid: 4200, startMs: 0, cmd: 'make release' }] }));
  eq(pill().textContent, '2 agents · 2 detached · 1 timer · goal paused', 'detached commands are counted in the pill, after the agents and before the timers');
  click(pill());
  const jobRows = p.q('[data-codex-extras="map-work"] [data-codex-extras="map-job"]');
  const cmdOf = (r) => r.querySelectorAll('[data-codex-extras-name]')[0], metaOf = (r) => r.querySelectorAll('[data-codex-extras-meta]')[0].textContent;
  eq([sections(), heads().map((h) => h.slice(0, 2)).find((h) => h[0] === 'Work left running'), jobRows.length, cmdOf(jobRows[0]).textContent.length,
    String(jobRows[0].getAttribute('aria-label')).split('\n')[0], /^detached · pid 4100 · started (\d\d\/\d\d )?\d\d:\d\d, 4m ago$/.test(metaOf(jobRows[0])), metaOf(jobRows[1])],
  [['map-me', 'map-agents', 'map-work', 'map-wakeups', 'map-goal'], ['Work left running', '2'], 2, 120, long, true, 'detached · pid 4200'],
  'the detached commands go in a section of the work left running, after the sub-agents and before the wake-up, each a card of its command line, '
  + 'cut to 120 characters with the whole of it on hover, over its pid and when it started');
  click(pill());

  p.send(Object.assign({}, MAP, { goal: null, agents: [], wakeups: MAP.wakeups }));
  eq(pill().textContent, '1 timer', 'with only a wake-up the pill says so, rather than 0 agents');
  click(pill());
  eq([sections(), p.q('[data-codex-extras="agent-map"] [data-codex-extras-act]').map((b) => b.getAttribute('data-codex-extras-act')),
    /goal/i.test(dlg() ? dlg().textContent : '')], [['map-me', 'map-wakeups'], ['removeWakeup'], false],
  'empty sections are left out: with no goal the dialog has no goal section and no button that sets one');
  p.send({ type: 'codex-extras-agent-map', shown: false, wakeups: [], goal: null, agents: [] });
  eq([!!pill(), !!dlg()], [false, false], 'once there is nothing to show the pill goes, and an open dialog with it');

  {
    /* The overlay's flex box can leave the dialog between pixels. The stand-in DOM gives every element made from here on
       the same box, a fraction of a pixel off on both axes, so the dialog is measured where the overlay put it. */
    const s = page(root);
    s.send({ type: 'codex-extras-view', timestamps: true, navigation: false, userColor: '', userEdge: true });
    s.send(MAP);
    const make = s.dom.document.createElement.bind(s.dom.document);
    s.dom.document.createElement = (tag) => {
      const e = make(tag);
      e.rect = { top: 100.4, left: 50.75, width: 320, height: 146 };
      return e;
    };
    click(s.q('[data-codex-extras="agents"]')[0]);
    const d = s.q('[data-codex-extras="map-dialog"]')[0];
    const at = () => [d.rect.left + parseFloat(d.style.left || '0'), d.rect.top + parseFloat(d.style.top || '0')];
    const whole = (v, scale) => Math.abs(v * scale - Math.round(v * scale)) < 1e-9;
    const first = at();
    s.win.devicePixelRatio = 2;
    s.send(MAP);
    const second = at();
    eq([whole(first[0], 1), whole(first[1], 1), Math.round(first[0]), Math.round(first[1]), whole(second[1], 2), Math.round(second[1] * 2)],
      [true, true, 51, 100, true, 201],
      'the dialog is moved by the fraction onto whole pixels, the nearest ones, and onto whole device pixels on a screen with two per pixel');
  }

  {
    /* Turning the switch on while the pointer rests on one of this script's controls: the view comes first and puts the
       other controls back in the row, then the map arrives. The pill is put in all the same; nothing already there moves. */
    const s = page(root);
    const view = (buttons) => s.send({ type: 'codex-extras-view', timestamps: true, navigation: false, userColor: '', userEdge: true, buttons });
    const usage = { used: 251000, window: 400000, line: 378947, lineFrom: 'default', model: 'gpt-6.1-sol', effort: 'medium', windowFrom: null,
      total: { input: 1200000, cached: 980000, output: 45000, reasoning: 12000, total: 1245000 } };
    s.send({ type: 'codex-extras-usage', usage });
    view(true);
    s.send(MAP);
    view(false);
    s.send({ type: 'codex-extras-agent-map', shown: false, wakeups: [], goal: null, agents: [] });
    view(true);
    const meter = s.q('[data-codex-extras="meter"]')[0];
    meter.dispatch('mouseenter', {});
    s.send(MAP);
    const back = s.q('[data-codex-extras="agents"]')[0];
    eq([!!back, back && back.parentNode === s.right, back && back.nextElementSibling === s.modelSlot, meter.isConnected && meter.nextElementSibling === back],
      [true, true, true, true],
      'a map that arrives while the pointer is on the meter still puts the pill in the row, after the meter, which stays where it was');
  }
};
