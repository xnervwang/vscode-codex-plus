// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The folder the plans are copied to before the plugin is removed sits in the Codex home under a name nobody chose,
 * so it carries a note saying what it is and where the files go to be used again.
 */
const fs = require('fs');
const path = require('path');

const PLAN = '01a1ffff-0000-7000-8000-000000000006';

module.exports = async ({ eq, tmp }) => {
  const install = require('../../src/plugin-install');
  const home = tmp('saved-plans-home');
  fs.mkdirSync(install.planDir(home), { recursive: true });
  fs.writeFileSync(path.join(install.planDir(home), `${PLAN}.json`), JSON.stringify({ nodes: [] }));
  fs.writeFileSync(path.join(install.planDir(home), 'config.json'), '{}');
  const kept = install.savePlans(home, 'stamp');
  eq(fs.readdirSync(kept).sort(), [`${PLAN}.json`, 'WHAT-THIS-IS.txt'].sort(), 'the plans are copied out with a note beside them');
  const note = fs.readFileSync(path.join(kept, 'WHAT-THIS-IS.txt'), 'utf8');
  eq([/work plans/i.test(note), note.includes(install.planDir(home))], [true, true],
    'which says what they are and names the folder to copy them back into');
  eq(install.savePlans(tmp('no-plans-home'), 'stamp'), '', 'with no plans there is no folder, and so no note');
};
