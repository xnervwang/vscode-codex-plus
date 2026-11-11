// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The companion Codex plugin: its manifests agree with each other, every hook it names exists, the Python parts pass
 * their own self-tests, the MCP server answers the protocol and writes only where it should, and the injected block
 * puts a plan in front of the model.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const fixture = require('../fixture');

const python = () => {
  for (const exe of ['python3', 'python']) {
    const r = cp.spawnSync(exe, ['-c', 'import sys; print(sys.version_info[:2] >= (3, 7))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return exe;
  }
  return '';
};

module.exports = async ({ ok, bad, note, eq, tmp, root }) => {
  const plugin = path.join(root, 'codex-plugin', 'agent-work-plan');
  const hooksDir = path.join(plugin, 'hooks');
  const market = JSON.parse(fs.readFileSync(path.join(root, 'codex-plugin', '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'));
  const install = require('../../src/plugin-install');
  eq([market.name, market.plugins[0].name, market.plugins[0].version], [install.MARKETPLACE, install.PLUGIN, manifest.version],
    'marketplace, plugin manifest and installer name the same plugin and version');
  eq(install.DATA_DIR, 'agent-work-plan-codex-extras', 'the data directory is <plugin>-<marketplace>, as Codex names it');

  // Before an uninstall the plans are copied out; when that fails, nothing is removed.
  const noPlans = tmp('no-plans');
  eq(install.savePlans(noPlans), '', 'no plan folder means nothing to save');
  const withPlans = tmp('with-plans');
  fs.mkdirSync(install.planDir(withPlans), { recursive: true });
  fs.writeFileSync(path.join(install.planDir(withPlans), '01a1b8e8-f7e2-7251-95a9-a95b65992849.json'), '{}');
  fs.writeFileSync(path.join(install.planDir(withPlans), 'config.json'), '{}');
  const saved = install.savePlans(withPlans, 'T');
  eq([path.basename(saved), fs.readdirSync(saved).filter((n) => n.endsWith('.json'))], ['agent-work-plan-plans-T', ['01a1b8e8-f7e2-7251-95a9-a95b65992849.json']], 'the plans are copied, without the settings');
  fs.writeFileSync(path.join(withPlans, 'agent-work-plan-plans-U'), 'a file where the copy would go');
  let threw = '';
  try { install.savePlans(withPlans, 'U'); } catch (e) { threw = e.message; }
  eq(/could not all be copied .* so the plugin was not removed/.test(threw), true, 'a copy that fails stops the uninstall, saying why');
  if (process.getuid && process.getuid() !== 0) {
    const shut = tmp('shut');
    fs.mkdirSync(install.planDir(shut), { recursive: true });
    fs.chmodSync(install.planDir(shut), 0);
    let why = '';
    try { install.savePlans(shut); } catch (e) { why = e.message; }
    fs.chmodSync(install.planDir(shut), 0o700);
    eq(/could not be read \(EACCES\)/.test(why), true, 'a plan folder that cannot be read is not taken for an empty one');
  }
  // Trusting hooks binds to the list the user was shown.
  const shown = [{ key: 'a', currentHash: '1' }, { key: 'b', currentHash: '2' }];
  eq([install.sameHooks([shown[1], shown[0]], shown), install.sameHooks([{ key: 'a', currentHash: '9' }, shown[1]], shown),
    install.sameHooks(shown.slice(1), shown), install.sameHooks(shown, undefined)], [true, false, false, false],
  'a hook whose hash changed, or a hook less or more, is not the list that was shown');
  /* plan_path.py is plan_common.py and plan_agent.py together (Agent Plus's shared code). */
  const planPath = ['plan_path.py', 'plan_common.py', 'plan_agent.py'].map((f) => fs.readFileSync(path.join(hooksDir, f), 'utf8')).join('\n');
  if (planPath.includes(`PLUGIN_DIR_NAME = "${install.DATA_DIR}"`)) ok('the hooks fall back to the same data directory');
  else bad('plan_path.py names a different data directory');

  // The keys Codex 0.164 listed for this plugin's hooks (hooks/list), which uninstalling removes from config.toml.
  const listed = ['pre_tool_use:0:0', 'post_tool_use:0:0', 'post_tool_use:0:1', 'session_start:0:0', 'session_start:0:1',
    'user_prompt_submit:0:0', 'user_prompt_submit:0:1', 'user_prompt_submit:0:2', 'stop:0:0', 'stop:0:1', 'stop:0:2']
    .map((k) => `${install.PLUGIN_ID}:hooks/hooks.json:${k}`);
  eq(install.hookKeys().sort(), listed.sort(), 'the hook trust keys computed for uninstalling are the ones Codex lists');
  const hooks = JSON.parse(fs.readFileSync(path.join(hooksDir, 'hooks.json'), 'utf8')).hooks;
  const KNOWN = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
    'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'Stop'];
  const unknown = Object.keys(hooks).filter((e) => !KNOWN.includes(e));
  eq(unknown, [], 'every hook event is one Codex has (it has no PostToolBatch)');
  const scripts = [];
  for (const groups of Object.values(hooks)) for (const g of groups) for (const h of g.hooks) {
    const m = /\$PLUGIN_ROOT\/hooks\/([\w-]+\.py)/.exec(h.command);
    if (!m) bad(`hook command does not run a script of the plugin: ${h.command}`);
    else scripts.push(m[1]);
  }
  const missing = scripts.filter((s) => !fs.existsSync(path.join(hooksDir, s)));
  eq(missing, [], `every script hooks.json names exists (${new Set(scripts).size} scripts)`);
  const mcp = JSON.parse(fs.readFileSync(path.join(plugin, '.mcp.json'), 'utf8')).mcpServers.work_plan;
  eq([mcp.cwd, fs.existsSync(path.join(plugin, mcp.args[0]))], ['.', true],
    'the MCP server runs from the plugin root (Codex starts it in CODEX_HOME otherwise)');
  const skill = fs.readFileSync(path.join(plugin, 'skills', 'maintain', 'SKILL.md'), 'utf8');
  if (/^---\nname: maintain\ndescription: .+\n/m.test(skill)) ok('the skill has the name and description Codex reads');
  else bad('SKILL.md frontmatter lacks name or description');
  if (/claude|CLAUDE_CODE/i.test(skill.replace(/CLAUDE_PLUGIN/g, ''))) bad('the skill still mentions Claude');
  else ok('the skill says nothing that only holds for Claude Code');

  // The states, waiting-on values and description limits agree between the Python side and the extension's reader.
  const workplan = (() => { try { return require('../../src/workplan'); } catch (_) { return null; } })();
  if (workplan) {
    const list = (name) => JSON.parse('[' + new RegExp(`^${name} = \\(([^)]*)\\)`, 'm').exec(planPath)[1].replace(/,\s*$/, '') + ']');
    eq(workplan.STATES, list('STATES'), 'states agree between plan_path.py and src/workplan.js');
    eq(workplan.WAITING_ON, list('WAITING_ON'), 'waiting-on values agree');
    eq([workplan.MAX_DETAIL_LINES, workplan.MAX_DETAIL_CHARS],
      [+/^MAX_DETAIL_LINES = (\d+)/m.exec(planPath)[1], +/^MAX_DETAIL_CHARS = (\d+)/m.exec(planPath)[1]],
      'description limits agree');
  }

  const py = python();
  if (!py) { note('no Python 3.7+ here: the plugin\'s self-tests and MCP checks did not run'); return; }
  for (const script of ['changes.py', 'guard-work-plan.py', 'refresh-work-plan.py', 'resume-work-plan.py', 'tell-time-zone.py']) {
    const r = cp.spawnSync(py, [path.join(hooksDir, script), '--selftest'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    if (r.status === 0 && /all checks pass/.test(r.stdout)) ok(`${script} self-test`);
    else bad(`${script} self-test failed:\n${(r.stdout + r.stderr).split('\n').filter((l) => /FAIL|Error/.test(l)).join('\n')}`);
  }

  // The MCP server over stdio: initialize, list, add a row, refuse a write outside the plan directory.
  const mcpHome = tmp('mcp');
  const data = path.join(mcpHome, 'plugins', 'data', install.DATA_DIR);
  const lookalike = path.join(tmp('mcp-elsewhere'), install.DATA_DIR, '01a1b8e8-f7e2-7251-95a9-a95b65992849.json');
  const plan = path.join(data, '01a1b8e8-f7e2-7251-95a9-a95b65992849.json');
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_row', arguments: { plan, state: 'doing', title: 'T' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'set_row', arguments: { plan, row: '1', state: 'waiting' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'set_row', arguments: { plan: '/etc/x.json', row: '1' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'add_row', arguments: { plan: lookalike, state: 'doing', title: 'T' } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'set_summary', arguments: { plan, text: 'What it is for.' } } },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'set_status', arguments: { plan, doing: 'd', progress: 'p', next: 'none' } } },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'set_status', arguments: { plan, doing: 'x'.repeat(81), progress: 'p', next: 'n' } } },
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'set_summary', arguments: { plan: lookalike, text: 'x' } } },
  ];
  const r = cp.spawnSync(py, [path.join(hooksDir, 'plan-mcp.py')], { input: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n',
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', CODEX_HOME: mcpHome } });
  const replies = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  eq(replies.map((x) => x.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'the MCP server answers every request and no notification');
  eq(replies[1].result.tools.map((t) => t.name), ['set_row', 'add_row', 'set_summary', 'set_status', 'skill_search', 'set_wakeup', 'clear_wakeup'],
    'it offers set_row, add_row, set_summary, set_status, skill_search, set_wakeup and clear_wakeup');
  eq(replies[2].result.isError, false, 'add_row creates the plan');
  eq(JSON.parse(fs.readFileSync(plan, 'utf8')).nodes[0].state, 'doing', 'with the row in it');
  eq(replies[3].result.isError, true, 'a move to waiting without waiting_on is refused, as by the row command');
  eq(replies[4].result.isError, true, 'a path outside the plan directory is refused');
  eq([replies[5].result.isError, fs.existsSync(lookalike)], [true, false],
    'a directory with the plan directory\'s name outside this Codex home is refused, and nothing is written there');
  {
    const brief = JSON.parse(fs.readFileSync(plan, 'utf8')).brief || {};
    const tools = Object.fromEntries(replies[1].result.tools.map((t) => [t.name, t]));
    eq([replies[6].result.isError, replies[7].result.isError, brief.summary, brief.status, /80/.test(replies[8].result.content[0].text),
      replies[8].result.isError, replies[9].result.isError, tools.set_status.inputSchema.required,
      tools.set_summary.annotations.destructiveHint, tools.set_status.annotations.openWorldHint],
    [false, false, 'What it is for.', { doing: 'd', progress: 'p', next: 'none' }, true, true, true, ['plan', 'doing', 'progress', 'next'],
      false, false],
    'set_summary and set_status write the brief as the row command does, refuse a part past its width and a plan outside the plan '
      + 'directory, and run without an approval');
  }

  // A row moved to the archive is changed through the tools as any other: set_row puts it back.
  {
    const old = path.join(data, '01a1b8e8-f7e2-7251-95a9-a95b65992848.json');
    const day = 86400e3;
    const at = (ms) => new Date(Date.now() - ms).toISOString().replace(/\.\d+Z$/, '+00:00');
    fs.writeFileSync(old, JSON.stringify({ nodes: [{ title: 'Closed long ago', state: 'done', closed: at(3 * day), note: 'kept' },
      { title: 'Open', state: 'todo' }] }));
    const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { plan: old, ...args } } });
    const once = (m) => cp.spawnSync(py, [path.join(hooksDir, 'plan-mcp.py')], { input: [msgs[0], msgs[1], m].map((x) => JSON.stringify(x)).join('\n') + '\n',
      encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', CODEX_HOME: mcpHome } });
    once(call(2, 'set_row', { row: '2', note: 'touched' }));
    const archived = JSON.parse(fs.readFileSync(old, 'utf8')).nodes[0];
    const back = once(call(2, 'set_row', { row: '1', state: 'todo' }));
    const row = JSON.parse(fs.readFileSync(old, 'utf8')).nodes[0];
    eq([archived.archived, /row 1: done -> todo/.test(back.stdout), row.title, row.note, row.archived,
      fs.existsSync(path.join(data, 'closed', path.basename(old)))],
    [true, true, 'Closed long ago', 'kept', undefined, false],
    'set_row moves a row closed days ago to the archive with the next write, and puts it back when it is reopened');
    fs.unlinkSync(old);
  }

  // The injection hook: a plan with an open row puts it in front of the model, with the tools to change it.
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: path.basename(plan, '.json'), turn_id: 'turn-1',
    transcript_path: null, cwd: data, model: 'm', permission_mode: 'default', prompt: 'p' };
  const inj = cp.spawnSync(py, [path.join(hooksDir, 'inject-work-plan.py'), data], { input: JSON.stringify(payload), encoding: 'utf8' });
  let ctx = '';
  try { ctx = JSON.parse(inj.stdout).hookSpecificOutput.additionalContext; } catch (_) { /* empty */ }
  if (/> 1\. T {3}\[doing/.test(ctx) && /set_row/.test(ctx) && ctx.includes(plan)) ok('the injected block lists the open row and names the tools');
  else bad(`the injected block is wrong: ${inj.stdout.slice(0, 300)} ${inj.stderr.slice(0, 300)}`);
  eq(JSON.parse(fs.readFileSync(plan.replace(/\.json$/, '.turn'), 'utf8')).prompt, 'turn-1', 'it marks the turn by Codex\'s turn_id');

  // The end-of-turn hook keeps the turn going with a reason, once, and never on its own continuation.
  const stop = { ...payload, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' };
  const rollout = path.join(data, '..', 'rollout.jsonl');
  const asRows = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(rollout, asRows(fixture.userMessageRows({ at: Date.now(), threadId: payload.session_id, turnId: 'turn-1', text: 'x' })));
  stop.transcript_path = rollout;
  const run = (p) => cp.spawnSync(py, [path.join(hooksDir, 'nudge-work-plan.py'), data], { input: JSON.stringify(p), encoding: 'utf8' }).stdout.trim();
  const first = run(stop);
  let parsed = {};
  try { parsed = JSON.parse(first); } catch (_) { /* empty */ }
  eq([parsed.decision, /still `doing`/.test(parsed.reason || '')], ['block', true], 'a turn ending with a doing row is kept going, with the reason');
  eq(run(stop), '', 'and not asked again about the same rows');
  eq(run({ ...stop, stop_hook_active: true }), '', 'and nothing is said on the continuation it caused');

  /* With no plan yet, a conversation the user has spoken in three times, whose last turn used 25 tools, is offered one
     once. The user's messages are written as Codex 0.164 writes them in VS Code (fixture.userMessageRows), which is what
     the hook has to find to know where the turn began and how often the user spoke. */
  const lone = '01a1b8e8-f7e2-7251-95a9-a95b65992852';
  const loneRollout = path.join(data, '..', 'rollout-no-plan.jsonl');
  const lines = [];
  const t0 = Date.now() - 600e3;
  for (let turn = 0; turn < 3; turn++) {
    const at = t0 + turn * 60e3;
    lines.push({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: `t${turn}` } });
    lines.push(...fixture.userMessageRows({ at: at + 1, threadId: lone, turnId: `t${turn}`, text: 'go', item: lines.length }));
    for (let k = 0; k < (turn === 2 ? 25 : 2); k++) {
      lines.push({ timestamp: new Date(at + 10 + k).toISOString(), type: 'response_item', payload: { type: 'function_call',
        name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls' }), call_id: `c${turn}-${k}` } });
    }
  }
  fs.writeFileSync(loneRollout, asRows(lines));
  const lonePayload = { ...stop, session_id: lone, transcript_path: loneRollout, last_assistant_message: 'Finished.' };
  let offer = {};
  try { offer = JSON.parse(run(lonePayload)); } catch (_) { /* empty */ }
  eq([offer.decision, /You have spoken 3 times and this turn used 25 tools/.test(offer.reason || '')], ['block', true],
    'with no plan, three user messages and a turn of 25 tool calls get the offer of one');
  eq(run(lonePayload), '', 'and the offer is made only once');

  // The row command does not write while another writer holds the plan's lock: it waits out a dead holder's lock
  // (LOCK_STALE) and then refuses, with nothing changed.
  const locked = path.join(tmp('locked'), '01a1b8e8-f7e2-7251-95a9-a95b65992850.json');
  fs.writeFileSync(locked, JSON.stringify({ nodes: [{ title: 'A', state: 'todo' }] }));
  const lock = locked + '.lock';
  fs.mkdirSync(lock);
  const keepFresh = setInterval(() => { try { const t = new Date(); fs.utimesSync(lock, t, t); } catch (_) { /* gone */ } }, 500);
  const refused = await new Promise((resolve) => {
    const child = cp.spawn(py, [path.join(hooksDir, 'plan-row.py'), locked, 'set', '1', 'doing'], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, err }));
  });
  clearInterval(keepFresh);
  eq([refused.code, /Nothing was written, because the plan's lock could not be taken/.test(refused.err), JSON.parse(fs.readFileSync(locked, 'utf8')).nodes[0].state],
    [1, true, 'todo'], 'with the plan\'s lock held by a live writer, the row command refuses and writes nothing');
  fs.rmdirSync(lock);
  const freed = cp.spawnSync(py, [path.join(hooksDir, 'plan-row.py'), locked, 'set', '1', 'doing'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  eq([freed.status, JSON.parse(fs.readFileSync(locked, 'utf8')).nodes[0].state], [0, 'doing'], 'and writes once the lock is free');
};
