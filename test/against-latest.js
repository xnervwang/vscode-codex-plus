// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Fetches the Codex build the marketplace is shipping now and checks every edit of the patch against it, before the
 * update reaches anyone. Only the two patched files are unpacked, into a temporary folder; nothing is installed.
 *
 *   node test/against-latest.js            the newest release
 *   CODEX_EXTRAS_PRERELEASE=1 node ...     the newest version, pre-releases included
 *
 * Exits 1 when an edit does not match exactly once or the result does not parse. What it cannot see: anything the page
 * script relies on at run time, which is only messages and so has nothing to match.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const host = require('../src/host');
const page = require('../src/webview-inject');
const supported = require('../src/supported');

const QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const EXTENSION_ID = 'openai.chatgpt';
const PLATFORM = process.env.CODEX_EXTRAS_TARGET_PLATFORM || 'linux-x64';

async function fetchRetrying(url, init) {
  let err;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((done) => setTimeout(done, 5000 * i));
    try {
      const res = await fetch(url, init);
      if (res.status < 500) return res;
      err = new Error(`status ${res.status}`);
    } catch (e) { err = e; }
  }
  throw err;
}

/* Pre-releases are versions whose properties say so; Codex publishes them as 26.5xxx. */
const isPre = (v) => (v.properties || []).some((p) => p.key === 'Microsoft.VisualStudio.Code.PreRelease' && p.value === 'true');

async function newest() {
  const res = await fetchRetrying(QUERY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' },
    // 0x1B6: versions, files, properties and statistics, every version rather than only the newest (0x200), which for
    // Codex is always a pre-release.
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }], pageNumber: 1, pageSize: 1 }], flags: 0x1B6 }),
  });
  if (!res.ok) throw new Error(`marketplace query returned ${res.status}`);
  const body = await res.json();
  const ext = body.results[0].extensions[0];
  const wantPre = !!process.env.CODEX_EXTRAS_PRERELEASE;
  const version = (ext.versions || []).find((v) => v.targetPlatform === PLATFORM && (wantPre || !isPre(v)));
  if (!version) throw new Error(`no ${PLATFORM} package among the published versions`);
  const asset = (version.files || []).find((f) => f.assetType.indexOf('VSIXPackage') !== -1);
  return { version: version.version, url: asset.source, pre: isPre(version) };
}

(async () => {
  const { version, url, pre } = await newest();
  console.log(`${EXTENSION_ID} ${version}${pre ? ' (pre-release)' : ''} for ${PLATFORM}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-extras-latest-'));
  let failed = 0;
  try {
    const res = await fetchRetrying(url);
    if (!res.ok) throw new Error(`package download returned ${res.status}`);
    const vsix = path.join(work, 'codex.vsix');
    fs.writeFileSync(vsix, Buffer.from(await res.arrayBuffer()));
    execFileSync('unzip', ['-q', vsix, 'extension/out/extension.js', 'extension/webview/index.html', '-d', work], { stdio: 'ignore' });
    const dir = path.join(work, 'extension');
    const h = host.patchSource(fs.readFileSync(host.targetFile(dir), 'utf8'));
    if (h.error) { failed++; console.log(`FAIL  host: ${h.error}`); } else console.log(`ok    host: every edit matches once (${h.chosen.map((c) => c.name).join(', ')}) and parses`);
    const p = page.patchSource(fs.readFileSync(page.targetFile(dir), 'utf8'));
    if (p.error) { failed++; console.log(`FAIL  page: ${p.error}`); } else console.log('ok    page: the script tag goes in ahead of the entry script');
    /*
     * This prints rather than fails. The edits matching a build is not the whole of what "verified" claims, and only
     * a machine with that Codex installed can establish the rest (src/supported.js).
     */
    console.log(supported.verified(version)
      ? `ok    record: ${version} is in src/supported-versions.json`
      : `note  record: ${version} is not in src/supported-versions.json (recorded: ${supported.versions().join(', ') || 'none'})`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(`could not check the latest Codex: ${e.message}`); process.exit(2); });
