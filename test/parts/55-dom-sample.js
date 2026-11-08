// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The sample of the conversation layout: what the page script sends when the host asks for one, what it refuses to send,
 * the request and reply across the patch, where the file lands, and the command's answer when there is no patch.
 *
 * The page side is checked by running the real script - the same file the patch copies into Codex's webview folder - in a
 * stand-in page whose DOM is written here. That page is planted with everything the sample must not carry: a sentence of
 * conversation, a tooltip, a label, a link, an image source, an input value, an alt text, a data-* value and a thread id.
 * Each is then looked for in the whole reply, by hand, one at a time.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const THREAD = '01a1b8f2-fd2b-7e60-9ffc-16e5cb642e31';
/* Everything a real conversation would hold that the sample must leave behind. */
const SECRETS = {
  'message text': 'Please rebase onto the release branch before Friday',
  'title attribute': 'tooltip-of-the-copy-button',
  'aria-label': 'label-of-the-stop-button',
  href: 'https://example.invalid/a-link-the-reply-made',
  'img src': 'https://example.invalid/an-image-from-the-reply.png',
  'input value': 'what-the-reader-was-typing',
  'alt text': 'alt-text-of-the-image',
  'data-* value': 'assistant-turn-payload',
  'thread id': THREAD,
};

/** One element of the stand-in page. `class` and `id` go into `attributes` as a real DOM keeps them. */
function el(tag, opts = {}) {
  const attrs = { ...(opts.attrs || {}) };
  if (opts.class) attrs.class = opts.class;
  if (opts.id) attrs.id = opts.id;
  const e = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    className: opts.class || '',
    attributes: Object.keys(attrs).map((name) => ({ name, value: attrs[name] })),
    childNodes: [],
    parentElement: null,
    scrollTop: opts.scrollTop || 0,
    scrollHeight: opts.scrollHeight || 0,
    clientHeight: opts.clientHeight || 0,
    clientWidth: opts.clientWidth || 0,
    getAttribute(name) { const a = this.attributes.find((x) => x.name === name); return a ? a.value : null; },
    getBoundingClientRect: () => ({ width: opts.w || 0, height: opts.h || 0 }),
  };
  for (const t of opts.texts || []) e.childNodes.push({ nodeType: 3, nodeValue: t });
  for (const c of opts.kids || []) { c.parentElement = e; e.childNodes.push(c); }
  return e;
}

/* A conversation of seven look-alike messages in a scroller, a composer below it, and a narrower scroller beside. */
function conversationPage() {
  const message = (n) => el('div', { class: 'msg group', id: `msg-${THREAD}`, w: 760, h: 120,
    attrs: { 'data-message-id': THREAD, 'data-role': SECRETS['data-* value'] },
    kids: [
      el('span', { class: 'at', w: 60, h: 14, texts: [`1${n}:04 PM`] }),
      el('div', { class: 'body', w: 740, h: 100, texts: [SECRETS['message text']] }),
      el('img', { class: 'shot', w: 200, h: 100, attrs: { src: SECRETS['img src'], alt: SECRETS['alt text'] } }),
      el('a', { class: 'ref', w: 80, h: 14, attrs: { href: SECRETS.href }, texts: ['release branch'] }),
    ] });
  const composer = el('form', { class: 'composer', id: 'a'.repeat(60), w: 760, h: 80, kids: [
    el('textarea', { class: 'box', w: 700, h: 60, attrs: { value: SECRETS['input value'], placeholder: 'Ask Codex' } }),
    el('button', { class: 'stop', w: 24, h: 24, attrs: { title: SECRETS['title attribute'], 'aria-label': SECRETS['aria-label'] } }),
  ] });
  const scroller = el('div', { class: 'conversation-scroll', w: 900, h: 800, scrollTop: 4200, scrollHeight: 5000,
    clientHeight: 800, clientWidth: 900, kids: [...Array.from({ length: 7 }, (_, n) => message(n)), composer] });
  const aside = el('div', { class: 'thread-list-scroll', w: 200, h: 300, scrollHeight: 900, clientHeight: 300, clientWidth: 200,
    kids: [el('div', { class: 'row', w: 200, h: 30, texts: ['Older conversation'] })] });
  return el('body', { class: 'vscode-dark codex', kids: [el('div', { class: 'app', w: 1100, h: 800, kids: [scroller, aside] })] });
}

/* A chain deeper than the sample is allowed to go. */
function deepPage(levels) {
  let node = el('div', { class: 'leaf', w: 10, h: 10, texts: ['bottom'] });
  for (let i = levels; i > 0; i--) node = el('div', { class: `n${i}`, w: 10, h: 10, kids: [node] });
  return el('body', { kids: [el('div', { class: 'deep-scroll', w: 500, h: 400, scrollHeight: 900, clientHeight: 400, clientWidth: 500, kids: [node] })] });
}

