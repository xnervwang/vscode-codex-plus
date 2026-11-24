// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Approvals asked for outside this window: the plugin's PermissionRequest hook leaves a mark beside the plans
 * (codex-plugin/agent-work-plan/hooks/mark-waiting.py), and the source reads it (src/waiting-marks.js), so a
 * conversation running in another window or in Codex's terminal interface shows as waiting for the user here too.
 *
 * The test runs the hook the way Codex does, with the JSON Codex 26.1117 sends on standard input (the input schemas
 * that build embeds). A stand-in reader returns rollout states the test sets, and a stand-in patch reports the
 * approvals this window's own app-server asked for.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

const ELSEWHERE = '01a1a77a-0000-7000-8000-0000000000e1';
const EXEC = '01a1a77a-0000-7000-8000-0000000000e2';
const HERE = '01a1a77a-0000-7000-8000-0000000000e3';
const SUB = '01a1a77a-0000-7000-8000-0000000000e4';
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const python = () => {
  for (const exe of ['python3', 'python']) {
    const r = cp.spawnSync(exe, ['-c', 'import sys; print(sys.version_info[:2] >= (3, 7))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return exe;
  }
  return '';
};

module.exports = async ({ eq, note, tmp, root }) => {
  const py = python();
  if (!py) { note('no Python 3.7+ here: the approval marks were not checked'); return; }
  const { vscode } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const install = require(path.join(root, 'src', 'plugin-install.js'));
  const { createCodexSource } = require(path.join(root, 'src', 'codex-source.js'));
  const waitingMarks = require(path.join(root, 'src', 'waiting-marks.js'));

  const home = tmp('codex-home');
  process.env.CODEX_HOME = home;
  const data = install.planDir(home);
  fs.mkdirSync(data, { recursive: true });
  const hook = path.join(root, 'codex-plugin', 'agent-work-plan', 'hooks', 'mark-waiting.py');
  const send = (payload) => cp.spawnSync(py, [hook, data], { input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const common = (session, turn) => ({ session_id: session, turn_id: turn, cwd: '/w', model: 'gpt-5.5', permission_mode: 'default',
    transcript_path: null });
  const asks = (session, turn, command, extra = {}) => send({ ...common(session, turn), hook_event_name: 'PermissionRequest', tool_name: 'Bash',
    tool_input: { command, description: 'Run it outside the sandbox.' }, ...extra });
  const marksOn = () => { try { return fs.readdirSync(path.join(data, waitingMarks.WAITING_DIR)).filter((n) => n.endsWith('.json')).sort(); } catch (_) { return []; } };

  /* ── the hook ── */
  const r = asks(ELSEWHERE, 't1', 'make check');
  eq([r.status, r.stdout, marksOn().map((n) => n.split('.')[0])], [0, '', [ELSEWHERE]],
    'PermissionRequest leaves a mark named by the conversation, prints nothing (so it decides nothing) and exits 0');
  const bad = send({ hook_event_name: 'PermissionRequest', session_id: 'x' });
  eq([bad.status, bad.stdout, marksOn().length], [0, '', 1], 'and an event it cannot use changes nothing and still exits 0 with no output');

  /* ── the source ── */
  const now = Date.now();
  const rows = [
    { id: ELSEWHERE, kind: 'user', origin: 'vscode', title: 'Running in another window', cwd: '/w', updatedMs: now },
    { id: EXEC, kind: 'background', origin: 'exec', title: 'A codex exec run', cwd: '/w', updatedMs: now },
    { id: HERE, kind: 'user', origin: 'vscode', title: 'Running here', cwd: '/w', updatedMs: now },
    { id: SUB, kind: 'subagent', origin: 'subagent', parent: EXEC, title: 'A codex exec run\'s sub-agent', cwd: '/w', updatedMs: now },
  ];
  const states = {};
  const running = (id, turn) => { states[id] = { working: true, turnId: turn, startedMs: now - 60e3, endedMs: 0, lastActivityMs: now - 1000 }; };
  for (const t of rows) running(t.id, 't1');
  const reader = { threads: () => rows, thread: (id) => rows.find((x) => x.id === id) || null, present: () => true,
    state: (id) => states[id] || null, unread: () => new Map(), hasPlan: () => false, sections: () => new Map(),
    refresh: async () => false, ready: async () => ({ threads: rows, readable: true }) };
  const pending = {};
  const approvalsChanged = new fake.EventEmitter();
  const patching = { approvalsOf: (id) => ({ decide: pending[id] || 0, soon: 0 }), onApprovalsChanged: (fn) => approvalsChanged.event(fn),
    canDeliver: () => false, sidebarShowing: () => '', panelThreads: () => [] };
  const source = createCodexSource(vscode, { reader, patching });
  const of = async (id) => {
    await source._poll({ tell: true });
    const c = (await source.listConversations()).find((x) => x.sessionId === id) || source.threadState(id);
    return c ? [c.state, c.activity, c.decide] : null;
  };
  try {
    eq(await of(ELSEWHERE), ['prompt', 'waiting', 1],
      'a conversation whose turn runs elsewhere and that has a mark is waiting for the user, as one this window asked about is');
    send({ ...common(ELSEWHERE, 't1'), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call_1',
      tool_input: { command: 'make check' }, tool_response: 'ok' });
    eq([marksOn(), await of(ELSEWHERE)], [[], ['working', 'working', 0]],
      'once the approved command has run, PostToolUse takes the mark away and the conversation is working again');

    asks(ELSEWHERE, 't1', 'make check');
    send({ ...common(ELSEWHERE, 't1'), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
    eq([marksOn(), await of(ELSEWHERE)], [[], ['working', 'working', 0]], 'the end of the turn (Stop) takes it away too');

    asks(ELSEWHERE, 't1', 'make check');
    eq(await of(ELSEWHERE), ['prompt', 'waiting', 1], 'asked again, it waits again');
    states[ELSEWHERE] = { ...states[ELSEWHERE], working: false, endedMs: Date.now() + 5 };
    eq([(await of(ELSEWHERE)).slice(1), marksOn()], [['stopped', 0], []],
      'a denied call gets no hook, so a turn the rollout shows ended after the mark ends it, and the mark is removed');

    running(ELSEWHERE, 't2');
    asks(ELSEWHERE, 't1', 'make check');
    eq((await of(ELSEWHERE))[2], 0, 'a mark of another turn than the one running does not count');
    states[ELSEWHERE] = { ...states[ELSEWHERE], startedMs: Date.now() + 5 };
    await of(ELSEWHERE);
    eq(marksOn(), [], 'and one older than the turn running is removed');
    running(ELSEWHERE, 't1');

    asks(EXEC, 't1', 'make check');
    asks(EXEC, 't1', 'make lint', { agent_id: SUB, agent_type: 'worker' });
    eq([marksOn().map((n) => n.split('.')[0]).sort(), (await of(EXEC))[1], (await of(SUB))[1]], [[EXEC, SUB].sort(), 'working', 'working'],
      'a codex exec run, and a sub-agent of one, are never waiting: exec refuses every approval request at once');
    send({ ...common(EXEC, 't1'), hook_event_name: 'SubagentStop', agent_id: SUB, agent_type: 'worker', agent_transcript_path: '',
      stop_hook_active: false, last_assistant_message: '' });
    send({ ...common(EXEC, 't1'), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '' });
    eq(marksOn(), [], 'their marks go at the end of their turns');

    /* For a request of this window's own, the mark is written before Codex sends the request, and the patch then has
       it outstanding. */
    asks(HERE, 't1', 'make check');
    pending[HERE] = 1;
    approvalsChanged.fire();
    eq(await of(HERE), ['prompt', 'waiting', 1], 'a request this window\'s app-server asked about is counted once, not once for it and once for its mark');
    await tick(5);
    pending[HERE] = 0;
    approvalsChanged.fire();
    eq([marksOn(), await of(HERE)], [[], ['working', 'working', 0]],
      'answered here, the mark of that request is removed at once, so the other windows stop showing it before the command ends');
    asks(HERE, 't1', 'make lint');
    eq((await of(HERE))[1], 'waiting', 'and a later request of the same conversation is marked and counted again');
    send({ ...common(HERE, 't1'), hook_event_name: 'UserPromptSubmit', prompt: 'and the docs' });
    eq(marksOn().length, 1, 'a message sent into the turn that waits leaves the mark');
    send({ ...common(HERE, 't2'), hook_event_name: 'UserPromptSubmit', prompt: 'next' });
    eq(marksOn(), [], 'the next turn\'s message takes it away');

    /* An old mark of a Codex that never cleared it. */
    fs.mkdirSync(path.join(data, waitingMarks.WAITING_DIR), { recursive: true });
    fs.writeFileSync(path.join(data, waitingMarks.WAITING_DIR, `${ELSEWHERE}.0123456789abcdef.json`),
      JSON.stringify({ at: Date.now() - waitingMarks.MAX_AGE_MS - 1000, session: ELSEWHERE, thread: ELSEWHERE, turn: 't1', tool: 'Bash' }));
    eq([(await of(ELSEWHERE))[1], marksOn()], ['working', []], 'a mark a day old counts for nothing and is removed');
  } finally {
    source.dispose();
  }
};
