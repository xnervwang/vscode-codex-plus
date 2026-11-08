// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The patch target in Codex's own extension: its extension-host bundle, out/extension.js.
 *
 * Every edit hands this extension something Codex holds and no API gives out, through a global the two share - both
 * run in one extension host process. Nothing Codex does is changed: each edit only adds a call, wrapped so that a fault
 * on this side can never reach Codex's own code path.
 *
 *   provider instance       Codex's webview provider, which can navigate its sidebar to a conversation
 *                           (navigateToRoute) and post a message to any of its panels (sendMessageToPanel)
 *   conversation panels     each conversation tab's WebviewPanel with its thread id, as Codex opens it: for the dot on
 *                           the tab's logo and for putting text in that conversation's message box
 *   window broadcasts       what this window tells Codex's other windows, among it which threads it is streaming
 *   page messages           messages of type "codex-extras" from the script this extension adds to Codex's page
 *                           (src/webview-inject.js), which Codex's own switch would otherwise drop as unknown
 *
 * Same discipline as claude-code-extras: every edit must match exactly once on a pristine bundle, all or nothing, the
 * result must parse, the untouched original is kept beside the file, the replacement is atomic, and the marker carries
 * a digest of the edits so an older patch is recognised as outdated.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { applyEdits, shapesOf } = require('./edits');

const VERSION = 1;
const ANY_MARK = '/* CODEX-EXTRAS-HOST v';
const BACKUP_SUFFIX = '.codex-extras-host.bak';
const TMP_SUFFIX = '.codex-extras-host.tmp';

/* A call into this extension that can never throw into Codex: `name` is a function this extension puts on globalThis. */
const call = (name, args) => `(()=>{try{globalThis.${name}&&globalThis.${name}(${args})}catch(_cx){}})()`;

const EDITS = [
  {
    name: 'provider instance',
    re: /editorPanels=new Map;/g,
    to: () => 'editorPanels=(globalThis.__codexExtrasProvider=this,new Map);',
  },
  {
    name: 'conversation panels',
    re: /(let\{conversationId:([\w$]+)\}=[\w$]+,[\s\S]{0,1500}?)(this\.editorPanels\.set\(([\w$]+),\{ready:!1,pendingMessages:\[\],initialRoute:)/g,
    to: (m, before, conv, set, panel) => `${before}${call('__codexExtrasPanel', `${panel},${conv},this`)},${set}`,
  },
  {
    name: 'window broadcasts',
    re: /async sendBroadcast\(([\w$]+),([\w$]+),\{targetClientIds:([\w$]+)\}=\{\}\)\{/g,
    to: (m, method, params, targets) => `async sendBroadcast(${method},${params},{targetClientIds:${targets}}={}){${call('__codexExtrasBroadcast', `${method},${params}`)};`,
  },
  {
    name: 'page messages',
    re: /async handleMessage\(([\w$]+),([\w$]+)\)\{switch\(\2\.type\)\{case"ready":break;/g,
    to: (m, webview, msg) => `async handleMessage(${webview},${msg}){switch(${msg}.type){case"codex-extras":{${call('__codexExtrasMessage', `${webview},${msg},this`)};break}case"ready":break;`,
  },
];

const MARK = `/* CODEX-EXTRAS-HOST v${VERSION}-` + crypto.createHash('sha256')
  .update(EDITS.map((e) => [e.name, ...shapesOf(e).map((s) => [String(s.re), String(s.to), s.note || ''].join('\0'))].join('\0')).join('\n'))
  .digest('hex').slice(0, 12) + ' */';

function hostFile(codexExtensionPath) { return path.join(codexExtensionPath, 'out', 'extension.js'); }

/** Pure transform. Returns { out, chosen } or { error }. Never partially applies. */
function patchSource(src) {
  if (src.includes(ANY_MARK)) return { error: 'the source to patch already carries a host patch' };
  const r = applyEdits(src, EDITS);
  if (r.error) return { error: r.error };
  const out = MARK + '\n' + r.out;
  try { new vm.Script(out, { filename: 'extension.js' }); }
  catch (err) { return { error: `patched host code does not parse: ${err.message}` }; }
  return { out, chosen: r.chosen };
}

/** 'patched' (this version), 'outdated' (another version of this patch), 'clean', 'missing'. */
function status(codexExtensionPath) {
  const file = hostFile(codexExtensionPath);
  if (!fs.existsSync(file)) return 'missing';
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARK)) return 'patched';
  if (src.includes(ANY_MARK)) return 'outdated';
  return 'clean';
}

/* A temporary name per process with a random part: every window patches the same file. */
function writeAtomic(file, text) {
  const tmp = `${file}${TMP_SUFFIX}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
    throw e;
  }
}

/* Apply or upgrade. Returns { changed, current, message }; `current` means the file carries this patch. */
function apply(codexExtensionPath) {
  const file = hostFile(codexExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  const state = status(codexExtensionPath);
  const no = (message) => ({ changed: false, current: false, message });
  if (state === 'missing') return no(`Codex host bundle not found at ${file}`);
  if (state === 'patched') return { changed: false, current: true, message: 'already patched' };
  let original;
  if (state === 'outdated') {
    if (!fs.existsSync(backup)) return no('an older patch is present but its backup is missing; reinstall Codex');
    original = fs.readFileSync(backup, 'utf8');
    if (original.includes(ANY_MARK)) return no('an older patch is present and its backup carries one too; reinstall Codex');
  } else {
    original = fs.readFileSync(file, 'utf8');
  }
  const r = patchSource(original);
  if (r.error) return no(r.error);
  if (state === 'clean') fs.writeFileSync(backup, original);
  writeAtomic(file, r.out);
  return { changed: true, current: true, message: 'patched' };
}

/** Put the original bundle back and remove the backup. */
function restore(codexExtensionPath) {
  const file = hostFile(codexExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) return { changed: false, message: 'nothing to restore' };
  const original = fs.readFileSync(backup, 'utf8');
  if (original.includes(ANY_MARK)) return { changed: false, message: 'backup is itself patched; not restored' };
  writeAtomic(file, original);
  fs.unlinkSync(backup);
  return { changed: true, message: 'restored' };
}

module.exports = {
  id: 'openai.chatgpt', name: 'Codex host', VERSION, MARK, ANY_MARK, BACKUP_SUFFIX, EDITS,
  patchSource, status, apply, restore, targetFile: hostFile,
};
