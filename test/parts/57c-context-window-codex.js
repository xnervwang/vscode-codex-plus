// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Checks what src/context-window.js assumes about model_context_window against the Codex installed here. Its
 * app-server runs real turns against a fake model, in a network namespace with only loopback
 * (test/context-window-probe.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

module.exports = async ({ eq, note, root }) => {
  const roots = [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')];
  const dir = roots.flatMap((r) => { try { return fs.readdirSync(r).filter((n) => /^openai\.chatgpt-/.test(n)).map((n) => path.join(r, n)); } catch (_) { return []; } }).sort().pop();
  const binary = dir ? require(path.join(root, 'src', 'appserver')).codexBinary(dir) : '';
  if (!binary) { note('no Codex is installed here, so what it does with model_context_window was not checked'); return; }
  if (process.platform !== 'linux') { note(`${process.platform} has no unprivileged network namespace, so Codex's handling of model_context_window was not checked`); return; }
  const ip = ['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip', '/bin/ip'].find((p) => fs.existsSync(p));
  if (!ip) { note('there is no ip program to bring loopback up with, so Codex\'s handling of model_context_window was not checked'); return; }
  const asUser = path.join(root, 'test', 'vscode', 'as-user.py');
  const r = spawnSync('unshare', ['-rn', 'sh', '-c', `${ip} link set lo up && exec python3 "$0" "$@"`, asUser, String(process.getuid()), String(process.getgid()),
    process.execPath, path.join(root, 'test', 'context-window-probe.js'), binary], { encoding: 'utf8', timeout: 90000 });
  let out = null;
  try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) { out = null; }
  if (!out) { note(`the probe could not run (${((r.error && r.error.message) || r.stderr || `exit ${r.status}`).trim().slice(0, 200)}), so Codex's handling of model_context_window was not checked`); return; }
  if (out.error) { eq(out.error, '', 'the probe ran to the end'); return; }

  const cw = require(path.join(root, 'src', 'context-window.js'));
  const listed = Array.isArray(out.listed) ? out.listed : [];
  eq([typeof out.listed === 'string' ? out.listed : '', listed.filter((m) => !cw.codexWindow(m))], ['', []],
    'every model this Codex lists has its default and its most in src/context-window.js');
  const some = (by) => Object.fromEntries(['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.5', 'made-up-model'].map((m) => [m, by[m]]));
  eq(Object.fromEntries(Object.entries(out.reported).map(([v, by]) => [v, some(by)])), {
    0: { 'gpt-6.1-sol': 258400, 'gpt-6-luna': 258400, 'gpt-5.5': 258400, 'made-up-model': 258400 },
    500000: { 'gpt-6.1-sol': 475000, 'gpt-6-luna': 475000, 'gpt-5.5': 258400, 'made-up-model': 258400 },
    1050000: { 'gpt-6.1-sol': 828400, 'gpt-6-luna': 828400, 'gpt-5.5': 258400, 'made-up-model': 258400 },
  }, 'Codex reports 95% of the window it uses: its default of 272,000, or the value set, held to the most it allows each model '
    + '(872,000 for the GPT-6 models, 272,000 for GPT-5.5 and for a model it does not list)');
  const expect = (model, value) => {
    const own = (listed.includes(cw.baseName(model)) && cw.codexWindow(model)) || [cw.FALLBACK, cw.FALLBACK];
    return Math.floor(Math.min(value || own[0], own[1]) * 95 / 100);
  };
  eq(Object.entries(out.reported).flatMap(([v, by]) => Object.entries(by).filter(([m, got]) => expect(m, +v) !== got).map(([m]) => `${m} at ${v}`)), [],
    'the defaults and the most in src/context-window.js are the ones this Codex uses');
  eq(out.compaction, { 440000: false, 460000: true }, 'with a window of 500,000, Codex compacts before a turn once a call passed 450,000, 90% of it');
  eq(out.loaded, { before: 258400, written: 'ok', after: 258400, resumedWithOverride: 258400, newConversation: 475000 },
    'a conversation the app-server has loaded keeps its window when config.toml changes, and a resume does not change it, '
      + 'even with an override; a conversation started afterwards uses the new value');
  eq(out.override, { started: 380000, switchedToLuna: 380000, switchedToSmaller: 258400, nextStart: 475000, nullStart: 'refused' },
    'an override at the start is that conversation\'s alone and stays with it through a change of model, held to the new model\'s most; '
      + 'a null override stops the conversation from starting at all');
};
