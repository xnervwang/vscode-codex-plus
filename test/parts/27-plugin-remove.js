// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * "Remove the Work Plan Plugin from Codex" when Codex does not do what it is asked. The removal is three requests to
 * Codex's app-server: plugin/uninstall, marketplace/remove, and a config write taking away the trust given to the
 * hooks. Whether they worked is read back from what each one removes: the plugin in Codex's cache, the marketplace's
 * entry in config.toml and the hooks' entries under hooks.state, shaped as Codex writes them.
 *
 * The stand-in codex program answers each request with an error or does what Codex does with it, as the test says.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const FAKE_APP_SERVER = `'use strict';
const fs = require('fs');
const path = require('path');
const home = process.env.CODEX_HOME;
const failing = (process.env.FAKE_CODEX_FAIL || '').split(',').filter(Boolean);
let buf = '';
const answer = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
const refuse = (id, message) => process.stdout.write(JSON.stringify({ id, error: { code: -32603, message } }) + '\\n');
const config = path.join(home, 'config.toml');
const keep = (test) => { try { fs.writeFileSync(config, fs.readFileSync(config, 'utf8').split('\\n\\n').filter((s) => !test(s)).join('\\n\\n')); } catch (_) {} };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (failing.includes(msg.method)) { refuse(msg.id, msg.method + ' failed in the stand-in'); continue; }
    if (msg.method === 'plugin/uninstall') fs.rmSync(path.join(home, 'plugins', 'cache', 'codex-extras'), { recursive: true, force: true });
    if (msg.method === 'marketplace/remove') keep((s) => s.startsWith('[marketplaces.codex-extras]'));
    if (msg.method === 'config/batchWrite') keep((s) => s.startsWith('[hooks.state."agent-work-plan@codex-extras:'));
    answer(msg.id, msg.method === 'config/batchWrite' ? { status: 'ok' } : {});
  }
});
`;

module.exports = async ({ eq, note, tmp, root }) => {
  if (process.platform === 'win32') { note('the stand-in codex is a shell script, so the removal is not run here'); return; }
  const install = require('../../src/plugin-install');
  const bin = tmp('fake-codex-remove');
  fs.writeFileSync(path.join(bin, 'app-server.js'), FAKE_APP_SERVER);
  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, 'app-server.js'))}\n`);
  fs.chmodSync(codex, 0o755);
  const homeWithPlugin = (label) => {
    const home = tmp(label);
    fs.mkdirSync(path.join(install.cacheDir(home), install.pluginVersion(), '.codex-plugin'), { recursive: true });
    const key = install.hookKeys()[0];
    fs.writeFileSync(path.join(home, 'config.toml'), [`[marketplaces.${install.MARKETPLACE}]\nsource = "/somewhere"`,
      `[plugins."${install.PLUGIN_ID}"]\nenabled = true`, `[hooks.state."${key}"]\ntrusted_hash = "sha256:00"`].join('\n\n') + '\n');
    return home;
  };
  const tryRemove = async (home, fail) => {
    process.env.FAKE_CODEX_FAIL = fail.join(',');
    try { await install.uninstall({ binary: codex, home }); return 'removed'; } catch (e) { return e.message; } finally { delete process.env.FAKE_CODEX_FAIL; }
  };

  eq(await tryRemove(homeWithPlugin('remove-works'), []), 'removed', 'a removal Codex carries out reports success');
  const refused = await tryRemove(homeWithPlugin('remove-refused'), ['plugin/uninstall']);
  eq([refused !== 'removed', /still in Codex/.test(refused), /plugin\/uninstall failed in the stand-in/.test(refused)], [true, true, true],
    'one where Codex refuses to uninstall the plugin is an error, saying what is left and what Codex said');
  const half = await tryRemove(homeWithPlugin('remove-half'), ['marketplace/remove']);
  eq([half !== 'removed', /marketplace/.test(half)], [true, true], 'and so is one that leaves the marketplace registered');
  const trust = await tryRemove(homeWithPlugin('remove-trust'), ['config/batchWrite']);
  eq([trust !== 'removed', /trust/.test(trust)], [true, true], 'or the trust given to the hooks');

  /* There is no command for it: uninstalling the extension takes the plugin out (uninstall.js, test/parts/24-uninstall-plugin.js). */
};
