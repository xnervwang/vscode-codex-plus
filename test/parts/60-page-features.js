// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The three additions that write into Codex's own tree: the time on each message and reply block, the list of the
 * user's own messages down the right edge, and the colouring of those messages.
 *
 * The checks fall into three groups:
 *
 *   the attributes    Every data-* attribute the page script selects by, checked against a real sample of a Codex
 *                     conversation (test/fixtures/). A Codex release that drops one turns this red, which is the whole
 *                     point of keeping the sample: none of these elements can be found by class name, because Codex's
 *                     class names are a build's output.
 *   the page          The real file src/page/codex-extras-page.js, run in a stand-in page (test/fake-dom.js) built in
 *                     the shape the sample shows. What it does to that page is then read back: which element each stamp
 *                     hangs on, what it says, how many rows the list has and in what order, that the colouring is class
 *                     names and never an inline style on anything of Codex's, and that everything goes again when the
 *                     settings go off.
 *   the host          Reading those times out of a rollout (src/user-times.js), the settings message, and that a panel
 *                     is sent both.
 *
 * The page also holds four things the script must not send: a message of the user's, a reply, a tooltip and a thread
 * id. Each is searched for in everything the script posted.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const { createDom } = require('../fake-dom');

const FIXTURE = 'conversation-layout-26.1021.22027.json';

/* The attributes the three features select Codex's own elements by. */
const REQUIRED = [
  'data-turn-key',
  'data-content-search-turn-key',
  'data-local-conversation-user-anchor',
  'data-local-conversation-final-assistant',
  'data-response-annotation-target',
  'data-conversation-role',
  'data-assistant-message-sent-time',
  'data-app-action-timeline-scroll',
  /* Not in the first list of eight, and used all the same: the bubble is what the bar down the edge goes on, and what
     the opening words are read from. */
  'data-user-message-bubble',
];

const SECRETS = {
  'a message of the user\'s': 'rebase onto the release branch before Friday',
  'a reply': 'The branch is already rebased, so nothing was left to do',
  'a tooltip': 'tooltip-of-the-copy-button',
  'a thread id': '01a1b8f2-fd2b-7e60-9ffc-16e5cb642e31',
};

/** Every data-* attribute name a sample saw, from its capped list and from the tree it kept. */
function attrNames(sample) {
  const out = new Set((sample.page && sample.page.dataAttrs) || []);
  const walk = (n) => {
    for (const a of n.attrs || []) if (String(a).startsWith('data-')) out.add(a);
    for (const k of n.kids || []) walk(k);
  };
  if (sample.tree) walk(sample.tree);
  return out;
}

/** The real page script in a stand-in page, and the way to speak to it as the host does. */
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
  return {
    posted,
    send(message) { listeners.message({ data: message }); },
    view(over = {}) {
      this.send(Object.assign({ type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true }, over));
    },
    times(list) { this.send({ type: 'codex-extras-user-times', times: list }); },
  };
}

/*
 * One turn in the shape the sample shows: a date divider on the first turn of a day, the user's own message inside
 * [data-local-conversation-user-anchor] with its words in a bubble and Codex's own time in the row of buttons beside
 * it, and the reply inside [data-response-annotation-target] under [data-local-conversation-final-assistant].
 */
function turn(dom, opts) {
  const { el, text } = dom;
  const head = opts.day
    ? [el('div', { attrs: { 'data-markdown-copy': '', role: 'presentation' },
      kids: [el('time', { attrs: { datetime: opts.day }, texts: ['Today'] })] })]
    : [];
  const bubble = el('div', { attrs: { 'data-user-message-bubble': '' }, rect: { top: opts.top || 0, height: 40 },
    kids: [el('p', { kids: [el('span', { texts: [opts.ask] })] })] });
  /* Codex's own time on the user's message: a bare span in the hover row, with no attribute of its own. */
  const beside = el('div', { kids: [el('div', { kids: [
    el('span', { kids: opts.askedAt ? [el('span', { texts: [opts.askedAt] })] : [] }),
    el('button', { attrs: { title: SECRETS['a tooltip'], type: 'button' } }),
  ] })] });
  const user = el('div', { attrs: { 'data-local-conversation-user-anchor': '', 'data-content-search-unit-key': '' },
    rect: { top: opts.top || 0, height: 67 },
    kids: [el('div', { kids: [
      el('h4', { class: 'sr-only', texts: ['You said'] }),
      el('div', { kids: [bubble, beside] }),
    ] })] });
  const reply = el('div', { attrs: { 'data-response-annotation-target': '', 'data-response-annotation-conversation': '' },
    rect: { top: (opts.top || 0) + 80, height: 120 },
    kids: [
      el('h4', { class: 'sr-only', attrs: { 'data-conversation-role': opts.role || 'assistant' }, texts: ['Codex replied'] }),
      el('div', { kids: [el('p', { kids: [el('span', { texts: [opts.reply] })] })] }),
      el('div', { class: 'turn-action-controls', kids: [
        el('span', { attrs: { 'data-assistant-message-sent-time': opts.sent === undefined ? '' : opts.sent },
          kids: [el('span', { texts: [opts.sentShown || ''] })] }),
      ] }),
    ] });
  const assistant = el('div', { attrs: { 'data-local-conversation-final-assistant': '' }, kids: [el('div', { kids: [reply] })] });
  const body = el('div', { attrs: { 'data-content-search-turn-key': '' },
    kids: [el('div', { kids: [el('div', { kids: [user] }), assistant] })] });
  const node = el('div', { attrs: { 'data-turn-key': opts.key }, kids: [...head, body] });
  void text;
  return { node, user, reply, bubble };
}

