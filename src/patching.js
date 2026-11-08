// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The patch to Codex's own extension: placeholder until the patch engine is wired in. With nothing patched, nothing can
 * be typed into a conversation or opened in Codex's sidebar, and the status says so.
 */
let state = { active: false, reason: 'not wired in yet' };

function activate() { return state; }
function statusLines() { return [`Patch to Codex: ${state.active ? 'in place' : 'none'} (${state.reason})`]; }
async function openInSidebar() { return false; }
function canType() { return false; }

module.exports = { activate, statusLines, openInSidebar, canType };
