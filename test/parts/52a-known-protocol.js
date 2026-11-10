// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The lists in src/protocol-known.js: every request Codex's app-server sends to
 * its client, and every question tool name in Codex's page, each marked as handled or deliberately left alone. This
 * checks that what is marked handled is recognised by the code it names, and, when a Codex is installed here, that its
 * codex program lists no request and its page no tool name missing from the lists. test/against-latest.js runs the
 * same comparison on the newest Codex in the marketplace.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async ({ eq, note, tmp }) => {
  const known = require('../../src/protocol-known');
  const { waitOf } = require('../../src/approvals');
  const files = require('../../src/codex-files');

  const params = { threadId: 't1', conversationId: 't1', isBlocking: true };
  const handled = Object.entries(known.SERVER_REQUESTS).filter(([, v]) => v.handled).map(([m]) => m);
  const ignored = Object.entries(known.SERVER_REQUESTS).filter(([, v]) => v.ignored).map(([m]) => m);
  eq([handled.length + ignored.length, Object.keys(known.SERVER_REQUESTS).length], [10, 10],
    'the ten requests Codex 26.1021.22027 makes of its client are each marked handled or left alone, with a reason');
  eq(handled.filter((m) => !waitOf({ id: 1, method: m, params })), [], 'every request marked handled is one src/approvals.js counts as waiting');
  eq(ignored.filter((m) => waitOf({ id: 1, method: m, params })), [], 'and none marked left alone is counted there by accident');
  eq([known.QUESTION_TOOLS.request_user_input_async.handled && files.ASYNC_QUESTION === 'request_user_input_async',
    !!known.QUESTION_TOOLS.request_user_input.handled && !!waitOf({ id: 1, method: 'item/tool/requestUserInput', params })], [true, true],
  'the question that does not wait is read where src/codex-files.js looks for it, and the one that does through its app-server request');
  eq(known.unknown(known.questionToolNames('a request_user_input and request_user_input_async, then request_user_input_later'), known.QUESTION_TOOLS),
    ['request_user_input_later'], 'a question tool name in neither list is found and named');

  /* ── against the Codex installed here, when there is one ── */
  const roots = [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')];
  const dir = roots.flatMap((r) => { try { return fs.readdirSync(r).filter((n) => /^openai\.chatgpt-/.test(n)).map((n) => path.join(r, n)); } catch (_) { return []; } }).sort().pop();
  const binary = dir ? require('../../src/appserver').codexBinary(dir) : '';
  if (!binary) { note('no Codex is installed here, so its own lists were not compared'); return; }
  const out = tmp('schema');
  try {
    execFileSync(binary, ['app-server', 'generate-json-schema', '--out', out], { env: { ...process.env, CODEX_HOME: tmp('schema-home') }, stdio: 'ignore', timeout: 60000 });
  } catch (e) { note(`the installed codex could not write its protocol (${e.message.split('\n')[0]}), so it was not compared`); return; }
  const methods = known.serverRequestMethods(out);
  eq([methods.length > 0, known.unknown(methods, known.SERVER_REQUESTS)], [true, []],
    `every request the installed Codex (${path.basename(dir)}) can make of its client is in the list`);
  const assets = path.join(dir, 'webview', 'assets');
  const text = fs.readdirSync(assets).filter((n) => n.endsWith('.js')).map((n) => fs.readFileSync(path.join(assets, n), 'utf8')).join('\n');
  eq(known.unknown(known.questionToolNames(text), known.QUESTION_TOOLS), [], 'and every question tool name in its page is too');
};
