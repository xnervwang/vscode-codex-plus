// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The things brought in line with Claude Code Extras before the first release: the tab's dot and title, the three
 * chimes, the strip in the corner, the layer everything of this script's sits on under Codex's overlays, the list kept
 * above the message box, and the outline on Codex's context meter. The conversation is built from the attributes the
 * real layout sample in test/fixtures/ has (scroller, turn, user anchor, bubble), and the message box as Codex
 * 26.1021's composer-controls bundle renders its root.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const { createDom } = require('../fake-dom');

function page(root, { meter = '', composerTop = 600 } = {}) {
  const dom = createDom();
  const turn = (n) => dom.el('div', { attrs: { 'data-turn-key': `t${n}` }, kids: [dom.el('div', { attrs: { 'data-local-conversation-user-anchor': '' },
    kids: [dom.el('div', { attrs: { 'data-user-message-bubble': '' }, texts: [`message ${n}`] })] })] });
  const scroller = dom.el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, kids: [turn(1), turn(2)] });
  const composer = dom.el('div', { attrs: { 'data-codex-composer-root': '' }, rect: { top: composerTop, left: 40, width: 700, height: 120 },
    kids: meter ? [dom.el('span', { attrs: { role: 'img', 'aria-label': meter } })] : [] });
  dom.setBody(dom.el('body', { kids: [dom.el('div', { kids: [scroller, composer] })] }));
  const tones = [];
  class AudioContext {
    constructor() { this.currentTime = 0; this.destination = {}; }
    createOscillator() { const o = { frequency: { setValueAtTime: (f, at) => tones.push({ f, at }) }, connect() {}, start() {}, stop() {} }; return o; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime: (v) => { if (v > 0.001) tones.peak = Math.max(tones.peak || 0, v); } }, connect() {} }; }
  }
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage() {} }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerHeight: 760, AudioContext };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const send = (m) => listeners.message({ data: m });
  send({ type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true });
  return { dom, tones, send, q: (sel) => dom.document.root.querySelectorAll(sel) };
}

module.exports = async ({ eq, tmp, root }) => {
  /* ── the dot on a tab's logo ── */
  const { withDot } = require('../../src/logo-dot');
  const logo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>';
  eq([/<circle cx="18.5" cy="5.5" r="5.5" fill="#3b82f6"\/>/.test(withDot(logo, '#3b82f6', { r: 5.5, gap: 1 })),
    /r="6.5" fill="black"/.test(withDot(logo, '#3b82f6', { r: 5.5, gap: 1 })), /r="4.2" fill="#3b82f6"/.test(withDot(logo, '#3b82f6'))],
  [true, true, true], 'a tab\'s dot is Claude Code Extras\' size, radius 5.5 at (18.5, 5.5) in a gap of 1, while a Conversations icon keeps its own');

  /* ── the tab's title ── */
  {
    const { vscode } = fake.create();
    fake.install(vscode);
    delete require.cache[require.resolve('../../src/patching')];
    const patching = require('../../src/patching');
    patching.installHooks();
    const THREAD = '019a6a10-0000-7000-8000-0000000000c1';
    let conversations = [{ sessionId: THREAD, title: 'Fix the flaky retry test', state: 'idle', working: false }];
    patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
      vscode, log: () => {}, settings: () => ({ patchCodex: 'off', chime: false, figures: false }),
      source: { onDidChangeConversations: () => ({ dispose() {} }), _focus() {}, listConversations: async () => conversations, logo: null },
      context: { globalStorageUri: vscode.Uri.file(tmp('gs2')) } });
    const panel = { webview: {}, title: 'Codex', reveal() {}, onDidDispose() {}, iconPath: null };
    globalThis.__codexExtrasPanel(panel, THREAD, { postMessageToWebview() {}, sendMessageToPanel() {} });
    await patching.refreshPanels();
    eq(panel.title, 'Fix the flaky retry test', 'a Codex tab is titled by its conversation rather than staying "Codex"');
    conversations = [{ ...conversations[0], title: 'x'.repeat(250) }];
    await patching.refreshPanels();
    eq(panel.title.length, 200, 'and follows a rename, up to 200 characters as Claude Code Extras allows');
    conversations = [{ ...conversations[0], title: '(untitled)' }];
    await patching.refreshPanels();
    eq(panel.title.length, 200, 'a conversation with no title yet leaves the tab\'s title as it was');
    patching._approvals.clear();
  }

  /* ── the page ── */
  const p = page(root, { meter: 'Context usage: 82%' });
  const at = (kind) => { p.tones.length = 0; p.tones.peak = 0; p.send({ type: 'codex-extras-chime', kind }); return p.tones.map((t) => t.f); };
  eq([at('done'), at('approval'), at('question'), p.tones.peak], [[880, 1174], [880, 880, 880], [1174, 880], 0.05],
    'the three chimes are Claude Code Extras\' own: rising when a turn ends, three equal notes for a permission, falling for a question, at its volume');

  p.send({ type: 'codex-extras-figures', text: '', tool: 'exec_command', toolSince: Date.now() - 65000 });
  const strip = p.q('[data-codex-extras="figures"]')[0];
  // A start 65 s back lands on the previous day for the first 65 s after midnight, and the stamp then leads with the date.
  eq([!!strip && /^exec_command running for 1m(\d+s)? \(since (?:(?:\d{4}\/)?\d\d\/\d\d )?\d\d:\d\d:\d\d\)$/.test(strip.textContent), strip && /z-index:25;/.test(strip.style.cssText)],
    [true, true], 'the corner strip says which tool call is running, for how long and since when, and sits under Codex\'s overlays');

  const css = (p.q('[data-codex-extras="style"]')[0] || {}).textContent || '';
  eq([/\.codex-extras-rail\{[^}]*z-index:25;/.test(css), /\.codex-extras-panel\{[^}]*z-index:26;/.test(css)], [true, true],
    'the rail and its list sit at 25 and 26, above Codex\'s content and below its lowest overlay layer, z-30');
  p.q('[data-codex-extras="nav-button"]')[2].dispatch('click', { stopPropagation() {} });
  const list = p.q('[data-codex-extras="nav-list"]')[0];
  eq([list && list.style.display, list && list.style.maxHeight], ['block', '584px'],
    'the list, once opened, stops above the message box, measured at that moment');

  eq([/\.codex-extras-ctx-low\{outline:1px solid [^}]*border-radius:4px;/.test(css), p.q('.codex-extras-ctx-low').length], [true, 1],
    'at 82% used the meter is outlined, 1px with rounded corners as Claude Code Extras draws it');
  const below = page(root, { meter: 'Context usage: 79%' });
  eq(below.q('.codex-extras-ctx-low').length, 0, 'and at 79% it is not: the threshold is 15 points before Codex compacts, at about 94.7% on that meter');
};
