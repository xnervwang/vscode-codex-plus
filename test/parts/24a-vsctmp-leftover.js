// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A folder VS Code failed to delete. It renames a folder to <folder>.<random>.vsctmp before deleting it, and one whose
 * deletion failed (a file held open, which happens most on Windows) stays under that name until its next start. The name
 * still starts like a copy of this extension, but nothing in it runs.
 */
const fs = require('fs');
const path = require('path');

const ID = 'xnervwang.codex-plus';

module.exports = async ({ eq, tmp }) => {
  const plan = require('../../src/uninstall-plan');
  const home = tmp('vsctmp-home');
  const ext = path.join(home, '.vscode-server', 'extensions');
  const self = path.join(ext, `${ID}-1.0.1`);
  fs.mkdirSync(self, { recursive: true });
  fs.mkdirSync(path.join(ext, `${ID}-1.0.0.1a2b3c4d.vsctmp`));
  fs.mkdirSync(path.join(ext, 'xnervwang.codex-extras-0.9.0.5e6f7a8b.vsctmp'));
  fs.writeFileSync(path.join(ext, '.obsolete'), JSON.stringify({ [`${ID}-1.0.1`]: true }));
  const other = path.join(home, '.vscode', 'extensions');
  fs.mkdirSync(path.join(other, `${ID}-1.0.1.9f8e7d6c.VSCTMP`), { recursive: true });

  const ids = [ID, ...plan.FORMER_IDS];
  eq([plan.liveCopies(ext, ids), plan.liveCopies(other, ids)], [[], []],
    'a leftover renamed to .vsctmp, under this id or the former one and in either case, is not a copy');
  eq(plan.beingUninstalled(self, ids), true, 'so a copy marked for deletion beside such a leftover is being uninstalled');
  eq(plan.lastCopy(ext, { id: ids, home }), true, 'and with only leftovers in the other editors, it is the last copy');
  eq(plan.restoreDirs(ext, { id: ids, home }).includes(path.resolve(other)), true,
    'an editor whose folder holds only a leftover has its Codex put back too');
  eq(plan.finishUninstall(self, ids, () => ({ unref() {} })), true, 'and deactivate hands the uninstall on');

  fs.mkdirSync(path.join(other, `${ID}-1.0.1`));
  eq([plan.lastCopy(ext, { id: ids, home }), plan.restoreDirs(ext, { id: ids, home }).includes(path.resolve(other))], [false, false],
    'while a real copy beside the leftover still counts as one');
};
