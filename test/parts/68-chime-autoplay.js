// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chimes against the browser's autoplay rule: an audio context made before anyone has clicked or typed in the
 * page starts suspended and plays nothing, and resume() may never settle when the browser refuses it. The stand-in
 * AudioContext below starts in a given state and resumes the way it is told to; the page is the one built in
 * 63-release-polish.js (the real layout sample's attributes, Codex 26.1021's message box).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const { createDom } = require('../fake-dom');

const settle = () => new Promise((r) => setImmediate(r));

function page(root, { state = 'suspended', resumes = 'resolve', chimeOn = true } = {}) {
  const dom = createDom();
  const turn = (n) => dom.el('div', { attrs: { 'data-turn-key': `t${n}` }, kids: [dom.el('div', { attrs: { 'data-local-conversation-user-anchor': '' },
    kids: [dom.el('div', { attrs: { 'data-user-message-bubble': '' }, texts: [`message ${n}`] })] })] });
  const scroller = dom.el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, kids: [turn(1), turn(2)] });
  const composer = dom.el('div', { attrs: { 'data-codex-composer-root': '' }, rect: { top: 600, left: 40, width: 700, height: 120 } });
  dom.setBody(dom.el('body', { kids: [dom.el('div', { kids: [scroller, composer] })] }));
  const tones = [], made = [], posted = [];
  class AudioContext {
    constructor() { this.currentTime = 0; this.destination = {}; this.state = state; this.resumed = 0; made.push(this); }
    resume() {
      this.resumed++;
      if (resumes === 'resolve') { this.state = 'running'; return Promise.resolve(); }
      return new Promise(() => {});
    }
    createOscillator() { return { frequency: { setValueAtTime: (f) => tones.push(f) }, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerHeight: 760, AudioContext };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const send = (m) => listeners.message({ data: m });
  const view = (chime) => send({ type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true, chime });
  view(chimeOn);
  const reports = () => posted.filter((m) => m && m.kind === 'chime').map((m) => [m.sound, m.state]);
  return { dom, tones, made, posted, reports, send, view, q: (sel) => dom.document.root.querySelectorAll(sel) };
}

module.exports = async ({ eq, root, tmp }) => {
  {
    const p = page(root, { state: 'suspended', resumes: 'resolve' });
    p.send({ type: 'codex-extras-chime', kind: 'done' });
    eq([p.tones.length, p.made.length && p.made[0].resumed], [0, 1], 'a suspended context is resumed before a chime, and nothing plays until it has');
    await settle();
    eq(p.tones, [880, 1174], 'and the chime plays once it is running');
    p.send({ type: 'codex-extras-chime', kind: 'question' });
    await settle();
    eq([p.made.length, p.tones.slice(2)], [1, [1174, 880]], 'the next chime uses the same context');
    eq(p.reports(), [['done', 'running']], 'the page tells the host about its first chime and not about the ones after it that played');
  }
  {
    const p = page(root, { state: 'suspended', resumes: 'never' });
    p.send({ type: 'codex-extras-chime', kind: 'approval' });
    await settle();
    p.dom.runTimers();
    await settle();
    eq([p.tones.length, p.reports()], [0, [['approval', 'suspended']]],
      'when the browser never lets the context resume, the chime is dropped after the wait rather than sounding later, and the host is told');
  }
  {
    const p = page(root, { state: 'suspended', resumes: 'resolve' });
    p.dom.document.dispatch('pointerdown', {});
    eq([p.made.length, p.made[0] && p.made[0].resumed], [1, 1], 'the first click in the page resumes a suspended context');
    p.dom.document.dispatch('keydown', {});
    eq(p.made[0] && p.made[0].resumed, 1, 'and a key after it, with the context running, does not resume it again');
  }
  {
    const p = page(root, { state: 'running', chimeOn: false });
    const chimes = () => p.q('[data-codex-extras="bar-button"]')[1];
    chimes().dispatch('click', { stopPropagation() {} });
    eq(p.posted.filter((m) => m && m.kind === 'toggleChime').length, 1, 'the Chimes button asks the host to switch the setting');
    p.view(true);
    await settle();
    eq(p.tones, [880, 1174], 'turning the chimes on from this page plays one as soon as the setting comes back on');
    chimes().dispatch('click', { stopPropagation() {} });
    p.view(false);
    p.view(true);
    await settle();
    eq(p.tones, [880, 1174], 'turning them off plays nothing, and neither does the setting coming on from somewhere other than this page\'s button');
  }

  /* ── the host's side: a line in the output panel, from a closed vocabulary ── */
  {
    const { vscode } = fake.create();
    fake.install(vscode);
    delete require.cache[require.resolve('../../src/patching')];
    const patching = require('../../src/patching');
    patching.installHooks();
    const lines = [];
    patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs-chime')), globalState: fake.memento() }, {
      vscode, log: (l) => lines.push(l), settings: () => ({ patchCodex: 'off', chime: true, figures: false }),
      source: { onDidChangeConversations: () => ({ dispose() {} }), _focus() {}, listConversations: async () => [], logo: null },
      context: { globalStorageUri: vscode.Uri.file(tmp('gs-chime2')) } });
    const webview = {};
    globalThis.__codexExtrasMessage(webview, { kind: 'chime', sound: 'done', state: 'running' });
    globalThis.__codexExtrasMessage(webview, { kind: 'chime', sound: 'approval', state: 'suspended' });
    globalThis.__codexExtrasMessage(webview, { kind: 'chime', sound: '<b>x</b>', state: 'whatever the page says' });
    eq(lines.filter((l) => /^chime /.test(l)), ['chime done: the audio context is running', 'chime approval: the audio context is suspended, so nothing was heard',
      'chime other: the audio context is in a state this extension does not know, so nothing may have been heard'],
    'each report becomes one line in the output panel, naming only words of its own vocabulary');
    patching._approvals.clear();
  }
};
