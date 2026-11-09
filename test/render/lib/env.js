// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What the render check needs from this machine, none of which is in the repository: a headless Chromium, a kernel
 * that lets an unprivileged user make a namespace with no network, and an installed Codex extension with its codex
 * program and its webview. find() returns them, or the list of what is missing.
 */
const fs = require('fs');
const path = require('path');
const { findChrome } = require('./cdp');
const { offlineProblem } = require('./app-server');
const page = require('./codex-page');
const { codexBinary } = require('../../../src/appserver');

function find({ codexDir = '' } = {}) {
  const missing = [];
  const chrome = findChrome();
  if (!chrome) missing.push('a headless Chromium: none in ~/.cache/ms-playwright/chromium_headless_shell-*, and CHROME is not set '
    + '(`npx playwright install chromium-headless-shell` puts one there)');
  const offline = offlineProblem();
  if (offline) missing.push(`a namespace with no network for Codex's app-server: ${offline}`);
  let codex = null;
  const installs = codexDir ? [{ dir: path.resolve(codexDir), version: readVersion(codexDir) }] : page.codexInstalls();
  if (!installs.length || !installs[0].version) missing.push('an installed Codex extension (openai.chatgpt) under ~/.vscode-server/extensions or ~/.vscode/extensions');
  else {
    const { dir, version } = installs[0];
    const binary = codexBinary(dir);
    if (!binary) missing.push(`the codex program of ${dir}`);
    codex = { dir, version, binary };
  }
  let capnweb = '';
  if (codex) {
    capnweb = page.capnwebAsset(codex.dir);
    if (!capnweb) missing.push(`Codex's capnweb module in ${path.join(codex.dir, 'webview', 'assets')} (an asset holding encodingLevel and getRemoteMain)`);
  }
  return { missing, chrome, codex, capnweb };
}

function readVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || ''; } catch (_) { return ''; }
}

module.exports = { find };
