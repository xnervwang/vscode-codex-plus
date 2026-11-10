// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Sub-agents under the conversation that started them. A sub-agent is a thread of its own whose source names its parent
 * (src/codex-files.js sourceKind). With background threads listed (codexPlus.hideBackgroundSessions off), a sub-agent is
 * drawn indented straight after its parent, in every group that shows the parent, instead of among the other
 * conversations. A sub-agent whose parent is not listed is drawn as before.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const { createDom } = require('../fake-dom');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, root }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  const { group, SessionsModel } = require('../../src/sessions-view');
  const t = (n, extra) => ({ id: ID(n), title: `t${n}`, kind: 'user', parent: '', cwd: '/w', section: '', createdMs: n, updatedMs: n, ...extra });
  const threads = [
    t(1, { section: 's1', updatedMs: 50 }),
    t(2, { kind: 'subagent', parent: ID(1), nickname: 'scout', updatedMs: 90, createdMs: 20 }),
    t(3, { kind: 'subagent', parent: ID(1), nickname: 'fixer', updatedMs: 80, createdMs: 10 }),
    t(4, { updatedMs: 70 }),
    t(5, { kind: 'subagent', parent: ID(99), updatedMs: 60 }),
    t(6, { kind: 'guardian', updatedMs: 40 }),
    t(7, { kind: 'subagent', parent: ID(4), updatedMs: 30 }),
  ];
  const ids = (g) => g.threads.map((x) => x.id);
  const shown = group(threads, { sections: new Map([['s1', 'Work']]), hideBackground: false, open: [ID(4)] });
  const by = (k) => shown.find((g) => g.key === k);
  eq(ids(by('section:s1')), [ID(1), ID(3), ID(2)], 'a sub-agent goes straight after its parent, in the order they were started');
  eq(ids(by('ungrouped')), [ID(4), ID(7), ID(5), ID(6)],
    'in whichever group the parent is in; one whose parent is not listed, and an approval review, stay where they were');
  eq(ids(by('open')), [ID(4), ID(7)], 'Open sessions draws the sub-agents of an open conversation under it too');
  eq(ids(group(threads, { sections: new Map([['s1', 'Work']]), hideBackground: true }).find((g) => g.key === 'ungrouped')), [ID(4)],
    'with background threads hidden, as by default, no sub-agent is listed');

  const model = new SessionsModel(vscode, { memory: { openThreads: () => [], recentlyClosed: () => [], frontAt: () => 0 }, memento: fake.memento(),
    reader: { threads: () => threads, sections: () => new Map([['s1', 'Work']]), state: () => null, thread: () => null },
    stateOf: () => null, settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: false }) }).model();
  const rows = model.groups.flatMap((g) => g.rows);
  const row = (n) => rows.find((r) => r.id === ID(n));
  eq([row(1).child, row(2).child, row(3).child, row(5).child, row(6).child], [false, true, true, false, false],
    'the model marks a sub-agent drawn under its parent');
  eq([row(2).title, row(3).parentTitle], ['t2', 't1'], 'and names its parent, for the hover');

  /* The page indents it. */
  const dom = createDom();
  const page = dom.el('div', { attrs: { id: 'root' } });
  dom.setBody(dom.el('body', { kids: [page] }));
  const listeners = {};
  const sandbox = Object.assign({}, dom.sandbox, { window: { innerWidth: 400, innerHeight: 800, getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    addEventListener: (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); } }, Map, Set, Proxy, Promise,
  acquireVsCodeApi: () => ({ postMessage() {}, getState: () => null, setState() {} }) });
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'page', 'sessions-page.js'), 'utf8'), sandbox);
  for (const fn of listeners.message) fn({ data: { type: 'model', model } });
  const drawn = page.querySelectorAll('.cp-row');
  eq(drawn.filter((e) => e.classList.contains('cp-child')).map((e) => e.dataset.id).sort(), [ID(2), ID(3), ID(7)].sort(),
    'the page draws each sub-agent under its parent as an indented row');
  const css = fs.readFileSync(path.join(root, 'src', 'page', 'sessions-page.css'), 'utf8');
  eq(/\.cp-row\.cp-child\s*\{[^}]*padding-left/.test(css), true, 'indented by the stylesheet');
};
