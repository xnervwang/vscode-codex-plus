// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The page's side of "waiting for your permission": the real file src/page/codex-extras-page.js run in a stand-in
 * page (test/fake-dom.js) built the way a Codex conversation is built, with an activity root holding both the element
 * the conversation scrolls and the area above the message box, which is where an approval card is drawn.
 *
 * Three things have to hold for any of it to work, so each has a check here:
 *
 *   - the selector is Codex's own, `:not()` and all, so a card on a shell page that is not in front is not reported;
 *   - the observer is on the activity root and not on the scroller, since the card appears outside the scroller and an
 *     observer down there would never see it;
 *   - it is not dropped while the page is hidden, which is when a tab in the background needs it.
 *
 * The page holds what a real approval card would hold, namely the command, the reason and a thread id, and each is
 * searched for in everything the page posted, since all the page may send is a flag.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const SECRETS = {
  'command text': 'tar -cf - /srv/data | ssh elsewhere.invalid cat',
  'reason text': 'this writes outside the workspace',
  'file path': '/home/someone/.ssh/config',
  'thread id': '01a1b8f2-fd2b-7e60-9ffc-16e5cb642e31',
};

/** The real page script in a stand-in page, with the page's messages to the host read back. */
function pageUnder(root, dom) {
  const posted = [];
  const win = {
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }),
    addEventListener: () => {},
    location: { pathname: '/index.html', hash: '' },
  };
  const ctx = vm.createContext(Object.assign({ globalThis: win }, dom.sandbox));
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'page', 'codex-extras-page.js'), 'utf8'), ctx);
  return { posted, flags: () => posted.filter((m) => m.kind === 'approval').map((m) => m.on) };
}

/*
 * A conversation as Codex lays one out: the activity root around everything, the scroller inside it, and beside the
 * scroller the area the approval card goes into - which is why the card is not in the scroller's subtree.
 */
function layout(dom) {
  const { el } = dom;
  const scroller = el('div', { class: 'thread-scroll-container', attrs: { 'data-app-action-timeline-scroll': '' },
    kids: [el('div', { attrs: { 'data-turn-key': 't1' } })] });
  const aboveComposer = el('div', { attrs: { 'data-above-composer-portal': '' } });
  const composer = el('div', { attrs: { 'data-codex-composer': '' } });
  const activity = el('div', { class: 'thread-scroll-layout', attrs: { 'data-request-input-activity-root': '' },
    kids: [scroller, aboveComposer, composer] });
  const body = el('body', { class: 'vscode-dark', kids: [el('div', { attrs: { 'data-app-shell': '' }, kids: [activity] })] });
  dom.setBody(body);
  return { activity, scroller, aboveComposer, body };
}

/** An approval card as Codex draws one: the attribute it marks it with, and what such a card holds. */
function approvalCard(dom) {
  const { el } = dom;
  return el('div', { class: '@container/approval-card rounded-3xl border border-default',
    attrs: { 'data-codex-approval-surface': 'true' },
    kids: [
      el('div', { class: 'min-w-0 flex-1', attrs: { role: 'alert', 'aria-atomic': 'true' },
        texts: [SECRETS['command text']] }),
      el('div', { attrs: { 'data-conversation-id': SECRETS['thread id'] }, texts: [SECRETS['reason text']] }),
      el('code', { texts: [SECRETS['file path']] }),
      el('button', { texts: ['Allow once'] }),
      el('button', { texts: ['Deny'] }),
    ] });
}

/** Let the page see the changes made since the last one, and run its debounce out. */
function settle(dom) {
  dom.fire(dom.takeMutations());
  dom.runTimers();
}

/** The live observer watching the activity root, which is the approval one. */
function approvalObserver(dom) {
  return dom.live().find((o) => o.targets.some(({ target }) => target && target.getAttribute
    && target.getAttribute('data-request-input-activity-root') !== null)) || null;
}

module.exports = async ({ ok, bad, eq, root }) => {
  /* ── the selector is Codex's own, and the harness reads all of it ── */
  const probe = createDom();
  const CODEX_SEL = '[data-codex-approval-surface]:not([data-app-shell-active-page="false"] *)';
  {
    const { el } = probe;
    const inFront = el('div', { attrs: { 'data-codex-approval-surface': 'true' } });
    const behind = el('div', { attrs: { 'data-codex-approval-surface': 'true' } });
    const page = el('div', { attrs: { 'data-app-shell-active-page': 'false' }, kids: [el('div', { kids: [behind] })] });
    probe.setBody(el('body', { kids: [el('div', { kids: [inFront] }), page] }));
    eq([probe.document.querySelectorAll(CODEX_SEL).length, probe.document.querySelector(CODEX_SEL) === inFront],
      [1, true], 'Codex\'s own selector picks the card on the page in front and leaves the one on a shell page that is not');
    eq(probe.document.querySelectorAll('[data-codex-approval-surface]').length, 2,
      'and without the :not() both would be picked, which is what that part of it is there for');
  }

  /* ── the page reports the card, and only when it changes ── */
  const dom = createDom();
  const page = pageUnder(root, dom);
  const built = layout(dom);
  eq(page.flags(), [], 'a page whose body is not built yet says nothing about an approval card');
  dom.document.dispatch('DOMContentLoaded');
  eq(page.flags(), [false], 'once the page is up it says there is none, so the host has a definite answer rather than silence');

  const card = approvalCard(dom);
  built.aboveComposer.appendChild(card);
  settle(dom);
  eq(page.flags(), [false, true], 'a card appearing above the message box is reported');
  settle(dom);
  eq(page.flags(), [false, true], 'and a pass that finds the same card again says nothing a second time');
  card.remove();
  settle(dom);
  eq(page.flags(), [false, true, false], 'the card going away is reported too');

  /* ── where the observer is, which is the whole reason this is not the marks observer ── */
  const watching = approvalObserver(dom);
  if (!watching) { bad('no observer is watching the activity root, so no card appearing would ever be seen'); return; }
  ok('the observer is on the activity root, which holds both the scroller and the area the card is drawn in');
  eq(watching.targets.map(({ target }) => target === built.scroller || target === built.body), [false],
    'and not on the element the conversation scrolls, whose subtree the card is outside of, nor on the whole body');
  eq(built.scroller.querySelectorAll('[data-codex-approval-surface]').length, 0,
    'which matters because a card really is outside the scroller: looking there finds nothing');

  /* ── hidden pages keep watching, since that is the case this is for ── */
  dom.document.hidden = true;
  dom.document.dispatch('visibilitychange');
  eq(!!approvalObserver(dom), true, 'a page going into the background keeps watching for a card');
  built.aboveComposer.appendChild(approvalCard(dom));
  settle(dom);
  eq(page.flags(), [false, true, false, true],
    'so a card that appears while the tab is in the background is still reported, which is when being told matters most');
  dom.document.hidden = false;
  dom.document.dispatch('visibilitychange');

  /* ── nothing of the conversation leaves the page ── */
  const whole = JSON.stringify(page.posted);
  for (const [what, value] of Object.entries(SECRETS)) {
    if (whole.includes(value)) bad(`the page sent ${what}`);
    else ok(`the page sent no ${what}`);
  }
  eq(page.posted.filter((m) => m.kind === 'approval').every((m) => Object.keys(m).sort().join(',') === 'kind,on,type'
    && typeof m.on === 'boolean'), true,
  'every approval message is a flag and nothing else: its type, its kind, and true or false');
};
