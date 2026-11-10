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
 * do to the folder they replace, does not count as one that is left, and neither does a folder left over from a deletion
 * that failed.
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
/* The editor renames a folder it is deleting to <folder>.<random>.vsctmp first, and one it failed to delete stays until
   its next start under that name, which still starts like a copy. */
const isCopy = (name, own) => own.some((re) => re.test(name)) && !/\.vsctmp$/i.test(name);

/** The copies of extension `id` (or of any of a list of ids) in one extensions folder that its editor has not marked
    for deletion. */
function liveCopies(extensionsDir, id = [ID, ...FORMER_IDS]) {
  const own = (Array.isArray(id) ? id : [id]).map(folderOf);
  const marked = obsolete(extensionsDir);
  let names;
  try { names = fs.readdirSync(extensionsDir); } catch (_) { return []; }
  return names.filter((n) => isCopy(n, own) && marked[n] !== true).map((n) => path.join(extensionsDir, n));
}

/** The extensions folders whose Codex the uninstall hook of the copy in `extensionsDir` puts back. */
function restoreDirs(extensionsDir, { id = [ID, ...FORMER_IDS], home = os.homedir() } = {}) {
  const own = path.resolve(extensionsDir);
  return roots(own, home).filter((d) => d === own || !liveCopies(d, id).length);
}

/*
 * Whether no editor on this machine holds a copy of this extension any more, the one being uninstalled being marked for
 * deletion by then. Only then is the work plan plugin removed from Codex: every copy left goes on using it and its
 * plans. An editor whose extensions folder is not among EDITORS is not seen, and the plugin its copy uses is installed
 * again at that copy's next start.
 */
function lastCopy(extensionsDir, { id = [ID, ...FORMER_IDS], home = os.homedir() } = {}) {
  return roots(path.resolve(extensionsDir), home).every((d) => !liveCopies(d, id).length);
}

/*
 * Whether the editor is taking this copy away with no other copy of it staying in its folder: the editor marks the
 * folder in .obsolete before the extension host restarts, and an update marks the old folder the same way while the new
 * one stays unmarked. A reload or a window closing marks nothing.
 */
function beingUninstalled(extensionPath, id = [ID, ...FORMER_IDS]) {
  if (!extensionPath) return false;
  const dir = path.dirname(path.resolve(extensionPath));
  const mine = path.basename(extensionPath);
  if (obsolete(dir)[mine] !== true) return false;
  return !liveCopies(dir, id).some((d) => path.basename(d) !== mine);
}

/** The install stamp VS Code wrote into the manifest of the copy at extensionPath, or 0 when there is none. */
function installStamp(extensionPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8')).__metadata;
    return (meta && meta.installedTimestamp) || 0;
  } catch (_) { return 0; }
}

/*
 * Whether the same version was installed again over this copy after it was loaded. A version number cannot tell two
 * builds of one version apart, and between releases it stays the same, but VS Code stamps every install into the
 * manifest (__metadata.installedTimestamp). With no stamp on either side there is nothing to compare, and the answer is
 * no.
 */
function replacedSince(extensionPath, loadedStamp) {
  if (!extensionPath || !loadedStamp) return false;
  const now = installStamp(extensionPath);
  return !!now && now !== loadedStamp;
}

/*
 * Where the copy a window loaded stands: 'uninstalling', 'replaced', or '' for neither. Replaced is a window running a
 * build that is no longer the installed one: the same version installed again over it (replacedSince), or another
 * version installed beside it, which marks this folder for deletion and leaves the new one unmarked. Such a window
 * leaves every file the windows share to the ones running the installed build.
 */
function standing(extensionPath, id = [ID, ...FORMER_IDS], loadedStamp = 0) {
  if (!extensionPath) return '';
  const own = path.resolve(extensionPath);
  if (obsolete(path.dirname(own))[path.basename(own)] === true) return beingUninstalled(own, id) ? 'uninstalling' : 'replaced';
  return replacedSince(own, loadedStamp) ? 'replaced' : '';
}

/* The Codex installs in one extensions folder that its editor has not marked for deletion. */
function codexInstalls(extensionsDir) {
  const marked = obsolete(extensionsDir);
  let names;
  try { names = fs.readdirSync(extensionsDir); } catch (_) { return []; }
  return names.filter((n) => /^openai\.chatgpt-/.test(n) && marked[n] !== true).map((n) => path.join(extensionsDir, n));
}

/*
 * deactivate on an uninstall: VS Code runs the uninstall hook only when it deletes the folder, which in remote
 * development is the next start of the remote server, so the hook is started here in a process of its own, which
 * outlives this extension host and its five-second wait for deactivate. Codex in this editor's folder is put back first,
 * synchronously, since a host that exits takes nothing further. Every step of the hook is safe to run twice.
 */
function finishUninstall(extensionPath, id = [ID, ...FORMER_IDS], spawn = require('child_process').spawn) {
  if (!beingUninstalled(extensionPath, id)) return false;
  const targets = require('./adapters');
  for (const dir of codexInstalls(path.dirname(path.resolve(extensionPath)))) {
    for (const t of [...targets].reverse()) { try { t.restore(dir); } catch (_) { /* the hook tries again */ } }
  }
  const child = spawn(process.execPath, [path.join(extensionPath, 'uninstall.js')], {
    detached: true, stdio: 'ignore',
    // On a desktop install the host's binary is Electron, which runs a script as plain Node only when told to.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (child && typeof child.unref === 'function') child.unref();
  return true;
}

module.exports = { ID, FORMER_IDS, EDITORS, roots, obsolete, liveCopies, restoreDirs, lastCopy, beingUninstalled, codexInstalls,
  finishUninstall, installStamp, replacedSince, standing };
