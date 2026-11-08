// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Whether claude-code-extras draws the shared work plan sidebar and Conversations panel, and handing it the Codex source
 * when it does (the shared-sidebar protocol, major 3).
 *
 * The host is xnervwang.claude-code-extras when it is installed, enabled, and its activate() returned a workPlanHost whose
 * `majors` include the source's `protocol`. Then the Codex source is registered with it and this extension draws none
 * of those views. Otherwise this extension sets codexExtras.standalone, which every one of its shared views is gated on,
 * and draws them itself. When claude-code-extras is there but cannot take this source - too old to have the API, or
 * past this major - the user is told once that updating it puts both agents in one sidebar; until then there are two.
 * The key says "draw" rather than "hosted": before this extension activates it is unset, so a view gated on it stays
 * hidden in that moment instead of flashing up and away when there is a host.
 */
const HOST_ID = 'xnervwang.claude-code-extras';
const CONTEXT_KEY = 'codexExtras.standalone';
const TOLD_KEY = 'codexExtras.toldHostTooOld';

/*
 * { host, present }: the workPlanHost to register `protocol` with, or null; and whether claude-code-extras is installed
 * at all, so a missing or incompatible API can be told apart from no host.
 */
async function probeHost(vscode, protocol) {
  const ext = vscode.extensions.getExtension(HOST_ID);
  if (!ext) return { host: null, present: false };
  let api;
  try { api = ext.isActive ? ext.exports : await ext.activate(); } catch (_) { return { host: null, present: true }; }
  const host = api && api.workPlanHost;
  const ok = host && typeof host.registerSource === 'function' && Array.isArray(host.majors) && host.majors.includes(protocol);
  return { host: ok ? host : null, present: true };
}

/** The host's workPlanHost if it takes `protocol`, or null. */
async function findHost(vscode, protocol = 3) { return (await probeHost(vscode, protocol)).host; }

/** Whether the host offers an optional capability (protocol section 7, rule 1). */
const hostHas = (host, name) => !!(host && Array.isArray(host.features) && host.features.includes(name));

/*
 * Register `source` with the host if there is one; otherwise mark this window standalone. Resolves to
 * { hosted, registration } where registration is the host's Disposable. Watches for the host being installed or enabled
 * later and calls onHosted(registration) then, so the caller can take its own views down.
 */
async function link(vscode, source, { onHosted = () => {}, log = () => {}, memento = null } = {}) {
  const state = { hosted: false, registration: null, watcher: null, host: null, incompatible: false };
  const tryHost = async () => {
    const { host, present } = await probeHost(vscode, source.protocol);
    state.incompatible = present && !host;
    if (!host) return false;
    state.host = host;
    try { state.registration = host.registerSource(source); } catch (e) { log(`workPlanHost.registerSource failed: ${e.message}`); return false; }
    state.hosted = true;
    await vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
    return true;
  };
  if (await tryHost()) return state;
  await vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);
  if (state.incompatible && memento && !memento.get(TOLD_KEY)) {
    await memento.update(TOLD_KEY, true);
    vscode.window.showInformationMessage('Update Claude Code Extras to its newest version to share one work plan sidebar '
      + 'and one Conversations tab with Codex Extras. Until then each extension shows its own.');
  }
  state.watcher = vscode.extensions.onDidChange(async () => {
    if (state.hosted) return;
    if (await tryHost()) { log('claude-code-extras is now the host of the work plan views'); onHosted(state.registration); }
  });
  return state;
}

module.exports = { HOST_ID, CONTEXT_KEY, TOLD_KEY, probeHost, findHost, hostHas, link };
