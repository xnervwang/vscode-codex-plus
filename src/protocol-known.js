// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The ways Codex can make a conversation wait that this extension knows of, in two lists that each new Codex release
 * is checked against: the requests its app-server sends to its client, and the question tool names its page knows.
 * Each entry says where it is handled, or why it is left alone. Both lists are taken from Codex 26.1021.22027.
 *
 * test/against-latest.js downloads the newest Codex from the marketplace and fails on any request or tool name that is
 * not in its list. Without that, a new kind of wait would only show up as a conversation that never says it is
 * waiting. That is how request_user_input_async went unnoticed: it is a tool rather than an app-server request, so a
 * check that only knew the requests could not see it.
 */
const fs = require('fs');
const path = require('path');

const SERVER_REQUESTS = {
  'item/commandExecution/requestApproval': { handled: 'counted as waiting (src/approvals.js APPROVALS)' },
  'item/fileChange/requestApproval': { handled: 'counted as waiting (src/approvals.js APPROVALS)' },
  'item/permissions/requestApproval': { handled: 'counted as waiting (src/approvals.js APPROVALS)' },
  execCommandApproval: { handled: 'counted as waiting, the older protocol (src/approvals.js APPROVALS)' },
  applyPatchApproval: { handled: 'counted as waiting, the older protocol (src/approvals.js APPROVALS)' },
  'item/tool/requestUserInput': { handled: 'counted as waiting, unless Codex answers it itself (src/approvals.js ASKS)' },
  'mcpServer/elicitation/request': { handled: 'counted as waiting, unless Codex answers it itself (src/approvals.js ASKS)' },
  'item/tool/call': { ignored: 'a dynamic tool call, which Codex\'s own host runs and answers' },
  'account/chatgptAuthTokens/refresh': { ignored: 'a sign-in token refresh, which Codex\'s own host answers' },
  'attestation/generate': { ignored: 'a device attestation, which Codex\'s own host answers' },
};

const QUESTION_TOOLS = {
  request_user_input: { handled: 'through its app-server request, item/tool/requestUserInput' },
  request_user_input_async: { handled: 'read from the rollout once its turn ends (src/codex-files.js ASYNC_QUESTION)' },
  request_user_input_response: { ignored: 'only inside codex_request_user_input_response, the key an answer carries, not a question' },
};

/** The methods of every request in a ServerRequest.json that `codex app-server generate-json-schema` wrote in `dir`. */
function serverRequestMethods(dir) {
  const schema = JSON.parse(fs.readFileSync(path.join(dir, 'ServerRequest.json'), 'utf8'));
  const out = [];
  for (const v of schema.oneOf || schema.anyOf || []) {
    const m = (v.properties || {}).method || {};
    for (const name of m.enum || (m.const ? [m.const] : [])) if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Every name starting request_user_input in `text`, once each. */
function questionToolNames(text) {
  return [...new Set(String(text).match(/request_user_input[a-z_]*/g) || [])];
}

/** The names of `names` that `list` does not have. */
function unknown(names, list) {
  return names.filter((n) => !Object.prototype.hasOwnProperty.call(list, n));
}

module.exports = { SERVER_REQUESTS, QUESTION_TOOLS, serverRequestMethods, questionToolNames, unknown };
