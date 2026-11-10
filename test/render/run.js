// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The render check: Codex's real conversation page, from the installed Codex extension, with this repository's page
 * script in it, drawn in a headless Chromium against Codex's real app-server running offline on a made-up conversation.
 * Not part of test/check.js and not in the package. Run it once per new Codex version:
 *
 *   node test/render/run.js [--out <dir>] [--codex <Codex extension dir>]
 *
 * It asserts what can only be seen in a drawn page - that nothing of this extension's covers Codex's own controls, that
 * what it adds to Codex's toolbar row moves none of Codex's buttons and leaves typing, pasting, dropping and keys in the
 * message box as they were, that the context meter compacts through the real app-server and leaves the draft alone, that
 * the page script finds what it looks for, that an approval card is reported - and saves a screenshot of each state in
 * <out>/shots (by default a new directory under the system's temporary directory). On a machine without what it needs
 * (lib/env.js) it says what is missing and exits 0. It exits 1 when an assertion fails.
 *
 * Nothing leaves the machine: the browser fails every request that is not to 127.0.0.1 and the number it failed is
 * printed, and the app-server runs in a namespace with no network.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const env = require('./lib/env');
const scene = require('./lib/scene');
const fake = require('./lib/fake-codex-home');
const live = require('./lib/live-turn');
const { MEASURE, OVER_FLOATING } = require('./lib/measure');
const png = require('./lib/png');
const patching = require('../../src/patching');

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const found = env.find({ codexDir: arg('--codex') });
if (found.missing.length) {
  console.log('The render check could not run here. Missing:');
  for (const m of found.missing) console.log(`  - ${m}`);
  process.exit(0);
}
/* --only <name>[,<name>] runs those scenes alone: conversation, narrow, wide, rail (rail-wide and rail-narrow), agentmap (and
   agentmap-narrow), approval, background, compact, chime, long, sessions. */
const ONLY = arg('--only') ? arg('--only').split(',') : null;
const want = (name) => !ONLY || ONLY.includes(name);
const OUT = path.resolve(arg('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plus-render-')));
const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const ENV = { ...found, work: path.join(OUT, 'work') };

