// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Builds the list for this extension's own Conversations view from a source's conversations, by the rules the shared
 * host applies (work plan host protocol, "Conversations and plans"): a running conversation is listed when it was
 * started in one of this window's workspace folders or a folder under one; a stopped one only while its plan still has
 * open rows and was written in the last week. A conversation's plan adds its `doing` rows and the questions on rows
 * waiting on the user, and any question makes its state `needs`, above everything but `prompt`.
 */
const fs = require('fs');
const path = require('path');
const { OPEN_STATES } = require('./workplan');

const CLOSED_DAYS = 7;
const RANK = { prompt: 0, needs: 1, working: 2, unread: 3, idle: 4 };

function planQuestions(nodes, prefix = '', out = []) {
  (nodes || []).forEach((n, i) => {
    const num = (prefix ? prefix + '.' : '') + (i + 1);
    if (n.waitingOn === 'user' && (n.state === 'waiting' || n.state === 'discussing')) {
      out.push({ row: num, title: n.title, question: n.question || n.title, since: n.asked || n.since || 0, state: n.state,
        note: n.note || '', detail: n.detail || '' });
    }
    planQuestions(n.children, num, out);
  });
  return out;
}

function doingRows(nodes, prefix = '', out = []) {
  (nodes || []).forEach((n, i) => {
    const num = (prefix ? prefix + '.' : '') + (i + 1);
    if (n.state === 'doing') out.push({ row: num, title: n.title, since: n.since || 0 });
    doingRows(n.children, num, out);
  });
  return out;
}

function openCount(nodes) {
  return (nodes || []).reduce((n, x) => n + (OPEN_STATES.includes(x.state) ? 1 : 0) + openCount(x.children), 0);
}

/* So that /home/x and /local/home/x match when one is a symbolic link to the other; case folds where the file system
   does. A folder that no longer exists, such as a deleted subfolder a stopped conversation ran in, is resolved through
   its nearest existing parent. */
function realPath(p) {
  let head = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), ...rest); } catch (_) { /* climb */ }
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    rest.unshift(path.basename(head));
    head = up;
  }
}
const caseOf = process.platform === 'win32' || process.platform === 'darwin' ? (s) => s.toLowerCase() : (s) => s;

function inFolders(cwd, folders) {
  if (!cwd) return false;
  if (!folders.length) return true;
  const c = caseOf(realPath(cwd));
  return folders.some((folder) => {
    const f = caseOf(realPath(folder));
    return c === f || c.startsWith(f.endsWith(path.sep) ? f : f + path.sep);
  });
}

/*
 * The conversations to show, sorted: what most needs the user first, then the most recently active. `readPlan(id)` is
 * the plan reader; `planFile(id)` its path, whose modification time decides whether a stopped conversation is recent.
 */
function build(list, { folders = [], readPlan, planFile = () => '', now = Date.now() }) {
  const out = [];
  for (const c of list || []) {
    if (!inFolders(c.cwd, folders)) continue;
    const plan = c.hasPlan ? readPlan(c.sessionId) : null;
    const nodes = plan && !plan.error ? plan.nodes : [];
    const open = openCount(nodes);
    if (!c.running) {
      if (!open) continue;
      let mtime = 0;
      try { mtime = fs.statSync(planFile(c.sessionId)).mtimeMs; } catch (_) { mtime = 0; }
      if (now - mtime > CLOSED_DAYS * 86400e3) continue;
    }
    const questions = planQuestions(nodes);
    // A state this build does not know is shown as idle (work plan host protocol, "Conversations and plans").
    let state = c.running && RANK[c.state] !== undefined && c.state !== 'needs' ? c.state : 'idle';
    if (questions.length && state !== 'prompt') state = 'needs';
    out.push({ ...c, state, questions, doing: doingRows(nodes), open, hasPlan: !!(plan && !plan.error),
      title: c.title || (plan && plan.title) || c.sessionId });
  }
  return out.sort((a, b) => (Number(b.running) - Number(a.running)) || (RANK[a.state] - RANK[b.state]) || (b.lastActiveAt - a.lastActiveAt));
}

module.exports = { build, planQuestions, doingRows, openCount, inFolders, RANK, CLOSED_DAYS };
