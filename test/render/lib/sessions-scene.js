// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The render check's `sessions` scene. It loads src/page/sessions-page.js, with the content policy src/sessions-view.js
 * sets, in a headless Chromium at sidebar width, using the Dark Modern theme variables and the webview API stand-in in
 * harness/vscode-stub.js. It posts made-up models and checks layout that only a real browser computes: Claude Code's
 * sizes, the time flush right, the rename button replacing the time on hover, the two new-conversation buttons side by
 * side, Claude Code's look and placement for the right-click menus, and draw and search times at 200 and 1000 rows. It
 * also reads the renderer's memory with the list shown and with a blank page. It needs no Codex.
 */
const fs = require('fs');
const path = require('path');
const { serve, launch, sleep } = require('./cdp');
const { pageHtml, COLORS, COLOR_NAMES, LIST_MENU, chatFont } = require('../../../src/sessions-view');

const ROOT = path.join(__dirname, '..', '..', '..');
const HARNESS = path.join(__dirname, '..', 'harness');
const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const DOTS = ['idle', 'working', 'prompt', 'unread', 'idle', 'workingElsewhere', 'failed', 'idle', 'unknown', 'promptElsewhere'];
const TITLES = ['Fix the retry delay in the inventory sync', 'Why does the nightly export skip archived rows?', 'Add a dry-run flag to the cleanup script',
  'Review the cache eviction change', 'Split the settings page into two', 'Upgrade the test runner', 'Trace the slow login on staging',
  'Rename the billing columns', 'Write the migration for the new index', 'Explain the flaky upload test'];

/* A model of `n` conversations in three groups and Ungrouped, as SessionsModel.model() makes one. A row may be
   deleted unless it is open here, running or waiting for the user (BUSY_LOOKS in src/sessions-view.js). */
const BUSY = ['working', 'workingElsewhere', 'prompt', 'promptElsewhere'];
function fakeModel(n, { stamp = '' } = {}) {
/* An idle conversation not open in this window has no dot, as the host draws it (SessionsModel.build). */
  const dotOf = (i) => (DOTS[i % DOTS.length] === 'idle' && i >= 2 ? 'none' : DOTS[i % DOTS.length]);
  const row = (i, extra = {}) => ({ id: ID(i), title: `${TITLES[i % TITLES.length]}${i >= TITLES.length ? ` (${i})` : ''}`,
    time: `${(i % 9) + 1}d · 11/0${(i % 9) + 1}→11/09${stamp}`, dot: dotOf(i), color: i % 7 === 3 ? 'charts.purple' : '',
    open: i < 2, sidebar: false, unread: DOTS[i % DOTS.length] === 'unread', grouped: false, group: 'Ungrouped', branch: i % 4 ? '' : `fix/${i}`,
    deletable: i >= 2 && !BUSY.includes(dotOf(i)), ...extra });
  const rows = Array.from({ length: n }, (_, i) => row(i));
  const groups = [{ key: 'section:a', label: 'Release 1.2', made: true, rows: [] }, { key: 'section:b', label: 'Investigations', made: true, rows: [] },
    { key: 'section:e', label: 'Later', made: true, rows: [] }, { key: 'ungrouped', label: 'Ungrouped', made: false, rows: [] }];
  rows.forEach((r, i) => {
    const g = i % 5 === 1 ? groups[0] : i % 5 === 2 ? groups[1] : groups[3];
    if (g !== groups[3]) Object.assign(r, { grouped: true, group: g.label });
    g.rows.push(r);
  });
  return { account: { account: [{ label: 'Signed in with', value: 'Amazon Bedrock' }], windows: [], tokens: [] },
    closed: [row(n + 1, { title: 'Closed this morning' }), row(n + 2, { title: 'Closed yesterday' })],
    open: rows.slice(0, 2), groups, front: ID(0), noGroups: false, menu: LIST_MENU, colors: COLOR_NAMES.map((name) => ({ name, color: COLORS[name] })),
    font: chatFont(() => undefined) };
}

