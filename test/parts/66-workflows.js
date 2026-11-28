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

/* The script of the first `run: |` block of `text` that contains `needle`, or of the last block when no needle is
   given. */
function runScript(text, needle = '') {
  const lines = text.split(/\r?\n/);
  const block = (at) => {
    const indent = (lines[at].match(/^\s*/) || [''])[0].length;
    const out = [];
    for (let i = at + 1; i < lines.length; i++) {
      if (lines[i].trim() === '') { out.push(''); continue; }
      const own = (lines[i].match(/^\s*/) || [''])[0].length;
      if (own <= indent) break;
      out.push(lines[i].slice(indent + 2));
    }
    return out.join('\n');
  };
  const blocks = lines.map((l, i) => (/^\s*run:\s*\|\s*$/.test(l) ? i : -1)).filter((i) => i >= 0).map(block);
  if (!blocks.length) return '';
  return needle ? blocks.find((b) => b.includes(needle)) || '' : blocks[blocks.length - 1];
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
  eq([/repository:\s*xnervwang\/vscode-agent-plus\s*\n(\s*ref:[^\n]*\n)?\s*path:\s*vscode-agent-plus\b/.test(check),
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
    const on = ui.split(/^jobs:/m)[0];
    eq([/^\s+push:/m.test(on), /^\s+pull_request:/m.test(on), /^\s+workflow_call:/m.test(on), /^\s+workflow_dispatch:/m.test(on)], [false, false, true, true],
      'it runs on no push and no pull request, which check.yml covers, but when release.yml calls it and by hand');
    const cron = (text) => ((/cron:\s*'([^']+)'/.exec(text) || [])[1] || '').trim().split(/\s+/);
    const [minute, hour, ...days] = cron(ui);
    const others = [check, latest].map((t) => cron(t).slice(0, 2).join(' '));
    eq(days.join(' ') === '* * *' && /^\d+$/.test(minute) && !['0', '30'].includes(minute) && !others.includes(`${minute} ${hour}`), true,
      'and once a day, neither on the hour nor on the half hour, and not at the time of the other two');
    eq(/os:[^\n]*\["ubuntu-latest",\s*"macos-latest",\s*"windows-latest"\]/.test(ui), true, 'on Linux, macOS and Windows');
    const shards = /shard:[^\n]*'\[([\d,\s]+)\]'/.exec(ui);
    const { SHARD_STARTS } = require(path.join(root, 'test', 'vscode', 'ui.js'));
    eq([shards && shards[1].split(',').map((x) => +x.trim()).join(' '), (/format\('\{0\}\/(\d+)', matrix\.shard\)/.exec(ui) || [])[1]],
      [SHARD_STARTS.map((_, i) => i + 1).join(' '), String(SHARD_STARTS.length)],
      'each system runs the window test in as many shards as ui.js SHARD_STARTS cuts it into, side by side');
    eq([/inputs:\s*\n\s+os:[\s\S]*options:\s*\[all,\s*ubuntu-latest,\s*macos-latest,\s*windows-latest\]/.test(ui), /\n\s+steps:\s*\n\s+description:/.test(ui),
      /CODEX_PLUS_UI_STEPS:\s*\$\{\{\s*inputs\.steps\s*\}\}/.test(ui), /fromJSON\(inputs\.steps && '\[0\]'/.test(ui)], [true, true, true, true],
      'by hand it can be run on one system, and with a regular expression of step names in one job per system instead of the shards');
    eq([/xvfb-run[^\n]*node test\/vscode\/run\.js/.test(ui), /CODEX_PLUS_UI_OFFLINE:\s*require/.test(ui)], [true, true],
      'on Linux under a virtual display, and failing there if the test stage cannot be cut off from the network');
    eq(/if:\s*always\(\)\s*\n\s*with:\s*\n\s*name:\s*vscode-/.test(ui), true, 'and the results are kept as an artifact whether the run passed or not');
    const pinned = (fs.readFileSync(path.join(root, '.github', 'agent-plus-commit'), 'utf8').split('\n').find((l) => l && !l.startsWith('#')) || '').trim();
    eq([/^[0-9a-f]{40}$/.test(pinned), [ui, check].every((t) => /grep -v '\^#' [\w./-]*\.github\/agent-plus-commit/.test(t) && /ref:\s*\$\{\{\s*steps\.core\.outputs\.ref\s*\}\}/.test(t)
      && /github\.event_name \}\}" = schedule \]/.test(t))], [true, true],
      'a push and a release build against the Agent Plus commit .github/agent-plus-commit names, and the daily runs against its newest commit');
    eq(/CODEX_PLUS_UI_CODEX:\s*\$\{\{\s*\(github\.event_name == 'schedule' \|\| inputs\.codex == 'latest'\) && 'latest' \|\| 'supported'\s*\}\}/.test(ui), true,
      'a release installs the newest Codex src/supported-versions.json lists, and the daily run the newest released');
    const runJs = fs.readFileSync(path.join(root, 'test', 'vscode', 'run.js'), 'utf8');
    eq(/require\('\.\.\/\.\.\/src\/supported'\)\.versions\(\)\.pop\(\)/.test(runJs) && /want === 'latest'\) return 'openai\.chatgpt'/.test(runJs), true,
      'and test/vscode/run.js installs that one by default, the marketplace\'s newest with CODEX_PLUS_UI_CODEX=latest');
  }

  /* ── the one that publishes a release ── */
  const rel = read('release.yml');
  eq(!!rel, true, 'the workflow that publishes a release is there');
  if (rel) {
    eq([/^on:\s*\n\s+push:\s*\n\s+tags:\s*\['v\*'\]/m.test(rel), /pull_request:|schedule:|workflow_dispatch:|branches:/.test(rel)], [true, false],
      'only a push of a v<version> tag starts it');
    eq([/^permissions:\s*\n\s+contents:\s*read\s*\n\S/m.test(rel), (rel.match(/id-token:\s*write/g) || []).length, /id-token:/.test(rel.split('\njobs:')[0])],
      [true, 1, false], 'the workflow only reads the repository, and the publishing job alone may ask for an OIDC token');
    eq([/environment:/.test(rel), /secrets\./.test(rel)], [false, false], 'with no environment and no stored token');
    const order = ['git merge-base --is-ancestor', 'Check the tag and the version against both registries', 'node test/check.js',
      'node test/against-core.js', 'package --out', 'actions/upload-artifact', 'publish --oidc', '--trusted-publishing'].map((s) => rel.indexOf(s));
    eq(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), true,
      'the tag is on main, the version is new to both registries, and the suite and the check against the Marketplace\'s Agent Plus pass, all before the package is built, kept and published');
    eq((rel.match(/--skip-duplicate/g) || []).length, 2, 'and each upload skips a registry that already has the version, so a rerun can finish a release');
    const job = (name) => (new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  \\w[\\w-]*:\\n|$)`).exec(rel) || [])[1] || '';
    eq([/needs:\s*checks/.test(job('window')), /uses:\s*\.\/\.github\/workflows\/vscode\.yml/.test(job('window')), /needs:\s*window/.test(job('publish')),
      /check\.js|against-core|merge-base/.test(job('publish')), /package --out/.test(job('checks'))], [true, true, true, false, false],
      'every window test step runs on the three systems once the quick checks pass, and the extension is packed and published only after that');
  }

  for (const [name, text] of [['check.yml', check], ['against-latest.yml', latest], ['vscode.yml', ui], ['release.yml', rel]].filter(([, t]) => t)) {
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
  const script = runScript(latest, 'node test/against-latest.js');
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

  /* What the step passes to the issue step: its exit code, and the Codex version named on the report's first line. */
  {
    const out = path.join(tmp('gh-output'), 'out');
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho "openai.chatgpt 26.1.2 for linux-x64"\necho "FAIL  host: an edit matched 0 times"\nexit 1\n', { mode: 0o755 });
    const r = cp.spawnSync('bash', ['-c', script], { cwd: home, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out }, encoding: 'utf8' });
    const said = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    eq([r.status, /^code=1$/m.test(said), /^version=26\.1\.2$/m.test(said), fs.existsSync(path.join(home, 'report.txt'))], [1, true, true, true],
      'the step keeps the report and passes its exit code and the Codex version the report names to the step that opens an issue');
  }
  /* The step that opens, reopens and closes the issue of each Codex version. */
  eq(/^\s+issues: write$/m.test(latest), true, 'the daily check may open and close issues');
  eq(/if: always\(\) && \(steps\.latest\.outputs\.code == '0' \|\| steps\.latest\.outputs\.code == '1'\)/.test(latest), true,
    'its issue step runs on an exit of 0 or 1, what the build itself showed, and not when the check could not run');
  eq([/const title = `Codex \$\{version \|\| 'an unknown build'\} /.test(latest), /state: 'all'/.test(latest), /i\.title === title/.test(latest), /issues\.create\(/.test(latest)],
    [true, true, true, true], 'the issue is titled by the version, and a failure opens one only when no issue of any state has that title');
  eq([/already\.state === 'open'[\s\S]*?left as it is/.test(latest), /issues\.update\(\{ \.\.\.repo, issue_number: already\.number, state: 'open' \}\)/.test(latest)], [true, true],
    'a failure leaves the open issue of its version as it is, and opens a closed one again');
  eq([/if \(passed\) \{[\s\S]*?The check passed on \$\{commit\} against Codex \$\{version\}\.[\s\S]*?state: 'closed'/.test(latest)], [true],
    'a pass closes the open issue of its version, with a comment naming the commit and the version the check passed on');
  eq(/const act = async \(what, fn\) => \{ said\.push\(what\); core\.info\(what\); if \(!preview\) await fn\(\); \}/.test(latest), true,
    'and a preview says each thing it would do to the issue without doing it');

  /* The ways a step is made to pass whatever it did. None of them is a thing to add here by accident. */
  for (const swallow of ['continue-on-error', '|| true', '|| exit 0', '&& exit 0']) {
    if (latest.includes(swallow)) bad(`the upstream check carries "${swallow}", which would let a moved edit pass`);
    else ok(`it does not carry "${swallow}"`);
  }
};
