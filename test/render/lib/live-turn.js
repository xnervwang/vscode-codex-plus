// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A made-up turn in progress, sent to the page as if Codex's app-server had sent it. The real app-server never hears of
 * it, so to the page it is a turn some other page started, and Codex marks its user message as steered into a running
 * turn (steeringStatus "accepted"), without the anchor attribute a turn's own first message gets.
 *
 *   approval()     a user message, a command waiting for approval, and the approval request
 *   background()   a user message and a command started through unified exec 60 seconds ago that has not ended
 */
const fake = require('./fake-codex-home');

const TURN = '0199a1b2-0000-7000-8000-0000000000f5';
const n = (method, params) => ({ type: 'mcp-notification', hostId: 'local', method, params });

function opening(now, text) {
  const thread = fake.THREAD;
  const item = { type: 'userMessage', id: 'item-live-user', clientId: null, content: [{ type: 'text', text, text_elements: [] }] };
  return [
    n('thread/status/changed', { threadId: thread, status: { type: 'active', activeFlags: [] } }),
    n('turn/started', { threadId: thread, turn: { id: TURN, rootTurnId: TURN, items: [], itemsView: 'full', status: 'inProgress', error: null,
      startedAt: Math.floor(now / 1000) - 70, completedAt: null, durationMs: null } }),
    n('item/started', { threadId: thread, turnId: TURN, startedAtMs: now - 70000, item }),
    n('item/completed', { threadId: thread, turnId: TURN, startedAtMs: now - 70000, completedAtMs: now - 70000, item }),
  ];
}

const command = (id, cmd, extra) => ({ type: 'commandExecution', id, command: cmd, commandActions: [{ type: 'unknown', command: cmd }], cwd: fake.CWD,
  status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null, processId: null, ...extra });

function approval(now = Date.now()) {
  const thread = fake.THREAD, ITEM = 'call_demo_deploy_1', CMD = 'npm run deploy -- --env staging';
  return [...opening(now, 'Deploy it to staging.'),
    n('item/started', { threadId: thread, turnId: TURN, startedAtMs: now - 5000, item: command(ITEM, CMD) }),
    n('thread/status/changed', { threadId: thread, status: { type: 'active', activeFlags: ['waitingOnApproval'] } }),
    { type: 'mcp-request', hostId: 'local', request: { id: 'demo-approval-1', method: 'item/commandExecution/requestApproval',
      params: { threadId: thread, turnId: TURN, itemId: ITEM, startedAtMs: now - 5000, approvalId: null, command: CMD, cwd: fake.CWD,
        commandActions: [{ type: 'unknown', command: CMD }], reason: 'The deploy script needs network access to reach the staging cluster.', kind: 'command' } } },
  ];
}

/* The command's item/started, as the page and the host both get it; there is no item/completed. */
function backgroundStart(now = Date.now()) {
  return n('item/started', { threadId: fake.THREAD, turnId: TURN, startedAtMs: now - 60000,
    item: command('call_demo_watch_1', 'npm run watch', { source: 'unifiedExecStartup' }) });
}
function background(now = Date.now()) {
  return [...opening(now, 'Start the watcher and leave it running.'), backgroundStart(now)];
}

module.exports = { approval, background, backgroundStart, TURN };
