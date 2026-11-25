// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The page clicks Retry for the user on Codex's notice that a conversation is open in another app
 * (src/page/codex-extras-page.js conflictNotice), and the host logs what the page reports about it (src/patching.js
 * writerConflictLine).
 *
 * The notice carries the props React would keep on it, in the shape Codex's writer conflict component passes them: its
 * callout gets the title element with the message id and the Retry handler, and the component above it the conversation
 * id. The timers are stepped one at a time, which stands in for the seconds between retries.
 */
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

function pageUnder(root, dom) {
  const posted = [];
  const win = {
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }),
    addEventListener: () => {},
    location: { pathname: '/index.html', hash: '' },
  };
  const ctx = vm.createContext(Object.assign({ globalThis: win }, dom.sandbox));
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), ctx);
  return { conflicts: () => posted.filter((m) => m.kind === 'writerConflict').map((m) => [m.event, m.thread, m.tries]) };
}

module.exports = async ({ eq, root }) => {
  const patching = require(path.join(root, 'src', 'patching.js'));
  const dom = createDom();
  let clicks = 0, disabled = false;
  /* An alert with the fiber chain of Codex's notice: the element's own fiber, the callout, then the component. */
  const notice = (title = 'localConversation.writerConflict.title', thread = '01a2-thread') => {
    const e = dom.el('div', { attrs: { role: 'alert' }, texts: ['This is open in another app'] });
    const component = { memoizedProps: { forkConversationId: thread, isResuming: false, onRetry: () => { clicks++; } }, return: null };
    const callout = { memoizedProps: { layout: 'warningCallout', role: 'alert', title: { props: { id: title, defaultMessage: 'This is open in another app' } },
      get isPrimaryCtaDisabled() { return disabled; }, onPrimaryCtaClick: () => { clicks++; } }, return: component };
    e['__reactFiber$test'] = { stateNode: e, memoizedProps: { role: 'alert' }, return: callout };
    return e;
  };
  const holder = dom.el('div');
  dom.setBody(dom.el('body', { kids: [holder] }));
  const page = pageUnder(root, dom);
  /* The approval watcher starts first and watches the body as well; this one is the last to start. */
  const observer = dom.live().filter((o) => o.targets.some((t) => t.target === dom.document.body && t.options.subtree)).pop();
  const show = (el) => { while (holder.firstChild) holder.removeChild(holder.firstChild); if (el) holder.appendChild(el); observer.fn([]); };
  /* Runs the debounce and then `n` of the waits between retries. */
  const step = (n = 1) => { dom.runTimers(); for (let i = 0; i < n; i++) dom.runTimers(); };

  eq(!!observer, true, 'the page watches its whole body for the notice from the start');

  show(dom.el('div', { attrs: { role: 'alert' }, texts: ['Something else went wrong'] }));
  step(3);
  eq([clicks, page.conflicts()], [0, []], 'an alert that is not the notice is left alone');
  const other = notice('localConversation.resumeFailed.title');
  show(other);
  step(3);
  eq(clicks, 0, 'an alert whose title has another message id is left alone too');

  show(notice());
  dom.runTimers();
  eq([clicks, dom.waiting()], [0, 1], 'the first retry waits a few seconds after the notice appears');
  dom.runTimers();
  eq([clicks, page.conflicts()], [1, [['retrying', '01a2-thread', 0]]], 'after those seconds Retry is clicked, and the host is told the retries started');
  disabled = true;
  dom.runTimers();
  eq(clicks, 1, 'Retry is not clicked while Codex has it disabled, and such a step does not count');
  disabled = false;
  dom.runTimers();
  dom.runTimers();
  eq(clicks, 3, 'then it is clicked again at each step');

  show(null);
  dom.runTimers();
  eq([clicks, page.conflicts().length], [3, 1], 'one step without the notice does not count as gone: the notice goes away for a moment each time Codex retries');
  dom.runTimers();
  eq([clicks, page.conflicts().slice(1), dom.waiting()], [3, [['cleared', '01a2-thread', 3]], 0],
    'after two steps without it, the host is told the notice went away after three clicks, and nothing more is scheduled');

  show(notice());
  step(30);
  eq([clicks - 3, page.conflicts().slice(2), dom.waiting()], [24, [['retrying', '01a2-thread', 0], ['stopped', '01a2-thread', 24]], 0],
    'a notice that comes back starts afresh; after 24 clicks it is left for the user and the host is told');
  observer.fn([]);
  step(3);
  eq(clicks - 3, 24, 'more changes to the page do not start it again while that notice stays');

  show(notice(undefined, '01a3-other'));
  step(1);
  eq([clicks - 27, page.conflicts().slice(4)], [1, [['retrying', '01a3-other', 0]]], 'a notice about another conversation starts afresh');
  show(null);
  step(2);
  show(notice());
  step(1);
  eq(page.conflicts().slice(-2), [['cleared', '01a3-other', 1], ['retrying', '01a2-thread', 0]], 'a notice after the last one went away starts afresh too');

  /* "Couldn't load messages", which the conflict also leaves behind. */
  {
    const d = createDom();
    let conflictClicks = 0, historyClicks = 0;
    const alertEl = (text, callout) => {
      const e = d.el('div', { attrs: { role: 'alert' }, texts: [text] });
      e['__reactFiber$test'] = { stateNode: e, memoizedProps: { role: 'alert' }, return: callout };
      return e;
    };
    const conflictEl = () => alertEl('This is open in another app', { memoizedProps: { title: { props: { id: 'localConversation.writerConflict.title' } },
      onPrimaryCtaClick: () => { conflictClicks++; } }, return: { memoizedProps: { forkConversationId: '01a2-thread' }, return: null } });
    const historyEl = () => alertEl('Couldn\'t load messages', { memoizedProps: { layout: 'warningCallout',
      content: { props: { className: 'select-none', children: { props: { id: 'localConversation.historyLoadFailed' } } } },
      onPrimaryCtaClick: () => { historyClicks++; } }, return: { memoizedProps: { className: 'mb-3' }, return: null } });
    const box = d.el('div');
    d.setBody(d.el('body', { kids: [box] }));
    pageUnder(root, d);
    const watch = d.live().filter((o) => o.targets.some((t) => t.target === d.document.body && t.options.subtree)).pop();
    const showAll = (...els) => { while (box.firstChild) box.removeChild(box.firstChild); for (const e of els) box.appendChild(e); watch.fn([]); };
    const steps = (n) => { for (let i = 0; i < n; i++) d.runTimers(); };

    showAll(historyEl());
    steps(5);
    eq([conflictClicks, historyClicks], [0, 0], 'on its own, "Couldn\'t load messages" is left for the user');
    showAll(conflictEl(), historyEl());
    steps(3);
    eq([conflictClicks, historyClicks], [2, 0], 'while the conflict notice is up, only its Retry is clicked');
    showAll(historyEl());
    steps(2);
    eq([conflictClicks, historyClicks], [2, 1], 'once the conflict notice has been gone for two steps, "Couldn\'t load messages" gets a click');
    steps(5);
    eq([historyClicks, d.waiting()], [3, 0], 'while it stays it is clicked at each step, three times at most, and then left');
    showAll(conflictEl(), historyEl());
    steps(2);
    showAll(historyEl());
    steps(3);
    const at = historyClicks;
    showAll();
    steps(3);
    eq([historyClicks - at, d.waiting()], [0, 0], 'once it has gone after a click, nothing more is clicked or scheduled');
  }

  /* The host's lines. */
  eq([
    patching.writerConflictLine({ event: 'retrying', thread: '01a2-thread', tries: 0 }),
    patching.writerConflictLine({ event: 'cleared', thread: '01a2-thread', tries: 1 }),
    patching.writerConflictLine({ event: 'stopped', thread: 'x y', tries: 24 }),
    patching.writerConflictLine({ event: 'other', thread: '01a2-thread', tries: 1 }),
  ], [
    'Codex says conversation 01a2-thread is open in another app; clicking its Retry every 5 s for up to 2 minutes',
    'Codex\'s notice that conversation 01a2-thread is open in another app went away after Retry was clicked 1 time',
    'Codex still says a conversation is open in another app after Retry was clicked 24 times; left for the user to retry',
    '',
  ], 'each report gets its log line, an id with other characters is not named, and a report of another kind gets none');
};
