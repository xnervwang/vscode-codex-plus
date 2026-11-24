// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The skill search of Codex Plus 1.3.0 and earlier left its index folder and one <session id>.routed per conversation
 * in the plan directory. These are deleted once per plan directory, and nothing else there is touched
 * (removeSkillSearchLeftovers in src/workplan.js, run by extension.js a minute after a trusted window starts).
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

const A = '01a1eeee-0000-7000-8000-0000000000d1';
const B = '01a1eeee-0000-7000-8000-0000000000d2';
const C = '01a1eeee-0000-7000-8000-0000000000d3';

/* Every file and folder under `dir`, with each file's text, so that anything changed or gone shows. */
function tree(dir) {
  const out = {};
  const walk = (sub) => {
    for (const e of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(path.join(dir, rel))}`;
      else if (e.isDirectory()) { out[`${rel}/`] = ''; walk(rel); }
      else out[rel] = fs.readFileSync(path.join(dir, rel), 'utf8');
    }
  };
  walk('');
  return out;
}

module.exports = async ({ eq, note, tmp, root }) => {
  const workplan = require('../../src/workplan');
  const put = (dir, rel, text = rel) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

  const dir = tmp('plans');
  const store = tmp('global-storage');
  const doneFile = path.join(store, 'cleared.json');
  for (const f of ['index.pickle', 'embeddings.pickle', 'vector.json', 'route.log', 'route.log.1', 'build.started', 'build.lock',
    'build.lock-ab12/held']) put(dir, `${workplan.SKILL_SEARCH_DIR}/${f}`);
  put(dir, `${A}.routed`, '{"format": 1}');
  put(dir, `${B}.routed`, '{"format": 1}');
  const kept = [`${A}.json`, `${A}.injected`, `${A}.compacted`, `${A}.tz`, `${B}.json`, 'config.json', 'closed/' + `${A}.json`,
    'shared/left-running.json', 'notes.routed', `${A}.routed.4242.tmp`, `${B}.routed.bak`, 'skill-route-old/index.pickle',
    `${C}.routed/inside`];
  for (const f of kept) put(dir, f);
  const before = tree(dir);
  const want = Object.fromEntries(Object.entries(before).filter(([k]) => !k.startsWith(`${workplan.SKILL_SEARCH_DIR}/`)
    && k !== `${A}.routed` && k !== `${B}.routed`));

  const first = workplan.removeSkillSearchLeftovers({ dir, doneFile });
  eq(first, { folder: true, files: 2, failed: '' }, 'the first call deletes the skill search\'s folder and both .routed files');
  eq(tree(dir), want, 'and every other file and folder in the plan directory is left as it was, a folder named like a .routed file and '
    + 'files that only start or end like one included');
  eq(JSON.parse(fs.readFileSync(doneFile, 'utf8')), [dir], 'the plan directory is recorded as cleared');

  put(dir, `${A}.routed`, 'written again');
  put(dir, `${workplan.SKILL_SEARCH_DIR}/index.pickle`, 'written again');
  eq(workplan.removeSkillSearchLeftovers({ dir, doneFile }), null, 'a second call on the same directory does nothing');
  eq([fs.existsSync(path.join(dir, `${A}.routed`)), fs.existsSync(path.join(dir, workplan.SKILL_SEARCH_DIR, 'index.pickle'))], [true, true],
    'and leaves even files of those names alone, so the deletion runs once');

  const other = tmp('other-home-plans');
  put(other, `${B}.routed`);
  put(other, `${B}.json`);
  eq([workplan.removeSkillSearchLeftovers({ dir: other, doneFile }), Object.keys(tree(other))], [{ folder: false, files: 1, failed: '' }, [`${B}.json`]],
    'another plan directory, as of another CODEX_HOME, is cleared once of its own');
  const missing = path.join(tmp('no-plans'), 'agent-work-plan-codex-extras');
  eq([workplan.removeSkillSearchLeftovers({ dir: missing, doneFile }), fs.existsSync(missing)], [{ folder: false, files: 0, failed: '' }, false],
    'a plan directory that does not exist has nothing to delete and is not created');
  eq(JSON.parse(fs.readFileSync(doneFile, 'utf8')), [dir, other, missing], 'and each is recorded once');

  /* The search never made a skill-route folder that is a link, so neither such a link nor its target is touched. */
  const linked = tmp('linked-plans');
  const target = tmp('link-target');
  put(target, 'keep.txt');
  let link = false;
  try { fs.symlinkSync(target, path.join(linked, workplan.SKILL_SEARCH_DIR), 'dir'); link = true; } catch (_) { /* no symlinks here */ }
  if (link) {
    workplan.removeSkillSearchLeftovers({ dir: linked, doneFile: path.join(tmp('gs-link'), 'cleared.json') });
    eq([fs.lstatSync(path.join(linked, workplan.SKILL_SEARCH_DIR)).isSymbolicLink(), tree(target)], [true, { 'keep.txt': 'keep.txt' }],
      'a link named like the search\'s folder is left, and so is the folder it points to');
  } else note('symbolic links cannot be made here: the case of a link named like the search\'s folder did not run');

  /* If a deletion fails, the directory is not recorded and the next start tries again. */
  if (process.platform !== 'win32' && !(process.getuid && process.getuid() === 0)) {
    const stuck = tmp('stuck-plans');
    const gs = path.join(tmp('gs-stuck'), 'cleared.json');
    put(stuck, `${A}.routed`);
    fs.chmodSync(stuck, 0o555);
    let r;
    try { r = workplan.removeSkillSearchLeftovers({ dir: stuck, doneFile: gs }); } finally { fs.chmodSync(stuck, 0o755); }
    eq([!!(r && r.failed), r && r.files, fs.existsSync(gs)], [true, 0, false], 'a .routed file that cannot be deleted is reported, and the directory is not recorded');
    eq([workplan.removeSkillSearchLeftovers({ dir: stuck, doneFile: gs }), fs.existsSync(path.join(stuck, `${A}.routed`))],
      [{ folder: false, files: 1, failed: '' }, false], 'so the next call deletes it');
  } else note('a read-only directory does not stop a deletion here: the case of a deletion that fails did not run');

  /* Through extension.js, the record goes in the extension's global storage and the log says what was deleted. */
  {
    const { vscode } = fake.create();
    fake.install(vscode);
    for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
    const home = tmp('codex-home');
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const ext = require(path.join(root, 'extension.js'));
      const plans = require(path.join(root, 'src', 'plugin-install.js')).planDir(home);
      put(plans, `${workplan.SKILL_SEARCH_DIR}/index.pickle`);
      put(plans, `${A}.routed`);
      put(plans, `${A}.json`);
      const gs = tmp('gs');
      const said = [];
      ext._removeSkillSearchLeftovers({ globalStorageUri: vscode.Uri.file(gs) }, (m) => said.push(m));
      eq([Object.keys(tree(plans)), JSON.parse(fs.readFileSync(path.join(gs, 'skill-search-leftovers-cleared.json'), 'utf8'))], [[`${A}.json`], [plans]],
        'the extension clears the plan directory of the Codex home it uses and records it in its global storage');
      eq(said, [`deleted what the skill search left in the plan directory: ${workplan.SKILL_SEARCH_DIR}/ and 1 .routed file(s)`], 'and logs what it deleted');
      ext._removeSkillSearchLeftovers({ globalStorageUri: vscode.Uri.file(gs) }, (m) => said.push(m));
      eq(said.length, 1, 'a second run says nothing');
      const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
      eq(/later\(\(\) => \{[^]*?removeSkillSearchLeftovers\(context, say\);[^]*?\}, 60000\);/.test(source), true,
        'activation runs it with the plan cleanup a minute after a trusted window starts');
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved;
    }
  }
};
