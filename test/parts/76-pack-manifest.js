// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Runs Agent Plus's shared package check (test/pack-check.js) on this repository: the local package against what vsce
 * would publish, the README's images left out of both, and the descriptor files.
 */
module.exports = async (h) => { await require('../pack-check.js')(h, h.root); };
