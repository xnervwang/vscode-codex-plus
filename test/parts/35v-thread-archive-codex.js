// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Checks what Codex's thread/archive and thread/unarchive do, which the session list's Archive, Unarchive and Archived
 * sessions rely on.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

module.exports = async ({ eq, note, root }) => {
  const roots = [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')];
  const dir = roots.flatMap((r) => { try { return fs.readdirSync(r).filter((n) => /^openai\.chatgpt-/.test(n)).map((n) => path.join(r, n)); } catch (_) { return []; } }).sort().pop();
  const binary = dir ? require(path.join(root, 'src', 'appserver')).codexBinary(dir) : '';
  if (!binary) { note('no Codex is installed here, so what its thread/archive does was not checked'); return; }
  const why = require(path.join(root, 'test', 'render', 'lib', 'app-server')).offlineProblem();
  if (why) { note(`Codex's app-server cannot be run offline here (${why}), so what its thread/archive does was not checked`); return; }
  const r = spawnSync(process.execPath, [path.join(root, 'test', 'thread-archive-probe.js'), binary], { encoding: 'utf8', timeout: 120000 });
  let out = null;
  try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) { out = null; }
  if (!out) { note(`the probe could not run (${((r.error && r.error.message) || r.stderr || `exit ${r.status}`).trim().slice(0, 200)}), so thread/archive was not checked`); return; }
  if (out.error) { eq(out.error, '', 'the probe ran to the end'); return; }

  /*
   * A is a conversation; P one with a sub-agent S; L is loaded on the probe's connection and T has a turn running.
   *
   * When a loaded thread is archived, Codex sends thread/status/changed notLoaded once or twice, depending on whether
   * the thread's own listener or the archive request removes it first. Archive, Unarchive and Delete in this extension
   * wait only for the answer.
   */
  const sorted = (list) => [...new Set(list)].sort();
  const a = out.archive;
  eq([a.answer, a.heard, a.disk.where.A, a.disk.rows.A.archived, a.disk.rows.A.inArchive], [{}, ['thread/archived A'], 'archived_sessions', 1, true],
    'thread/archive answers {}, reports it, and moves the rollout to archived_sessions/, where the state database then points');
  eq(a.disk.rows.A.archivedAt >= Math.floor(a.sentS) - 1 && a.disk.rows.A.archivedAt <= Math.ceil(a.sentS) + 2, true,
    'archived_at is the time of the request, in seconds');
  eq(out.again.answer, { error: 'no rollout found for thread id <id>' }, 'asked again, Codex says it has no rollout for it');
  eq([sorted(out.parent.heard), out.parent.disk.where.S, out.parent.disk.rows.S.archived], [['thread/archived P', 'thread/archived S'], 'archived_sessions', 1],
    'archiving a conversation archives its sub-agent too');
  eq(/is archived/.test(String((out.resume.answer || {}).error || '')), true, 'an archived conversation cannot be resumed');
  const l = out.loaded;
  eq([out.loadedBefore, l.answer, l.loadedAfter, l.disk.where.L, l.disk.rows.L.archived, l.disk.rows.L.inArchive, sorted(l.heard)],
    [['L', 'T'], {}, ['T'], 'archived_sessions', 1, true, ['thread/archived L', 'thread/status/changed L notLoaded']],
    'one loaded on the connection is unloaded and archived, not refused');
  eq([out.runningBefore, sorted(out.running.heard.filter((h) => /^(turn\/completed|thread\/archived)/.test(h))), out.running.disk.where.T],
    [[], ['thread/archived T', 'turn/completed T interrupted'], 'archived_sessions'],
    'one with a turn running has that turn stopped, which it was not before the request, and is archived; this is why Archive leaves a running one alone');
  const u = out.unarchive;
  eq([u.answer, sorted(u.heard), u.disk.where.P, u.disk.where.S, u.disk.rows.P.archived, u.disk.rows.P.archivedAt],
    [{ thread: 'P' }, ['thread/unarchived P', 'thread/unarchived S'], 'sessions/<day>', 'sessions/<day>', 0, null],
    'thread/unarchive puts the rollout and its sub-agent\'s back under sessions/ by day and clears archived_at');
  eq(out.unarchiveAgain.answer, { error: 'no archived rollout found for thread id <id>' }, 'asked again, Codex says it has no archived rollout for it');
  eq([out.deleteArchived.heard, 'L' in out.deleteArchived.disk.where, 'L' in out.deleteArchived.disk.rows], [['thread/deleted L'], false, false],
    'an archived conversation is deleted by thread/delete like any other');
};