let passed = 0, failed = 0;
const results = { codex: found.codex.version, capnweb: found.capnweb, scenes: {}, blocked: [] };
const check = (ok, what, detail) => {
  if (ok) { passed++; console.log(`  ok    ${what}`); } else { failed++; console.log(`  FAIL  ${what}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); }
};
const sleep = scene.sleep;

const VIEW = { type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true, lowContext: true,
  replyFigures: true, buttons: true, chime: true, infoButton: true, chimeButton: true, contextMeter: true };
/* The usage this extension's host would send for the made-up conversation: its newest token count and what it spent. */
const USAGE = patching.usageOf({ context: { used: 251000, window: 400000 }, model: 'gpt-6.1-sol', effort: 'medium',
  tokens: { total: 1245000, input: 1200000, output: 45000, cached: 980000, reasoning: 12000 } }, 0);

/* Open a scene, tell the page what this extension's host would, and wait for it to draw. */
async function opened(name, opts = {}) {
  console.log(`\n── ${name}`);
  const s = await scene.open(ENV, { name, ...opts });
  await s.toPage(VIEW);
  await s.toPage({ type: 'codex-extras-user-times', times: s.data.times, compactions: [], turns: s.data.figures, turnTimes: s.data.turnTimes });
  await s.toPage(patching.figuresOf({ state: 'idle' }, 0));
  await s.toPage(USAGE);
  await sleep(1200);
  results.scenes[name] = { measures: {} };
  return s;
}
async function selfcheck(s) {
  const id = `sc-${Date.now()}`;
  await s.toPage({ type: 'codex-extras-selfcheck', id });
  for (let i = 0; i < 20; i++) {
    const r = await s.b.evaluate(`(window.__posted || []).filter((m) => m.kind === 'selfcheck' && m.id === ${JSON.stringify(id)}).pop() || null`);
    if (r) return r.report;
    await sleep(200);
  }
  return null;
}
const scrollTo = (s, where) => s.b.evaluate(`(() => { const sc = document.querySelector('[data-app-action-timeline-scroll]'); if (!sc) return -1;
  sc.scrollTop = ${where === 'top' ? 0 : 'sc.scrollHeight'}; return sc.scrollTop; })()`).then(() => sleep(700));
/* The measurements, and how tall the row's glyphs and Codex's own toolbar icons are inked, read off a screenshot of the
   bottom of the page at twice its size. */
async function measured(s, name, label) {
  await sleep(400);
  const m = await s.b.evaluate(MEASURE);
  const top = m.composer ? Math.max(0, m.composer.y0 - 4) : Math.max(0, m.viewport[1] - 200);
  const file = path.join(ENV.work, `${name}-${label}-ink.png`);
  await s.b.screenshot(file, { x: 0, y: top, width: m.viewport[0], height: m.viewport[1] - top, scale: 2 });
  const img = png.read(file);
  const inked = (r) => { const k = png.ink(img, { x0: r.x0 * 2, y0: (r.y0 - top) * 2, x1: r.x1 * 2, y1: (r.y1 - top) * 2 }); return k ? k.h / 2 : 0; };
  m.ink = { ours: m.ourButtons.map((b) => inked(b.rect)), codex: m.codexIcons.map(inked).filter((h) => h > 0) };
  results.scenes[name].measures[label] = m;
  return m;
}
const shot = (s, file, clip) => s.b.screenshot(path.join(SHOTS, `${file}.png`), clip);
const centre = (s, sel) => s.b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
  const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);

/*
 * Codex's floating boxes over our elements: its model menu and the conversation's own menu, each opened, shot, and
 * sampled where it overlaps anything of ours. No overlap at all is said, since nothing is then checked.
 */
async function floating(s, name) {
  for (const [label, sel] of [['model menu', 'button[data-codex-intelligence-trigger]'], ['chat actions menu', 'button[aria-label="Chat actions"]']]) {
    const at = await centre(s, sel);
    if (!at) { check(false, `${name}: Codex's ${label} button is in the page`); continue; }
    await s.b.click(at[0], at[1]);
    await sleep(700);
    await shot(s, `${name}-floating-${label.replace(/ /g, '-')}`);
    const f = await s.b.evaluate(OVER_FLOATING('[role="menu"],[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper]'));
    results.scenes[name][`floating ${label}`] = f;
    check(f.boxes > 0, `${name}: Codex's ${label} opens`, f);
    if (!f.sampled) console.log(`  note  ${name}: Codex's ${label} overlaps nothing of ours here, so there was nothing to sample`);
    else check(f.wrong.length === 0, `${name}: nothing of ours is drawn over Codex's ${label} (${f.sampled} points sampled where they overlap)`, f.wrong.slice(0, 5));
    await s.b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await s.b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(400);
  }
}

/* The assertions every drawn state is held to. */
function geometry(m, where, { strip = false } = {}) {
  check(!m.overlaps.length, `${where}: nothing of ours overlaps Codex's bubbles, buttons, message box, approval card, meter or tool rows`,
    m.overlaps.map((o) => `${o.ours} on ${o.codex}, ${o.area} px²`));
  const t = m.toolbar;
  if (t && (t.toolsInRow || t.meterInRow)) {
    /* All of it in the row or none of it: the two buttons and the meter never split between the row and the one below. */
    check(!m.bar && (!t.tools || t.toolsInRow) && (!t.meter || t.meterInRow), `${where}: the controls are all in Codex's toolbar row, none below the box`, { bar: m.bar, t });
    const mid = (r) => (r.y0 + r.y1) / 2, line = t.add ? mid(t.add) : null;
    const ours = [t.tools, t.meter].filter(Boolean);
    check(line !== null && ours.every((r) => Math.abs(mid(r) - line) <= 1), `${where}: they sit on the line of Codex's own toolbar buttons`, { line, ours });
    if (t.tools) check(t.perm && t.tools.x0 >= t.perm.x1 && t.tools.x1 <= (t.meter || t.model).x0, `${where}: the two buttons come after Codex's permissions button`, { perm: t.perm, tools: t.tools });
    if (t.meter) check(t.model && t.meter.x1 <= t.model.x0 && t.model.x0 - t.meter.x1 <= 8, `${where}: the meter stands just left of Codex's model picker`, { meter: t.meter, model: t.model });
    check(t.toolTones.every((d) => d <= 1), `${where}: in the row they show no background of their own, as Codex's buttons do not`, t.toolTones);
    const icons = m.ink.codex.filter((h) => h >= 6);
    if (icons.length >= 3) {
      const lo = Math.min(...icons), hi = Math.max(...icons);
      check(m.ink.ours.length && m.ink.ours.every((h) => h >= lo && h <= hi), `${where}: the two glyphs are inked within the heights of Codex's own toolbar icons (${lo} to ${hi} px)`, m.ink);
    }
  }
  if (m.rail) {
    check(!m.railColumn.length, `${where}: nothing Codex draws in the conversation, and no stamp of ours, is in the rail's column`,
      m.railColumn.map((c) => `${c.what}, ${c.coveredPx} px`));
  }
  if (m.bar && m.composer) {
    check(m.gaps.barBelowFrame >= 2 && m.gaps.barInView, `${where}: the button row is at least 2 px below the message box frame and inside the page`,
      { below: m.gaps.barBelowFrame, inView: m.gaps.barInView });
    /* Codex's own icons are not all one height; the glyphs are held to the range they span. Its chevrons are left out. */
    const icons = m.ink.codex.filter((h) => h >= 6);
    if (icons.length < 3) console.log(`  note  ${where}: ${icons.length} of Codex's toolbar icons drawn here, too few to hold the row's glyphs to`);
    else {
      const lo = Math.min(...icons), hi = Math.max(...icons);
      check(m.ink.ours.length && m.ink.ours.every((h) => h >= lo && h <= hi),
        `${where}: the row's glyphs are inked within the heights of Codex's own toolbar icons (${lo} to ${hi} px)`, m.ink);
    }
    check(m.barTone && m.barTone.diff <= 1, `${where}: the button row shows no background of its own against the page`, m.barTone && m.barTone.diff);
  }
  if (strip) {
    check(!!m.strip, `${where}: the figures strip is drawn`);
    if (m.strip && m.composer) {
      check(m.gaps.stripBelowFrame >= 2 && m.gaps.stripInView, `${where}: the figures strip is at least 2 px below the message box frame and inside the page`,
        { below: m.gaps.stripBelowFrame, inView: m.gaps.stripInView });
      check(m.stripTone && m.stripTone.diff <= 1, `${where}: the figures strip shows no background of its own against the page`, m.stripTone && m.stripTone.diff);
    }
  }
  check(m.replyTimes.shown === 0, `${where}: a reply carrying our time does not show Codex's own sent time as well`, m.replyTimes);
}
/* The scrollbar keeps the page's right edge and the rail and its open list stand to its left, as in Claude Code Plus: the
   room for the rail is made inside the scroller, and no message text runs under the rail. */
const RAIL_EDGES = `(() => {
  const sc = document.querySelector('[data-app-action-timeline-scroll]'), rail = document.querySelector('.codex-extras-rail');
  const panel = document.querySelector('.codex-extras-panel');
  if (!sc || !rail) return null;
  const cs = getComputedStyle(sc), r = sc.getBoundingClientRect(), rr = rail.getBoundingClientRect();
  const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
  const bar = sc.offsetWidth - sc.clientWidth - bl - br, barRight = r.right - br;
  const text = [...sc.querySelectorAll('p, li, pre, h1, h2, h3, h4, table, blockquote, [data-user-message-bubble]')]
    .map((x) => x.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
  const open = panel && getComputedStyle(panel).display !== 'none' ? panel.getBoundingClientRect() : null;
  return { vw: innerWidth, bar, border: br, barRight: Math.round(barRight), barLeft: Math.round(barRight - bar),
    rail: [Math.round(rr.left), Math.round(rr.right)], list: open ? [Math.round(open.left), Math.round(open.right)] : null,
    text: text.length, under: text.filter((b) => b.right > rr.left + 0.5).map((b) => Math.round(b.right - rr.left)) };
})()`;
async function railEdges(s, where, { list = false } = {}) {
  const e = await s.b.evaluate(RAIL_EDGES);
  results.scenes[where.split(',')[0]].measures[`railEdges ${list ? 'list open' : 'rail'}`] = e;
  if (!e) { check(false, `${where}: the rail and the scroller are in the page`); return; }
  check(e.bar > 0 && e.border === 0 && e.barRight === e.vw, `${where}: the scrollbar is at the page's right edge, with no border of ours beside it`, e);
  check(e.rail[1] <= e.barLeft && (!list || (e.list && e.list[1] <= e.barLeft)),
    `${where}: the rail${list ? ' and its open list stand' : ' stands'} left of the scrollbar, covering none of it`, e);
  if (!list) check(e.text > 0 && e.under.length === 0, `${where}: no message text runs under the rail`, e);
}
/* Codex's toolbar buttons with this script's three controls on and then off: none of them moves or changes size. With the
   controls in the row below the box, the box is raised to make room for that row, so only left edges and sizes are compared. */
async function unmoved(s, where) {
  const read = async () => { await sleep(700); return s.b.evaluate(MEASURE); };
  const on = await read();
  await s.toPage({ ...VIEW, infoButton: false, chimeButton: false, contextMeter: false });
  const off = await read();
  await s.toPage(VIEW);
  await read();
  const inRow = !!(on.toolbar && (on.toolbar.toolsInRow || on.toolbar.meterInRow));
  const key = (b) => (inRow ? [b.name, b.rect.x0, b.rect.y0, b.rect.x1, b.rect.y1] : [b.name, b.rect.x0, b.rect.x1 - b.rect.x0, b.rect.y1 - b.rect.y0]);
  const a = ((on.toolbar && on.toolbar.buttons) || []).map(key), b = ((off.toolbar && off.toolbar.buttons) || []).map(key);
  check(a.length >= 3 && JSON.stringify(a) === JSON.stringify(b),
    `${where}: none of Codex's ${a.length} toolbar buttons moves or changes size when this script's controls are ${inRow ? 'in its row' : 'below the box'}`, { on: a, off: b });
  return inRow;
}
/*
 * Typing text, pressing a key that Codex's box handles, pasting and dropping text, done once with this script's
 * controls off and once with them on: the message box ends up with the same text both times. Then clicking the
 * information button leaves the caret in the box and opens no Codex popup.
 */
async function inputUnchanged(s, where) {
  const editor = '[data-codex-composer-root] [contenteditable="true"]';
  const text = () => s.b.evaluate(`(document.querySelector('${editor}') || {}).innerText || ''`);
  const key = async (k, code, vk, modifiers = 0) => {
    await s.b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await s.b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const run = async () => {
    const at = await centre(s, editor);
    await s.b.click(at[0], at[1]);
    await sleep(200);
    await key('a', 'KeyA', 65, 2);
    await key('Backspace', 'Backspace', 8);
    await s.b.send('Input.insertText', { text: 'typed words' });
    for (let i = 0; i < 5; i++) await key('ArrowLeft', 'ArrowLeft', 37);
    await s.b.send('Input.insertText', { text: '[here]' });
    await s.b.evaluate(`(() => { const e = document.querySelector('${editor}'); const d = new DataTransfer(); d.setData('text/plain', ' pasted');
      e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); })()`);
    await sleep(200);
    const r = await s.b.evaluate(`(() => { const b = document.querySelector('${editor}').getBoundingClientRect(); return [b.left + 40, b.top + 8]; })()`);
    const data = { items: [{ mimeType: 'text/plain', data: ' dropped' }], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await s.b.send('Input.dispatchDragEvent', { type, x: r[0], y: r[1], data });
    await sleep(400);
    return text();
  };
  await s.toPage({ ...VIEW, infoButton: false, chimeButton: false, contextMeter: false });
  await sleep(600);
  const off = await run();
  await s.toPage(VIEW);
  await sleep(700);
  const on = await run();
  results.scenes[where.split(',')[0]].input = { off, on };
  check(['typed', '[', 'here]', 'words', 'pasted'].every((w) => on.includes(w)) && on === off,
    `${where}: select-all and delete, typing, the arrow keys, pasting and dropping leave the same text with the controls in the row as without them`, { off, on });
  const info = await centre(s, '[data-codex-extras="bar-button"]');
  const floatsBefore = await s.b.evaluate(`document.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper]').length`);
  await s.b.click(info[0], info[1]);
  await sleep(600);
  const after = await s.b.evaluate(`(() => ({ focused: !!(document.activeElement && document.activeElement.closest('[data-codex-composer-root] [contenteditable="true"]')),
    box: !!(document.querySelector('[data-codex-extras="info"]') && document.querySelector('[data-codex-extras="info"]').style.display === 'block'),
    floats: document.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper]').length }))()`);
  check(after.focused && after.floats === floatsBefore, `${where}: a click on the information button keeps the caret in the message box and opens nothing of Codex's`, after);
  await s.b.click(10, 10);
  await sleep(300);
}
/* The figures behind the meter, opened by resting the pointer on it. */
async function meterHover(s, where, file) {
  const at = await centre(s, '[data-codex-extras="meter"]');
  if (!at) { check(false, `${where}: the meter is drawn`); return null; }
  await s.b.hover(at[0], at[1]);
  await sleep(800);
  const box = await s.b.evaluate(`(() => { const b = document.querySelector('[data-codex-extras="context"]'), m = document.querySelector('[data-codex-extras="meter"]');
    if (!b || b.style.display !== 'block') return null; const r = b.getBoundingClientRect(), t = m.getBoundingClientRect();
    return { rect: [r.left, r.top, r.right, r.bottom].map(Math.round), meterTop: Math.round(t.top), text: b.innerText }; })()`);
  await shot(s, file);
  check(!!box && box.rect[0] >= 0 && box.rect[1] >= 0 && box.rect[2] <= innerW(s) && box.rect[3] <= box.meterTop
    && ['In context', 'Free', 'Auto-compact at', 'This conversation', 'Cached input', 'Reasoning', 'Click to compact now'].every((w) => box.text.includes(w)),
  `${where}: resting on the meter opens its figures above it, inside the page`, box);
  await s.b.hover(10, 10);
  await sleep(500);
  return box;
}
const innerW = (s) => s.width || 1100;

function selfchecked(r, where, { turns, users, rows, replies = turns }) {
  const c = (r && r.codex) || {}, t = (r && r.times) || {}, nav = (r && r.navigation) || {};
  check(!!(c.scroller && c.scroller.found), `${where}: the page script found the conversation's scroller`);
  check(c.turns >= turns, `${where}: it sees ${turns} turns or more`, c.turns);
  check(c.entries && c.entries.user === users, `${where}: it reads ${users} messages of yours`, c.entries);
  check(t.user === users && t.assistant >= replies, `${where}: every message of yours and every one of the ${replies} replies carries a time`, { user: t.user, assistant: t.assistant });
  check(nav.rows === rows, `${where}: the list has a row for each of your messages`, nav.rows);
}

(async () => {
  let s;
  /* ── the conversation: four turns, 1100 by 760 ── */
  if (want('conversation')) s = await opened('conversation');
  if (want('conversation')) try {
    const r = await selfcheck(s);
    results.scenes.conversation.selfcheck = r;
    selfchecked(r, 'conversation', { turns: 4, users: 4, rows: 4 });
    /* Each turn's times from its rollout, by turn id: seconds on every reply, and, since these turns did nothing before
       their reply and Codex draws no "Worked for" for them, the turn's duration after the reply's time. */
    {
      const said = await s.b.evaluate(`({ worked: [...document.querySelectorAll('[data-turn-key] button[aria-expanded]')].filter((b) => !b.closest('[data-local-conversation-final-assistant],[data-local-conversation-user-anchor],[data-content-search-unit-key],[data-codex-extras]')).length,
        replies: [...document.querySelectorAll('.codex-extras-stamp-assistant')].map((x) => [x.textContent, x.getAttribute('data-codex-extras-figures') || '']) })`);
      results.scenes.conversation.replyLines = said;
      const lined = said.replies.filter(([, f]) => f);
      check(said.worked === 0 && lined.length === 4 && lined.every(([t, f]) => /\d\d:\d\d:\d\d$/.test(t) && /^ \d+s · ctx \d+%/.test(f)),
        'conversation: each reply carries its seconds, and its turn\'s duration where Codex draws no "Worked for"', said);
    }
    /* The page script's layout sample of the drawn page, beside the one taken in a user's window (test/fixtures):
       which data-* names the two do not share, for a new Codex build to be read against. Said, not asserted. */
    await s.toPage({ type: 'codex-extras-sample', id: 'layout' });
    await sleep(700);
    const taken = await s.b.evaluate('(window.__posted || []).filter((m) => m.kind === "sample").pop() || null');
    if (taken && taken.sample) {
      fs.writeFileSync(path.join(OUT, 'layout-sample.json'), JSON.stringify(taken.sample, null, 1));
      const fixtures = path.join(__dirname, '..', 'fixtures');
      const name = fs.readdirSync(fixtures).filter((n) => /^conversation-layout-.*\.json$/.test(n)).sort().pop();
      if (name) {
        const real = JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8')).sample.page.dataAttrs;
        const drawn = taken.sample.page.dataAttrs;
        const cut = real[real.length - 1];
        const near = (list) => list.filter((a) => a <= cut);
        results.layout = { fixture: name, onlyInFixture: near(real).filter((a) => !drawn.includes(a)), onlyDrawn: near(drawn).filter((a) => !real.includes(a)) };
        console.log(`  note  layout sample written to ${path.join(OUT, 'layout-sample.json')}; against ${name}, up to where its list is cut: `
          + `${results.layout.onlyInFixture.length} data-* names only in the fixture, ${results.layout.onlyDrawn.length} only in the drawn page`);
      }
    }
    await scrollTo(s, 'top');
    await shot(s, 'conversation-top');
    geometry(await measured(s, 'conversation', 'top'), 'conversation, top');
    await scrollTo(s, 'bottom');
    await shot(s, 'conversation-bottom');
    geometry(await measured(s, 'conversation', 'bottom'), 'conversation, bottom');
    await shot(s, 'composer-row', { x: 0, y: 560, width: 1100, height: 200 });
    {
      const t = (results.scenes.conversation.measures.bottom || {}).toolbar || {};
      const y = t.add ? t.add.y0 - 8 : 700;
      await shot(s, 'toolbar-row', { x: 0, y, width: 1100, height: 44, scale: 2 });
    }
    check(await unmoved(s, 'conversation'), 'conversation: at 1100 px the two buttons and the meter fit in Codex\'s toolbar row');
    await meterHover(s, 'conversation', 'meter-hover');
    await inputUnchanged(s, 'conversation');
    await s.b.evaluate(`(() => { const a = [...document.querySelectorAll('[data-local-conversation-user-anchor]')].pop(); const b = a && a.querySelector('button'); if (b) b.focus(); })()`);
    await shot(s, 'user-message-focused', { x: 600, y: 380, width: 500, height: 140 });
    await s.b.evaluate('document.activeElement && document.activeElement.blur()');
    const handle = await centre(s, '.codex-extras-rail-handle');
    if (handle) {
      await s.b.click(handle[0], handle[1]);
      await sleep(500);
      await shot(s, 'list-open');
      await s.b.hover(handle[0], handle[1]);
      await sleep(300);
      const hover = await s.b.evaluate(`(() => { const h = document.querySelector('.codex-extras-rail-handle'); const c = getComputedStyle(h);
        return { color: c.backgroundColor, image: c.backgroundImage }; })()`);
      results.scenes.conversation.handleHover = hover;
      const opaque = /rgb\(/.test(hover.color) || (/rgba\([^)]*,\s*1\)/.test(hover.color));
      check(opaque, 'the rail handle is opaque while hovered', hover);
      /* The handle has a hover label drawn by the script, and a list row shows its time and opening characters in a box
         beside the list, as in Claude Code Plus. */
      await s.b.hover(10, 10);
      await s.b.hover(handle[0], handle[1]);
      await sleep(200);
      const label = await s.b.evaluate(`(() => { const b = document.querySelector('[data-codex-extras="label"]'); return b ? b.textContent : null; })()`);
      await shot(s, 'rail-handle-hover');
      check(/Your messages in this conversation/.test(label || ''), 'conversation: resting on the rail\'s handle shows its explanation in a box of this script\'s own', label);
      const row = await centre(s, '[data-codex-extras="nav-row"]');
      if (row) {
        await s.b.hover(row[0], row[1]);
        await sleep(300);
        const tip = await s.b.evaluate(`(() => { const t = document.querySelector('[data-codex-extras="nav-tip"]'); const p = document.querySelector('.codex-extras-panel');
          if (!t || !p) return null; const a = t.getBoundingClientRect(), b = p.getBoundingClientRect();
          return { text: t.textContent.slice(0, 60), right: Math.round(a.right), panelLeft: Math.round(b.left), panelWidth: Math.round(b.width), top: Math.round(a.top) }; })()`);
        results.scenes.conversation.rowTip = tip;
        await shot(s, 'list-row-hover');
        check(!!tip && /^\d\d:\d\d/.test(tip.text) && tip.right <= tip.panelLeft && tip.panelWidth === 280,
          'conversation: resting on a row of the 280-wide list shows its time and words in a box to the left of the list', tip);
      }
      await s.b.click(handle[0], handle[1]);
      await s.b.hover(10, 10);
    }
    await floating(s, 'conversation');
    /* The yellow "!" of a page the script cannot read. There is none on this page, whose messages are all recognised.
       After the attributes it finds messages by are renamed, as a Codex release might rename them, one appears after
       three passes and five seconds, at the top right of the conversation and over none of Codex's buttons. */
    {
      const warnAt = () => s.b.evaluate(`(() => { const w = document.querySelector('[data-codex-extras="warn"]'); if (!w) return null;
        const a = w.getBoundingClientRect(); const over = [...document.querySelectorAll('button')].filter((b) => !b.closest('[data-codex-extras]')).filter((b) => {
          const r = b.getBoundingClientRect(); return r.width > 0 && r.left < a.right && a.left < r.right && r.top < a.bottom && a.top < r.bottom; }).length;
        const sc = document.querySelector('[data-app-action-timeline-scroll]'); return { x: [a.left, a.right].map(Math.round), y: [a.top, a.bottom].map(Math.round),
        scrollerTop: sc ? Math.round(sc.getBoundingClientRect().top) : null, vw: innerWidth, over }; })()`);
      check(await warnAt() === null, 'conversation: a page whose messages are recognised shows no "!"');
      await s.b.evaluate(`(() => { for (const a of ['data-local-conversation-user-anchor', 'data-response-annotation-target', 'data-user-message-bubble'])
        for (const e of [...document.querySelectorAll('[' + a + ']')]) { e.setAttribute(a + '-renamed', e.getAttribute(a)); e.removeAttribute(a); } })()`);
      for (let i = 0; i < 3; i++) { await s.toPage(VIEW); await sleep(200); }
      await sleep(5200);
      await s.toPage(VIEW);
      await sleep(400);
      const w = await warnAt();
      results.scenes.conversation.warn = w;
      await shot(s, 'unrecognised-warn');
      check(!!w && w.x[1] === w.vw - 4 && w.x[1] - w.x[0] === 16 && w.y[0] >= w.scrollerTop && w.over === 0,
        'conversation: with its messages no longer recognised, the page shows a 16 px "!" at the top right of the conversation, over none of Codex\'s buttons', w);
    }
    results.blocked.push(...s.b.blocked);
  } finally { await s.close(); }

  /* ── the same at the width of Codex's sidebar, and at a wide window ── */
  for (const [name, width, height] of [['narrow', 400, 760], ['wide', 1600, 900]].filter(([n]) => want(n))) {
    s = await opened(name, { width, height });
    s.width = width;
    try {
      await scrollTo(s, 'bottom');
      await shot(s, `${name}-bottom`);
      geometry(await measured(s, name, 'bottom'), `${name}, bottom`);
      const inRow = await unmoved(s, name);
      results.scenes[name].inToolbar = inRow;
      console.log(`  note  ${name}: at ${width} px the controls are ${inRow ? 'in Codex\'s toolbar row' : 'in the row below the message box, the toolbar having no room for them'}`);
      if (name === 'narrow') {
        /* Without the meter the two buttons alone fit at this width. */
        await s.toPage({ ...VIEW, contextMeter: false });
        const m2 = await measured(s, name, 'buttons only');
        geometry(m2, `${name}, two buttons only`);
        check(!!(m2.toolbar && m2.toolbar.toolsInRow), `${name}: the two buttons alone fit in the toolbar row at ${width} px`, m2.toolbar);
        await shot(s, `${name}-buttons-only`, { x: 0, y: 680, width, height: 80, scale: 2 });
        await s.toPage(VIEW);
        await sleep(700);
      }
      await scrollTo(s, 'top');
      geometry(await measured(s, name, 'top'), `${name}, top`);
      const handle = await centre(s, '.codex-extras-rail-handle');
      if (handle) { await s.b.click(handle[0], handle[1]); await sleep(500); await shot(s, `${name}-list-open`); await s.b.click(handle[0], handle[1]); await sleep(300); }
      if (name === 'narrow') { await scrollTo(s, 'bottom'); await floating(s, name); }
      results.blocked.push(...s.b.blocked);
    } finally { await s.close(); }
  }

  /* ── the rail beside a scrollbar that is drawn, which the scenes above hide, at a wide window and at the sidebar's width ── */
  for (const [name, width, height] of [['rail-wide', 1600, 900], ['rail-narrow', 400, 760]].filter(([n]) => want(n) || want('rail'))) {
    s = await opened(name, { width, height, scrollbars: true });
    try {
      await scrollTo(s, 'bottom');
      await shot(s, name);
      await shot(s, `${name}-edge`, { x: width - 140, y: 0, width: 140, height, scale: 2 });
      await railEdges(s, name);
      const handle = await centre(s, '.codex-extras-rail-handle');
      if (handle) {
        await s.b.click(handle[0], handle[1]);
        await sleep(500);
        await shot(s, `${name}-list-open`);
        await railEdges(s, `${name}, list open`, { list: true });
        await s.b.click(handle[0], handle[1]);
        await sleep(300);
      } else check(false, `${name}: the rail's handle is in the page`);
      results.blocked.push(...s.b.blocked);
    } finally { await s.close(); }
  }

  /* ── the Agent map: Claude Code's pill in the row of this script's controls, and the dialog it opens ── */
  for (const [name, width, height] of [['agentmap', 1100, 760], ['agentmap-narrow', 400, 760]].filter(([n]) => want(n) || want('agentmap'))) {
    s = await opened(name, { width, height });
    try {
      const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;
      await s.toPage({ type: 'codex-extras-agent-map', shown: true,
        wakeups: [{ everyMinutes: 10, prompt: 'Keep going with the open rows of the plan.', nextMs: Date.now() + 7 * 60e3, expiresMs: Date.now() + 6 * 86400e3, paused: false }],
        goal: { status: 'active', objective: 'Make the nightly export skip archived rows and report how many it skipped', tokensUsed: 182000, tokenBudget: 1000000 },
        agents: [{ id: ID(3), name: 'scout', title: 'Find where the retry delay is set', dot: 'working', updatedMs: Date.now() - 20e3 },
          { id: ID(4), name: 'Fix the flaky upload test', title: 'Fix the flaky upload test', dot: 'idle', updatedMs: Date.now() - 12 * 60e3 }] });
      await sleep(700);
      await scrollTo(s, 'bottom');
      const pill = await s.b.evaluate(`(() => {
        const p = document.querySelector('[data-codex-extras="agents"]');
        if (!p) return null;
        const b = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x0: r.left, x1: r.right, y0: r.top, y1: r.bottom, mid: (r.top + r.bottom) / 2 }; };
        const meter = document.querySelector('[data-codex-extras="meter"]'), info = document.querySelector('[data-codex-extras="tools"]');
        const st = getComputedStyle(p);
        return { text: p.textContent, rect: b(p), meter: b(meter), tools: b(info), inBar: !!p.closest('[data-codex-extras="bar"]'),
          radius: st.borderRadius, bg: st.backgroundColor, dot: (() => { const d = p.querySelector('[data-codex-extras-dot]'); return d ? [b(d).x1 - b(d).x0, d.getAttribute('data-codex-extras-dot')] : null; })() };
      })()`);
      results.scenes[name].measures.pill = pill;
      await shot(s, `${name}-pill`, { x: 0, y: Math.max(0, height - 120), width, height: 120, scale: 2 });
      check(!!pill && pill.text === '2 agents · 1 timer · goal' && pill.dot && pill.dot[0] === 6 && pill.dot[1] === 'working' && pill.radius === '9999px',
        `${name}: the Agent map pill reads as Claude Code Plus labels it, with a 6 px dot for its agents, and is rounded as Claude Code's`, pill);
      check(!!pill && !!pill.meter && Math.abs(pill.rect.mid - pill.meter.mid) <= 1 && (pill.inBar ? pill.rect.x0 >= pill.meter.x1 : pill.rect.x1 <= pill.meter.x0),
        `${name}: it sits on the line of the context meter, ${pill && pill.inBar ? 'after it in the row below the box' : 'just left of it in Codex\'s toolbar row'}`, pill);
      const at = await centre(s, '[data-codex-extras="agents"]');
      if (!at) { check(false, `${name}: the Agent map pill is in the page to be clicked`); continue; }
      const t0 = await s.b.evaluate('performance.now()');
      await s.b.click(at[0], at[1]);
      const opened2 = await s.b.evaluate(`(() => { const d = document.querySelector('[data-codex-extras="map-dialog"]'); void (d && d.offsetHeight); return performance.now(); })()`);
      await sleep(300);
      await shot(s, name);
      const dlg = await s.b.evaluate(`(() => {
        const o = document.querySelector('[data-codex-extras="agent-map"]'), d = document.querySelector('[data-codex-extras="map-dialog"]');
        if (!o || !d) return null;
        const r = d.getBoundingClientRect(), or = o.getBoundingClientRect(), st = getComputedStyle(d), h = d.querySelector('h3');
        const rows = [...d.querySelectorAll('[data-codex-extras="map-agent"]')].map((x) => { const b = x.getBoundingClientRect(); return [Math.round(b.width), getComputedStyle(x).borderRadius]; });
        return { cover: [or.left, or.top, or.right, or.bottom], box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
          vw: innerWidth, vh: innerHeight, radius: st.borderRadius, bg: st.backgroundColor, overlay: getComputedStyle(o).backgroundColor,
          title: [h.textContent, getComputedStyle(h).fontSize, getComputedStyle(h).fontWeight],
          sections: [...d.querySelectorAll('[data-codex-extras^="map-"]')].map((x) => x.getAttribute('data-codex-extras')).filter((k) => /^map-(wakeups|goal|agents)$/.test(k)),
          rows, dots: [...d.querySelectorAll('[data-codex-extras="map-agent"] [data-codex-extras-dot]')].map((x) => Math.round(x.getBoundingClientRect().width)),
          focused: document.activeElement === d };
      })()`);
      results.scenes[name].measures.dialog = { ...dlg, openMs: +(opened2 - t0).toFixed(1) };
      check(!!dlg && dlg.cover.join() === `0,0,${dlg.vw},${dlg.vh}` && dlg.overlay === 'rgba(0, 0, 0, 0.75)' && dlg.radius === '8px' && dlg.bg === 'rgb(24, 24, 24)'
        && dlg.title.join() === 'Agent map,16px,600' && dlg.focused,
      `${name}: the dialog is Claude Code's: a dimmed page, an 8 px rounded box in the sidebar's colour, the title in 16 px at weight 600, and it takes the focus`, dlg);
      check(!!dlg && dlg.sections.join() === 'map-wakeups,map-goal,map-agents' && dlg.box[0] >= 16 && dlg.box[2] <= dlg.vw - 16 && dlg.box[1] >= 0 && dlg.box[3] <= dlg.vh
        && dlg.rows.every(([w, rad]) => w === Math.min(300, dlg.box[2] - dlg.box[0] - 32 - 8) && rad === '4px') && dlg.dots.length === 2 && dlg.dots.every((x) => x === 8),
      `${name}: it holds the wake-up, the goal and the sub-agents in that order, inside the page, each agent a 4 px rounded row with an 8 px dot`, dlg);
      const press = async (sel) => { const c = await centre(s, sel); if (c) { await s.b.click(c[0], c[1]); await sleep(150); } return !!c; };
      await s.b.evaluate('window.__posted.length = 0');
      const pressed = [await press('[data-codex-extras-act="removeWakeup"]'), await press('[data-codex-extras-act="pauseGoal"]')];
      const sent = await s.b.evaluate('window.__posted.filter((m) => m.kind === "agentMap").map((m) => m.action)');
      check(pressed.every(Boolean) && sent.join() === 'removeWakeup,pauseGoal', `${name}: Remove and Pause send their requests to the host`, { pressed, sent });
      await s.b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(200);
      const gone = await s.b.evaluate('!document.querySelector(\'[data-codex-extras="agent-map"]\')');
      check(gone && results.scenes[name].measures.dialog.openMs < 100, `${name}: Esc closes it and takes it off the page; it was on screen within 100 ms of the click`,
        { gone, openMs: results.scenes[name].measures.dialog.openMs });
      results.blocked.push(...s.b.blocked);
    } finally { await s.close(); }
  }

  /* ── a turn some other page started, stopped on an approval ── */
  if (want('approval')) s = await opened('approval');
  if (want('approval')) try {
    let tool = null;
    for (const m of live.approval()) {
      await s.toPage(m);
      if (m.type === 'mcp-notification' && m.method === 'item/started' && m.params.item.type === 'commandExecution') {
        tool = { name: 'shell', startedMs: m.params.startedAtMs, endedMs: 0, callId: m.params.item.id };
      }
      await sleep(120);
    }
    await s.toPage(patching.figuresOf({ state: 'working', lastTool: tool }, 0));
    await sleep(1500);
    await scrollTo(s, 'bottom');
    const r = await selfcheck(s);
    results.scenes.approval.selfcheck = r;
    check(!!(r && r.approval && r.approval.onScreen && r.approval.told === true), 'approval: the card is seen and the host is told approval: true', r && r.approval);
    const told = await s.b.evaluate(`(window.__posted || []).filter((m) => m.kind === 'approval').map((m) => m.on)`);
    check(told.includes(true), 'approval: the page posted approval: true', told);
    selfchecked(r, 'approval', { turns: 5, users: 5, rows: 5, replies: 4 });
    await shot(s, 'approval');
    await shot(s, 'approval-zoom', { x: 0, y: 520, width: 1100, height: 240, scale: 2 });
    const m = await measured(s, 'approval', 'bottom');
    geometry(m, 'approval, bottom', { strip: false });
    check(!/running for/.test(m.stripText), 'approval: while Codex shows the running command itself, the strip does not say it again', m.stripText);
    results.blocked.push(...s.b.blocked);
  } finally { await s.close(); }

  /* ── the message box with a command still running in the background, and Codex's own context meter on ── */
  if (want('background')) s = await opened('background', { settings: { 'show-context-window-usage': true } });
  if (want('background')) try {
    patching.installHooks();
    let tool = null;
    for (const m of live.background()) {
      await s.toPage(m);
      if (m.type === 'mcp-notification') globalThis.__codexExtrasAppServer('notification', { method: m.method, params: m.params });
      if (m.method === 'item/started' && m.params.item.type === 'commandExecution') tool = { name: 'exec_command', startedMs: m.params.startedAtMs, endedMs: 0, callId: m.params.item.id };
      await sleep(120);
    }
    const usage = { inputTokens: 251000, cachedInputTokens: 0, outputTokens: 900, reasoningOutputTokens: 300, totalTokens: 251900 };
    await s.toPage({ type: 'mcp-notification', hostId: 'local', method: 'thread/tokenUsage/updated',
      params: { threadId: fake.THREAD, turnId: live.TURN, tokenUsage: { last: usage, total: usage, modelContextWindow: 400000 } } });
    const running = patching.runningCommands(fake.THREAD).length;
    const fig = patching.figuresOf({ state: 'working', lastTool: tool }, running);
    await s.toPage(fig);
    await sleep(1500);
    await scrollTo(s, 'bottom');
    await shot(s, 'background');
    await shot(s, 'background-composer', { x: 0, y: 480, width: 1100, height: 280 });
    await shot(s, 'background-composer-zoom', { x: 500, y: 680, width: 600, height: 80, scale: 2 });
    const m = await measured(s, 'background', 'bottom');
    const meters = (m.toolbar && m.toolbar.meters) || [];
    results.scenes.background.meters = meters;
    results.scenes.background.figures = fig;
    check(running === 1, 'background: the host counts one command still running from the app-server\'s item/started', running);
    check(meters.length === 1 && !meters[0].drawn && !!(m.toolbar && m.toolbar.meter),
      'background: with Codex\'s own meter on, it is hidden while this script\'s is drawn, so the row shows one', { meters, ours: m.toolbar && m.toolbar.meter });
    await s.toPage({ ...VIEW, contextMeter: false });
    const m2 = await measured(s, 'background', 'meter off');
    check(((m2.toolbar && m2.toolbar.meters) || []).some((x) => x.drawn) && !(m2.toolbar && m2.toolbar.meter),
      'background: with codexPlus.contextMeter off, Codex\'s own meter is back and this script draws none', m2.toolbar && m2.toolbar.meters);
    await shot(s, 'background-composer-codex-meter', { x: 500, y: 680, width: 600, height: 80, scale: 2 });
    await s.toPage(VIEW);
    await sleep(700);
    geometry(m, 'background, bottom', { strip: true });
    check(/1 command running/.test(m.stripText) && !/running for/.test(m.stripText),
      'background: the strip says one command is running, and not the tool call Codex already shows', m.stripText);
    results.blocked.push(...s.b.blocked);
  } finally { await s.close(); }

  /*
   * ── compacting from the meter, through Codex's real app-server ──
   * The host's side is src/patching.js itself, with this run's app-server standing in for the one Codex connects to in
   * a window. The app-server has no network here, so the compaction it starts cannot finish.
   */
  if (want('compact')) {
    const asked = [];
    s = await opened('compact', { onAppServer: (kind, m) => { if (kind === 'notification' && globalThis.__codexExtrasAppServer) globalThis.__codexExtrasAppServer('notification', m); } });
    try {
      patching.installHooks();
      /* What an earlier scene of this run left: its live turn on the same made-up conversation, never ended there. */
      globalThis.__codexExtrasAppServer('notification', { method: 'turn/completed', params: { threadId: fake.THREAD, turn: { id: 'earlier' } } });
      patching._approvals.clear();
      let handler = null;
      const conn = {
        registerProvider(name, h) { handler = h; return { dispose() { handler = null; } }; },
        sendRequest(name, id, method, params) {
          asked.push({ method, params });
          s.as.request(method, params).then((r) => { if (handler) handler.onResult({ ...r, id }); });
        },
      };
      const webview = {};
      const provider = { postMessageToWebview: (w, msg) => { s.toPage(msg); }, sendMessageToPanel() {}, codexMcpConnection: conn };
      globalThis.__codexExtrasPanel({ webview, reveal() {}, onDidDispose() {}, iconPath: null }, fake.THREAD, provider);
      let handled = 0;
      const relay = async () => {
        const list = await s.b.evaluate("(window.__posted || []).filter((m) => m.kind === 'compact')");
        for (const msg of list.slice(handled)) globalThis.__codexExtrasMessage(webview, msg, provider);
        handled = list.length;
      };
      const editor = '[data-codex-composer-root] [contenteditable="true"]';
      const at = await centre(s, editor);
      await s.b.click(at[0], at[1]);
      await s.b.send('Input.insertText', { text: 'a draft to keep' });
      const meter = await centre(s, '[data-codex-extras="meter"]');
      await s.b.click(meter[0], meter[1]);
      await sleep(300);
      await relay();
      await sleep(2500);
      const after = await s.b.evaluate(`(() => ({ draft: (document.querySelector('${editor}') || {}).innerText || '',
        focused: !!(document.activeElement && document.activeElement.closest('${editor}')),
        said: (document.querySelector('[data-codex-extras="label"]') || {}).textContent || '',
        drawn: /Compacting context|Context compacted/.test((document.querySelector('[data-app-action-timeline-scroll]') || {}).innerText || ''),
        posted: (window.__posted || []).filter((m) => m.kind === 'compact').map((m) => Object.keys(m).sort().join(',')) }))()`);
      results.scenes.compact.first = { after, asked };
      await shot(s, 'compact-started');
      check(asked.length === 1 && asked[0].method === 'thread/compact/start' && asked[0].params.threadId === fake.THREAD,
        'compact: a click on the meter sends thread/compact/start for this conversation to the app-server, once', asked);
      check(after.posted.every((k) => k === 'id,kind,type'), 'compact: the page sends nothing but an id with it', after.posted);
      check(after.drawn && after.said === 'Compaction started', 'compact: Codex\'s page draws the compaction, and the meter says it started', after);
      check(after.draft === 'a draft to keep' && after.focused, 'compact: the draft in the message box is left as it was, with the caret in it', after);
      await s.b.click(meter[0], meter[1]);
      await sleep(300);
      await relay();
      await sleep(600);
      const busy = await s.b.evaluate("(document.querySelector('[data-codex-extras=\"label\"]') || {}).textContent || ''");
      results.scenes.compact.second = { busy, asked: asked.length };
      await shot(s, 'compact-busy', { x: 500, y: 600, width: 600, height: 160, scale: 2 });
      check(asked.length === 1 && busy === 'Compact is disabled while a chat is in progress',
        'compact: a second click while that compaction runs sends nothing and says so in Codex\'s own words', { busy, asked: asked.length });
      results.blocked.push(...s.b.blocked);
    } finally { await s.close(); }
  }

  /* ── a long conversation over two days: ten turns yesterday and fifteen today ── */
  /*
   * ── a chime before and after the page is clicked, under the browser's own autoplay rule ──
   *
   * Nobody has clicked or typed in a page that has just opened, so the audio context the first chime makes starts
   * suspended and plays nothing; the page tells the host so. A click in the page (Input.dispatchMouseEvent, as a person
   * would click) is what lets it run, and the next chime then starts its oscillators in a running context.
   */
  if (want('chime')) {
    s = await opened('chime');
    try {
      await s.b.evaluate(`(() => { const C = window.AudioContext; window.__ctxs = []; window.__osc = 0;
        window.AudioContext = class extends C { constructor(...a) { super(...a); window.__ctxs.push(this); } };
        const make = C.prototype.createOscillator; C.prototype.createOscillator = function () { window.__osc++; return make.apply(this, arguments); }; })()`);
      const heard = () => s.b.evaluate(`({ told: (window.__posted || []).filter((m) => m.kind === 'chime').map((m) => m.state),
        state: window.__ctxs[0] ? window.__ctxs[0].state : 'none', osc: window.__osc })`);
      await s.toPage({ type: 'codex-extras-chime', kind: 'done' });
      await sleep(800);
      const before = await heard();
      results.scenes.chime.before = before;
      check(before.told[0] === 'suspended' && before.state === 'suspended' && before.osc === 0,
        'chime: in a page nobody has clicked, a chime finds its audio context suspended, plays nothing, and the page tells the host so', before);
      const at = await centre(s, '[data-app-action-timeline-scroll]');
      await s.b.click(at[0], at[1]);
      await sleep(500);
      await s.toPage({ type: 'codex-extras-chime', kind: 'done' });
      await sleep(800);
      const after = await heard();
      results.scenes.chime.after = after;
      check(after.state === 'running' && after.osc >= 2 && after.told.length === before.told.length,
        'chime: after one click in the page the next chime runs in a running context and starts its oscillators, with nothing to report', after);
      results.blocked.push(...s.b.blocked);
    } finally { await s.close(); }
  }

  if (want('long')) s = await opened('long', { turns: fake.manyTurns(25), days: [[1, 10], [0, 15]] });
  if (want('long')) try {
    await scrollTo(s, 'bottom');
    await sleep(800);
    const r = await selfcheck(s);
    results.scenes.long.selfcheck = r;
    const c = (r && r.codex) || {}, nav = (r && r.navigation) || {};
    console.log(`  note  long: Codex keeps ${c.turns} of 25 turns in the page; ${c.userAnchors} messages of yours found, the list has ${nav.rows} rows`);
    await shot(s, 'long-bottom');
    geometry(await measured(s, 'long', 'bottom'), 'long, bottom');
    const handle = await centre(s, '.codex-extras-rail-handle');
    if (handle) { await s.b.click(handle[0], handle[1]); await sleep(600); }
    await shot(s, 'long-list-open');
    const list = await s.b.evaluate(`(() => { const p = document.querySelector('.codex-extras-panel'); const f = document.querySelector('[data-codex-composer-root]');
      if (!p) return null; const a = p.getBoundingClientRect(), b = f ? f.getBoundingClientRect() : null;
      const rows = [...p.querySelectorAll('.codex-extras-row')].map((x) => (x.querySelector('.codex-extras-row-when') || {}).textContent || '');
      return { rows: rows.length, whens: rows, panel: [a.left, a.top, a.right, a.bottom].map(Math.round),
        overComposer: b ? Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) * Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) : 0 }; })()`);
    results.scenes.long.list = list;
    const stamps = await s.b.evaluate(`[...document.querySelectorAll('.codex-extras-stamp-user')].map((e) => e.textContent)`);
    results.scenes.long.userStamps = stamps;
    const leftNav = await s.b.evaluate(`(() => [...document.querySelectorAll('body *')].filter((e) => { if (e.closest('[data-codex-extras]')) return false;
      const st = getComputedStyle(e); if (st.position !== 'fixed' && st.position !== 'sticky' && st.position !== 'absolute') return false;
      const b = e.getBoundingClientRect(); return b.left <= 4 && b.width > 0 && b.width < 60 && b.height > 80; }).length)()`);
    results.scenes.long.leftNav = leftNav;
    console.log(`  note  long: the list shows ${list && list.rows} rows; stamps on your messages read ${JSON.stringify(stamps.slice(0, 2))}...; `
      + `${leftNav} narrow fixed element(s) of Codex's at the left edge; the open list overlaps the message box by ${list && list.overComposer} px²`);
    check(list && list.overComposer === 0, 'long: the open list does not cover the message box', list);
    /* Yesterday's turns, which Codex mounts only once the view is near them, and whose times it writes after the day's
       name ("Sunday 9:02 AM"). Scrolled up in steps, since each step mounts the turns above. */
    if (handle) { await s.b.click(handle[0], handle[1]); await sleep(300); }
    for (let i = 0; i < 12; i++) await scrollTo(s, 'top');
    const early = await s.b.evaluate(`(() => ({ divider: [...document.querySelectorAll('[data-app-action-timeline-scroll] time[datetime]')].map((x) => x.textContent.trim()),
      day: [...document.querySelectorAll('[data-app-action-timeline-scroll] time[datetime]')].map((x) => { const d = new Date(x.getAttribute('datetime'));
        return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0'); })[0] || '',
      users: [...document.querySelectorAll('.codex-extras-stamp-user')].map((x) => x.textContent),
      replies: [...document.querySelectorAll('.codex-extras-stamp-assistant')].map((x) => x.textContent) }))()`);
    results.scenes.long.top = early;
    await shot(s, 'long-top');
    console.log(`  note  long, top: Codex's day divider reads ${JSON.stringify(early.divider)}; stamps there ${JSON.stringify(early.users.slice(0, 2))}...`);
    const ofDay = (x) => !!early.day && new RegExp(`^${early.day} \\d\\d:\\d\\d`).test(x);
    check(early.users.length > 0 && early.users.every(ofDay) && early.replies.length > 0 && early.replies.every(ofDay),
      'long, top: yesterday\'s messages and replies carry a time too, read from Codex\'s "<day> <clock>" and written after the date of its divider', early);
    geometry(await measured(s, 'long', 'top'), 'long, top');
    results.blocked.push(...s.b.blocked);
  } finally { await s.close(); }

  /* The session list's own page, which is this extension's rather than Codex's (lib/sessions-scene.js). */
  if (want('sessions')) await require('./lib/sessions-scene').run({ env: ENV, check, shots: SHOTS, out: OUT, results });

  results.passed = passed;
  results.failed = failed;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  const hosts = [...new Set(results.blocked.map((u) => { try { return new URL(u).host; } catch (_) { return u; } }))];
  console.log(`\nrequests failed in the browser because they were not to 127.0.0.1: ${results.blocked.length}${hosts.length ? ` (${hosts.join(', ')})` : ''}`);
  console.log(`screenshots in ${SHOTS}; measurements in ${path.join(OUT, 'results.json')}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
