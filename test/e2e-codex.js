// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * End-to-end check of the work plan against a real codex, in a CODEX_HOME made for it. Not part of test/check.js: it
 * calls a model, so it needs credentials and a minute or two.
 *
 *   node test/e2e-codex.js <codex binary> <CODEX_HOME to use> [<model>]
 *
 * The CODEX_HOME must already hold a config.toml that can reach a model (model, model_provider and its provider table);
 * nothing else in it is needed. It installs the plugin there through app-server, trusts its hooks the way Codex's
 * Settings > Hooks page does, and then proves three things with `codex exec`:
 *
 *   1. the model starts a plan and changes a row through the work_plan MCP tools, with no approval, in a read-only
 *      sandbox;
 *   2. the next turn has the plan's open rows in front of it (the injection hook ran);
 *   3. a turn that ends with a row still `doing` is kept going by the Stop hook, with the reminder to move it on.
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const install = require('../src/plugin-install');

const [binary, home, model] = process.argv.slice(2);
if (!binary || !home) { console.error('usage: node test/e2e-codex.js <codex binary> <CODEX_HOME> [<model>]'); process.exit(2); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-extras-e2e-'));
const proj = path.join(work, 'proj');
fs.mkdirSync(proj);

function exec(args, prompt) {
  const extra = model ? ['-m', model] : [];
  const r = cp.spawnSync(binary, ['exec', ...args, '--json', '--skip-git-repo-check', '-c', 'model_reasoning_effort="low"', ...extra, prompt],
    { cwd: proj, env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', input: '', timeout: 600000, maxBuffer: 64 << 20 });
  const events = r.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } });
  return { status: r.status, events, stderr: r.stderr };
}
const items = (run, type) => run.events.filter((e) => e.type === 'item.completed' && e.item && e.item.type === type).map((e) => e.item);
let failed = 0;
const check = (label, cond) => { if (!cond) failed++; console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`); };

(async () => {
  await install.install({ binary, home, stage: path.join(work, 'marketplace') });
  check('the plugin is in Codex\'s cache', install.installedVersions(home).length > 0);
  const before = await install.hookStatus({ binary, home, cwds: [proj] });
  check(`Codex lists the plugin's hooks (${before.total})`, before.total >= 9);
  await install.trustHooks({ binary, home, cwds: [proj] });
  const after = await install.hookStatus({ binary, home, cwds: [proj] });
  check('after trusting, none needs review', after.review.length === 0);

  const one = exec([], "Start this conversation's work plan: add a row titled 'Probe' in state doing with the work_plan MCP "
    + 'tools (build the plan path as the agent-work-plan skill says), then set it to done, then reply DONE.');
  const thread = (one.events.find((e) => e.type === 'thread.started') || {}).thread_id;
  const calls = items(one, 'mcp_tool_call').filter((c) => c.server === 'work_plan' && c.status === 'completed');
  check('the model changed rows through the MCP tools', calls.length >= 2);
  const plan = path.join(install.planDir(home), `${thread}.json`);
  let nodes = [];
  try { nodes = JSON.parse(fs.readFileSync(plan, 'utf8')).nodes; } catch (_) { /* none */ }
  check('the plan file holds the row, done', nodes.length === 1 && nodes[0].state === 'done');

  cp.spawnSync('python3', [path.join(install.SOURCE, install.PLUGIN, 'hooks', 'plan-row.py'), plan, 'add', 'todo', 'Second row'], { encoding: 'utf8' });
  const two = exec(['resume', thread], 'Without calling any tool, quote the row lines of the work plan block given at the start of this turn.');
  const said = items(two, 'agent_message').map((m) => m.text).join('\n');
  check('the next turn was given the open row', /2\. Second row/.test(said));

  exec(['resume', thread], 'Set row 2 of the work plan to doing with the work_plan tools, then reply OK and stop.');
  // The reminder may be answered either way (move the row on, or keep it doing with a note); what is checked is that
  // the Stop hook put it into the turn, which Codex records in the rollout as a hook_prompt.
  const rollout = require('../src/codex-files').rolloutOf(thread, home);
  const text = rollout ? fs.readFileSync(rollout, 'utf8') : '';
  check('the Stop hook kept the turn going with the doing-row reminder', /hook_prompt[^\n]*This turn is ending with 1 row/.test(text));

  console.log(failed ? `${failed} failed` : 'all passed');
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