/* More children than the sample is allowed to keep, each one its own group so none is folded into a count. */
function widePage(count) {
  const kids = Array.from({ length: count }, (_, i) => el('div', { class: `one-of-a-kind-${i}`, w: 10, h: 10 }));
  return el('body', { kids: [el('div', { class: 'wide-scroll', w: 500, h: 400, scrollHeight: 900, clientHeight: 400, clientWidth: 500, kids })] });
}

/** Run the real page script in a stand-in page, and return a way to ask it for samples. */
function pageUnder(root) {
  const posted = [];
  const listeners = {};
  const document = { body: null, createElement: () => ({ style: {}, setAttribute(k, v) { this[k] = v; }, textContent: '' }), addEventListener() {} };
  const win = {
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }),
    addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: `#/local/${THREAD}`, search: `?prefill=${SECRETS['input value']}` },
    Intl, setInterval: () => 1, clearInterval() {}, Date, Math, Object, String,
  };
  win.globalThis = win;
  const sandbox = vm.createContext({ globalThis: win, document, Intl, Date, Math, Object, String, setInterval: () => 1, clearInterval() {} });
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'page', 'codex-extras-page.js'), 'utf8'), sandbox);
  let n = 0;
  return (body) => {
    document.body = body;
    const id = `req-${++n}`;
    listeners.message({ data: { type: 'codex-extras-sample', id } });
    return posted.filter((m) => m.kind === 'sample' && m.id === id)[0];
  };
}

/** Every node of a sampled tree, the root included. */
function flatten(node, out = []) {
  out.push(node);
  for (const k of node.kids || []) flatten(k, out);
  return out;
}

