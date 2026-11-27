// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Runs last: checks that every notification this extension showed in the parts before it, through the stand-in
 * vscode (test/fake-vscode.js), started with a timestamp (src/notice-time.js).
 */
const fake = require('../fake-vscode');

module.exports = ({ eq }) => {
  eq(fake.unstamped.slice(0, 5), [], 'every notification shown in the parts before this one starts with its time');
};
