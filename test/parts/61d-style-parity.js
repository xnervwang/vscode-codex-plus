// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What this extension draws in Codex's conversation page, held to what Claude Code Plus draws for the same thing: the
 * hover labels, the time stamps, the two toolbar glyphs, the session information box, the strip's tool clock, the
 * button labels, the fonts, the Agent map's dots and its dialog's focus border, the context box, the rail's list, and
 * Codex's own time beside a message of yours while the stamps are on. Also the command titles shared with Claude Code
 * Plus's. The render check measures the same things in Codex's real page.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

/* The conversation of test/parts/63-release-polish.js: two turns of the user's, the message box, an optional meter.
   `own` puts a clock in the first message's row of buttons, where Codex renders its own time. */
function page(root, { own = '' } = {}) {
  const dom = createDom();
  const turn = (n) => dom.el('div', { attrs: { 'data-turn-key': `t${n}` }, kids: [dom.el('div', { attrs: { 'data-local-conversation-user-anchor': '' },
    kids: [dom.el('div', { attrs: { 'data-user-message-bubble': '' }, texts: [`message ${n}`] }),
      ...(own && n === 1 ? [dom.el('div', { kids: [dom.el('span', { attrs: { 'data-own': '' }, texts: [own] })] })] : [])] })] });
  const scroller = dom.el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, kids: [turn(1), turn(2)] });
  const composer = dom.el('div', { attrs: { 'data-codex-composer-root': '' }, rect: { top: 600, left: 40, width: 700, height: 120 } });
  dom.setBody(dom.el('body', { kids: [dom.el('div', { kids: [scroller, composer] })] }));
  const posted = [];
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerHeight: 760, innerWidth: 1100 };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const send = (m) => listeners.message({ data: m });
  const view = (over = {}) => send(Object.assign({ type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true }, over));
  view();
  return { dom, posted, send, view, q: (sel) => dom.document.root.querySelectorAll(sel) };
}

