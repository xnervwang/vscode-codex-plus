// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

/*
 * Page script for the Codex session list webview (src/sessions-view.js SessionsView). The host posts { type: 'model' }
 * whenever the list changes. The page lays it out like Claude Code's list, with Claude Code Plus's OPEN SESSIONS and
 * RECENTLY CLOSED above the session manager.
 *
 * Elements are kept per key (row id, group key) and reused, and a field is written only when its value differs, so a
 * model in which one row changed touches that row alone. Filters and search run over the model already in the page and
 * toggle only rows whose visibility changes. Messages to the host carry user actions only. The hover delay is the
 * page's only timer.
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
  const context = (e, value) => {
    const v = JSON.stringify(Object.assign({ preventDefaultContextMenuItems: true }, value));
    if (e.getAttribute('data-vscode-context') !== v) e.setAttribute('data-vscode-context', v);
  };
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
  context(root, {});

  /* ── rows ── */
  function makeRow() {
    const r = el('div', 'cp-row');
    r.tabIndex = -1;
    r.draggable = true;
    const dot = el('span', 'cp-dot');
    const title = el('span', 'cp-title');
    const meta = el('span', 'cp-meta');
    const time = el('span', 'cp-time');
    const acts = el('span', 'cp-actions');
    const rename = button('cp-act', 'Rename', icon('pencil'));
    rename.dataset.act = 'rename';
    acts.appendChild(rename);
    meta.append(time, acts);
    r.append(dot, title, meta);
    r._p = { dot, title, time };
    r._sig = '';
    r._mark = '';
    return r;
  }
  const themeColor = (id) => (id ? `var(--vscode-${String(id).replace(/\./g, '-')})` : '');
  function fillRow(r, row, place) {
    r._row = row;
    r._place = place;
    const sig = `${row.id}\u0001${row.title}\u0001${row.time}\u0001${row.dot}\u0001${row.color}\u0001${row.grouped}\u0001${row.unread}`;
    if (sig === r._sig) return;
    r._sig = sig;
    r.dataset.id = row.id;
    r._p.dot.className = `cp-dot d-${row.dot}`;
    if (!r._editing) { r._mark = ''; markTitle(r); }
    r._p.title.style.color = themeColor(row.color);
    setText(r._p.time, row.time);
    context(r, { webviewSection: 'thread', threadId: row.id, codexPlusGrouped: !!row.grouped, codexPlusUnread: !!row.unread });
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
    for (const [id, r] of cache) if (!seen.has(id)) { if (r === hl) hl = null; r.remove(); cache.delete(id); }
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
      context(ge._p.head, { webviewSection: 'group', groupKey: g.key, codexPlusMade: !!g.made });
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

  /* ── selection ── */
  function visibleRows() {
    return [...root.querySelectorAll('.cp-row')].filter((r) => !r.closest('.cp-hidden, .cp-section:not(.cp-open), .cp-group:not(.cp-open)'));
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
  function highlight(r) {
    if (hl && hl !== r) hl.classList.remove('cp-hl');
    hl = r || null;
    if (hl) { hl.classList.add('cp-hl'); hl.scrollIntoView({ block: 'nearest' }); }
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
  function startRename(id) {
    const r = openRows.get(id) || [...groupEls.values()].map((ge) => ge._p.rows.get(id)).find(Boolean) || closedRows.get(id);
    if (!r || r._editing) return;
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
      hoverBox.textContent = `Group: ${r._row.group}\nSession ID: ${r._row.id}`;
      hoverBox.classList.remove('cp-hidden');
      const b = r.getBoundingClientRect();
      const w = hoverBox.offsetWidth, h = hoverBox.offsetHeight;
      hoverBox.style.left = `${Math.max(4, Math.min(b.left + 8, window.innerWidth - w - 4))}px`;
      hoverBox.style.top = `${b.bottom + 4 + h <= window.innerHeight ? b.bottom + 4 : Math.max(4, b.top - h - 4)}px`;
    }, HOVER_MS);
  }

  /* ── events ── */
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (!t.closest('.cp-menu') && !t.closest('[data-tool="filter"]')) closeMenu();
    const act = t.closest('.cp-act');
    if (act) { e.stopPropagation(); const r = act.closest('.cp-row'); if (r && act.dataset.act === 'rename') startRename(r._row.id); return; }
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
    if (item) { ui.status[item.dataset.status] = !ui.status[item.dataset.status]; keep(); filter(); return; }
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
  /* A right-click on a row outside the selection acts on that row alone; VS Code's own menu is drawn from the row's
     data-vscode-context, so only the selection the host keeps has to follow. */
  root.addEventListener('contextmenu', (e) => {
    hideHover();
    closeMenu();
    const r = e.target.closest('.cp-row');
    if (r && !selection.has(r._row.id)) { anchor = r._row.id; select([r._row.id]); }
    if (r) highlight(r);
  });
  root.addEventListener('mouseover', (e) => {
    const r = e.target.closest('.cp-row');
    if (r && r !== hoverRow && !r._editing) showHover(r);
    else if (!r && hoverRow) hideHover();
  });
  root.addEventListener('mouseleave', hideHover);
  root.addEventListener('mousedown', hideHover);
  root.addEventListener('scroll', () => { hideHover(); closeMenu(); }, { passive: true });

  searchInput.addEventListener('input', () => { ui.search = searchInput.value; keep(); filter(); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (ui.search) { ui.search = ''; } else { ui.searchOpen = false; } keep(); filter(); root.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); root.focus(); highlight(visibleRows()[0]); }
    else if (e.key === 'Enter') { e.preventDefault(); const first = hl || visibleRows().find((r) => r.closest('.cp-group')); if (first) openRow(first); }
  });

  root.addEventListener('keydown', (e) => {
    if (e.target === searchInput || e.target.isContentEditable) return;
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
    else if (msg.type === 'startRename' && typeof msg.id === 'string') startRename(msg.id);
    else if (msg.type === 'startRenameGroup' && typeof msg.key === 'string') renameGroup(msg.key);
  });
  window.addEventListener('blur', () => { hideHover(); closeMenu(); });
  filter();
  send({ kind: 'ready' });
}());
