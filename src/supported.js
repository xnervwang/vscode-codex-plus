// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which Codex builds this extension has been verified against, kept in the repository (src/supported-versions.json) so
 * that the answer can be looked up per commit rather than remembered.
 *
 * The question it exists to answer is "was any of this ever run against the Codex I am on". Nothing else here can
 * answer it. Everything this extension does to Codex is fitted to one build's shape: the host patch matches four places
 * in Codex's own bundle by the code around them, the page script hangs its marks on Codex's `data-*` attributes, and the
 * conversation list reads columns out of Codex's state database. Codex ships weekly and none of those three are an API.
 *
 * WHAT AN ENTRY CLAIMS is that somebody ran the checks against that build and they passed - not that the rules merely
 * looked plausible. Each field is a separate claim, because the three failure modes are independent and they fail
 * differently:
 *
 *   hostEdits      the four edits of the host patch, by name, each matching exactly once on a pristine bundle. This one
 *                  fails loudly: the patch is all or nothing, so a rule that stops matching leaves Codex untouched.
 *   pagePatch      the script tag goes into Codex's page ahead of its entry script.
 *   stateDb        the state database file name. A new one is a new file, so the old one is simply not there.
 *   threadColumns  the columns read from the `threads` table. Missing ones are dropped from the query rather than
 *                  failing it, so losing one costs a field in the list and says nothing.
 *   pageAnchors    Codex's own `data-*` attributes the page script finds its way around by. This is the quiet one: an
 *                  attribute that is renamed upstream matches nothing, and the marks simply do not appear.
 *
 * A build that is not listed is NOT a build that is known to be broken, which is why nothing here raises a dialog. The
 * patch refuses rather than half-applies, so the cost of being on an unrecorded build is already covered; what is worth
 * saying is only that no one has checked this one, and the place to say it is the log and the status command.
 *
 * Dates are kept per entry, unlike the same record in claude-code-extras, which deliberately has none. There the file
 * was rewritten from the machine on every run, so a timestamp produced a diff on every commit and nobody read them.
 * This one is written by hand when somebody checks a build, so the date changes only when a claim does.
 */
const fs = require('fs');
const path = require('path');

const RECORD_FILE = path.join(__dirname, 'supported-versions.json');
const EMPTY = { codex: {} };

/** Semantic order, so 26.9.1 sorts before 26.10.1 rather than after it the way strings would. */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** The record as committed. An absent or unreadable file reads as nothing recorded, which is a valid state. */
function read(file = RECORD_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && parsed.codex && typeof parsed.codex === 'object') return { codex: parsed.codex };
  } catch (_) { /* absent or unreadable is the same as nothing recorded */ }
  return EMPTY;
}

/** Recorded builds, oldest first. */
function versions(record = read()) {
  return Object.keys(record.codex).sort(cmpVersion);
}

function entry(version, record = read()) {
  return (version && record.codex[version]) || null;
}

function verified(version, record = read()) {
  return !!entry(version, record);
}

const FIELDS = [
  ['hostEdits', 'the host patch'],
  ['threadColumns', 'the state database columns'],
  ['pageAnchors', "Codex's page attributes"],
];

/* What was checked on one build, as one clause: "the host patch (4), ...". */
function checkedParts(e) {
  const parts = [];
  for (const [key, said] of FIELDS) {
    const list = Array.isArray(e[key]) ? e[key] : [];
    if (list.length) parts.push(`${said} (${list.length})`);
  }
  if (e.pagePatch) parts.push('the page patch');
  if (e.stateDb) parts.push(e.stateDb);
  return parts.join(', ');
}

/**
 * The lines the status command prints about this. Always at least one: a reader looking at the status wants to know
 * where this build stands, and saying nothing when it is recorded would leave that unanswered.
 */
function statusLines(version, record = read()) {
  const all = versions(record);
  const list = all.length ? all.join(', ') : 'none';
  if (!version) return [`Verified against Codex: ${list} (which Codex is installed could not be read)`];
  const e = entry(version, record);
  if (e) {
    return [`Verified against Codex: this build, ${version}, on ${e.checked || 'an unrecorded date'}`,
      `  checked: ${checkedParts(e) || '(nothing recorded)'}`,
      `  others recorded: ${all.filter((v) => v !== version).join(', ') || 'none'}`];
  }
  return [`Verified against Codex: NOT this build. Codex ${version} is not in src/supported-versions.json`,
    `  recorded: ${list}`,
    '  the patch refuses rather than half-applies, so this is a note, not a fault'];
}

/** The single line for the log when the installed build is unrecorded, or '' when there is nothing to say. */
function noticeLine(version, record = read()) {
  if (!version || verified(version, record)) return '';
  const all = versions(record);
  return `Codex ${version} is not among the builds this extension has been verified against `
    + `(${all.join(', ') || 'none recorded'}). Nothing is disabled by that: the patch matches Codex's own code by shape `
    + 'and refuses as a whole if it does not fit, and "Codex Extras: Show Status" says where each piece stands.';
}

module.exports = { RECORD_FILE, read, versions, entry, verified, statusLines, noticeLine, cmpVersion, checkedParts, FIELDS };