module.exports = async ({ ok, bad, eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);

  /* ── the page side: the real script, a stand-in page, and the reply read apart ── */
  const ask = pageUnder(root);
  const reply = ask(conversationPage());
  if (!reply) { bad('the page script sent no reply to a sample request'); return; }
  eq([reply.type, reply.kind, reply.id, !!reply.sample, reply.error], ['codex-extras', 'sample', 'req-1', true, undefined],
    'a sample request is answered once, as a codex-extras message of kind sample');
  const s = reply.sample;
  const whole = JSON.stringify(reply);

  for (const [what, value] of Object.entries(SECRETS)) {
    if (whole.includes(value)) bad(`the sample carries ${what}`);
    else ok(`the sample carries no ${what}`);
  }
  eq(/prefill/.test(whole), false, 'the page\'s query string is left out, since Codex puts route state there');
  eq(s.page.route, '/index.html#/local/<id>', 'the route is kept with the thread id masked out');
  eq(s.page.body, ['vscode-dark', 'codex'], 'the body\'s class names come back, which say which theme was in use');
  eq(s.page.dataAttrs, ['data-message-id', 'data-role'], 'the data-* attribute NAMES in the page come back, and no value of one');

  eq([s.root.fromScroller, s.root.path, s.root.scroll],
    [true, ['div.app', 'div.conversation-scroll'], { top: 4200, height: 5000, client: 800 }],
    'the sample starts at the widest element that actually scrolls, and says how to get to it');
  eq(s.tree.kids.length, 4, 'under it, three samples of the seven look-alike messages and the one composer');
  eq([s.tree.kids[0].twins, s.tree.kids[3].twins, s.tree.children], [7, 1, 8],
    'the first of a look-alike group carries the whole group\'s size, and the parent still says how many children it has');
  eq([s.messageBlocks.count, s.messageBlocks.at, s.messageBlocks.depth], [7, 'div.msg.group', 1],
    'and the biggest group of look-alike siblings tall enough to hold a message is reported as the likely message list');

  const msg = s.tree.kids[0];
  eq([msg.tag, msg.classes, msg.attrs, msg.w, msg.h, msg.depth, msg.children],
    ['div', ['msg', 'group'], ['data-message-id', 'data-role', 'id'], 760, 120, 1, 4],
    'a message gives its tag, class names, attribute names, rounded size, depth and child count');
  eq(msg.id, 'msg-<id>', 'an id with a thread id in it keeps its shape and loses the id');
  eq(flatten(s.tree).find((x) => x.classes && x.classes[0] === 'composer').id, '<long>',
    'an id too long to be a generated one is replaced rather than carried');
  const at = msg.kids.find((k) => k.classes[0] === 'at');
  eq(at.text, [{ len: 8, head: 'ddoddoaa' }],
    'a text node gives its length and the shape of its first characters: this one reads as a time, not as a sentence');
  const body = msg.kids.find((k) => k.classes[0] === 'body');
  eq([body.text[0].len, body.text[0].head.length, body.text[0].head],
    [SECRETS['message text'].length, 8, 'aaaaaaoa'],
    'a sentence gives its true length and eight letters of shape, which is the whole of what is said about it');

  const deep = ask(deepPage(20)).sample;
  const depths = flatten(deep.tree).map((x) => x.depth);
  eq([Math.max(...depths), deep.limits.depth], [12, 12], 'a chain deeper than the limit is cut at it');
  const wide = ask(widePage(600)).sample;
  const count = flatten(wide.tree).length;
  eq([count, wide.sampled, wide.limits.nodes], [400, 400, 400], 'more elements than the limit are cut at it');
  eq(wide.tree.unsampled, { groups: 201, elements: 201 },
    'and what the budget ran out before reaching is counted, so the sample says how much it left out');

  /* ── where the file lands ── */
  const dom = require('../../src/dom-sample');
  const gs = tmp('global-storage');
  const dir = path.join(gs, 'made-by-the-command');
  const file = dom.save({ dir, date: new Date(2026, 10, 8, 14, 3, 9), codexVersion: '26.1021.22027', sample: s });
  eq([path.basename(file), file.startsWith(gs + path.sep)], ['conversation-layout-20261108-140309.json', true],
    'the file is named by the second it was taken in, under the directory it was given');
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  eq([back.format, back.codexVersion, typeof back.takenAt, back.sample.root.fromScroller, back.sample.tree.kids.length],
    [1, '26.1021.22027', 'string', true, 4], 'and it reads back as a fixture: format, when, which Codex, and the sample itself');

  /* ── the request and reply across the patch ── */
  delete require.cache[require.resolve('../../src/patching')];
  const patching = require('../../src/patching');
  eq(/Patch Codex/.test((await patching.sampleLayout()).error || ''), true,
    'with no patch in effect the page cannot be asked, and the answer says which command puts it in place');
  const sent = [];
  const provider = { postMessageToWebview: (w, m) => sent.push(m) };
  const panel = { webview: {}, active: false, reveal() {}, onDidDispose() {}, iconPath: null };
  patching.installHooks();
  globalThis.__codexExtrasPanel(panel, THREAD, provider);
  eq(/in front/.test((await patching.sampleLayout()).error || ''), true,
    'with the patch but no Codex tab in front, it says to bring one forward rather than sampling the wrong page');
  panel.active = true;
  const wanted = patching.sampleLayout();
  const request = sent[sent.length - 1];
  eq([request.type, typeof request.id], ['codex-extras-sample', 'string'], 'the request goes to the panel in front, with a nonce');
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'sample', id: request.id, sample: s }, provider);
  eq((await wanted).sample.messageBlocks.count, 7, 'and the page\'s answer to that nonce is what comes back');
  const stale = patching.sampleLayout({ timeoutMs: 60 });
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'sample', id: 'a-nonce-of-an-older-request', sample: s }, provider);
  eq(/did not answer/.test((await stale).error || ''), true, 'an answer carrying another request\'s nonce is dropped, and that request times out');
  const refused = patching.sampleLayout({ timeoutMs: 2000 });
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'sample', id: sent[sent.length - 1].id, error: 'the page has no body yet' }, provider);
  eq((await refused).error, 'Codex\'s page could not take a sample: the page has no body yet', 'a page that could not sample says so');

  /*
   * A window whose Codex page still carries an older page script than this extension's. A page runs the script it was
   * built with, so such a page answers nothing at all; the reason is read off the file instead of waited out.
   */
  const codexDir = tmp('codex-of-this-window');
  fs.mkdirSync(path.join(codexDir, 'webview'), { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'webview', 'index.html'), '<!-- CODEX-EXTRAS-PAGE v1-0123456789ab -->\n<html></html>\n');
  control.state.extensions.set('openai.chatgpt', { extensionPath: codexDir, packageJSON: { version: '26.1021.22027' } });
  patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
    vscode, log: () => {}, settings: () => ({ patchCodex: 'off', chime: false, figures: false }), planQuestions: () => 0,
    source: { onDidChangeConversations: () => ({ dispose() {} }), _focus() {}, listConversations: async () => [], logo: null },
    context: { globalStorageUri: vscode.Uri.file(tmp('gs')) } });
  eq(/an older version of this extension's page script/.test((await patching.sampleLayout()).error || ''), true,
    'a page left on an older page script is named as the reason, instead of the request being waited out');

  /* ── the command itself, in a window where Codex is not patched: it writes nothing and says why ── */
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  vscode.workspace.isTrusted = true;
  vscode.workspace.onDidGrantWorkspaceTrust = () => ({ dispose() {} });
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  control.state.config = { codexHome: home, installWorkPlanPlugin: 'never', reopenDroppedTabs: false, patchCodex: 'off' };
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  const storage = tmp('storage-of-the-command');
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento(),
    globalStorageUri: vscode.Uri.file(storage), extensionPath: root });
  const before = control.state.said.length;
  await control.state.handlers['codexExtras.sampleConversationDom']();
  const said = control.state.said.slice(before);
  const written = fs.readdirSync(storage).filter((f) => f.startsWith(dom.PREFIX));
  eq([said.length, /patch to Codex is not in effect/.test((said[0] || {}).message || ''), written],
    [1, true, []], 'the command writes no file without the patch, and says in one sentence what to do about it');
  for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
  ext.deactivate();
};
