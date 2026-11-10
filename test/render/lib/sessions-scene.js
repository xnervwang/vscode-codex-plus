// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The render check's `sessions` scene. It loads src/page/sessions-page.js, with the content policy src/sessions-view.js
 * sets, in a headless Chromium at sidebar width, using the Dark Modern theme variables and the webview API stand-in in
 * harness/vscode-stub.js. It posts made-up models and checks layout that only a real browser computes: Claude Code's
 * sizes, the time flush right, the rename button replacing the time on hover, the two new-conversation buttons side by
 * side, and draw and search times at 200 and 1000 rows. It also reads the renderer's memory with the list shown and with
 * a blank page. It needs no Codex.
 */
const fs = require('fs');
const path = require('path');
const { serve, launch, sleep } = require('./cdp');
const { pageHtml } = require('../../../src/sessions-view');

const ROOT = path.join(__dirname, '..', '..', '..');
const HARNESS = path.join(__dirname, '..', 'harness');
const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const DOTS = ['idle', 'working', 'prompt', 'unread', 'idle', 'workingElsewhere', 'failed', 'idle', 'unknown', 'promptElsewhere'];
const TITLES = ['Fix the retry delay in the inventory sync', 'Why does the nightly export skip archived rows?', 'Add a dry-run flag to the cleanup script',
  'Review the cache eviction change', 'Split the settings page into two', 'Upgrade the test runner', 'Trace the slow login on staging',
  'Rename the billing columns', 'Write the migration for the new index', 'Explain the flaky upload test'];

/* A model of `n` conversations in three groups and Ungrouped, as SessionsModel.model() makes one. */
function fakeModel(n, { stamp = '' } = {}) {
  const row = (i, extra = {}) => ({ id: ID(i), title: `${TITLES[i % TITLES.length]}${i >= TITLES.length ? ` (${i})` : ''}`,
    time: `${(i % 9) + 1}d · 11/0${(i % 9) + 1}→11/09${stamp}`, dot: DOTS[i % DOTS.length], color: i % 7 === 3 ? 'charts.purple' : '',
    open: i < 2, sidebar: false, unread: DOTS[i % DOTS.length] === 'unread', grouped: false, group: 'Ungrouped', branch: i % 4 ? '' : `fix/${i}`, ...extra });
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
    open: rows.slice(0, 2), groups, front: ID(0), noGroups: false };
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
    check(m.dots.every(([w, h]) => w === 8 && h === 8), 'sessions: every status dot is 8 by 8 px', m.dots);
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

    /* A ChatGPT account whose limits Codex can read: a bar for each window, as Claude Code draws its own. */
    const soon = Math.floor(Date.now() / 1000) + 2 * 3600, later = Math.floor(Date.now() / 1000) + 4 * 86400;
    await toPage({ type: 'model', model: Object.assign({}, small, { account: { account: [{ label: 'Email', value: 'demo.user@example.com' }, { label: 'Plan', value: 'Pro' }],
      windows: [{ name: '5h', usedPercent: 23, resetsAt: soon }, { name: 'Weekly', usedPercent: 86, resetsAt: later }], tokens: [{ label: 'Tokens today', value: 1234567 }] } }) });
    await sleep(200);
    const usage = await b.evaluate(`[...document.querySelectorAll('.cp-usage')].map((u) => { const t = u.querySelector('.cp-track').getBoundingClientRect(), f = u.querySelector('.cp-fill');
      return { text: u.textContent, share: Math.round(100 * f.getBoundingClientRect().width / t.width), high: f.classList.contains('cp-high'), h: t.height }; })`);
    r.measures.usage = usage;
    await shot('sessions-account-usage', { x: 0, y: 0, width: 360, height: 220 });
    check(usage.length === 2 && usage[0].share === 23 && usage[1].share === 86 && !usage[0].high && usage[1].high && usage.every((u) => u.h === 6),
      'sessions: each window is a 6 px bar filled to its share, the one past 80% in the warning colour', usage);
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
        text: box.classList.contains('cp-hidden') ? '' : box.textContent }; })()`);
    r.measures.hover = hv;
    check(hv.time === 'hidden' && hv.acts === 'visible' && hv.actRight === 8, 'sessions: on hover the rename button is where the time was', hv);
    check(/^Group: Release 1\.2\nSession ID: 01a1f0f0-/.test(hv.text), 'sessions: the hover box gives the group and the session ID', hv.text);
    await b.hover(5, 890);
    await sleep(200);

    /* The status filter's menu, and the search. */
    const fb = await b.evaluate(`(() => { const r = document.querySelector('[data-tool="filter"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await b.click(fb[0], fb[1]);
    await sleep(200);
    await shot('sessions-filter-menu');
    const menuItems = await b.evaluate('[...document.querySelectorAll(".cp-menu-item")].map((x) => x.textContent)');
    check(menuItems.length === 5, 'sessions: the status filter\'s menu opens with its five choices', menuItems);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await b.click(fb[0], fb[1]);
    await sleep(100);
    for (const ch of 'export') {
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, code: `Key${ch.toUpperCase()}` });
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}` });
    }
    await sleep(200);
    await shot('sessions-search');
    const found = await b.evaluate('[...document.querySelectorAll(".cp-group .cp-row")].filter((x) => x.offsetParent).map((x) => x.querySelector(".cp-title").textContent)');
    check(found.length > 0 && found.every((t) => /export/i.test(t)), 'sessions: typing in the list searches it', found);
    await b.evaluate(`(() => { const i = document.querySelector('.cp-search input'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);

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
