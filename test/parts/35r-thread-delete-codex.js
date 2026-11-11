// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Checks what Codex's thread/delete removes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

module.exports = async ({ eq, note, root }) => {
  const roots = [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')];
  const dir = roots.flatMap((r) => { try { return fs.readdirSync(r).filter((n) => /^openai\.chatgpt-/.test(n)).map((n) => path.join(r, n)); } catch (_) { return []; } }).sort().pop();
  const binary = dir ? require(path.join(root, 'src', 'appserver')).codexBinary(dir) : '';
  if (!binary) { note('no Codex is installed here, so what its thread/delete removes was not checked'); return; }
  const why = require(path.join(root, 'test', 'render', 'lib', 'app-server')).offlineProblem();
  if (why) { note(`Codex's app-server cannot be run offline here (${why}), so what its thread/delete removes was not checked`); return; }
  const r = spawnSync(process.execPath, [path.join(root, 'test', 'thread-delete-probe.js'), binary], { encoding: 'utf8', timeout: 90000 });
  let out = null;
  try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) { out = null; }
  if (!out) { note(`the probe could not run (${((r.error && r.error.message) || r.stderr || `exit ${r.status}`).trim().slice(0, 200)}), so thread/delete was not checked`); return; }
  if (out.error) { eq(out.error, '', 'the probe ran to the end'); return; }

  /* P is a conversation, S a sub-agent it spawned and G one S spawned; U and L are two others, L loaded on the same
     connection. P has a goal, and every one of them a line in session_index.jsonl. */
  eq(out.before, { rollouts: ['G', 'L', 'P', 'S', 'U'],
    tables: { 'goals.thread_goals': ['P'], 'state.thread_spawn_edges': ['P', 'S'], 'state.threads': ['G', 'L', 'P', 'S', 'U'] },
    index: ['G', 'L', 'P', 'S', 'U'] }, 'before: five rollouts, five rows in the state database, two spawn edges, one goal, five titles');
  eq([out.parent.result, out.parent.deleted], [{}, ['G', 'S', 'P']],
    'thread/delete on the conversation answers {} and reports it deleted, after the sub-agents below it, the deepest first');
  eq(out.parent.after, { rollouts: ['L', 'U'], tables: { 'state.threads': ['L', 'U'] }, index: ['L', 'U'] },
    'its rollout, its row in the state database, its spawn edges, its goal and its title are gone, and so is all of that of every sub-agent below it');
  eq([out.again, out.missing], ['no rollout found for thread id <id>', { code: -32600, message: 'no rollout found for thread id <id>' }],
    'asked again, or for a conversation it never had, Codex refuses with "no rollout found"');
  eq([out.loaded.result, out.loaded.heard, out.loaded.after.rollouts], [{}, ['thread/status/changed notLoaded', 'thread/deleted'], ['U']],
    'a conversation the app-server has loaded is unloaded and deleted, not refused, which is why Delete checks for open ones itself');
};
