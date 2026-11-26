// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Loading a Codex page again when Codex has replaced it with its recovery page ("ChatGPT hit a snag") because one of
 * its own modules failed to load. The page script reports that page (lookForBroken in
 * src/page/codex-extras-page.js). The browser keeps a failed module load for the rest of the page's life, so only a new
 * page brings the conversation back, and a reload from inside the page leaves VS Code's empty placeholder. Setting the
 * webview's html again from here is what builds a new page in place: the tab keeps its position, nothing else comes to
 * the front, and Codex's sidebar, which has no tab, gets a new page the same way. The html gets a comment with the time
 * at its end, since VS Code builds no new page for the html it already has.
 *
 * A page is loaded again at most LIMIT times in WINDOW_MS; after that it is left as it is, with a line in the log.
 */

/* A pause before the page is loaded again, for whatever made the load fail to clear. */
const WAIT_MS = 2000;
const LIMIT = 2;
const WINDOW_MS = 10 * 60e3;
const STAMP = /<!-- Codex Plus loaded this page again at \d+ -->$/;

/*
 * log(line); sleep(ms) -> Promise; now() -> ms. report({ webview, key, where, file }) handles one page's report:
 * `webview` is the page's vscode.Webview, `key` names the page across its loads (its tab's URI, or 'sidebar'), and
 * `where` says in the log which page it is. Resolves to 'loaded', 'limit' or 'failed'. Reports are handled one at a time.
 */
function createBrokenPages({ log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, waitMs = WAIT_MS } = {}) {
  const recent = new Map();
  let chain = Promise.resolve();

  async function reload({ webview, key, where, file }) {
    log(`Codex's page ${where} could not load its code${file ? ` (${file})` : ''}`);
    const times = (recent.get(key) || []).filter((t) => now() - t < WINDOW_MS);
    if (times.length >= LIMIT) {
      log(`the page ${where} was loaded again ${times.length} times in the last ${WINDOW_MS / 60e3} minutes, so it is left for the user`);
      return 'limit';
    }
    await sleep(waitMs);
    try {
      const html = String(webview.html || '').replace(STAMP, '');
      webview.html = `${html}<!-- Codex Plus loaded this page again at ${now()} -->`;
      times.push(now());
      recent.set(key, times);
      log(`loaded the page ${where} again`);
      return 'loaded';
    } catch (e) {
      log(`could not load the page ${where} again: ${(e && e.message) || e}`);
      return 'failed';
    }
  }

  return {
    report(r) {
      const next = chain.then(() => reload(r));
      chain = next.catch(() => {});
      return next;
    },
  };
}

module.exports = { createBrokenPages, WAIT_MS, LIMIT, WINDOW_MS };
