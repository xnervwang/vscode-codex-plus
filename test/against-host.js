// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Checks this extension against the claude-code-extras build the marketplace is shipping now (the work plan host
 * protocol, "Compatibility and releases"): whether it accepts this source's protocol major, and whether both sides
 * understand each other's answer files. It only reads the marketplace and unpacks into a temporary folder; nothing is
 * installed.
 *
 *   node test/against-host.js
 *
 * A build without workPlanHost is not a failure: Codex Extras then draws its own views, which is the expected outcome
 * until claude-code-extras ships the API. It fails when the host has the API and does not accept this major, or when
 * the two answer formats differ.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PROTOCOL } = require('../src/codex-source');
const { FORMAT } = require('../src/answers');

const QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const HOST_ID = 'xnervwang.claude-code-extras';
const ATTEMPTS = 3;

async function fetchRetrying(url, init) {
  let err;
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i) await new Promise((done) => setTimeout(done, 5000 * i));
    try {
      const res = await fetch(url, init);
      if (res.status < 500) return res;
      err = new Error(`status ${res.status}`);
    } catch (e) { err = e; }
  }
  throw err;
}

async function newest() {
  const res = await fetchRetrying(QUERY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: HOST_ID }], pageNumber: 1, pageSize: 1 }], flags: 950 }),
  });
  if (!res.ok) throw new Error(`marketplace query returned ${res.status}`);
  const body = await res.json();
  const ext = body.results && body.results[0] && body.results[0].extensions && body.results[0].extensions[0];
  if (!ext) throw new Error(`the marketplace has no ${HOST_ID}`);
  const version = (ext.versions || [])[0];
  const asset = version && (version.files || []).find((f) => f.assetType.indexOf('VSIXPackage') !== -1);
  if (!asset) throw new Error('the newest version carries no downloadable vsix');
  return { version: version.version, url: asset.source };
}

/* Every .js file of the package, read from a scratch unpack. */
function sources(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) out.push({ file: path.relative(dir, p), text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

(async () => {
  const { version, url } = await newest();
  console.log(`${HOST_ID} ${version} on the marketplace`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-extras-host-'));
  let code = 0;
  try {
    const res = await fetchRetrying(url);
    if (!res.ok) throw new Error(`package download returned ${res.status}`);
    const vsix = path.join(work, 'host.vsix');
    fs.writeFileSync(vsix, Buffer.from(await res.arrayBuffer()));
    execFileSync('unzip', ['-q', vsix, 'extension/extension.js', 'extension/src/*', '-d', work], { stdio: 'ignore' });
    const files = sources(path.join(work, 'extension'));
    const api = files.find((f) => /workPlanHost/.test(f.text));
    if (!api) {
      console.log('ok    the host does not implement the shared interface yet: Codex Extras draws its own views');
      return;
    }
    let failed = 0;
    const m = /majors\s*:\s*\[([^\]]*)\]/.exec(api.text);
    const majors = m ? m[1].split(',').map((x) => Number(x.trim())).filter(Number.isFinite) : [];
    if (majors.includes(PROTOCOL)) console.log(`ok    it accepts protocol major ${PROTOCOL} (majors ${JSON.stringify(majors)}, in ${api.file})`);
    else { failed++; console.log(`FAIL  it does not accept protocol major ${PROTOCOL}: majors ${JSON.stringify(majors)} in ${api.file}`); }
    const answers = files.find((f) => /answers\.js$/.test(f.file));
    const fm = answers && /const FORMAT\s*=\s*(\d+)/.exec(answers.text);
    if (!fm) console.log('note  its answer files carry no format number; they are read as format 1');
    else if (Number(fm[1]) === FORMAT) console.log(`ok    both write and read answer format ${FORMAT}`);
    else { failed++; console.log(`FAIL  its answer format is ${fm[1]}, this extension's is ${FORMAT}`); }
    code = failed ? 1 : 0;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  process.exit(code);
})().catch((e) => { console.error(`could not check against the host: ${e.message}`); process.exit(2); });
