// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

/*
 * Page script for the Codex session list webview (src/sessions-view.js SessionsView). The host posts { type: 'model' }
 * whenever the list changes. The page lays it out like Claude Code's list, with Claude Code Plus's OPEN SESSIONS and
 * RECENTLY CLOSED above the session manager.
 *
 * Elements are kept per key (row id, group key) and reused, and a field is written only when its value differs, so a
 * one-row change rewrites one row. Filters and search run over the model already in the page and toggle only rows
 * whose visibility changes.
 *
 * Collapsed sections and groups, the status filter, Active and the search text are saved with setState, so they survive
 * VS Code dropping the page while the view is hidden.
 */
(function () {
  'use strict';
  const host = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {}, getState() { return null; }, setState() {} };
  const root = document.getElementById('root');
  if (!root) return;
  const send = (msg) => { try { host.postMessage(msg); } catch (_) { /* the host is gone */ } };

  const saved = host.getState() || {};
  const ui = {
    collapsed: Object.assign({ closed: true }, saved.collapsed || {}),
    status: Object.assign({}, saved.status || {}),
    active: !!saved.active,
    search: typeof saved.search === 'string' ? saved.search : '',
    searchOpen: typeof saved.search === 'string' && saved.search !== '',
  };
  const keep = () => { try { host.setState({ collapsed: ui.collapsed, status: ui.status, active: ui.active, search: ui.search }); } catch (_) { /* not kept */ } };

  /* ── building blocks ── */
  const SVG = 'http://www.w3.org/2000/svg';
  const ICONS = {
    chevron: ['M6 4l4 4-4 4'],
    plus: ['M8 3v10', 'M3 8h10'],
    sidebar: ['M3.5 3h9A1.5 1.5 0 0 1 14 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3z', 'M10 3v10'],
    search: ['M7 3a4 4 0 1 1 0 8a4 4 0 0 1 0-8z', 'M10 10l3.5 3.5'],
    funnel: ['M2.5 3.5h11l-4.2 5v4l-2.6 1.2v-5.2z'],
    caret: ['M5 6.5l3 3 3-3'],
    pencil: ['M10.5 2.5l3 3-7.5 7.5H3v-3z'],
    bolt: ['M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z'],
    close: ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'],
    check: ['M3.5 8.5l3 3 6-7'],
  };
  const icon = (name, cls = 'cp-icon') => {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('class', cls);
    s.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) { const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); s.appendChild(p); }
    return s;
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const button = (cls, title, ...kids) => { const b = el('button', cls); b.type = 'button'; if (title) { b.title = title; b.setAttribute('aria-label', title); } b.append(...kids); return b; };
  /* Text written only when it differs, so a model that changed nothing changes nothing on the page. */
  const setText = (e, text) => { if (e.textContent !== text) e.textContent = text; };

  /* A section: a header that collapses it, with its label and count, and a body. */
  function section(key, label) {
    const s = el('div', 'cp-section');
    s.dataset.key = key;
    const head = button('cp-section-head', '');
    head.dataset.toggle = key;
    const count = el('span', 'cp-count');
    head.append(icon('chevron', 'cp-icon cp-chevron'), el('span', 'cp-section-label', label), count);
    const body = el('div', 'cp-section-body');
    s.append(head, body);
    return { s, head, count, body };
  }

  /* ── the page's fixed parts ── */
  const account = section('account', 'Account & usage');
  account.count.remove();
  account.body.classList.add('cp-account');
  const closed = section('closed', 'Recently closed');
  const open = section('open', 'Open sessions');
  const closedList = el('div', 'cp-list'), openList = el('div', 'cp-list');
  closed.body.appendChild(closedList);
  open.body.appendChild(openList);
  const manager = section('manager', 'Session manager');
  manager.count.remove();
  const newRow = el('div', 'cp-new-row');
  const newTab = button('cp-new', 'New Codex conversation in a tab', icon('plus'), el('span', '', 'New in tab'));
  newTab.dataset.send = 'newInTab';
  const newSide = button('cp-new', 'New Codex conversation in the sidebar', icon('plus'), el('span', '', 'New in sidebar'));
  newSide.dataset.send = 'newInSidebar';
  newRow.append(newTab, newSide);
  const filterRow = el('div', 'cp-filter-row');
  const filterBtn = button('cp-tool', 'Filter by status', icon('funnel'), icon('caret', 'cp-icon'));
  filterBtn.dataset.tool = 'filter';
  const activeBtn = button('cp-tool', 'Show only conversations that need input, are working, or are unread', icon('bolt'), el('span', '', 'Active · 0'));
  activeBtn.dataset.tool = 'active';
  const tail = el('span', 'cp-tail');
  const searchBtn = button('cp-tool cp-icon-only', 'Search sessions', icon('search'));
  searchBtn.dataset.tool = 'search';
  const groupBtn = button('cp-tool', 'New group', icon('plus'), el('span', '', 'New group'));
  groupBtn.dataset.send = 'newGroup';
  tail.append(searchBtn, groupBtn);
  const searchBox = el('div', 'cp-search');
  const searchInput = el('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search sessions';
  searchInput.setAttribute('aria-label', 'Search sessions');
  searchInput.spellcheck = false;
  const clearBtn = button('cp-clear', 'Clear search', icon('close'));
  clearBtn.dataset.tool = 'clear';
  searchBox.append(icon('search'), searchInput, clearBtn);
  filterRow.append(filterBtn, activeBtn, tail, searchBox);
  const groupsEl = el('div', 'cp-groups');
  const nullText = el('div', 'cp-null', 'No sessions yet');
  const noneText = el('div', 'cp-none', 'No sessions found');
  manager.body.append(newRow, filterRow, groupsEl, nullText, noneText);
  const hoverBox = el('div', 'cp-hover cp-hidden');
  const menu = el('div', 'cp-menu cp-hidden');
  menu.setAttribute('role', 'menu');
  root.append(account.s, closed.s, open.s, manager.s, hoverBox, menu);

  /* ── rows ── */
  function makeRow() {
    const r = el('div', 'cp-row');
    r.tabIndex = -1;
    r.draggable = true;
    const dot = el('span', 'cp-dot');
    const title = el('span', 'cp-title');
    const goal = el('span', 'cp-goal cp-hidden');
    const meta = el('span', 'cp-meta');
    const time = el('span', 'cp-time');
    const acts = el('span', 'cp-actions');
    const rename = button('cp-act', 'Rename', icon('pencil'));
    rename.dataset.act = 'rename';
    acts.appendChild(rename);
    meta.append(time, acts);
    r.append(dot, title, goal, meta);
    r._p = { dot, title, time, goal };
    r._sig = '';
    r._mark = '';
    return r;
  }
  /* The same words as GOAL_WORD in src/sessions-view.js. */
  const GOAL_WORD = { active: 'goal', paused: 'goal paused', blocked: 'goal blocked', usageLimited: 'goal: usage limit',
    budgetLimited: 'goal: budget spent', complete: 'goal done' };
  /* The states Resume Goal can set going again: the ones Codex stopped it in, and the user's own pause. */
  const RESUMABLE = ['paused', 'blocked', 'usageLimited', 'budgetLimited'];
  const themeColor = (id) => (id ? `var(--vscode-${String(id).replace(/\./g, '-')})` : '');
  function fillRow(r, row, place) {
    r._row = row;
    r._place = place;
    const sig = `${row.id}\u0001${row.title}\u0001${row.time}\u0001${row.dot}\u0001${row.color}\u0001${row.grouped}\u0001${row.unread}`
      + `\u0001${row.goal || ''}\u0001${row.goalText || ''}\u0001${row.child ? 1 : 0}\u0001${row.parentTitle || ''}\u0001${row.nickname || ''}`
      + `\u0001${row.here ? 1 : 0}`;
    if (sig === r._sig) return;
    r._sig = sig;
    r.dataset.id = row.id;
    r._p.dot.className = `cp-dot d-${row.dot}`;
    r.classList.toggle('cp-child', !!row.child);
    if (!r._editing) { r._mark = ''; markTitle(r); }
    r._p.title.style.color = themeColor(row.color);
    setText(r._p.time, row.time);
    setText(r._p.goal, GOAL_WORD[row.goal] || (row.goal ? 'goal' : ''));
    r._p.goal.classList.toggle('cp-hidden', !row.goal);
    r._p.goal.classList.toggle('cp-goal-active', row.goal === 'active');
    /* What the row's right-click menu is chosen by, under the names the when clauses of LIST_MENU use. */
    r._ctx = { webviewSection: 'thread', threadId: row.id, codexPlusGrouped: !!row.grouped, codexPlusUnread: !!row.unread,
      codexPlusGoal: row.goal || '', codexPlusGoalResumable: RESUMABLE.includes(row.goal), codexPlusOpenHere: !!row.here };
  }
  /* The title, with the part the search matched marked, written only when that changed. */
  function markTitle(r) {
    const title = r._row.title;
    const q = term();
    const at = q && !looksLikeId(q) ? title.toLowerCase().indexOf(q.toLowerCase()) : -1;
    const want = at >= 0 && r._place !== 'open' && r._place !== 'closed' ? `${at}:${q.length}` : '';
    if (want === r._mark && r._p.title.firstChild) return;
    r._mark = want;
    const t = r._p.title;
    if (!want) { t.textContent = title; return; }
    t.textContent = '';
    const m = el('mark', 'cp-mark', title.slice(at, at + q.length));
    t.append(title.slice(0, at), m, title.slice(at + q.length));
  }
  /* Puts `rows` into `list` in order, reusing the row element kept for each id in `cache`. */
  function reconcile(list, cache, rows, place) {
    const seen = new Set();
    let i = 0;
    for (const row of rows) {
      seen.add(row.id);
      let r = cache.get(row.id);
      if (!r) { r = makeRow(); cache.set(row.id, r); }
      fillRow(r, row, place);
      const at = list.children[i];
      if (at !== r) list.insertBefore(r, at || null);
      i++;
    }
    for (const [id, r] of cache) if (!seen.has(id)) { if (r === hl) hl = null; if (r === ctxRow) ctxRow = null; r.remove(); cache.delete(id); }
  }

  /* ── groups of the session manager ── */
  const groupEls = new Map();
  function makeGroup(key) {
    const g = el('div', 'cp-group');
    g.dataset.key = key;
    const head = el('div', 'cp-group-head');
    head.dataset.group = key;
    const name = el('span', 'cp-group-name');
    const count = el('span', 'cp-group-count');
    head.append(icon('chevron', 'cp-icon cp-chevron'), name, count);
    const list = el('div', 'cp-list');
    g.append(head, list);
    g._p = { head, name, count, list, rows: new Map() };
    return g;
  }

  /* ── the model ── */
  let model = null;
  let hl = null;
  /* The row the last right-click menu was opened on. A conversation can appear twice, in Open sessions and in a group;
     commands from that menu act on this row. */
  let ctxRow = null;
  let selection = new Set();
  let anchor = '';
  let shownFront = '';
  let renameGroupKey = '';
  let lastExpanded = '';
  const closedRows = new Map(), openRows = new Map();

  function apply(next) {
    model = next || { account: null, closed: [], open: [], groups: [], front: '', noGroups: false };
    drawAccount(model.account);
    reconcile(closedList, closedRows, model.closed || [], 'closed');
    reconcile(openList, openRows, model.open || [], 'open');
    setText(closed.count, String((model.closed || []).length));
    setText(open.count, String((model.open || []).length));
    closed.s.classList.toggle('cp-hidden', !(model.closed || []).length);
    open.s.classList.toggle('cp-hidden', !(model.open || []).length);
    const keys = new Set();
    let i = 0;
    for (const g of model.groups || []) {
      keys.add(g.key);
      let ge = groupEls.get(g.key);
      if (!ge) { ge = makeGroup(g.key); groupEls.set(g.key, ge); }
      ge._g = g;
      if (!ge._p.name.isContentEditable) setText(ge._p.name, g.label);
      ge._p.head._ctx = { webviewSection: 'group', groupKey: g.key, codexPlusMade: !!g.made };
      reconcile(ge._p.list, ge._p.rows, g.rows, g.key);
      const at = groupsEl.children[i];
      if (at !== ge) groupsEl.insertBefore(ge, at || null);
      i++;
    }
    for (const [key, ge] of groupEls) if (!keys.has(key)) { ge.remove(); groupEls.delete(key); }
    groupBtn.classList.toggle('cp-hidden', !!model.noGroups);
    for (const s of [account, closed, open, manager]) s.s.classList.toggle('cp-open', !ui.collapsed[s.s.dataset.key]);
    for (const ge of groupEls.values()) ge.classList.toggle('cp-open', !ui.collapsed[`group:${ge.dataset.key}`]);
    filter();
    front();
    selection = new Set([...selection].filter((id) => rowsOf(id).length));
    paintSelection();
    if (renameGroupKey) renameGroup(renameGroupKey);
    expanded();
  }

  function drawAccount(a) {
    account.s.classList.toggle('cp-hidden', !a);
    if (!a) return;
    const sig = JSON.stringify(a);
    if (account.body._sig === sig) return;
    account.body._sig = sig;
    const kv = (k, v) => { const d = el('div', 'cp-kv'); d.append(el('span', '', k), el('span', '', v)); return d; };
    const parts = [el('div', 'cp-account-label', 'Account'), ...(a.account || []).map((x) => kv(x.label, x.value))];
    for (const w of a.windows || []) {
      const u = el('div', 'cp-usage');
      const headRow = el('div', 'cp-usage-head');
      headRow.append(el('span', '', w.name === 'Limit' ? 'Limit' : `${w.name} limit`), el('span', 'cp-usage-pct', `${w.usedPercent}% used`));
      const track = el('div', 'cp-track'), fill = el('div', `cp-fill${w.usedPercent >= 80 ? ' cp-high' : ''}`);
      fill.style.width = `${Math.max(0, Math.min(100, w.usedPercent))}%`;
      track.appendChild(fill);
      u.append(headRow, track);
      if (w.resetsAt) u.appendChild(el('div', 'cp-reset', resetText(w.resetsAt)));
      parts.push(u);
    }
    for (const k of a.tokens || []) parts.push(kv(k.label, Number(k.value).toLocaleString('en-US')));
    account.body.replaceChildren(...parts);
  }
  const pad = (n) => String(n).padStart(2, '0');
  function resetText(sec) {
    const d = new Date(sec * 1000);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.getTime() - Date.now() > 24 * 3600e3 ? `Resets ${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hm}` : `Resets ${hm}`;
  }

  /* The conversation in front is drawn as the current one, and its row in OPEN SESSIONS is scrolled to once. */
  function front() {
    const id = (model && model.front) || '';
    for (const r of root.querySelectorAll('.cp-row.cp-current')) if (r.dataset.id !== id) r.classList.remove('cp-current');
    if (!id) { shownFront = ''; return; }
    for (const r of rowsOf(id)) r.classList.add('cp-current');
    if (id === shownFront) return;
    shownFront = id;
    const r = openRows.get(id);
    if (r && !open.s.classList.contains('cp-hidden') && open.s.classList.contains('cp-open')) r.scrollIntoView({ block: 'nearest' });
  }

  /* Every row element of a conversation, in every place it is listed. */
  function rowsOf(id) {
    const out = [];
    for (const m of [closedRows, openRows]) if (m.has(id)) out.push(m.get(id));
    for (const ge of groupEls.values()) if (ge._p.rows.has(id)) out.push(ge._p.rows.get(id));
    return out;
  }

  /* The group keys whose rows are on screen, for the host to read the rollouts of those it has not read. */
  function expanded() {
    if (!model) return;
    const keys = [];
    if (!ui.collapsed.closed && (model.closed || []).length) keys.push('closed');
    if (!ui.collapsed.open && (model.open || []).length) keys.push('open');
    if (!ui.collapsed.manager) for (const g of model.groups || []) if (!ui.collapsed[`group:${g.key}`] && g.rows.length) keys.push(g.key);
    const sig = keys.join('\n');
    if (sig === lastExpanded) return;
    lastExpanded = sig;
    send({ kind: 'expanded', keys });
  }

  /* ── filtering and searching, over the session manager's rows ── */
  const looksLikeId = (q) => /^[0-9a-f-]{4,}$/i.test(q);
  const term = () => ui.search.trim();
  const statusOf = (row) => (row.dot === 'prompt' || row.dot === 'promptElsewhere' ? 'needs_input'
    : row.dot === 'working' || row.dot === 'workingElsewhere' ? 'working' : 'completed');
  const isActive = (row) => row.unread || statusOf(row) !== 'completed';
  function passes(row) {
    const st = statusOf(row);
    const states = ['needs_input', 'working', 'completed'].filter((k) => ui.status[k]);
    if (states.length && !states.includes(st)) return false;
    const tabs = ['open', 'closed'].filter((k) => ui.status[k]);
    if (tabs.length && !tabs.includes(row.open ? 'open' : 'closed')) return false;
    if (ui.active && !isActive(row)) return false;
    const q = term().toLowerCase();
    if (!q) return true;
    if (row.title.toLowerCase().includes(q) || (row.branch && row.branch.toLowerCase().includes(q))) return true;
    return looksLikeId(q) && row.id.toLowerCase().includes(q);
  }
  const filtering = () => !!(term() || ui.active || Object.keys(ui.status).some((k) => ui.status[k]));
  function filter() {
    if (!model) return;
    const on = filtering();
    let shown = 0, any = 0;
    const seen = new Map();
    for (const ge of groupEls.values()) {
      let n = 0;
      for (const r of ge._p.rows.values()) {
        const ok = !on || passes(r._row);
        if (r._shown !== ok) { r._shown = ok; r.classList.toggle('cp-hidden', !ok); }
        markTitle(r);
        if (ok) n++;
        any++;
        if (!seen.has(r._row.id)) seen.set(r._row.id, r._row);
      }
      shown += n;
      setText(ge._p.count, String(n));
      ge.classList.toggle('cp-hidden', on && n === 0);
    }
    const rows = [...seen.values()];
    setText(activeBtn.lastChild, `Active · ${rows.filter(isActive).length}`);
    activeBtn.classList.toggle('cp-on', ui.active);
    filterBtn.classList.toggle('cp-on', ['needs_input', 'working', 'completed', 'open', 'closed'].some((k) => ui.status[k]));
    searchBox.classList.toggle('cp-hidden', !ui.searchOpen);
    searchBtn.classList.toggle('cp-on', ui.searchOpen);
    clearBtn.classList.toggle('cp-hidden', !ui.search);
    if (searchInput.value !== ui.search) searchInput.value = ui.search;
    const made = (model.groups || []).some((g) => g.made);
    nullText.classList.toggle('cp-hidden', any > 0 || made || on);
    noneText.classList.toggle('cp-hidden', !(on && shown === 0));
    if (!menu.classList.contains('cp-hidden')) drawMenu(rows);
  }

  /* ── the status filter's menu ── */
  const MENU = [['Status'], ['needs_input', 'Needs input'], ['working', 'Working'], ['completed', 'Completed'], ['-'], ['Tabs'], ['open', 'Open'], ['closed', 'Closed']];
  function drawMenu(rows) {
    const counts = { needs_input: 0, working: 0, completed: 0, open: 0, closed: 0 };
    for (const r of rows) { counts[statusOf(r)]++; counts[r.open ? 'open' : 'closed']++; }
    menu.replaceChildren(...MENU.map(([key, label]) => {
      if (key === '-') return el('div', 'cp-menu-sep');
      if (!label) return el('div', 'cp-menu-title', key);
      const item = el('div', `cp-menu-item${ui.status[key] ? ' cp-checked' : ''}`);
      item.tabIndex = 0;
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('aria-checked', ui.status[key] ? 'true' : 'false');
      item.dataset.status = key;
      item.append(icon('check', 'cp-icon cp-check'), el('span', '', label), el('span', 'cp-n', String(counts[key])));
      return item;
    }));
  }
  function openMenu() {
    const rows = [];
    const seen = new Set();
    for (const ge of groupEls.values()) for (const r of ge._p.rows.values()) if (!seen.has(r._row.id)) { seen.add(r._row.id); rows.push(r._row); }
    drawMenu(rows);
    menu.classList.remove('cp-hidden');
    const b = filterBtn.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(b.left, window.innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${b.bottom + 2}px`;
  }
  const closeMenu = () => menu.classList.add('cp-hidden');
  const toggleStatus = (item) => { ui.status[item.dataset.status] = !ui.status[item.dataset.status]; keep(); filter(); };

  /* Keys in the status filter's menu: the arrows move between its items, Enter or Space picks one, Esc closes it. */
  function menuKey(e, box) {
    const items = [...box.querySelectorAll('.cp-menu-item')];
    const item = e.target.closest('.cp-menu-item');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const at = items.indexOf(item), n = items.length, down = e.key === 'ArrowDown';
      const next = items[at < 0 ? (down ? 0 : n - 1) : (at + (down ? 1 : n - 1)) % n];
      if (next) next.focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && item) {
      toggleStatus(item);
    } else if (e.key === 'Escape') {
      closeMenu();
      root.focus();
    } else return false;
    e.preventDefault();
    return true;
  }

  /* ── the right-click menus of rows and group headers ── */
  /*
   * The page draws these menus itself. VS Code's native menu can list only the commands in package.json, so it cannot
   * offer the user's own groups or show a colour swatch. They copy the context menu in Claude Code's webview (its
   * index.js; the class names there end in __ozcbg). The model carries the items and when each is offered (LIST_MENU
   * in src/sessions-view.js).
   */
  const EDGE = 8;
  const SUB_CLOSE_MS = 150;
  let cm = null;
  let swallowClick = false;
  const inCtx = (t) => !!(cm && t && t.closest && t.closest('.cp-ctx'));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /* A when clause of the table: `key == 'value'`, `key` and `!key`, joined by &&. */
  function holds(when, ctx) {
    return String(when || '').split('&&').map((p) => p.trim()).filter(Boolean).every((p) => {
      const m = /^([\w.]+) == '([^']*)'$/.exec(p);
      if (m) return String(ctx[m[1]]) === m[2];
      return p.charAt(0) === '!' ? !ctx[p.slice(1)] : !!ctx[p];
    });
  }
  /* Text Color's submenu, as Claude Code Plus builds it. A colour is checked only when every conversation in `ids` has it. */
  function colorItems(ids) {
    const nameOf = new Map((model.colors || []).map((c) => [c.color, c.name]));
    const of = (id) => { const r = rowsOf(id)[0]; return r && r._row.color ? nameOf.get(r._row.color) || '' : ''; };
    const first = ids.length ? of(ids[0]) : '';
    const current = ids.every((id) => of(id) === first) ? first : null;
    return [{ label: 'Default', pick: '', swatch: '', checked: current === '' },
      ...(model.colors || []).map((c, i) => ({ label: cap(c.name), pick: c.name, swatch: themeColor(c.color), checked: current === c.name,
        separatorBefore: i === 0 }))];
  }
  /* Add to Group's: the groups the user made, except one that already holds every conversation in `ids`. */
  const groupItems = (ids) => (model.groups || []).filter((g) => g.made && !ids.every((id) => g.rows.some((r) => r.id === id)))
    .map((g) => ({ label: g.label, pick: g.key }));
  /* The items for the context of a row or header. An item whose submenu would be empty is left out, as Claude Code does
     with Add to group. */
  function itemsFor(ctx, ids) {
    const at = Object.assign({ 'codexPlus.noGroups': !!model.noGroups }, ctx);
    const out = [];
    let last = '';
    for (const m of model.menu || []) {
      if (!holds(m.when, at)) continue;
      const sub = m.submenu === 'color' ? colorItems(ids) : m.submenu === 'group' ? groupItems(ids) : null;
      if (sub && !sub.length) continue;
      const group = String(m.group).split('@')[0];
      out.push({ label: m.title, command: m.command, submenu: sub, separatorBefore: out.length > 0 && group !== last });
      last = group;
    }
    return out;
  }

  /* Claude Code's placement of a menu opened at x. When its submenu would fit on neither side, the menu moves left to
     make room for one as wide as itself on its right. */
  function mainLeft(x, w, hasSub) {
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - w - EDGE));
    if (!hasSub || left + w - 2 + w <= window.innerWidth - EDGE || left - w + 2 >= EDGE) return left;
    return Math.max(EDGE, window.innerWidth - EDGE - w + 2 - w);
  }
  /* And of a submenu beside its item `at`. With no room on either side, it goes against the edge where it covers less
     of the item. */
  function subLeft(at, w) {
    if (at.right - 2 + w <= window.innerWidth - EDGE) return at.right - 2;
    if (at.left - w + 2 >= EDGE) return at.left - w + 2;
    const right = Math.max(EDGE, window.innerWidth - w - EDGE);
    return EDGE + w - at.left < at.right - right ? EDGE : right;
  }
  const fitTop = (y, h) => Math.max(EDGE, Math.min(y, window.innerHeight - h - EDGE));

  /* An item is a button, as in Claude Code's menu. A colour has Claude Code Plus's swatch before its name. */
  function itemButton(it) {
    const b = el('button', 'cp-ctx-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (typeof it.swatch === 'string') {
      const s = el('span', it.swatch ? 'cp-swatch' : 'cp-swatch cp-swatch-none');
      if (it.swatch) s.style.background = it.swatch;
      const label = el('span', 'cp-ctx-label');
      label.append(s, `${it.label}${it.checked ? ' ✓' : ''}`);
      b.append(label);
    } else b.append(it.label);
    if (it.submenu) {
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      b.append(el('span', 'cp-ctx-chevron', '›'));
    }
    return b;
  }
  function menuBox(items, sub) {
    const box = el('div', sub ? 'cp-ctx cp-ctx-sub' : 'cp-ctx');
    box.setAttribute('role', 'menu');
    const buttons = items.map((it) => {
      if (it.separatorBefore) box.append(el('div', 'cp-ctx-sep'));
      const b = itemButton(it);
      box.append(b);
      return b;
    });
    return { box, buttons };
  }
  const rectOf = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.left + b.width, top: b.top, bottom: b.top + b.height }; };

  function openCtx(x, y, ctx, items) {
    closeCtx();
    closeMenu();
    hideHover();
    const { box, buttons } = menuBox(items, false);
    buttons.forEach((b, i) => b.addEventListener('mouseenter', () => hoverItem(i)));
    box.addEventListener('scroll', () => closeSub(false));
    root.appendChild(box);
    cm = { box, buttons, items, ctx, back: document.activeElement || null, sub: null, subButtons: [], subAt: -1, timer: 0 };
    box.style.left = `${mainLeft(x, box.offsetWidth, items.some((it) => it.submenu))}px`;
    box.style.top = `${fitTop(y, box.offsetHeight)}px`;
    if (buttons[0]) buttons[0].focus();
  }
  const stopTimer = () => { if (cm && cm.timer) { clearTimeout(cm.timer); cm.timer = 0; } };
  /* The pointer on item i: its submenu opens at once; any other item closes an open submenu a moment later. */
  function hoverItem(i) {
    if (!cm) return;
    if (cm.items[i].submenu) { openSub(i, false); return; }
    if (!cm.sub) return;
    stopTimer();
    cm.timer = setTimeout(() => { if (cm) { cm.timer = 0; closeSub(false); } }, SUB_CLOSE_MS);
  }
  function openSub(i, focus) {
    stopTimer();
    if (cm.subAt !== i) {
      closeSub(false);
      const parent = cm.buttons[i];
      const { box, buttons } = menuBox(cm.items[i].submenu, true);
      box.addEventListener('mouseenter', stopTimer);
      root.appendChild(box);
      parent.classList.add('cp-ctx-open');
      parent.setAttribute('aria-expanded', 'true');
      Object.assign(cm, { sub: box, subButtons: buttons, subAt: i });
      const at = rectOf(parent);
      box.style.left = `${subLeft(at, box.offsetWidth)}px`;
      box.style.top = `${fitTop(at.top - 3, box.offsetHeight)}px`;
    }
    if (focus && cm.subButtons[0]) cm.subButtons[0].focus();
  }
  function closeSub(focusParent) {
    stopTimer();
    if (!cm || !cm.sub) return;
    const parent = cm.buttons[cm.subAt];
    cm.sub.remove();
    Object.assign(cm, { sub: null, subButtons: [], subAt: -1 });
    parent.classList.remove('cp-ctx-open');
    parent.setAttribute('aria-expanded', 'false');
    if (focusParent) parent.focus();
  }
  /* Takes the menu off the page, and gives the focus back to where it was if the menu had it. */
  function closeCtx() {
    if (!cm) return;
    const was = cm;
    stopTimer();
    const a = document.activeElement;
    const had = !a || a === document.body || was.box.contains(a) || (!!was.sub && was.sub.contains(a));
    if (was.sub) was.sub.remove();
    was.box.remove();
    cm = null;
    if (had && was.back && was.back.isConnected) was.back.focus({ preventScroll: true });
  }
  /* Runs the item `b`. An item of a submenu sends the command of the item that opened it, with what was picked. */
  function pressItem(b) {
    if (!cm) return;
    const j = cm.subButtons.indexOf(b);
    const i = j >= 0 ? cm.subAt : cm.buttons.indexOf(b);
    const it = cm.items[i];
    if (!it) return;
    if (j < 0 && it.submenu) { openSub(i, true); return; }
    const msg = { kind: 'menu', command: it.command, context: cm.ctx };
    if (j >= 0) msg.pick = it.submenu[j].pick;
    closeCtx();
    send(msg);
  }
  /* Claude Code's keys, except that Esc closes an open submenu before the menu. Other keys are ignored while the menu
     has the focus; typing would otherwise start a search behind it. */
  function ctxKey(e) {
    const inSub = !!cm.sub && cm.sub.contains(e.target);
    const list = inSub ? cm.subButtons : cm.buttons;
    const b = e.target.closest('.cp-ctx-item');
    const at = b ? list.indexOf(b) : -1;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      if (!inSub) closeSub(false);
      const n = list.length, down = k === 'ArrowDown';
      const next = list[at < 0 ? (down ? 0 : n - 1) : (at + (down ? 1 : n - 1)) % n];
      if (next) next.focus();
    } else if (k === 'ArrowRight') {
      if (!inSub && at >= 0 && cm.items[at].submenu) openSub(at, true);
    } else if (k === 'ArrowLeft') {
      if (inSub) closeSub(true);
    } else if (k === 'Enter' || k === ' ') {
      if (b) pressItem(b);
    } else if (k === 'Escape') {
      if (cm.sub) closeSub(inSub); else closeCtx();
    } else if (k !== 'Tab') return;
    e.preventDefault();
  }
  /* Opens the menu of a row or a group header: where the pointer is for a right-click, under the row for a key. */
  function openFor(where, e) {
    if (!model || !where._ctx || where._editing || where.querySelector('.cp-editing')) return false;
    const items = itemsFor(where._ctx, where._ctx.webviewSection === 'thread' ? [...selection] : []);
    if (!items.length) return false;
    const at = rectOf(where);
    const pointer = !!e && typeof e.clientX === 'number' && !!(e.clientX || e.clientY);
    openCtx(pointer ? e.clientX : at.left + 8, pointer ? e.clientY : at.bottom, where._ctx, items);
    return true;
  }
  /* A row whose menu opens is selected alone if it was not selected, and the menu's commands act on the selection. */
  function aimAt(r) {
    ctxRow = r;
    if (!selection.has(r._row.id)) { anchor = r._row.id; select([r._row.id]); }
    highlight(r, false);
  }

  /* ── selection ── */
  const onScreen = (r) => !r.closest('.cp-hidden, .cp-section:not(.cp-open), .cp-group:not(.cp-open)');
  function visibleRows() {
    return [...root.querySelectorAll('.cp-row')].filter(onScreen);
  }
  function paintSelection() {
    for (const r of root.querySelectorAll('.cp-row.cp-selected')) if (!selection.has(r.dataset.id)) r.classList.remove('cp-selected');
    for (const id of selection) for (const r of rowsOf(id)) r.classList.add('cp-selected');
  }
  function select(ids) {
    selection = new Set(ids);
    paintSelection();
    send({ kind: 'select', ids: [...selection] });
  }
  /* `scroll` is false where a scroll would close the menu being opened. */
  function highlight(r, scroll = true) {
    if (hl && hl !== r) hl.classList.remove('cp-hl');
    hl = r || null;
    if (hl) { hl.classList.add('cp-hl'); if (scroll) hl.scrollIntoView({ block: 'nearest' }); }
  }
  function openRow(r) {
    if (!r || !r._row) return;
    send({ kind: 'open', id: r._row.id, where: r._row.sidebar ? 'sidebar' : 'tab' });
  }

  /* ── editing a title or a group's name where it is drawn ── */
  function editText(span, was, done) {
    span.textContent = was;
    span.contentEditable = 'true';
    span.classList.add('cp-editing');
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let over = false;
    const finish = (commit) => {
      if (over) return;
      over = true;
      span.removeEventListener('keydown', onKey);
      span.removeEventListener('blur', onBlur);
      const text = span.textContent.replace(/\s+/g, ' ').trim();
      span.contentEditable = 'false';
      span.classList.remove('cp-editing');
      done(commit && text && text !== was ? text : '');
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); root.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); root.focus(); }
      e.stopPropagation();
    };
    const onBlur = () => finish(true);
    span.addEventListener('keydown', onKey);
    span.addEventListener('blur', onBlur);
  }
  /* The row of `id` that a command from the host acts on: the right-clicked one, or else the first one on screen. */
  function rowFor(id) {
    if (ctxRow && ctxRow.isConnected && ctxRow._row.id === id) return ctxRow;
    const all = [openRows.get(id), ...[...groupEls.values()].map((ge) => ge._p.rows.get(id)), closedRows.get(id)].filter(Boolean);
    return all.find(onScreen) || all[0] || null;
  }
  function startRename(r) {
    if (!r || r._editing) return;
    const id = r._row.id;
    expand(r);
    r._editing = true;
    r.draggable = false;
    editText(r._p.title, r._row.title, (title) => {
      r._editing = false;
      r.draggable = true;
      if (title) { r._row = Object.assign({}, r._row, { title }); send({ kind: 'rename', id, title }); }
      r._mark = '';
      markTitle(r);
    });
  }
  function renameGroup(key) {
    const ge = groupEls.get(key);
    if (!ge) { renameGroupKey = key; return; }
    renameGroupKey = '';
    if (ge._p.name.isContentEditable) return;
    if (ui.collapsed.manager) { ui.collapsed.manager = false; manager.s.classList.add('cp-open'); keep(); }
    ge._p.head.scrollIntoView({ block: 'nearest' });
    editText(ge._p.name, ge._g.label, (name) => {
      ge._p.name.textContent = name || ge._g.label;
      if (name) send({ kind: 'renameGroup', key, name });
    });
  }
  /* Opens the section and group a row is in, so that it can be seen. */
  function expand(r) {
    const s = r.closest('.cp-section'), g = r.closest('.cp-group');
    if (s && !s.classList.contains('cp-open')) toggle(s.dataset.key);
    if (g && !g.classList.contains('cp-open')) toggle(`group:${g.dataset.key}`);
  }
  function toggle(key) {
    ui.collapsed[key] = !ui.collapsed[key];
    keep();
    if (key.startsWith('group:')) { const ge = groupEls.get(key.slice(6)); if (ge) ge.classList.toggle('cp-open', !ui.collapsed[key]); }
    else { const s = root.querySelector(`.cp-section[data-key="${key}"]`); if (s) s.classList.toggle('cp-open', !ui.collapsed[key]); }
    expanded();
  }

  /* ── the hover box: the group and the session ID, as Claude Code Plus shows them ── */
  const HOVER_MS = 600;
  let hoverTimer = 0, hoverRow = null;
  function hideHover() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
    hoverRow = null;
    hoverBox.classList.add('cp-hidden');
  }
  function showHover(r) {
    hideHover();
    hoverRow = r;
    hoverTimer = setTimeout(() => {
      hoverTimer = 0;
      if (!r.isConnected || hoverRow !== r || !r._row) return;
      const under = r._row.child ? `\nSub-agent${r._row.nickname ? ` ${r._row.nickname}` : ''} of: ${r._row.parentTitle}` : '';
      hoverBox.textContent = `Group: ${r._row.group}\nSession ID: ${r._row.id}${under}${r._row.goalText ? `\n${r._row.goalText}` : ''}`;
      hoverBox.classList.remove('cp-hidden');
      /* Placed as agentPlusKit.labels places Claude Code Plus's: centred on the row, 8 px above it when that fits in
         the window and 8 px below it otherwise, and kept 8 px inside the window's sides. */
      const b = r.getBoundingClientRect();
      const w = hoverBox.offsetWidth, h = hoverBox.offsetHeight;
      const left = b.left + b.width / 2 - w / 2;
      hoverBox.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, left)))}px`;
      hoverBox.style.top = `${Math.round(b.top - h - 8 >= 8 ? b.top - h - 8 : b.bottom + 8)}px`;
    }, HOVER_MS);
  }

  /* ── events ── */
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (swallowClick) { swallowClick = false; e.preventDefault(); return; }
    const ctxItem = t.closest('.cp-ctx-item');
    if (ctxItem) { pressItem(ctxItem); return; }
    if (t.closest('.cp-ctx')) return;
    if (!t.closest('.cp-menu') && !t.closest('[data-tool="filter"]')) closeMenu();
    const act = t.closest('.cp-act');
    if (act) { e.stopPropagation(); const r = act.closest('.cp-row'); if (r && act.dataset.act === 'rename') startRename(r); return; }
    const sendBtn = t.closest('[data-send]');
    if (sendBtn) { send({ kind: sendBtn.dataset.send }); return; }
    const tool = t.closest('[data-tool]');
    if (tool) {
      const k = tool.dataset.tool;
      if (k === 'filter') { if (menu.classList.contains('cp-hidden')) openMenu(); else closeMenu(); }
      else if (k === 'active') { ui.active = !ui.active; keep(); filter(); }
      else if (k === 'search') { ui.searchOpen = !ui.searchOpen; if (!ui.searchOpen) ui.search = ''; keep(); filter(); if (ui.searchOpen) searchInput.focus(); }
      else if (k === 'clear') { ui.search = ''; keep(); filter(); searchInput.focus(); }
      return;
    }
    const item = t.closest('.cp-menu-item');
    if (item) { toggleStatus(item); return; }
    const sectionToggle = t.closest('[data-toggle]');
    if (sectionToggle) { toggle(sectionToggle.dataset.toggle); return; }
    const gh = t.closest('.cp-group-head');
    if (gh && !t.closest('.cp-editing')) { toggle(`group:${gh.dataset.group}`); return; }
    const r = t.closest('.cp-row');
    if (!r || r._editing) return;
    const id = r._row.id;
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id); else next.add(id);
      anchor = id;
      select([...next]);
      highlight(r);
      return;
    }
    if (e.shiftKey && anchor) {
      const list = visibleRows();
      const a = list.findIndex((x) => x._row.id === anchor), b = list.indexOf(r);
      if (a >= 0 && b >= 0) { select(list.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x._row.id)); highlight(r); return; }
    }
    anchor = id;
    select([id]);
    highlight(r);
    openRow(r);
  });
  /* A right-click on a row or a group header opens the page's menu and cancels the event. VS Code opens its own menu
     for any right-click that reaches it uncancelled (webview/browser/pre/index.html). */
  root.addEventListener('contextmenu', (e) => {
    hideHover();
    closeMenu();
    if (inCtx(e.target)) { e.preventDefault(); return; }
    closeCtx();
    const r = e.target.closest('.cp-row');
    ctxRow = r || null;
    if (r) aimAt(r);
    const where = r || e.target.closest('.cp-group-head');
    if (where && openFor(where, e)) e.preventDefault();
  });
  /* A press outside the menu closes it. As in Claude Code's menu, a left click there does nothing else, so it does not
     also open a row. */
  root.addEventListener('mousedown', (e) => {
    swallowClick = false;
    if (cm && !inCtx(e.target)) { swallowClick = e.button === 0; closeCtx(); }
  });
  root.addEventListener('wheel', (e) => { if (cm && (e.deltaX || e.deltaY) && !inCtx(e.target)) closeCtx(); }, { passive: true });
  root.addEventListener('mouseover', (e) => {
    const r = e.target.closest('.cp-row');
    if (r && r !== hoverRow && !r._editing) showHover(r);
    else if (!r && hoverRow) hideHover();
  });
  root.addEventListener('mouseleave', hideHover);
  root.addEventListener('mousedown', hideHover);
  root.addEventListener('scroll', () => { hideHover(); closeMenu(); closeCtx(); }, { passive: true });

  searchInput.addEventListener('input', () => { ui.search = searchInput.value; keep(); filter(); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (ui.search) { ui.search = ''; } else { ui.searchOpen = false; } keep(); filter(); root.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); root.focus(); highlight(visibleRows()[0]); }
    else if (e.key === 'Enter') { e.preventDefault(); const first = hl || visibleRows().find((r) => r.closest('.cp-group')); if (first) openRow(first); }
  });

  root.addEventListener('keydown', (e) => {
    if (e.target === searchInput || e.target.isContentEditable) return;
    if (inCtx(e.target)) { ctxKey(e); return; }
    const inMenu = e.target.closest && e.target.closest('.cp-menu');
    if (inMenu && menuKey(e, inMenu)) return;
    /* Shift+F10 and the menu key open the menu of the focused or highlighted row. Chromium on macOS does not turn
       Shift+F10 into a contextmenu event. */
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const r = (e.target.closest && e.target.closest('.cp-row')) || hl;
      if (r && r._row && onScreen(r)) { e.preventDefault(); closeCtx(); aimAt(r); openFor(r, null); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = visibleRows();
      if (!list.length) return;
      const at = hl ? list.indexOf(hl) : -1;
      highlight(list[e.key === 'ArrowDown' ? Math.min(list.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)]);
      return;
    }
    if (e.key === 'Enter' && hl) { e.preventDefault(); openRow(hl); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      closeCtx();
      if (ui.search) { ui.search = ''; keep(); filter(); } else if (selection.size) select([]); else highlight(null);
      return;
    }
    /* Typing in the list starts a search, as in Claude Code's list. */
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      ui.searchOpen = true;
      ui.search += e.key;
      keep();
      filter();
      searchInput.focus();
      e.preventDefault();
    }
  });

  /* ── dragging rows onto a group ── */
  const DRAG = 'application/x-codex-plus-threads';
  let dragging = null;
  root.addEventListener('dragstart', (e) => {
    const r = e.target.closest && e.target.closest('.cp-row');
    if (!r || r._editing) return;
    hideHover();
    const ids = selection.has(r._row.id) ? [...selection] : [r._row.id];
    dragging = ids;
    e.dataTransfer.setData(DRAG, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
  });
  root.addEventListener('dragend', () => { dragging = null; for (const h of root.querySelectorAll('.cp-drop')) h.classList.remove('cp-drop'); });
  const target = (e) => {
    const h = e.target.closest && e.target.closest('.cp-group-head');
    const ge = h && groupEls.get(h.dataset.group);
    return ge && (ge._g.made || ge._g.key === 'ungrouped') ? h : null;
  };
  root.addEventListener('dragover', (e) => {
    const h = target(e);
    if (!h || !dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    h.classList.add('cp-drop');
  });
  root.addEventListener('dragleave', (e) => { const h = target(e); if (h && !h.contains(e.relatedTarget)) h.classList.remove('cp-drop'); });
  root.addEventListener('drop', (e) => {
    const h = target(e);
    if (!h) return;
    e.preventDefault();
    h.classList.remove('cp-drop');
    let ids = dragging;
    try { ids = JSON.parse(e.dataTransfer.getData(DRAG) || 'null') || ids; } catch (_) { /* the drag's own list */ }
    dragging = null;
    if (Array.isArray(ids) && ids.length) send({ kind: 'move', ids, key: h.dataset.group });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'model') apply(msg.model);
    else if (msg.type === 'startRename' && typeof msg.id === 'string') startRename(rowFor(msg.id));
    else if (msg.type === 'startRenameGroup' && typeof msg.key === 'string') renameGroup(msg.key);
  });
  window.addEventListener('blur', () => { hideHover(); closeMenu(); closeCtx(); });
  window.addEventListener('resize', closeCtx);
  filter();
  send({ kind: 'ready' });
}());
