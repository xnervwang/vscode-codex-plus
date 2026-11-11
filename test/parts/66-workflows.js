// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The CI workflows: that they are there, what starts each of them, and that the daily one against the Codex being
 * shipped cannot pass while the patch no longer fits.
 *
 * That last part is checked by running the step's own shell with a `node` of this file's making, once for each exit
 * code against-latest.js has. A step that swallows a failure reads exactly like a step that keeps passing, and a
 * scheduled check is the kind nobody looks at until it matters, so the property is worth a check of its own rather
 * than a careful reading of the YAML.
 *
 * The YAML is read by locating a `run: |` and taking the indented lines under it, which is enough for files this
 * repository writes and is not a YAML parser; a workflow these checks cannot find anything in says so.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = path.join('.github', 'workflows');

/** The block scalar under the last `run: |` in `text`, dedented. */
function runScript(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.map((l, i) => (/^\s*run:\s*\|\s*$/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  if (at === undefined) return '';
  const indent = (lines[at].match(/^\s*/) || [''])[0].length;
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { out.push(''); continue; }
    const own = (lines[i].match(/^\s*/) || [''])[0].length;
    if (own <= indent) break;
    out.push(lines[i].slice(indent + 2));
  }
  return out.join('\n');
}

module.exports = ({ ok, bad, eq, tmp, root }) => {
  const read = (name) => {
    const file = path.join(root, DIR, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  const check = read('check.yml');
  const latest = read('against-latest.yml');
  eq([!!check, !!latest], [true, true], `both workflows are in ${DIR}`);
  if (!check || !latest) return;

  /* ── the one on every push ── */
  eq([/^on:/m.test(check), /^\s+push:/m.test(check), /^\s+pull_request:/m.test(check)], [true, true, true],
    'the suite runs on a push and on a pull request');
  eq(/node test\/check\.js/.test(check), true, 'and what it runs is the suite itself');
  /* Both Nodes, because node:sqlite is behind a flag in one of them and not in the other, and check.js re-execs
     itself with the flag only when it has to - so one version alone never exercises that. */
  eq(/node:\s*\['22',\s*'24'\]/.test(check), true, 'on the two Node versions the extension is meant to read Codex\'s database under');
  /* Agent Plus beside this repository, where test/parts/45-core.js looks for it, so the checks of the two together run on
     a runner too; and the suite run from this repository's own folder, which is no longer the workspace's root. */
  eq([/repository:\s*xnervwang\/vscode-agent-plus\s*\n\s*path:\s*vscode-agent-plus\b/.test(check),
    /^\s+path:\s*vscode-codex-plus\s*$/m.test(check), /working-directory:\s*vscode-codex-plus\b/.test(check)], [true, true, true],
  'Agent Plus is checked out beside this repository, as ../vscode-agent-plus, and the suite runs in this one');
  eq(/^\s+push:\s*\n\s+branches:\s*\[main\]/m.test(check), true, 'a push runs it on main only');
  const daily = /cron:\s*'([^']+)'/.exec(check);
  eq(!!daily && daily[1].split(/\s+/).slice(2).join(' ') === '* * *' && daily[1].split(/\s+/)[0] !== '0', true,
    'and it runs once a day, not on the hour, so a change to Agent Plus\'s main that breaks this one shows within a day');
  /* ── the one in a real VS Code window, on three platforms ── */
  const ui = read('vscode.yml');
  eq(!!ui, true, 'the workflow that runs the extension in a real VS Code window is there too');
  if (ui) {
    eq([/^\s+push:\s*\n(\s*#.*\n)*\s+branches:\s*\[main,\s*'ci\/\*\*'\]/m.test(ui), /^\s+pull_request:/m.test(ui), /workflow_dispatch:/.test(ui)], [true, true, true],
      'it runs on a push to main or to a ci/ branch, on a pull request, and by hand');
    const cron = (text) => ((/cron:\s*'([^']+)'/.exec(text) || [])[1] || '').trim().split(/\s+/);
    const [minute, hour, ...days] = cron(ui);
    const others = [check, latest].map((t) => cron(t).slice(0, 2).join(' '));
    eq(days.join(' ') === '* * *' && /^\d+$/.test(minute) && !['0', '30'].includes(minute) && !others.includes(`${minute} ${hour}`), true,
      'and once a day, neither on the hour nor on the half hour, and not at the time of the other two');
    eq(/os:\s*\[ubuntu-latest,\s*macos-latest,\s*windows-latest\]/.test(ui), true, 'on Linux, macOS and Windows');
    eq([/xvfb-run[^\n]*node test\/vscode\/run\.js/.test(ui), /CODEX_PLUS_UI_OFFLINE:\s*require/.test(ui)], [true, true],
      'on Linux under a virtual display, and failing there if the test stage cannot be cut off from the network');
    eq(/if:\s*always\(\)\s*\n\s*with:\s*\n\s*name:\s*vscode-/.test(ui), true, 'and the results are kept as an artifact whether the run passed or not');
  }

  for (const [name, text] of [['check.yml', check], ['against-latest.yml', latest], ['vscode.yml', ui]].filter(([, t]) => t)) {
    const uses = text.match(/uses:\s*actions\/(?:checkout|setup-node)@\S+/g) || [];
    eq(uses.length > 0 && uses.every((u) => /@v7$/.test(u)), true, `${name} uses checkout and setup-node at v7, as Claude Code Plus's workflow does`);
  }

  /* ── the daily one against the Codex being shipped ── */
  const cron = /cron:\s*'([^']+)'/.exec(latest);
  eq(!!cron, true, 'the upstream check is on a schedule');
  if (cron) {
    const [minute, hour, dom, month, dow] = cron[1].trim().split(/\s+/);
    eq([dom, month, dow], ['*', '*', '*'], 'every day');
    eq([/^\d+$/.test(minute), /^\d+$/.test(hour)], [true, true], 'at one time of day');
    eq(minute !== '0', true, 'and not on the hour, which is when a scheduled run is likeliest to be dropped');
  }
  eq(/workflow_dispatch:/.test(latest), true, 'and it can be started by hand as well, for the day an edit is changed');
  eq(/node test\/against-latest\.js/.test(latest), true, 'what it runs is the check against the latest Codex');

  /*
   * The step's own shell, run against a `node` that exits the way against-latest.js does: 0 when every edit still
   * fits, 1 when one does not, and anything else when the check could not run at all. All but the first have to end
   * the step, or the workflow goes green while the patch quietly does nothing for everyone who updates.
   */
  const script = runScript(latest);
  eq(script.includes('node test/against-latest.js'), true, 'the step is a shell script, which these checks could read');
  const bin = tmp('stub-node');
  const home = tmp('fake-repo');
  const run = (code) => {
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
    const r = cp.spawnSync('bash', ['-c', script], { cwd: home, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const fine = run(0);
  eq([fine.status, fine.out.includes('::error::')], [0, false],
    'with every edit still fitting the step passes and says nothing');
  const moved = run(1);
  eq(moved.status, 1, 'an edit that no longer fits ends the step, rather than being left for somebody to read in a log');
  eq([/::error::/.test(moved.out), /src\/host\.js/.test(moved.out)], [true, true],
    'and the run is annotated with which files have to be updated');
  const broken = run(2);
  eq(broken.status, 2, 'a check that could not run at all ends the step too, since it proves nothing either way');
  eq(/did not run/.test(broken.out), true, 'and says that is what happened, rather than naming an edit');

  /* The ways a step is made to pass whatever it did. None of them is a thing to add here by accident. */
  for (const swallow of ['continue-on-error', '|| true', '|| exit 0', '&& exit 0']) {
    if (latest.includes(swallow)) bad(`the upstream check carries "${swallow}", which would let a moved edit pass`);
    else ok(`it does not carry "${swallow}"`);
  }
};
