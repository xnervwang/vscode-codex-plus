// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Whether a conversation's starting directory is in this window's workspace, comparing real paths.
 *
 * Same shape as folderTest() in Agent Plus's src/folders.js, which cannot be required from here because the two
 * are separate extensions. Two differences matter for Codex's threads:
 *
 *   - a directory that no longer exists still resolves, through the nearest ancestor that does, so a conversation
 *     started in a folder since deleted is still placed in the workspace that held it
 *   - names are folded on darwin as well as win32
 *
 * The paths have to be resolved because VS Code reports this machine's workspace folder as /home/<user>/... while
 * Codex records the thread's cwd as /local/home/<user>/..., /home/<user> being a symbolic link. Comparing the strings
 * puts every conversation outside the workspace and leaves the session list empty.
 */
const fs = require('fs');
const path = require('path');

/* How far up the tree to look for an ancestor that exists. Deeper than any real checkout, and bounded so a path that
   never resolves cannot spin. */
const MAX_WALK_UP = 64;

const caseOf = process.platform === 'win32' || process.platform === 'darwin' ? (s) => s.toLowerCase() : (s) => s;

/** `p` with every symbolic link resolved; the nearest existing ancestor's real path with the rest put back, if it is gone. */
function realPath(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch (_) { /* gone, or not readable */ }
  let head = abs;
  const tail = [];
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
    try { return path.join(fs.realpathSync.native(head), ...tail); } catch (_) { /* keep going up */ }
  }
  return abs;
}

/*
 * A test for "is this directory one of `folders` or under one". With a `memo`, each path is resolved once: the test is
 * asked about the folder of every conversation on every pass, and resolving one is a system call per level of it. How
 * long a resolved answer stays good for is up to whoever passes the memo in.
 */
function folderTest(folders, memo) {
  const resolve = memo
    ? (p) => { if (!memo.has(p)) memo.set(p, caseOf(realPath(p))); return memo.get(p); }
    : (p) => caseOf(realPath(p));
  const roots = (folders || []).filter(Boolean).map(resolve);
  return (dir) => {
    if (!dir || !roots.length) return false;
    const cwd = resolve(dir);
    return roots.some((root) => {
      const rel = path.relative(root, cwd);
      return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
    });
  };
}

module.exports = { folderTest, realPath, MAX_WALK_UP };
