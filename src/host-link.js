// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Registering the Codex source with Agent Plus (xnervwang.agent-plus), which draws the work plan,
 * Conversations and Answer views; its docs/protocol.md is the contract.
 *
 * Agent Plus is in extensionDependencies, so VS Code activates it before this extension and its exports are there
 * at once. The registration result says whether the source was taken: only then does codexPlus.registered turn on,
 * which the views Agent Plus draws for this source depend on. The session list has its own container and does not
 * wait for it. When the protocol majors do not match, Agent Plus itself tells the user which extension to update (it
 * knows its own versions and the gallery's); this extension says something only when there is no interface to register
 * with at all.
 */
const CORE_ID = 'xnervwang.agent-plus';
const REGISTERED_KEY = 'codexPlus.registered';
const TOLD_KEY = 'codexPlus.toldNoCore';

/* The agentPlus interface, or null with the reason. */
async function findCore(vscode) {
  const ext = vscode.extensions.getExtension(CORE_ID);
  if (!ext) return { core: null, why: 'Agent Plus is not installed or not enabled' };
  let api;
  try { api = ext.isActive ? ext.exports : await ext.activate(); } catch (e) { return { core: null, why: `Agent Plus did not start: ${(e && e.message) || e}` }; }
  const core = api && api.agentPlus;
  if (!core || typeof core.registerSource !== 'function') return { core: null, why: 'Agent Plus has no agentPlus interface' };
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
    log(`not registered with Agent Plus: ${why}`);
    await setKey(false);
    const key = `${TOLD_KEY}:${why}`;
    if (memento && !memento.get(key)) {
      await memento.update(key, true);
      const open = 'Show Agent Plus';
      Promise.resolve(vscode.window.showWarningMessage(`Codex Plus shows its conversations through Agent Plus, and ${why}. `
        + 'Install or update it.', open)).then((pick) => (pick === open ? vscode.commands.executeCommand('extension.open', CORE_ID) : undefined))
        .catch((e) => log(`opening Agent Plus's page failed: ${e.message}`));
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
  log(`Agent Plus did not take the Codex source (${code}): ${reason}`);
  await setKey(false);
  return { registered: false, registration: null, code, reason, core };
}

module.exports = { CORE_ID, REGISTERED_KEY, TOLD_KEY, findCore, coreHas, link };
