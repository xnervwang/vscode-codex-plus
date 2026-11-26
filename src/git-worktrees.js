// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The linked git worktrees of the repositories the window's folders are in, read from git's own files: a worktree's
 * `.git` is a file naming its folder under the repository's `.git/worktrees/`, and that folder's `gitdir` file names
 * the worktree's `.git` back. A conversation started in one of them belongs to this project, and Agent Plus's session
 * list draws the worktree's name on its row. No git program is run.
 */
const fs = require('fs');
const path = require('path');
const { realPath, MAX_WALK_UP } = require('./folders');

/* Worktrees read from one repository at most, against a repository with a great many. */
const MAX_TREES = 200;

const readText = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch (_) { return null; } };

/* The repository's shared .git folder for a worktree whose top is `top`, or null. */
function commonDirOf(top) {
  const dotGit = path.join(top, '.git');
  let st;
  try { st = fs.statSync(dotGit); } catch (_) { return null; }
  if (st.isDirectory()) return dotGit;
  const m = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) || '');
  if (!m) return null;
  const gitDir = path.resolve(top, m[1].trim());
  const common = readText(path.join(gitDir, 'commondir'));
  return common ? path.resolve(gitDir, common) : gitDir;
}

/* The top of the worktree holding `folder`: the nearest folder at or above it with a .git, or ''. */
function topOf(folder) {
  let dir = path.resolve(folder);
  for (let i = 0; i < MAX_WALK_UP; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

/*
 * The worktrees of the repositories `folders` are in, other than the ones holding them, as [{ path, name }]: the
 * repository's main worktree when a folder is in a linked one, and every linked worktree whose folder is still there.
 * `name` is the worktree folder's name. Paths are real paths.
 */
function worktreesOf(folders) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    const real = realPath(p);
    if (seen.has(real) || !fs.existsSync(real)) return;
    seen.add(real);
    out.push({ path: real, name: path.basename(real) });
  };
  const tops = (folders || []).filter(Boolean).map(topOf).filter(Boolean).map(realPath);
  for (const t of tops) seen.add(t);
  const done = new Set();
  for (const top of tops) {
    const common = commonDirOf(top);
    if (!common || done.has(common)) continue;
    done.add(common);
    if (path.basename(common) === '.git') add(path.dirname(common));
    let names = [];
    try { names = fs.readdirSync(path.join(common, 'worktrees')).slice(0, MAX_TREES); } catch (_) { names = []; }
    for (const n of names) {
      const gitFile = readText(path.join(common, 'worktrees', n, 'gitdir'));
      if (gitFile) add(path.dirname(path.resolve(common, 'worktrees', n, gitFile)));
    }
  }
  return out;
}

module.exports = { worktreesOf, commonDirOf, topOf };