function conversation(dom, turns) {
  const built = turns.map((t) => turn(dom, t));
  const scroller = dom.el('div', { class: 'thread-scroll-container',
    attrs: { 'data-app-action-timeline-scroll': '', role: 'region', tabindex: '0' },
    rect: { top: 0, height: 755 }, scrollHeight: 915, clientHeight: 755, clientWidth: 1370,
    kids: built.map((b) => b.node) });
  const body = dom.el('body', { class: 'vscode-dark', kids: [dom.el('div', { kids: [scroller] })] });
  dom.setBody(body);
  return { built, scroller, body };
}

const stampOf = (el) => (el.children.find((k) => k.getAttribute('data-codex-extras') === 'stamp') || null);
const stampText = (el) => { const s = stampOf(el); return s ? s.textContent : null; };
const ours = (dom) => dom.document.root.querySelectorAll('[data-codex-extras]');

module.exports = async ({ ok, bad, eq, note, tmp, root }) => {
  /* ── the attributes, against a real sample ── */
  const file = path.join(__dirname, '..', 'fixtures', FIXTURE);
  const sample = JSON.parse(fs.readFileSync(file, 'utf8')).sample;
  const seen = attrNames(sample);
  const missing = REQUIRED.filter((n) => !seen.has(n));
  eq(missing, [], `every data-* attribute these features select by is in the Codex ${FIXTURE.replace(/\D+/, '').slice(0, 2)}.x sample`);
  eq(seen.has('data-app-action-timeline-scroll') && sample.page.scrollers === 1, true,
    'and the element the sample started at is the one scroller of the page, which is what the rail scrolls');
  /* The list a sample keeps is capped, so the names are read from the tree as well. Said as a check rather than left in
     a comment, because a check is what notices when the cap stops biting. */
  const capped = REQUIRED.filter((n) => !(sample.page.dataAttrs || []).includes(n));
  if (capped.length) {
    ok(`the sample's own list of data-* names holds ${sample.page.dataAttrs.length} of them and so misses `
      + `${capped.length} of these, which is why the check reads the sampled tree too`);
  } else {
    note('this sample\'s list of data-* names is not capped, so the tree did not have to be read for the check');
  }

  /* ── the page ── */
  const dom = createDom();
  const page = pageUnder(root, dom);
  const DAY = '2026-11-08';
  const made = conversation(dom, [
    { key: 't1', day: DAY, top: 100, ask: SECRETS['a message of the user\'s'], askedAt: '10:35 PM',
      reply: SECRETS['a reply'], sent: '2026-11-08T22:36:04Z', sentShown: '10:36 PM' },
    /* No time of Codex's own on the user's message, and the reply's carried as a count of seconds. */
    { key: 't2', top: 400, ask: 'and the tests?', reply: 'All 273 pass.', sent: '1762641600', sentShown: '' },
    /* A sent time in a form the parser does not know. */
    { key: 't3', top: 700, ask: 'ship it', reply: 'Done.', sent: 'the day before yesterday', sentShown: '' },
  ]);
  page.view();

  const [one, two, three] = made.built;
  eq([stampOf(one.user) !== null, stampOf(one.user).getAttribute('data-codex-extras'),
    stampOf(one.user) === one.user.children[0]],
  [true, 'stamp', true], 'a stamp is this script\'s own element, first inside the message it belongs to');
  eq(stampText(one.user), '22:35', 'the time Codex itself shows on the user\'s message is read and rewritten in their own zone');
  eq(stampText(one.reply), '22:36:04', 'a reply\'s sent time is taken from its attribute and shown to the second');
  eq(stampText(two.reply), '22:40:00', 'a sent time written as a count of seconds is read as one');
  eq(stampText(three.reply), null, 'a sent time in no form the parser knows leaves the reply unstamped');
  eq(stampText(two.user), null, 'and the user\'s message carries none while nothing says when it was sent');
  const shapes = page.posted.filter((m) => m.kind === 'stampShape');
  eq([shapes.length, shapes[0] && shapes[0].len, shapes[0] && shapes[0].first, shapes[0] && shapes[0].digits],
    [1, 'the day before yesterday'.length, 'letter', false],
    'the host is told the shape of that time once: its length, the class of its first character, whether it is all digits');

  /* The host's times from the rollout, which is the second source for the user's own messages. */
  const t = (h, m, s) => new Date(2026, 10, 8, h, m, s).getTime();
  page.times([t(22, 35, 10), t(22, 39, 2)]);
  eq([stampText(one.user), stampText(two.user)], ['22:35', null],
    'times from the rollout for fewer messages than the page shows are left unused, Codex\'s own still read');
  page.times([t(22, 35, 10), t(22, 39, 2), t(22, 44, 30)]);
  eq([stampText(one.user), stampText(two.user), stampText(three.user)], ['22:35:10', '22:39:02', '22:44:30'],
    'one time per message of theirs, and the rollout\'s seconds are taken where its minute is the one Codex rendered');
  page.times([t(19, 1, 10), t(22, 39, 2), t(22, 44, 30)]);
  eq([stampText(one.user), stampText(two.user)], ['22:35', '22:39:02'],
    'a rollout time that disagrees with the clock on that message is dropped for it alone, and the clock stands');

  /* The list of the user's own messages. */
  let rows = dom.document.root.querySelectorAll('[data-codex-extras="nav-row"]');
  eq(rows.length, 3, 'the list has one row per message of the user\'s');
  eq(rows.map((r) => r.textContent), ['22:35rebase onto the release branch before Friday', '22:39:02and the tests?', '22:44:30ship it'],
    'each row is that message\'s time and its opening words, in the order the conversation has them');
  eq(rows[0].getAttribute('title').includes('rebase onto the release branch'), true,
    'and the whole opening sentence is on the row for hovering, since a row is one line wide');
  /* The newest message is re-read on every pass, since it can still be arriving; the ones before it are not, because
     reading one walks its whole subtree and the answer no longer changes. */
  three.bubble.querySelector('span').textContent = 'ship it today';
  page.view();
  eq(dom.document.root.querySelectorAll('[data-codex-extras="nav-row"]')[2].textContent, '22:44:30ship it today',
    'the newest message\'s row follows its words while it is still arriving');
  rows = dom.document.root.querySelectorAll('[data-codex-extras="nav-row"]');
  rows[2].dispatch('click', { stopPropagation() {} });
  eq([three.user.scrolledIntoView, one.user.scrolledIntoView], [1, 0], 'clicking a row scrolls that message into view');
  const rail = dom.document.root.querySelectorAll('[data-codex-extras="nav-button"]');
  eq(rail.length, 5, 'the rail has five controls: to the top, up, the list, down, to the bottom');
  rail[4].dispatch('click', { stopPropagation() {} });
  rail[0].dispatch('click', { stopPropagation() {} });
  eq(made.scroller.scrolledTo.map((o) => o.top), [915, 0],
    'the outer two scroll the conversation itself to its end and to its start, the end measured at the moment of the jump');
  rail[3].dispatch('click', { stopPropagation() {} });
  eq(one.user.scrolledIntoView + two.user.scrolledIntoView + three.user.scrolledIntoView, 2,
    'and the down arrow steps to a message rather than to an edge');

  /* The colouring: class names on Codex's elements, and the meaning of them in this script's own stylesheet. */
  eq([one.user.className.includes('codex-extras-user-ink'), one.bubble.className.includes('codex-extras-user-edge')],
    [false, true], 'with no colour set only the bar is marked, and on the bubble rather than the full-width message');
  page.view({ userColor: '#90EE90' });
  const sheet = dom.document.head.children.find((k) => k.getAttribute('data-codex-extras') === 'style');
  eq([one.user.className.includes('codex-extras-user-ink'), !!sheet, sheet && sheet.textContent.includes('#90EE90')],
    [true, true, true], 'a colour marks the message and reaches the page as a rule of this script\'s own stylesheet');
  eq(ours(dom).every((e) => !Object.keys(e.style).length || e.getAttribute('data-codex-extras') === 'nav-list'
    || e.getAttribute('data-codex-extras') === 'nav-row'),
  true, 'nothing of Codex\'s is given an inline style, and this script\'s own only where a row is shown or hidden');
  eq([one.user.style.color, one.bubble.style.color, one.bubble.style.borderInlineStart],
    [undefined, undefined, undefined], 'and Codex\'s own elements carry no colour or border of this script\'s in their style');
  page.view({ userColor: 'red; background:url(http://evil.invalid)' });
  eq(dom.document.head.children.find((k) => k.getAttribute('data-codex-extras') === 'style').textContent.includes('evil.invalid'),
    false, 'a colour that is not a colour never reaches the stylesheet');

  /* The observer: on the one element the user scrolls, and not fed by this script's own writing. */
  const watching = dom.live();
  eq([watching.length, watching[0].targets[watching[0].targets.length - 1].target === made.scroller,
    watching[0].targets[watching[0].targets.length - 1].options.childList,
    watching[0].targets[watching[0].targets.length - 1].options.subtree],
  [1, true, true, true], 'one observer, on the conversation\'s scroller, for its children at any depth');
  dom.runTimers();
  const before = dom.waiting();
  dom.fire([{ type: 'childList', target: stampOf(one.reply) }]);
  eq(dom.waiting(), before, 'a change inside this script\'s own element is its own writing coming back, and starts no pass');
  dom.fire([{ type: 'childList', target: two.reply }]);
  eq(dom.waiting(), before + 1, 'a change to one of Codex\'s elements starts one pass, after a wait rather than at once');
  dom.fire([{ type: 'childList', target: three.reply }]);
  eq(dom.waiting(), before + 1, 'and a second change while that one is waiting does not start another');
  dom.runTimers();
  dom.document.hidden = true;
  dom.document.dispatch('visibilitychange', {});
  eq(dom.live().length, 0, 'a hidden page is not watched at all');
  dom.document.hidden = false;
  dom.document.dispatch('visibilitychange', {});
  eq(dom.live().length, 1, 'and it is watched again when it comes back');

  /* Everything off: every mark and every element of this script's goes, and Codex's page is as it was. */
  page.view({ timestamps: false, navigation: false, userColor: '', userEdge: false });
  eq([stampText(one.user), stampText(one.reply), stampText(three.user)], [null, null, null], 'the stamps go when the times go off');
  eq(dom.document.root.querySelectorAll('[data-codex-extras="nav"]').length, 0, 'the rail and the list go when the navigation goes off');
  eq([one.user.className, one.bubble.className], ['', ''], 'and the class names this script put on Codex\'s elements go with them');
  eq(ours(dom).length, 0, 'nothing of this script\'s is left anywhere in the page');
  eq(dom.live().length, 0, 'and with nothing to show, the page is no longer watched');

  /* ── nothing the conversation says leaves the page ── */
  const sent = JSON.stringify(page.posted);
  for (const [what, value] of Object.entries(SECRETS)) {
    if (sent.includes(value)) bad(`the page sent ${what} to the host`);
    else ok(`the page sent the host no ${what}`);
  }
  eq(page.posted.map((m) => m.kind).filter((k, i, a) => a.indexOf(k) === i), ['tz', 'stampShape'],
    'the only things it posts at all are the user\'s time zone and the shape of a time it could not read');

  /* ── the host: those times out of a rollout ── */
  const times = require('../../src/user-times');
  const line = (stamp, role, text, type = 'message') => JSON.stringify({ timestamp: stamp, type: 'response_item',
    payload: { type, role, content: [{ type: 'input_text', text }] } });
  const rolls = tmp('rollout');
  const roll = path.join(rolls, 'rollout-2026-11-08T22-00-00-01a1b8f2-fd2b-7e60-9ffc-16e5cb642e31.jsonl');
  const first = [
    JSON.stringify({ timestamp: '2026-11-08T22:00:00.000Z', type: 'session_meta', payload: { id: 'x' } }),
    line('2026-11-08T22:35:00.000Z', 'user', '<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>'),
    line('2026-11-08T22:35:10.000Z', 'user', SECRETS['a message of the user\'s']),
    JSON.stringify({ timestamp: '2026-11-08T22:35:20.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
    line('2026-11-08T22:36:04.000Z', 'assistant', SECRETS['a reply']),
    '',
  ].join('\n');
  fs.writeFileSync(roll, first);
  times.forget();
  eq(times.userTimes(roll), [Date.parse('2026-11-08T22:35:10.000Z')],
    'one time per message the user typed, and none for the one Codex wrote itself in their name');
  fs.appendFileSync(roll, line('2026-11-08T22:39:02.000Z', 'user', 'and the tests?') + '\n');
  eq(times.userTimes(roll), [Date.parse('2026-11-08T22:35:10.000Z'), Date.parse('2026-11-08T22:39:02.000Z')],
    'and a rollout that has grown is read from where the last read stopped');
  /* A line still being written: the read stops at the last complete one, so the rest is read when it is finished. */
  fs.appendFileSync(roll, line('2026-11-08T22:44:30.000Z', 'user', 'ship it').slice(0, 40));
  eq(times.userTimes(roll).length, 2, 'a line only half written yet is not read');
  fs.appendFileSync(roll, line('2026-11-08T22:44:30.000Z', 'user', 'ship it').slice(40) + '\n');
  eq(times.userTimes(roll).length, 3, 'and it is read once the rest of it is there');
  eq(times.timesIn([line('2026-11-08T22:50:00.000Z', 'user', 'go on'), 'not json at all', ''], []).times.length, 1,
    'a line that is not JSON is passed over rather than throwing');
  eq(times.timesIn([JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'go on' }] } })], []),
    { times: [], broken: true }, 'a message of theirs with no readable time makes the whole list unusable, since it would be one short');
  eq(times.userTimes(path.join(rolls, 'not-there.jsonl')), null, 'a rollout that is not there answers with no times rather than an empty list');
  fs.writeFileSync(path.join(rolls, 'gone.jsonl.zst'), 'not really zstd');
  eq(times.userTimes(path.join(rolls, 'gone.jsonl')), null, 'and a rollout Codex has compressed is left alone');

  /* ── the host: the settings message, and a panel being sent it ── */
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const codexDir = tmp('codex-of-this-window');
  control.state.extensions.set('openai.chatgpt', { extensionPath: codexDir, packageJSON: { version: '26.1021.22027' } });
  delete require.cache[require.resolve('../../src/patching')];
  const patching = require('../../src/patching');
  eq([patching.safeColor('#90EE90'), patching.safeColor('lightgreen'), patching.safeColor('rgb(144,238,144)'),
    patching.safeColor('red;background:url(x)'), patching.safeColor('')],
  ['#90EE90', 'lightgreen', 'rgb(144,238,144)', '', ''], 'only a plain CSS colour is passed on to the page');
  eq(patching.viewOf({ timestamps: false, conversationNavigation: true, userMessageColor: ' #abc ', userMessageEdge: false }),
    { type: 'codex-extras-view', timestamps: false, navigation: true, userColor: '#abc', userEdge: false },
    'the settings reach the page as one message, with the colour trimmed');
  eq(patching.viewOf({}), { type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true },
    'and a setting nobody has touched reads as on, the same way the page itself defaults');

  const posted = [];
  const provider = { postMessageToWebview: (w, m) => posted.push(m) };
  const panel = { webview: {}, active: true, reveal() {}, onDidDispose() {}, iconPath: null };
  patching.installHooks();
  globalThis.__codexExtrasPanel(panel, SECRETS['a thread id'], provider);
  patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
    vscode, log: () => {}, planQuestions: () => 0,
    settings: () => ({ patchCodex: 'off', chime: false, figures: false, timestamps: true, conversationNavigation: false,
      userMessageColor: 'lightgreen', userMessageEdge: true }),
    userTimes: async (id) => ({ times: id === SECRETS['a thread id'] ? [111, 222] : null }),
    source: { onDidChangeConversations: () => ({ dispose() {} }), _focus() {}, listConversations: async () => [], logo: null },
    context: { globalStorageUri: vscode.Uri.file(tmp('gs')) } });
  await patching.refreshPanels();
  const view = posted.filter((m) => m.type === 'codex-extras-view').pop();
  const whens = posted.filter((m) => m.type === 'codex-extras-user-times').pop();
  eq([view && view.timestamps, view && view.navigation, view && view.userColor, view && view.userEdge],
    [true, false, 'lightgreen', true], 'a redraw sends the panel what the settings say');
  eq(whens && whens.times, [111, 222], 'and, while the times are on, when the user\'s own messages were sent');
  const lines = patching.removePatch(vscode);
  const off = posted.filter((m) => m.type === 'codex-extras-view').pop();
  eq([off.timestamps, off.navigation, off.userEdge, off.userColor, Array.isArray(lines)], [false, false, false, '', true],
    'and taking the patch away tells the pages still running to clear everything off Codex\'s tree first');
};
