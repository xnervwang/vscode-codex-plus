// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The reader's time zone reaches Agent Plus through the protocol's timeZone(): Codex's page reports the zone it runs
 * in, and the registered source returns it, so the work plan view shows times in that zone instead of the zone of the
 * machine running the extension host. The answer is read with the core's own timeZoneOf, from its checkout, since that
 * is what the core accepts.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

module.exports = async ({ eq, note, tmp, root }) => {
  const core = process.env.AGENT_WORK_PLAN_DIR || path.join(root, '..', 'vscode-agent-plus');
  const coreSources = path.join(core, 'src', 'sources.js');
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  let source = null;
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: (s) => { source = s; return { accepted: true, code: '', reason: '', registration: { dispose() {} } }; } } } });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  try {
    eq(source.timeZone(), '', 'before Codex\'s page has said anything, the source knows no zone');
    globalThis.__codexExtrasMessage({}, { type: 'codex-extras', kind: 'tz', timeZone: 'America/Los_Angeles' }, {});
    await new Promise((r) => setTimeout(r, 20));
    eq(source.timeZone(), 'America/Los_Angeles', 'once it has, the source answers with the zone it reported');
    if (!fs.existsSync(coreSources)) { note(`no Agent Plus checkout at ${core}, so the core's own reading of it was not run`); return; }
    eq(require(coreSources).timeZoneOf(source), 'America/Los_Angeles', 'and Agent Plus takes that answer as the reader\'s zone');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
