// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which extensions folders the uninstall hook (uninstall.js) puts Codex back in.
 *
 * The folder this copy was installed in, always: this copy patched the Codex there. Each other editor on the machine
 * keeps its extensions in a folder of its own. One that still holds a copy of this extension leaves its Codex to that
 * copy, which patched it and patches it again at its next start. One that holds none has nothing left that could take
 * the patch out, so it is put back here.
 *
 * A copy its editor has marked for deletion in that folder's .obsolete file, which is what an uninstall and an update
 * do to the folder they replace, does not count as one that is left.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = 'xnervwang.codex-plus';
/* The id this extension had before it was renamed: a copy under it still patches its editor's Codex. */
const FORMER_IDS = ['xnervwang.codex-extras'];
const EDITORS = ['.vscode', '.vscode-server', '.vscode-insiders', '.vscode-server-insiders', '.cursor'];

/** The extensions folder of every editor this looks in, the given one first. */
function roots(extensionsDir, home = os.homedir()) {
  return [...new Set([extensionsDir, ...EDITORS.map((d) => path.join(home, d, 'extensions'))].map((d) => path.resolve(d)))];
}

/** The folders an editor has marked for deletion, as it records them: folder name -> true. */
function obsolete(extensionsDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(extensionsDir, '.obsolete'), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) { return {}; }
}

/* A copy's folder is <id>-<version>, with the platform after the version for a platform build; the digit after the
   dash keeps an extension whose name merely starts with this one's from being taken for a copy of it. */
const folderOf = (id) => new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d`, 'i');

/** The copies of extension `id` (or of any of a list of ids) in one extensions folder that its editor has not marked
    for deletion. */
function liveCopies(extensionsDir, id = [ID, ...FORMER_IDS]) {
  const own = (Array.isArray(id) ? id : [id]).map(folderOf);
  const marked = obsolete(extensionsDir);
  let names;
  try { names = fs.readdirSync(extensionsDir); } catch (_) { return []; }
  return names.filter((n) => own.some((re) => re.test(n)) && marked[n] !== true).map((n) => path.join(extensionsDir, n));
}

/** The extensions folders whose Codex the uninstall hook of the copy in `extensionsDir` puts back. */
function restoreDirs(extensionsDir, { id = [ID, ...FORMER_IDS], home = os.homedir() } = {}) {
  const own = path.resolve(extensionsDir);
  return roots(own, home).filter((d) => d === own || !liveCopies(d, id).length);
}

module.exports = { ID, FORMER_IDS, EDITORS, roots, obsolete, liveCopies, restoreDirs };
