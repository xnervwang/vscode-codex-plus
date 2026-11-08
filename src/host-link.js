// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Whether claude-code-extras draws the shared work plan sidebar and Conversations panel, and handing it the Codex
 * source when it does (the work plan host protocol in claude-code-extras' docs/work-plan-host.md, major 3).
 *
 * The host is xnervwang.claude-code-extras when it is installed, enabled, and its activate() returned a workPlanHost
 * whose `majors` include the source's `protocol`. Then the Codex source is registered with it and this extension draws
 * none of those views. Otherwise this extension sets codexExtras.standalone, which every one of its shared views is
 * gated on, and draws them itself. The Codex session list, which no host draws, is contributed twice - into this
 * extension's container under the standalone key and into the host's container under the hosted key - so it always sits
 * in the one sidebar there is. When claude-code-extras is there but cannot take this source, the user is told once which
 * extension to update, with a button that updates it: claude-code-extras when it is too old to have the API or this
 * major, this extension when the host is past this major. Until then there are two sidebars. The key says "draw" rather than "hosted": before this extension activates it is unset, so a view gated on it
 * stays hidden in that moment instead of flashing up and away when there is a host.
 */
const HOST_ID = 'xnervwang.claude-code-extras';
const SELF_ID = 'xnervwang.codex-extras';
const CONTEXT_KEY = 'codexExtras.standalone';
/* Set once the source is registered: the Codex session list then shows in the host's own container, so the activity
   bar never carries two icons. Like the standalone key it is unset before activation, so neither copy flashes up. */
const HOSTED_KEY = 'codexExtras.hosted';
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
  // A host past this major has dropped it: the extension to update is this one, not the host.
  const newer = !ok && !!host && Number.isInteger(host.version) && host.version > protocol;
  return { host: ok ? host : null, present: true, newer };
}

/** The host's workPlanHost if it takes `protocol`, or null. */
async function findHost(vscode, protocol = 3) { return (await probeHost(vscode, protocol)).host; }

/** Whether the host offers an optional capability (work plan host protocol, "Compatibility and releases"). */
const hostHas = (host, name) => !!(host && Array.isArray(host.features) && host.features.includes(name));

/*
 * Register `source` with the host if there is one; otherwise mark this window standalone. Resolves to
 * { hosted, registration } where registration is the host's Disposable. Watches for the host being installed or enabled
 * later and calls onHosted(registration) then, so the caller can take its own views down.
 */
async function link(vscode, source, { onHosted = () => {}, log = () => {}, memento = null } = {}) {
  const state = { hosted: false, registration: null, watcher: null, host: null, incompatible: false, hostNewer: false };
  const tryHost = async () => {
    const { host, present, newer } = await probeHost(vscode, source.protocol);
    state.incompatible = present && !host;
    state.hostNewer = !!newer;
    if (!host) return false;
    state.host = host;
    try { state.registration = host.registerSource(source); } catch (e) { log(`workPlanHost.registerSource failed: ${e.message}`); return false; }
    state.hosted = true;
    await vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
    await vscode.commands.executeCommand('setContext', HOSTED_KEY, true);
    return true;
  };
  if (await tryHost()) return state;
  await vscode.commands.executeCommand('setContext', HOSTED_KEY, false);
  await vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);
  if (state.incompatible && memento && !memento.get(TOLD_KEY)) {
    await memento.update(TOLD_KEY, true);
    const [message, button, id] = state.hostNewer
      ? ['Update Codex Extras to its newest version: Claude Code Extras no longer takes this version, so until then each '
        + 'shows its own work plan sidebar and Conversations tab.', 'Update Codex Extras', SELF_ID]
      : ['Update Claude Code Extras to its newest version to share one work plan sidebar and one Conversations tab with '
        + 'Codex Extras. Until then each extension shows its own.', 'Update Claude Code Extras', HOST_ID];
    Promise.resolve(vscode.window.showInformationMessage(message, button)).then((pick) => {
      // For an installed extension this command installs the newest marketplace version, that is, it updates it.
      if (pick === button) return vscode.commands.executeCommand('workbench.extensions.installExtension', id);
      return undefined;
    }).catch((e) => log(`updating ${id} failed: ${e.message}`));
  }
  state.watcher = vscode.extensions.onDidChange(async () => {
    if (state.hosted) return;
    if (await tryHost()) { log('claude-code-extras is now the host of the work plan views'); onHosted(state.registration); }
  });
  return state;
}

module.exports = { HOST_ID, CONTEXT_KEY, HOSTED_KEY, TOLD_KEY, probeHost, findHost, hostHas, link };
