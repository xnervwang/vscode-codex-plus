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
const { CORE_ID, findCore, coreHas, link: linkCore } = require('./core-link');

const REGISTERED_KEY = 'codexPlus.registered';
const TOLD_KEY = 'codexPlus.toldNoCore';

/*
 * Registers `source`. Resolves to { registered, registration, code, reason, core }. `memento` keeps the one notice
 * shown when there is no interface at all.
 */
function link(vscode, source, { log = () => {}, memento = null } = {}) {
  const tell = (why) => {
    const open = 'Show Agent Plus';
    Promise.resolve(vscode.window.showWarningMessage(`Codex Plus shows its conversations through Agent Plus, and ${why}. `
      + 'Install or update it.', open)).then((pick) => (pick === open ? vscode.commands.executeCommand('extension.open', CORE_ID) : undefined))
      .catch((e) => log(`opening Agent Plus's page failed: ${e.message}`));
  };
  return linkCore(vscode, source, { name: 'the Codex source', log, contextKey: REGISTERED_KEY, memento, toldKey: TOLD_KEY, tell });
}

module.exports = { CORE_ID, REGISTERED_KEY, TOLD_KEY, findCore, coreHas, link };
