// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Agent map's pill and dialog in Codex's page (src/page/codex-extras-page.js), on the stand-in DOM. The pill is green
 * while anything the conversation started still runs, red while a sub-agent waits for the user, and grey once it has
 * all ended; its label has one count per kind. The dialog lists that work in one section, each item a card with a green
 * dot. The host's side is test/parts/35x-agent-map-work.js.
 */
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const FLEX = { display: 'flex' }, CONTENTS = { display: 'contents' };
const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

/* Codex's toolbar row, as test/parts/61c-agent-map-page.js draws it. */
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
  return { dom, q, send(m) { listeners.message({ data: m }); } };
}

const BASE = { type: 'codex-extras-agent-map', shown: true, wakeups: [], goal: null, agents: [], detached: [], background: [], kinds: [], envelope: '✉️' };
const map = (o) => Object.assign({}, BASE, o);
const click = (e, extra = {}) => e.dispatch('click', Object.assign({ stopPropagation() {}, preventDefault() {} }, extra));
const now = Date.now();
const job = { pid: 4100, startMs: now - 60e3, cmd: 'python3 driver.py --all' };
const W = {
  command: { kind: 'command', pid: 11, startMs: now - 90e3, cmd: '/bin/bash -lc npm run watch', name: '', job: '' },
  codexExec: { kind: 'codexExec', pid: 40, startMs: now - 80e3, cmd: '/tmp/x/exts/openai.chatgpt-26.1117.41037-linux-x64/bin/linux-x86_64/codex exec --skip-git-repo-check Wait for the job.', name: '', job: '' },
  claudeWorker: { kind: 'claudeWorker', pid: 50, startMs: now - 70e3, cmd: 'claude -p go', name: 'night worker', job: '' },
  claudeBg: { kind: 'claudeBg', pid: 60, startMs: now - 50e3, cmd: '', name: 'night suite', job: 'abcd1234' },
};
const agent = (n, dot, extra) => Object.assign({ id: ID(n), name: `nick${n}`, title: `Sub ${n}`, dot, unseen: false, updatedMs: now }, extra);

