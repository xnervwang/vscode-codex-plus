// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Stamp wrapping and rail rows, following Claude Code Plus commits 3354c89, 302eed0 and 9fa2292. test/render checks the
 * same in Chromium.
 */
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const T1 = '019a6a10-0000-7000-8000-0000000000b1';
const T2 = '019a6a10-0000-7000-8000-0000000000b2';
const LONG = 'first question, which is long enough to be cut short in the list';

function pageUnder(root, dom) {
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: () => {} }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' } };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  return { send(m) { listeners.message({ data: m }); } };
}

module.exports = async ({ eq, root }) => {
  const NB = '\u00a0', SEP = `${NB}\u00b7 `, J = '\u2060';
  const day = new Date();
  day.setDate(day.getDate() - 1);
  const at = (h, m, s) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, s).getTime();
  const md = `${String(day.getMonth() + 1).padStart(2, '0')}/${String(day.getDate()).padStart(2, '0')}`;
  const pre = day.getFullYear() === new Date().getFullYear() ? md : `${day.getFullYear()}/${md}`;

  const dom = createDom();
  const { el } = dom;
  const userEl = (clock, words) => el('div', { attrs: { 'data-local-conversation-user-anchor': '', 'data-content-search-unit-key': 'u' },
    kids: [el('div', { attrs: { 'data-user-message-bubble': '' }, kids: [el('p', { texts: [words] })] }),
      el('div', { kids: [el('span', { kids: [el('span', { texts: [clock] })] })] })] });
  const replyEl = (clock) => el('div', { attrs: { 'data-response-annotation-target': '' }, kids: [
    el('h4', { attrs: { 'data-conversation-role': 'assistant' }, texts: ['Codex said'] }), el('p', { texts: ['an answer'] }),
    el('div', { kids: [el('span', { attrs: { 'data-assistant-message-sent-time': 'true' }, kids: [el('span', { texts: [clock] })] })] })] });
  const turnEl = (key, user, reply) => el('div', { attrs: { 'data-turn-key': key }, kids: [el('div', { attrs: { 'data-content-search-turn-key': key },
    kids: [el('div', { kids: [user, el('div', { attrs: { 'data-local-conversation-final-assistant': '' }, kids: [reply] })] })] })] });
  const u1 = userEl('10:35 PM', LONG), r1 = replyEl('10:35 PM');
  const u2 = userEl('10:36 PM', 'and a short one'), r2 = replyEl('10:36 PM');
  dom.setBody(el('body', { kids: [el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 600 }, kids: [
    turnEl(T1, u1, r1), turnEl(T2, u2, r2)] })] }));
  const page = pageUnder(root, dom);
  page.send({ type: 'codex-extras-view', timestamps: true, navigation: true, userEdge: true });
  page.send({ type: 'codex-extras-user-times', times: null, compactions: [],
    turns: { [T1]: 'ctx 12% · gpt-x low', [T2]: 'ctx 33% · gpt-6.1-sol high · skills web-fetching, disk-cleanup' },
    turnTimes: { [T1]: { u: [at(22, 35, 1)], r: [at(22, 35, 9)], d: 9400 }, [T2]: { u: [at(22, 36, 0)], r: [at(22, 36, 5)], d: 5200 } } });

  /* ── where a stamp may wrap ── */
  const stamp = (host) => host.children.find((k) => k.getAttribute('data-codex-extras') === 'stamp') || null;
  const said = (host) => { const s = stamp(host); return s ? s.textContent : null; };
  const line = (host) => { const s = stamp(host); return s ? s.getAttribute('data-codex-extras-figures') : null; };
  eq([said(u1), said(r1)], [`${pre}${NB}22:35:01`, `${pre}${NB}22:35:09`],
    'a stamp from another day keeps its date and its time together with a no-break space');
  eq(line(r1), `  9s${SEP}ctx${NB}12%${SEP}gpt-${J}x${NB}low`,
    'a reply\'s line can break only after a "·", which stays at the end of the line, and at the gap after the time; "ctx 12%" and the model with its effort '
      + 'stay whole, a word joiner after each hyphen keeping the browser from breaking there');
  eq(line(r2), `  5s${SEP}ctx${NB}33%${SEP}gpt-${J}6.1-${J}sol${NB}high${SEP}skills${NB}web-${J}fetching, disk-${J}cleanup`,
    'a list of skills can also break between two of them, so a long one does not have to break inside a name');
  const sheet = () => (dom.document.head.children.find((k) => k.getAttribute('data-codex-extras') === 'style') || {}).textContent || '';
  eq(/\.codex-extras-stamp\{[^}]*white-space:normal;overflow-wrap:anywhere;/.test(sheet()), true,
    'the stamp wraps at those spaces, with white-space normal, so the two spaces after the time are not kept as they would be under '
      + 'a pre-wrap message, and breaks inside a part only when that part alone is wider than the column');

  /* ── the rail's list ── */
  const rows = dom.document.root.querySelectorAll('[data-codex-extras="nav-row"]');
  const time = (r) => r.children[0] || null;
  eq(rows.map((r) => r.textContent), [`${pre} 22:35:01  ${LONG.slice(0, 44)}\u2026`, `${pre} 22:36:00  and a short one`],
    'a row is its time, two spaces and its words, and words cut at 44 characters end in an ellipsis');
  eq(rows.map((r) => [time(r) && time(r).tagName, time(r) && time(r).textContent, time(r) && time(r).style.fontVariantNumeric,
    time(r) && time(r).style.fontKerning]), [['SPAN', `${pre} 22:35:01`, 'tabular-nums', 'none'], ['SPAN', `${pre} 22:36:00`, 'tabular-nums', 'none']],
  'its time is a span of its own with digits of one width and no kerning, so the words of every row start at the same place');
};
