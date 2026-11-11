// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Fetches the Codex build the marketplace is shipping now and checks every edit of the patch against it, before the
 * update reaches anyone. It then compares what that build can make a conversation wait on with the lists in
 * src/protocol-known.js: every request its app-server can send to its client, as its own codex program lists them, and
 * every question tool name in its page. It unpacks those files into a temporary folder and installs nothing.
 *
 *   node test/against-latest.js            the newest release
 *   CODEX_EXTRAS_PRERELEASE=1 node ...     the newest version, pre-releases included
 *
 * Exits 1 when an edit does not match exactly once, the result does not parse, or a request or a question tool name is
 * not in its list. The codex program is run only when PLATFORM below is this machine's own. It cannot check what the
 * page script relies on at run time: that is messages, with no text in the files to match them against.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const host = require('../src/host');
const page = require('../src/webview-inject');
const manifest = require('../src/manifest');
const supported = require('../src/supported');
const known = require('../src/protocol-known');
const { codexBinary } = require('../src/appserver');

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
    execFileSync('unzip', ['-q', vsix, 'extension/out/extension.js', 'extension/webview/index.html', 'extension/package.json', '-d', work], { stdio: 'ignore' });
    const dir = path.join(work, 'extension');
    const h = host.patchSource(fs.readFileSync(host.targetFile(dir), 'utf8'));
    if (h.error) { failed++; console.log(`FAIL  host: ${h.error}`); } else console.log(`ok    host: every edit matches once (${h.chosen.map((c) => c.name).join(', ')}) and parses`);
    const p = page.patchSource(fs.readFileSync(page.targetFile(dir), 'utf8'));
    if (p.error) { failed++; console.log(`FAIL  page: ${p.error}`); } else console.log('ok    page: the script tag goes in ahead of the entry script');
    const m = manifest.patchSource(fs.readFileSync(manifest.targetFile(dir), 'utf8'));
    if (m.error) { failed++; console.log(`FAIL  manifest: ${m.error}`); } else console.log('ok    manifest: the tab bar button gets its "when", and the result is JSON');
    /* What it can wait on. A name in neither list fails, printed so that it can be looked up and added to one. */
    try {
      execFileSync('unzip', ['-q', vsix, 'extension/webview/assets/*.js', 'extension/bin/*/codex', 'extension/bin/*/codex.exe', '-d', work], { stdio: 'ignore' });
    } catch (_) { /* a pattern matching nothing, the .exe on any platform but Windows, is not an error here */ }
    const assets = path.join(dir, 'webview', 'assets');
    const text = fs.readdirSync(assets).filter((n) => n.endsWith('.js')).map((n) => fs.readFileSync(path.join(assets, n), 'utf8')).join('\n');
    const tools = known.questionToolNames(text), newTools = known.unknown(tools, known.QUESTION_TOOLS);
    if (newTools.length) { failed++; console.log(`FAIL  question tools: the page knows ${newTools.join(', ')}, in neither list of src/protocol-known.js`); }
    else console.log(`ok    question tools: ${tools.join(', ')}, each handled or left alone on purpose`);
    const binary = PLATFORM === `${process.platform}-${process.arch}` ? codexBinary(dir) : '';
    if (!binary) console.log(`note  requests: no codex program for this machine in the ${PLATFORM} package, so its app-server requests were not listed`);
    else {
      const out = path.join(work, 'schema');
      try {
        fs.chmodSync(binary, 0o755);
        execFileSync(binary, ['app-server', 'generate-json-schema', '--out', out],
          { env: { ...process.env, CODEX_HOME: path.join(work, 'codex-home') }, stdio: 'ignore', timeout: 120000 });
        const methods = known.serverRequestMethods(out), newMethods = known.unknown(methods, known.SERVER_REQUESTS);
        if (!methods.length) { failed++; console.log('FAIL  requests: ServerRequest.json lists none, so the list could not be checked'); }
        else if (newMethods.length) { failed++; console.log(`FAIL  requests: the app-server can also send ${newMethods.join(', ')}, in neither list of src/protocol-known.js`); }
        else console.log(`ok    requests: all ${methods.length} the app-server can send its client are handled or left alone on purpose`);
      } catch (e) { failed++; console.log(`FAIL  requests: the codex program did not write its protocol: ${String(e.message).split('\n')[0]}`); }
    }
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