module.exports = async ({ eq, root }) => {
  const p = page(root);
  p.send({ type: 'codex-extras-view', timestamps: true, navigation: false, userColor: '', userEdge: true });
  const pill = () => p.q('[data-codex-extras="agents"]')[0];
  const pillDot = () => { const d = pill() && pill().querySelectorAll('[data-codex-extras-dot]')[0]; return d ? d.getAttribute('data-codex-extras-dot') : ''; };
  const look = () => [!!pill(), pillDot(), pill() ? pill().textContent : ''];

  /* ── each kind alone ── */
  p.send(map({ detached: [job], kinds: ['detached'] }));
  eq(look(), [true, 'working', '1 detached'], 'a detached command alone shows the pill with a green dot');
  const cases = [
    ['command', '1 terminal', 'terminal'],
    ['codexExec', '1 codex exec', 'codex exec'],
    ['claudeWorker', '1 claude -p', 'claude -p'],
    ['claudeBg', '1 claude --bg', 'claude --bg'],
  ];
  for (const [kind, counted, word] of cases) {
    p.send(map({ background: [W[kind]], kinds: [kind] }));
    eq(look(), [true, 'working', counted], `${kind} alone shows the pill with a green dot, counted`);
    p.send(map({ kinds: [kind] }));
    eq(look(), [true, 'working', word], `${kind} known to run but not listed is named without a count`);
  }
  p.send(map({ detached: [job], background: [W.command, W.command, W.claudeWorker], kinds: ['command', 'detached', 'claudeWorker'],
    agents: [agent(3, 'stopped'), agent(4, 'stopped')], wakeups: [{ everyMinutes: 10, prompt: 'p', nextMs: now + 60e3, expiresMs: now + 9e6, paused: false }],
    goal: { status: 'paused', objective: 'Ship it', tokensUsed: 1, tokenBudget: 0 } }));
  eq(look(), [true, 'working', '2 agents · 1 detached · 2 terminals · 1 claude -p · 1 timer · goal paused'],
    'running work is counted after the agents and before the timers, as Claude Code Plus counts it');

  /* ── the pill's colour ── */
  p.send(map({ agents: [agent(3, 'working'), agent(4, 'waiting')] }));
  eq(pillDot(), 'waiting', 'a sub-agent waiting for the user makes it red');
  p.send(map({ agents: [agent(3, 'background')] }));
  eq(pillDot(), 'working', 'a sub-agent with only background work left keeps it green');
  p.send(map({ agents: [agent(3, 'stopped'), agent(4, 'unknown')] }));
  eq(pillDot(), 'idle', 'and once everything has ended it is grey');
  const style = () => { const d = pill().querySelectorAll('[data-codex-extras-dot]')[0]; return d ? d.style.cssText : ''; };
  const grey = style();
  p.send(map({ agents: [agent(3, 'waiting')] }));
  const red = style();
  p.send(map({ kinds: ['command'] }));
  const green = style();
  eq([/#22c55e/.test(green), /#ef4444/.test(red), /opacity:\s*\.4/.test(grey), /#3b82f6/.test(green + red + grey)], [true, true, true, false],
    'green, red and a dimmed grey, and no blue');

  /* ── the dialog ── */
  p.send(map({ detached: [job], background: [W.command, W.codexExec, W.claudeWorker, W.claudeBg], kinds: ['command', 'detached', 'codexExec', 'claudeWorker', 'claudeBg'],
    agents: [agent(3, 'working'), agent(4, 'background', { unseen: true }), agent(5, 'waiting'), agent(6, 'stopped', { unseen: true }), agent(7, 'unknown')] }));
  click(pill());
  const order = p.q('[data-codex-extras="agent-map"] [data-codex-extras^="map-"]').map((s) => s.getAttribute('data-codex-extras'))
    .filter((k) => /^map-(me|agents|work|wakeups|goal)$/.test(k));
  const workHead = p.q('[data-codex-extras="map-work"] [data-codex-extras-head]')[0];
  eq([order, workHead && workHead.getAttribute('data-codex-extras-head'), workHead && workHead.querySelectorAll('[data-codex-extras-count]')[0].textContent],
    [['map-me', 'map-agents', 'map-work'], 'Work left running', '5'],
    'the work left running is one section after the sub-agents, which Claude Code Plus splits into its background tasks, detached commands, '
    + 'claude -p and claude --bg sessions, with one count for all of it');
  const rows = p.q('[data-codex-extras="map-work"] [data-codex-extras="map-bg"]');
  eq(p.q('[data-codex-extras="map-work"] [data-codex-extras-card]').map((r) => r.getAttribute('data-codex-extras') + ' ' + (r.getAttribute('data-codex-extras-kind') || '')),
    ['map-job ', 'map-bg command', 'map-bg codexExec', 'map-bg claudeWorker', 'map-bg claudeBg'],
    'the detached commands first, then the rest of the work, oldest first');
  eq(rows.map((r) => (r.querySelectorAll('[data-codex-extras-dot]')[0] || { getAttribute: () => '' }).getAttribute('data-codex-extras-dot')),
    ['working', 'working', 'working', 'working'], 'each with a green dot');
  const lines = rows.map((r) => [(r.querySelectorAll('[data-codex-extras-name]')[0] || {}).textContent,
    ((r.querySelectorAll('[data-codex-extras-meta]')[0] || {}).textContent || '').replace(/ · started .*$/, ''), String(r.getAttribute('aria-label') || '').split('\n')[0].replace(/ · started .*$/, '')]);
  eq(lines, [['bash -lc npm run watch', 'background terminal · pid 11', '/bin/bash -lc npm run watch'],
    ['codex exec --skip-git-repo-check Wait for the job.', 'codex exec · pid 40',
      '/tmp/x/exts/openai.chatgpt-26.1117.41037-linux-x64/bin/linux-x86_64/codex exec --skip-git-repo-check Wait for the job.'],
    ['night worker', 'claude -p · pid 50', 'claude -p go'], ['night suite', 'claude --bg · job abcd1234 · pid 60', 'claude --bg · job abcd1234 · pid 60']],
  'a background terminal and a codex exec are titled by their command line, its program named by the last part of its path, a claude -p worker '
  + 'and a claude --bg session by their name, each over what it is, its pid and when it started, with the whole command line on hover, or the second '
  + 'line for a session that has none');
  const jobs = p.q('[data-codex-extras="map-work"] [data-codex-extras="map-job"]');
  eq(jobs.map((r) => (r.querySelectorAll('[data-codex-extras-dot]')[0] || { getAttribute: () => '' }).getAttribute('data-codex-extras-dot')), ['working'],
    'a detached command has the green dot too');
  const agents = p.q('[data-codex-extras="map-agent"]');
  const dots = agents.map((b) => b.querySelectorAll('[data-codex-extras-dot]')[0]);
  eq(dots.map((d) => (d ? d.getAttribute('data-codex-extras-dot') : '')), ['working', 'background', 'waiting', 'stopped', 'unknown'],
    'each sub-agent\'s dot is its own activity');
  eq(dots.map((d) => (d || { style: {} })).map((d) => [/#22c55e/.test(d.style.cssText) && !/border:/.test(d.style.cssText), /border:\s*2px solid #22c55e/.test(d.style.cssText),
    /#ef4444/.test(d.style.cssText), /width:\s*8px/.test(d.style.cssText) && /height:\s*8px/.test(d.style.cssText)]),
  [[true, false, false, true], [false, true, false, true], [false, false, true, true], [false, false, false, true], [false, false, false, true]],
  'green while working, a green ring for background work only, red while waiting, and none once stopped, each in a space of the same size');
  const marks = agents.map((b) => b.querySelectorAll('[data-codex-extras-unseen]')[0] || null);
  eq(marks.map((x) => (x ? x.textContent : '')), ['', '✉️', '', '✉️', ''], 'an unread reply puts the envelope the host chose after the name');
  const nameOf = (b) => b.querySelectorAll('[data-codex-extras-name]')[0];
  eq([!!nameOf(agents[1]), nameOf(agents[1]) && nameOf(agents[1]).textContent, marks[1] && marks[1].parentNode === nameOf(agents[1]).parentNode,
    marks[1] && /flex-shrink:\s*0/.test(marks[1].style.cssText)], [true, 'nick4', true, true],
  'beside the name rather than in it, so the name\'s ellipsis never cuts it off');
  click(pill());

  p.send(map({ kinds: [] }));
  eq(!!pill(), true, 'a map the host still sends shows the pill');
  p.send({ type: 'codex-extras-agent-map', shown: false, wakeups: [], goal: null, agents: [], detached: [], background: [], kinds: [] });
  eq(!!pill(), false, 'and once the host has nothing to show it goes');
};
