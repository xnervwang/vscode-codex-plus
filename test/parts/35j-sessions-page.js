// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * src/page/sessions-page.js run on the stand-in DOM of test/fake-dom.js, fed models the way the host posts them. Sizes,
 * colours and layout are checked by the render check's sessions scene (test/render/run.js). This part checks behaviour:
 * the sections drawn, no DOM writes for a repeated model, one row rewritten for one changed row, filters and search,
 * keys, the hover box, dropping rows on a group, inline rename, and the messages sent to the host.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const row = (n, extra = {}) => ({ id: ID(n), title: `Conversation ${n}`, time: `${n}d · 11/0${n % 9}`, dot: 'idle', color: '', open: false,
  sidebar: false, unread: false, grouped: false, group: 'Ungrouped', branch: '', ...extra });

module.exports = async ({ eq, root }) => {
  const dom = createDom();
  const { document } = dom;
  const page = dom.el('div', { attrs: { id: 'root' } });
  dom.setBody(dom.el('body', { kids: [page] }));
  const posted = [];
  const listeners = {};
  let state = null;
  const win = { innerWidth: 400, innerHeight: 800, getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); } };
  const sandbox = Object.assign({}, dom.sandbox, { window: win, Map, Set, Proxy, Promise,
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => state, setState: (s) => { state = s; } }) });
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(root, 'src', 'page', 'sessions-page.js'), 'utf8');
  vm.runInContext(source, sandbox);
  const toPage = (msg) => { for (const fn of listeners.message || []) fn({ data: msg }); };
  const $ = (sel) => page.querySelector(sel);
  const $$ = (sel) => page.querySelectorAll(sel);
  const shown = (e) => !!e && !e.closest('.cp-hidden');
  const kinds = () => posted.map((m) => m.kind);

  eq(kinds(), ['ready'], 'the page says it is ready, which is when the host sends it the model');
  const model = {
    account: { account: [{ label: 'Signed in with', value: 'Amazon Bedrock' }], windows: [], tokens: [] },
    closed: [row(9, { title: 'Closed earlier' })],
    open: [row(1, { open: true, here: true, dot: 'working' })],
    groups: [{ key: 'section:a', label: 'Alpha', made: true, rows: [row(2, { grouped: true, group: 'Alpha', dot: 'prompt' })] },
      { key: 'section:e', label: 'Empty one', made: true, rows: [] },
      { key: 'ungrouped', label: 'Ungrouped', made: false, rows: [row(1, { open: true, here: true, dot: 'working' }), row(3, { unread: true, branch: 'fix/retry' }), row(4)] }],
    front: ID(1), noGroups: false,
  };
  toPage({ type: 'model', model });

  /* ── what is drawn ── */
  const labels = $$('.cp-section').filter(shown).map((s) => s.querySelector('.cp-section-label').textContent);
  eq(labels, ['Account & usage', 'Recently closed', 'Open sessions', 'Session manager'],
    'ACCOUNT & USAGE, RECENTLY CLOSED, OPEN SESSIONS and SESSION MANAGER, in that order (the stylesheet writes them in capitals)');
  eq([$('.cp-section[data-key="closed"]').classList.contains('cp-open'), $('.cp-section[data-key="open"]').classList.contains('cp-open')], [false, true],
    'Recently closed starts collapsed and Open sessions open, as in Claude Code Plus');
  eq([...$$('.cp-section[data-key="closed"] .cp-count'), ...$$('.cp-section[data-key="open"] .cp-count')].map((c) => c.textContent), ['1', '1'],
    'each of the two carries its count');
  eq($('.cp-account').textContent, 'AccountSigned in withAmazon Bedrock', 'the account section has the Account line and, for this account, nothing else');
  eq($$('.cp-new').map((b) => b.textContent), ['New in tab', 'New in sidebar'], 'New in tab and New in sidebar side by side, under the manager\'s header');
  eq($$('.cp-group').map((g) => [g.querySelector('.cp-group-name').textContent, g.querySelector('.cp-group-count').textContent]),
    [['Alpha', '1'], ['Empty one', '0'], ['Ungrouped', '3']], 'each group with its name and a count, the empty one the user made with its nought');
  const r3 = $(`.cp-group[data-key="ungrouped"] .cp-row[data-id="${ID(3)}"]`);
  eq([r3.querySelector('.cp-dot').className, r3.querySelector('.cp-title').textContent, r3.querySelector('.cp-time').textContent,
    !!r3.querySelector('.cp-actions [data-act="rename"]')], ['cp-dot d-idle', 'Conversation 3', '3d · 11/03', true],
  'a row is its dot, its title, its time and, in the time\'s place on hover, the rename button');
  eq([r3.hasAttribute('data-vscode-context'), $('.cp-group[data-key="section:a"] .cp-group-head').hasAttribute('data-vscode-context')], [false, false],
    'a row and a group header carry nothing for VS Code\'s own menu, since the page draws their right-click menus');
  eq($$('.cp-row.cp-current').map((r) => r.dataset.id), [ID(1), ID(1)], 'the conversation in front is drawn as the current one wherever it is listed');
  eq(posted.filter((m) => m.kind === 'expanded').pop().keys, ['open', 'section:a', 'ungrouped'],
    'and the host is told which groups are open, which is when it reads the rollouts of their conversations');

  /* ── a model it already has, and one with a single row changed ── */
  dom.takeMutations();
  toPage({ type: 'model', model: JSON.parse(JSON.stringify(model)) });
  eq(dom.takeMutations().length, 0, 'the same model again changes nothing on the page');
  const one = JSON.parse(JSON.stringify(model));
  one.groups[2].rows[2].time = 'now · 11/10';
  toPage({ type: 'model', model: one });
  const touched = new Set(dom.takeMutations().map((m) => m.target.closest && m.target.closest('.cp-row')).filter(Boolean));
  eq([...touched].map((r) => r.dataset.id), [ID(4)], 'a model with one row changed rewrites that row and no other');

  /* ── filtering and searching ── */
  const visibleIds = () => $$('.cp-group .cp-row').filter(shown).map((r) => r.dataset.id);
  eq($('[data-tool="active"]').textContent, 'Active · 3', 'Active counts the conversations that need input, are working or are unread');
  $('[data-tool="active"]').bubble('click');
  eq(visibleIds(), [ID(2), ID(1), ID(3)], 'and shows only those');
  $('[data-tool="active"]').bubble('click');
  page.bubble('keydown', { key: 'r' });
  eq([shown($('.cp-search')), $('.cp-search input').value], [true, 'r'], 'typing in the list opens the search with what was typed');
  const input = $('.cp-search input');
  input.value = 'fix/re';
  input.bubble('input');
  eq(visibleIds(), [ID(3)], 'the search matches the branch as well as the title');
  input.value = ID(4).slice(-6);
  input.bubble('input');
  eq(visibleIds(), [ID(4)], 'and four or more characters of hex match the session id');
  input.value = 'Conversation 2';
  input.bubble('input');
  eq([visibleIds(), $('.cp-group[data-key="section:a"] .cp-mark').textContent, shown($('.cp-group[data-key="ungrouped"]'))],
    [[ID(2)], 'Conversation 2', false], 'a title match is marked, and a group with nothing left in it is not drawn');
  input.value = 'nothing like it';
  input.bubble('input');
  eq([shown($('.cp-none')), $('.cp-none').textContent], [true, 'No sessions found'], 'a search that finds nothing says so');
  input.bubble('keydown', { key: 'Escape' });
  eq([input.value, visibleIds().length, shown($('.cp-none'))], ['', 4, false], 'Esc clears the search');
  $('[data-tool="filter"]').bubble('click');
  const items = $$('.cp-menu-item').map((i) => [i.dataset.status, i.querySelector('.cp-n').textContent]);
  eq(items, [['needs_input', '1'], ['working', '1'], ['completed', '2'], ['open', '1'], ['closed', '3']],
    'the status filter offers Needs input, Working and Completed, and Open and Closed tabs, each with its count');
  $('.cp-menu-item[data-status="needs_input"]').bubble('click');
  eq(visibleIds(), [ID(2)], 'and picking one shows only those');
  $('.cp-menu-item[data-status="needs_input"]').bubble('click');
  eq(state.status.needs_input, false, 'what is picked is kept with the page\'s own state, so it outlives the page');

  /* ── clicks, keys and the hover ── */
  posted.length = 0;
  $(`.cp-group[data-key="ungrouped"] .cp-row[data-id="${ID(4)}"] .cp-title`).bubble('click');
  eq(posted.map((m) => [m.kind, m.ids || m.id]), [['select', [ID(4)]], ['open', ID(4)]], 'a click selects a row and opens its conversation');
  posted.length = 0;
  $(`.cp-group[data-key="ungrouped"] .cp-row[data-id="${ID(3)}"]`).bubble('click', { ctrlKey: true });
  eq(posted.map((m) => [m.kind, m.ids]), [['select', [ID(4), ID(3)]]], 'a click with Ctrl adds it to the selection and opens nothing');
  page.bubble('keydown', { key: 'Escape' });
  eq(posted.pop(), { kind: 'select', ids: [] }, 'Esc clears the selection');
  page.bubble('keydown', { key: 'Escape' });
  eq($$('.cp-row.cp-hl').length, 0, 'and pressed again, the row the keys were on');
  page.bubble('keydown', { key: 'ArrowDown' });
  page.bubble('keydown', { key: 'ArrowDown' });
  posted.length = 0;
  page.bubble('keydown', { key: 'Enter' });
  eq(posted, [{ kind: 'open', id: ID(2), where: 'tab' }], 'the arrow keys move through the rows on screen and Enter opens the one reached');
  const r2 = $('.cp-group[data-key="section:a"] .cp-row');
  r2.bubble('mouseover');
  eq(shown($('.cp-hover')), false, 'the hover box waits, as a tooltip does');
  dom.runTimers();
  eq([shown($('.cp-hover')), $('.cp-hover').textContent], [true, `Group: Alpha\nSession ID: ${ID(2)}`], 'then gives the group and the session ID');
  r2.bubble('mousedown');
  eq(shown($('.cp-hover')), false, 'and goes as soon as the row is clicked');

  /* ── dragging rows onto a group ── */
  posted.length = 0;
  const data = new Map();
  const dt = { setData: (k, v) => data.set(k, v), getData: (k) => data.get(k) || '', effectAllowed: '', dropEffect: '' };
  $(`.cp-group[data-key="ungrouped"] .cp-row[data-id="${ID(4)}"]`).bubble('dragstart', { dataTransfer: dt });
  const over = $('.cp-group[data-key="section:e"] .cp-group-head').bubble('dragover', { dataTransfer: dt });
  $('.cp-group[data-key="section:e"] .cp-group-head').bubble('drop', { dataTransfer: dt });
  eq([over.defaultPrevented, posted], [true, [{ kind: 'move', ids: [ID(4)], key: 'section:e' }]], 'a row dropped on a group is moved into it');

  /* ── editing a title, and a new group's name ── */
  posted.length = 0;
  toPage({ type: 'startRename', id: ID(3) });
  const title = $(`.cp-group[data-key="ungrouped"] .cp-row[data-id="${ID(3)}"] .cp-title`);
  eq(title.isContentEditable, true, 'Rename edits the title where it is drawn');
  title.textContent = '  A better   title ';
  title.bubble('keydown', { key: 'Enter' });
  eq([posted, title.isContentEditable], [[{ kind: 'rename', id: ID(3), title: 'A better title' }], false], 'and Enter sends the new title');

  /* Conversation 1 is listed twice, in Open sessions and in Ungrouped. */
  const openRow1 = $(`.cp-section[data-key="open"] .cp-row[data-id="${ID(1)}"]`);
  const groupRow1 = $(`.cp-group[data-key="ungrouped"] .cp-row[data-id="${ID(1)}"]`);
  const editing = () => [openRow1, groupRow1].map((r) => r.querySelector('.cp-title').isContentEditable);
  const stopEditing = () => { for (const r of [openRow1, groupRow1]) if (r.querySelector('.cp-title').isContentEditable) r.querySelector('.cp-title').bubble('keydown', { key: 'Escape' }); };
  $(`.cp-group[data-key="ungrouped"] .cp-row[data-id="${ID(3)}"]`).bubble('click');
  groupRow1.bubble('click', { ctrlKey: true });
  groupRow1.bubble('contextmenu');
  toPage({ type: 'startRename', id: ID(1) });
  eq(editing(), [false, true], 'Rename from a right-click menu edits the row the menu was opened on, with other rows selected too, '
    + 'and not the same conversation\'s row in Open sessions');
  stopEditing();
  groupRow1.querySelector('[data-act="rename"]').bubble('click');
  eq(editing(), [false, true], 'and so does the rename button on a row');
  stopEditing();
  page.bubble('contextmenu');
  $('.cp-section[data-key="open"] .cp-section-head').bubble('click');
  toPage({ type: 'startRename', id: ID(1) });
  eq([editing(), $('.cp-section[data-key="open"]').classList.contains('cp-open')], [[false, true], false],
    'with no row right-clicked, the conversation\'s row on screen is edited, rather than opening a collapsed section for it');
  stopEditing();
  $('.cp-section[data-key="open"] .cp-section-head').bubble('click');
  page.bubble('keydown', { key: 'Escape' });
  posted.length = 0;
  toPage({ type: 'startRenameGroup', key: 'section:new' });
  const withNew = JSON.parse(JSON.stringify(model));
  withNew.groups.splice(2, 0, { key: 'section:new', label: 'New group', made: true, rows: [] });
  toPage({ type: 'model', model: withNew });
  const name = $('.cp-group[data-key="section:new"] .cp-group-name');
  eq(name.isContentEditable, true, 'a group made from the list has its name edited as soon as it is drawn');
  name.textContent = 'Reading';
  name.bubble('keydown', { key: 'Escape' });
  eq([posted.filter((m) => m.kind === 'renameGroup'), name.textContent], [[], 'New group'], 'and Esc keeps the name it had');

  /* ── the status filter's menu, by keys ── */
  $('[data-tool="filter"]').bubble('click');
  $$('.cp-menu-item[data-status]')[0].bubble('keydown', { key: 'ArrowDown' });
  eq($$('.cp-menu-item[data-status]')[1].focused, true, 'the arrow keys move through the status filter\'s menu');
  $$('.cp-menu-item[data-status]')[1].bubble('keydown', { key: 'Escape' });

  /* ── nothing at all ── */
  toPage({ type: 'model', model: { account: null, closed: [], open: [], groups: [], front: '', noGroups: true } });
  eq([shown($('.cp-null')), $('.cp-null').textContent, $$('.cp-section').filter(shown).map((s) => s.dataset.key), shown($('[data-send="newGroup"]'))],
    [true, 'No sessions yet', ['manager'], false], 'with no conversation it says "No sessions yet", and without groups in this Codex there is no New group');
};
