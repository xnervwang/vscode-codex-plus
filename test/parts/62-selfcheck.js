// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The page's self-check: what it counts, what it refuses to carry, and the two places it comes out.
 *
 * The page it is run against is rebuilt out of the real sample in test/fixtures/, element by element, rather than
 * written here. That is the point of the check: the counts then come from the shape a live Codex 26.1021 actually had,
 * so a release that moves one of the anchors turns this red, and no second hand-written copy of Codex's shape has to be
 * kept in step with the first (test/parts/60-page-features.js has that one).
 *
 * A sample carries no attribute values and no text - only each text's length and the class of its first characters - so
 * the rebuild plants a string of its own in every text node, of the length and shape the sample recorded. Two things
 * follow. Every piece of text in the page is then a string this file knows, so "the reply carries no text from the
 * conversation" can be checked against all of it at once instead of against a few planted samples. And the texts the
 * sample recorded as clock-shaped are rebuilt as real clocks, which is what makes the times countable: that shape, eight
 * characters as dd?dd?aa, is a clock and can be nothing else.
 *
 * What the rebuild cannot show is said here rather than left to be inferred:
 *
 *   - It is rooted at the scroller, because the sample is. The element the approval watcher wants sits above that, so
 *     the rebuild puts one there - the live page had it, which is why its name is in the sample's own list of data-*
 *     attribute names even though it is not in the sampled tree.
 *   - A sent time's attribute value is not in the sample, so the rebuilt one is empty and the reply's time comes from
 *     the clock Codex had already rendered inside that element. That is the fallback path, not the first one; the first
 *     is checked with a value of its own in 60-page-features.
 *   - The sample keeps three of any group of look-alike siblings and a count of the rest, so the rebuilt conversation
 *     has as many turns as the sample kept, not as many as the conversation had.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const fixture = require('../fixture');
const { createDom } = require('../fake-dom');

const FIXTURE = 'conversation-layout-26.1021.22027.json';
const THREAD = '01a1b8f2-fd2b-7e60-9ffc-16e5cb642e31';
/* The element the approval watcher observes. Not in the sampled tree, since the sample starts at the scroller and this
   is above it; its name is in the sample's list of data-* names, which is the evidence that the live page had one. */
const ACTIVITY = 'data-request-input-activity-root';
const CARD = 'data-codex-approval-surface';

/* A text shaped like a clock Codex rendered: eight characters, two digits, a separator, two digits, a separator and two
   letters. Rebuilt as a real clock, since that shape admits nothing else. */
const CLOCK_SHAPE = { len: 8, head: 'ddoddoaa' };
const CH = { a: 'abcdefghijklmnopqrstuvwxyz', d: '0123456789', o: '-_.:;!?,' };

/**
 * One string of the length and first-character shape the sample recorded, unique across the page so it can be looked
 * for in the reply. Clock-shaped ones come back as clocks, each a different minute.
 */
function plantText(shape, seen) {
  if (shape.len === CLOCK_SHAPE.len && shape.head === CLOCK_SHAPE.head) {
    for (let i = 0; i < 60; i++) {
      const text = `0${1 + (i % 9)}:${String(10 + i).padStart(2, '0')} PM`;
      if (!seen.has(text)) { seen.add(text); return { text, clock: true }; }
    }
  }
  for (let seed = 0; seed < 4000; seed++) {
    let text = '';
    for (let i = 0; i < shape.len; i++) {
      const kind = i < shape.head.length ? shape.head[i] : 'a';
      const alphabet = CH[kind] || CH.o;
      text += alphabet[(seed * 7 + i * 3 + shape.len) % alphabet.length];
    }
    if (!seen.has(text)) { seen.add(text); return { text, clock: false }; }
  }
  throw new Error('plantText ran out of distinct strings');
}

