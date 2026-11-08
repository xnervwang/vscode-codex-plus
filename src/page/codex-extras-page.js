// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

/*
 * Runs in Codex's page (its sidebar and every conversation tab), added by src/webview-inject.js as a module script
 * ahead of Codex's own, so it runs first. It touches nothing Codex draws: everything it shows is one strip of its own,
 * appended to <body> beside Codex's root, never inside it.
 *
 *   - The page's time zone goes to the extension host, since this is the one part that runs where the reader is.
 *   - A chime plays when the host says a turn finished, or a plan question appeared, for the conversation shown here.
 *   - The strip shows the figures the host sends for this conversation: the last turn's duration, how much of the
 *     context window is in use, model and effort, and while a turn runs, the tool call in progress and for how long.
 *
 * Messages to the host are of type "codex-extras", which the patched host hands to this extension; messages from it
 * are of types starting "codex-extras-", which Codex's page ignores.
 */
(function () {
  'use strict';
  var orig = globalThis.acquireVsCodeApi;
  if (typeof orig !== 'function') return;
  /* The editor gives a page one handle and throws on a second request; Codex asks for one as it starts. Both go
     through this, so whichever asks first creates it and the other gets the same one. */
  var api = null;
  globalThis.acquireVsCodeApi = function () { if (!api) api = orig(); return api; };
  var post = function (m) { try { globalThis.acquireVsCodeApi().postMessage(Object.assign({ type: 'codex-extras' }, m)); } catch (e) { /* lost */ } };

  try { post({ kind: 'tz', timeZone: String(Intl.DateTimeFormat().resolvedOptions().timeZone || '') }); } catch (e) { /* none */ }

  var audio = null;
  function chime(kind) {
    try {
      audio = audio || new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      var notes = kind === 'question' ? [660, 880] : [880, 660];
      notes.forEach(function (f, i) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, audio.currentTime + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.08, audio.currentTime + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.12 + 0.11);
        o.connect(g); g.connect(audio.destination);
        o.start(audio.currentTime + i * 0.12); o.stop(audio.currentTime + i * 0.12 + 0.12);
      });
    } catch (e) { /* no audio here */ }
  }

  var strip = null, figures = null, timer = null;
  function draw() {
    if (!figures || !figures.text) { if (strip) strip.style.display = 'none'; return; }
    if (!strip) {
      strip = document.createElement('div');
      strip.setAttribute('data-codex-extras', 'figures');
      strip.style.cssText = 'position:fixed;right:8px;bottom:2px;z-index:2147483000;pointer-events:none;'
        + 'font:11px var(--vscode-font-family,sans-serif);color:var(--vscode-descriptionForeground,#888);'
        + 'background:var(--vscode-editor-background,transparent);opacity:.85;padding:0 4px;border-radius:3px;';
      document.body.appendChild(strip);
    }
    var text = figures.text;
    if (figures.tool && figures.toolSince) {
      var s = Math.max(0, Math.round((Date.now() - figures.toolSince) / 1000));
      text = figures.tool + ' running for ' + (s >= 60 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : s + 's') + ' · ' + text;
    }
    strip.textContent = text;
    strip.style.display = '';
  }

  globalThis.addEventListener('message', function (e) {
    var m = e && e.data;
    if (!m || typeof m.type !== 'string' || m.type.indexOf('codex-extras-') !== 0) return;
    if (m.type === 'codex-extras-chime') chime(m.kind);
    else if (m.type === 'codex-extras-figures') {
      figures = m;
      if (timer) { clearInterval(timer); timer = null; }
      if (m.tool) timer = setInterval(draw, 1000);
      if (document.body) draw(); else document.addEventListener('DOMContentLoaded', draw);
    }
  });
})();
