// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The model is told the command line that changes a row, which starts with the Python launcher in launcher.json. When
 * that launcher is a path the shell has to quote, as the Python this extension downloads on Windows is, PowerShell runs
 * the line only with `&` in front of it.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const python = () => {
  for (const exe of ['python3', 'python']) {
    const r = cp.spawnSync(exe, ['-c', 'import sys; print(sys.version_info[:2] >= (3, 7))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return exe;
  }
  return '';
};

module.exports = async ({ eq, note, tmp }) => {
  const py = python();
  if (!py) { note('no Python 3.7 here: what the model is told about the row command was not checked'); return; }
  const pi = require('../../src/plugin-install');
  const SESSION = '01a1b8f3-0000-7000-8000-000000000007';
  const told = (launcher) => {
    const stage = tmp('stage-hint');
    pi.stageMarketplace(stage, pi.SOURCE, pi.SHIPPED_PYTHON);
    const hooks = path.join(stage, pi.PLUGIN, 'hooks');
    if (launcher) fs.writeFileSync(path.join(hooks, 'launcher.json'), JSON.stringify({ row: launcher }) + '\n');
    const data = tmp('plan-data-hint');
    fs.writeFileSync(path.join(data, `${SESSION}.json`), JSON.stringify({ nodes: [{ title: 'Ask', state: 'doing' }] }));
    const r = cp.spawnSync(py, [path.join(hooks, 'inject-work-plan.py'), data], { encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, turn_id: 't1', transcript_path: null,
        cwd: data, model: 'm', permission_mode: 'default', prompt: 'p' }) });
    try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) { return r.stderr.slice(0, 300); }
  };
  const hint = /In PowerShell, put & and a space in front of/;
  const quoted = told(['C:\\Users\\Jo Ann\\AppData\\python\\python.exe']);
  eq([quoted.includes("'C:\\Users\\Jo Ann\\AppData\\python\\python.exe'"), hint.test(quoted)], [true, true],
    'with a quoted interpreter path for a launcher, the model is told to put & in front of the row command in PowerShell');
  eq([hint.test(told(null)), hint.test(told(['py', '-3']))], [false, false], 'and with python3, or a launcher named plainly, it is not');
};