module.exports = async ({ eq, root }) => {
  const source = fs.readFileSync(path.join(root, 'src', 'page', 'codex-extras-page.js'), 'utf8');
  const p = page(root, { own: '9:08 AM' });
  const css = () => (p.q('[data-codex-extras="style"]')[0] || {}).textContent || '';
  const ruleOf = (text, sel) => { const i = text.indexOf(sel + '{'); return i < 0 ? '' : text.slice(i + sel.length + 1, text.indexOf('}', i)); };

  /* ── the hover label: Claude Code Plus's box ── */
  const [info, mute] = p.q('[data-codex-extras="bar-button"]');
  mute.dispatch('mouseenter', {});
  const label = p.q('[data-codex-extras="label"]')[0];
  const look = label ? label.style.cssText : '';
  eq(['padding:8px;', 'background:var(--vscode-menu-background,', 'border:1px solid var(--vscode-inlineChatInput-border,var(--vscode-input-border,',
    'border-radius:8px;', 'color:var(--vscode-foreground,', 'font-size:.9em;'].map((x) => look.includes(x)).concat(/font:/.test(look)),
  [true, true, true, true, true, true, false],
  'a hover label is Claude Code Plus\'s: the menu background, the input border, 8 px corners and padding, the foreground, 0.9em in the page\'s own font');
  mute.dispatch('mouseleave', {});

  /* ── the time stamps: monospace, 0.8em, the text's own colour at 60% ── */
  const stamp = ruleOf(css(), '.codex-extras-stamp');
  eq([stamp.includes('font-family:var(--vscode-editor-font-family,monospace)'), stamp.includes('font-size:.8em'), stamp.includes('opacity:.6'),
    /(^|;)color:/.test(stamp), /font:/.test(stamp)], [true, true, true, false, false],
  'a stamp is in the editor\'s monospace font at 0.8em, in the colour of the text around it at 60%, as Claude Code Plus\'s');

  /* ── Codex's own time beside a message of yours is hidden while the stamps are on ── */
  const own = p.q('[data-own]')[0];
  eq([own.classList.contains('codex-extras-own-time'), /\.codex-extras-own-time\{display:none !important;\}/.test(css())], [true, true],
    'the clock Codex renders beside your message is hidden while this script stamps it, as Claude Code Plus hides Claude Code\'s');
  p.view({ timestamps: false });
  eq(/\.codex-extras-own-time\{/.test(css()), false, 'and shown again with the stamps off');
  p.view();

  /* ── the two glyphs: ℹ and ♪, the note struck straight through at 40% while chimes are off ── */
  const parts = (b) => b.querySelectorAll('svg')[0].childNodes;
  eq(parts(info).some((n) => n.getAttribute('fill') === 'none'), false, 'the information button is the letter ℹ, not a ringed i');
  const strike = parts(mute).find((n) => n.getAttribute('data-codex-extras-mute') !== null);
  eq(!!strike && /^M[\d.]+ ([\d.]+)h[\d.]+$/.test(strike.getAttribute('d')), true, 'the note\'s strike is a horizontal line through it, as text-decoration draws one');
  p.view({ chime: false });
  eq(p.q('[data-codex-extras="bar-button"]')[1].style.opacity, '0.4', 'and while chimes are off the note is at 40%, as Claude Code Plus\'s is');

  /* ── button labels, as Claude Code Plus words them ── */
  eq([p.q('[data-codex-extras="bar-button"]')[1].getAttribute('aria-label'), (p.view(), p.q('[data-codex-extras="bar-button"]')[1].getAttribute('aria-label'))],
    ['Chimes are muted - click to hear a chime when a turn finishes', 'A chime when a turn finishes, and when Codex is waiting for you - click to mute'],
    'the chime button says what Claude Code Plus\'s says, with Codex for Claude');
  const infoLabel = info.getAttribute('aria-label');
  eq([/^About this conversation: /.test(infoLabel), /\.$/.test(infoLabel), /Click a value/.test(infoLabel)], [true, false, false],
    'the information button\'s label is one clause with no full stop, as Claude Code Plus\'s');

  /* ── the session information box ── */
  info.dispatch('click', { stopPropagation() {} });
  const ask = p.posted.filter((m) => m.kind === 'infoAsk').pop();
  p.send({ type: 'codex-extras-info', id: ask.id, rows: [{ label: 'Thread', value: 'abc' }, { label: 'Process', value: '42' }] });
  const box = p.q('[data-codex-extras="info"]')[0];
  const line = box.childNodes[0];
  eq([/width:400px;/.test(box.style.cssText), /align-items:baseline;/.test(line.style.cssText), /flex:0 0 72px;/.test(line.childNodes[0].style.cssText)],
    [true, true, true], 'the box is 400 px wide, its names in a 72 px column on the values\' baseline, as Claude Code Plus\'s');
  const value = line.childNodes[1];
  value.dispatch('click', { stopPropagation() {} });
  eq([value.textContent, value.style.opacity], ['copied', '0.6'], 'a value clicked says "copied" at 60% for a moment');

  /* ── the strip's tool clock: the reply's duration format, at 80% ── */
  p.send({ type: 'codex-extras-figures', text: '', tool: 'exec_command', toolSince: Date.now() - 120000 });
  const strip = p.q('[data-codex-extras="figures"]')[0];
  const two = strip.textContent;
  p.send({ type: 'codex-extras-figures', text: '', tool: 'exec_command', toolSince: Date.now() - 3903000 });
  eq([/^exec_command running for 2m \(since /.test(two), /^exec_command running for 1h5m \(since /.test(strip.textContent), /opacity:\.8;/.test(strip.style.cssText)],
    [true, true, true], 'a tool clock writes 2m and 1h5m as a reply\'s duration is written, at 80% as Claude Code Plus\'s is');

  /* ── fonts: the page's own family, only the size set ── */
  eq((source.match(/font:\s*(?:\d{3}\s+)?\d+px\s+var\(--vscode-font-family/g) || []).length, 0,
    'nothing this script draws names a font family of its own; each box takes Codex\'s page font and sets only its size');

  /* ── the commands Claude Code Plus also has ── */
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const title = (c) => (pkg.contributes.commands.find((x) => x.command === c) || {}).title;
  eq([title('codexPlus.renameThread'), title('codexPlus.moveThreadToSection'), title('codexPlus.markThreadUnread'), title('codexPlus.stopLoadingWorkPlanPlugin')],
    ['Codex Plus: Rename', 'Codex Plus: Add to Group', 'Codex Plus: Mark as Unread', 'Codex Plus: Stop Loading the Work Plan Plugin'],
    'the tab\'s menu items carry no "...", as Claude Code\'s do not, and Stop Loading is named as Claude Code Plus names it');

  /* ── the session information's names ── */
  const info2 = require('../../src/session-info');
  eq(info2.rows('019a6a10-0000-7000-8000-00000000ffff', { pid: '4242' }).map((r) => r.label), ['Thread', 'Process'],
    'the box names its rows in a word or two, as Claude Code Plus\'s Session and Process');
  /* ── the Agent map: the list's dots, the dialog's border while it has the focus ── */
  eq(/DOT_TONE = \{ working: '#22c55e', prompt: '#3b82f6',\s*unread: '#ef4444', failed: 'var\(--vscode-errorForeground,#f85149\)'/.test(source), true,
    'a sub-agent\'s dot has the session list\'s colours');
  eq(/\[data-codex-extras="map-dialog"\]:focus-within\{border-color:color-mix\(in srgb,var\(--vscode-inputOption-activeBorder,#2488db\) 65%,transparent\) !important;\}/.test(css()),
    true, 'the dialog\'s border turns to the active input border at 65% while it holds the focus, as Claude Code\'s');

  /* ── the context box and the rail's list ── */
  eq([/width:330px;/.test(source.slice(source.indexOf('function ctxShow'), source.indexOf('function ctxHideNow'))),
    /width:54px;/.test(source.slice(source.indexOf('function ctxRow'), source.indexOf('function ctxNote')))], [true, true],
  'the context box is 330 px wide with a 54 px column for the figures, as Claude Code Plus\'s');
  const panel = ruleOf(css(), '.codex-extras-panel');
  eq([panel.includes('line-height:1.4;'), /\.codex-extras-row-when/.test(css()),
    /setAttribute\('title'/.test(source.slice(source.indexOf('function addRule'), source.indexOf('function addRule') + 1200))], [true, false, false],
  'the list\'s rows are 1.4 high with the time in the same text as the words, and a compaction line has a drawn label rather than a native title');

};
