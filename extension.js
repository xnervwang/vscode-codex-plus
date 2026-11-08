// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Activation: reads the settings, points the Codex file readers at the right CODEX_HOME, and registers each part.
 * Each part lives in its own module under src/ and is handed the context and a shared log; nothing here knows how a
 * part works inside.
 */
const vscode = require('vscode');
const files = require('./src/codex-files');

const CONFIG = 'codexExtras';
let log = null;

function applyCodexHome() {
  const dir = String(vscode.workspace.getConfiguration(CONFIG).get('codexHome') || '').trim();
  files.setCodexHome(dir);
}

async function showStatus() {
  const home = files.codexHome();
  const db = files.stateDbPath(home);
  const threads = files.listThreads(home) || [];
  const counts = {};
  for (const t of threads) counts[t.kind] = (counts[t.kind] || 0) + 1;
  const lines = [
    `CODEX_HOME: ${home}`,
    `State database: ${db || '(not found)'}`,
    `Threads: ${threads.length} (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'})`,
  ];
  for (const part of parts) if (typeof part.status === 'function') lines.push(...[].concat(part.status() || []));
  log.appendLine(lines.join('\n'));
  log.show(true);
}

/* Parts register themselves here as they are added; each may expose status() lines for Show Status. */
const parts = [];

function activate(context) {
  log = vscode.window.createOutputChannel('Codex Extras');
  context.subscriptions.push(log);
  applyCodexHome();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${CONFIG}.codexHome`)) applyCodexHome();
  }));
  context.subscriptions.push(vscode.commands.registerCommand(`${CONFIG}.status`, showStatus));
}

function deactivate() { files.closeAll(); }

module.exports = { activate, deactivate };
