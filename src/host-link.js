// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Whether claude-code-extras draws the shared work plan sidebar and Conversations panel, and handing it the Codex source
 * when it does (the shared-sidebar protocol, version 2).
 *
 * The host is xnervwang.claude-code-extras when it is installed, enabled, and its activate() returned a workPlanHost of
 * version 2 or later. Then the Codex source is registered with it and this extension draws none of those views. Otherwise
 * this extension sets codexExtras.standalone, which every one of its shared views is gated on, and draws them itself.
 * The key says "draw" rather than "hosted": before this extension activates it is unset, so a view gated on it stays
 * hidden in that moment instead of flashing up and away when there is a host.
 */
const HOST_ID = 'xnervwang.claude-code-extras';
const MIN_VERSION = 2;
const CONTEXT_KEY = 'codexExtras.standalone';

/** The host's workPlanHost, or null when there is none to use. */
async function findHost(vscode) {
  const ext = vscode.extensions.getExtension(HOST_ID);
  if (!ext) return null;
  let api;
  try { api = ext.isActive ? ext.exports : await ext.activate(); } catch (_) { return null; }
  const host = api && api.workPlanHost;
  if (!host || typeof host.registerSource !== 'function' || !(Number(host.version) >= MIN_VERSION)) return null;
  return host;
}

/*
 * Register `source` with the host if there is one; otherwise mark this window standalone. Resolves to
 * { hosted, registration } where registration is the host's Disposable. Watches for the host being installed or enabled
 * later and calls onHosted(registration) then, so the caller can take its own views down.
 */
async function link(vscode, source, { onHosted = () => {}, log = () => {} } = {}) {
  const state = { hosted: false, registration: null, watcher: null };
  const tryHost = async () => {
    const host = await findHost(vscode);
    if (!host) return false;
    try { state.registration = host.registerSource(source); } catch (e) { log(`workPlanHost.registerSource failed: ${e.message}`); return false; }
    state.hosted = true;
    await vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
    return true;
  };
  if (await tryHost()) return state;
  await vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);
  state.watcher = vscode.extensions.onDidChange(async () => {
    if (state.hosted) return;
    if (await tryHost()) { log('claude-code-extras is now the host of the work plan views'); onHosted(state.registration); }
  });
  return state;
}

module.exports = { HOST_ID, MIN_VERSION, CONTEXT_KEY, findHost, link };
