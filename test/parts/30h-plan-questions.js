// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A question the conversation's work plan put to the user after the user's last message makes the conversation wait
 * for the user: the red dot on its tab and on its row in the session list, as Agent Plus's Conversations panel counts
 * it (its src/conversations.js activityOf). A question from before that message, or with no last message to compare
 * with, leaves the activity as it was.
 *
 * The worker reads the questions with the rest of its snapshot, and a plan rewritten in place moves its stamp, as the
 * plugin's hooks and this suite's window test both write a plan without touching its folder.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

module.exports = async ({ eq, tmp }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const { createCodexSource, conversationOf } = require('../../src/codex-source');
  const { ops } = require('../../src/codex-worker');
  const files = require('../../src/codex-files');
  const install = require('../../src/plugin-install');
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const th = { id: '01a2f0f0-0000-7000-8000-000000000301', title: 'Pick the cache size', cwd: '/w', updatedMs: now - 1000 };
  const none = { unread: new Set(), openHere: new Set(), now };
  const lastUser = now - 600e3;
  const ended = { working: false, startedMs: lastUser, endedMs: now - 60e3, lastEndedMs: now - 60e3, lastActivityMs: now - 60e3, lastUserMs: lastUser };
  const running = { working: true, startedMs: lastUser, lastActivityMs: now - 1000, lastUserMs: lastUser };
  /* `state` is the older protocol's, which keeps `prompt` for a permission prompt. */
  const pick = (c) => [c.activity, c.state];

  /* ── the rule ── */
  eq(pick(conversationOf(th, { ...none, state: ended, planAsked: lastUser + 30e3 })), ['waiting', 'idle'],
    'a turn over whose plan asked the user something after the user last wrote is waiting');
  eq(pick(conversationOf(th, { ...none, state: ended, planAsked: lastUser - 3 * 86400e3 })), ['stopped', 'idle'],
    'one asked days before the user last wrote is not');
  eq(pick(conversationOf(th, { ...none, state: running, planAsked: lastUser + 30e3 })), ['waiting', 'working'],
    'a new question outranks a turn still running, as in Agent Plus');
  eq(pick(conversationOf(th, { ...none, state: ended, left: ['command'], planAsked: lastUser + 30e3 })), ['waiting', 'working'],
    'and background work still running');
  eq(pick(conversationOf(th, { ...none, state: { ...ended, lastUserMs: 0 }, planAsked: now - 1000 })), ['stopped', 'idle'],
    'with no last user message known, a question is not taken to be new');
  eq(pick(conversationOf(th, { ...none, state: ended, unread: new Set([th.id]), planAsked: lastUser + 30e3 })), ['waiting', 'unread'],
    'and the unread reply stays beside it');
  eq(conversationOf(th, { ...none, state: ended, unread: new Set([th.id]), planAsked: lastUser + 30e3 }).unseen, true,
    'unseen is still reported with it');

  /* ── the worker's snapshot ── */
  const home = tmp('plan-questions-home');
  const [one, two] = fixture.codexHome(home, [{ title: 'With a question', turns: [{}] }, { title: 'Without one', turns: [{}] }]);
  const plans = install.planDir(home);
  fs.mkdirSync(plans, { recursive: true });
  const asked = now - 5000;
  const planOf = (q) => JSON.stringify({ nodes: [{ title: 'Choose', state: 'doing', since: iso(now - 60e3), children: [
    Object.assign({ title: 'Cache size', state: 'waiting', waitingOn: 'user', question: '64 or 128 MB?' }, q)] }] });
  fs.writeFileSync(path.join(plans, `${one.id}.json`), planOf({ asked: iso(asked) }));
  fs.writeFileSync(path.join(plans, `${two.id}.json`), planOf({ waitingOn: 'agent', asked: iso(asked) }));
  try {
    const first = ops.snapshot({ home });
    const asks = new Map(first.asks || []);
    eq([asks.get(one.id), asks.has(two.id)], [Date.parse(iso(asked)), false],
      'the snapshot carries when each plan last asked the user something, and nothing for a row waiting on the agent');
    const later = now - 1000;
    const before = fs.statSync(plans).mtimeMs;
    const file = path.join(plans, `${one.id}.json`);
    fs.writeFileSync(file, planOf({ asked: iso(later) }));
    /* A write in the same clock tick as the first can leave the file's time as it was. */
    fs.utimesSync(file, new Date(now + 5000), new Date(now + 5000));
    eq(fs.statSync(plans).mtimeMs, before, 'writing a plan in place leaves its folder\'s time alone');
    const next = ops.snapshot({ home, previous: first.stamp });
    eq([next.same, new Map(next.asks || []).get(one.id)], [false, Date.parse(iso(later))],
      'a plan rewritten in place, its folder\'s time unchanged, moves the stamp and is read again');
  } finally { files.setCodexHome(''); }

  /* ── through the reader and the source ── */
  const { CodexReader } = require('../../src/codex-reader');
  const reader = new CodexReader({ inline: true });
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  files.setCodexHome(home);
  const source = createCodexSource(vscode, { reader });
  try {
    control.setTabs([control.fileTab('/w/notes.txt')], 0);
    source._tabsChanged();
    await reader.refresh({ home, force: true });
    const list = new Map((await source.listConversations()).map((c) => [c.sessionId, c]));
    eq([reader.planAsked(one.id) > 0, list.get(one.id) && list.get(one.id).activity, list.get(two.id) && list.get(two.id).activity],
      [true, 'waiting', 'stopped'], 'listConversations reports the conversation whose plan asked the user after the user last wrote as waiting');
    const st = source.threadState(one.id);
    eq(st && st.activity, 'waiting', 'and threadState, which the Agent map and the sub-agent rows read, the same');
  } finally {
    source.dispose();
    reader.dispose();
    process.env.CODEX_HOME = prev;
    files.setCodexHome('');
  }
};
