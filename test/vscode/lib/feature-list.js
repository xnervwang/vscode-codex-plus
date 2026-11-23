// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The look run's feature list, ui-look-features.json, and what it names of Agent Plus: under each feature that works
 * through Agent Plus the settings, commands and views of Agent Plus's package.json it uses, and in agentPlusOther the
 * rest, each with why it is not this extension's. test/parts/77-ui-look-features.js holds that against the Agent Plus
 * the suite finds, and the window test against the one it installed.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'ui-look-features.json');
const KINDS = ['settings', 'commands', 'views'];

function load(file = FILE) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { features: d.features, agentPlusOther: d.agentPlusOther || [] };
}

/* What Agent Plus's package.json contributes, by kind. */
function contributed(pkg) {
  const c = (pkg && pkg.contributes) || {};
  const conf = Array.isArray(c.configuration) ? c.configuration : [c.configuration || {}];
  return { settings: conf.flatMap((x) => Object.keys(x.properties || {})), commands: (c.commands || []).map((x) => x.command),
    views: Object.values(c.views || {}).flat().map((v) => v.id) };
}

/*
 * Why the list does not match Agent Plus's package.json `pkg`, one line each, [] when it does: a name listed twice, an
 * entry of agentPlusOther with no why, a name Agent Plus does not have (or not of that kind), and one of Agent Plus's
 * that is listed nowhere.
 */
function agentPlusGaps({ features, agentPlusOther }, pkg) {
  const used = { settings: [], commands: [], views: [] };
  for (const f of features) for (const kind of KINDS) used[kind].push(...(((f.agentPlus || {})[kind]) || []));
  const listed = [...KINDS.flatMap((k) => used[k]), ...agentPlusOther.map((o) => o.key)];
  const gaps = [...new Set(listed)].filter((k) => listed.filter((x) => x === k).length !== 1).map((k) => `${k} is listed more than once`)
    .concat(agentPlusOther.filter((o) => typeof o.why !== 'string' || !o.why.trim()).map((o) => `${o.key} says no why`));
  const has = contributed(pkg);
  const all = KINDS.flatMap((k) => has[k]);
  for (const k of all) if (!listed.includes(k)) gaps.push(`${k} of Agent Plus is not listed`);
  for (const kind of KINDS) for (const k of used[kind]) if (!has[kind].includes(k)) gaps.push(`${k} is not one of Agent Plus's ${kind}`);
  for (const o of agentPlusOther) if (!all.includes(o.key)) gaps.push(`${o.key} is not Agent Plus's`);
  return gaps;
}

module.exports = { load, contributed, agentPlusGaps, FILE };