/** The sampled tree as elements of the stand-in page, with a planted string in every text node. */
function rebuild(dom, node, planted, top) {
  const attrs = {};
  for (const name of node.attrs || []) attrs[name] = name === 'id' ? String(node.id || '') : '';
  const texts = [];
  for (const shape of node.text || []) {
    const made = plantText(shape, planted.seen);
    planted.all.push(made);
    texts.push(made.text);
  }
  const el = dom.el(node.tag || 'div', {
    class: (node.classes || []).join(' '),
    attrs,
    texts,
    rect: { top: top.at += 7, width: node.w || 0, height: node.h || 0 },
  });
  for (const kid of node.kids || []) el.appendChild(rebuild(dom, kid, planted, top));
  return el;
}

/**
 * The stand-in page: the sampled scroller, inside the activity root the live page had, inside a body. `planted.all`
 * ends up holding every string the page contains.
 */
function pageFromSample(dom, sample, { card = false } = {}) {
  const planted = { all: [], seen: new Set() };
  const scroller = rebuild(dom, sample.tree, planted, { at: 0 });
  const scroll = sample.root.scroll || {};
  scroller.scrollTop = scroll.top || 0;
  scroller.scrollHeight = scroll.height || 0;
  scroller.clientHeight = scroll.client || 0;
  scroller.clientWidth = 1370;
  const inside = [scroller];
  if (card) inside.push(dom.el('div', { attrs: { [CARD]: '' }, texts: ['Allow Codex to run this command?'] }));
  const activity = dom.el('div', { attrs: { [ACTIVITY]: '' }, kids: inside });
  const body = dom.el('body', { class: 'vscode-dark', kids: [dom.el('div', { kids: [activity] })] });
  dom.setBody(body);
  return planted;
}

/** The real page script in a stand-in page, and the ways the host speaks to it. */
function pageUnder(root, dom) {
  const posted = [];
  const listeners = {};
  const win = {
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }),
    addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' },
  };
  const ctx = vm.createContext(Object.assign({ globalThis: win }, dom.sandbox));
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'page', 'codex-extras-page.js'), 'utf8'), ctx);
  let n = 0;
  return {
    posted,
    send(message) { listeners.message({ data: message }); },
    view(over = {}) {
      this.send(Object.assign({ type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true }, over));
    },
    times(list) { this.send({ type: 'codex-extras-user-times', times: list }); },
    figures(over = {}) { this.send(Object.assign({ type: 'codex-extras-figures', text: '' }, over)); },
    /** One self-check, as the host asks for it, and the reply to that request alone. */
    ask() {
      const id = `check-${++n}`;
      this.send({ type: 'codex-extras-selfcheck', id });
      return posted.filter((m) => m.kind === 'selfcheck' && m.id === id)[0];
    },
  };
}

