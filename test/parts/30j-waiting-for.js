// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The reason a waiting conversation gives Agent Plus (`waitingFor`, in the Conversations part of its docs/protocol.md),
 * and `shows`, which Agent Plus asks only when `features` lists it.
 *
 * A request this window's app-server sent gets the tool name Codex's PermissionRequest hook uses for the same action
 * (codex-rs/core/src/tools/approvals.rs, permission_request_payload), so the window that runs the conversation and a
 * window reading the hook's mark show the same name. The marks carry that name themselves. A question asked with
 * request_user_input_async, and one put in the work plan after the user's last message, have no tool.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

const ID = (n) => `01a2f0f1-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const approvals = require(path.join(root, 'src', 'approvals.js'));
  const waitingMarks = require(path.join(root, 'src', 'waiting-marks.js'));
  const install = require(path.join(root, 'src', 'plugin-install.js'));
  const { createCodexSource, conversationOf } = require(path.join(root, 'src', 'codex-source.js'));
  const T = ID(1);

  /* ── a request this window's app-server sent ── */
  const reasonOf = typeof approvals.reasonOfRequest === 'function' ? approvals.reasonOfRequest : () => undefined;
  const of = (method, params) => reasonOf({ id: 1, method, params: { threadId: T, ...params } });
  eq([of('item/commandExecution/requestApproval', { command: 'make check' }), of('execCommandApproval', { conversationId: T })],
    [{ kind: 'permission', tool: 'Bash' }, { kind: 'permission', tool: 'Bash' }],
    'a command to approve is Bash, the name Codex gives it in its PermissionRequest hook, in both protocols');
  eq(of('item/commandExecution/requestApproval', { kind: 'writeStdin' }), { kind: 'permission', tool: 'write_stdin' },
    'input for a terminal already running is write_stdin');
  eq([of('item/fileChange/requestApproval', {}), of('applyPatchApproval', { conversationId: T })],
    [{ kind: 'permission', tool: 'apply_patch' }, { kind: 'permission', tool: 'apply_patch' }], 'a file change is apply_patch');
  eq(of('item/permissions/requestApproval', { reason: 'network' }), { kind: 'permission', tool: 'request_permissions' },
    'a request for more permissions is request_permissions');
  eq(of('mcpServer/elicitation/request', { serverName: 'rmcp', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'echo' } }),
    { kind: 'permission', tool: 'mcp__rmcp__echo' }, 'an MCP tool call to approve is mcp__<server>__<tool>, as the hook names it');
  eq(of('mcpServer/elicitation/request', { serverName: 'rmcp', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' } }),
    { kind: 'permission' }, 'and one that does not name its tool is an approval of no known tool');
  eq([of('item/tool/requestUserInput', { isBlocking: true, questions: [{ id: 'q1', question: 'Which branch?' }] }),
    of('mcpServer/elicitation/request', { serverName: 'rmcp', mode: 'form', message: 'Your API key?' })],
  [{ kind: 'question' }, { kind: 'question' }], 'a question the model asks, and a form an MCP server asks to have filled in, are questions');
  eq(of('item/tool/requestUserInput', { isBlocking: true, questions: [{ id: 'mcp_tool_call_approval_call_7', question: 'Allow?' }] }),
    { kind: 'permission' }, 'an MCP tool call Codex asks about as a question is an approval, of a tool the question does not name');
  eq(of('mcpServer/elicitation/request', { serverName: 'rmcp', mode: 'url', url: 'https://example.invalid/', elicitationId: 'e1' }),
    { kind: 'choice' }, 'a page an MCP server asks the user to go to is a choice');
  eq([of('item/started', {}), reasonOf(null)], [null, null], 'anything that does not wait has no reason');

  /* ── a conversation's reason, from the requests this window has outstanding ── */
  const book = approvals.createApprovals();
  const bookReason = (t) => (typeof book.reasonOf === 'function' ? book.reasonOf(t) : undefined);
  book.request({ id: 'r1', method: 'item/tool/requestUserInput', params: { threadId: T, isBlocking: false, questions: [{ id: 'q' }] } });
  book.request({ id: 'r2', method: 'item/fileChange/requestApproval', params: { threadId: T } });
  book.request({ id: 'r3', method: 'item/commandExecution/requestApproval', params: { threadId: T } });
  eq(bookReason(T), { kind: 'permission', tool: 'apply_patch' },
    'with several outstanding, the oldest the user has to answer names it, before one Codex will answer by itself');
  book.resolve('r2');
  eq(bookReason(T), { kind: 'permission', tool: 'Bash' }, 'answered, the next one does');
  book.resolve('r3');
  eq(bookReason(T), { kind: 'question' }, 'and with only a question Codex answers by itself left, that');
  book.resolve('r1');
  book.pageSays(T, true);
  eq([book.of(T).decide, bookReason(T)], [1, null], 'an approval card a page reports, with no request behind it here, has no reason');
  eq(bookReason(ID(9)), null, 'and a conversation with nothing outstanding has none');
  const patching = require(path.join(root, 'src', 'patching.js'));
  patching._approvals.clear();
  patching._approvals.request({ id: 'p1', method: 'item/permissions/requestApproval', params: { threadId: T } });
  eq(typeof patching.waitReasonOf === 'function' ? patching.waitReasonOf(T) : undefined, { kind: 'permission', tool: 'request_permissions' },
    'the patch answers it for the source from the requests it has on its books');
  patching._approvals.clear();

  /* ── the marks of other windows ── */
  const now = Date.now();
  const st = { working: true, turnId: 't1', startedMs: now - 60e3, endedMs: 0, lastActivityMs: now - 1000 };
  const counted = waitingMarks.counted([{ at: now - 30e3, turn: 't1', tool: 'Bash', file: 'a' }, { at: now - 20e3, turn: 't1', tool: 'apply_patch', file: 'b' }],
    { state: st });
  eq([counted.count, counted.tool], [2, 'Bash'], 'the marks still asked for name the tool of the oldest');
  eq(waitingMarks.counted([{ at: now - 30e3, turn: 't0', tool: 'Bash', file: 'a' }], { state: st }).tool, '',
    'and a mark that no longer counts names none');

  /* ── conversationOf ── */
  const th = { id: T, title: 'Ship the fix', cwd: '/w', updatedMs: now - 1000 };
  const none = { unread: new Set(), openHere: new Set(), now };
  const ended = { working: false, startedMs: now - 60e3, endedMs: now - 30e3, lastEndedMs: now - 30e3, lastActivityMs: now - 30e3, lastUserMs: now - 60e3 };
  const wf = (opts) => conversationOf(th, { ...none, ...opts }).waitingFor;
  eq(wf({ state: st, waiting: { decide: 1, soon: 0, reason: { kind: 'permission', tool: 'Bash' } } }), { kind: 'permission', tool: 'Bash' },
    'a conversation stopped on an approval reports the tool');
  eq(wf({ state: st, waiting: { decide: 0, soon: 1, reason: { kind: 'question' } } }), { kind: 'question' },
    'one stopped on a question Codex will answer by itself reports a question');
  eq(wf({ state: { ...ended, askedMs: now - 31e3 } }), { kind: 'question' },
    'one whose turn ended on a question asked with request_user_input_async reports a question');
  eq(wf({ state: ended, planAsked: now - 10e3 }), { kind: 'planQuestion' },
    'one whose work plan put a question to the user after their last message reports a question in its plan');
  eq(wf({ state: st, waiting: { decide: 1, soon: 0 } }), undefined, 'one stopped on something whose reason is not known reports none');
  eq(wf({ state: st, waiting: { decide: 1, soon: 0, reason: { kind: 'nonsense' } } }), undefined, 'and neither does one with a reason that is not one');
  eq([wf({ state: st }), wf({ state: st, waiting: { decide: 0, soon: 0, reason: { kind: 'permission', tool: 'Bash' } } }), wf({ state: ended })],
    [undefined, undefined, undefined], 'a conversation that is not waiting reports none, whatever is passed in');

  /* ── through the source: this window's requests, the marks, the rollout and the plan ── */
  const home = tmp('codex-home');
  process.env.CODEX_HOME = home;
  const marksDir = path.join(install.planDir(home), waitingMarks.WAITING_DIR);
  fs.mkdirSync(marksDir, { recursive: true });
  const mark = (thread, key, tool) => fs.writeFileSync(path.join(marksDir, `${thread}.${key}.json`),
    JSON.stringify({ at: now - 30e3, session: thread, thread, turn: 't1', tool }));
  const E = ID(2), E2 = ID(3), H = ID(4), Q = ID(5), P = ID(6), W = ID(7), S = ID(8);
  const rows = [E, E2, H, Q, P, W, S].map((id, i) => ({ id, kind: 'user', origin: 'vscode', title: `Conversation ${i + 1}`, cwd: '/w', updatedMs: now }));
  const states = {};
  for (const id of [E, E2, H, W, S]) states[id] = { ...st };
  states[Q] = { ...ended, askedMs: now - 31e3 };
  states[P] = { ...ended };
  mark(E, '0000000000000001', 'Bash');
  mark(E2, '0000000000000002', '');
  mark(H, '0000000000000003', 'Bash');
  const reader = { threads: () => rows, thread: (id) => rows.find((x) => x.id === id) || null, present: () => true,
    state: (id) => states[id] || null, unread: () => new Map(), hasPlan: () => false, sections: () => new Map(),
    planAsked: (id) => (id === P ? now - 10e3 : 0), refresh: async () => false, ready: async () => ({ threads: rows, readable: true }),
    request: async () => null };
  const owed = { [H]: { decide: 1, soon: 0 } };
  const reasons = { [H]: { kind: 'permission', tool: 'apply_patch' } };
  let side = '';
  const stand = { approvalsOf: (id) => owed[id] || { decide: 0, soon: 0 }, waitReasonOf: (id) => reasons[id] || null,
    onApprovalsChanged: () => ({ dispose() {} }), canDeliver: () => false, sidebarShowing: () => side, panelThreads: () => [] };
  const source = createCodexSource(vscode, { reader, patching: stand });
  try {
    await source._poll({ tell: true });
    const list = new Map((await source.listConversations()).map((c) => [c.sessionId, c]));
    const said = (id) => { const c = list.get(id); return c ? [c.activity, c.waitingFor] : null; };
    eq(said(E), ['waiting', { kind: 'permission', tool: 'Bash' }],
      'a conversation another window runs, waiting on an approval its hook marked, reports the tool the mark names');
    eq(said(E2), ['waiting', { kind: 'permission' }], 'one whose mark names no tool reports an approval of no known tool');
    eq(said(H), ['waiting', { kind: 'permission', tool: 'apply_patch' }],
      'one this window\'s app-server asked about reports what that request names, over a mark');
    eq(said(Q), ['waiting', { kind: 'question' }], 'one whose turn ended on a question reports a question');
    eq(said(P), ['waiting', { kind: 'planQuestion' }], 'one whose work plan asks the user reports a question in its plan');
    eq(said(W), ['working', undefined], 'one that is working reports none');
    eq((source.threadState(E) || {}).waitingFor, { kind: 'permission', tool: 'Bash' }, 'and threadState says the same');

    /* ── shows ── */
    eq((source.features || []).includes('shows'), true, '`features` lists shows, so Agent Plus asks it');
    control.setTabs([control.fileTab('/w/notes.txt'), control.codexTab(W)], 0);
    source._tabsChanged();
    eq([source.shows(W), source.isFocused(W)], [true, false],
      'a conversation in a tab of this window behind another is shown here, though it is not in front');
    side = S;
    eq([source.shows(S), source.shows(E), source.shows('')], [true, false, false],
      'one in Codex\'s sidebar is shown here too, and one this window has in neither is not');
  } finally {
    source.dispose();
  }
};
