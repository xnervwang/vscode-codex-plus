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
 *   conversation panels     each conversation tab's WebviewPanel as Codex opens it, with the thread id its URI names
 *                           (none for a tab opened on /extension/panel/new) and the route it opened on: for the dot on
 *                           the tab's logo and for putting text in that conversation's message box
 *   other panels            the panels Codex opens without a conversation URI (its diff, plan and settings panels, and
 *                           the one it makes when it has no sidebar), so that every page outside the sidebar is known
 *   page requests           a page's request to the app-server, with the webview that sent it, at the moment it is
 *                           sent; a prewarmed thread start is its own message type and is handed over as one
 *   page responses          the app-server's answer, as Codex hands it back to the page that asked. The answer to a
 *                           page's thread start carries the id of the conversation that page goes on to show, and the
 *                           webview it goes back to is what ties that id to one tab (src/patching.js)
 *   window broadcasts       what this window tells Codex's other windows, among it which threads it is streaming
 *   page messages           messages of type "codex-extras" from the script this extension adds to Codex's page
 *                           (src/webview-inject.js), which Codex's own switch would otherwise drop as unknown
 *   app-server traffic      the requests Codex's app-server makes of its client, and the answers going back: this is
 *                           the one place an approval request can be read, since it stops and waits for the user and
 *                           is written to no file (src/approvals.js). Three places, all unconditional - the two
 *                           coordinators Codex hands these to are each behind a feature switch, so hooking those
 *                           would report nothing whenever a switch is off
 *
 * Same discipline as claude-code-extras: every edit must match exactly once on a pristine bundle, all or nothing, the
 * result must parse, the untouched original is kept beside the file, the replacement is atomic, and the marker carries
 * a digest of the edits so an older patch is recognised as outdated.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { applyEdits, shapesOf, moveBack } = require('./edits');

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
    re: /(let\{conversationId:([\w$]+)\}=([\w$]+),[\s\S]{0,1500}?)(this\.editorPanels\.set\(([\w$]+),\{ready:!1,pendingMessages:\[\],initialRoute:)/g,
    to: (m, before, conv, route, set, panel) => `${before}${call('__codexExtrasPanel', `${panel},${conv},this,${route}.path`)},${set}`,
  },
  {
    name: 'other panels',
    re: /this\.editorPanels\.set\(([\w$]+),\{ready:!1,pendingMessages:\[\],initialRoute:([\w$]+)\?\.initialRoute\}\)/g,
    to: (m, panel, opts) => `${m},${call('__codexExtrasPanel', `${panel},null,this,${opts}?.initialRoute`)}`,
  },
  /*
   * The two message types a page sends a request to the app-server with sit next to each other, so one match carries
   * both. The call goes in just ahead of the line that records which page asked, so a request Codex refuses on the
   * spot (it answers the page itself and sends nothing) is never handed over.
   */
  {
    name: 'page requests',
    re: /(case"mcp-request":\{if\([\w$]+\(([\w$]+)\.request\)\)[\s\S]{0,600}?)(this\.pendingMcpRequests\.set\(String\([\w$]+\),([\w$]+)\),this\.codexMcpConnection\.sendRequest\([^;]{0,120}\);break\}case"thread-prewarm-start":\{[\s\S]{0,80}?)(this\.pendingMcpRequests\.set\(String\([\w$]+\),\4\),this\.codexMcpConnection\.prewarmThreadStart\()/g,
    to: (m, before, msg, between, webview, prewarm) => `${before}${call('__codexExtrasPageRequest', `${webview},${msg}.request,"request"`)},`
      + `${between}${call('__codexExtrasPageRequest', `${webview},${msg}.request,"prewarm"`)},${prewarm}`,
  },
  {
    name: 'page responses',
    re: /deliverMcpResponseToOrigin\(([\w$]+)\)\{let ([\w$]+)=String\(\1\.id\),([\w$]+)=this\.pendingMcpRequests\.get\(\2\);/g,
    to: (m, response, id, webview) => `${m}${call('__codexExtrasPageResponse', `${webview},${response}`)};`,
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
  /*
   * Incoming app-server messages, where the request branch and the notification branch sit next to each other, so one
   * match carries both: a request that may be waiting for the user, and the notification saying one was answered
   * (serverRequest/resolved). Anchored on the two branch tests rather than on the method that holds them, which is a
   * name the build is free to change.
   */
  {
    name: 'app-server requests',
    re: /if\(this\.isMcpRequestMessage\(([\w$]+)\)\)\{([\s\S]{0,400}?)(return\{routeKind:"request",method:\1\.method\}\}if\(this\.isMcpNotificationMessage\(\1\)\)\{)/g,
    to: (m, msg, body, between) => `if(this.isMcpRequestMessage(${msg})){${call('__codexExtrasAppServer', `"request",${msg}`)};`
      + `${body}${between}${call('__codexExtrasAppServer', `"notification",${msg}`)};`,
  },
  /* The answer this window sends, which is also how Codex's own countdown answers one for the user. */
  {
    name: 'app-server answers',
    re: /sendResponse\(([\w$]+),([\w$]+)\)\{/g,
    to: (m, id, result) => `sendResponse(${id},${result}){${call('__codexExtrasAppServer', `"answer",{id:${id}}`)};`,
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
  /* Written as the patched file is: a backup cut short would be put back over Codex's file by the next restore. */
  if (state === 'clean') writeAtomic(backup, original);
  writeAtomic(file, r.out);
  /* A restore in another window can have moved the backup over the file since it was read; the file is patched now, so
     its backup is put back from the copy just patched from. */
  if (!fs.existsSync(backup)) writeAtomic(backup, original);
  return { changed: true, current: true, message: 'patched' };
}

/* Whether a backup can stand for Codex's bundle: something that parses. Anything else is not put back over it. */
function usableBackup(text) {
  if (!text.trim()) return false;
  try { new vm.Script(text, { filename: 'extension.js' }); return true; } catch (_) { return false; }
}

/** Put the original bundle back and remove the backup. */
function restore(codexExtensionPath) {
  const file = hostFile(codexExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) return { changed: false, message: 'nothing to restore' };
  const original = fs.readFileSync(backup, 'utf8');
  if (original.includes(ANY_MARK)) return { changed: false, message: 'backup is itself patched; not restored' };
  if (!usableBackup(original)) return { changed: false, message: 'backup is empty or does not parse; not restored, reinstall Codex' };
  return moveBack(backup, file);
}

module.exports = {
  id: 'openai.chatgpt', name: 'Codex host', VERSION, MARK, ANY_MARK, BACKUP_SUFFIX, EDITS,
  patchSource, status, apply, restore, targetFile: hostFile,
};