module.exports = async ({ ok, bad, eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', FIXTURE), 'utf8')).sample;

  /* ── the page, rebuilt out of the real sample ── */
  const dom = createDom();
  const planted = pageFromSample(dom, sample);
  const page = pageUnder(root, dom);
  const first = page.ask();
  if (!first) { bad('the page script sent no reply to a self-check request'); return; }
  eq([first.type, first.kind, first.id, !!first.report, first.error],
    ['codex-extras', 'selfcheck', 'check-1', true, undefined],
    'a self-check request is answered once, as a codex-extras message of kind selfcheck');

  const r = first.report;
  eq(r.script.version, pkg.version,
    'the page script reports its own version, and it is the version of the package the patch copies it from');
  eq([r.script.running, typeof r.format], [true, 'number'], 'with a running flag and the shape of the report it sent');

  /*
   * The counts, against the real sample. Each is named rather than asserted as a bare number: what is being checked is
   * that the anchor was found at all, and the number is how many the sample kept.
   */
  eq(r.codex.scroller.found, true, 'the self-check found the conversation scroller in the Codex 26.1021 shape');
  eq(r.codex.scroller.selector, '[data-app-action-timeline-scroll]',
    'and it reports the selector it looked for it by, which is a constant of the script and not read off the page');
  for (const [what, got] of Object.entries({
    turns: r.codex.turns,
    'messages of the user\'s': r.codex.userAnchors,
    'reply blocks': r.codex.assistantBlocks,
    'sent-time elements': r.codex.sentTimeElements,
    bubbles: r.codex.bubbles,
  })) {
    if (got > 0) ok(`${got} ${what} were recognised in that shape, so their anchors are still where the script looks`);
    else bad(`no ${what} were recognised in the real Codex sample: that anchor has moved`);
  }
  eq([r.codex.entries.user > 0, r.codex.entries.assistant > 0], [true, true],
    'and the conversation reads as both sides, which is what every part below works from');

  /* The times. The user side is the one the coverage report calls out as never seen in a live interface: the clock
     Codex renders in the hover row beside a message, which carries no attribute of its own. */
  eq([r.times.user > 0, r.times.userSource], [true, 'clock'],
    'a time is drawn on the user\'s own messages, and it came from the clock Codex itself had rendered');
  eq([r.times.userFromClock, r.times.userFromRollout, r.times.userUnstamped],
    [r.codex.userAnchors, 0, 0], 'one per message of theirs, none of them from the rollout, none left unstamped');
  if (r.times.assistant > 0) ok(`${r.times.assistant} replies carry a time, read from what Codex had rendered in the sent-time element`);
  else bad('no reply carries a time, so neither the sent-time anchor nor the clock inside it was read');
  eq([r.times.hostTimes, r.times.hostTimesLinedUp, r.times.unreadableForms], [0, false, 0],
    'the host has sent no times yet, so none lined up, and no form of a sent time was unreadable');

  /* The rest of what the page draws. */
  eq([r.navigation.rows > 0, r.navigation.railButtons, r.navigation.listOpen], [true, 5, false],
    'the list has a row per message of theirs, the rail its five controls, and it starts shut');
  eq(r.navigation.scrolls, { selector: '[data-app-action-timeline-scroll]', found: true },
    'and the list reports which scroll container its buttons move, as a selector rather than as its content');
  eq([r.colour.edged, r.colour.inked, r.colour.colourAccepted, r.colour.styleSheet],
    [r.codex.userAnchors, 0, false, true],
    'every message of theirs is given a bar, none a colour while none is set, and the stylesheet is in the page');
  eq([r.figures.present, r.figures.hasText], [false, false], 'the figures strip is not drawn before the host sends any');
  eq(r.marks.total > 0, true, 'and the script says how much of its own is in the page');

  /*
   * ── nothing the conversation says is in the reply ──
   *
   * Read the other way round from the sample's check: rather than looking for each planted string, every string the
   * reply contains at all is listed and held against what the script is allowed to say. That settles the question for
   * text of any length, where looking for the planted strings cannot - a two-character one occurs inside this file's
   * own words by chance, and no two-character text can be told from a coincidence. The planted strings are still looked
   * for as well, from the length at which a hit means something, since that catches one buried inside a longer value.
   */
  const whole = JSON.stringify(first);
  const strings = (value, out = []) => {
    if (typeof value === 'string') out.push(value);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
    return out;
  };
  /* Everything the reply may hold: the message's own envelope, the version, the words for a time's source, and the
     selectors - which are constants of the script, already in its source, and the reason the reply is useful at all. */
  const ALLOWED = new Set(['codex-extras', 'selfcheck', 'check-1', pkg.version, 'clock', 'rollout', 'both', 'none',
    '[data-app-action-timeline-scroll]', '[data-request-input-activity-root]', 'body',
    '[data-codex-approval-surface]:not([data-app-shell-active-page="false"] *)']);
  eq([...new Set(strings(first))].filter((s) => !ALLOWED.has(s)), [],
    'every string in the whole reply is one the script is allowed to say: its own selectors and nothing read off the page');
  const SHORTEST = 5;
  const searchable = planted.all.filter((p) => p.text.length >= SHORTEST);
  eq([searchable.length > 15, searchable.filter((p) => whole.includes(p.text)).map((p) => p.text)], [true, []],
    `and none of the ${searchable.length} planted strings long enough for a hit to mean anything is in it`);
  /* The stamps the script wrote are a time rendered in the user's own zone, a different string from the clock it read,
     so a check of the planted strings alone would miss them. */
  const stamps = dom.document.root.querySelectorAll('[data-codex-extras="stamp"]').map((s) => s.textContent).filter(Boolean);
  eq([stamps.length > 0, stamps.filter((t) => whole.includes(t))], [true, []],
    'nor is any of the times it rendered itself, which it made rather than found');
  eq(/\d{1,2}:\d{2}/.test(whole), false, 'the reply holds nothing shaped like a time at all');
  eq(whole.includes(THREAD) || whole.includes('xnerv'), false, 'and no thread id and no name out of a path');

  /* ── the approval card, which the sample cannot hold: it is only in the page while Codex is asking ── */
  eq([r.approval.onScreen, r.approval.watching.activityRootFound, r.approval.watching.observing,
    r.approval.watching.selector],
  [false, true, true, '[data-request-input-activity-root]'],
    'with no card up the watcher is still observing, and on the activity root rather than on the body');
  eq(r.approval.cardSelector.includes(CARD), true, 'and it reports the selector it recognises a card by');

  const withCard = createDom();
  pageFromSample(withCard, sample, { card: true });
  const carded = pageUnder(root, withCard);
  const up = carded.ask().report;
  eq([up.approval.onScreen, up.approval.told], [true, true],
    'a card in the page is seen, and the host had already been told the same thing');

  /*
   * A hidden page. The two watchers are meant to part company here: the marks' observer goes, since nothing is being
   * looked at, and the card's stays, since a tab in the background is the case it exists for. One self-check taken on a
   * hidden page is what tells those two apart.
   */
  page.view();
  dom.document.hidden = true;
  dom.document.dispatch('visibilitychange', {});
  const hidden = page.ask().report;
  eq([hidden.page.hidden, hidden.page.marksObserving, hidden.approval.watching.observing],
    [true, false, true], 'on a hidden page the marks watcher has gone and the approval watcher has not');
  dom.document.hidden = false;
  dom.document.dispatch('visibilitychange', {});
  eq(page.ask().report.page.marksObserving, true, 'and it is observing again once the page is back');

  /* ── the settings the host sent, and the times from the rollout ── */
  page.view({ navigation: false, userColor: '#90EE90' });
  const after = page.ask().report;
  eq([after.settings.navigation, after.settings.userColor, after.colour.inked > 0, after.colour.colourAccepted,
    after.navigation.rows],
  [false, true, true, true, 0], 'the settings it has are reported, and the list goes while the colouring arrives');
  eq(typeof after.settings.userColor, 'boolean',
    'the colour is reported as whether one is set and never as the value, which the user typed');
  page.view();
  const times = Array.from({ length: after.codex.userAnchors }, (_, i) => Date.now() - i * 60000);
  page.times(times);
  const lined = page.ask().report;
  eq([lined.times.hostTimes, lined.times.hostTimesLinedUp], [times.length, true],
    'as many times from the rollout as the page shows messages of theirs line up with it');
  page.times([1]);
  const short = page.ask().report;
  eq([short.times.hostTimes, short.times.hostTimesLinedUp, short.times.userSource],
    [1, false, 'clock'], 'fewer than the page shows do not line up and go unused, and Codex\'s own clock still stands');

  /* Everything off: the self-check is how "nothing of its own is left in the page" is read back. */
  page.view({ timestamps: false, navigation: false, userColor: '', userEdge: false });
  const off = page.ask().report;
  eq([off.marks.total, off.times.user, off.times.assistant, off.navigation.rows, off.colour.inked, off.colour.edged],
    [0, 0, 0, 0, 0, 0], 'with every setting off it reports nothing of its own anywhere in the page');
  eq(off.codex.turns > 0, true, 'while Codex\'s own turns are of course still there, untouched');

  /* ── the figures strip ── */
  page.view();
  page.figures({ text: 'ctx 12%', tool: 'exec_command', toolSince: Date.now() - 5000 });
  const strip = page.ask().report.figures;
  eq([strip.present, strip.showing, strip.hasText, strip.toolRunning], [true, true, true, true],
    'the strip reports itself present and showing once the host sends figures for the conversation');
  eq(JSON.stringify(page.posted).includes('ctx 12%'), false, 'and its text, which is the host\'s own, is not sent back');

  /* ── the page that cannot answer at all: the script loaded before Codex had built anything ── */
  const empty = createDom();
  const bodyless = pageUnder(root, empty);
  const none = bodyless.ask();
  eq([none && none.error, none && none.report], ['the page has no body yet', undefined],
    'a page with nothing in it yet says so instead of answering with zeroes that read as a Codex that changed');

  /* ── the lines a person reads, which are the same in both places they come out ── */
  delete require.cache[require.resolve('../../src/patching')];
  const patching = require('../../src/patching');
  const lines = patching.selfCheckLines(first);
  const text = lines.join('\n');
  eq([lines.length > 10, /^Page self-check: page script /.test(lines[0])], [true, true],
    'the report comes out as lines, the first naming the version of the script that answered');
  eq([text.includes('[data-app-action-timeline-scroll]'), text.includes('[data-request-input-activity-root]')],
    [true, true], 'the selectors are in them, so a reader can see which element each part was looking for');
  /* A count and its noun are written together, and a noun that does not take a plural -s has to be given its own.
     Checked because the lines are meant to be pasted into a report by the person who ran them. */
  eq(text.match(/\b(?:replys|bars|coloureds|day dividerss)\b/g), null,
    'each count reads as English, rather than as a noun with an -s put on the end of it');
  eq([/\bthe host has sent no times for this conversation\b/.test(text), /lined up/.test(text)], [true, false],
    'and with no times sent at all it says that, rather than reporting them as not lining up');
  eq(searchable.filter((p) => text.includes(p.text)).map((p) => p.text), [],
    'and the lines carry none of the page\'s own text either, which they could only get from the reply');
  eq(patching.selfCheckLines({ error: 'the patch to Codex is not in effect' }),
    ['Page self-check: the patch to Codex is not in effect'],
    'an answer that did not arrive is one line saying why, since a window with no patch is a state and not a fault');
  eq(patching.selfCheckLines(undefined), ['Page self-check: the page sent no answer'],
    'and no answer at all is one line too, rather than a throw inside Show Status');
  /* A report from a page script older than these lines: every count it does not carry reads as none rather than
     throwing, which is what keeps Show Status working while a window waits for its reload. */
  const sparse = patching.selfCheckLines({ report: { script: {}, format: 1 } });
  eq([sparse.length === lines.length, /unknown version/.test(sparse[0])], [true, true],
    'a report missing everything but its shape still comes out as the same lines, each reading as none');

  /* ── the request and the reply across the patch ── */
  const { vscode, control } = fake.create();
  fake.install(vscode);
  eq(/Patch Codex/.test((await patching.selfCheckPage()).error || ''), true,
    'with no patch in effect the page cannot be asked, and the answer names the command that puts it in place');
  const sent = [];
  const provider = { postMessageToWebview: (w, m) => sent.push(m) };
  const panel = { webview: {}, active: false, reveal() {}, onDidDispose() {}, iconPath: null };
  patching.installHooks();
  globalThis.__codexExtrasPanel(panel, THREAD, provider);
  eq(/in front/.test((await patching.selfCheckPage()).error || ''), true,
    'with the patch but no Codex tab in front it says to bring one forward, rather than checking the wrong page');
  panel.active = true;
  const wanted = patching.selfCheckPage();
  const request = sent[sent.length - 1];
  eq([request.type, typeof request.id], ['codex-extras-selfcheck', 'string'], 'the request goes to the panel in front, with a nonce');
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'selfcheck', id: request.id, report: r }, provider);
  eq((await wanted).report.codex.turns, r.codex.turns, 'and the page\'s answer to that nonce is what comes back');
  const stale = patching.selfCheckPage({ timeoutMs: 60 });
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'selfcheck', id: 'the-nonce-of-an-older-request', report: r }, provider);
  eq(/did not answer/.test((await stale).error || ''), true,
    'an answer carrying another request\'s nonce is dropped, and that request times out');
  const refused = patching.selfCheckPage({ timeoutMs: 2000 });
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'selfcheck', id: sent[sent.length - 1].id, error: 'the page has no body yet' }, provider);
  eq((await refused).error, 'Codex\'s page could not finish its self-check: the page has no body yet',
    'and a page that could not run one says so in the same sentence as the reason');
  /*
   * The two questions are asked over one channel, so an answer to one must never settle the other. Both are left
   * outstanding at once and answered in the wrong order.
   */
  const bothSample = patching.sampleLayout({ timeoutMs: 2000 });
  const bothCheck = patching.selfCheckPage({ timeoutMs: 2000 });
  const checkId = sent[sent.length - 1].id, sampleId = sent[sent.length - 2].id;
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'selfcheck', id: checkId, report: r }, provider);
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'sample', id: sampleId, sample }, provider);
  eq([(await bothCheck).report.codex.turns, (await bothSample).sample.root.fromScroller], [r.codex.turns, true],
    'a self-check and a sample outstanding together are each settled by their own answer, in whichever order those come');

  /*
   * A window whose Codex page carries an older copy of the page script. Such a page has no self-check in it at all, so
   * the reason comes from reading the file rather than from waiting out a reply that cannot arrive.
   */
  const codexDir = tmp('codex-of-this-window');
  fs.mkdirSync(path.join(codexDir, 'webview'), { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'webview', 'index.html'), '<!-- CODEX-EXTRAS-PAGE v1-0123456789ab -->\n<html></html>\n');
  control.state.extensions.set('openai.chatgpt', { extensionPath: codexDir, packageJSON: { version: '26.1021.22027' } });
  patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
    vscode, log: () => {}, settings: () => ({ patchCodex: 'off', chime: false, figures: false }), planQuestions: () => 0,
    source: { onDidChangeConversations: () => ({ dispose() {} }), _focus() {}, listConversations: async () => [], logo: null },
    context: { globalStorageUri: vscode.Uri.file(tmp('gs')) } });
  const old = await patching.selfCheckPage();
  eq(/an older version of this extension's page script/.test(old.error || ''), true,
    'a page left on an older page script is named as the reason, instead of the request being waited out');
  eq(patching.selfCheckLines(old).length, 1, 'and that comes out as the one line, not as a report of zeroes');

  /* ── the two places it comes out, in a window where Codex is not patched ── */
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  vscode.workspace.isTrusted = true;
  vscode.workspace.onDidGrantWorkspaceTrust = () => ({ dispose() {} });
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  control.state.config = { codexHome: home, installWorkPlanPlugin: 'never', reopenDroppedTabs: false, patchCodex: 'off' };
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento(),
    globalStorageUri: vscode.Uri.file(tmp('storage')), extensionPath: root });

  control.state.log.length = 0;
  await control.state.handlers['codexExtras.status']();
  eq(/Page self-check: the patch to Codex is not in effect/.test(control.state.log.join('\n')), true,
    'Show Status ends with the self-check, and in a window with no patch that is the one line rather than an error');

  control.state.log.length = 0;
  const before = control.state.said.length;
  await control.state.handlers['codexExtras.pageSelfCheck']();
  const said = control.state.said.slice(before);
  eq([/Page self-check:/.test(control.state.log.join('\n')), said.length, (said[0] || {}).buttons],
    [true, 1, ['Copy']], 'and the command of its own writes the same lines to the output panel and offers to copy them');
  /* The lines go to the clipboard whole, which is the point of the command: one paste carries the answer back. */
  control.answer('Codex Extras:', 'Copy');
  await control.state.handlers['codexExtras.pageSelfCheck']();
  eq(/^Page self-check:/.test(control.state.clipboard), true, 'and copies them when the user asks for that');
  for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
  ext.deactivate();
};
