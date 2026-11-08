// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Registering the Codex source with Agent Work Plan (xnervwang.agent-work-plan), which draws the work plan,
 * Conversations and Answer views; its docs/protocol.md is the contract.
 *
 * Agent Work Plan is in extensionDependencies, so VS Code activates it before this extension and its exports are there
 * at once. The registration result says whether the source was taken: only then does codexExtras.registered turn on,
 * which the views Agent Work Plan draws for this source depend on. The session list has its own container and does not
 * wait for it. When the protocol majors do not match, Agent Work
 * Plan itself tells the user which extension to update (it knows its own versions and the gallery's); this extension
 * says something only when there is no interface to register with at all.
 */
const CORE_ID = 'xnervwang.agent-work-plan';
const REGISTERED_KEY = 'codexExtras.registered';
const TOLD_KEY = 'codexExtras.toldNoCore';

/* The agentWorkPlan interface, or null with the reason. */
async function findCore(vscode) {
  const ext = vscode.extensions.getExtension(CORE_ID);
  if (!ext) return { core: null, why: 'Agent Work Plan is not installed or not enabled' };
  let api;
  try { api = ext.isActive ? ext.exports : await ext.activate(); } catch (e) { return { core: null, why: `Agent Work Plan did not start: ${(e && e.message) || e}` }; }
  const core = api && api.agentWorkPlan;
  if (!core || typeof core.registerSource !== 'function') return { core: null, why: 'Agent Work Plan has no agentWorkPlan interface' };
  return { core, why: '' };
}

/* Whether the host offers an optional capability by name (protocol, "Adding to the protocol"). */
const coreHas = (core, name) => !!(core && Array.isArray(core.features) && core.features.includes(name));

/*
 * Registers `source`. Resolves to { registered, registration, code, reason, core }. `memento` keeps the one notice
 * shown when there is no interface at all.
 */
async function link(vscode, source, { log = () => {}, memento = null } = {}) {
  const setKey = (on) => Promise.resolve(vscode.commands.executeCommand('setContext', REGISTERED_KEY, on)).catch(() => {});
  const { core, why } = await findCore(vscode);
  if (!core) {
    log(`not registered with Agent Work Plan: ${why}`);
    await setKey(false);
    const key = `${TOLD_KEY}:${why}`;
    if (memento && !memento.get(key)) {
      await memento.update(key, true);
      const open = 'Show Agent Work Plan';
      Promise.resolve(vscode.window.showWarningMessage(`Codex Extras shows its conversations through Agent Work Plan, and ${why}. `
        + 'Install or update it.', open)).then((pick) => (pick === open ? vscode.commands.executeCommand('extension.open', CORE_ID) : undefined))
        .catch((e) => log(`opening Agent Work Plan's page failed: ${e.message}`));
    }
    return { registered: false, registration: null, code: 'no-core', reason: why, core: null };
  }
  let r;
  try { r = core.registerSource(source); } catch (e) { r = { accepted: false, code: 'failed', reason: String((e && e.message) || e) }; }
  if (r && r.accepted === true) {
    await setKey(true);
    return { registered: true, registration: r.registration, code: '', reason: '', core };
  }
  const code = (r && r.code) || 'failed', reason = (r && r.reason) || 'no reason given';
  log(`Agent Work Plan did not take the Codex source (${code}): ${reason}`);
  await setKey(false);
  return { registered: false, registration: null, code, reason, core };
}

module.exports = { CORE_ID, REGISTERED_KEY, TOLD_KEY, findCore, coreHas, link };
