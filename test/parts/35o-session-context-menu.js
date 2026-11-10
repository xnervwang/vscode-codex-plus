// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The page's right-click menus of the session list's rows and group headers. The render check's sessions scene
 * measures their sizes and placement.
 */
const { runSessionsPage } = require('../sessions-page-run');
const { LIST_MENU, COLORS, COLOR_NAMES } = require('../../src/sessions-view');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const row = (n, extra = {}) => ({ id: ID(n), title: `Conversation ${n}`, time: '1d', dot: 'idle', color: '', open: false, sidebar: false,
  unread: false, grouped: false, group: 'Ungrouped', branch: '', goal: '', goalText: '', here: false, ...extra });
/* The context the page sends with an item of an ungrouped, read row's menu. */
const thread = (id) => ({ webviewSection: 'thread', threadId: id, codexPlusGrouped: false, codexPlusUnread: false, codexPlusGoal: '',
  codexPlusGoalResumable: false, codexPlusOpenHere: false });

module.exports = async ({ eq, root }) => {
  const { dom, page, posted, $, $$, toPage, toWindow } = runSessionsPage(root, { width: 400, height: 800 });
  const colors = (COLOR_NAMES || []).map((name) => ({ name, color: COLORS[name] }));
  const model = {
    account: null, closed: [], front: '', noGroups: false, menu: LIST_MENU, colors,
    open: [row(1, { open: true, here: true })],
    groups: [{ key: 'section:pin', label: 'Pinned', made: false, rows: [row(6, { grouped: true, group: 'Pinned' })] },
      { key: 'section:a', label: 'Alpha', made: true, rows: [row(2, { grouped: true, group: 'Alpha', color: 'charts.blue' }),
        row(5, { grouped: true, group: 'Alpha', color: 'charts.blue' })] },
      { key: 'section:e', label: 'Empty one', made: true, rows: [] },
      { key: 'ungrouped', label: 'Ungrouped', made: false, rows: [row(1, { open: true, here: true }), row(3, { color: 'charts.blue' }), row(4)] }],
  };
  toPage({ type: 'model', model });

  const main = () => $$('.cp-ctx').find((b) => !b.classList.contains('cp-ctx-sub')) || null;
  const sub = () => $('.cp-ctx-sub');
  const items = (box) => (box ? box.querySelectorAll('.cp-ctx-item') : []);
  const label = (b) => (b.childNodes[0] ? b.childNodes[0].textContent : '');
  const item = (title) => items(main()).find((b) => label(b) === title) || null;
  const kinds = (box) => (box ? box.children.map((c) => (c.classList.contains('cp-ctx-sep') ? '-' : 'item')) : []);
  const rowEl = (key, n) => $(`.cp-group[data-key="${key}"] .cp-row[data-id="${ID(n)}"]`);
  const head = (key) => $(`.cp-group[data-key="${key}"] .cp-group-head`);
  const rightClick = (e, x = 30, y = 50) => e.bubble('contextmenu', { clientX: x, clientY: y, button: 2 });
  const clickAway = () => { page.bubble('mousedown', { button: 0 }); page.bubble('click'); };
  const gone = () => $$('.cp-ctx').length === 0;
  const timers = dom.waiting();
  const COLOR = 'Codex Plus: Text Color', GROUP = 'Codex Plus: Add to Group', RENAME = 'Codex Plus: Rename...';

  /* ── a right-click on a row ── */
  posted.length = 0;
  const ev = rightClick(rowEl('ungrouped', 4));
  eq([ev.defaultPrevented, !!main(), main() && main().getAttribute('role'), main() && main().style.left, main() && main().style.top],
    [true, true, 'menu', '30px', '50px'],
    'a right-click on a row is kept from VS Code, whose own menu would open otherwise, and the page opens its menu where the click was');
  eq(items(main()).map(label), ['Codex Plus: Resume in Tab', 'Codex Plus: Resume in Sidebar', GROUP, 'Codex Plus: Mark as Unread', RENAME,
    COLOR, 'Codex Plus: Set Goal...'], 'with the row\'s items, each after "Codex Plus: "');
  eq(kinds(main()), ['item', 'item', '-', 'item', '-', 'item', '-', 'item', '-', 'item', '-', 'item'], 'and a separator between groups of items, as VS Code drew them');
  eq([!!items(main())[0] && items(main())[0].focused, dom.waiting() === timers, posted], [true, true, [{ kind: 'select', ids: [ID(4)] }]],
    'the first item has the focus, opening started no timer, and the row right-clicked is selected');
  eq([item(COLOR) && item(COLOR).getAttribute('aria-haspopup'), item(COLOR) && (item(COLOR).querySelector('.cp-ctx-chevron') || {}).textContent,
    item(GROUP) && !!item(GROUP).querySelector('.cp-ctx-chevron'), item(RENAME) && item(RENAME).querySelector('.cp-ctx-chevron')], ['menu', '›', true, null],
  'Text Color and Add to Group end in Claude Code\'s › for a submenu, and no other item does');
  posted.length = 0;
  if (item(RENAME)) item(RENAME).bubble('click');
  eq([posted, gone(), dom.waiting() === timers], [[{ kind: 'menu', command: 'codexPlus.renameThread', context: thread(ID(4)) }], true, true],
    'an item clicked sends its command with the row\'s context to the host, and the menu is taken off the page');

  rightClick($(`.cp-section[data-key="open"] .cp-row[data-id="${ID(1)}"]`));
  const fromOpen = items(main()).map(label);
  clickAway();
  rightClick(rowEl('ungrouped', 1));
  eq([fromOpen.length > 0, [...fromOpen, ...items(main()).map(label)].filter((t) => /Resume in/.test(t))], [true, []],
    'a conversation open in this window has no Resume in Tab or Resume in Sidebar, on its row in Open sessions or in a group');
  clickAway();

  /* ── a group header ── */
  posted.length = 0;
  rightClick(head('section:a'));
  eq([items(main()).map(label), kinds(main()), posted],
    [['Codex Plus: Start New Session in This Group', 'Codex Plus: New Group...', 'Codex Plus: Rename Group...', 'Codex Plus: Delete Group'],
      ['item', 'item', '-', 'item', '-', 'item'], []], 'a group\'s header opens its four items, and selects nothing');
  if (items(main())[3]) items(main())[3].bubble('click');
  eq(posted, [{ kind: 'menu', command: 'codexPlus.deleteGroup', context: { webviewSection: 'group', groupKey: 'section:a', codexPlusMade: true } }],
    'each sends its command with the header\'s context');
  rightClick(head('ungrouped'));
  eq(items(main()).map(label), ['Codex Plus: New Group...'], 'Ungrouped\'s header has New Group alone');
  clickAway();

  /* ── several rows selected ── */
  page.bubble('keydown', { key: 'Escape' });
  rowEl('section:a', 2).bubble('click', { ctrlKey: true });
  rowEl('ungrouped', 3).bubble('click', { ctrlKey: true });
  posted.length = 0;
  rightClick(rowEl('ungrouped', 3));
  if (item(COLOR)) item(COLOR).bubble('mouseenter');
  const colourItems = items(sub()).map((b) => b.textContent);
  eq([posted.filter((m) => m.kind === 'select'), colourItems, kinds(sub())],
    [[], ['Default', 'Red', 'Blue ✓', 'Green', 'Yellow', 'Purple', 'Orange', 'Pink', 'Cyan'], ['item', '-', 'item', 'item', 'item', 'item', 'item', 'item', 'item', 'item']],
    'a right-click inside the selection keeps it, and Text Color lists Default, a separator and Claude Code Plus\'s eight colours, the colour they all have checked');
  eq(items(sub()).map((b) => { const s = b.querySelector('.cp-swatch'); return s ? (s.classList.contains('cp-swatch-none') ? 'ring' : s.style.background) : null; }),
    ['ring', ...(COLOR_NAMES || []).map((n) => `var(--vscode-${COLORS[n].replace(/\./g, '-')})`)],
    'each with a swatch in its theme colour before it, and an empty ring for Default');
  posted.length = 0;
  if (items(sub())[1]) items(sub())[1].bubble('click');
  eq([posted, gone()], [[{ kind: 'menu', command: 'codexPlus.setTitleColor', context: thread(ID(3)), pick: 'red' }], true],
    'a colour clicked sends Text Color with what was picked, for the host to give it to every selected conversation');
  rightClick(rowEl('ungrouped', 3));
  if (item(GROUP)) item(GROUP).bubble('mouseenter');
  eq(items(sub()).map((b) => b.textContent), ['Alpha', 'Empty one'], 'Add to Group lists the groups the user made, Codex\'s Pinned not among them');
  posted.length = 0;
  if (items(sub())[1]) items(sub())[1].bubble('click');
  eq(posted, [{ kind: 'menu', command: 'codexPlus.moveThreadToSection', context: thread(ID(3)), pick: 'section:e' }],
    'and a group clicked sends Add to Group with that group');

  posted.length = 0;
  rightClick(rowEl('ungrouped', 4));
  if (item(COLOR)) item(COLOR).bubble('mouseenter');
  const noColour = items(sub()).map((b) => b.textContent)[0];
  if (item(GROUP)) item(GROUP).bubble('mouseenter');
  eq([posted, noColour, items(sub()).map((b) => b.textContent), $$('.cp-ctx-sub').length], [[{ kind: 'select', ids: [ID(4)] }], 'Default ✓', ['Alpha', 'Empty one'], 1],
    'a right-click outside the selection acts on that row alone: Default is checked for a row with no colour, and one submenu is open at a time');
  clickAway();
  page.bubble('keydown', { key: 'Escape' });
  rowEl('section:a', 2).bubble('click', { ctrlKey: true });
  rowEl('section:a', 5).bubble('click', { ctrlKey: true });
  rightClick(rowEl('section:a', 5));
  if (item(GROUP)) item(GROUP).bubble('mouseenter');
  eq(items(sub()).map((b) => b.textContent), ['Empty one'], 'a group that holds every selected conversation is left out of Add to Group');
  clickAway();
  page.bubble('keydown', { key: 'Escape' });
  rowEl('section:a', 2).bubble('click', { ctrlKey: true });
  rowEl('ungrouped', 4).bubble('click', { ctrlKey: true });
  rightClick(rowEl('ungrouped', 4));
  if (item(COLOR)) item(COLOR).bubble('mouseenter');
  eq([items(sub()).length, items(sub()).filter((b) => /✓/.test(b.textContent)).length], [9, 0], 'and with different colours none is checked');
  clickAway();
  page.bubble('keydown', { key: 'Escape' });
  const one = JSON.parse(JSON.stringify(model));
  one.groups = [one.groups[1], one.groups[3]];
  one.groups[0].rows = [one.groups[0].rows[0]];
  toPage({ type: 'model', model: one });
  rightClick(rowEl('section:a', 2));
  const onlyGroup = items(main()).map(label);
  clickAway();
  toPage({ type: 'model', model: Object.assign({}, model, { noGroups: true }) });
  rightClick(rowEl('ungrouped', 4));
  const noGroups = items(main()).map(label);
  clickAway();
  const headEv = rightClick(head('section:a'));
  eq([onlyGroup.length > 0 && !onlyGroup.includes(GROUP), noGroups.length > 0 && !noGroups.includes(GROUP), headEv.defaultPrevented, gone()], [true, true, false, true],
    'with no other group to add to there is no Add to Group; with no groups in this Codex neither, and a header with nothing to offer opens nothing');
  toPage({ type: 'model', model });

  /* ── keys ── */
  page.bubble('keydown', { key: 'Escape' });
  rightClick(rowEl('ungrouped', 4));
  const list = items(main());
  if (list[0]) list[0].bubble('keydown', { key: 'ArrowUp' });
  if (list[list.length - 1]) list[list.length - 1].bubble('keydown', { key: 'ArrowDown' });
  if (list[0]) list[0].bubble('keydown', { key: 'ArrowDown' });
  eq([list.length > 2 && list[list.length - 1].focused, !!list[1] && list[1].focused], [true, true], 'the arrow keys move between the items, round from either end');
  if (item(RENAME)) item(RENAME).bubble('keydown', { key: 'ArrowRight' });
  if (item(RENAME)) item(RENAME).bubble('keydown', { key: 'x' });
  eq([!!sub(), !!main(), $('.cp-search input') && $('.cp-search input').value], [false, true, ''],
    '→ on an item without a submenu does nothing, and a letter typed in the menu does not start a search');
  if (item(COLOR)) item(COLOR).bubble('keydown', { key: 'ArrowRight' });
  eq([!!sub(), !!items(sub())[0] && items(sub())[0].focused], [true, true], '→ on Text Color opens its submenu with the focus on its first item');
  if (items(sub())[0]) items(sub())[0].bubble('keydown', { key: 'ArrowDown' });
  eq(!!items(sub())[1] && items(sub())[1].focused, true, 'the arrows then move within the submenu');
  if (items(sub())[1]) items(sub())[1].bubble('keydown', { key: 'ArrowLeft' });
  eq([!!sub(), !!main(), !!item(COLOR) && item(COLOR).focused], [false, true, true], '← closes the submenu and puts the focus back on Text Color');
  if (item(GROUP)) item(GROUP).bubble('keydown', { key: 'Enter' });
  eq([!!sub(), items(sub()).map((b) => b.textContent), !!items(sub())[0] && items(sub())[0].focused], [true, ['Alpha', 'Empty one'], true],
    'Enter on Add to Group opens its submenu the same way');
  const escSub = items(sub())[0] ? items(sub())[0].bubble('keydown', { key: 'Escape' }) : {};
  eq([!!sub(), !!main(), escSub.defaultPrevented], [false, true, true], 'Esc closes the submenu and leaves the menu');
  if (item(GROUP)) item(GROUP).bubble('keydown', { key: 'Escape' });
  eq(gone(), true, 'and Esc again closes the menu');
  rightClick(rowEl('ungrouped', 4));
  if (item(COLOR)) item(COLOR).bubble('keydown', { key: 'ArrowRight' });
  posted.length = 0;
  if (items(sub())[2]) items(sub())[2].bubble('keydown', { key: 'Enter' });
  rightClick(rowEl('ungrouped', 4));
  if (item('Codex Plus: Mark as Unread')) item('Codex Plus: Mark as Unread').bubble('keydown', { key: ' ' });
  eq(posted.filter((m) => m.kind === 'menu').map((m) => [m.command, m.pick === undefined ? null : m.pick]),
    [['codexPlus.setTitleColor', 'blue'], ['codexPlus.markThreadUnread', null]], 'Enter or Space runs the item with the focus, in the submenu or the menu');
  const r3 = rowEl('ungrouped', 3);
  r3.rect = { top: 300, left: 6, width: 388, height: 28, bottom: 328, right: 394 };
  page.bubble('keydown', { key: 'Escape' });
  page.bubble('keydown', { key: 'Escape' });
  const visible = page.querySelectorAll('.cp-row').filter((r) => !r.closest('.cp-hidden, .cp-section:not(.cp-open), .cp-group:not(.cp-open)'));
  for (let i = 0; i <= visible.indexOf(r3); i++) page.bubble('keydown', { key: 'ArrowDown' });
  posted.length = 0;
  const f10 = page.bubble('keydown', { key: 'F10', shiftKey: true });
  const atRow = [main() && main().style.left, main() && main().style.top];
  if (items(main())[0]) items(main())[0].bubble('click');
  page.bubble('keydown', { key: 'ContextMenu' });
  eq([f10.defaultPrevented, atRow, posted.filter((m) => m.kind === 'menu').map((m) => m.context.threadId), !!main()], [true, ['14px', '328px'], [ID(3)], true],
    'Shift+F10 or the menu key opens the menu of the row the arrow keys are on, under that row');
  clickAway();

  /* ── the pointer, and the wait before a submenu closes ── */
  rightClick(rowEl('ungrouped', 4));
  if (item(COLOR)) item(COLOR).bubble('mouseenter');
  const opened = !!sub() && item(COLOR).classList.contains('cp-ctx-open') && item(COLOR).getAttribute('aria-expanded') === 'true';
  if (item(RENAME)) item(RENAME).bubble('mouseenter');
  const waiting = [!!sub(), dom.waiting() - timers];
  dom.runTimers();
  eq([opened, waiting, !!sub(), !!main(), item(COLOR) && item(COLOR).classList.contains('cp-ctx-open')], [true, [true, 1], false, true, false],
    'resting on Text Color opens its submenu at once; moving onto another item closes it after a moment, as Claude Code\'s does');
  if (item(COLOR)) item(COLOR).bubble('mouseenter');
  if (item(RENAME)) item(RENAME).bubble('mouseenter');
  if (sub()) sub().bubble('mouseenter');
  const kept = dom.waiting() === timers;
  dom.runTimers();
  eq([kept, !!sub()], [true, true], 'and reaching the submenu in that moment keeps it open');
  if (item(RENAME)) item(RENAME).bubble('mouseenter');
  clickAway();
  eq([gone(), dom.waiting() === timers], [true, true], 'closing the menu clears that wait, so no timer is left behind');

  /* ── what closes it ── */
  rightClick(rowEl('ungrouped', 4));
  posted.length = 0;
  rowEl('ungrouped', 3).bubble('mousedown', { button: 0 });
  rowEl('ungrouped', 3).bubble('click');
  const swallowed = [gone(), posted.length];
  rowEl('ungrouped', 3).bubble('mousedown', { button: 0 });
  rowEl('ungrouped', 3).bubble('click');
  eq([swallowed, posted.map((m) => m.kind)], [[true, 0], ['select', 'open']],
    'a click outside the menu only closes it, as Claude Code\'s does; the next click opens the row');
  const closes = [];
  rightClick(rowEl('ungrouped', 4));
  if (main()) main().bubble('wheel', { deltaY: 40 });
  const inside = rightClick(main() || page);
  closes.push(['wheel or right-click inside', !gone() && inside.defaultPrevented]);
  page.bubble('wheel', { deltaY: 40 });
  closes.push(['wheel outside', gone()]);
  rightClick(rowEl('ungrouped', 4));
  page.bubble('scroll');
  closes.push(['scroll', gone()]);
  rightClick(rowEl('ungrouped', 4));
  toWindow('blur');
  closes.push(['window blur', gone()]);
  rightClick(rowEl('ungrouped', 4));
  toWindow('resize');
  closes.push(['window resize', gone()]);
  rightClick(rowEl('ungrouped', 4));
  if (item(COLOR)) item(COLOR).bubble('mouseenter');
  rowEl('ungrouped', 3).bubble('mousedown', { button: 2 });
  rightClick(rowEl('ungrouped', 3));
  const after = $$('.cp-ctx').length;
  posted.length = 0;
  if (items(main())[0]) items(main())[0].bubble('click');
  closes.push(['right-click elsewhere', after === 1 && posted.filter((m) => m.kind === 'menu').map((m) => m.context.threadId).join() === ID(3)]);
  rightClick(rowEl('ungrouped', 4));
  const bare = page.bubble('contextmenu', { clientX: 5, clientY: 790, button: 2 });
  closes.push(['right-click on no row', gone() && !bare.defaultPrevented]);
  eq(closes.filter(([, ok]) => !ok).map(([what]) => what), [],
    'scrolling, the window losing the focus or changing size, and another right-click close it, and nothing of it is left on the page');
  eq(dom.waiting(), timers, 'nor any timer');
};