/* Proportional set size of a process, in MB, from /proc; 0 where that cannot be read. */
function pssMb(pid) {
  try { const m = /^Pss:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')); return m ? +m[1] / 1024 : 0; } catch (_) { return 0; }
}
/* The renderer processes of the browser started with `userDataDir`. */
function renderers(userDataDir) {
  /* A zygote's children rewrite their command line into one string with spaces, so it is searched as text. */
  const procs = [];
  for (const d of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ');
      const ppid = +/^PPid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${d}/status`, 'utf8'))[1];
      procs.push({ pid: +d, ppid, cmd });
    } catch (_) { /* gone */ }
  }
  const browser = procs.find((p) => p.cmd.includes(`--user-data-dir=${userDataDir} `) && !p.cmd.includes('--type='));
  if (!browser) return [];
  const mine = new Set([browser.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs) if (!mine.has(p.pid) && mine.has(p.ppid)) { mine.add(p.pid); grew = true; }
  }
  return procs.filter((p) => mine.has(p.pid) && p.cmd.includes('--type=renderer')).map((p) => p.pid);
}

async function open(env, dir, { width = 360, height = 900 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const nonce = 'n0n0n0n0n0n0n0n0n0n0n0n0n0n0n0n0';
  let html = pageHtml({ js: '/page/sessions-page.js', css: '/page/sessions-page.css', csp: 'http://127.0.0.1:*', nonce });
  html = html.replace(`<script nonce="${nonce}" src="/page/sessions-page.js">`,
    `<script nonce="${nonce}" src="/harness/vscode-stub.js"></script>\n<script nonce="${nonce}" src="/page/sessions-page.js">`);
  const srv = await serve({ '/page/': path.join(ROOT, 'src', 'page'), '/harness/': HARNESS }, {
    '/sessions.html': () => ({ body: html }),
    '/blank.html': () => ({ body: '<!DOCTYPE html><html><body></body></html>' }),
  });
  const userDataDir = path.join(dir, 'chrome-profile');
  const b = await launch({ chrome: env.chrome, width, height, userDataDir });
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
  await b.send('Performance.enable');
  return { b, srv, userDataDir, port: srv.port, close: async () => { await b.close(); await srv.close(); } };
}

async function run({ env, check, shots, out, results }) {
  console.log('\n── sessions');
  const r = results.scenes.sessions = { measures: {} };
  const work = path.join(out, 'work', 'sessions');

  /* A blank page first, for the renderer's memory with nothing of ours in it. */
  const blank = await open(env, path.join(work, 'blank'));
  try {
    await blank.b.navigate(`http://127.0.0.1:${blank.port}/blank.html`);
    await sleep(1500);
    r.blankPssMb = renderers(blank.userDataDir).map(pssMb).filter(Boolean);
  } finally { await blank.close(); }

  const s = await open(env, path.join(work, 'page'));
  const b = s.b;
  const toPage = (msg) => b.evaluate(`window.__fromHost(${JSON.stringify(msg)})`);
  const shot = (name, clip) => b.screenshot(path.join(shots, `${name}.png`), clip);
  try {
    await b.navigate(`http://127.0.0.1:${s.port}/sessions.html`);
    for (let i = 0; i < 50; i++) { if (await b.evaluate('(window.__posted || []).some((m) => m.kind === "ready")')) break; await sleep(100); }
    check(await b.evaluate('(window.__posted || []).some((m) => m.kind === "ready")'), 'sessions: the page says it is ready');
    const small = fakeModel(14);
    small.groups[2].rows = [];
    await toPage({ type: 'model', model: small });
    await sleep(300);
    await shot('sessions-list');
    const m = await b.evaluate(`(() => {
      const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x0: b.left, y0: b.top, x1: b.right, y1: b.bottom, w: b.width, h: b.height }; };
      const st = (e) => (e ? getComputedStyle(e) : null);
      const rows = [...document.querySelectorAll('.cp-group .cp-row')].filter((x) => x.offsetParent);
      const label = document.querySelector('.cp-section[data-key="open"] .cp-section-label');
      const gname = document.querySelector('.cp-group-name');
      const news = [...document.querySelectorAll('.cp-new')].map(box);
      return {
        rowH: rows.map((x) => x.getBoundingClientRect().height),
        rowRadius: st(rows[0]).borderRadius, rowGap: st(rows[0]).gap,
        dots: rows.map((x) => box(x.querySelector('.cp-dot'))).map((d) => [d.w, d.h]),
        timeRight: rows.map((x) => Math.round(x.getBoundingClientRect().right - x.querySelector('.cp-time').getBoundingClientRect().right)),
        titleEnds: rows.map((x) => Math.round(x.querySelector('.cp-time').getBoundingClientRect().left - x.querySelector('.cp-title').getBoundingClientRect().right)),
        label: { text: label.textContent, transform: st(label).textTransform, size: st(label).fontSize, weight: st(label).fontWeight, spacing: st(label).letterSpacing,
          color: st(label).color },
        group: { size: st(gname).fontSize, weight: st(gname).fontWeight, color: st(gname).color },
        badge: (() => { const h = document.querySelector('.cp-group-head'), c = h.querySelector('.cp-group-count'); return { gap: Math.round(h.getBoundingClientRect().right - c.getBoundingClientRect().right), bg: st(c).backgroundColor, size: st(c).fontSize }; })(),
        news, headH: box(document.querySelector('.cp-group-head')).h, sectionH: box(document.querySelector('.cp-section-head')).h,
        rootSize: st(document.querySelector('.cp-root')).fontSize,
        filterRow: [...document.querySelectorAll('.cp-filter-row > .cp-tool, .cp-filter-row .cp-tail')].map(box).map((x) => Math.round(x.y0)),
      };
    })()`);
    r.measures.list = m;
    check(m.rowH.length > 0 && m.rowH.every((h) => h === 28), 'sessions: every row is 28 px high, as in Claude Code\'s list', m.rowH);
    check(m.rowRadius === '6px' && m.rowGap === '8px', 'sessions: rows have 6 px corners and 8 px between their parts', [m.rowRadius, m.rowGap]);
    check(m.dots.some(([w]) => w > 0) && m.dots.filter(([w]) => w > 0).every(([w, h]) => w === 8 && h === 8), 'sessions: every status dot drawn is 8 by 8 px', m.dots);
    check(m.timeRight.every((x) => x === 8), 'sessions: every time ends at the row\'s right edge, inside its 8 px padding', m.timeRight);
    check(m.titleEnds.every((x) => x >= 8), 'sessions: the title stops at least 8 px short of the time', m.titleEnds);
    const px = (v, want) => Math.abs(parseFloat(v) - want) < 0.01;
    check(m.label.transform === 'uppercase' && px(m.label.size, 13 * 0.85) && m.label.weight === '600' && m.label.spacing === '0.5px'
      && m.label.color === 'rgb(157, 157, 157)', 'sessions: section labels are capitals at 0.85em, weight 600, 0.5 px apart, in the secondary colour', m.label);
    check(px(m.group.size, 13 * 0.9) && m.group.weight === '600' && m.group.color === 'rgb(157, 157, 157)',
      'sessions: group names are 0.9em, weight 600, in the secondary colour, and not in capitals', m.group);
    check(m.badge.gap === 8 && m.badge.bg === 'rgb(97, 97, 97)', 'sessions: a group\'s count is a badge at the right of its header', m.badge);
    check(m.news.length === 2 && Math.abs(m.news[0].y0 - m.news[1].y0) < 1 && Math.abs(m.news[0].w - m.news[1].w) < 2 && m.news[0].x1 <= m.news[1].x0,
      'sessions: New in tab and New in sidebar are side by side, each half the width', m.news);
    check(m.headH === 26 && m.sectionH === 26, 'sessions: group and section headers are 26 px high', [m.headH, m.sectionH]);
    check(new Set(m.filterRow).size === 1, 'sessions: the filter row\'s controls sit on one line', m.filterRow);

    /* Where both lists have the same thing, the look is Claude Code Plus's (test/parts/35p-sessions-style.js has the values). */
    const look = await b.evaluate(`(() => {
      const st = (e) => getComputedStyle(e);
      const rows = [...document.querySelectorAll('.cp-row')].filter((x) => x.offsetParent);
      const label = document.querySelector('.cp-account-label'), kv = document.querySelector('.cp-kv'), name = kv && kv.firstElementChild;
      const icon = (sel) => { const s = document.querySelector(sel); return s ? [st(s).fill, st(s).stroke] : null; };
      const act = (rows[0] || document).querySelector('.cp-act svg');
      const dot = (x) => { const d = x.querySelector('.cp-dot'); const c = st(d); return [d.className.replace('cp-dot d-', ''), c.display === 'none' ? '' : c.backgroundColor, c.borderTopColor]; };
      return {
        dots: rows.map(dot),
        icons: { funnel: icon('[data-tool="filter"] svg'), bolt: icon('[data-tool="active"] svg') },
        font: [st(document.querySelector('.cp-root')).fontFamily, st(document.querySelector('.cp-root')).fontSize],
        account: label && { opacity: st(label).opacity, colour: st(label).color, size: st(label).fontSize, pad: st(kv).paddingTop, nameOpacity: st(name).opacity, nameColour: st(name).color },
        chevron: st(document.querySelector('.cp-chevron')).transitionDuration,
        rename: act ? [act.getBoundingClientRect().width, act.getBoundingClientRect().height, act.closest('.cp-act').getAttribute('aria-label')] : null,
        noDot: rows.filter((x) => st(x.querySelector('.cp-dot')).display === 'none').map((x) => Math.round(x.querySelector('.cp-title').getBoundingClientRect().left - x.getBoundingClientRect().left)),
      };
    })()`);
    r.measures.look = look;
    const TONE = { working: ['rgb(34, 197, 94)'], prompt: ['rgb(59, 130, 246)'], unread: ['rgb(239, 68, 68)'], failed: ['rgb(248, 81, 73)'],
      workingElsewhere: ['rgba(0, 0, 0, 0)', 'rgb(34, 197, 94)'], promptElsewhere: ['rgba(0, 0, 0, 0)', 'rgb(59, 130, 246)'] };
    check(Object.keys(TONE).every((k) => look.dots.some(([s]) => s === k)) && look.dots.every(([s, bg, edge]) => !TONE[s] || (bg === TONE[s][0] && (!TONE[s][1] || edge === TONE[s][1]))),
      'sessions: the dots are Claude Code Plus\'s #22c55e, #3b82f6 and #ef4444, rings in the same colours, failed in errorForeground', look.dots);
    check(look.dots.some(([s]) => s === 'none') && look.noDot.length > 0 && look.noDot.every((x) => x === 8),
      'sessions: an idle row not open here has no dot, and its title starts at the row\'s 8 px padding, as in Claude Code\'s list', look.noDot);
    check(['funnel', 'bolt'].every((k) => look.icons[k] && look.icons[k][0] !== 'none' && look.icons[k][1] === 'none'), 'sessions: the funnel and the bolt are solid shapes', look.icons);
    check(/BlinkMacSystemFont/.test(look.font[0]) && look.font[1] === '13px', 'sessions: the list is in the chat font the host sent, Claude Code\'s own default here', look.font);
    check(!!look.account && look.account.opacity === '0.7' && look.account.colour === 'rgb(204, 204, 204)' && look.account.size === '12px' && look.account.pad === '4px'
      && look.account.nameOpacity === '0.7' && look.account.nameColour === 'rgb(204, 204, 204)',
    'sessions: ACCOUNT is the foreground at 70% and 12 px, and each row has 4 px above it with its name at 70%, as in Claude Code', look.account);
    check(look.chevron === '0s', 'sessions: a chevron turns without an animation, as Claude Code\'s', look.chevron);
    check(!!look.rename && look.rename[0] === 20 && look.rename[1] === 20 && look.rename[2] === 'Rename session', 'sessions: a row\'s rename button has a 20 px icon and says "Rename session"', look.rename);

    /* An expanded section leaves 10 px under its last row before the next section; a collapsed one leaves none. */
    const gapBelowOpen = () => b.evaluate(`(() => {
      const s = document.querySelector('.cp-section[data-key="open"]');
      const open = s.classList.contains('cp-open');
      const below = s.querySelector(open ? '.cp-section-body' : '.cp-section-head').getBoundingClientRect().bottom;
      return { open, gap: Math.round(s.nextElementSibling.getBoundingClientRect().top - below) };
    })()`);
    const toggleOpen = async () => {
      await b.evaluate(`document.querySelector('.cp-section[data-key="open"] .cp-section-head').click()`);
      await sleep(100);
    };
    const expanded = await gapBelowOpen();
    await shot('sessions-section-gap-expanded', { x: 0, y: 0, width: 360, height: 360 });
    await toggleOpen();
    const collapsed = await gapBelowOpen();
    await shot('sessions-section-gap-collapsed', { x: 0, y: 0, width: 360, height: 360 });
    await toggleOpen();
    r.measures.sectionGap = { expanded, collapsed };
    check(expanded.open && expanded.gap === 10 && !collapsed.open && collapsed.gap === 0,
      'sessions: an expanded section leaves 10 px under its last row, a collapsed one none', { expanded, collapsed });
    const accountShown = () => b.evaluate(`(() => { const s = document.querySelector('.cp-section[data-key="account"]');
      return { open: s.classList.contains('cp-open'), shown: getComputedStyle(s.querySelector('.cp-section-body')).display !== 'none' }; })()`);
    const toggleAccount = async () => {
      await b.evaluate(`document.querySelector('.cp-section[data-key="account"] .cp-section-head').click()`);
      await sleep(100);
    };
    const accountOpen = await accountShown();
    await toggleAccount();
    const accountClosed = await accountShown();
    await shot('sessions-account-collapsed', { x: 0, y: 0, width: 360, height: 160 });
    await toggleAccount();
    check(accountOpen.open && accountOpen.shown && !accountClosed.open && !accountClosed.shown,
      'sessions: collapsing ACCOUNT & USAGE hides what is under it, as every other section does', { accountOpen, accountClosed });

    /* A ChatGPT account whose limits Codex can read: a bar for each window, as Claude Code draws its own. */
    const soon = Math.floor(Date.now() / 1000) + 2 * 3600, later = Math.floor(Date.now() / 1000) + 4 * 86400;
    await toPage({ type: 'model', model: Object.assign({}, small, { account: { account: [{ label: 'Email', value: 'demo.user@example.com' }, { label: 'Plan', value: 'Pro' }],
      windows: [{ name: '5h', usedPercent: 23, resetsAt: soon }, { name: 'Weekly', usedPercent: 86, resetsAt: later }], tokens: [{ label: 'Tokens today', value: 1234567 }] } }) });
    await sleep(200);
    const usage = await b.evaluate(`[...document.querySelectorAll('.cp-usage')].map((u) => { const t = u.querySelector('.cp-track').getBoundingClientRect(), f = u.querySelector('.cp-fill');
      return { text: u.textContent, share: Math.round(100 * f.getBoundingClientRect().width / t.width), high: f.classList.contains('cp-high'), h: t.height,
        fill: getComputedStyle(f).backgroundColor }; })`);
    r.measures.usage = usage;
    await shot('sessions-account-usage', { x: 0, y: 0, width: 360, height: 220 });
    check(usage.length === 2 && usage[0].share === 23 && usage[1].share === 86 && !usage[0].high && usage[1].high && usage.every((u) => u.h === 6),
      'sessions: each window is a 6 px bar filled to its share, the one past 80% in the warning colour', usage);
    check(usage.length === 2 && usage[1].fill === 'rgb(217, 119, 87)', 'sessions: the bar past 80% is Claude\'s orange, #d97757, as Claude Code draws it', usage.map((u) => u.fill));
    await toPage({ type: 'model', model: small });
    await sleep(100);

    /* The hover: the rename button takes the time's place, and after a moment the box gives the group and the ID. */
    const target = await b.evaluate(`(() => { const x = [...document.querySelectorAll('.cp-group[data-key="section:a"] .cp-row')][0]; const r = x.getBoundingClientRect();
      return [r.left + 60, r.top + r.height / 2]; })()`);
    await b.hover(target[0], target[1]);
    await sleep(800);
    await shot('sessions-row-hover');
    const hv = await b.evaluate(`(() => { const x = document.querySelector('.cp-group[data-key="section:a"] .cp-row'); const t = x.querySelector('.cp-time'), a = x.querySelector('.cp-actions');
      const box = document.querySelector('.cp-hover');
      return { time: getComputedStyle(t).visibility, acts: getComputedStyle(a).visibility, actRight: Math.round(x.getBoundingClientRect().right - a.getBoundingClientRect().right),
        text: box.classList.contains('cp-hidden') ? '' : box.textContent,
        look: (() => { const c = getComputedStyle(box), a = box.getBoundingClientRect(), w = x.getBoundingClientRect();
          return { padding: c.padding, radius: c.borderTopLeftRadius, bg: c.backgroundColor, border: c.borderTopColor, colour: c.color, size: c.fontSize, maxWidth: c.maxWidth,
            gap: Math.round(w.top - a.bottom), centre: Math.round((a.left + a.right) / 2 - (w.left + w.right) / 2) }; })() }; })()`);
    r.measures.hover = hv;
    check(hv.time === 'hidden' && hv.acts === 'visible' && hv.actRight === 8, 'sessions: on hover the rename button is where the time was', hv);
    check(/^Group: Release 1\.2\nSession ID: 01a1f0f0-/.test(hv.text), 'sessions: the hover box gives the group and the session ID', hv.text);
    const hl = hv.look;
    check(hl.padding === '8px' && hl.radius === '8px' && hl.bg === 'rgb(31, 31, 31)' && hl.border === 'rgb(60, 60, 60)' && hl.colour === 'rgb(204, 204, 204)'
      && hl.size === '11.7px' && hl.maxWidth === '260px' && hl.gap === 8 && Math.abs(hl.centre) <= 1,
    'sessions: the hover box is Claude Code Plus\'s, drawn 8 px above the row and centred on it: the menu background, the input border, 8 px corners and padding, 0.9em', hl);
    await b.hover(5, 890);
    await sleep(200);

    /* A conversation listed both in Open sessions and in a group: Rename from the group row's menu edits the title on
       that row. */
    const rightClick = async (x, y) => {
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
    };
    const rowAt = (sel) => b.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + 60, r.top + r.height / 2]; })()`);
    const twice = await rowAt(`.cp-group[data-key="section:a"] .cp-row[data-id="${ID(1)}"]`);
    await b.evaluate('window.__posted.length = 0');
    await rightClick(twice[0], twice[1]);
    await sleep(100);
    await sleep(100);
    const renameItem = await b.evaluate(`(() => { const i = [...document.querySelectorAll('.cp-ctx-item')].find((x) => x.childNodes[0] && x.childNodes[0].textContent === 'Codex Plus: Rename');
      if (!i) return null; const r = i.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    if (renameItem) await b.click(renameItem[0], renameItem[1]);
    await sleep(100);
    const rightClicked = await b.evaluate(`window.__posted.some((m) => m.kind === 'select' && m.ids.join() === ${JSON.stringify(ID(1))})
      && window.__posted.some((m) => m.kind === 'menu' && m.command === 'codexPlus.renameThread' && m.context.threadId === ${JSON.stringify(ID(1))})
      && document.querySelectorAll('.cp-ctx').length === 0`);
    await toPage({ type: 'startRename', id: ID(1) });
    await sleep(150);
    await shot('sessions-rename-in-group', { x: 0, y: 0, width: 360, height: 560 });
    const renamed = await b.evaluate(`(() => {
      const t = [...document.querySelectorAll('.cp-title.cp-editing')];
      return t.map((x) => { const row = x.closest('.cp-row'), a = row.getBoundingClientRect(), e = x.getBoundingClientRect();
        return { where: (x.closest('.cp-group') || x.closest('.cp-section')).dataset.key, id: row.dataset.id, inside: e.top >= a.top && e.bottom <= a.bottom,
          outline: getComputedStyle(x).outlineColor }; });
    })()`);
    r.measures.renameTwice = { rightClicked, renamed };
    check(rightClicked && renamed.length === 1 && renamed[0].where === 'section:a' && renamed[0].id === ID(1) && renamed[0].inside,
      'sessions: Rename on a group\'s row edits that row, not the same conversation\'s row in Open sessions', r.measures.renameTwice);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(100);
    await toPage({ type: 'startRenameGroup', key: 'section:a' });
    await sleep(150);
    const groupOutline = await b.evaluate(`(() => { const e = document.querySelector('.cp-group-name.cp-editing'); return e ? getComputedStyle(e).outlineColor : null; })()`);
    await shot('sessions-rename-group', { x: 0, y: 0, width: 360, height: 560 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(100);
    r.measures.editOutlines = { title: renamed[0] && renamed[0].outline, group: groupOutline };
    check(r.measures.editOutlines.title === 'rgb(77, 170, 252)' && groupOutline === 'rgb(36, 136, 219)',
      'sessions: a title being renamed is outlined in the link colour and a group name in the active input border, as in Claude Code', r.measures.editOutlines);

    /* The right-click menus and their submenus, each timed from the right-click or the hover to the drawn menu. */
    const esc = () => b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    const ctxRow = `.cp-group[data-key="section:b"] .cp-row[data-id="${ID(2)}"]`;
    const at = await rowAt(ctxRow);
    const opened = (sel, x, y) => b.evaluate(`(() => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, button: 2 });
      const t = performance.now(); document.querySelector(${JSON.stringify(sel)}).dispatchEvent(e); void document.body.offsetHeight;
      return { ms: +(performance.now() - t).toFixed(2), prevented: e.defaultPrevented, menus: document.querySelectorAll('.cp-ctx').length }; })()`);
    const rowOpen = await opened(ctxRow, Math.round(at[0]), Math.round(at[1]));
    await esc();
    await sleep(100);
    await rightClick(at[0], at[1]);
    await sleep(200);
    await shot('sessions-ctx-row', { x: 0, y: 0, width: 360, height: 900 });
    const MEASURE_CTX = `(() => {
      const st = (e) => getComputedStyle(e);
      const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: e.offsetWidth, h: e.offsetHeight }; };
      const one = (m) => {
        if (!m) return null;
        const s = st(m), items = [...m.querySelectorAll('.cp-ctx-item')], sep = m.querySelector('.cp-ctx-sep'), chev = m.querySelector('.cp-ctx-chevron');
        const i = items[0] ? st(items[0]) : null;
        return { box: box(m), radius: s.borderTopLeftRadius, border: [s.borderTopWidth, s.borderTopStyle, s.borderTopColor].join(' '), padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(' '),
          minWidth: s.minWidth, maxHeight: s.maxHeight, shadow: s.boxShadow, bg: s.backgroundColor, zIndex: s.zIndex, position: s.position,
          item: i && { padding: [i.paddingTop, i.paddingRight, i.paddingBottom, i.paddingLeft].join(' '), fontSize: i.fontSize, color: i.color, maxWidth: i.maxWidth, h: items[0].offsetHeight },
          sep: sep && { h: sep.offsetHeight, margin: [st(sep).marginTop, st(sep).marginBottom].join(' '), bg: st(sep).backgroundColor },
          chevron: chev && { text: chev.textContent, float: st(chev).cssFloat, opacity: st(chev).opacity, marginLeft: st(chev).marginLeft },
          labels: items.map((x) => (x.childNodes[0] ? x.childNodes[0].textContent : '')), texts: items.map((x) => x.textContent),
          cut: items.filter((x) => x.scrollWidth > x.clientWidth).map((x) => \`\${x.textContent} (needs \${x.scrollWidth} px, has \${x.clientWidth})\`),
          swatches: [...m.querySelectorAll('.cp-swatch')].map((x) => { const c = st(x); return [x.offsetWidth, x.offsetHeight, c.backgroundColor, c.borderTopStyle]; }),
          seps: [...m.children].map((c) => (c.classList.contains('cp-ctx-sep') ? '-' : 'item')).join('') };
      };
      const main = [...document.querySelectorAll('.cp-ctx')].find((m) => !m.classList.contains('cp-ctx-sub')) || null, sub = document.querySelector('.cp-ctx-sub');
      const parent = main && main.querySelector('.cp-ctx-item.cp-ctx-open');
      return { main: one(main), sub: one(sub), parent: parent && box(parent), vw: innerWidth, vh: innerHeight,
        focused: document.activeElement && document.activeElement.classList.contains('cp-ctx-item') ? document.activeElement.textContent : '' };
    })()`;
    const row = await b.evaluate(MEASURE_CTX);
    /* Claude Code's values, with --app-menu-* resolved through the Dark Modern colours of harness/vscode-stub.js. */
    const CC = { radius: '6px', border: '1px solid rgb(69, 69, 69)', padding: '2px 0px 2px 0px', minWidth: '140px', shadow: 'rgba(0, 0, 0, 0.15) 0px 2px 8px 0px',
      bg: 'rgb(31, 31, 31)', zIndex: '1000', position: 'fixed', itemPadding: '6px 12px 6px 12px', fontSize: '13px', color: 'rgb(204, 204, 204)', maxWidth: '280px' };
    const looks = (m) => !!m && m.radius === CC.radius && m.border === CC.border && m.padding === CC.padding && m.minWidth === CC.minWidth
      && m.shadow === CC.shadow && m.bg === CC.bg && m.zIndex === CC.zIndex && m.position === CC.position && !!m.item && m.item.padding === CC.itemPadding
      && m.item.fontSize === CC.fontSize && m.item.color === CC.color && m.item.maxWidth === CC.maxWidth;
    /* Claude Code's placement of a menu and of a submenu, from wBt in its webview's index.js. */
    const EDGE = 8;
    const ccMainLeft = (x, w, vw) => {
      const left = Math.max(EDGE, Math.min(x, vw - w - EDGE));
      return left + w - 2 + w <= vw - EDGE || left - w + 2 >= EDGE ? left : Math.max(EDGE, vw - EDGE - w + 2 - w);
    };
    const ccSubLeft = (p, w, vw) => {
      if (p.r - 2 + w <= vw - EDGE) return p.r - 2;
      if (p.l - w + 2 >= EDGE) return p.l - w + 2;
      const right = Math.max(EDGE, vw - w - EDGE);
      return EDGE + w - p.l < p.r - right ? EDGE : right;
    };
    const near = (a, want) => Math.abs(a - want) <= 1;
    r.measures.ctxRow = { open: rowOpen, ...row };
    check(rowOpen.prevented && rowOpen.menus === 1, 'sessions: a right-click on a row is cancelled, so VS Code opens no menu of its own, and the page opens one', rowOpen);
    check(looks(row.main), 'sessions: the menu has Claude Code\'s corners, border, padding, shadow, colours and item size', row.main);
    check(row.main && near(row.main.box.l, ccMainLeft(Math.round(at[0]), row.main.box.w, row.vw)) && near(row.main.box.t, Math.round(at[1])),
      'sessions: it opens where Claude Code would put it for a click there', { main: row.main && row.main.box, at });
    check(row.main && row.main.labels.join('|') === 'Codex Plus: Resume in Tab|Codex Plus: Resume in Sidebar|Codex Plus: Add to Group|Codex Plus: Remove from Group|'
      + 'Codex Plus: Mark as Unread|Codex Plus: Rename|Codex Plus: Text Color' && row.main.seps === 'itemitem-itemitem-item-item-item'
      && row.main.sep && row.main.sep.h === 1 && row.main.sep.margin === '2px 2px' && row.main.sep.bg === CC.border.slice(10)
      && row.main.chevron && row.main.chevron.text === '›' && row.main.chevron.float === 'right' && row.main.chevron.opacity === '0.7' && row.main.chevron.marginLeft === '12px'
      && row.focused === 'Codex Plus: Resume in Tab',
    'sessions: a grouped row\'s items, separators 1 px with 2 px above and below, Claude Code\'s › on the two with a submenu, the first item focused; '
      + 'no Delete, since this one is waiting for the user', row.main);
    check(!!row.main && row.main.cut.length === 0, 'sessions: no item of a row\'s menu is cut short', row.main && row.main.cut);

    const centre = (label) => b.evaluate(`(() => { const i = [...document.querySelectorAll('.cp-ctx-item')].find((x) => x.childNodes[0] && x.childNodes[0].textContent === ${JSON.stringify(label)});
      if (!i) return null; const r = i.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    const move = (x, y) => b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    const subTimed = (label) => b.evaluate(`(() => { const i = [...document.querySelectorAll('.cp-ctx-item')].find((x) => x.childNodes[0] && x.childNodes[0].textContent === ${JSON.stringify(label)});
      const t = performance.now(); i.dispatchEvent(new MouseEvent('mouseenter')); void document.body.offsetHeight; return +(performance.now() - t).toFixed(2); })()`);
    const colourAt = await centre('Codex Plus: Text Color');
    const colourMs = await subTimed('Codex Plus: Text Color');
    if (colourAt) await move(colourAt[0], colourAt[1]);
    await sleep(200);
    await shot('sessions-ctx-text-color', { x: 0, y: 0, width: 360, height: 900 });
    const tc = await b.evaluate(MEASURE_CTX);
    const HEX = { red: '241, 76, 76', blue: '55, 148, 255', green: '137, 209, 133', yellow: '204, 167, 0', purple: '177, 128, 215', orange: '209, 134, 22',
      pink: '214, 112, 214', cyan: '17, 168, 205' };
    r.measures.ctxTextColor = { ms: colourMs, ...tc };
    check(tc.sub && looks(tc.sub) && tc.parent && near(tc.sub.box.l, ccSubLeft(tc.parent, tc.sub.box.w, tc.vw)) && near(tc.sub.box.t, Math.max(EDGE, Math.min(tc.parent.t - 3, tc.vh - tc.sub.box.h - EDGE))),
      'sessions: resting on Text Color opens its submenu beside it, drawn and placed as Claude Code\'s submenu is', { sub: tc.sub && tc.sub.box, parent: tc.parent });
    check(tc.sub && tc.sub.texts.join('|') === `Default ✓|${COLOR_NAMES.map((n) => n[0].toUpperCase() + n.slice(1)).join('|')}` && tc.sub.seps === 'item-itemitemitemitemitemitemitemitem'
      && tc.sub.swatches.length === 9 && tc.sub.swatches.every(([w, h]) => w === 10 && h === 10) && tc.sub.swatches[0][3] === 'solid'
      && COLOR_NAMES.every((n, i) => tc.sub.swatches[i + 1][2] === `rgb(${HEX[n]})`),
    'sessions: it lists Default, checked for a row with no colour, a separator and Claude Code Plus\'s eight colours, each with a 10 px swatch in its theme colour', tc.sub);

    const groupAt = await centre('Codex Plus: Add to Group');
    if (groupAt) await move(groupAt[0], groupAt[1]);
    await sleep(300);
    await shot('sessions-ctx-add-to-group', { x: 0, y: 0, width: 360, height: 900 });
    const ag = await b.evaluate(MEASURE_CTX);
    const laterAt = await b.evaluate(`(() => { const i = [...document.querySelectorAll('.cp-ctx-sub .cp-ctx-item')].find((x) => x.textContent === 'Later');
      if (!i) return null; const r = i.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await b.evaluate('window.__posted.length = 0');
    if (laterAt) { await move(laterAt[0], laterAt[1]); await b.click(laterAt[0], laterAt[1]); }
    await sleep(100);
    const picked = await b.evaluate('({ posted: window.__posted.filter((m) => m.kind === "menu"), left: document.querySelectorAll(".cp-ctx").length })');
    r.measures.ctxAddToGroup = { ...ag, picked };
    check(ag.sub && looks(ag.sub) && ag.sub.texts.join('|') === 'Release 1.2|Later' && ag.parent && near(ag.sub.box.l, ccSubLeft(ag.parent, ag.sub.box.w, ag.vw)),
      'sessions: moving onto Add to Group swaps in its submenu, of the groups the user made except the row\'s own', ag.sub);
    check(picked.left === 0 && picked.posted.length === 1 && picked.posted[0].command === 'codexPlus.moveThreadToSection' && picked.posted[0].pick === 'section:e'
      && picked.posted[0].context.threadId === ID(2), 'sessions: a group clicked there is sent to the host with the row\'s context, and the menu goes', picked);

    const withGoal = JSON.parse(JSON.stringify(small));
    Object.assign(withGoal.groups[1].rows.find((x) => x.id === ID(2)), { goal: 'active',
      goalText: 'Goal (goal, 182,000 of 1,000,000 tokens): Make the nightly export skip archived rows' });
    await toPage({ type: 'model', model: withGoal });
    await sleep(200);
    const goalAt = await rowAt(ctxRow);
    await rightClick(goalAt[0], goalAt[1]);
    await sleep(200);
    await shot('sessions-ctx-row-goal', { x: 0, y: 0, width: 360, height: 900 });
    const gm = await b.evaluate(MEASURE_CTX);
    r.measures.ctxRowGoal = gm;
    check(!!gm.main && looks(gm.main) && gm.main.labels.join('|') === 'Codex Plus: Resume in Tab|Codex Plus: Resume in Sidebar|Codex Plus: Add to Group|'
      + 'Codex Plus: Remove from Group|Codex Plus: Mark as Unread|Codex Plus: Rename|Codex Plus: Text Color|Codex Plus: Pause Goal|Codex Plus: Clear Goal'
      && gm.main.seps === 'itemitem-itemitem-item-item-item-itemitem' && gm.main.cut.length === 0,
    'sessions: a row with a running goal ends its menu in Pause Goal and Clear Goal, after a separator, neither cut short', gm.main);
    await esc();
    await sleep(100);
    await toPage({ type: 'model', model: small });
    await sleep(100);

    const delSel = `.cp-group[data-key="section:b"] .cp-row[data-id="${ID(7)}"]`;
    const delAt = await rowAt(delSel);
    await rightClick(delAt[0], delAt[1]);
    await sleep(200);
    await shot('sessions-ctx-row-delete', { x: 0, y: 0, width: 360, height: 900 });
    const dOne = await b.evaluate(MEASURE_CTX);
    await esc();
    await sleep(100);
    const alsoAt = await rowAt(`.cp-group[data-key="ungrouped"] .cp-row[data-id="${ID(3)}"]`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await b.send('Input.dispatchMouseEvent', { type, x: alsoAt[0], y: alsoAt[1], button: 'left', clickCount: 1, modifiers: 2 });
    }
    await sleep(100);
    await rightClick(delAt[0], delAt[1]);
    await sleep(200);
    await shot('sessions-ctx-rows-delete', { x: 0, y: 0, width: 360, height: 900 });
    const dTwo = await b.evaluate(MEASURE_CTX);
    await esc();
    await sleep(50);
    await esc();
    await sleep(100);
    r.measures.ctxRowDelete = { one: dOne.main, two: dTwo.main };
    check(!!dOne.main && looks(dOne.main) && dOne.main.labels.join('|') === 'Codex Plus: Resume in Tab|Codex Plus: Resume in Sidebar|Codex Plus: Add to Group|'
      + 'Codex Plus: Remove from Group|Codex Plus: Mark as Unread|Codex Plus: Rename|Codex Plus: Text Color|Codex Plus: Delete Conversation...'
      && dOne.main.seps === 'itemitem-itemitem-item-item-item-item' && dOne.main.cut.length === 0,
    'sessions: a row that may be deleted ends its menu in Delete Conversation..., after a separator, not cut short', dOne.main);
    check(!!dTwo.main && dTwo.main.labels[dTwo.main.labels.length - 1] === 'Codex Plus: Delete 2 Conversations...' && dTwo.main.cut.length === 0,
      'sessions: with a second one selected it reads Delete 2 Conversations..., not cut short', dTwo.main);

    const headSel = '.cp-group[data-key="section:a"] .cp-group-head';
    const headAt = await b.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(headSel)}).getBoundingClientRect(); return [r.left + 40, r.top + r.height / 2]; })()`);
    const headOpen = await opened(headSel, Math.round(headAt[0]), Math.round(headAt[1]));
    await esc();
    await sleep(100);
    await rightClick(headAt[0], headAt[1]);
    await sleep(200);
    await shot('sessions-ctx-group', { x: 0, y: 0, width: 360, height: 900 });
    const gh = await b.evaluate(MEASURE_CTX);
    r.measures.ctxGroup = { open: headOpen, ...gh };
    check(headOpen.prevented && looks(gh.main) && gh.main.labels.join('|') === 'Codex Plus: Start New Session in This Group|Codex Plus: New Group...|Codex Plus: Rename Group...|Codex Plus: Delete Group'
      && gh.main.seps === 'itemitem-item-item' && !gh.main.chevron, 'sessions: a group header\'s menu has its four items in the same look', gh.main);
    check(!!gh.main && gh.main.cut.length === 0, 'sessions: no item of a group header\'s menu is cut short, at 280 px', gh.main && gh.main.cut);
    await esc();
    await sleep(100);
    const gone = await b.evaluate('document.querySelectorAll(".cp-ctx").length');

    /* Keys in the real page: Shift+F10 on the row the arrows reached, → into Text Color, Esc twice. */
    await b.evaluate(`(() => { document.getElementById('root').focus(); })()`);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 });
    await sleep(150);
    const byKey = await b.evaluate(MEASURE_CTX);
    const key = (k, code, vk) => b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
    for (let i = 0; i < 20 && byKey.main && !/Text Color/.test(await b.evaluate('document.activeElement.textContent')); i++) await key('ArrowDown', 'ArrowDown', 40);
    await key('ArrowRight', 'ArrowRight', 39);
    await sleep(100);
    const intoSub = await b.evaluate(MEASURE_CTX);
    await esc();
    await sleep(50);
    const afterOne = await b.evaluate(MEASURE_CTX);
    await esc();
    await sleep(50);
    const afterTwo = await b.evaluate('document.querySelectorAll(".cp-ctx").length');
    r.measures.ctxKeys = { gone, byKey: byKey.main && byKey.main.labels, intoSub: intoSub.focused, afterOne: [!!afterOne.main, !!afterOne.sub], afterTwo };
    check(gone === 0 && !!byKey.main && intoSub.focused === 'Default ✓' && afterOne.main && !afterOne.sub && afterTwo === 0,
      'sessions: Shift+F10 opens the highlighted row\'s menu, → enters Text Color, and Esc closes the submenu and then the menu', r.measures.ctxKeys);

    /* 100 groups: Add to Group still fits in the window, and opens as fast. */
    const many = JSON.parse(JSON.stringify(small));
    for (let i = 0; i < 100; i++) many.groups.splice(3, 0, { key: `section:g${i}`, label: `Group ${i + 1}`, made: true, rows: [] });
    await toPage({ type: 'model', model: many });
    await sleep(200);
    const at2 = await rowAt(ctxRow);
    const manyOpen = await opened(ctxRow, Math.round(at2[0]), Math.round(at2[1]));
    const manyMs = await subTimed('Codex Plus: Add to Group');
    const fits = await b.evaluate('(() => { const s = document.querySelector(".cp-ctx-sub"); if (!s) return null; const r = s.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight, items: s.querySelectorAll(".cp-ctx-item").length }; })()');
    await esc();
    await esc();
    await toPage({ type: 'model', model: small });
    await sleep(100);
    r.measures.ctxTiming = { row: rowOpen.ms, textColor: colourMs, group: headOpen.ms, manyRow: manyOpen.ms, manyGroups: manyMs, fits };
    console.log(`  note  sessions: right-click to drawn menu ${rowOpen.ms} ms (row), ${headOpen.ms} ms (group header), ${manyOpen.ms} ms with 100 groups; `
      + `submenu ${colourMs} ms (Text Color), ${manyMs} ms (Add to Group, 100 groups)`);
    check(rowOpen.ms < 100 && headOpen.ms < 100 && manyOpen.ms < 100 && colourMs < 100 && manyMs < 100 && fits && fits.items === 102 && fits.top >= EDGE - 1 && fits.bottom <= fits.h - EDGE + 1,
      'sessions: each menu and submenu is drawn within 100 ms of the right-click or the hover, 100 groups included, and fits in the window', r.measures.ctxTiming);

    /* A sidebar 300 px wide. */
    const narrow = await open(env, path.join(work, 'narrow'), { width: 300, height: 700 });
    try {
      const nb = narrow.b;
      await nb.navigate(`http://127.0.0.1:${narrow.port}/sessions.html`);
      for (let i = 0; i < 50; i++) { if (await nb.evaluate('(window.__posted || []).some((m) => m.kind === "ready")')) break; await sleep(100); }
      await nb.evaluate(`window.__fromHost(${JSON.stringify({ type: 'model', model: small })})`);
      await sleep(300);
      const nAt = await nb.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(ctxRow)}).getBoundingClientRect(); return [r.right - 30, r.top + r.height / 2]; })()`);
      await nb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nAt[0], y: nAt[1], button: 'none' });
      await nb.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nAt[0], y: nAt[1], button: 'right', clickCount: 1 });
      await nb.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nAt[0], y: nAt[1], button: 'right', clickCount: 1 });
      await sleep(200);
      const nColour = await nb.evaluate(`(() => { const i = [...document.querySelectorAll('.cp-ctx-item')].find((x) => x.childNodes[0] && x.childNodes[0].textContent === 'Codex Plus: Text Color');
        if (!i) return null; const r = i.getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; })()`);
      if (nColour) await nb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nColour[0], y: nColour[1], button: 'none' });
      await sleep(300);
      await nb.screenshot(path.join(shots, 'sessions-ctx-narrow.png'));
      const n = await nb.evaluate(MEASURE_CTX);
      const inView = (m) => !!m && m.box.l >= EDGE - 1 && m.box.r <= n.vw - EDGE + 1 && m.box.t >= EDGE - 1 && m.box.b <= n.vh - EDGE + 1;
      const redAt = await nb.evaluate(`(() => { const i = [...document.querySelectorAll('.cp-ctx-sub .cp-ctx-item')].find((x) => x.textContent.startsWith('Red'));
        if (!i) return null; const r = i.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
      const hit = redAt ? await nb.evaluate(`(() => { const e = document.elementFromPoint(${redAt[0]}, ${redAt[1]}); return e && e.closest('.cp-ctx-item') ? e.closest('.cp-ctx-item').textContent : ''; })()`) : '';
      await nb.evaluate('window.__posted.length = 0');
      if (redAt) {
        await nb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: redAt[0], y: redAt[1], button: 'none' });
        await nb.click(redAt[0], redAt[1]);
      }
      await sleep(100);
      const nPicked = await nb.evaluate('window.__posted.filter((m) => m.kind === "menu").map((m) => m.pick)');
      r.measures.ctxNarrow = { ...n, hit, picked: nPicked };
      check(n.vw === 300 && inView(n.main) && inView(n.sub) && n.parent && near(n.main.box.l, ccMainLeft(Math.round(nAt[0]), n.main.box.w, n.vw))
        && near(n.sub.box.l, ccSubLeft(n.parent, n.sub.box.w, n.vw)),
      'sessions: in a 300 px sidebar the menu and the Text Color submenu are placed as Claude Code places them, both wholly in the window', { main: n.main && n.main.box, sub: n.sub && n.sub.box, parent: n.parent });
      check(hit === 'Red' && nPicked.join() === 'red', 'sessions: and a colour there is the topmost thing under the pointer and can be clicked', { hit, picked: nPicked });
      check(nb.errors.length === 0, 'sessions: the 300 px page threw nothing', nb.errors);
    } finally { await narrow.close(); }

    /* At 170 px the New in tab and New in sidebar labels no longer fit. */
    const SIZES = `({ newButtons: [...document.querySelectorAll('.cp-new')].map((b) => { const i = b.querySelector('svg'), l = b.querySelector('span');
        return { icon: i ? Math.round(i.getBoundingClientRect().width) : 0, cut: !!l && l.scrollWidth > l.clientWidth, overflow: l ? getComputedStyle(l).textOverflow : '' }; }),
      tools: [...document.querySelectorAll('.cp-filter-row svg')].map((i) => Math.round(i.getBoundingClientRect().width)),
      dots: [...document.querySelectorAll('.cp-row .cp-dot')].filter((d) => getComputedStyle(d).display !== 'none').map((d) => Math.round(d.getBoundingClientRect().width)),
      chevrons: [...document.querySelectorAll('.cp-group-head svg')].map((i) => Math.round(i.getBoundingClientRect().width)),
      counts: [...document.querySelectorAll('.cp-group-head .cp-group-count')].map((c) => c.scrollWidth <= c.clientWidth) })`;
    const wideSizes = await b.evaluate(SIZES);
    const thin = await open(env, path.join(work, 'thin'), { width: 170, height: 500 });
    try {
      const tb = thin.b;
      await tb.navigate(`http://127.0.0.1:${thin.port}/sessions.html`);
      for (let i = 0; i < 50; i++) { if (await tb.evaluate('(window.__posted || []).some((m) => m.kind === "ready")')) break; await sleep(100); }
      await tb.evaluate(`window.__fromHost(${JSON.stringify({ type: 'model', model: small })})`);
      await sleep(300);
      await tb.screenshot(path.join(shots, 'sessions-170.png'));
      const thinSizes = await tb.evaluate(SIZES);
      r.measures.thin = { wide: wideSizes, thin: thinSizes };
      check(thinSizes.newButtons.length === 2 && thinSizes.newButtons.every((x) => x.icon === 16 && x.overflow === 'ellipsis') && thinSizes.newButtons.some((x) => x.cut),
        'sessions: in a 170 px list New in tab and New in sidebar keep their 16 px icons and their labels end in an ellipsis', thinSizes.newButtons);
      const same = (k) => JSON.stringify(thinSizes[k].slice(0, Math.min(thinSizes[k].length, wideSizes[k].length))) === JSON.stringify(wideSizes[k].slice(0, Math.min(thinSizes[k].length, wideSizes[k].length)));
      check(['tools', 'dots', 'chevrons'].every((k) => thinSizes[k].length > 0 && same(k)) && thinSizes.counts.every(Boolean),
        'sessions: and the filter row\'s icons, the rows\' dots, the group headers\' arrows and counts are as large there as in a wide list', r.measures.thin);
      check(tb.errors.length === 0, 'sessions: the 170 px page threw nothing', tb.errors);
    } finally { await thin.close(); }

    /* The status filter's menu, and the search. */
    const fb = await b.evaluate(`(() => { const r = document.querySelector('[data-tool="filter"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await b.click(fb[0], fb[1]);
    await sleep(200);
    await shot('sessions-filter-menu');
    const menuItems = await b.evaluate('[...document.querySelectorAll(".cp-menu-item")].map((x) => x.textContent)');
    check(menuItems.length === 5, 'sessions: the status filter\'s menu opens with its five choices', menuItems);
    const fm = await b.evaluate(`(() => {
      const m = document.querySelector('.cp-menu'), s = getComputedStyle(m), items = [...m.querySelectorAll('.cp-menu-item')], i = getComputedStyle(items[0]);
      const head = m.querySelector('.cp-menu-title'), h = getComputedStyle(head), check = items[0].querySelector('.cp-check');
      return { radius: s.borderTopLeftRadius, border: [s.borderTopWidth, s.borderTopStyle, s.borderTopColor].join(' '), padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(' '),
        minWidth: s.minWidth, shadow: s.boxShadow, bg: s.backgroundColor, item: { padding: [i.paddingTop, i.paddingRight, i.paddingBottom, i.paddingLeft].join(' '), fontSize: i.fontSize,
          h: items[0].offsetHeight, radius: i.borderTopLeftRadius }, head: { opacity: h.opacity, padding: [h.paddingTop, h.paddingRight].join(' '), size: h.fontSize },
        check: check && [check.offsetWidth, getComputedStyle(check).marginRight], texts: items.map((x) => x.textContent) }; })()`);
    r.measures.filterMenu = fm;
    check(fm.radius === CC.radius && fm.border === CC.border && fm.padding === CC.padding && fm.minWidth === CC.minWidth && fm.shadow === CC.shadow && fm.bg === CC.bg
      && fm.item.padding === CC.itemPadding && fm.item.fontSize === CC.fontSize && fm.item.radius === '0px' && fm.head.opacity === '0.5' && fm.head.padding === '4px 12px'
      && fm.head.size === '11.7px' && fm.check && fm.check[0] === 16 && fm.check[1] === '6px',
    'sessions: the status filter\'s menu is the right-click menus\' Claude Code menu: 2 px padding, 6 by 12 px items with square corners, Claude Code\'s headings and its 16 px check', fm);
    check(fm.texts.every((t) => /^(Needs input|Working|Completed|Open|Closed) · \d+$/.test(t)), 'sessions: each choice reads "Needs input · 3", as Claude Code writes it', fm.texts);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await b.click(fb[0], fb[1]);
    await sleep(100);
    /* The click left the menu open; Esc closes it, so the search is shot with nothing over it. */
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(100);
    for (const ch of 'export') {
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, code: `Key${ch.toUpperCase()}` });
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}` });
    }
    await sleep(200);
    await shot('sessions-search');
    const found = await b.evaluate('[...document.querySelectorAll(".cp-group .cp-row")].filter((x) => x.offsetParent).map((x) => x.querySelector(".cp-title").textContent)');
    check(found.length > 0 && found.every((t) => /export/i.test(t)), 'sessions: typing in the list searches it', found);
    const sb = await b.evaluate(`(() => {
      const box = document.querySelector('.cp-search'), input = box.querySelector('input'), c = getComputedStyle(input), f = document.querySelector('[data-tool="filter"]').getBoundingClientRect();
      const mark = document.querySelector('.cp-mark'), q = document.createElement('span'); q.style.background = 'color-mix(in srgb, #d97757 20%, transparent)'; document.body.appendChild(q);
      const want = getComputedStyle(q).backgroundColor; q.remove();
      return { above: Math.round(box.getBoundingClientRect().bottom) <= Math.round(f.top), border: c.borderTopWidth, radius: c.borderTopLeftRadius, h: Math.round(input.getBoundingClientRect().height),
        size: c.fontSize, bg: c.backgroundColor, placeholder: input.placeholder, magnifier: getComputedStyle(document.querySelector('[data-tool="search"]')).display,
        mark: mark ? getComputedStyle(mark).backgroundColor : null, want }; })()`);
    r.measures.search = sb;
    check(sb.above && sb.border === '0px' && sb.radius === '4px' && sb.h === 31 && sb.size === '11.7px' && sb.bg === 'rgb(49, 49, 49)' && sb.placeholder === 'Search sessions…'
      && sb.magnifier === 'none', 'sessions: the search box opens above the filter buttons, Claude Code\'s: no border, 4 px corners, 31 px high at 0.9em, "Search sessions…", the magnifier hidden', sb);
    check(!!sb.mark && sb.mark === sb.want, 'sessions: the matched words are marked in Claude\'s orange at 20%', sb);
    await b.evaluate(`(() => { const i = document.querySelector('.cp-search input'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);

    /* Dragging a row: the image is Claude Code's pill with the row's title. */
    const drag = await b.evaluate(`(() => {
      const row = document.querySelector('.cp-group .cp-row'), dt = new DataTransfer(); let got = null;
      dt.setDragImage = (e, x, y) => { const c = getComputedStyle(e); got = { text: e.textContent, x, y, bg: c.backgroundColor, colour: c.color, radius: c.borderTopLeftRadius,
        padding: [c.paddingTop, c.paddingRight].join(' '), maxWidth: c.maxWidth, title: row.querySelector('.cp-title').textContent }; };
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      row.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      return { got, left: document.querySelectorAll('.cp-drag').length }; })()`);
    r.measures.drag = drag;
    check(!!drag.got && drag.got.text === drag.got.title && drag.got.x === -12 && drag.got.y === -12 && drag.got.bg === 'rgb(4, 57, 94)' && drag.got.colour === 'rgb(255, 255, 255)'
      && drag.got.radius === '6px' && drag.got.padding === '2px 8px' && drag.got.maxWidth === '240px' && drag.left === 0,
    'sessions: a dragged row is shown as Claude Code\'s pill, its title in the selection colour, and the pill goes when the drag ends', drag);

    /* Time to draw and to search, timed inside the page with the layout it forces. */
    const timing = async (n) => {
      const first = fakeModel(n), again = fakeModel(n, { stamp: ' ' });
      return b.evaluate(`(() => {
        const send = (m) => window.__fromHost({ type: 'model', model: m });
        const time = (fn) => { const t = performance.now(); fn(); void document.body.offsetHeight; return +(performance.now() - t).toFixed(2); };
        send({ account: null, closed: [], open: [], groups: [], front: '', noGroups: false });
        void document.body.offsetHeight;
        const first = ${JSON.stringify(first)}, again = ${JSON.stringify(again)};
        const one = JSON.parse(JSON.stringify(first)); one.groups[3].rows[0].time = 'now · 11/10';
        const out = { first: time(() => send(first)), same: time(() => send(JSON.parse(JSON.stringify(first)))), one: time(() => send(one)), all: [] };
        for (let i = 0; i < 5; i++) out.all.push(time(() => send(i % 2 ? first : again)));
        const input = document.querySelector('.cp-search input');
        const keys = [];
        for (const q of ['r', 're', 'rev', 'revi', 'review']) keys.push(time(() => { input.value = q; input.dispatchEvent(new Event('input')); }));
        keys.push(time(() => { input.value = ''; input.dispatchEvent(new Event('input')); }));
        out.keys = keys;
        out.nodes = document.getElementsByTagName('*').length;
        return out;
      })()`);
    };
    r.measures.t200 = await timing(200);
    r.measures.t1000 = await timing(1000);
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const t2 = r.measures.t200, t10 = r.measures.t1000;
    console.log(`  note  sessions: 200 rows drawn in ${t2.first} ms, every row redrawn in ${med(t2.all)} ms (median of 5), one row in ${t2.one} ms, `
      + `the same model in ${t2.same} ms, a key of search in ${med(t2.keys)} ms`);
    console.log(`  note  sessions: 1000 rows drawn in ${t10.first} ms, every row redrawn in ${med(t10.all)} ms, one row in ${t10.one} ms, `
      + `a key of search in ${med(t10.keys)} ms (slowest ${Math.max(...t10.keys)} ms); ${t10.nodes} elements on the page`);
    check(med(t2.all) < 50, 'sessions: redrawing all 200 rows takes under 50 ms', t2.all);
    check(t10.first < 300 && med(t10.all) < 150, 'sessions: drawing 1000 rows takes under 300 ms, and redrawing them under 150 ms', [t10.first, t10.all]);
    check(Math.max(...t10.keys) < 100, 'sessions: with 1000 rows, each key of a search takes under 100 ms', t10.keys);

    check(b.errors.length === 0, 'sessions: the page threw nothing', b.errors);
    results.blocked.push(...b.blocked);
  } finally { await s.close(); }

  /* Memory, in a browser of its own that has drawn nothing but 200 rows, after a collection. */
  const mem = await open(env, path.join(work, 'memory'));
  try {
    await mem.b.navigate(`http://127.0.0.1:${mem.port}/sessions.html`);
    for (let i = 0; i < 50; i++) { if (await mem.b.evaluate('(window.__posted || []).some((m) => m.kind === "ready")')) break; await sleep(100); }
    await mem.b.evaluate(`window.__fromHost(${JSON.stringify({ type: 'model', model: fakeModel(200) })})`);
    await sleep(1000);
    await mem.b.send('HeapProfiler.enable');
    await mem.b.send('HeapProfiler.collectGarbage');
    await sleep(1500);
    const metrics = await mem.b.send('Performance.getMetrics');
    const get = (k) => (metrics.metrics.find((x) => x.name === k) || {}).value;
    r.measures.memory = { pssMb: renderers(mem.userDataDir).map(pssMb).filter(Boolean), blankPssMb: r.blankPssMb,
      jsHeapUsedMb: +((get('JSHeapUsedSize') || 0) / 1048576).toFixed(2), nodes: get('Nodes') };
    console.log(`  note  sessions: with 200 rows the renderer holds ${r.measures.memory.pssMb.map((x) => x.toFixed(1)).join(', ')} MB (PSS), `
      + `a blank page ${r.blankPssMb.map((x) => x.toFixed(1)).join(', ')} MB; JS heap ${r.measures.memory.jsHeapUsedMb} MB, ${r.measures.memory.nodes} DOM nodes`);
    await mem.b.screenshot(path.join(shots, 'sessions-200.png'));
    check(r.measures.memory.pssMb.length > 0, 'sessions: the renderer\'s memory could be read', r.measures.memory);
    check(mem.b.errors.length === 0, 'sessions: drawing 200 rows threw nothing', mem.b.errors);
  } finally { await mem.close(); }
}

module.exports = { run, fakeModel };
