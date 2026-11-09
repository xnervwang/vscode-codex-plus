// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Conversations stopped waiting for the user: which requests count as waiting for a person and which Codex answers
 * by itself, what finishes one, what clears a request nothing ever answers, and the hook the patch calls.
 *
 * The classification is checked against Codex's own, which is readable in its bundle: the five methods its approval
 * tracker keys by request id, and the two its countdown coordinator takes over except in the cases it hands back.
 * Where a real Codex is installed here, the method names are looked for in its pristine bundle as well, so a renamed
 * method is caught rather than quietly classified as something that does not wait.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const fake = require('../fake-vscode');

const THREAD = '01a1b8f2-fd2b-7e60-9ffc-16e5cb642e31';
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function pristineBundles() {
  const out = [];
  for (const root of [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const n of names) {
      if (!/^openai\.chatgpt-/.test(n)) continue;
      const file = path.join(root, n, 'out', 'extension.js');
      const backup = file + '.codex-extras-host.bak';
      const use = fs.existsSync(backup) ? backup : file;
      if (fs.existsSync(use)) out.push({ name: n, src: fs.readFileSync(use, 'utf8') });
    }
  }
  return out;
}

module.exports = async ({ ok, bad, note, eq, tmp }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  const { createApprovals, waitOf, APPROVALS, ASKS, COUNTDOWN_MS } = require('../../src/approvals');

  /* ── which requests wait, and which of those the user has to answer ── */
  const ask = (method, params) => waitOf({ id: 1, method, params });
  for (const [method, where] of Object.entries(APPROVALS)) {
    eq(ask(method, { [where]: THREAD, turnId: 't1' }), { thread: THREAD, method, decides: true },
      `${method} waits for the user, and says which conversation by its ${where}`);
  }
  eq(ask('item/commandExecution/requestApproval', {}), null,
    'a request naming no conversation is not counted, since nothing could be shown for it');
  eq(ask('item/started', { threadId: THREAD }), null, 'a method that does not wait for anybody is not counted');
  eq(waitOf(null), null, 'and neither is nothing at all');

  eq(ask('item/tool/requestUserInput', { threadId: THREAD, isBlocking: true }),
    { thread: THREAD, method: 'item/tool/requestUserInput', decides: true },
    'a blocking input request waits for the user: Codex takes its own countdown off that one');
  eq(ask('item/tool/requestUserInput', { threadId: THREAD }).decides, false,
    'a non-blocking one does not, since Codex answers it with an empty input once its countdown runs out');
  eq(ask('mcpServer/elicitation/request', { threadId: THREAD, mode: 'openai/userVerification' }).decides, true,
    'a user-verification elicitation waits for the user');
  eq(ask('mcpServer/elicitation/request', { threadId: THREAD, _meta: { autoResolutionMs: 30000 } }).decides, false,
    'an elicitation that asked for a countdown does not: Codex declines it when the countdown runs out');
  eq([ask('mcpServer/elicitation/request', { threadId: THREAD }).decides,
    ask('mcpServer/elicitation/request', { threadId: THREAD, _meta: { autoResolutionMs: COUNTDOWN_MS.min - 1 } }).decides,
    ask('mcpServer/elicitation/request', { threadId: THREAD, _meta: { autoResolutionMs: COUNTDOWN_MS.max + 1 } }).decides,
    ask('mcpServer/elicitation/request', { threadId: THREAD, _meta: { autoResolutionMs: 30000.5 } }).decides],
  [true, true, true, true],
  'an elicitation whose _meta asks for no countdown, or one outside the range Codex accepts, gets none and so waits for the user');

  /* ── the two kinds are counted apart ── */
  const book = createApprovals();
  book.request({ id: 'r1', method: 'item/commandExecution/requestApproval', params: { threadId: THREAD } });
  book.request({ id: 'r2', method: 'item/tool/requestUserInput', params: { threadId: THREAD } });
  eq([book.of(THREAD), book.decideCount()], [{ decide: 1, soon: 1 }, 1],
    'a conversation with one of each reports both, and only the one needing an answer is counted');
  book.request({ id: 'r3', method: 'applyPatchApproval', params: { conversationId: THREAD } });
  book.request({ id: 'r4', method: 'execCommandApproval', params: { conversationId: OTHER } });
  eq([book.of(THREAD).decide, book.of(OTHER).decide, book.decideCount(), book.threads().length], [2, 1, 3, 2],
    'several at once are counted per conversation and across them');

  /* ── what finishes one ── */
  eq([book.resolve('r1'), book.of(THREAD).decide], [THREAD, 1], 'the answer this window sends finishes that request');
  eq(book.resolve('r1'), '', 'and the same answer arriving twice takes nothing a second time');
  eq([book.resolve('r3'), book.of(THREAD)], [THREAD, { decide: 0, soon: 1 }],
    'with the last one answered the conversation owes nothing, though Codex still has one of its own to answer');
  eq(book.resolve('never-asked'), '', 'an answer to something that was never recorded changes nothing');

  /* ── the net: a request nothing ever answers, under a conversation that stopped ── */
  const net = createApprovals();
  net.request({ id: 'x1', method: 'item/fileChange/requestApproval', params: { threadId: THREAD } });
  const stopped = () => false;
  eq([net.prune(stopped), net.of(THREAD).decide], [[], 1],
    'one pass saying the conversation is not running drops nothing: a request can arrive before the poll that shows its turn');
  eq([net.prune(stopped), net.of(THREAD).decide, net.threads()], [[THREAD], 0, []],
    'the second pass drops it, so a request nothing answered cannot be owed for ever');
  net.request({ id: 'x2', method: 'item/fileChange/requestApproval', params: { threadId: THREAD } });
  net.prune(stopped);
  net.prune(() => true);
  eq([net.prune(stopped), net.of(THREAD).decide], [[], 1],
    'a pass that finds the conversation running again starts the count over, so a slow turn is never dropped mid-wait');

  /* ── what a page says, beside what this window's own requests say ── */
  const pg = createApprovals();
  pg.pageSays(THREAD, true);
  eq([pg.of(THREAD), pg.decideCount(), pg.threads()], [{ decide: 1, soon: 0 }, 1, [THREAD]],
    'a page reporting an approval card counts as one answer owed, which is how a conversation only the sidebar shows is seen');
  pg.request({ id: 'p1', method: 'item/permissions/requestApproval', params: { threadId: THREAD } });
  eq([pg.of(THREAD).decide, pg.decideCount()], [1, 1],
    'a conversation seen both by its page and by this window\'s requests is counted once, not twice');
  pg.pageSays(THREAD, false);
  eq(pg.of(THREAD).decide, 1, 'and the card going off a page does not take away a request this window has not seen answered');
  pg.resolve('p1');
  eq([pg.of(THREAD).decide, pg.threads()], [0, []], 'with both gone the conversation is off the books');

  /* ── the hook the patch calls ── */
  const patching = require('../../src/patching');
  const changes = [];
  const chimes = [];
  const provider = { postMessageToWebview: (w, msg) => chimes.push(msg), sendMessageToPanel: (p, msg) => chimes.push(msg) };
  let conversations = [{ sessionId: THREAD, state: 'working', working: true }];
  patching.installHooks();
  patching._approvals.clear();
  const context = { subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() };
  patching.activate(context, {
    vscode, log: () => {}, settings: () => ({ patchCodex: 'off', chime: true, figures: false }), planQuestions: () => 0,
    source: { onDidChangeConversations: () => ({ dispose() {} }), _focus: () => {}, logo: null,
      listConversations: async () => conversations },
    context: { globalStorageUri: vscode.Uri.file(tmp('gs2')) },
  });
  patching.onApprovalsChanged(() => changes.push(patching.decideCount()));
  const webview = {};
  const panel = { webview, reveal() {}, onDidDispose(fn) { this.dispose = fn; }, iconPath: null };
  globalThis.__codexExtrasPanel(panel, THREAD, provider);

  globalThis.__codexExtrasAppServer('request', { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD } });
  eq([patching.decideCount(), patching.approvalsOf(THREAD), changes], [1, { decide: 1, soon: 0 }, [1]],
    'a request through the hook is on the books at once, and the views are told rather than left to the next poll');
  globalThis.__codexExtrasAppServer('request', { id: 8, method: 'item/started', params: { threadId: THREAD } });
  eq(changes.length, 1, 'a message that is not a request waiting on anybody tells nobody anything');
  globalThis.__codexExtrasAppServer('answer', { id: 7 });
  eq([patching.decideCount(), changes], [0, [1, 0]], 'the answer this window sent takes it off the books');

  globalThis.__codexExtrasAppServer('request', { id: 9, method: 'item/fileChange/requestApproval', params: { threadId: THREAD } });
  globalThis.__codexExtrasAppServer('notification', { method: 'serverRequest/resolved', params: { requestId: 9 } });
  eq(patching.decideCount(), 0, 'and so does the notification saying somebody else answered it');
  globalThis.__codexExtrasAppServer('request', { id: 10, method: 'item/fileChange/requestApproval', params: { threadId: THREAD } });
  globalThis.__codexExtrasAppServer('notification', { method: 'item/completed', params: { requestId: 10 } });
  eq(patching.decideCount(), 1, 'while any other notification leaves it where it was');

  /* A closed tab does not end the wait: the host side never needed one. */
  chimes.length = 0;
  panel.dispose();
  eq([patching.decideCount(), patching.panelThreads().includes(THREAD)], [1, false],
    'closing the conversation\'s tab leaves the request owed, since this side reads it from the app-server and not from a page');
  globalThis.__codexExtrasAppServer('answer', { id: 10 });

  /* ── the chime, and the dot ── */
  const fresh = { webview: {}, reveal() {}, onDidDispose() {}, iconPath: null };
  globalThis.__codexExtrasPanel(fresh, THREAD, provider);
  conversations = [{ sessionId: THREAD, state: 'working', working: true }];
  await patching.refreshPanels();
  chimes.length = 0;
  globalThis.__codexExtrasAppServer('request', { id: 11, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD } });
  await patching.refreshPanels();
  eq(chimes.filter((m) => m.type === 'codex-extras-chime').map((m) => m.kind), ['approval'],
    'a conversation that now owes an answer chimes once, with a sound of its own');
  chimes.length = 0;
  await patching.refreshPanels();
  eq(chimes.filter((m) => m.type === 'codex-extras-chime').length, 0, 'and not again while the same request is still waiting');

  /* The model asking the user something through a blocking input request rings the question chime, not the one for
     permission; a permission arriving with it still rings the permission chime. */
  globalThis.__codexExtrasAppServer('answer', { id: 11 });
  await patching.refreshPanels();
  chimes.length = 0;
  globalThis.__codexExtrasAppServer('request', { id: 21, method: 'item/tool/requestUserInput', params: { threadId: THREAD, isBlocking: true } });
  await patching.refreshPanels();
  eq(chimes.filter((m) => m.type === 'codex-extras-chime').map((m) => m.kind), ['question'],
    'a blocking input request from the model rings the question chime');
  chimes.length = 0;
  globalThis.__codexExtrasAppServer('request', { id: 22, method: 'item/tool/requestUserInput', params: { threadId: THREAD, isBlocking: true } });
  globalThis.__codexExtrasAppServer('request', { id: 23, method: 'item/permissions/requestApproval', params: { threadId: THREAD } });
  await patching.refreshPanels();
  eq(chimes.filter((m) => m.type === 'codex-extras-chime').map((m) => m.kind), ['approval'],
    'and a question arriving together with a request for permission rings the permission chime, once');
  chimes.length = 0;
  globalThis.__codexExtrasAppServer('request', { id: 24, method: 'item/tool/requestUserInput', params: { threadId: THREAD, isBlocking: false } });
  await patching.refreshPanels();
  eq(chimes.filter((m) => m.type === 'codex-extras-chime').length, 0,
    'one Codex will answer by itself after its countdown rings nothing, as before');
  for (const id of [21, 22, 23, 24]) globalThis.__codexExtrasAppServer('answer', { id });
  globalThis.__codexExtrasAppServer('request', { id: 11, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD } });
  await patching.refreshPanels();

  /* A turn that stopped on an approval has not finished, so it must not ring the finished-turn chime. */
  chimes.length = 0;
  conversations = [{ sessionId: THREAD, state: 'prompt', working: true, decide: 1 }];
  await patching.refreshPanels();
  eq(chimes.filter((m) => m.type === 'codex-extras-chime').length, 0,
    'a turn waiting on the user does not ring the finished-turn chime, though the state it reports is no longer working');
  globalThis.__codexExtrasAppServer('answer', { id: 11 });
  eq(patching.TAB_DOTS.prompt, '#f59e0b', 'and the tab dot has a colour for waiting on the user, beside working and unread');

  /* ── what a page reports, and which conversation it is taken to be about ── */
  const sidebarPage = {};
  globalThis.__codexExtrasMessage(fresh.webview, { kind: 'approval', on: true }, provider);
  eq([patching.approvalsOf(THREAD).decide, patching.decideCount()], [1, 1],
    'a page saying a card is up is taken to be about the conversation whose panel that page belongs to');
  globalThis.__codexExtrasMessage(fresh.webview, { kind: 'approval', on: false }, provider);
  eq(patching.decideCount(), 0, 'and the card going off that page ends it');
  globalThis.__codexExtrasBroadcast('thread-stream-following-changed', { conversationId: OTHER, following: true });
  globalThis.__codexExtrasMessage(sidebarPage, { kind: 'approval', on: true }, provider);
  eq([patching.approvalsOf(OTHER).decide, patching.waitingThreads()], [1, [OTHER]],
    'a page with no panel of its own is the sidebar, so its card is about the conversation the sidebar last went to');
  globalThis.__codexExtrasMessage(sidebarPage, { kind: 'approval', on: false }, provider);
  eq(patching.decideCount(), 0, 'which ends the same way');

  const line = patching.statusLines().filter((l) => l.startsWith('Waiting for you'))[0];
  eq(line, 'Waiting for you: nothing', 'the status command says so when nothing is waiting');
  globalThis.__codexExtrasAppServer('request', { id: 12, method: 'item/tool/requestUserInput', params: { threadId: THREAD } });
  eq(patching.statusLines().filter((l) => l.startsWith('Waiting for you'))[0],
    `Waiting for you: ${THREAD} (0 to decide, 1 Codex will answer itself)`,
    'and tells the two kinds apart when one is Codex\'s own to answer');
  patching._approvals.clear();

  /* ── the method names, against the Codex installed here ── */
  const bundles = pristineBundles();
  if (!bundles.length) note('no Codex extension installed here: the method names were not looked for in a real bundle');
  for (const { name, src } of bundles) {
    const missing = [...Object.keys(APPROVALS), ...ASKS].filter((m) => !src.includes(`"${m}"`));
    if (missing.length) bad(`${name}: Codex's bundle no longer names ${missing.join(', ')}, so those requests would be read as not waiting`);
    else ok(`${name}: all ${Object.keys(APPROVALS).length + ASKS.size} methods that wait are still named in Codex's own bundle`);
  }
};
