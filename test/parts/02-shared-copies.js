// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Runs Agent Plus's shared copy check (test/shared-copies.js) on the files listed in shared.json: a copy edited here
 * fails, and a source that has changed in an Agent Plus checkout beside this one is noted.
 */
module.exports = async (h) => { await require('../shared-copies.js')(h, h.root); };
