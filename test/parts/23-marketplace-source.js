// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Installing when Codex already holds a marketplace of the same name from another source, as it does after the
 * extension was installed under another id: Codex 26.1021's app-server refuses marketplace/add with "is already added
 * from a different source; remove it before adding this source". The stand-in codex below gives that answer while the
 * registered source differs from the one asked for, and records every request it was sent.
 */
const fs = require('fs');
const path = require('path');

const FAKE_APP_SERVER = `'use strict';
const fs = require('fs');
const path = require('path');
const home = process.env.CODEX_HOME;
const log = path.join(home, 'requests.jsonl');
const registered = path.join(home, 'registered-source');
let buf = '';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
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
    fs.appendFileSync(log, msg.method + '\\n');
    if (msg.method === 'marketplace/add') {
      const had = fs.existsSync(registered) ? fs.readFileSync(registered, 'utf8') : '';
      if (had && had !== msg.params.source) {
        send({ id: msg.id, error: { code: -32600, message: "marketplace 'codex-extras' is already added from a different source; remove it before adding this source" } });
        continue;
      }
      fs.writeFileSync(registered, msg.params.source);
      send({ id: msg.id, result: { installedRoot: msg.params.source } });
    } else if (msg.method === 'marketplace/remove') {
      fs.rmSync(registered, { force: true });
      send({ id: msg.id, result: {} });
    } else if (msg.method === 'config/batchWrite') send({ id: msg.id, result: { status: 'ok' } });
    else send({ id: msg.id, result: {} });
  }
});
`;

module.exports = async ({ eq, note, tmp }) => {
  if (process.platform === 'win32') { note('the stand-in codex is a shell script, so this is not run on Windows'); return; }
  const install = require('../../src/plugin-install');
  const bin = tmp('fake-codex-source');
  fs.writeFileSync(path.join(bin, 'app-server.js'), FAKE_APP_SERVER);
  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, 'app-server.js'))}\n`);
  fs.chmodSync(codex, 0o755);

  const home = tmp('codex-home-source');
  fs.writeFileSync(path.join(home, 'registered-source'), '/elsewhere/xnervwang.codex-extras/marketplace');
  const stage = tmp('stage-source');
  const r = await install.install({ binary: codex, home, stage });
  const sent = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').filter((m) => m.includes('/'));
  eq(sent, ['marketplace/add', 'marketplace/remove', 'marketplace/add', 'plugin/install', 'config/batchWrite'],
    'a marketplace of the same name from another source is removed and this one added, then the plugin installed');
  eq([fs.readFileSync(path.join(home, 'registered-source'), 'utf8'), r.marketplace], [stage, stage],
    'and Codex is left holding this extension\'s staging directory');

  fs.writeFileSync(path.join(home, 'requests.jsonl'), '');
  await install.install({ binary: codex, home, stage });
  const again = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').filter((m) => m.includes('/'));
  eq(again, ['marketplace/add', 'plugin/install', 'config/batchWrite'], 'once it is this source, nothing is removed');
};
