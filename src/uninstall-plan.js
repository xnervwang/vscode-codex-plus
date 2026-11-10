// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which extensions folders the uninstall hook (uninstall.js) puts Codex back in, read from the folders themselves
 * (src/installed-copies.js, shared with Claude Code Plus) for this extension's ids.
 *
 * The folder this copy was installed in, always: this copy patched the Codex there. Each other editor on the machine
 * keeps its extensions in a folder of its own. One that still holds a copy of this extension leaves its Codex to that
 * copy, which patched it and patches it again at its next start. One that holds none has nothing left that could take
 * the patch out, so it is put back here.
 */
const path = require('path');
const copies = require('./installed-copies');

const ID = 'xnervwang.codex-plus';
/* The id this extension had before it was renamed: a copy under it still patches its editor's Codex. */
const FORMER_IDS = ['xnervwang.codex-extras'];
const IDS = [ID, ...FORMER_IDS];

const liveCopies = (extensionsDir, id = IDS) => copies.liveCopies(extensionsDir, id);
/** The extensions folders whose Codex the uninstall hook of the copy in `extensionsDir` puts back. */
const restoreDirs = (extensionsDir, { id = IDS, home } = {}) => copies.plan(extensionsDir, id, { home }).restore;
/*
 * Whether no editor on this machine holds a copy of this extension any more, the one being uninstalled being marked for
 * deletion by then. Only then is the work plan plugin removed from Codex: every copy left goes on using it and its
 * plans. An editor whose extensions folder is not among EDITORS is not seen, and the plugin its copy uses is installed
 * again at that copy's next start.
 */
const lastCopy = (extensionsDir, { id = IDS, home } = {}) => copies.plan(extensionsDir, id, { home }).lastCopy;
const beingUninstalled = (extensionPath, id = IDS) => copies.beingUninstalled(extensionPath, id);
const standing = (extensionPath, id = IDS, loadedStamp = 0) => copies.standing(extensionPath, id, loadedStamp);
/* The Codex installs in one extensions folder that its editor has not marked for deletion. */
const codexInstalls = (extensionsDir) => copies.unmarkedInstalls(extensionsDir, 'openai.chatgpt-');

/*
 * deactivate on an uninstall: Codex in this editor's folder is put back first, synchronously, since a host that exits
 * takes nothing further; then the uninstall hook is started in a process of its own (copies.detachHook).
 */
function finishUninstall(extensionPath, id = IDS, spawn = require('child_process').spawn) {
  if (!beingUninstalled(extensionPath, id)) return false;
  const targets = require('./adapters');
  for (const dir of codexInstalls(path.dirname(path.resolve(extensionPath)))) {
    for (const t of [...targets].reverse()) { try { t.restore(dir); } catch (_) { /* the hook tries again */ } }
  }
  copies.detachHook(extensionPath, spawn);
  return true;
}

module.exports = { ID, FORMER_IDS, EDITORS: copies.EDITORS, roots: copies.roots, obsolete: copies.obsolete, liveCopies,
  restoreDirs, lastCopy, beingUninstalled, codexInstalls, finishUninstall, installStamp: copies.installStamp,
  replacedSince: copies.replacedSince, standing };
