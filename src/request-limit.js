// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * VS Code's limit on the requests webview tabs can have in flight (src/webview-limit.js), looked at a few seconds after
 * each start so the window is not held up. Codex's page loads its code as thousands of small files, so a Codex tab is
 * the kind that waits on that limit. It asks once for each new VS Code build or, if codexExtras.webviewRequestLimit says
 * so, raises the limit again without asking. On Linux it never raises on its own: VS Code added the limit there because
 * too many open files can crash a window.
 */
const fs = require('fs');
const path = require('path');
const webviewLimit = require('./webview-limit');

const SETTING = 'webviewRequestLimit';
const ASKED_KEY = 'codexExtras.webviewLimitAsked';

function place(vscode) {
  const local = !vscode.env.remoteName;
  let commit = '';
  try { commit = String(JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8')).commit || ''); } catch (_) { /* unknown */ }
  return { fs: vscode.workspace.fs, local, appRoot: vscode.env.appRoot, commit,
    at: local ? (p) => vscode.Uri.file(p) : (p) => vscode.Uri.from({ scheme: 'vscode-local', path: p }) };
}

function create(vscode, context, { cfg, log }) {
  const change = async (where, installs, from, to) => {
    const failed = [];
    for (const i of installs) {
      const why = await webviewLimit.setLimit(where.fs, i, from, to);
      log(`webview request limit: ${i.root} ${from} -> ${to}: ${why || 'done'}`);
      if (why) failed.push({ install: i, why });
    }
    return failed;
  };
  const stuck = async (failed) => {
    const how = webviewLimit.byHand(failed[0].install, process.platform);
    const why = /NoPermissions|EACCES|EPERM/.test(failed[0].why) ? 'no permission to write the file' : failed[0].why;
    if (await vscode.window.showWarningMessage(`Codex Extras: could not change VS Code's request limit (${why}). To change it yourself: ${how}`,
      'Copy the command') === 'Copy the command') await vscode.env.clipboard.writeText(how);
  };
  let busy = false;
  const checkOnce = async () => {
    const mode = cfg().get(SETTING, 'ask');
    if (mode === 'leave' || !vscode.workspace.fs || !vscode.env.appRoot) return;
    const where = place(vscode);
    const installs = await webviewLimit.find(where);
    log('webview request limit: ' + (installs.map((i) => `${i.root} = ${i.limit}`).join('; ') || 'no installation found'));
    const low = installs.filter((i) => i.limit === webviewLimit.OLD);
    if (!low.length) return;
    const linux = low.every((i) => webviewLimit.platformOf(i.root, process.platform) === 'linux');
    if (mode !== 'raise' || linux) {
      if (context.globalState.get(ASKED_KEY, '') === where.commit) return;
      await context.globalState.update(ASKED_KEY, where.commit);
      const always = 'Raise it, now and after updates', once = 'Raise it this time', no = 'Leave it';
      const pick = await vscode.window.showInformationMessage(
        'Codex Extras: VS Code lets webview tabs, Codex\'s among them, have 32 requests in flight at once across all windows, '
        + 'and a tab can stay blank waiting for one. Raise the limit to 1000000 in VS Code\'s own files?'
        + (linux ? ' VS Code added the limit for Linux, where too many open files can crash a window.' : ''),
        ...(linux ? [once, no] : [always, once, no]));
      if (pick === no) { await cfg().update(SETTING, 'leave', vscode.ConfigurationTarget.Global); return; }
      if (pick !== always && pick !== once) return;
      if (pick === always) await cfg().update(SETTING, 'raise', vscode.ConfigurationTarget.Global);
    }
    const failed = await change(where, low, webviewLimit.OLD, webviewLimit.NEW);
    if (failed.length < low.length) vscode.window.showInformationMessage('Codex Extras: VS Code\'s request limit is now 1000000. Quit and reopen VS Code for this to apply.');
    if (failed.length) await stuck(failed);
  };
  return {
    async check() { if (busy) return; busy = true; try { await checkOnce(); } finally { busy = false; } },
    async putBack() {
      if (!vscode.workspace.fs || !vscode.env.appRoot) return;
      const where = place(vscode);
      const high = (await webviewLimit.find(where)).filter((i) => i.limit === webviewLimit.NEW);
      await cfg().update(SETTING, 'leave', vscode.ConfigurationTarget.Global);
      if (!high.length) { vscode.window.showInformationMessage('Codex Extras: VS Code\'s request limit is already 32.'); return; }
      const failed = await change(where, high, webviewLimit.NEW, webviewLimit.OLD);
      if (failed.length < high.length) vscode.window.showInformationMessage('Codex Extras: VS Code\'s request limit is back to 32. Quit and reopen VS Code for this to apply.');
      if (failed.length) await stuck(failed);
    },
  };
}

module.exports = { create, SETTING };
