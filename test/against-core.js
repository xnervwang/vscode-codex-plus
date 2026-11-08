// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Checks this extension against the Agent Work Plan build the marketplace is shipping now: whether it accepts the Codex
 * source's protocol major, as its package.json states under "agentWorkPlan". It only reads the marketplace; nothing is
 * installed.
 *
 *   node test/against-core.js
 *
 * Exit 0 when it accepts this major, or when Agent Work Plan is not on the marketplace yet (said so); 1 when it does not
 * accept it; 2 when the marketplace could not be read.
 */
const { PROTOCOL } = require('../src/codex-source');

const QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const CORE_ID = 'xnervwang.agent-work-plan';
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

(async () => {
  const res = await fetchRetrying(QUERY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: CORE_ID }], pageNumber: 1, pageSize: 1 }], flags: 0x2 | 0x80 | 0x200 }),
  });
  if (!res.ok) throw new Error(`marketplace query returned ${res.status}`);
  const body = await res.json();
  const ext = body.results && body.results[0] && body.results[0].extensions && body.results[0].extensions[0];
  if (!ext) { console.log(`skip  ${CORE_ID} is not on the marketplace yet, so there is nothing to check against`); return 0; }
  const version = (ext.versions || [])[0];
  const asset = version && (version.files || []).find((f) => f.assetType === 'Microsoft.VisualStudio.Code.Manifest');
  if (!asset) throw new Error('the newest version carries no manifest');
  const manifest = await (await fetchRetrying(asset.source)).json();
  const accepts = (manifest.agentWorkPlan && manifest.agentWorkPlan.accepts) || [];
  console.log(`${CORE_ID} ${version.version} on the marketplace accepts protocol ${JSON.stringify(accepts)}`);
  if (accepts.includes(PROTOCOL)) { console.log(`ok    it accepts protocol ${PROTOCOL}`); return 0; }
  console.log(`FAIL  it does not accept protocol ${PROTOCOL}`);
  return 1;
})().then((code) => process.exit(code), (e) => { console.error(`could not check against Agent Work Plan: ${e.message}`); process.exit(2); });
