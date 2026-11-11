// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The single list of patch targets in Codex's extension, in the order they are applied. The extension and the uninstall
 * hook both read it from here, so a target added to one cannot be forgotten by the other.
 */
module.exports = [require('./host'), require('./webview-inject'), require('./manifest')];
