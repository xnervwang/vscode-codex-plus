// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The window stage of run.js: a real VS Code window with Codex, Agent Plus and this extension freshly installed,
 * driven through Playwright. It checks, in order:
 *
 *   the patch    Codex gets patched on the first start, VS Code says to reload, and until the reload the tab bar keeps
 *                Codex's own button
 *   tab bar      after the reload one Codex button, this extension's, whose hover and click follow codexPlus.tabBarButton,
 *                with Codex's own back when the extension is turned off
 *   list         Agent Plus's session list (its agentPlus.sessions view), with the conversations this extension hands
 *                it: a row for each with its dot and stripe, the ones Codex archived shown as archived, and no row for
 *                a codex exec run, which is background work. A conversation's row is keyed by "codex" and its thread id
 *   archive pass this extension's daily pass over archived conversations leaves them to Agent Plus's list while that
 *                list archives and deletes conversations in the window
 *   delete       Delete on an archived row of Agent Plus's list: its confirmation lists what will be deleted in this
 *                extension's words, and the rollout goes from the Codex home
 *   a tab        a conversation opened in a tab from its row in Agent Plus's list: its title, then the dot on its logo
 *                during a turn sent through fake-model.js, and the envelope after its title once the reply arrives while
 *                the tab is in the background. After a rename that leaves the envelope in the new name, the tab ends
 *                with one envelope, and the name saved in Codex and the list row's title have none
 *   left running a conversation shows a green ring, on its tab and in Agent Plus's list, until the work its turn
 *                started is done: a background command, a sub-agent, and on Linux a detached shell, a program run under
 *                setsid, a codex exec, a claude -p worker and a claude --bg session. The ones on Linux need
 *                Codex's approval to run outside its sandbox, and the tab shows the red dot until it is given. With
 *                background conversations listed, the sub-agent's row has its nickname and its dot. Once the shell or
 *                the program stops, the conversation gets a notice. The two Claude Code ones are stand-ins, since a real
 *                one would call a model
 *   images       a reply's images: a PNG and an SVG by absolute path, a file:// URL and a data: URL drawn, an image at
 *                a web address shown as a plain link; with codexPlus.replyImages off the others are "[Image]", and
 *                drawn again once it is back on. What the model is told is left to the hook's own self-test, since
 *                this window does not trust the plugin's hooks
 *   Codex's page what the patch adds there: the time stamps, the rail, the buttons by the message box, the Agent map,
 *                and the Work plan line on the context meter's hover
 *   links        another conversation a reply names, by its title in corner brackets and by its id, drawn as links in
 *                the theme's link colour; a click brings that conversation's tab to the front, and with
 *                codexPlus.conversationLinks off there are none. A link to a conversation a second window shows is
 *                taken by that window, which brings its tab forward while this one opens nothing; a link to another
 *                agent's conversation, from a source registered as claude-code in the test, names that agent and
 *                reaches that source's reveal
 *   the brief    a click on the conversation in Agent Plus's Conversations panel shows the brief its plan holds in the
 *                Answer view; the arrow on its row and the page's button each go back to the conversation's tab
 *   a question   Codex's asynchronous question answered while its turn still runs, on its card or by a message typed
 *                into the message box: once the turn has ended there is no red dot on the tab, no waiting dot on the
 *                list row or Agent Plus's panel, and no count. A question left unanswered gets the red dot on the tab,
 *                the blue dot of a waiting dialog on the list row and the panel, and the count; its page plays the
 *                question chime. The model's blocking question (request_user_input, in Plan mode): the same signs,
 *                gone once it is answered on its card
 *   the sidebar  a conversation opened in Codex's sidebar: each reply's stamp inside its column, and this extension's
 *                controls in a line of their own inside the message box when the sidebar is too narrow for them in
 *                Codex's toolbar row
 *   side and tab Codex's sidebar opened on one conversation with the tab of another in front: Agent Plus's front and
 *                its work plan view follow the same one, whichever came forward last
 *   recent chats another conversation picked in Codex's Recent chats from a conversation's tab opens in an editor tab
 *                of its own: titled by it, in front for Agent Plus and drawn as current in the list
 *   archived     the conversation in the tab archived in Codex while open: the tab keeps its turns, read-only, and
 *                opening it with this extension's Open in Tab unarchives it and gives the tab its message box back
 *   a New tab    a first message typed into a tab the tab bar button opened: the tab is titled by the conversation, and
 *                Agent Plus has it in front, so its reply is neither announced nor counted
 *   to the front a conversation's tab clicked from a New tab with nothing typed into it, and from the tab above: Agent
 *                Plus has the conversation the clicked tab shows in front at once, although VS Code says which panel is
 *                visible only after it reports the switch
 *   two windows  a second window holding a conversation in a tab: an approval asked for there (the PermissionRequest
 *                hook's mark, the hook run here with what Codex sends it; on Linux also a real request, approved there)
 *                gives it the red dot and Agent Plus's count in this window. Archived in the other window, it is left
 *                alone by the daily pass while that window shows it
 *   mid-turn     a question the work plan puts while the turn runs: the dot stays green, and it is neither counted nor
 *                reported as waiting until the turn ends
 *   elsewhere    a conversation in a folder the window does not open: in Agent Plus's list of every conversation, and,
 *                marked unread, archived and unarchived, not announced as finished
 *   installed    when the build this window runs counts as one a newer install has replaced, the conversation is still
 *                told when a detached command it started ends
 *   locked       a conversation whose writer lock another process holds: Codex says it is open in another app, Codex
 *                Plus clicks its Retry for the user, and once the lock is let go it opens without a click
 *   broken page  a page that could not load one of Codex's modules, which Codex replaces with its recovery page: a new
 *                page is built in the same tab and draws the conversation the locked step used
 *   token mode   what reaches the made-up model in each of Agent Plus's token modes, with the plugin's hooks trusted
 *
 * Every step saves a screenshot to <out>/shots, and crops of the parts this extension draws are compared with the
 * approved copies (lib/baseline.js).
 */
const fs = require('fs');
const path = require('path');
const win = require('./lib/window');
const { baselines } = require('./lib/baseline');
const pixels = require('./lib/pixels');
const fakeHome = require('./lib/fake-home');
const { codexBinary } = require('../../src/appserver');
const steps = require('./lib/steps');

const { sleep, until } = win;
const TITLES = { tab: 'Codex Plus: New Codex Conversation in a Tab', sidebar: 'Codex Plus: Open Codex Sidebar', codex: 'Open Codex Sidebar' };
/* TAB_DOTS in src/patching.js: green working, drawn as a ring with only background work left, and red waiting. */
const DOTS = { working: [0x22, 0xc5, 0x5e], waiting: [0xef, 0x44, 0x44] };
/* The unread envelope in the Dark Modern theme that run.js sets (src/envelope.js). */
const ENVELOPE = '\u{1F4E9}';
/* The form src/envelope.js draws in the light themes. */
const TEXT_ENVELOPE = '\u2709\uFE0E';
const envelopes = (text) => (String(text || '').match(/(?:\uD83D\uDCE9|\u2709)[\uFE0E\uFE0F]?/g) || []).length;
const bare = (text) => String(text || '').replace(/(?:\uD83D\uDCE9|\u2709)[\uFE0E\uFE0F]?/g, ' ').replace(/\s+/g, ' ').trim();
const COMPOSER = '[data-codex-composer-root] [contenteditable="true"]';
/* What lib/fake-model.js answers a turn with when no script is set. */
const REPLY = 'Done. The cap is configurable.';

/*
 * The tables lib/steps.js uses to pick the steps of a partial run. BASE sets up what nearly every step uses: the
 * patched and reloaded window, and `codex`, the page of the conversation in a tab. NEEDS has, for a step, the earlier
 * steps whose variables or conversations it uses. SHARD_STARTS cuts the steps into the shards .github/workflows/vscode.yml
 * runs side by side, at about even times.
 */
const STEP_BASE = ['the feature list against the Agent Plus installed', 'the patch', 'tab bar', 'a conversation in a tab'];
const BEGUN = 'a conversation begun in a tab the tab bar button opened';
const AGENT_NEW = 'a conversation begun in a tab New Codex Agent opened';
const IN_TAB_NEW = 'a conversation begun with Codex\'s new conversation button in a tab';
const SUB_AGENT = 'a sub-agent opened in a tab from the Agent map';
const RESTORED = 'tabs restored at a reload';
const STEP_NEEDS = {
  [AGENT_NEW]: [BEGUN],
  [IN_TAB_NEW]: [AGENT_NEW],
  'a conversation\'s tab brought back to the front': [BEGUN],
  'New Codex Agent twice and Codex\'s New chat in a tab, each a new conversation': [BEGUN],
  [RESTORED]: [BEGUN, IN_TAB_NEW, SUB_AGENT],
  'a turn in a restored New tab': [RESTORED],
  'a closed conversation brought back': [RESTORED],
  'a second window': [BEGUN],
  'a notice for a tab restored behind another': [RESTORED],
  'restored tabs keep their envelopes': [RESTORED],
  'a tab closed while the extension host was away': [RESTORED],
};
const SHARD_STARTS = ['the feature list against the Agent Plus installed', 'a claude --bg session whose job id a later poll reads',
  'a conversation in Codex\'s sidebar', 'a second window', 'a tab closed while the extension host was away'];
/* CODEX_PLUS_UI_STEPS (a regular expression of step names) or CODEX_PLUS_UI_SHARD ("k/n") pick the steps of this run;
   null means every step. */
function stepsToRun(env = process.env) {
  return steps.chosen({ names: steps.namesIn(__filename), only: env.CODEX_PLUS_UI_STEPS ? new RegExp(env.CODEX_PLUS_UI_STEPS) : null,
    shard: env.CODEX_PLUS_UI_SHARD || '', starts: SHARD_STARTS, needs: STEP_NEEDS, base: STEP_BASE });
}

async function run({ exe, profile, env, playwright, model, threads, out, check: report, note }) {
  let failedChecks = 0;
  const check = (cond, what, detail) => { const ok = report(cond, what, detail); if (!ok) failedChecks++; return ok; };
  const shotsDir = path.join(out, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const base = baselines({ out, check, note });
  let shotNo = 0;
  const w = await win.open({ exe, profile, env, playwright, log: path.join(out, 'vscode-window.log') });
  const { page, call } = w;
  /* The start of a call that reads the extension's own copy of one of its modules: own('patching'). On Windows the host
     loaded them under a drive letter of another case than extensionPath gives, and a require by that path loads a
     second copy that never ran. */
  const OWN = `const mine = vscode.extensions.getExtension('xnervwang.codex-plus');
    const own = (m) => { const file = require('path').join(mine.extensionPath, 'src', m + '.js');
      const k = Object.keys(require.cache).find((x) => x.toLowerCase() === file.toLowerCase());
      return k ? require.cache[k].exports : require(file); };`;
  const shot = (name) => page.screenshot({ path: path.join(shotsDir, `${String(++shotNo).padStart(2, '0')}-${name}.png`) }).catch(() => {});
  /* Clicks into the message box of a Codex page, near the start of its first line. The context meter in the row of
     buttons under the text opens a card over the box on a hover, and a pointer left where the meter has moved to can
     open it with no move at all. So the pointer first moves to a corner of the same page, which the meter takes as the
     pointer leaving it (a move out of the page is not), and the click waits until the card has closed. */
  const intoComposer = async (f) => {
    await f.locator('body').hover({ position: { x: 4, y: 4 }, force: true }).catch(() => page.mouse.move(5, 5));
    const shut = await until(() => f.evaluate(() => ![...document.querySelectorAll('[data-codex-extras="context"]')].some((e) => e.style.display === 'block'))
      .catch(() => true), 3000, 100);
    if (!shut) note(`${stepNow}: the context meter's card was still open 3 s after the pointer left it, over the message box`);
    await f.locator(COMPOSER).first().click({ position: { x: 24, y: 10 } });
  };
  /*
   * What the window held when a step failed, beside its screenshot in <out>/state/<number>-<name>/: the workbench's
   * HTML and the text of each frame in it (the webviews of Codex's pages and Agent Plus's views among them), with their
   * addresses, the tabs VS Code has, and the notifications shown.
   */
  const keepState = async (name) => {
    const dir = path.join(out, 'state', `${String(shotNo).padStart(2, '0')}-${name.replace(/[^\w.-]+/g, '-').slice(0, 80)}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const frames = [];
      for (const [i, f] of page.frames().entries()) {
        const html = await f.content().catch(() => '');
        const text = await f.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        if (html) fs.writeFileSync(path.join(dir, `frame-${i}.html`), html.slice(0, 4 << 20));
        frames.push({ frame: i, url: f.url().slice(0, 300), name: f.name(), text: text.slice(0, 20000) });
      }
      const said = { step: name, at: new Date().toISOString(), tabs: await tabs().catch((e) => String(e)), notifications: await toasts().catch((e) => String(e)), frames };
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(said, null, 2) + '\n');
    } catch (e) { note(`${name}: the window's state could not be kept: ${(e && e.message) || e}`); }
  };
  const picked = stepsToRun();
  /* Turns a step's error into one line: the error's first lines, the end of Playwright's call log for a timeout (it says
     what kept the action from happening), and where the error was thrown. */
  const failure = (e) => {
    const lines = String((e && e.stack) || e).split('\n');
    const said = lines.filter((l) => !/^\s+at /.test(l)), at = lines.filter((l) => /^\s+at /.test(l)).slice(0, 3);
    const kept = said.length > 10 ? [...said.slice(0, 4), '…', ...said.slice(-6)] : said;
    return [...kept, ...at].map((l) => l.trim()).join(' | ');
  };
  /*
   * VS Code's webview service worker lets 32 resource responses of one webview origin be open at once, and the Codex tabs
   * of every window of this profile share one origin. A page closed while it still loads leaves its queued requests
   * behind, and each of them then holds a place for 30 s before it times out; on a slow machine a Codex page opened in
   * the minutes after gets none of its files, and Codex puts "Codex could not start" in it. So before a step, and before any
   * page or window closes or reloads, each Codex origin is asked for one more file, queued behind the files
   * already asked for, until one comes back within a second. Resolves to the seconds this waited.
   */
  const served = async (pages = [page], ms = 480000) => {
    const t0 = Date.now();
    const origins = new Map();
    for (const pg of pages) {
      for (const f of (pg && !pg.isClosed() ? pg.frames() : [])) {
        const host = await f.evaluate(() => (location.protocol === 'vscode-webview:' && /\/openai\.chatgpt[^/]*\/webview\/$/.test(document.baseURI)
          ? location.host : '')).catch(() => '');
        if (host && !origins.has(host)) origins.set(host, f);
      }
    }
    await Promise.all([...origins.values()].map(async (f) => {
      while (Date.now() - t0 < ms) {
        const took = await f.evaluate((cap) => new Promise((done) => {
          const at = performance.now();
          const timer = setTimeout(() => done(-1), cap);
          fetch(new URL(`index.html?cxp-served=${Date.now()}`, document.baseURI), { cache: 'no-store' }).then((r) => r.text())
            .then(() => { clearTimeout(timer); done(performance.now() - at); }, () => { clearTimeout(timer); done(-2); });
        }), Math.max(1000, ms - (Date.now() - t0))).catch(() => -2);
        /* -2: the fetch failed or the frame went, so there is nothing to wait for there. */
        if (took === -2 || (took >= 0 && took < 1000)) return;
      }
    }));
    return Math.round((Date.now() - t0) / 1000);
  };
  /*
   * served() knows only that VS Code has caught up with what Codex's pages have asked for so far; a page opened a
   * moment ago has yet to ask for most of its code, and closing it or reloading the window then leaves that queued. So
   * settle() first waits for each Codex tab page to draw its message box and, on a conversation page, its turns. If
   * served() had to wait, settle() repeats the process because those files may have been for the tab pages. A tab's
   * page is recognized by the initial-route tag Codex puts in it, or by the webview origin such pages share: the page
   * of Codex's hidden sidebar has a message box and the titles of conversations in its text too. A page showing Codex's
   * recovery page ("ChatGPT hit a snag") fetches nothing more and counts as drawn, and so does a page that has been up
   * for 15 s, since by then Codex has asked for its route's code: the page the Agent map opens for a sub-agent has
   * drawn no turns within a minute. Resolves to false when fewer than `least` such pages were there or one had not
   * drawn within 60 s.
   */
  let tabsHost = '';
  const tabPages = async () => {
    const seen = [];
    for (const f of page.frames()) {
      const st = await f.evaluate(() => {
        if (!/\/openai\.chatgpt[^/]*\/webview\/$/.test(document.baseURI)) return null;
        const m = document.querySelector('meta[name="initial-route"]');
        return { host: location.host, route: m ? m.content : null, composer: !!document.querySelector('[data-codex-composer-root]'),
          turns: !!document.querySelector('[data-turn-key]'), broke: /hit a snag|Something went wrong/.test(document.body ? document.body.innerText : ''),
          up: Math.round(performance.now() / 1000) };
      }).catch(() => null);
      if (st) seen.push({ f, ...st });
    }
    for (const x of seen) if (x.route !== null) tabsHost = x.host;
    return seen.filter((x) => x.route !== null || (tabsHost && x.host === tabsHost)).map((x) => ({ f: x.f,
      drawn: x.broke || x.up >= 15 || (x.composer && (!/^\/local\//.test(x.route || '') || x.turns)),
      says: { route: x.route, composer: x.composer, turns: x.turns, up: x.up } }));
  };
  const quietFor = (f, ms) => f.evaluate((gap) => {
    const g = globalThis;
    if (g.__cxpLastFile === undefined) {
      g.__cxpLastFile = performance.now();
      try { new PerformanceObserver(() => { g.__cxpLastFile = performance.now(); }).observe({ type: 'resource' }); } catch (_) { /* none */ }
    }
    return performance.now() - g.__cxpLastFile > gap;
  }, ms).catch(() => true);
  const settle = async (what, least = 1) => {
    for (let tries = 0; tries < 3; tries++) {
      const pages = await until(async () => { const ps = await tabPages(); return ps.length >= least && ps.every((x) => x.drawn) && ps; }, 60000, 500);
      if (!pages) {
        const ps = await tabPages();
        note(`${what}: ${ps.length} page(s) of Codex's tabs were there, and not all of them had drawn within 60 s: ${JSON.stringify(ps.filter((x) => !x.drawn).map((x) => x.says))}`);
        await served();
        return false;
      }
      await until(async () => (await Promise.all(pages.map((x) => quietFor(x.f, 2000)))).every(Boolean), 60000, 500);
      if (await served() < 2) return true;
    }
    return true;
  };
  const step = async (name, fn) => {
    if (picked && !picked.has(name)) return;
    console.log(`\n── ${name}`);
    stepNow = name;
    const failedBefore = failedChecks;
    const waited = await served().catch(() => 0);
    if (waited >= 10) note(`${name}: before it began, VS Code took ${waited} s to give Codex's pages the files they had asked for`);
    try { await fn(); } catch (e) { check(false, `${name}: ran to its end`, failure(e)); }
    if (failedChecks > failedBefore) { await shot(`${name}-failed`); await keepState(`${name}-failed`); }
  };

  /* ── what the window and the extension host say ── */
  const patchState = () => call(`
    const mine = vscode.extensions.getExtension('xnervwang.codex-plus'), codex = vscode.extensions.getExtension('openai.chatgpt');
    if (!mine || !codex) return null;
    const A = require(require('path').join(mine.extensionPath, 'src', 'adapters'));
    return { active: mine.isActive, targets: A.map((a) => [a.name, a.status(codex.extensionPath)]) };`);
  const tabs = () => call(`return vscode.window.tabGroups.all.map((g) => ({ column: g.viewColumn, active: g.isActive,
    tabs: g.tabs.map((t) => ({ label: t.label, active: t.isActive, view: (t.input && t.input.viewType) || '' })) }));`);
  const exec = (command, ...a) => call(`await vscode.commands.executeCommand(${JSON.stringify(command)}, ...arg); return true;`, a);
  /* Started and not waited for: the command opens a prompt that is answered through the window. */
  const start = (command) => call(`vscode.commands.executeCommand(${JSON.stringify(command)}); return true;`);
  const setting = (key, value) => call(`await vscode.workspace.getConfiguration('codexPlus').update(${JSON.stringify(key)}, arg, vscode.ConfigurationTarget.Global); return true;`, value);
  const openNotes = () => call(`await vscode.window.showTextDocument(vscode.Uri.file(${JSON.stringify(path.join(profile.folder, 'notes.txt'))}), { preview: false }); return true;`);

  /* The Codex buttons in the active editor group's tool bar, by their labels. */
  const codexButtons = () => page.evaluate(() => [...document.querySelectorAll('.editor-group-container.active .editor-actions .action-item .action-label')]
    .map((a) => a.getAttribute('aria-label') || a.title || '').filter((t) => /Codex/.test(t)));
  const codexButton = () => page.locator('.editor-group-container.active .editor-actions .action-item .action-label[aria-label*="Codex"]').first();
  /* The text of VS Code's hover over `loc`. */
  const anyHover = () => page.evaluate(() => !![...document.querySelectorAll('.monaco-hover, .workbench-hover')].find((e) => e.offsetParent && e.innerText.trim()));
  const hoverText = async (loc) => {
    await page.mouse.move(5, 300);
    await until(async () => !await anyHover(), 3000, 200);
    await sleep(300);
    await loc.hover();
    const text = await until(() => page.evaluate(() => {
      const h = [...document.querySelectorAll('.monaco-hover, .workbench-hover')].find((e) => e.offsetParent && e.innerText.trim());
      return h ? h.innerText.trim() : '';
    }), 5000, 200);
    await page.mouse.move(5, 300);
    await sleep(300);
    return text || '';
  };
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.notification-list-item-message')].map((e) => e.innerText));
  /* Agent Plus's notice stays on screen while the pointer rests on it and the extension cannot close it, so it can cover
     the message box's buttons, the meter, the Agent map pill and the end of the status bar. */
  const clearToasts = () => exec('notifications.clearAll').catch(() => {});
  const focused = () => call('return vscode.window.state.focused;');
  /* Whether this run's Agent Plus has its 'waitingFor' feature, which says what a conversation needs from the user. That
     Agent Plus also gives no notice for a conversation the focused window shows anywhere, even in a tab behind others,
     since the tab's dot and the count already show it. */
  const apWaits = (() => {
    try {
      const dir = fs.readdirSync(profile.exts).find((n) => n.startsWith('xnervwang.agent-plus-'));
      return require(path.join(profile.exts, dir, 'src', 'sources.js')).FEATURES.includes('waitingFor');
    } catch (_) { return false; }
  })();
  /* Under xvfb-run every window VS Code has once focused reports itself focused for good, so a step tells Agent Plus alone
     which window has the focus, through a global of that window's extension host. lib/window.js starts the windows with
     AGENT_PLUS_TEST_FOCUS=1, without which Agent Plus does not read it; null makes Agent Plus go by VS Code's focus again. */
  const testFocus = (on, folder) => call('if (arg === null) delete globalThis.__agentPlusTestFocused; else globalThis.__agentPlusTestFocused = arg; return true;',
    on, 60000, folder);
  /* For conversation `id`, the { activity, waitingFor } that each window's Agent Plus listing it reports to the others
     (<shared home>/attention). */
  const attentionOf = (id) => {
    const dir = path.join(profile.home, '.agent-work-plan', 'attention');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
    return names.flatMap((n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).items || []; } catch (_) { return []; } })
      .filter((it) => it && it.sessionId === id).map((it) => ({ activity: it.activity, waitingFor: it.waitingFor || null }));
  };
  const waitsOn = (id, why) => attentionOf(id).some((x) => x.activity === 'waiting' && JSON.stringify(x.waitingFor) === JSON.stringify(why));
  /* Every toast window `p` has shown since its log was started, as { text, at } in the page's clock, so a notice that came
     and went between two reads is still there. */
  const toastLogOf = (p) => p.evaluate(() => {
    if (!window.__cxpToastLog) {
      const log = window.__cxpToastLog = [], now = new Set();
      const scan = () => {
        const shown = new Set([...document.querySelectorAll('.notification-toast')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean));
        for (const t of shown) if (!now.has(t)) log.push({ text: t, at: Date.now() });
        now.clear();
        for (const t of shown) now.add(t);
      };
      new MutationObserver(scan).observe(document.querySelector('.notifications-toasts') || document.body, { childList: true, subtree: true, characterData: true });
      scan();
    }
    return { now: Date.now(), log: window.__cxpToastLog.slice() };
  }).catch(() => ({ now: 0, log: [] }));
  /* The toasts `p` showed since `mark` that are about a wait for the user: naming conversation `t`, or worded like a
     request for approval, as a notice from Codex itself would be. */
  const WAIT_WORDS = /approv|permission|allow|sandbox|waiting for you|needs? you/i;
  const waitToasts = async (p, t, mark) => (await toastLogOf(p)).log.filter((x) => x.at >= mark && (x.text.includes(`"${t}"`) || WAIT_WORDS.test(x.text)))
    .map((x) => x.text);
  /* The bell, a separate entry Agent Plus dropped after 1.7.0, shows the number of conversations waiting or finished.
     The Conversations entry's "N conversations need you" counts those with a question in their plan and those waiting
     for the user to approve something or answer; its hover, which the entry's aria-label carries, lists the waiting ones
     last under WAITS_HEAD, one a line for the first ten and then "and N more". */
  const WAITS_HEAD = 'Waiting for you to approve something or answer:';
  const agentStatus = () => page.evaluate(() => {
    const shown = [...document.querySelectorAll('.statusbar-item')].filter((x) => x.offsetParent);
    const bell = shown.find((x) => /agentPlus\.attention$/.test(x.id));
    const entry = shown.find((x) => /agentPlus\.conversations$/.test(x.id));
    return { bell: bell ? Number(bell.innerText.trim()) || 0 : null, text: entry ? entry.innerText : '', label: entry ? entry.getAttribute('aria-label') || '' : '' };
  });
  const agentCount = async () => {
    const s = await agentStatus();
    if (s.bell !== null) return s.bell;
    const lines = s.label.split(/\r?\n/).map((l) => l.trim()), at = lines.indexOf(WAITS_HEAD);
    let n = 0;
    for (const l of at < 0 ? [] : lines.slice(at + 1)) {
      const more = /^and (\d+) more$/.exec(l);
      if (more) return n + Number(more[1]);
      if (!l || l.endsWith(':')) break;
      n++;
    }
    return n;
  };
  /* The number in Agent Plus's "N conversations need you" in the status bar, 0 while it is not shown. */
  const asking = () => page.evaluate(() => {
    const e = [...document.querySelectorAll('.statusbar-item')].find((x) => /\d+ conversations? needs? you/.test(x.innerText));
    return e ? Number((/(\d+) conversations? needs? you/.exec(e.innerText) || [])[1]) || 0 : 0;
  });
  const toastAbout = (t, words) => page.evaluate(([want, w]) => {
    const n = [...document.querySelectorAll('.notification-toast')].find((e) => e.innerText.includes(`"${want}" ${w}`));
    return n ? n.innerText : '';
  }, [t, words]);
  /* The same for this window, since it was last loaded. Agent Plus's notice leaves the screen by itself after some ten
     seconds. */
  const toastLog = () => page.evaluate(() => {
    if (!window.__cxpToastLog) {
      const log = window.__cxpToastLog = [], now = new Set();
      const scan = () => {
        const shown = new Set([...document.querySelectorAll('.notification-toast')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean));
        for (const t of shown) if (!now.has(t)) log.push({ text: t, at: Date.now() });
        now.clear();
        for (const t of shown) now.add(t);
      };
      new MutationObserver(scan).observe(document.querySelector('.notifications-toasts') || document.body, { childList: true, subtree: true, characterData: true });
      scan();
    }
    return { now: Date.now(), log: window.__cxpToastLog.slice() };
  }).catch(() => ({ now: 0, log: [] }));
  const toastMark = async () => (await toastLog()).now;
  const toastsAbout = async (t, mark) => (await toastLog()).log.filter((x) => x.at >= mark && x.text.includes(`"${t}"`)).map((x) => x.text);
  /* Waits for a toast since `mark` saying `"<t>" <words>`. */
  const toastSaid = (t, words, mark, ms = 20000) => until(async () => (await toastsAbout(t, mark))
    .find((x) => x.includes(`"${t}" ${words}`)) || '', ms, 300);
  /* Clicks Open on the notification about `t`: its Open button, or in an older Agent Plus the Open link in its text. A toast left
     alone moves into VS Code's notification list after some ten seconds, where it is clicked instead. */
  const openFromToast = async (t) => {
    let n = page.locator('.notification-toast').filter({ hasText: `"${t}"` }).first(), where = 'toast';
    if (!await n.count()) {
      await exec('notifications.showList');
      n = page.locator('.notifications-center .notification-list-item').filter({ hasText: `"${t}"` }).first();
      await n.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      where = 'notification list';
    }
    const b = n.locator('.monaco-button').filter({ hasText: /^Open$/ });
    if (await b.count()) await b.first().click({ timeout: 5000 });
    else await n.locator('a').filter({ hasText: 'Open' }).first().click({ timeout: 5000 });
    if (where !== 'toast') await exec('notifications.hideList');
    return where;
  };
  /* The row of Agent Plus's Conversations panel titled `want`: the codicon names of its icon, the theme colour the icon is
     drawn in ('green', 'red', 'blue' or ''), and the badge VS Code draws after its label for the envelope's file decoration. */
  const panelRow = async (want) => {
    await exec('agentPlus.showConversations');
    return page.evaluate((t) => {
      /* The theme's colours are variables set on the workbench element, not on the body. */
      const at = document.querySelector('.monaco-workbench') || document.body;
      const colourOf = (v) => { const s = document.createElement('span'); s.style.color = `var(${v})`; at.append(s); const c = getComputedStyle(s).color; s.remove(); return c; };
      const tones = { green: colourOf('--vscode-charts-green'), red: colourOf('--vscode-charts-red'), blue: colourOf('--vscode-charts-blue') };
      const r = [...document.querySelectorAll('[id="workbench.parts.panel"] .monaco-list-row')]
        .find((x) => { const l = x.querySelector('.label-name'); return l && l.textContent.trim() === t; });
      if (!r) return null;
      const icon = r.querySelector('.custom-view-tree-node-item-icon');
      const label = r.querySelector('.monaco-icon-label');
      /* A selected row draws its icon in the selection's colour, so the colour set on the icon is read before the computed one. */
      const colour = icon ? getComputedStyle(icon).color : '', declared = icon ? icon.style.color : '';
      const badge = label ? getComputedStyle(label, '::after').content : '';
      const rgb = (/(\d+),\s*(\d+),\s*(\d+)/.exec(declared || colour) || []).slice(1).map(Number);
      const tone = /charts-green/.test(declared) || colour === tones.green ? 'green' : /charts-red/.test(declared) || colour === tones.red ? 'red'
        : /charts-blue/.test(declared) || colour === tones.blue ? 'blue'
          : rgb.length !== 3 ? '' : rgb[1] > rgb[0] + 40 && rgb[1] > rgb[2] + 40 ? 'green' : rgb[0] > rgb[1] + 60 && rgb[0] > rgb[2] + 60 ? 'red'
            : rgb[2] > rgb[0] + 60 && rgb[2] > rgb[1] + 40 ? 'blue' : '';
      return { icons: icon ? [...icon.classList].filter((c) => /^codicon-/.test(c)) : [], colour, declared, tone,
        selected: r.classList.contains('selected'), badge: /^".*"$/.test(badge) ? badge.slice(1, -1) : '' };
    }, want).catch(() => null);
  };
  /* The text of the context menu VS Code shows, '' for none. A locator also reaches a menu drawn inside a shadow root,
     so it is tried when the page's own query finds none. */
  const vsMenu = async () => {
    const plain = await page.evaluate(() => { const m = [...document.querySelectorAll('.context-view .monaco-menu')].find((e) => e.offsetParent); return m ? m.innerText : ''; });
    if (plain) return plain;
    const menus = page.locator('.context-view .monaco-menu');
    for (let i = 0, n = await menus.count().catch(() => 0); i < n; i++) {
      if (await menus.nth(i).isVisible().catch(() => false)) return (await menus.nth(i).innerText().catch(() => '')) || '';
    }
    return '';
  };
  const menuWith = (item) => until(async () => { const t = await vsMenu(); return t.includes(item) && t; }, 5000, 200);
  /* What a failure reports: VS Code's context views and their contents, including shadow roots, the menu and title bar
     styles VS Code was left at, and the window's last right-clicks. */
  const menuTrace = async () => ({
    views: await page.evaluate(() => [...document.querySelectorAll('.context-view')].map((v) => ({ cls: v.className, shown: !!v.offsetParent, kids: v.childElementCount,
      text: v.innerText.slice(0, 120), shadows: [...v.querySelectorAll('*')].filter((e) => e.shadowRoot).map((e) => e.shadowRoot.textContent.slice(0, 120)) }))).catch((e) => String(e)),
    style: await call("const w = vscode.workspace.getConfiguration('window'); return [w.get('menuStyle'), w.get('titleBarStyle')];").catch((e) => String(e)),
    rightClicks: await page.evaluate(() => (window.__cxpRightClicks || []).slice(-4)).catch(() => []),
  });
  /*
   * Right-clicks the tab titled `name` (with `onPage`, the newest turn on the conversation page it shows) and clicks
   * `item` in the menu that opens. The tab is clicked first unless `select` is false, which leaves a tab in the
   * background there, its reply unread. Resolves to the menu's text, and throws with menuTrace() when no menu offered
   * `item`. A right-click on a tab has opened no menu now and then on Linux runs too, so it is tried a few times.
   */
  const contextPick = async (name, item, { onPage = false, select = true } = {}) => {
    if (!await labelOf(name)) throw new Error(`no tab is titled "${name}": ${JSON.stringify(await tabs())}`);
    await page.evaluate(() => {
      if (window.__cxpRightClicks) return;
      window.__cxpRightClicks = [];
      window.addEventListener('contextmenu', (e) => window.__cxpRightClicks.push(`${String(e.target.className || e.target.tagName).slice(0, 60)}${e.defaultPrevented ? ' (taken)' : ''}`), true);
    }).catch(() => {});
    let where = '';
    let shut = false;
    /* A menu still open takes a right-click as a click outside it. A pointer resting on the tab after the click that
       selects it brings up the tab's hover, which sits where the menu would open. Either way no menu opens, so before
       the right-click the pointer moves off and the test waits until neither is there. */
    const noMenu = () => until(() => page.evaluate(() => ![...document.querySelectorAll('.context-view')].some((v) => v.offsetParent && v.childElementCount))
      .catch(() => true), 5000, 100);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await page.keyboard.press('Escape');
      if (select || onPage) await tabNamed(name).click();
      await page.mouse.move(5, 5);
      await noMenu();
      if (onPage) {
        const f = await frontPage();
        /* The newest turn is the one in view. Playwright gives a box inside a frame in the window's own coordinates. */
        const turn = f && f.locator('[data-turn-key]').last();
        /* A long newest turn shown down to its end has its top above the page's frame, where a point would land on the
           tab bar; so it is brought into view and the point taken inside the part of it the frame shows. */
        if (turn) await turn.scrollIntoViewIfNeeded().catch(() => {});
        const talk = turn && await turn.boundingBox();
        const shown = f && await f.frameElement().then((e) => e.boundingBox()).catch(() => null);
        if (talk) {
          const top = shown ? Math.max(talk.y, shown.y) : talk.y, bottom = shown ? Math.min(talk.y + talk.height, shown.y + shown.height) : talk.y + talk.height;
          const x = talk.x + talk.width / 2, y = top + Math.min(20, Math.max(0, bottom - top) / 2);
          /* Until VS Code has laid the tab's webview over the editor area, a right-click at that point opens the editor
             area's own menu. */
          await until(() => page.evaluate(([px, py]) => { const e = document.elementFromPoint(px, py); return !!e && e.tagName === 'IFRAME'; }, [x, y])
            .catch(() => false), 10000, 100);
          await page.mouse.click(x, y, { button: 'right' });
        }
      } else await tabNamed(name).click({ button: 'right' });
      where = await menuWith(item);
      if (!where) {
        note(`${stepNow}: a right-click on ${onPage ? 'the page' : `the tab "${name}"`} opened no menu with "${item}", so it is made again: ${JSON.stringify(await menuTrace()).slice(0, 700)}`);
        continue;
      }
      /* The menu item's own element takes the click; the label inside it reads as covered to Playwright. The click
         waits until the menu has stopped moving in. A menu that closes before the click is opened again. */
      const entry = page.locator('.context-view .monaco-menu .action-menu-item').filter({ hasText: item }).first();
      await still(entry).catch(() => false);
      if (await entry.click({ timeout: 5000, force: true }).then(() => true, () => false)) return where;
      shut = true;
    }
    const trace = await menuTrace();
    await page.keyboard.press('Escape');
    throw new Error(`${shut ? 'the menu closed before' : 'no menu offered'} "${item}" on ${onPage ? 'the page' : 'the tab'}${shut ? ' could be clicked' : ''}: ${JSON.stringify(trace).slice(0, 900)}`);
  };
  /* What the panel draws for each activity (LOOK in Agent Plus's src/conversations-view.js, the session list's dots):
     `waiting` for a question in the work plan, `dialog` for a dialog waiting for the user, such as Codex's approval card
     or its question. */
  const PANEL = { working: ['codicon-circle-filled', 'green'], background: ['codicon-circle', 'green'], waiting: ['codicon-circle-filled', 'red'],
    dialog: ['codicon-circle-filled', 'blue'], stopped: ['codicon-blank', ''] };
  const panelShows = (r, activity, unseen) => !!r && r.icons.includes(PANEL[activity][0]) && r.tone === PANEL[activity][1]
    && (unseen === null || envelopes(r.badge) === (unseen ? 1 : 0));
  /* Waits for the panel's row of `t` to show `activity`, with the envelope if `unseen` and without it if not (null takes either); then
     the panel is closed, so the editor keeps the height the crops were made at. */
  const panelSays = async (t, activity, unseen, ms = 20000) => {
    const got = await until(async () => { const r = await panelRow(t); return panelShows(r, activity, unseen) && r; }, ms, 700);
    const last = got || await panelRow(t);
    await exec('workbench.action.closePanel');
    /* The editor grows back over the panel's place, and a click aimed before it settles lands elsewhere. */
    await sleep(800);
    return { ok: !!got, row: last };
  };
  const frontTab = async () => { const g = (await tabs()).find((x) => x.active); return g && g.tabs.find((x) => x.active); };
  /* Every Codex tab, with its URI's route and fragment; only the fragment tells two New tabs apart. */
  const codexTabsNow = () => call(`return vscode.window.tabGroups.all.flatMap((g) => g.tabs
    .filter((t) => t.input && typeof t.input.viewType === 'string' && /conversationEditor$/.test(t.input.viewType) && t.input.uri)
    .map((t) => ({ label: t.label, route: t.input.uri.path, fragment: t.input.uri.fragment, active: t.isActive && g.isActive, column: g.viewColumn })));`);
  /* The Codex conversation page VS Code shows: the frame whose webview is visible. Codex keeps the pages of its tabs
     in the background and of its hidden sidebar. */
  const frontPage = async () => {
    for (const f of page.frames()) {
      try {
        if (!await f.evaluate(() => !!document.querySelector('[data-codex-composer-root]') && innerWidth > 600)) continue;
        const host = f.parentFrame() && await f.parentFrame().frameElement();
        if (host && await host.isVisible()) return f;
      } catch (_) { /* gone */ }
    }
    return null;
  };
  /* Whether the page VS Code shows is Codex's own "Codex could not start", which Codex puts in a page that has not
     started within 30 s of its creation. */
  const gaveUpInFront = async () => {
    for (const f of page.frames()) {
      try {
        if (!await f.evaluate(() => document.title === 'Codex could not start')) continue;
        const host = f.parentFrame() && await f.parentFrame().frameElement();
        if (host && await host.isVisible()) return true;
      } catch (_) { /* gone */ }
    }
    return false;
  };
  /* The chimes the host asks a Codex page to play from now on (its codex-extras-chime messages, src/patching.js), as
     the page receives them: the sound itself cannot be heard here. */
  const hearChimes = (f) => (f ? f.evaluate(() => {
    if (!window.__cxpTestChimes) {
      window.__cxpTestChimes = [];
      window.addEventListener('message', (e) => { const d = e && e.data; if (d && d.type === 'codex-extras-chime') window.__cxpTestChimes.push(String(d.kind)); });
    }
    window.__cxpTestChimes.length = 0;
    return true;
  }).catch(() => false) : false);
  const chimesHeard = (f) => (f ? f.evaluate(() => (window.__cxpTestChimes || []).slice()).catch(() => null) : null);
  const pageSays = (f) => (f ? f.evaluate(() => ({ turns: document.querySelectorAll('[data-turn-key]').length, text: document.body.innerText.slice(0, 200) }))
    .catch((e) => ({ error: String(e) })) : null);
  /* "Codex could not start" when the page got none of its files within 30 s, or "ChatGPT hit a snag", its recovery
     page, drawn when one of its own modules failed to load (Codex.log: "Failed to fetch dynamically imported
     module"); '' when it shows neither. */
  const brokenInFront = async () => {
    for (const f of page.frames()) {
      try {
        const why = await f.evaluate(() => (document.title === 'Codex could not start' ? 'Codex could not start'
          : /ChatGPT hit a snag/.test(document.body ? document.body.innerText : '') ? 'ChatGPT hit a snag' : ''));
        if (!why) continue;
        const host = f.parentFrame() && await f.parentFrame().frameElement();
        if (host && await host.isVisible()) return why;
      } catch (_) { /* gone */ }
    }
    return '';
  };
  /*
   * After `act` brings the conversation page to the front, shownOrAgain() polls `shown` every 500 ms and resolves to
   * its first truthy result. On the CI machines Codex has now and then given up on such a page in one of the two ways
   * above, which is Codex's page failing to start rather than what the step checks, and one failed page would otherwise
   * fail every step after it that needs the conversation. So the tab is then closed, once VS Code has caught up with
   * Codex's files, and `act` done once more, with a note.
   */
  /* For a frame on Codex's recovery page, what its own resource timing says of the code it fetched: up to twelve
     fetches of Codex's code that did not return a complete 200 response, and up to twelve modules Codex's conversation
     and New pages import that have no entry at all, which are requests that never ended. Null for any other frame; only
     its first heading is read before that is known. */
  const fetchesIn = (f) => f.evaluate(async () => {
    const h = document.querySelector('h1, h2');
    if (!h || !/ChatGPT hit a snag/.test(h.textContent || '')) return null;
    const all = performance.getEntriesByType('resource').filter((e) => /\/assets\//.test(e.name));
    const file = (e) => e.name.split('/').pop();
    const odd = all.filter((e) => e.responseStatus !== 200 || !e.decodedBodySize).map((e) => ({ file: file(e), status: e.responseStatus,
      worker: e.workerStart > 0, bytes: e.decodedBodySize, at: Math.round(e.startTime), ms: Math.round(e.duration) })).slice(0, 12);
    const seen = new Set(all.map(file)), missing = new Set();
    for (const e of all.filter((x) => /local-conversation-page|new-thread-panel-page/.test(x.name))) {
      const text = await fetch(e.name).then((r) => r.text()).catch(() => '');
      for (const m of text.matchAll(/(?:from|import)\s*["'`]\.\/([\w.-]+\.js)["'`]/g)) if (!seen.has(m[1])) missing.add(m[1]);
    }
    return { odd, missing: [...missing].slice(0, 12), entries: all.length };
  }).catch(() => null);
  const fetchesOf = async (pg = page) => {
    for (const f of (pg && !pg.isClosed() ? pg.frames() : [])) { const r = await fetchesIn(f); if (r) return r; }
    return null;
  };
  /*
   * Codex draws its recovery page ("ChatGPT hit a snag") when one of its own modules fails to load. Every 3 s each frame
   * of the windows in `watched` is looked at, and each one found on that page is noted once, with the step it happened in
   * and its fetches (fetchesIn), so that a run says how often it came and where even when no check failed on it.
   */
  let stepNow = '';
  const watched = new Set([page]), snagged = new WeakSet();
  let snagBusy = false;
  const snagWatch = setInterval(async () => {
    if (snagBusy) return;
    snagBusy = true;
    try {
      for (const pg of [...watched]) {
        for (const f of (pg && !pg.isClosed() ? pg.frames() : [])) {
          if (snagged.has(f)) continue;
          const r = await fetchesIn(f);
          if (!r) continue;
          snagged.add(f);
          note(`during "${stepNow}" Codex drew its recovery page in a page${pg === page ? '' : ' of another window'}; its fetches of Codex's code short of a whole 200: ${JSON.stringify(r)}`);
        }
      }
    } catch (_) { /* a window going away */ } finally { snagBusy = false; }
  }, 3000);
  const shownOrAgain = async (what, act, shown, ms = 90000) => {
    let broke = '';
    await act();
    const got = await until(async () => (await shown()) || ((broke = await brokenInFront()) ? 'broke' : null), ms, 500);
    if (got !== 'broke') return got;
    const fetched = broke === 'ChatGPT hit a snag' ? await fetchesOf() : null;
    note(`${what}: Codex put "${broke}" in the page in front, so its tab was closed and that was done again${fetched ? `; its fetches of Codex's code short of a whole 200: ${JSON.stringify(fetched)}` : ''}`);
    await settle(`${what}: before the tab Codex gave up on was closed`, 0);
    await exec('workbench.action.closeActiveEditor');
    await act();
    return until(shown, ms, 500);
  };
  /* Opens conversation `t` in a tab with Codex Plus's command and resolves to that tab's page once it has drawn
     turns, or to null after 90 s. Looking for any page with the conversation's title finds the page of Codex's
     hidden sidebar at once, while the tab's own page has not started. When the tab is not in front within 10 s the
     command is run again. */
  const openShown = async (t) => {
    const mine = async () => (await codexTabsNow()).find((x) => x.route === `/local/${t.id}`);
    const open = async () => {
      await exec('codexPlus.openThreadInTab', t.id);
      if (!await until(async () => { const x = await mine(); return x && x.active; }, 10000, 250)) await exec('codexPlus.openThreadInTab', t.id);
    };
    return shownOrAgain(`opening "${t.title}" in a tab`, open, async () => {
      const x = await mine();
      if (!x || !x.active) return null;
      const f = await frontPage();
      const s = await pageSays(f);
      return s && s.turns >= 1 && f;
    });
  };
  const tabNamed = (label) => page.locator('.tabs-container .tab').filter({ hasText: label }).first();
  /* The conversation Agent Plus last said is in front, as its output channel has it: "codex <id>",
     "codex (no session yet)", "(none)", or '' before it said any. */
  const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).flatMap((n) => (n.isDirectory() ? walk(path.join(d, n.name)) : [path.join(d, n.name)])); } catch (_) { return []; } };
  /* Everything Codex Plus's output channel has written in this run, across reloads. NO_ANCHORS matches its line for a
     page whose message box or messages the page script did not recognise (src/patching.js anchorsMissingLine). */
  const ownLog = () => walk(path.join(profile.user, 'logs')).filter((f) => /Codex Plus\.log$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  /* When Codex's own log says a page of it did not start within its own wait (reason=renderer_ready_timeout), each such
     line's time; Codex writes its log lines in local time. */
  const codexStalls = () => walk(path.join(profile.user, 'logs')).filter((f) => /[\\/]openai\.chatgpt[\\/]Codex\.log$/.test(f))
    .flatMap((f) => fs.readFileSync(f, 'utf8').split('\n')).filter((l) => /reason=renderer_ready_timeout/.test(l))
    .map((l) => Date.parse(l.slice(0, 23).replace(' ', 'T'))).filter(Number.isFinite);
  const NO_ANCHORS = /the page script recognised none of [^\n]*/g;
  const noAnchors = () => ownLog().match(NO_ANCHORS) || [];
  const agentFront = () => {
    const logs = walk(path.join(profile.user, 'logs')).filter((f) => /Agent Plus\.log$/.test(f))
      .map((f) => ({ f, at: fs.statSync(f).mtimeMs })).sort((a, b) => b.at - a.at);
    if (!logs.length) return '';
    const said = fs.readFileSync(logs[0].f, 'utf8').split('\n').filter((l) => / active conversation: /.test(l));
    return said.length ? said[said.length - 1].replace(/^.* active conversation: /, '').trim() : '';
  };
  /* The id of the conversation whose rollout in the Codex home has a user message starting with `text`, '' while there
     is none. Codex names a new conversation in a thread of its own, whose request quotes the message inside one of its
     own, and keeps the newline the message box ends a message with. */
  const rolloutWith = (text) => {
    const dir = path.join(profile.codexHome, 'sessions');
    let names = [];
    try { names = fs.readdirSync(dir, { recursive: true }).map(String).filter((n) => n.endsWith('.jsonl') && !threads.some((t) => n.includes(t.id))); } catch (_) { return ''; }
    const hit = names.find((n) => { try { return fs.readFileSync(path.join(dir, n), 'utf8').includes(`"message":${JSON.stringify(text).slice(0, -1)}`); } catch (_) { return false; } });
    return hit ? (hit.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/) || [])[1] || '' : '';
  };
  /*
   * For a failure's detail: the panels the patch holds and, since the first call, what their pages, the app-server and
   * the tabs did, in order: the newest turn each page said it shows, each turn the app-server started, each tab change
   * with which panels were visible at that moment, and each panel's own view state change.
   */
  const panelTrace = () => call(`${OWN} const p = own('patching');
    const shape = (x, r) => { try { return { route: r.route, opened: r.opened, thread: r.thread, turn: r.turn, started: r.started, titled: r.titled,
      visible: x.visible, active: x.active, column: x.viewColumn }; } catch (_) { return { route: r.route, disposed: true }; } };
    if (!globalThis.__cxpTrace) {
      const log = globalThis.__cxpTrace = [], t0 = Date.now();
      const push = (e) => { log.push({ at: Date.now() - t0, ...e }); if (log.length > 120) log.shift(); };
      const known = (w) => [...p._registry.keys()].some((x) => { try { return x.webview === w; } catch (_) { return false; } });
      const watch = (x) => { try { x.onDidChangeViewState(() => { const r = p._registry.get(x); push({ k: 'view', ...(r ? shape(x, r) : { unknown: true }) }); }); } catch (_) { /* gone */ } };
      for (const x of p._registry.keys()) watch(x);
      const wrap = (k, rec) => { const f = globalThis[k]; if (typeof f !== 'function') return; globalThis[k] = function (...a) { try { rec(...a); } catch (_) { /* traced or not */ } return f.apply(this, a); }; };
      wrap('__codexExtrasPanel', (x, conv, prov, route) => { push({ k: 'panel', conv: conv || '', route: String(route || '') }); watch(x); });
      wrap('__codexExtrasMessage', (w, m) => { if (m && m.kind === 'turnShown') push({ k: 'shown', turn: m.turn, known: known(w) }); });
      wrap('__codexExtrasAppServer', (kind, m) => { if (kind === 'notification' && m && m.method === 'turn/started') push({ k: 'started', thread: (m.params || {}).threadId, turn: ((m.params || {}).turn || {}).id }); });
      vscode.window.tabGroups.onDidChangeTabs(() => { const g = vscode.window.tabGroups.activeTabGroup, t = g && g.activeTab;
        push({ k: 'tabs', front: t ? t.label : '', panels: [...p._registry].map(([x, r]) => shape(x, r)).filter((s) => s.visible) }); });
    }
    return { panels: [...p._registry].map(([x, r]) => shape(x, r)), trace: globalThis.__cxpTrace.slice(-60) };`);
  /* Codex keeps one draft for every new conversation page (key panel-new-conversation of its composer-prompt-drafts-v2
     record, in VS Code's global state) and deletes it only once the message typed into it has gone out as a turn, so a page opened
     before that starts with the message another one sent. Returns what the box held, and what is left after emptying it. */
  const emptyBox = async (f) => {
    const box = f.locator(COMPOSER).first();
    await box.click();
    const read = () => box.evaluate((e) => e.textContent.trim()).catch(() => '');
    const had = await read();
    if (had) {
      await box.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await box.press('Backspace');
      await until(async () => !await read(), 3000, 200);
    }
    return { had, left: await read() };
  };
  /* On CI, Codex has now and then put its "Codex could not start" in the new tab instead of starting its page: the new
     page got none of its files while VS Code still served what other Codex pages had asked for (served()). So the
     button is clicked only after every Codex tab page has drawn and VS Code has served all their requests. If Codex
     still gives up, the button worked, so the test closes that tab and clicks the button once more. */
  const newTabPage = async () => {
    await settle('before the tab bar button opens a new conversation page', 0);
    await openNotes();
    const buttons = await until(async () => { const b = await codexButtons(); return b.length === 1 && b[0] === TITLES.tab && b; }, 15000, 500);
    let before = null, fresh = null;
    for (let tries = 0; tries < 2 && !fresh; tries++) {
      before = new Set(page.frames());
      await codexButton().click();
      /* Codex keeps the page of its hidden sidebar, which also shows a message box and no turns. */
      const got = await until(async () => {
        for (const f of page.frames()) {
          if (before.has(f)) continue;
          try { if (await f.evaluate(() => !!document.querySelector('[data-codex-composer-root]') && !document.querySelector('[data-turn-key]') && innerWidth > 600)) return f; } catch (_) { /* gone */ }
        }
        return await gaveUpInFront() ? 'gaveUp' : null;
      }, 90000, 500);
      if (got !== 'gaveUp') { fresh = got; break; }
      note('the new tab has Codex\'s "Codex could not start", so it is closed');
      await exec('workbench.action.closeActiveEditor');
      await served();
      await openNotes();
    }
    /* On CI this has failed without saying why, so a screenshot and the list of the window's frames are kept. */
    if (!fresh) {
      await shot('new-tab-page-missing');
      const frames = [];
      for (const f of page.frames()) {
        const seen = await f.evaluate(() => ({ url: location.href.slice(0, 120), width: innerWidth, composer: !!document.querySelector('[data-codex-composer-root]'),
          turns: document.querySelectorAll('[data-turn-key]').length, title: document.title })).catch((e) => ({ error: String(e).slice(0, 80) }));
        frames.push(Object.assign({ new: !before.has(f) }, seen));
      }
      note(`the tab bar button opened no new conversation page: buttons before the click ${JSON.stringify(buttons || await codexButtons())}, `
        + `tabs ${JSON.stringify(await tabs().catch(() => null))}, frames ${JSON.stringify(frames)}`);
    }
    return fresh;
  };
  const auxiliaryShowsCodex = () => page.evaluate(() => {
    const part = document.getElementById('workbench.parts.auxiliarybar');
    return !!(part && part.offsetWidth > 0 && part.offsetHeight > 0 && /Codex/.test(part.innerText));
  });

  /* Where the plan bar sits in frame `f` relative to the message box and to Codex's own elements matching `sel` (its
     question card, its approval card). */
  const planBarAgainst = (f, sel) => (f ? f.evaluate((q) => {
    const rect = (e) => { const r = e.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
    const b = document.querySelector('[data-codex-extras="plan-bar"]');
    if (!b || b.style.display === 'none' || !b.getClientRects().length) return null;
    const bar = rect(b), boxEl = document.querySelector('[data-codex-composer-root]');
    const over = (q ? [...document.querySelectorAll(q)] : []).filter((e) => e.getClientRects().length).map(rect)
      .filter((r) => Math.min(r.right, bar.right) - Math.max(r.left, bar.left) > 0 && Math.min(r.bottom, bar.bottom) - Math.max(r.top, bar.top) > 0);
    return { bar, box: boxEl ? rect(boxEl) : null, over };
  }, sel || '').catch(() => null) : null);
  /* Checks that a drawn plan bar covers nothing `sel` selects. */
  const planBarClear = async (f, sel, what) => {
    /* The bar moves only on the message box's next resize, so a card that has just made the box taller can sit under
       the bar for a moment. */
    let at = await planBarAgainst(f, sel);
    if (!at) { note(`${what}: no plan bar was drawn, so whether it would cover it was not checked`); return; }
    if (at.over.length) at = await until(async () => { const x = await planBarAgainst(f, sel); return x && !x.over.length && x; }, 5000, 250) || await planBarAgainst(f, sel) || at;
    check(!at.over.length, `${what}: the plan bar above the message box covers none of it`, at);
  };

  /* A frame of the window's webviews in which `test` (a function of document) is true. */
  const frameWhere = async (test, ms, arg) => until(async () => {
    for (const f of page.frames()) {
      try { if (await f.evaluate(test, arg)) return f; } catch (_) { /* not ready, or gone */ }
    }
    return null;
  }, ms, 500);
  /* The crop of `box` (in the window's CSS pixels) as a PNG, with each of its four edges rounded to the nearest pixel, as
     the page itself snaps them: a size such as 258.5 px rounded alone comes out as 258 in one run and 259 in the next.
     It is taken again when the dialog asking to trust the hooks, which dims the whole window, showed meanwhile. */
  const crop = async (box) => {
    const x = Math.round(box.x), y = Math.round(box.y);
    const clip = { x, y, width: Math.round(box.x + box.width) - x, height: Math.round(box.y + box.height) - y };
    for (let tries = 1; ; tries++) {
      await until(async () => !await trustShown(), 10000, 200);
      const cancelled = trustCancelled;
      const png = await page.screenshot({ animations: 'disabled', clip });
      if (tries >= 4 || (!await trustShown() && trustCancelled === cancelled)) return png;
    }
  };
  /* Resolves once `loc` has stopped changing: its animations have finished and two readings of its box agree. The list's
     menus scale in over a tenth of a second, and a box measured while they do is a few pixels short. */
  const still = async (loc) => {
    let last = '';
    return until(async () => {
      const busy = await loc.evaluate((e) => e.getAnimations({ subtree: true }).some((a) => a.playState === 'running'));
      const box = JSON.stringify(await loc.boundingBox());
      const same = !busy && box === last;
      last = box;
      return same;
    }, 3000, 100);
  };
  /* Rectangles of `boxes` relative to `outer`, for the masks of a crop. */
  const within = (outer, boxes) => boxes.filter(Boolean).map((b) => ({ x: Math.floor(b.x - Math.round(outer.x)), y: Math.floor(b.y - Math.round(outer.y)),
    w: Math.ceil(b.width) + 1, h: Math.ceil(b.height) + 1 }));
  /* Crops the tab's logo and dot, starting three pixels left of and above the first lit pixel. On Windows the tab's box
     is no guide: the logo sat up to one pixel left or three right of where it puts it, and its height changed between
     runs. */
  const logoCrop = async (label) => {
    const box = await page.locator('.tabs-container .tab').filter({ hasText: label }).first().boundingBox();
    if (!box) return null;
    const img = pixels.decode(await crop({ x: box.x, y: box.y, width: Math.min(48, box.width), height: box.height }));
    let left = img.width, top = img.height;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        if ((r > 120 && g > 120 && b > 120) || (r > 180 && g < 110 && b < 110)) { left = Math.min(left, x); top = Math.min(top, y); }
      }
    }
    if (left >= img.width) return null;
    const x0 = Math.max(0, left - 3), y0 = Math.max(0, top - 3), w = Math.min(24, img.width - x0), h = Math.min(22, img.height - y0);
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) img.data.copy(data, y * w * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4);
    return pixels.encode({ width: w, height: h, data });
  };
  /* Counts the pixels of each tab dot colour on the logo of the tab named `label`, and tells a ring from a dot: a
     ring's centre pixel is not green. */
  const dotsOn = async (label) => {
    const tab = page.locator('.tabs-container .tab').filter({ hasText: label }).first();
    const box = await tab.boundingBox();
    if (!box) return null;
    const img = pixels.decode(await crop({ x: box.x, y: box.y, width: Math.min(40, box.width), height: box.height }));
    const count = {};
    const near = (i, c) => Math.abs(img.data[i] - c[0]) <= 24 && Math.abs(img.data[i + 1] - c[1]) <= 24 && Math.abs(img.data[i + 2] - c[2]) <= 24;
    for (const [k, c] of Object.entries(DOTS)) {
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) if (near(i, c)) n++;
      count[k] = n;
    }
    let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (near((y * img.width + x) * 4, DOTS.working)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      }
    }
    count.ring = count.working >= 6 && !near((Math.round((y0 + y1) / 2) * img.width + Math.round((x0 + x1) / 2)) * 4, DOTS.working);
    return count;
  };
  /* Finds the tab whose title is `want` once its envelope is removed. */
  const labelOf = async (want) => {
    const t = (await tabs()).flatMap((g) => g.tabs).find((x) => bare(x.label) === want);
    return t ? t.label : null;
  };

  /* Installing the work plan plugin at start-up asks for trust in its hooks with a modal dialog, which takes every click
     and hover in the window until answered. No step here needs the hooks, so the dialog is cancelled whenever it shows. */
  let watchingTrust = true, trustCancelled = 0;
  const trustDialog = () => page.locator('.monaco-dialog-box').filter({ hasText: 'Trust the work plan hooks in Codex?' }).first();
  const trustShown = () => trustDialog().isVisible().catch(() => false);
  const trustWatch = (async () => {
    while (watchingTrust) {
      try {
        const box = trustDialog();
        if (await box.isVisible()) {
          await box.locator('.dialog-buttons .monaco-button').filter({ hasText: 'Cancel' }).first().dispatchEvent('click');
          trustCancelled++;
        }
      } catch (_) { /* the window is reloading */ }
      await sleep(500);
    }
  })();

  try {
    await w.hostUp();

    /* Checks the look run's list of the Agent Plus settings, commands and views each feature uses against the Agent Plus
       this window has installed. */
    await step('the feature list against the Agent Plus installed', async () => {
      const featureList = require('./lib/feature-list');
      const dir = fs.readdirSync(profile.exts).filter((n) => /^xnervwang\.agent-plus-\d/.test(n)).sort().pop();
      if (!dir) throw new Error(`no Agent Plus in ${profile.exts}`);
      const pkg = JSON.parse(fs.readFileSync(path.join(profile.exts, dir, 'package.json'), 'utf8'));
      const gaps = featureList.agentPlusGaps(featureList.load(), pkg);
      check(!gaps.length, `every setting, command and view of the Agent Plus ${pkg.version} installed here is in ui-look-features.json once`, gaps);
    });

    await step('the patch', async () => {
      const st = await until(async () => { const s = await patchState(); return s && s.targets.every(([, x]) => x === 'patched') && s; }, 120000, 1000);
      check(!!st, 'Codex Plus patches Codex\'s host bundle, its page and its manifest on the first start', await patchState());
      const toast = await until(() => page.evaluate(() => [...document.querySelectorAll('.notification-list-item-message')].map((e) => e.innerText)
        .find((t) => /Codex is patched\. Reload the window/.test(t)) || ''), 30000, 500);
      check(!!toast, 'and VS Code shows its prompt to reload the window', toast);
      await shot('patched-reload-prompt');
      await openNotes();
      await until(async () => (await codexButtons()).length > 0, 15000);
      const before = await codexButtons();
      check(before.length === 1 && before[0] === TITLES.codex, 'until the reload the tab bar has one Codex button, Codex\'s own', before);
      const hover = before.length ? await hoverText(codexButton()) : '';
      check(hover === TITLES.codex, `and its hover reads "${TITLES.codex}"`, hover);
      await shot('tab-bar-before-reload');
    });

    await step('tab bar', async () => {
      await exec('notifications.clearAll');
      /* Codex may have opened a tab of its own on its first start. */
      await settle('tab bar: before the reload', 0);
      await w.reload();
      await until(async () => { const s = await patchState(); return s && s.active; }, 60000, 1000);
      await openNotes();
      const ours = await until(async () => { const b = await codexButtons(); return b.length === 1 && b[0] === TITLES.tab && b; }, 30000, 500);
      check(!!ours, 'after the reload the tab bar has one Codex button, this extension\'s, for codexPlus.tabBarButton "tab"', await codexButtons());
      const hover = await hoverText(codexButton());
      check(hover === TITLES.tab, `its hover reads "${TITLES.tab}"`, hover);
      await shot('tab-bar-after-reload');
      const btn = await codexButton().boundingBox();
      if (btn) base.compare('tab-bar-button', await crop({ x: btn.x - 4, y: btn.y - 4, width: btn.width + 8, height: btn.height + 8 }));

      const groups = (await tabs()).length;
      const framesBefore = new Set(page.frames());
      await codexButton().click();
      const opened = await until(async () => {
        const t = await tabs();
        const front = t.find((g) => g.active).tabs.find((x) => x.active);
        return front && front.view === 'chatgpt.conversationEditor' && front.label === 'Codex' && { t, front };
      }, 20000, 500);
      check(!!opened && opened.t.length === groups, 'a click opens a new Codex conversation in a tab titled Codex, in the group already there rather than a new split',
        opened || await tabs());
      /* Codex's sidebar page, which was already there, has a message box too. The window opens 1024 px wide on macOS
         and Windows, so with Codex's sidebar open the tab's page is narrower than the other steps expect. */
      const loaded = await until(async () => {
        for (const f of page.frames()) {
          if (framesBefore.has(f)) continue;
          if (await f.evaluate(() => !!document.querySelector('[data-codex-composer-root]')).catch(() => false)) return f;
        }
        return null;
      }, 90000, 500);
      check(!!loaded, 'and Codex draws its message box in that tab');
      await shot('tab-bar-new-tab');

      await setting('tabBarButton', 'sidebar');
      const side = await until(async () => { const b = await codexButtons(); return b.length === 1 && b[0] === TITLES.sidebar && b; }, 15000, 500);
      check(!!side, 'with codexPlus.tabBarButton "sidebar" it is still one button, this extension\'s', await codexButtons());
      const sideHover = await hoverText(codexButton());
      check(sideHover === TITLES.sidebar, `its hover reads "${TITLES.sidebar}"`, sideHover);
      const groupsBefore = (await tabs()).length;
      await codexButton().click();
      check(!!await until(auxiliaryShowsCodex, 15000, 500) && (await tabs()).length === groupsBefore, 'and a click shows Codex in the secondary sidebar, with no new tab group');
      await shot('tab-bar-sidebar');
      await exec('workbench.action.closeAuxiliaryBar');
      check(!!await until(async () => !await auxiliaryShowsCodex(), 10000, 300), 'the secondary sidebar closes');
      /* Opening the sidebar goes through a vscode:// link, and VS Code may ask before an extension opens one. */
      await start('codexPlus.openCodex');
      const allow = page.locator('.monaco-dialog-box').filter({ hasText: 'open this URI' }).first();
      if (await allow.waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)) {
        await allow.locator('.dialog-buttons .monaco-button').filter({ hasText: 'Open' }).first().click({ timeout: 5000 });
      }
      check(!!await until(auxiliaryShowsCodex, 15000, 500), 'with codexPlus.tabBarButton "sidebar", Codex Plus: Open Codex shows Codex in the secondary sidebar too');
      await exec('workbench.action.closeAuxiliaryBar');
      await setting('tabBarButton', 'tab');
      const codexTabs = async () => (await tabs()).flatMap((g) => g.tabs).filter((x) => x.view === 'chatgpt.conversationEditor').length;
      const hadTabs = await codexTabs();
      await exec('codexPlus.openCodex');
      const newTab = await until(async () => { const f = await frontTab(); return (await codexTabs()) === hadTabs + 1 && f && f.view === 'chatgpt.conversationEditor' && f.label === 'Codex' && f; }, 20000, 500);
      check(!!newTab, 'and with "tab", it opens a new Codex conversation in a tab, as the button does', await tabs());
      if (newTab) await settle('tab bar: before the tab Codex Plus: Open Codex opened was closed');
      await exec('workbench.action.closeActiveEditor');

      await setting('enabled', false);
      const off = await until(async () => { const b = await codexButtons(); return b.length === 1 && b[0] === TITLES.codex && b; }, 15000, 500);
      check(!!off, 'turned off, the tab bar has Codex\'s own button again, and only that one', await codexButtons());
      await shot('tab-bar-turned-off');
      await setting('enabled', true);
      const on = await until(async () => { const b = await codexButtons(); return b.length === 1 && b[0] === TITLES.tab && b; }, 15000, 500);
      check(!!on, 'turned back on, this extension\'s button is back in its place', await codexButtons());
      await exec('notifications.clearAll');
    });

    /* ── Agent Plus's session list, with the conversations this extension hands it (src/session-list-source.js) ── */
    let sl = null;
    /* A row's data-key, as Agent Plus's keyOf makes it from the source id and the thread id. */
    const slKey = (id) => JSON.stringify(['codex', id]);
    const slRowOf = (t, section = '') => sl.locator(`${section ? `.sl-section[data-key="${section}"]` : '.sl-section:not([data-key="closed"])'} .sl-row[data-key='${slKey(t.id)}']`).first();
    /* Shows the session list's container and finds its page again, since VS Code builds the page anew each time its
       container is shown after another one. */
    const showList = async () => {
      await exec('workbench.view.extension.agentPlusSessions');
      const f = await frameWhere(() => !!document.querySelector('.sl-root .sl-new'), 20000);
      if (f) sl = f;
      return f;
    };
    /* What `id`'s row shows, or null when there is none:
         dot, stripe   as Agent Plus drew them from what this extension reported: green, greenRing, blue, red, redRing or
                       none; here, elsewhere, closed or none
         away          the icon before its time for where else it is open: window, terminal or ''
         section, current, title, unread, shown, depth, hover, badges */
    const slRow = (id, section = '') => (sl ? sl.evaluate(([key, sec]) => {
      const r = [...document.querySelectorAll('.sl-row')].find((x) => x.dataset.key === key && (sec ? x.closest('.sl-section').dataset.key === sec
        : x.closest('.sl-section').dataset.key !== 'closed'));
      if (!r) return null;
      const t = r.querySelector('.sl-title');
      return { dot: r.dataset.dot, stripe: r.dataset.stripe, section: r.closest('.sl-section').dataset.key, current: r.classList.contains('sl-current'),
        title: t ? t.textContent : '', unread: !!r.querySelector('.sl-unread'),
        away: (() => { const a = r.querySelector('.sl-away:not(.sl-hidden)'); return a ? a.dataset.away || '' : ''; })(), shown: !!r.offsetParent && !r.closest('.sl-hidden'),
        depth: r._row ? r._row.depth || 0 : 0, hover: r._row ? String(r._row.hover || '') : '', badges: [...r.querySelectorAll('.sl-badge')].map((b) => b.textContent) };
    }, [slKey(id), section]).catch(() => null) : Promise.resolve(null));
    /* Waits up to `ms`, with the list shown, for `id`'s row to pass `test`. */
    const slRowSays = async (id, test, ms = 15000) => {
      if (!await showList()) return null;
      return until(async () => { const r = await slRow(id); return !!r && test(r) && r; }, ms, 500);
    };
    /* The session id and section of each row the list marks as current, as "<id> <section>". */
    const currentRows = async () => {
      if (!await showList()) return null;
      return sl.evaluate(() => [...document.querySelectorAll('.sl-row.sl-current')].map((r) => {
        let id = r.dataset.key;
        try { id = JSON.parse(r.dataset.key)[1]; } catch (_) { /* kept as it is */ }
        return `${id} ${r.closest('.sl-section').dataset.key}`;
      })).catch(() => null);
    };
    /* Exactly one row, in any section, is drawn as current for the conversation in front, and none when no conversation
       is in front. */
    const drawnCurrent = (rows, id) => !!rows && (id ? rows.length === 1 && rows[0].startsWith(`${id} `) : rows.length === 0);
    const checkCurrent = async (id, what) => {
      const got = await until(async () => { const r = await currentRows(); return drawnCurrent(r, id) && r; }, 20000, 500);
      check(!!got, `${what}: Agent Plus's session list draws ${id ? 'that conversation\'s row' : 'no row'} as the current one, and no other row`,
        { want: id, rows: got || await currentRows() });
      return !!got;
    };
    /* The conversations whose rows have the 'here' stripe, the one for a conversation open in this window. */
    const hereRows = async () => {
      if (!await showList()) return null;
      return sl.evaluate(() => [...document.querySelectorAll('.sl-section:not([data-key="closed"]) .sl-row[data-stripe="here"]')]
        .map((r) => { try { return JSON.parse(r.dataset.key)[1]; } catch (_) { return r.dataset.key; } })).catch(() => null);
    };
    /* Agent Plus's Work plan view shows the plan of the conversation in front; each test plan has one row. */
    const PLANS = path.join(profile.codexHome, 'plugins', 'data', 'agent-work-plan-codex-extras');
    const planFor = (id, rowTitle) => {
      fs.mkdirSync(PLANS, { recursive: true });
      const at = new Date().toISOString().replace(/\.\d+Z$/, '+00:00');
      fs.writeFileSync(path.join(PLANS, `${id}.json`), JSON.stringify({ nodes: [{ title: rowTitle, state: 'doing', since: at }] }));
    };
    /* The rows of the Work plan view. Agent Plus's container is shown to read them and the session list put back
       afterwards, since the steps that read the list's page expect it there. */
    const planRows = async () => {
      await exec('workbench.view.extension.agentPlus');
      const rows = await page.evaluate(() => {
        const bar = document.getElementById('workbench.parts.sidebar');
        return bar ? [...bar.querySelectorAll('.monaco-list-row')].filter((r) => r.offsetParent).map((r) => r.innerText.trim()) : [];
      }).catch(() => []);
      await showList();
      return rows;
    };
    const planTitle = (id) => `Work plan of ${id}`;
    /* Writes a one-row plan for `id` and checks that the Work plan view shows it. */
    const planShown = async (id, what) => {
      planFor(id, planTitle(id));
      await exec('agentPlus.refreshWorkPlan');
      return checkPlan(planTitle(id), what);
    };
    const checkPlan = async (rowTitle, what) => {
      /* A row reads "1. <title>" and its times. */
      const got = await until(async () => { const r = await planRows(); return r.some((x) => x.includes(rowTitle)) && r; }, 20000, 500);
      check(!!got, `${what}: Agent Plus's Work plan view shows that conversation's plan`, { want: rowTitle, rows: got || await planRows() });
      return !!got;
    };
    /* A press outside the page's menus closes them and does nothing else (Agent Plus's session-list-page.js); the bottom
       of the list is empty. */
    const closeMenus = async () => {
      if (!await sl.evaluate(() => !!document.querySelector('.sl-ctx')).catch(() => false)) return;
      await page.keyboard.press('Escape');
      if (await until(() => sl.evaluate(() => !document.querySelector('.sl-ctx')), 1000, 100)) return;
      const box = await (await sl.frameElement()).boundingBox();
      await page.mouse.click(box.x + 20, box.y + box.height - 12);
      await until(() => sl.evaluate(() => !document.querySelector('.sl-ctx')), 3000, 100);
    };
    /* An item of the row's menu, or of its submenu, whose whole label is `label`, a submenu arrow or a check mark aside:
       Archive is not Unarchive. */
    const slItem = (label, sub = false) => sl.locator(sub ? '.sl-ctx-sub .sl-ctx-item' : '.sl-ctx:not(.sl-ctx-sub) .sl-ctx-item')
      .filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[›✓]?\\s*$`) }).first();
    /*
     * Right-clicks `t`'s row and clicks the menu item labels[0], or, given labels[1], that item of its submenu.
     * The page closes its menu when its window loses focus, like VS Code's own menus, and another webview of the
     * window (Codex's page in a tab) can take the focus at any moment; a click then lands on whatever was under the
     * menu. So the page records where each click lands, and a click that missed the item while the page lost the focus
     * is retried, at most twice. An item with a submenu is clicked to open it: in a side bar too narrow for the
     * submenu beside the menu, it opens in the menu's place, and resting on the item opens nothing.
     */
    const pick = async (t, labels) => {
      await sl.evaluate(() => {
        window.__landed = [];
        if (window.__landedHook) return;
        window.__landedHook = true;
        window.addEventListener('click', (e) => {
          const item = e.target.closest && e.target.closest('.sl-ctx-item');
          window.__landed.push(item ? item.textContent.replace(/[›✓]/g, '').trim() : `outside the menu (${e.target.className || e.target.tagName})`);
        }, true);
        window.addEventListener('blur', () => window.__landed.push('the page lost the focus'));
      });
      const said = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        await closeMenus();
        await sl.evaluate(() => { window.__landed = []; });
        await slRowOf(t).click({ button: 'right' });
        if (!await until(() => sl.evaluate(() => !!document.querySelector('.sl-ctx')), 5000, 100)) { said.push('no menu opened'); continue; }
        const lostFocus = () => sl.evaluate(() => window.__landed.includes('the page lost the focus'));
        try {
          if (labels.length > 1) {
            await slItem(labels[0]).click({ timeout: 5000 });
            await slItem(labels[1], true).click({ timeout: 5000 });
          } else await slItem(labels[0]).click({ timeout: 5000 });
        } catch (e) {
          if (!await lostFocus()) throw e;
          said.push(`the menu closed before the click: ${e.message.split('\n')[0]}`);
          continue;
        }
        const landed = await sl.evaluate(() => window.__landed.slice());
        const last = labels[labels.length - 1];
        if (landed.some((x) => x === last || x.startsWith(last))) return attempt;
        said.push(landed.join(', ') || 'nothing recorded');
        if (!landed.includes('the page lost the focus')) throw new Error(`the click on ${labels.join(' > ')} landed elsewhere: ${said.join('; ')}`);
        await sleep(500);
      }
      throw new Error(`the menu kept closing before ${labels.join(' > ')} could be clicked: ${said.join('; ')}`);
    };
    const retried = (n, what) => { if (n > 1) note(`${what} took ${n} tries: the session list lost the focus while its menu was open`); };
    /* The list's menu offers Mark as Unread only on a row it does not already show as unread, so a row shown as unread
       is marked read first, as happens when a reply landed while its tab was in front for less than the time the list
       takes as seeing it. */
    const readInList = async (t) => {
      if (!((await slRow(t.id)) || {}).unread) return;
      retried(await pick(t, ['Mark as Read']), 'Mark as Read');
      await until(async () => !((await slRow(t.id)) || {}).unread, 10000, 300);
    };
    /* The hover lines of a row that name work still running (LEFT_WORDS in src/session-list-source.js), '' for none. */
    const leftLines = (r) => (r ? r.hover.split('\n').filter((l) => / is still (running|busy)$/.test(l)).join('\n') : '');
    const agentSetting = (key, value) => call(`await vscode.workspace.getConfiguration('agentPlus').update(${JSON.stringify(key)}, arg, vscode.ConfigurationTarget.Global); return true;`, value);
    /* Agent Plus's session list with the conversations this extension hands it (src/session-list-source.js). The three
       made-up conversations are in Ungrouped under their titles, and none is running, waiting or open here. The two
       Codex archived some time ago (prepare below) were imported as archived the first time the list saw Codex. The run
       of codex exec in the window's folder (lib/fake-home.js BACKGROUND) is background work and has no row, and neither
       has the conversation in a folder the window does not open (ELSEWHERE). */
    await step('Codex\'s conversations in Agent Plus\'s session list', async () => {
      check(!!await showList(), 'Agent Plus\'s session list opens in its own activity bar container');
      if (!sl) return;
      const rows = () => sl.evaluate(() => [...document.querySelectorAll('.sl-row')].map((r) => {
        let key = [];
        try { key = JSON.parse(r.dataset.key); } catch (_) { /* not a key */ }
        return { source: key[0], id: key[1], title: r.querySelector('.sl-title').textContent, section: r.closest('.sl-section').dataset.key,
          dot: r.dataset.dot, stripe: r.dataset.stripe };
      })).catch(() => null);
      const want = [...threads.map((t) => [t, 'ungrouped']), ...ARCHIVED.map((t) => [t, 'archived'])];
      const listed = await until(async () => { const r = await rows(); return r && want.every(([t, s]) => r.some((x) => x.id === t.id && x.section === s)) && r; }, 30000, 500);
      const of = (t) => (listed || []).find((x) => x.id === t.id) || null;
      check(!!listed && threads.every((t) => { const x = of(t); return x.source === 'codex' && x.title === t.title; }),
        `it lists the ${threads.length} made-up conversations in Ungrouped, as Codex's, each by its title`, listed || await rows());
      check(!!listed && threads.every((t) => of(t).dot === 'none' && of(t).stripe === 'none'),
        'none of them has a dot, as none runs or waits, nor the stripe of a conversation open in this window', listed && threads.map(of));
      check(!!listed && ARCHIVED.every((t) => of(t).title === t.title),
        'the two conversations Codex archived are in Archived, imported as Codex had them the first time the list saw Codex', listed && ARCHIVED.map(of));
      if (!listed) {
        const db = await call(`${OWN} const f = own('codex-files'); const t = f.listThreads() || [];
          return { file: f.stateDbPath(), backfillDone: f.backfillDone(), backfill: f.query('select status, updated_at from backfill_state'),
            archived: t.filter((x) => x.archived).map((x) => x.id), threads: t.length };`).catch((e) => String(e));
        note(`what Codex Plus reads of Codex's state database after the list was not as expected: ${JSON.stringify(db)}`);
      }
      const bg = fakeHome.BACKGROUND;
      const kind = await call(`${OWN} const t = (own('codex-files').listThreads() || []).find((x) => x.id === arg);
        return t ? { kind: t.kind, source: t.source, cwd: t.cwd } : null;`, bg.id).catch((e) => String(e));
      const shownNow = await rows();
      check(!!kind && kind.kind === 'background' && !!shownNow && !shownNow.some((x) => x.id === bg.id),
        'the run of codex exec in the window\'s folder is one Codex Plus takes for background work, and the list, which leaves such work out, has no row for it',
        { kind, rows: shownNow });
      check(!!shownNow && !shownNow.some((x) => x.id === fakeHome.ELSEWHERE.id), 'nor for the conversation in a folder the window does not open', shownNow);
      /* The list's unread mark is its own record of the replies seen in this window, with the source's viewedAt. This
         extension gives no viewedAt, so the step notes which rows have the mark while no tab has an envelope, and does
         not check it. */
      const marked = (await Promise.all(threads.map((t) => slRow(t.id)))).filter((r) => r && r.unread).map((r) => r.title);
      if (marked.length) note(`the list draws the unread mark on ${marked.length} of the made-up conversations, none of whose tabs this window has shown: ${JSON.stringify(marked)}`);
      await page.mouse.move(5, 880);
      await sleep(300);
      await shot('agent-plus-session-list');
    });

    /* A minute after the window starts, with codexPlus.deleteArchivedAfterDays at 20, the pass over archived
       conversations would delete the conversation Codex archived 25 days ago (prepare below). While Agent Plus's session
       list archives and deletes conversations in the window, the pass leaves that to the list, so both archived
       conversations stay in its Archived section. */
    await step('conversations archived long ago are left to Agent Plus\'s session list', async () => {
      const rolloutOf = (id) => { try { return fs.readdirSync(path.join(profile.codexHome, 'archived_sessions'), { recursive: true }).some((n) => String(n).includes(id)); } catch (_) { return false; } };
      const [old, recent] = ARCHIVED;
      const up = await until(async () => { const s = await call('return process.uptime();').catch(() => 0); return s >= 75 && s; }, 90000, 2000);
      if (!up) note('the extension host had not been up for 75 s within 90 s, so the pass activation starts may not have run yet');
      const pass = await call(`const mine = vscode.extensions.getExtension('xnervwang.codex-plus');
        const file = require('path').join(mine.extensionPath, 'extension.js');
        const k = Object.keys(require.cache).find((x) => x.toLowerCase() === file.toLowerCase());
        return k ? await require.cache[k].exports._sweepArchived() : null;`).catch((e) => String(e));
      check(!!pass && pass.ran === false && /Agent Plus's session list/.test(pass.why || ''),
        'the pass over archived conversations does not run while Agent Plus\'s session list archives and deletes conversations, and says that is why', pass);
      check(rolloutOf(old.id) && rolloutOf(recent.id), 'so the conversation archived 25 days ago keeps its rollout in archived_sessions/, as does the one archived 10 days ago',
        ARCHIVED.map((t) => [t.title, rolloutOf(t.id)]));
      const kept = await slRowSays(old.id, (r) => r.section === 'archived', 10000);
      check(!!kept, 'and Agent Plus\'s list keeps it in Archived', await slRow(old.id, 'archived'));
    });

    /* The made-up conversation that no other step uses, archived in Agent Plus's list and deleted from its Archived
       section. The list's confirmation lists what will be deleted in this extension's words, and Delete goes to this
       extension, which has Codex delete the rollout. */
    await step('a conversation deleted from Agent Plus\'s session list', async () => {
      if (!await showList()) throw new Error('the session list did not open');
      const t = threads[2];
      const under = (top) => { try { return fs.readdirSync(path.join(profile.codexHome, top), { recursive: true }).filter((n) => String(n).includes(t.id)); } catch (_) { return []; } };
      const rollouts = () => [...under('sessions'), ...under('archived_sessions')];
      const dialog = () => page.evaluate(() => {
        const d = [...document.querySelectorAll('.monaco-dialog-box')].find((e) => e.offsetParent);
        if (!d) return null;
        const text = (sel) => { const e = d.querySelector(sel); return e ? e.innerText.trim() : ''; };
        return { title: text('.dialog-message-text'), detail: text('.dialog-message-detail'),
          buttons: [...d.querySelectorAll('.dialog-buttons .monaco-button')].map((b) => b.innerText.trim()) };
      });
      const press = (label) => page.locator('.monaco-dialog-box .dialog-buttons .monaco-button').filter({ hasText: label }).first().click({ timeout: 5000 });
      check(under('sessions').length === 1 && !!await slRow(t.id), 'the conversation to delete is listed and has its rollout in the made-up Codex home', { rollouts: rollouts(), row: await slRow(t.id) });
      retried(await pick(t, ['Archive']), 'Archive');
      const archived = await until(async () => { const r = await slRow(t.id); return r && r.section === 'archived' && r; }, 20000, 500);
      check(!!archived && under('sessions').length === 1, 'Archive in its row\'s menu puts it in the list\'s Archived, and leaves its rollout where Codex has it',
        { row: archived || await slRow(t.id), rollouts: rollouts() });
      if (!await sl.evaluate(() => { const s = document.querySelector('.sl-section[data-key="archived"]'); return !s || s.classList.contains('sl-open'); })) {
        await sl.locator('.sl-section[data-key="archived"] .sl-head').first().click();
      }
      await sleep(500);
      retried(await pick(t, ['Delete...']), 'Delete...');
      const asked = await until(dialog, 15000, 300);
      if (!asked) {
        note(`no confirmation drawn in the window was found on ${process.platform}, so Delete was not tried here: VS Code may have shown the system's own dialog`);
        await shot('delete-no-dialog');
        return;
      }
      await shot('delete-confirmation');
      check(asked.title === `Delete "${t.title}" from disk?` && asked.buttons.includes('Delete') && asked.detail.startsWith(`"${t.title}" (Codex): the rollout (`)
        && /This cannot be undone\.$/.test(asked.detail),
      'Delete... opens the list\'s confirmation, naming the conversation and, as this extension describes it, what goes and its size', asked);
      await press('Delete');
      const gone = await until(async () => !await slRow(t.id) && rollouts().length === 0, 30000, 500);
      check(!!gone, 'Delete has this extension delete it: its row leaves the list and its rollout the Codex home', { row: await slRow(t.id), rollouts: rollouts(), toasts: await toasts() });
      await shot('delete-done');
    });
    let codex = null;
    const title = threads[0].title;
    /*
     * Reads, in Codex's page `f`, how far the conversation's scroller is from its end, whether the row of buttons under
     * the last reply is within the scroller's view and above the plan bar, and whether Codex shows its arrow back to
     * the latest message, which it does once the conversation is more than 112 px from its end. The plan bar's room
     * comes out of the scroller's height, and keepEnd in src/page/codex-extras-page.js keeps a conversation at its end
     * when that room is taken or given back. Codex itself treats a conversation within 24 px of its end as being at its
     * end.
     */
    const endOf = (f) => (f ? f.evaluate(() => {
      const sc = document.querySelector('[data-app-action-timeline-scroll]');
      const replies = sc ? sc.querySelectorAll('[data-local-conversation-final-assistant]') : [];
      const reply = replies[replies.length - 1];
      const arrow = document.querySelector('button[class*="scroll-to-bottom"]');
      if (!sc || !reply) return { scroller: !!sc, reply: !!reply };
      const s = sc.getBoundingClientRect(), viewTop = s.top + sc.clientTop, viewBottom = viewTop + sc.clientHeight;
      const bar = document.querySelector('[data-codex-extras="plan-bar"]');
      const barTop = bar && bar.style.display !== 'none' && bar.getClientRects().length ? bar.getBoundingClientRect().top : Infinity;
      const buttons = [...reply.querySelectorAll('button')].map((b) => b.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
      const row = buttons.length ? { top: Math.min(...buttons.map((b) => b.top)), bottom: Math.max(...buttons.map((b) => b.bottom)) } : null;
      const fromEnd = sc.scrollHeight - sc.clientHeight - sc.scrollTop;
      return { fromEnd: Math.round(fromEnd), atEnd: fromEnd <= 24, view: [viewTop, viewBottom].map(Math.round), barTop: barTop === Infinity ? null : Math.round(barTop),
        row: row && [row.top, row.bottom].map((v) => Math.round(v * 10) / 10), buttons: buttons.length,
        rowInView: !!row && row.top >= viewTop - 1 && row.bottom <= Math.min(viewBottom, barTop) + 1, arrow: arrow ? arrow.getAttribute('aria-hidden') !== 'true' : null };
    }).catch((e) => ({ error: String(e) })) : Promise.resolve(null));
    const endInView = async (f, what) => {
      const fine = (x) => !!x && x.atEnd && x.rowInView && x.arrow === false;
      const at = await until(async () => { const x = await endOf(f); return fine(x) && x; }, 5000, 250) || await endOf(f);
      check(fine(at), `${what}: the conversation is at its end, with the row of buttons under its last reply in view above the message box, and Codex shows no arrow back to the latest message`, at);
    };
    /* Clicks the rail's "Bottom of the conversation" button in `f`, after a scroll up with the mouse wheel when `wheel`
       is set. Codex stops following the end at that scroll up and does not treat the
       rail's jump as a scroll of the user's, so it is the page script that keeps the end in view afterwards. The click
       is dispatched to the button: in a page too short for the whole rail to fit above the plan bar, the bar is still
       drawn over the rail's lower buttons. */
    const railToEnd = async (f, wheel, what) => {
      if (wheel) {
        const sb = await f.locator('[data-app-action-timeline-scroll]').first().boundingBox().catch(() => null);
        if (sb) { await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2); await page.mouse.wheel(0, -300); await sleep(800); }
      }
      const up = await endOf(f);
      await f.locator('[data-codex-extras="nav-button"][aria-label="Bottom of the conversation"]').first().dispatchEvent('click', {}, { timeout: 5000 }).catch(() => {});
      const at = await until(async () => { const x = await endOf(f); return x && x.fromEnd <= 1 && x; }, 5000, 250) || await endOf(f);
      check(!!at && at.fromEnd <= 1, `${what}: the rail's Bottom of the conversation brings the conversation to its end${wheel ? ' after a scroll up with the wheel' : ''}`, { before: up, after: at });
    };
    await step('a conversation in a tab', async () => {
      if (!await showList()) throw new Error('the session list did not open');
      const groups = (await tabs()).length;
      let open = null;
      codex = await shownOrAgain('a conversation in a tab', async () => {
        await showList();
        await slRowOf(threads[0]).click();
        open = open || await until(async () => { const t = await tabs(); const x = t.flatMap((g) => g.tabs).find((y) => bare(y.label) === title); return x && x.active && t; }, 20000, 500);
      }, () => frameWhere((want) => !!document.querySelector('[data-codex-composer-root]') && document.querySelectorAll('[data-turn-key]').length >= 4
        && document.body.innerText.includes(want), 0, title));
      check(!!open && open.length === groups, 'a click on its row in Agent Plus\'s session list opens the conversation in a tab of the group there, titled by the conversation',
        open || await tabs());
      check(!!codex, 'Codex draws the conversation in that tab, every turn of it, with its message box');
      await shot('conversation-tab');
      const here = await slRowSays(threads[0].id, (r) => r.stripe === 'here');
      check(!!here && here.dot === 'none', 'its row then has the stripe of a conversation open in this window, and still no dot, as its tab has none',
        here || await slRow(threads[0].id));
      await checkCurrent(threads[0].id, 'with the tab opened from its row in front');
      await planShown(threads[0].id, 'with the tab opened from its row in front');
      const drawnBar = await until(() => codex.evaluate(() => {
        const b = document.querySelector('[data-codex-extras="plan-bar"]');
        return !!b && b.style.display !== 'none' && b.getClientRects().length > 0;
      }), 20000, 400);
      if (drawnBar) await endInView(codex, 'with the plan bar drawn over the conversation just opened');
      else check(false, 'the plan written for the conversation draws the plan bar in its tab', await endOf(codex));
    });

    await step('Codex\'s page', async () => {
      if (!codex) throw new Error('the conversation did not open');
      await clearToasts();
      await sleep(2000);
      const seen = await codex.evaluate(() => ({
        user: document.querySelectorAll('.codex-extras-stamp-user').length, assistant: document.querySelectorAll('.codex-extras-stamp-assistant').length,
        rail: !!document.querySelector('.codex-extras-rail'),
        railAt: (() => { const r = document.querySelector('.codex-extras-rail'); if (!r) return null; const b = r.getBoundingClientRect();
          const bar = document.querySelector('[data-codex-extras="plan-bar"]'), sc = document.querySelector('[data-app-action-timeline-scroll]');
          return { top: b.top, bottom: b.bottom, off: Math.abs(b.top + b.height / 2 - innerHeight / 2),
            bar: bar && bar.getClientRects().length ? bar.getBoundingClientRect().top : null, scroller: sc ? sc.getBoundingClientRect().top : null }; })(),
        buttons: document.querySelectorAll('[data-codex-extras="bar-button"]').length,
        meter: !!document.querySelector('[data-codex-extras="meter"]'), pill: ((document.querySelector('[data-codex-extras="agents"]') || {}).innerText || '').trim(),
        turns: document.querySelectorAll('[data-turn-key]').length }));
      check(seen.user === 4 && seen.assistant >= 4, 'each of the four messages and replies carries a time stamp', seen);
      check(seen.rail, 'the rail at the right edge is drawn', seen);
      const railFits = (a) => a.off <= 1 || (a.bar !== null && (Math.abs(a.bottom - (a.bar - 4)) <= 1 || (a.scroller !== null && Math.abs(a.top - (a.scroller + 4)) <= 1)));
      check(!!seen.railAt && Number.isInteger(seen.railAt.top) && railFits(seen.railAt),
        'and is on a whole pixel, so its arrows are drawn sharp, centred unless that would put it under the plan bar', seen.railAt);
      check(seen.buttons === 2 && seen.meter, 'the information and chime buttons and the context meter are by the message box', seen);
      check(/1 timer/.test(seen.pill), 'the Agent map pill names the wake-up the conversation has', seen.pill);
      /* Each crop is one control, so none takes in Codex's buttons or the gap before the pill, which moves by a pixel. */
      const drawnAt = async (sel) => {
        const frame = await (await codex.frameElement()).boundingBox().catch(() => null);
        const r = await codex.evaluate((q) => {
          const all = [...document.querySelectorAll(q)].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0);
          return all.length ? { x0: Math.min(...all.map((b) => b.left)), y0: Math.min(...all.map((b) => b.top)), x1: Math.max(...all.map((b) => b.right)), y1: Math.max(...all.map((b) => b.bottom)) } : null;
        }, sel).catch(() => null);
        return frame && r ? { frame: { x: frame.x, y: frame.y }, ...r } : null;
      };
      for (const [name, sel] of [['composer-buttons', '[data-codex-extras="bar-button"]'], ['composer-meter', '[data-codex-extras="meter"]'], ['composer-pill', '[data-codex-extras="agents"]']]) {
        await clearToasts();
        const left = (await toasts()).filter(Boolean);
        if (left.length) note(`${name}: notifications still on screen before its crop: ${JSON.stringify(left).slice(0, 300)}`);
        /* The page's frame has been measured a pixel off where the window drew it, once. */
        let at = null, png = null;
        for (let tries = 0; tries < 5; tries++) {
          const before = await drawnAt(sel);
          if (!before) break;
          png = await crop({ x: before.frame.x + before.x0 - 2, y: before.frame.y + before.y0 - 2, width: before.x1 - before.x0 + 4, height: before.y1 - before.y0 + 4 });
          const after = await drawnAt(sel);
          at = { before, after };
          if (JSON.stringify(before) === JSON.stringify(after)) break;
          await sleep(300);
        }
        /* Where it was drawn, to a fraction of a pixel: a glyph drawn half a pixel lower differs on every column. */
        if (png) base.compare(name, png, { detail: `drawn at ${JSON.stringify(at)}` });
      }

      await codex.locator('.codex-extras-rail-handle').first().click();
      const rows = await until(() => codex.evaluate(() => {
        const p = document.querySelector('.codex-extras-panel');
        return p && getComputedStyle(p).display !== 'none' && [...p.querySelectorAll('.codex-extras-row')].map((x) => x.textContent);
      }), 5000, 200);
      check(!!rows && rows.length === 4 && rows.every((t) => /^(\d\d\/\d\d )?\d\d:\d\d:\d\d {2}\S/.test(t)), 'the rail\'s handle opens the list of your messages, one row each with its time', rows);
      await shot('conversation-rail-list');
      /* A jump that scrolls more than Codex's own scroller moves the whole page up (scrollToNode in the page script). */
      const host = await codex.parentFrame().frameElement();
      const placed = async () => ({ top: ((await host.boundingBox()) || {}).y,
        scrolled: await host.evaluate((e) => { let n = 0; for (let x = e.parentElement; x; x = x.parentElement) n += x.scrollTop; return n; }),
        others: await page.evaluate(() => [...document.querySelectorAll('.webview-overlay-content')].filter((e) => e.scrollTop)
          .map((e) => { const f = e.querySelector('iframe'); return `${e.scrollTop} px: ${f ? (f.title || f.name || f.className) : '(no webview)'}`; })) });
      const placedBefore = await placed();
      await codex.locator('[data-codex-extras="nav-row"]').nth(2).click();
      await sleep(1500);
      const placedAfter = await placed();
      check(placedAfter.top === placedBefore.top && placedAfter.scrolled === 0,
        'a jump from the list moves the conversation inside Codex\'s page, and leaves the page where VS Code put it', { before: placedBefore, after: placedAfter });
      if (placedAfter.others.length) note(`other webviews VS Code has scrolled inside their boxes: ${placedAfter.others.join('; ')}`);
      await codex.locator('.codex-extras-rail-handle').first().click();

      await codex.locator('[data-codex-extras="agents"]').first().click();
      const map = await until(() => codex.evaluate(() => {
        const d = document.querySelector('[data-codex-extras="map-dialog"]');
        const s = d && d.querySelector('[data-codex-extras="map-wakeups"]');
        return d && { text: d.innerText, prompt: s ? s.textContent : '', wakeups: !!s, remove: !!d.querySelector('[data-codex-extras-act="removeWakeup"]') };
      }), 5000, 200);
      check(!!map && map.wakeups && map.remove && /every 45 min/.test(map.text) && /nightly export/.test(map.prompt),
        'the pill opens the Agent map, with the wake-up\'s interval, its prompt and Remove', map);
      /* Laid out as Claude Code Plus lays out Claude Code's map: first the conversation's row under its own heading, then
         each section under a heading in capitals, with its count and a line above it. */
      const laid = await codex.evaluate(() => {
        const d = document.querySelector('[data-codex-extras="map-dialog"]');
        if (!d) return null;
        const own = d.querySelector('[data-codex-extras="map-me"] [data-codex-extras-card]');
        return { sections: [...d.querySelectorAll('[data-codex-extras^="map-"]')].map((x) => x.getAttribute('data-codex-extras')).filter((k) => /^map-(me|agents|work|wakeups|goal)$/.test(k)),
          heads: [...d.querySelectorAll('[data-codex-extras-head]')].map((h) => [h.getAttribute('data-codex-extras-head'),
            (h.querySelector('[data-codex-extras-count]') || {}).textContent || null, getComputedStyle(h.firstChild).textTransform, getComputedStyle(h).borderTopWidth]),
          own: own ? [(own.querySelector('[data-codex-extras-name]') || {}).textContent, (own.querySelector('[data-codex-extras-meta]') || {}).textContent] : null };
      }).catch(() => null);
      check(!!laid && laid.sections.join() === 'map-me,map-wakeups'
        && JSON.stringify(laid.heads) === JSON.stringify([['This conversation', null, 'uppercase', '0px'], ['Wake-ups', '1', 'uppercase', '1px']])
        && !!laid.own && laid.own[0] === title && /tokens in context$/.test(laid.own[1]),
      'the map has the conversation\'s own card first, titled by the conversation, with the model and the context in use under it, then the wake-up\'s section, '
      + 'each under a heading in capitals, the wake-up\'s with its count and a line above it', laid);
      await shot('agent-map');
      const dialog = codex.locator('[data-codex-extras="map-dialog"]').first();
      await still(dialog);
      const dbox = await dialog.boundingBox();
      check(!!dbox && [dbox.x, dbox.y].every((v) => Math.abs(v - Math.round(v)) < 0.01),
        'the Agent map sits on whole pixels, so its lines of text are drawn in the same place every time', dbox);
      const times = await dialog.locator('[data-codex-extras="map-wakeups"] [data-codex-extras-meta]').boundingBox().catch(() => null);
      /* The model and the context the conversation holds: both come from what the made-up model counted. */
      const context = await dialog.locator('[data-codex-extras="map-me"] [data-codex-extras-meta]').boundingBox().catch(() => null);
      /* A next wake-up after midnight carries its date, which widens the dialog past the approved copy. */
      const dated = !!map && /next \d\d\/\d\d/.test(map.text);
      if (dbox && !dated) base.compare('agent-map-dialog', await crop(dbox), { masks: within(dbox, [times, context]) });
      else if (dated) note('the next wake-up falls after midnight, so its date widens the Agent map; its crop was not compared');
      await page.keyboard.press('Escape');
      check(!!await until(() => codex.evaluate(() => !document.querySelector('[data-codex-extras="map-dialog"]')), 5000, 200), 'Esc closes it');

      const infoButton = codex.locator('[data-codex-extras="bar-button"][aria-label^="About this conversation"]').first();
      await infoButton.click();
      const info = await until(() => codex.evaluate(() => {
        const b = document.querySelector('[data-codex-extras="info"]');
        return b && getComputedStyle(b).display !== 'none' && b.innerText;
      }), 10000, 200);
      check(!!info && /Token mode/.test(info) && !/Work plan/.test(info), 'the information box names the token mode, and leaves the work plan to the context meter', info);
      /* Each place a value of the box goes on to a new line, as the few characters on either side of it. */
      const midWord = await codex.evaluate(() => {
        const bad = [];
        for (const v of document.querySelectorAll('[data-codex-extras="info"] span[title="Click to copy"]')) {
          const chars = [];
          const walk = document.createTreeWalker(v, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) for (let i = 0; i < n.nodeValue.length; i++) chars.push([n, i]);
          let top = null;
          chars.forEach(([n, i], k) => {
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            const b = r.getClientRects()[0];
            if (!b) return;
            const before = k ? chars[k - 1][0].nodeValue[chars[k - 1][1]] : '';
            if (top !== null && b.top > top + 2 && !/[\s/\\-]/.test(before)) bad.push(`${v.textContent.slice(Math.max(0, k - 8), k)}|${v.textContent.slice(k, k + 8)}`);
            top = b.top;
          });
        }
        return bad;
      }).catch((e) => [String(e)]);
      check(midWord.length === 0, 'the information box breaks a value\'s lines between words or after a path\'s slash, never inside a word', midWord);
      await shot('information-box');
      await infoButton.click();
      await codex.locator('[data-codex-extras="meter"]').first().hover();
      const hover = await until(() => codex.evaluate(() => {
        const b = document.querySelector('[data-codex-extras="context"]');
        return b && getComputedStyle(b).display !== 'none' && /Work plan:/.test(b.innerText) && b.innerText;
      }), 10000, 200);
      check(!!hover && /Work plan: injected 1 time since the conversation began: \d+ characters, about \d+ tokens/.test(hover),
        'the context meter\'s hover says how much the work plan has added to the conversation\'s context', hover);
      /* The meter's hover reaches up over the plan bar; where they overlap, the hover must be drawn on top. */
      const overBar = await codex.evaluate(() => {
        const b = document.querySelector('[data-codex-extras="context"]'), p = document.querySelector('[data-codex-extras="plan-bar"]');
        if (!b || !p || !p.getClientRects().length) return { bar: !!p };
        const x = b.getBoundingClientRect(), y = p.getBoundingClientRect();
        const l = Math.max(x.left, y.left), r = Math.min(x.right, y.right), t = Math.max(x.top, y.top), d = Math.min(x.bottom, y.bottom);
        if (r - l < 2 || d - t < 2) return { bar: true, meet: false };
        const top = document.elementFromPoint((l + r) / 2, (t + d) / 2);
        return { bar: true, meet: true, hoverOnTop: !!top && b.contains(top) };
      }).catch((e) => ({ error: String(e) }));
      if (overBar.meet) check(overBar.hoverOnTop, 'where the context meter\'s hover meets the plan bar, the hover is drawn over the bar', overBar);
      else note(`the context meter's hover and the plan bar did not meet (${JSON.stringify(overBar)}), so which is on top was not checked`);
      await shot('context-meter-hover');
      /* Jumping the pointer from the meter to the window's corner leaves the hover open. The hover takes the click meant
         for the message box, and every click after it. The pointer goes to the top of the conversation, above the hover,
         which reaches up over the middle of it. */
      const talk = await codex.locator('[data-app-action-timeline-scroll]').first().boundingBox();
      /* Once, a single jump of the pointer left the meter matching :hover in Codex's page, which then never saw the
         pointer leave. */
      await page.mouse.move(talk ? talk.x + 30 : 0, talk ? talk.y + 15 : 0, { steps: 6 });
      /* For a hover left open: whether the page still thinks the pointer is over the meter or the hover, and what is
         under the point the pointer moved to. */
      const hoverState = () => codex.evaluate(() => {
        const b = document.querySelector('[data-codex-extras="context"]'), m = document.querySelector('[data-codex-extras="meter"]');
        const t = document.querySelector('[data-app-action-timeline-scroll]'), tr = t && t.getBoundingClientRect();
        const at = tr ? { x: Math.round(tr.left + 30), y: Math.round(tr.top + 15) } : null;
        const under = at ? document.elementFromPoint(at.x, at.y) : null;
        const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); };
        return { open: !!b && getComputedStyle(b).display !== 'none', box: rect(b), meter: rect(m), meterHovered: !!m && m.matches(':hover'),
          boxHovered: !!b && b.matches(':hover'), under: under ? `${under.tagName} ${String(under.className || '').slice(0, 60)}` : null, at };
      }).catch((e) => String(e));
      check(!!await until(() => codex.evaluate(() => {
        const b = document.querySelector('[data-codex-extras="context"]');
        return !b || getComputedStyle(b).display === 'none';
      }), 5000, 200), 'and closes once the pointer leaves the meter', await hoverState());

      /* The jump from the list above left the conversation scrolled up from its end in a short page, as on Windows with
         Codex's setup notice over the message box. */
      await railToEnd(codex, true, 'before Codex Plus is toggled off and on');
      /* Toggled off and on with the pointer resting on the meter. The meter is taken out from under the pointer, so the
         page still counts the pointer as on it when the controls come back, and the map arrives after them. */
      await codex.locator('[data-codex-extras="meter"]').first().hover();
      await exec('codexPlus.toggle');
      await until(() => codex.evaluate(() => !document.querySelector('[data-codex-extras="meter"]')), 15000, 300);
      await exec('codexPlus.toggle');
      const barNow = () => codex.evaluate(() => {
        const pill = document.querySelector('[data-codex-extras="agents"]'), meter = document.querySelector('[data-codex-extras="meter"]');
        return { pill: pill ? pill.textContent.trim() : null, meter: meter ? meter.textContent.trim() : null };
      });
      const backOn = await until(async () => { const b = await barNow(); return b.meter !== null && /timer/.test(b.pill || '') && b; }, 10000, 300);
      check(!!backOn, 'toggled off and on with the pointer resting on the meter, the meter and the Agent map pill are both back within 10 s', backOn || await barNow());
      await endInView(codex, 'with Codex Plus toggled off and on');
      await shot('toggled-on-over-meter');
      await page.mouse.move(talk ? talk.x + 30 : 0, talk ? talk.y + 15 : 0, { steps: 6 });
    });

    /* Helpers for the two steps that check the plan bar. */
    const planBarTools = (() => {
      const since = new Date().toISOString().replace(/\.\d+Z$/, '+00:00');
      /* Asked days before the user's last message, so the question counts in the bar but gives the tab no red dot, which
         the steps after this one do not expect. */
      const asked = new Date(Date.now() - 3 * 86400e3).toISOString().replace(/\.\d+Z$/, '+00:00');
      const writeRows = (thread, nodes) => { fs.mkdirSync(PLANS, { recursive: true }); fs.writeFileSync(path.join(PLANS, `${thread}.json`), JSON.stringify({ nodes })); };
      /* Reads the bar in frame `f`: its bubbles as "state count", "to decide", whether "Plan" is drawn, and where it sits
         relative to the message box. */
      const barIn = (f) => (f ? f.evaluate(() => {
        const b = document.querySelector('[data-codex-extras="plan-bar"]');
        if (!b || b.style.display === 'none' || !b.getClientRects().length) return null;
        const t = (sel) => { const e = b.querySelector(sel); return e ? e.textContent.trim() : null; };
        const r = b.getBoundingClientRect(), x = (document.querySelector('[data-codex-composer-root]') || b).getBoundingClientRect();
        return { bubbles: [...b.querySelectorAll('.apb-b')].map((s) => s.getAttribute('data-state') + ' ' + s.textContent.trim()).join(), red: t('.apb-q'),
          name: !!b.querySelector('.apb-name'), compact: b.getAttribute('data-compact') === '1', page: innerWidth,
          at: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
          box: { left: Math.round(x.left), top: Math.round(x.top), width: Math.round(x.width) } };
      }).catch(() => null) : null);
      const barSays = (f, test, ms = 20000) => until(async () => { const b = await barIn(f); return b && test(b) && b; }, ms, 400);
      const noBar = (f, ms = 20000) => until(() => f.evaluate(() => !document.querySelector('[data-codex-extras="plan-bar"]')).catch(() => false), ms, 400);
      const placed = (b) => !!b && b.at.left === b.box.left && b.at.width === b.box.width && Math.abs(b.at.top + b.at.height + 6 - b.box.top) <= 1;
      /* The rows the side bar shows as it is, without bringing Agent Plus's container forward as planRows does: with the
         session list in front there are none, since that list is a page of its own. */
      const planViewRows = () => page.evaluate(() => {
        const bar = document.getElementById('workbench.parts.sidebar');
        return bar ? [...bar.querySelectorAll('.monaco-list-row')].filter((r) => r.offsetParent).map((r) => r.innerText.trim()) : [];
      }).catch(() => null);
      return { since, asked, writeRows, barIn, barSays, noBar, placed, planViewRows };
    })();

    /* Codex Plus draws a summary of the conversation's plan with Agent Plus's fragment just above the message box,
       at the same width as the box (codexPlus.planBar, src/plan-bars.js and the page script's placePlanBar); the bar
       updates as the plan changes, and clicks on it open Agent Plus's views. The compact bar in Codex's narrow
       sidebar is checked at the end of the sidebar's own step. */
    await step('the plan bar', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const id = threads[0].id;
      const { since, asked, writeRows, barIn, barSays, noBar, placed, planViewRows } = planBarTools;
      await clearToasts();
      await tabNamed(title).click();
      await until(async () => (await frontPage()) === codex, 10000, 300);
      const QUESTION = 'Should the retry delay stay at 30 seconds?';
      const ROWS = [
        { title: 'Find the retry delay', state: 'done', since, closed: since },
        { title: 'Change the retry delay', state: 'doing', since, children: [{ title: 'Read the sync job', state: 'doing', since }] },
        { title: 'Decide the default delay', state: 'waiting', waitingOn: 'user', question: QUESTION, asked, since: asked },
        { title: 'Update the docs', state: 'todo', since }];

      /* The row waiting for the user's answer counts in "to decide" only, not in a waiting bubble. */
      const ALL = 'doing 2,todo 1';
      writeRows(id, ROWS);
      const full = await barSays(codex, (b) => b.bubbles === ALL && b.red === '1 to decide');
      check(!!full && !full.compact && full.name,
        'a plan with rows doing, waiting on the user and to do draws the bar: Plan, a bubble of 2 doing and one of 1 to do, and the row waiting in "1 to decide"',
        full || await barIn(codex));
      check(placed(full), 'the bar sits just above the message box, 6 px clear of it, and is as wide as it', full);
      /* Where even the space between the top of the conversation and the bar is too short for the rail, it stays below
         Codex's header rather than cover its New chat button. */
      const railOverBar = await codex.evaluate(() => {
        const r = document.querySelector('.codex-extras-rail'), b = document.querySelector('[data-codex-extras="plan-bar"]');
        const sc = document.querySelector('[data-app-action-timeline-scroll]');
        if (!r || !b) return null;
        const x = r.getBoundingClientRect(), y = b.getBoundingClientRect();
        return { rail: [Math.round(x.top), Math.round(x.bottom)], bar: Math.round(y.top), scroller: sc ? Math.round(sc.getBoundingClientRect().top) : null, page: innerHeight };
      }).catch((e) => ({ error: String(e) }));
      check(!!railOverBar && !railOverBar.error && (railOverBar.rail[1] <= railOverBar.bar
        || (railOverBar.scroller !== null && Math.abs(railOverBar.rail[0] - (railOverBar.scroller + 4)) <= 1)),
      'the navigation rail ends above the bar, so the bar covers none of its buttons, or in a page with no room for that starts just below Codex\'s header', railOverBar);
      /* Every Codex element whose drawn part meets the bar, except the message box's ancestors, goes into the
         results as lying under the bar. Codex's conversation scroller ends at the top of the message box's room, where
         the bar sits, and the part of the conversation it clips is not drawn below that line. Only ancestors that
         contain the element's layout clip it. For a fixed element they start at its nearest ancestor with a transform
         or a filter, and for an absolute one at its nearest positioned ancestor. An element a pixel or less across is
         drawn for screen readers only, as Codex's own visually hidden headings are. An overlap under a pixel is not
         counted: it comes from a box at a fractional position beside the bar, which sits on whole pixels. */
      const under = await codex.evaluate(() => {
        const b = document.querySelector('[data-codex-extras="plan-bar"]'), box = document.querySelector('[data-codex-composer-root]');
        if (!b || !box) return null;
        const r = b.getBoundingClientRect(), out = [];
        const drawn = (e) => {
          const x = e.getBoundingClientRect();
          let left = x.left, top = x.top, right = x.right, bottom = x.bottom, how = getComputedStyle(e).position;
          for (let a = e.parentElement; a && left < right && top < bottom; a = a.parentElement) {
            const st = getComputedStyle(a), holdsFixed = st.transform !== 'none' || st.filter !== 'none';
            if ((how === 'fixed' && !holdsFixed) || (how === 'absolute' && st.position === 'static' && !holdsFixed)) continue;
            how = st.position;
            const ab = a.getBoundingClientRect(), inLeft = ab.left + a.clientLeft, inTop = ab.top + a.clientTop;
            if (st.overflowX !== 'visible') { left = Math.max(left, inLeft); right = Math.min(right, inLeft + a.clientWidth); }
            if (st.overflowY !== 'visible') { top = Math.max(top, inTop); bottom = Math.min(bottom, inTop + a.clientHeight); }
          }
          return { left, top, right, bottom };
        };
        const meets = (x) => Math.min(x.right, r.right) - Math.max(x.left, r.left) >= 1 && Math.min(x.bottom, r.bottom) - Math.max(x.top, r.top) >= 1;
        for (const e of document.body.querySelectorAll('*')) {
          if (e.closest('[data-codex-extras]') || e.closest('[data-agent-plus-plan-bar-list]') || e.contains(box)) continue;
          const x = e.getBoundingClientRect(), st = getComputedStyle(e);
          if (!(x.width > 1 && x.height > 1) || st.visibility === 'hidden' || st.display === 'none' || !meets(x)) continue;
          const d = drawn(e);
          if (!meets(d)) continue;
          out.push({ tag: e.tagName.toLowerCase(), attrs: [...e.attributes].map((a) => a.name).filter((n) => n !== 'class' && n !== 'style').slice(0, 6),
            box: [x.left, x.top, x.width, x.height].map(Math.round), drawn: [d.left, d.top, d.right - d.left, d.bottom - d.top].map(Math.round),
            position: st.position, z: st.zIndex, text: !![...e.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim()) });
        }
        const up = [];
        for (let n = box; n && n !== document.body && up.length < 12; n = n.parentElement) {
          const x = n.getBoundingClientRect(), st = getComputedStyle(n);
          up.push({ tag: n.tagName.toLowerCase(), attrs: [...n.attributes].map((a) => a.name).filter((a) => a !== 'class' && a !== 'style').slice(0, 6),
            box: [x.left, x.top, x.width, x.height].map(Math.round), display: st.display, position: st.position, margin: st.marginTop, kids: n.children.length });
        }
        return { bar: [r.left, r.top, r.width, r.height].map(Math.round), under: out.slice(0, 40), up };
      }).catch((e) => ({ error: String(e) }));
      fs.writeFileSync(path.join(out, 'plan-bar-layout.json'), JSON.stringify(under, null, 2));
      const drawnUnder = (under && under.under || []).filter((e) => e.text || /^(button|svg|img|input|textarea)$/.test(e.tag));
      check(!!under && !under.error && !drawnUnder.length, 'nothing of Codex\'s with text or a control in it lies under the bar', drawnUnder);
      await shot('plan-bar');

      writeRows(id, [...ROWS, { title: 'Write the release note', state: 'todo', since }]);
      const more = await barSays(codex, (b) => b.bubbles === 'doing 2,todo 2');
      check(!!more, 'a row added to the plan shows at once as one more in its state\'s bubble', more || await barIn(codex));
      writeRows(id, [ROWS[0], { title: 'Change the retry delay', state: 'done', since, closed: since, children: [{ title: 'Read the sync job', state: 'done', since, closed: since }] },
        ROWS[2], ROWS[3], { title: 'Write the release note', state: 'todo', since }]);
      const fewer = await barSays(codex, (b) => b.bubbles === 'todo 2' && b.red === '1 to decide');
      check(!!fewer, 'rows closed leave fewer open, and with none doing the bar has no doing bubble', fewer || await barIn(codex));
      writeRows(id, ROWS);
      await barSays(codex, (b) => b.bubbles === ALL);

      /* A click on the bar shows the plan in Agent Plus's Work plan view; one on "to decide" opens the question. */
      await showList();
      await codex.locator('[data-codex-extras="plan-bar"] .apb-name').first().click({ timeout: 10000 });
      const shown = await until(async () => { const r = await planViewRows(); return r && r.some((x) => x.includes('Read the sync job')) && r; }, 15000, 500);
      check(!!shown, 'a click on the bar brings Agent Plus\'s Work plan view forward with the conversation\'s plan', shown || await planViewRows());
      await shot('plan-bar-opened-plan');
      await codex.locator('[data-codex-extras="plan-bar"] .apb-q').first().click({ timeout: 10000 });
      const answer = await frameWhere((q) => { const e = document.getElementById('question'); return !!e && e.textContent.includes(q); }, 20000, QUESTION);
      const said = answer && await answer.evaluate(() => ({ row: (document.getElementById('row') || {}).textContent || '', question: document.getElementById('question').textContent }));
      check(!!said && /Decide the default delay/.test(said.row), 'a click on its "to decide" opens the Answer view at the question, with its row', said);
      await shot('plan-bar-opened-answer');
      await exec('workbench.action.closePanel');
      await showList();

      /* No plan, no bar; the setting turns it off and on. */
      await railToEnd(codex, true, 'before the plan bar goes and comes back');
      fs.rmSync(path.join(PLANS, `${id}.json`), { force: true });
      check(!!await noBar(codex), 'a conversation whose plan is gone has no bar, and the message box no room for one', await barIn(codex));
      await endInView(codex, 'with the plan bar gone');
      writeRows(id, ROWS);
      check(!!await barSays(codex, (b) => b.bubbles === ALL), 'a plan written again brings the bar back', await barIn(codex));
      await endInView(codex, 'with the plan bar back');
      await setting('planBar', false);
      check(!!await noBar(codex, 10000), 'codexPlus.planBar turned off takes the bar away', await barIn(codex));
      await setting('planBar', undefined);
      const back = await barSays(codex, (b) => b.bubbles === ALL, 10000);
      check(placed(back), 'and turned on again it is back, in its place', back || await barIn(codex));
      await endInView(codex, 'with codexPlus.planBar turned off and on');
      await shot('plan-bar-back');
      planFor(id, planTitle(id));
      await exec('agentPlus.refreshWorkPlan');
      if (!await until(async () => { const d = await dotsOn(title); return d && d.waiting === 0 && d.working === 0; }, 20000, 500)) {
        note(`the plan bar: the tab still had a dot when the step ended: ${JSON.stringify(await dotsOn(title))}`);
      }
    });

    await step('the dot on a tab', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const id = threads[0].id;
      const before = await dotsOn(title);
      check(!!before && before.working === 0 && before.waiting === 0 && envelopes(await labelOf(title)) === 0,
        'a stopped conversation\'s tab has no dot, and its title no envelope', { dots: before, label: await labelOf(title) });
      const idle = await panelSays(title, 'stopped', false);
      check(idle.ok, 'and its row in Agent Plus\'s Conversations panel has a blank where a dot would be, and no envelope', idle.row);
      model.hold();
      const turns = model.turns();
      await intoComposer(codex);
      await codex.locator(COMPOSER).first().pressSequentially('Run the tests again.');
      await codex.locator(COMPOSER).first().press('Enter');
      check(!!await until(() => model.turns() > turns, 20000, 300), 'a message sent from the tab reaches the made-up model', model.seen.slice(-3));
      const working = await until(async () => { const d = await dotsOn(title); return d && d.working >= 6 && !d.ring && d; }, 20000, 500);
      check(!!working, 'while the turn runs the tab\'s logo carries the green dot', await dotsOn(title));
      const green = await slRowSays(id, (r) => r.dot === 'green');
      check(!!green, 'and its row in Agent Plus\'s session list the green dot of a turn running', green || await slRow(id));
      const busy = await panelSays(title, 'working', false);
      check(busy.ok, 'and its row in Agent Plus\'s Conversations panel a solid green circle', busy.row);
      const meterNow = () => codex.evaluate(() => { const m = document.querySelector('[data-codex-extras="meter"]'); return m ? m.textContent.trim() : null; });
      await sleep(2000);
      check(/%/.test(await meterNow() || ''), 'and the context meter stays, with the last turn\'s figure, before this turn\'s first model call has answered', await meterNow());
      await shot('tab-dot-working');
      await openNotes();
      await sleep(800);
      const counted = await agentCount();
      const mark = await toastMark();
      model.release();
      const unread = await until(async () => {
        const d = await dotsOn(title), label = await labelOf(title);
        return d && d.working === 0 && d.waiting === 0 && label === `${title} ${ENVELOPE}` && { d, label };
      }, 30000, 500);
      check(!!unread, 'once the reply lands with the tab not in front, the dot goes and the tab\'s title ends in the envelope',
        { dots: await dotsOn(title), label: await labelOf(title) });
      await sleep(3000);
      check((await agentCount()) <= counted, 'and Agent Plus\'s status bar count does not include it',
        { before: counted, now: await agentCount() });
      if (apWaits) {
        await sleep(8000);
        const shown = await toastsAbout(title, mark);
        check(!shown.length, 'and, its tab being in this window, Agent Plus shows no notification of it: the envelope and the count tell of it here', shown);
      } else if (await focused()) {
        const notified = await toastSaid(title, 'finished', mark);
        const open = notified ? await page.locator('.notification-toast').filter({ hasText: `"${title}"` }).locator('.monaco-button, a').filter({ hasText: /^Open$/ }).count() : 0;
        check(!!notified && open > 0, 'and, the window having the focus, says in a notification that it finished, with Open to go to it', { notified, open });
      } else {
        await sleep(8000);
        const shown = await toastsAbout(title, mark);
        check(!shown.length, `the window does not have the system's focus on ${process.platform}, and Agent Plus shows no notification while no window has it`, shown);
      }
      const seenNot = await panelSays(title, 'stopped', true);
      check(seenNot.ok, 'and its row in Agent Plus\'s Conversations panel has no dot, and the envelope as its badge', seenNot.row);
      await shot('tab-dot-unread');
      const logo = await logoCrop(title);
      if (logo) base.compare('tab-dot-unread', logo);

      const unreadRow = await slRowSays(id, (r) => r.unread);
      check(!!unreadRow && envelopes(unreadRow.title) === 0, 'and its row in Agent Plus\'s session list carries the unread mark, its title no envelope',
        unreadRow || await slRow(id));

      /* In a light theme the envelope is drawn in its text form (src/envelope.js): on the tab, and as the badge of Agent
         Plus's row. */
      const theme = (name) => call('await vscode.workspace.getConfiguration(\'workbench\').update(\'colorTheme\', arg, vscode.ConfigurationTarget.Global); return true;', name);
      for (const name of ['Default Light Modern', 'Default High Contrast Light']) {
        await theme(name);
        const codes = async () => [...String(await labelOf(title) || '')].slice(-2).map((c) => c.codePointAt(0).toString(16));
        const tabLabel = await until(async () => (await labelOf(title)) === `${title} ${TEXT_ENVELOPE}`, 15000, 500);
        check(!!tabLabel, `in ${name} the tab's title ends in the envelope's text form, U+2709 U+FE0E`, { label: await labelOf(title), last: await codes() });
        const p = await panelSays(title, 'stopped', true);
        check(p.ok && p.row.badge === TEXT_ENVELOPE, 'and its row in Agent Plus\'s panel has it as its badge', p.row);
        await shot(`unread-${name.toLowerCase().replace(/\W+/g, '-')}`);
      }
      await theme('Default Dark Modern');
      check(!!await until(async () => (await labelOf(title)) === `${title} ${ENVELOPE}`, 15000, 500), 'back in Default Dark Modern the tab\'s envelope is the colour form again',
        await labelOf(title));

      /* Renamed while the reply is unread, keeping the tab's envelope at the end of the typed name. */
      const renameTo = async (name) => {
        await call('vscode.commands.executeCommand(\'codexPlus.renameThread\', arg); return true;', id);
        const box = page.locator('.quick-input-widget input').first();
        await box.waitFor({ state: 'visible', timeout: 10000 });
        const offered = await box.inputValue();
        await box.fill(name);
        await box.press('Enter');
        return offered;
      };
      const stored = () => call(`${OWN}
        const t = (own('codex-files').listThreads() || []).find((x) => x.id === arg); return t ? t.title : null;`, id).catch((e) => String(e));
      const renamed = `${title} (renamed)`;
      const offered = await renameTo(`${renamed} ${ENVELOPE}`);
      check(offered === title, 'Rename on a conversation with a reply not seen starts from its title, without the envelope', offered);
      const shown = await until(async () => { const l = await labelOf(renamed); return l && l; }, 20000, 500);
      check(shown === `${renamed} ${ENVELOPE}` && envelopes(shown) === 1, 'renamed with the envelope left in, the tab\'s title ends in one envelope', shown);
      const saved = await until(async () => { const t = await stored(); return t === renamed && t; }, 15000, 500);
      check(!!saved, 'and the name saved in Codex has none', await stored());
      const inList = await slRowSays(id, (r) => r.title === renamed);
      check(!!inList && inList.unread, 'and its row in Agent Plus\'s session list takes that name, with no envelope in it, keeping the unread mark', inList || await slRow(id));
      await shot('renamed-with-envelope');
      /* Wherever the envelope is typed into the new name, and in either form, the saved name has no envelope and the tab's title has one, at the end. */
      for (const [how, typed, want] of [['in the middle', `${title} ${ENVELOPE} (middle)`, `${title} (middle)`],
        ['at the start', `${ENVELOPE} ${title} (start)`, `${title} (start)`], ['twice', `${title} (twice) ${ENVELOPE}${ENVELOPE}`, `${title} (twice)`],
        ['in its text form', `${title} (text form) ${TEXT_ENVELOPE}`, `${title} (text form)`], ['taken out', `${title} (none typed)`, `${title} (none typed)`]]) {
        const from = await renameTo(typed);
        const tabNow = await until(async () => (await labelOf(want)) === `${want} ${ENVELOPE}`, 20000, 500);
        const savedNow = await until(async () => (await stored()) === want, 15000, 500);
        const rowThen = await slRowSays(id, (r) => r.title === want && r.unread);
        check(!!tabNow && !!savedNow && !!rowThen && envelopes(from) === 0,
          `renamed with the envelope typed ${how}: the name saved has none, the tab's title ends in one, and the list row takes the name and keeps its unread mark`,
          { typed, offered: from, tab: await labelOf(want), stored: await stored(), row: await slRow(id) });
      }
      /* The pencil on Agent Plus's row edits the title in place, and the list hands the name typed there to this
         extension's rename. */
      const pencil = `${title} (pencil, unread)`;
      if (await showList()) {
        const was = await stored();
        await slRowOf(threads[0]).hover();
        await slRowOf(threads[0]).locator('.sl-act[data-act="rename"]').first().click();
        const editing = await until(() => sl.evaluate((key) => { const r = [...document.querySelectorAll('.sl-row')].find((x) => x.dataset.key === key);
          const t = r && r.querySelector('.sl-title.sl-editing'); return t && t.textContent; }, slKey(id)), 5000, 200);
        check(editing === was && envelopes(editing) === 0, 'the pencil on its row in Agent Plus\'s list, while the reply is unread, edits the title without the envelope', { editing, stored: was });
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await page.keyboard.type(`${pencil} ${ENVELOPE}`);
        await page.keyboard.press('Enter');
        const done = await until(async () => (await stored()) === pencil && (await labelOf(pencil)) === `${pencil} ${ENVELOPE}`, 20000, 500);
        check(!!done, 'and the name typed there with an envelope is saved without it, the tab keeping one after its title', { stored: await stored(), tab: await labelOf(pencil) });
      }
      /* The tab's own menu, right-clicked in the background so the reply stays unread. */
      const fromTab = `${title} (tab menu, unread)`;
      const named = (await labelOf(pencil)) ? pencil : await stored();
      let picked = '';
      try { picked = await contextPick(named, 'Codex Plus: Rename', { select: false }); } catch (e) { check(false, 'a right-click on the tab in the background offers Rename', String(e.message || e).split('\n')[0]); }
      if (picked) {
        const box = page.locator('.quick-input-widget input').first();
        await box.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        const from = await box.inputValue().catch(() => '');
        await box.fill(`${fromTab} ${ENVELOPE}`).catch(() => {});
        await box.press('Enter').catch(() => {});
        const done = await until(async () => (await stored()) === fromTab && (await labelOf(fromTab)) === `${fromTab} ${ENVELOPE}`, 20000, 500);
        check(from === named && !!done, 'Rename in the menu of the tab in the background starts from the title without the envelope, saves the name without the one typed, and leaves the reply unread',
          { offered: from, stored: await stored(), tab: await labelOf(fromTab) });
      }

      await renameTo(title);
      check(!!await until(async () => (await labelOf(title)) === `${title} ${ENVELOPE}`, 20000, 500), 'renamed back, the tab keeps one envelope after its title',
        await labelOf(title));

      const unreadCount = await agentCount();
      await page.locator('.tabs-container .tab').filter({ hasText: title }).first().click();
      await page.bringToFront().catch(() => {});
      const read = await until(async () => {
        const d = await dotsOn(title), label = await labelOf(title);
        return d && d.working === 0 && d.waiting === 0 && label === title && d;
      }, 20000, 500);
      const inFront = await focused();
      if (read || inFront) {
        check(!!read, 'and bringing the tab to the front takes the envelope away', { dots: await dotsOn(title), label: await labelOf(title), windowFocused: inFront });
        check((await agentCount()) <= unreadCount, 'and Agent Plus\'s count, which never had it, does not go up', { before: unreadCount, now: await agentCount() });
        const gone = await panelSays(title, 'stopped', false);
        check(gone.ok, 'and its row in Agent Plus\'s panel loses the envelope', gone.row);
      } else note(`the window does not have the system's focus on ${process.platform}, so the reply stays unread, as it should; clearing the dot was not checked`);
      await shot('tab-dot-read');
    });

    await step('a conversation watched while its turn finishes', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const inFocus = await focused();
      await exec('notifications.clearAll');
      const counted = await agentCount();
      const mark = await toastMark();
      model.hold();
      const turns = model.turns();
      await codex.locator('[data-codex-composer-root] [contenteditable="true"]').first().click();
      await page.keyboard.type('Check the build once more.');
      await page.keyboard.press('Enter');
      const working = await until(async () => model.turns() > turns && ((await dotsOn(title)) || {}).working >= 6, 20000, 300);
      check(!!working, 'with its tab in front, a message sent from it starts a turn', await dotsOn(title));
      model.release();
      const ended = await until(async () => { const d = await dotsOn(title); return d && d.working === 0 && d; }, 30000, 500);
      await sleep(8000);
      const after = { ended: !!ended, dots: await dotsOn(title), label: await labelOf(title), counted: await agentCount(), notifications: await toastsAbout(title, mark) };
      if (inFocus) {
        check(after.ended && !!after.dots && after.dots.waiting === 0 && after.label === title && after.counted <= counted && !after.notifications.length,
          'when the reply lands with the tab in front of the focused window, the tab gets no envelope and Agent Plus neither announces nor counts it',
          { before: counted, ...after });
      } else {
        /* Requirement 6 spares the conversation in front of the focused window; while no window has the focus, it spares none. */
        check(after.ended && after.label === `${title} ${ENVELOPE}` && after.counted > counted && !after.notifications.length,
          `without the system's focus on ${process.platform}, the reply landing in the tab in front is not taken as seen: the tab gets the envelope and Agent Plus counts it, `
          + 'but shows no notification while no window has the focus', { before: counted, ...after });
        await exec('notifications.clearAll');
      }
      await shot('tab-in-front-finished');
    });

    /* A question the work plan puts to the user makes the conversation wait for them on every platform, with no command
       to approve (src/codex-source.js conversationOf); a question put before the user's last message does not. */
    const PLANS_DIR = path.join(profile.codexHome, 'plugins', 'data', 'agent-work-plan-codex-extras');
    const askInPlan = (id, at) => {
      fs.mkdirSync(PLANS_DIR, { recursive: true });
      const when = new Date(at).toISOString();
      fs.writeFileSync(path.join(PLANS_DIR, `${id}.json`), JSON.stringify({ nodes: [{ title: 'Choose the cache size', state: 'waiting', waitingOn: 'user',
        question: 'Should the cache hold 64 or 128 MB?', asked: when, since: when }] }));
    };
    const OLD_QUESTION_MS = 3 * 86400e3;
    /* Sends `text` from the tab of threads[0] and lets its reply land with notes.txt in front. Resolves once the tab's
       title carries the envelope. */
    const finishBehind = async (text) => {
      await tabNamed(title).click();
      await until(async () => (await frontPage()) === codex, 10000, 300);
      model.hold();
      const turns = model.turns();
      await intoComposer(codex);
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
      if (!await until(() => model.turns() > turns, 20000, 300)) throw new Error(`"${text}" reached no model`);
      await openNotes();
      await sleep(800);
      model.release();
      return !!await until(async () => (await labelOf(title)) === `${title} ${ENVELOPE}`, 30000, 500);
    };
    const readBack = async () => { await tabNamed(title).click(); return !!await until(async () => (await labelOf(title)) === title, 20000, 500); };

    /* Requirement 8: "finished" and "waiting" can each be turned off without changing the count (requirement 11);
       agentPlus.notifications.enabled turns off both and the count. */
    await step('the notification settings', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const id = threads[0].id;
      const inFocus = await focused();
      if (!inFocus) note(`the window does not have the system's focus on ${process.platform}, where Agent Plus shows no notification anyway, so "not shown" says less here`);
      await exec('notifications.clearAll');

      await agentSetting('notifications.finished', false);
      let counted = await agentCount(), mark = await toastMark();
      const landed = await finishBehind('Count the failing tests.');
      await sleep(8000);
      let said = { landed, notifications: await toastsAbout(title, mark), count: [counted, await agentCount()] };
      check(landed && !said.notifications.length && said.count[1] <= counted,
        'with agentPlus.notifications.finished off, a reply landing in the background is neither announced nor counted', said);
      if (inFocus) check(await readBack(), 'brought to the front, it is read');
      await agentSetting('notifications.finished', undefined);

      await agentSetting('notifications.waiting', false);
      await openNotes();
      counted = await agentCount();
      mark = await toastMark();
      askInPlan(id, Date.now());
      await exec('agentPlus.refreshWorkPlan');
      const red = await until(async () => ((await dotsOn(title)) || {}).waiting >= 6, 20000, 500);
      await sleep(8000);
      said = { red: !!red, notifications: await toastsAbout(title, mark), count: [counted, await agentCount()] };
      check(said.red && !said.notifications.length && said.count[1] >= Math.max(1, counted),
        'with agentPlus.notifications.waiting off, a question the work plan puts to the user turns the tab\'s dot red, is not announced, and is still counted', said);
      askInPlan(id, Date.now() - OLD_QUESTION_MS);
      await exec('agentPlus.refreshWorkPlan');
      check(!!await until(async () => ((await dotsOn(title)) || {}).waiting === 0, 20000, 500), 'and with the question dated before the user\'s last message, the red dot goes',
        await dotsOn(title));
      await agentSetting('notifications.waiting', undefined);

      await agentSetting('notifications.enabled', false);
      mark = await toastMark();
      const off = await finishBehind('Count the skipped tests.');
      askInPlan(id, Date.now());
      await exec('agentPlus.refreshWorkPlan');
      const redOff = await until(async () => ((await dotsOn(title)) || {}).waiting >= 6, 20000, 500);
      await sleep(8000);
      said = { landed: off, red: !!redOff, notifications: await toastsAbout(title, mark), count: await agentCount() };
      check(off && said.red && !said.notifications.length && said.count === 0,
        'with agentPlus.notifications.enabled off, neither a reply landing in the background nor a question in the plan is announced, Agent Plus counts nothing, '
        + 'and the tab still draws its envelope and red dot', said);
      await shot('notifications-off');
      await agentSetting('notifications.enabled', undefined);
      const t0 = Date.now();
      const again = await until(async () => (await agentCount()) > 0, 45000, 500);
      const took = Math.round((Date.now() - t0) / 1000);
      check(!!again && took <= 10, `turned back on, Agent Plus counts the conversation again at once (here after ${took} s)`, await agentCount());
      askInPlan(id, Date.now() - OLD_QUESTION_MS);
      await exec('agentPlus.refreshWorkPlan');
      await until(async () => ((await dotsOn(title)) || {}).waiting === 0, 20000, 500);
      if (inFocus) await readBack();
      await exec('notifications.clearAll');
    });

    /* Requirement 11: an envelope turning up on a conversation that had stopped is not announced. Requirement 12: when one
       turn follows another at once, as with a queued message, the moment between them is not announced. */
    await step('what Agent Plus does not announce', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const id = threads[0].id;
      const inFocus = await focused();
      await openNotes();
      if (!await showList()) throw new Error('the session list did not open');
      if (inFocus) await readInList(threads[0]);
      let counted = await agentCount(), mark = await toastMark(), said = null;
      /* Without the focus the conversation's reply is unread already, and its menu offers Mark as Read instead. */
      if (inFocus) {
      retried(await pick(threads[0], ['Mark as Unread']), 'Mark as Unread');
      const marked = await until(async () => (await labelOf(title)) === `${title} ${ENVELOPE}`, 15000, 500);
      await sleep(6000);
      said = { marked: !!marked, notifications: await toastsAbout(title, mark), count: [counted, await agentCount()] };
      check(said.marked && !said.notifications.length && said.count[1] === counted,
        'Mark as Unread in the row menu of Agent Plus\'s session list, which the list hands to this extension, puts the envelope on the stopped conversation\'s tab, '
        + 'without a notification or a change to Agent Plus\'s count', said);
      retried(await pick(threads[0], ['Mark as Read']), 'Mark as Read');
      check(!!await until(async () => (await labelOf(title)) === title && (await agentCount()) === counted, 15000, 500),
        'and Mark as Read takes the envelope away without changing the count', { label: await labelOf(title), count: [counted, await agentCount()] });
      } else note(`the window does not have the system's focus on ${process.platform}, so the reply is unread already and Mark as Unread was not tried`);

      await tabNamed(title).click();
      await until(async () => (await frontPage()) === codex, 10000, 300);
      model.hold();
      const turns = model.turns();
      await intoComposer(codex);
      await page.keyboard.type('Draft the summary of the failures.');
      await page.keyboard.press('Enter');
      if (!await until(() => model.turns() > turns, 20000, 300)) throw new Error('the message reached no model');
      /* Codex sends a queued message as soon as the running turn ends (src/wakeup.js uses the same queue). */
      const queued = await call(`${OWN} return own('patching').hostRequest('thread/queue/add', arg);`, { threadId: id, clientUserMessageId: `cxp-test-${Date.now()}`,
        input: [{ type: 'text', text: 'And then the release notes.', text_elements: [] }] }).catch((e) => ({ outcome: 'failed', reason: String(e) }));
      check(!!queued && (queued.outcome === 'done' || queued.outcome === 'sent'), 'Codex takes a second message into its queue while the turn runs', queued);
      await openNotes();
      await sleep(800);
      mark = await toastMark();
      const before = model.turns();
      model.release();
      model.hold();
      const next = await until(() => model.turns() > before, 20000, 300);
      check(!!next, 'once the first turn has ended, Codex starts the next one with the queued message', { turns: [before, model.turns()] });
      await sleep(8000);
      said = { notifications: await toastsAbout(title, mark), dots: await dotsOn(title) };
      check(!said.notifications.length && !!said.dots && said.dots.working >= 6, 'and the moment between the two turns is not announced as finished', said);
      model.release();
      if (apWaits) {
        const done = await until(async () => { const d = await dotsOn(title); return d && d.working === 0 && d; }, 30000, 500);
        const stopped = await panelSays(title, 'stopped', null, 30000);
        await sleep(8000);
        check(!!done && stopped.ok && !(await toastsAbout(title, mark)).length, 'once the queued turn has ended too, it is not announced either, its tab being in this window',
          { dots: await dotsOn(title), row: stopped.row, notifications: await toastsAbout(title, mark) });
        note('this Agent Plus announces no conversation the focused window shows, so that the reply after a queued turn is announced once '
          + 'was not checked here: that takes a conversation no window shows');
      } else if (inFocus) {
        const fin = await toastSaid(title, 'finished', mark, 30000);
        await sleep(2000);
        check(!!fin && (await toastsAbout(title, mark)).length === 1, 'once the queued turn has ended too and stays so, it is announced, once', await toastsAbout(title, mark));
      } else note(`the window does not have the system's focus on ${process.platform}, so the notice after the queued turn was not looked for`);
      if (inFocus) await readBack();
      await exec('notifications.clearAll');
    });

    /* Each setting of what the patch adds to the conversation's page is turned off and back to its default, checking what
       goes and what comes back (viewOf in src/patching.js, which src/page/codex-extras-page.js draws from). The turns sent
       above give the replies a duration and figures to show. */
    await step('settings that Codex\'s page follows', async () => {
      if (!codex) throw new Error('the conversation did not open');
      await tabNamed(title).click();
      await until(async () => (await frontPage()) === codex, 10000, 300);
      await clearToasts();
      const read = () => codex.evaluate(() => {
        const bar = [...document.querySelectorAll('[data-codex-extras="bar-button"]')];
        const mute = bar.find((b) => b.hasAttribute('data-codex-extras-muted'));
        const replies = [...document.querySelectorAll('.codex-extras-stamp-assistant')];
        /* A reply's duration and figures are an attribute its stylesheet draws after the time. */
        const fig = (e) => e.getAttribute('data-codex-extras-figures') || '';
        return { userStamps: document.querySelectorAll('.codex-extras-stamp-user').length, replyStamps: replies.length,
          timed: replies.filter((e) => e.hasAttribute('data-codex-extras-timed')).length,
          figures: replies.filter((e) => /ctx\s\d+%/.test(fig(e))).length, durations: replies.filter((e) => /^\s*\d+[hms]/.test(fig(e))).length,
          rail: !!document.querySelector('.codex-extras-rail'), edges: document.querySelectorAll('.codex-extras-user-edge').length,
          info: bar.some((b) => /^About this conversation/.test(b.getAttribute('aria-label') || '')), mute: !!mute,
          muted: mute ? mute.getAttribute('data-codex-extras-muted') : '', meter: !!document.querySelector('[data-codex-extras="meter"]'),
          codexMeterHidden: document.querySelectorAll('.codex-extras-ctx-hidden').length };
      }).catch((e) => ({ error: String(e) }));
      /* Codex draws a conversation's turns as they come into view and keeps them. In a short window, such as on
         Windows with the plan bar above the message box, it draws only some turns at first. The test scrolls to the
         top and back to the end first. */
      const scrollTo = (top) => codex.evaluate((up) => {
        const s = document.querySelector('[data-app-action-timeline-scroll]');
        if (s) s.scrollTop = up ? 0 : s.scrollHeight;
      }, top).catch(() => {});
      await scrollTo(true);
      await sleep(1500);
      await scrollTo(false);
      await sleep(1500);
      let last = '';
      const on = await until(async () => {
        const x = await read(), seen = JSON.stringify(x), again = seen === last;
        last = seen;
        return x.replyStamps > 0 && x.meter && again && x;
      }, 20000, 700) || await read();
      check(on.userStamps > 0 && on.timed > 0 && on.figures > 0 && on.durations > 0 && on.rail && on.edges > 0 && on.info && on.mute && on.muted === 'false'
        && on.meter, 'with the defaults the page has the times, each reply\'s figures and how long its turn took, the rail, the bar down '
        + 'the user\'s messages, both buttons, and the meter', on);
      const same = (x) => ['userStamps', 'replyStamps', 'timed', 'figures', 'durations', 'rail', 'edges', 'info', 'mute', 'muted', 'meter', 'codexMeterHidden']
        .every((k) => x[k] === on[k]);
      /* Turns `key` off and checks with `gone` that `what` has left the page, then that the page is as it was once `key` is
         back at its default. */
      const pageSetting = async (key, what, gone) => {
        await setting(key, false);
        const off = await until(async () => { const x = await read(); return gone(x) && x; }, 15000, 500);
        check(!!off, `with codexPlus.${key} off, ${what}`, off || await read());
        await shot(`page-setting-${key}`);
        await setting(key, undefined);
        const back = await until(async () => { const x = await read(); return same(x) && x; }, 15000, 500);
        check(!!back, `and with codexPlus.${key} back at its default, the page is as it was`, { was: on, now: back || await read() });
      };
      await pageSetting('timestamps', 'the times above the messages and replies go, the replies\' figures staying', (x) => x.userStamps === 0 && x.timed === 0 && x.figures > 0);
      await pageSetting('turnFigures', 'the context share, model and effort beside each reply\'s time go', (x) => x.replyStamps > 0 && x.figures === 0);
      await pageSetting('replyDuration', 'how long each turn took goes from beside its reply\'s time', (x) => x.replyStamps > 0 && x.durations === 0 && x.figures > 0);
      await pageSetting('conversationNavigation', 'the rail at the right edge goes', (x) => !x.rail && x.replyStamps > 0);
      await pageSetting('userMessageEdge', 'the bar down the user\'s messages goes', (x) => x.edges === 0 && x.userStamps > 0);
      await pageSetting('infoButton', 'the information button goes, the chime button staying', (x) => !x.info && x.mute);
      await pageSetting('chimeButton', 'the chime button goes, the information button staying', (x) => !x.mute && x.info);
      await pageSetting('chime', 'the chime button is drawn muted', (x) => x.mute && x.muted === 'true');
      /* Whether Codex's own meter comes back depends on Codex drawing one where the patch looks (codexMeter in the page). */
      await pageSetting('contextMeter', 'the meter goes', (x) => !x.meter && x.info);
    });

    /* What reaches the plugin's hooks: the settings file under CODEX_HOME that they read on every message (writeHookSettings
       in extension.js), and the skills entries Codex keeps in config.toml (src/skills-config.js). Settings that only the
       Custom token mode reads are set with the mode at Custom. */
    await step('settings the hooks are given', async () => {
      const file = path.join(profile.codexHome, 'plugins', 'data', 'agent-work-plan-codex-extras', 'config.json');
      const hooks = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
      const toml = () => { try { return fs.readFileSync(path.join(profile.codexHome, 'config.toml'), 'utf8'); } catch (_) { return ''; } };
      await agentSetting('tokenMode', 'custom');
      const set = [];
      /* Sets `key` to `value` and checks with `given` that the hooks' settings file has the new value right away. */
      const hookSetting = async (key, value, given) => {
        set.push(key);
        await setting(key, value);
        const h = await until(() => { const x = hooks(); return x && given(x) && x; }, 15000, 300);
        check(!!h, `codexPlus.${key} set to ${JSON.stringify(value)} reaches the hooks' settings at once`, hooks());
      };
      await hookSetting('workPlan', false, (h) => h.enabled === false);
      await hookSetting('conversationBrief', false, (h) => h.brief === false);
      await hookSetting('tellCodexYourTimeZone', false, (h) => h.tellTimeZone === false);
      await hookSetting('workPlanOfferMinTurns', 1, (h) => h.offerMinTurns === 1);
      await hookSetting('workPlanOfferMinToolCalls', 4, (h) => h.offerMinToolCalls === 4);
      await hookSetting('workPlanQuietWhenReplyMatches', '^GPT says:', (h) => h.quietWhenReplyMatches === '^GPT says:');
      planFor(threads[0].id, planTitle(threads[0].id));
      await exec('agentPlus.refreshWorkPlan');
      const planNow = await until(async () => { const r = await planRows(); return !r.some((x) => x.includes('Work plan of ')) && r; }, 15000, 500);
      check(!!planNow, 'with codexPlus.workPlan off, Agent Plus\'s Work plan view shows no Codex conversation\'s plan', await planRows());
      for (const key of set) await setting(key, undefined);
      check(!!await until(() => { const h = hooks(); return h && h.enabled === true && h.brief === true && h.tellTimeZone === true && h.offerMinTurns === 3 && h; }, 15000, 300),
        'back at their defaults, the hooks are given those again', hooks());
      await agentSetting('tokenMode', undefined);
      await checkPlan(planTitle(threads[0].id), 'with codexPlus.workPlan back on');

      await setting('skillsListBudget', 4000);
      await setting('disabledSkills', ['inventory-sync-retry']);
      const written = await until(() => { const t = toml(); return /max_context_tokens\s*=\s*4000/.test(t) && /inventory-sync-retry/.test(t) && /enabled\s*=\s*false/.test(t) && t; }, 20000, 500);
      check(!!written, 'codexPlus.skillsListBudget and codexPlus.disabledSkills are written into Codex\'s config.toml', toml().slice(-600));
      await setting('skillsListBudget', undefined);
      await setting('disabledSkills', undefined);
      check(!!await until(() => { const t = toml(); return !/max_context_tokens/.test(t) && !/inventory-sync-retry/.test(t); }, 20000, 500),
        'and taken out of it again once back at their defaults', toml().slice(-600));
    });

    await step('work left running after a turn', async () => {
      if (!codex || !await showList()) throw new Error('the conversation or the session list did not open');
      const id = threads[0].id;
      /* Reads the dot on the tab and the dot on the list row, with the row's hover lines about work still running
         (sessionOf in src/session-list-source.js). */
      const now = async () => {
        const d = await dotsOn(title), r = await slRow(id);
        return { tab: !!d && d.working >= 6 && d.ring, row: !!r && r.dot === 'greenRing', green: d ? d.working : -1,
          running: leftLines(r), dots: d, rowDot: r && r.dot };
      };
      const send = async (text) => {
        await clearToasts();
        await codex.locator('[data-codex-composer-root] [contenteditable="true"]').first().click();
        await page.keyboard.type(text);
        await page.keyboard.press('Enter');
      };
      const card = () => codex.evaluate(() => {
        const s = document.querySelector('[data-codex-approval-surface]');
        return s ? { text: s.innerText.slice(0, 300), buttons: [...s.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean) } : null;
      }).catch(() => null);
      const approve = async (name) => {
        await clearToasts();
        await planBarClear(codex, '[data-codex-approval-surface]', `${name}: Codex's approval card`);
        const buttons = codex.locator('[data-codex-approval-surface] button');
        const yes = buttons.filter({ hasText: /^(Yes|Allow once|Allow this time|Approve|Run)\b/ }).first();
        if (await yes.count()) await yes.click();
        const submit = buttons.filter({ hasText: /^Submit$/ }).first();
        if (await submit.count()) await submit.click();
        check(!!await until(async () => !await card(), 10000, 300), `${name}: and approving it there lets the command run`, await card());
      };
      /* The command items this window's app-server reports, kept for why() below. */
      await call(`${OWN}
        const p = own('patching');
        globalThis.__cxpTestCommandNotes = [];
        p.onAppServerNotification((m, q) => { const it = (q && q.item) || {};
          if (/^item\\//.test(m) && it.type === 'commandExecution') globalThis.__cxpTestCommandNotes.push([m, it.id, it.source, it.status].join(' ')); });
        return true;`).catch(() => false);
      /* What this window's host and the rollout say of the conversation's commands, for a green that does not leave. */
      const why = async () => {
        const here = await call(`${OWN}
          const req = own;
          const files = req('codex-files'), rollout = files.rolloutOf(arg);
          const st = rollout ? files.rolloutState(rollout) : null;
          const bt = await req('patching').hostRequest('thread/backgroundTerminals/list', { threadId: arg });
          return { commands: req('patching').runningCommands(arg).map((c) => c.command.slice(0, 60)), open: st && st.openCommandIds,
            working: st && st.working, notes: (globalThis.__cxpTestCommandNotes || []).slice(-8), terminals: JSON.stringify(bt).slice(0, 300) };`, id)
          .catch((e) => String(e));
        let tail = [];
        try {
          const sessions = path.join(profile.codexHome, 'sessions');
          const file = fs.readdirSync(sessions, { recursive: true }).map((r) => path.join(sessions, r)).find((f) => f.endsWith(`${id}.jsonl`));
          tail = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-8).map((l) => {
            const r = JSON.parse(l), q = r.payload || {};
            return [r.type, q.type, q.item ? `${q.item.type} ${q.item.id} ${q.item.status || ''}` : q.call_id || ''].filter(Boolean).join(' ');
          });
        } catch (e) { tail = [String(e)]; }
        return { here, tail };
      };
      const pillText = () => codex.evaluate(() => ((document.querySelector('[data-codex-extras="agents"]') || {}).textContent || ''))
        .catch(() => '');
      const pillNow = () => codex.evaluate(() => {
        const p = document.querySelector('[data-codex-extras="agents"]');
        const d = p && p.querySelector('[data-codex-extras-dot]');
        return p ? { dot: d ? d.getAttribute('data-codex-extras-dot') : '', text: p.textContent } : null;
      }).catch(() => null);
      const mapRows = async () => {
        await clearToasts();
        await codex.locator('[data-codex-extras="agents"]').first().click().catch(() => {});
        await until(() => codex.evaluate(() => !!document.querySelector('[data-codex-extras="map-dialog"]')).catch(() => false), 5000, 200);
        const rows = await codex.evaluate(() => {
          const dot = (e) => { const d = e.querySelector('[data-codex-extras-dot]'); return d ? d.getAttribute('data-codex-extras-dot') : ''; };
          const all = (sel) => [...document.querySelectorAll(`[data-codex-extras="map-dialog"] ${sel}`)];
          return { agents: all('[data-codex-extras="map-agent"]').map((e) => ({ dot: dot(e), name: (e.querySelector('[data-codex-extras-name]') || {}).textContent || '' })),
            jobs: all('[data-codex-extras="map-job"]').map((e) => ({ dot: dot(e), text: e.textContent })),
            work: all('[data-codex-extras="map-bg"]').map((e) => ({ kind: e.getAttribute('data-codex-extras-kind'), dot: dot(e), text: e.textContent })) };
        }).catch(() => null);
        await page.keyboard.press('Escape');
        await until(() => codex.evaluate(() => !document.querySelector('[data-codex-extras="map-dialog"]')).catch(() => true), 3000, 200);
        return rows;
      };
      /* Codex runs a sandboxed command under bubblewrap, which on some machines cannot bind the root directory at all;
         the command then exits with bwrap's message as its output. */
      const sandboxRefused = () => {
        try {
          const sessions = path.join(profile.codexHome, 'sessions');
          const file = fs.readdirSync(sessions, { recursive: true }).map((r) => path.join(sessions, r)).find((f) => f.endsWith(`${id}.jsonl`));
          const m = /bwrap: [^"\\]*/.exec(fs.readFileSync(file, 'utf8').split('\n').slice(-30).join('\n'));
          return m ? m[0] : '';
        } catch (_) { return ''; }
      };
      /* With `panel` set, the case also checks Agent Plus's Conversations panel: the row's red circle while Codex asks, and
         its green ring after the turn. Whether it has the envelope depends on the focus, so that is left out. */
      const leftCase = async ({ name, words, steps, ask, end, ms = 45000, during, notice, map, panel = false }) => {
        const from = model.seen.length;
        const counted = await agentCount();
        model.script(id, steps);
        await send(`Start the ${name} and come back.`);
        /* On Windows Codex asks before it runs even a sandboxed command; elsewhere only a command asked to run outside. */
        const shown = await until(async () => (await card()) || (!ask && model.left() === 0 && 'none'), 20000, 300);
        if (ask) check(!!shown && shown !== 'none', `${name}: Codex shows its card asking to run the command outside the sandbox`);
        if (shown && shown !== 'none') {
          note(`${name}: the card reads ${JSON.stringify(shown)}`);
          const red = await until(async () => { const d = await dotsOn(title); return d && d.waiting >= 6 && d; }, 20000, 500);
          check(!!red, `${name}: while Codex waits for the approval, the tab's logo carries the red dot`, await dotsOn(title));
          const blueRow = await until(async () => { const r = await slRow(id); return !!r && r.dot === 'blue' && r; }, 10000, 300);
          check(!!blueRow, `${name}: and the conversation's row in Agent Plus's session list the blue dot of a dialog waiting for the user`, await slRow(id));
          if (panel) {
            const p = await panelSays(title, 'dialog', null);
            check(p.ok, `${name}: and its row in Agent Plus's Conversations panel a blue circle`, p.row);
          }
          if (await focused()) {
            await sleep(4000);
            const held = { counted: await agentCount(), notification: await toastAbout(title, 'is waiting for you') };
            check(held.counted <= counted && !held.notification,
              `${name}: and with the tab in front of the focused window, Agent Plus neither announces nor counts it`, { before: counted, ...held });
          }
          await shot(`left-${name.replace(/\W+/g, '-')}-approval`);
          await approve(name);
        }
        const after = await until(async () => { const g = await now(); return model.left() === 0 && g.running.includes(words) && g.tab && g.row && g; }, 40000, 500);
        const refused = after ? '' : sandboxRefused();
        if (refused) {
          note(`${name}: Codex's own sandbox could not start the command on this machine ("${refused}"), so it ended at once and nothing was left running to check`);
          return;
        }
        check(!!after, `${name}: after its turn has ended, the tab's logo and the conversation's row in Agent Plus's session list show the green ring, and the row's hover says "${words}"`,
          after || { left: model.left(), ...await now(), held: await call(`${OWN}
            const a = own('patching')._approvals;
            return { waiting: a.of(arg), threads: a.threads(), sinceMs: a.since ? a.since(arg) : null };`, id).catch((e) => String(e)) });
        await shot(`left-${name.replace(/\W+/g, '-')}`);
        let listed = null;
        if (map) {
          const pill = await until(async () => { const q = await pillNow(); return q && q.dot === 'working' && map.text.test(q.text) && q; }, 20000, 500);
          check(!!pill, `${name}: the Agent map pill has a green dot and counts it (${map.text})`, await pillNow());
          listed = await mapRows();
          check(!!listed && map.listed(listed), `${name}: and the Agent map dialog lists it with a green dot`, listed);
        }
        /* After the map, which has to be read while the work still runs. */
        if (panel) {
          const p = await panelSays(title, 'background', null, 10000);
          check(p.ok, `${name}: and its row in Agent Plus's Conversations panel a green ring`, { panel: p.row, still: await now() });
        }
        if (during) await during(listed);
        if (end) end();
        const gone = await until(async () => { const g = await now(); return g.green === 0 && !/^(green|greenRing)$/.test(g.rowDot || '') && !g.running.includes(words) && g; }, ms, 1000);
        check(!!gone, `${name}: once that has finished, the green leaves both`, gone || { ...await now(), ...await why() });
        if (notice) {
          /* The notice has to be a message of its own after the last reply, since every request carries the conversation's
             earlier notices and the command itself in its history. */
          const told = () => model.seen.slice(from).find((x) => x.context && x.context.said.some((t) => t.includes('Codex Plus notice') && t.includes(notice)));
          const got = await until(told, 60000, 1000);
          check(!!got && got.context.said.some((t) => /exit code cannot be known/.test(t)), `${name}: and the conversation is sent a notice that it is no longer running, `
            + 'naming it and saying its exit code cannot be known', got ? got.context.said : model.seen.slice(from).map((x) => x.context && x.context.said));
          await until(async () => !(await dotsOn(title) || {}).working, 30000, 1000);
        }
      };
      const green = (x) => x.dot === 'working';
      await leftCase({ name: 'background command', words: 'A background command is still running', panel: true,
        steps: [{ call: 'exec_command', args: { cmd: process.platform === 'win32' ? 'Start-Sleep -Seconds 25' : 'sleep 25', yield_time_ms: 1000 } },
          { reply: 'Started the job.' }],
        /* Without /proc or this window's app-server (Windows) the host knows a terminal runs but cannot count or list it. */
        map: { text: /\b(1 )?terminal\b/, listed: (r) => r.work.some((x) => x.kind === 'command' && green(x)
          && /Sleep|sleep|A background terminal is still running/.test(x.text)) } });
      await leftCase({ name: 'sub-agent', words: 'A sub-agent is still running', end: () => model.releaseOthers(), panel: true,
        steps: [{ call: 'spawn_agent', namespace: 'collaboration', args: { task_name: 'job', message: 'Wait for the job.', fork_turns: 'none' } },
          { reply: 'Started a helper.' }],
        map: { text: /\b1 agent\b/, listed: (r) => r.agents.some((a) => a.dot === 'working' || a.dot === 'background') },
        during: async (listed) => {
          await agentSetting('sessions.hideBackground', false);
          try {
            const kid = await until(async () => (await showList()) && sl.evaluate(() => {
              const r = [...document.querySelectorAll('.sl-row')].map((e) => e._row).find((x) => x && x.depth > 0);
              return r ? { title: String(r.title || ''), dot: String(r.dot || ''), depth: r.depth } : null;
            }).catch(() => null), 20000, 500);
            const name = ((listed && listed.agents[0]) || {}).name || '';
            check(!!kid && kid.title === name && kid.title !== '(untitled)' && /^(green|greenRing)$/.test(kid.dot),
              'sub-agent: with background conversations listed (agentPlus.sessions.hideBackground off), its row under the conversation has the Agent map\'s name for it and a green dot',
              { row: kid, map: name });
            await shot('left-sub-agent-row');
          } finally { await agentSetting('sessions.hideBackground', undefined); }
        } });
      if (process.platform === 'linux') {
        const outside = (cmd) => ({ call: 'exec_command', args: { cmd, yield_time_ms: 1000, sandbox_permissions: 'require_escalated',
          justification: 'Start the job outside the sandbox.' } });
        /* Codex ends a command's process group when the command exits, and a job sent to the background stays in that group
           until it has run setsid. The command therefore returns only after the job leads a session of its own. */
        const detach = (cmd) => `${cmd} p=$!; i=0; while [ "$(cut -d' ' -f6 /proc/$p/stat 2>/dev/null)" != "$p" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done`;
        await leftCase({ name: 'detached shell', words: 'A command it detached is still running', ask: true, ms: 70000,
          notice: 'sleep 45; true', steps: [outside(detach("setsid nohup bash -c 'sleep 45; true' >/dev/null 2>&1 &")), { reply: 'Started the job.' }],
          map: { text: /\b1 detached\b/, listed: (r) => r.jobs.some((j) => green(j) && /sleep 45/.test(j.text)) } });
        await leftCase({ name: 'program setsid started', words: 'A command it detached is still running', ask: true, ms: 70000,
          notice: 'sleep 47', steps: [outside(detach('setsid sleep 47 >/dev/null 2>&1 < /dev/null &')), { reply: 'Started the job.' }],
          map: { text: /\b1 detached\b/, listed: (r) => r.jobs.some((j) => green(j) && /sleep 47/.test(j.text)) },
          during: async () => {
            const pill = await until(async () => { const t = await pillText(); return /\b1 detached\b/.test(t) && t; }, 20000, 500);
            check(!!pill, 'program setsid started: the Agent map button counts it as detached', await pillText());
          } });
        const ext = fs.readdirSync(profile.exts).find((d) => d.startsWith('openai.chatgpt-'));
        const bin = ext ? codexBinary(path.join(profile.exts, ext)) : '';
        check(!!bin, 'the codex program of the Codex extension is found, for a codex exec to start', profile.exts);
        if (bin) {
          await leftCase({ name: 'codex exec', words: 'A codex exec it started is still running', ask: true, end: () => model.releaseOthers(),
            steps: [outside(`setsid nohup '${bin}' exec --skip-git-repo-check 'Wait for the job.' >/dev/null 2>&1 &`), { reply: 'Started a worker.' }],
            map: { text: /\b1 codex exec\b/, listed: (r) => r.work.some((x) => x.kind === 'codexExec' && green(x) && /codex exec/.test(x.text)) } });
        }
        /* The stand-ins write the session record Claude Code keeps for a running process, which is what Codex Plus
           reads, under this window's own HOME. The --bg one returns after its session has written that record, as
           claude --bg prints its hint only when the session is up; by then the session is out of the command's process
           group, which Codex can kill the moment the command exits. */
        const fakeBin = path.join(profile.home, 'fake-claude');
        fs.mkdirSync(fakeBin, { recursive: true });
        const fakeClaude = path.join(fakeBin, 'claude'), fakeSession = path.join(fakeBin, 'claude-bg-session');
        fs.writeFileSync(fakeClaude, [
          '#!/bin/sh',
          'sessions="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions"',
          'mkdir -p "$sessions"',
          'if [ "$1" = "--bg" ]; then',
          `  env -u CODEX_THREAD_ID setsid '${fakeSession}' "$sessions" < /dev/null > /dev/null 2>&1 &`,
          '  i=0; while [ ! -s "$sessions/$!.json" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done',
          "  echo 'backgrounded · 1a2b3c4d'",
          '  exit 0',
          'fi',
          'printf \'{"pid":%s,"sessionId":"0b1c2d3e-0000-4000-8000-0000000000a1","kind":"interactive","entrypoint":"sdk-cli","status":"busy","name":"window test worker"}\\n\' $$ > "$sessions/$$.json"',
          'sleep 40', ''].join('\n'), { mode: 0o755 });
        fs.writeFileSync(fakeSession, [
          '#!/bin/sh',
          'printf \'{"pid":%s,"sessionId":"0b1c2d3e-0000-4000-8000-0000000000b1","kind":"bg","entrypoint":"cli","status":"busy","jobId":"1a2b3c4d","name":"window test session"}\\n\' $$ > "$1/$$.json"',
          'sleep 40', ''].join('\n'), { mode: 0o755 });
        await leftCase({ name: 'claude -p worker', words: 'A claude -p worker it started is still running', ask: true, ms: 70000,
          steps: [outside(`setsid nohup '${fakeClaude}' -p 'Wait for the job.' >/dev/null 2>&1 < /dev/null &`), { reply: 'Started a worker.' }],
          map: { text: /\b1 claude -p\b/, listed: (r) => r.work.some((x) => x.kind === 'claudeWorker' && green(x) && /^window test worker/.test(x.text) && /claude -p · /.test(x.text)) } });
        await leftCase({ name: 'claude --bg session', words: 'A claude --bg session it started is still busy', ask: true, ms: 70000,
          steps: [outside(`'${fakeClaude}' --bg 'Run the suite.'`), { reply: 'Started a session.' }],
          map: { text: /\b1 claude --bg\b/, listed: (r) => r.work.some((x) => x.kind === 'claudeBg' && green(x) && /window test session/.test(x.text) && /job 1a2b3c4d/.test(x.text)) } });

        /* Every window on a build installed over: this copy's manifest gets an install stamp other than the one it was
           loaded with (src/installed-copies.js replacedSince), which reinstalling the same version also does. With
           no window running the installed build, this one still notes the end of a command left running detached and
           sends the conversation its notice (src/uninstall-plan.js keepsShared). */
        const selfDir = path.join(profile.exts, fs.readdirSync(profile.exts).find((d) => d.startsWith('xnervwang.codex-plus-')));
        const manifest = path.join(selfDir, 'package.json'), had = fs.readFileSync(manifest, 'utf8');
        const hostPid = await call('return process.pid;');
        const entry = () => { try { return JSON.parse(fs.readFileSync(path.join(PLANS_DIR, 'windows', `${hostPid}.json`), 'utf8')); } catch (_) { return null; } };
        try {
          const pkg = JSON.parse(had);
          const meta = pkg.__metadata || {};
          pkg.__metadata = Object.assign({}, meta, { installedTimestamp: (meta.installedTimestamp || Date.now()) + 1 });
          fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2));
          const over = await until(() => { const e = entry(); return e && e.installed === false && e; }, 30000, 500);
          check(!!over, 'with another install stamp in its manifest, this window takes its build for one installed over, and its entry among the windows says so',
            { entry: entry(), stamp: meta.installedTimestamp });
          if (over) {
            await leftCase({ name: 'detached shell in a window installed over', words: 'A command it detached is still running', ask: true, ms: 70000,
              notice: 'sleep 33; true', steps: [outside(detach("setsid nohup bash -c 'sleep 33; true' >/dev/null 2>&1 &")), { reply: 'Started the job.' }] });
          }
        } finally { fs.writeFileSync(manifest, had); }
        const installed = await until(() => { const e = entry(); return e && e.installed === true && e; }, 30000, 500);
        check(!!installed, 'with its manifest put back, the window takes its build for the installed one again', entry());
      } else {
        note(`a detached shell, a program setsid started, a codex exec and claude -p and claude --bg sessions are found through /proc, which ${process.platform} does not have, `
          + 'so none of them is made here; the red dot is checked in the step on a conversation waiting for you');
      }
      model.script(null);
    });

    /* Here the claude --bg launch command waits before it starts the session, so exec_command answers after yield_time_ms
       with the command still running and the job id comes in the output of a later write_stdin poll on its session.
       On Linux the stand-in is a claude script, as in the step above. macOS has no setsid and Windows no sh, so there the
       command only prints the hint line, as in the next step, and this step writes the session's record itself, for a
       process it starts. */
    await step('a claude --bg session whose job id a later poll reads', async () => {
      if (!codex || !await showList()) throw new Error('the conversation or the session list did not open');
      const id = threads[0].id, job = '9c8d7e6f', mark = 'Run the polled suite.', words = 'A claude --bg session it started is still busy';
      const linux = process.platform === 'linux';
      const sessions = path.join(env.CLAUDE_CONFIG_DIR || path.join(profile.home, '.claude'), 'sessions');
      fs.mkdirSync(sessions, { recursive: true });
      const record = (pid) => JSON.stringify({ pid, sessionId: '0b1c2d3e-0000-4000-8000-0000000000c1', kind: 'bg', entrypoint: 'cli', status: 'busy',
        jobId: job, name: 'window test polled session' });
      const now = async () => {
        const d = await dotsOn(title), r = await slRow(id);
        return { tab: !!d && d.working >= 6 && d.ring, row: !!r && r.dot === 'greenRing', green: d ? d.working : -1,
          running: leftLines(r), rowDot: r && r.dot };
      };
      const pillNow = () => codex.evaluate(() => {
        const p = document.querySelector('[data-codex-extras="agents"]');
        const d = p && p.querySelector('[data-codex-extras-dot]');
        return p ? { dot: d ? d.getAttribute('data-codex-extras-dot') : '', text: p.textContent } : null;
      }).catch(() => null);
      const mapWork = async () => {
        await clearToasts();
        await codex.locator('[data-codex-extras="agents"]').first().click().catch(() => {});
        await until(() => codex.evaluate(() => !!document.querySelector('[data-codex-extras="map-dialog"]')).catch(() => false), 5000, 200);
        const rows = await codex.evaluate(() => [...document.querySelectorAll('[data-codex-extras="map-dialog"] [data-codex-extras="map-bg"]')].map((e) => {
          const d = e.querySelector('[data-codex-extras-dot]');
          return { kind: e.getAttribute('data-codex-extras-kind'), dot: d ? d.getAttribute('data-codex-extras-dot') : '', text: e.textContent };
        })).catch(() => null);
        await page.keyboard.press('Escape');
        await until(() => codex.evaluate(() => !document.querySelector('[data-codex-extras="map-dialog"]')).catch(() => true), 3000, 200);
        return rows;
      };
      /* The output of the launch command and of each write_stdin call on its session, read from the rollout. */
      const polled = () => {
        let rows;
        try {
          const dir = path.join(profile.codexHome, 'sessions');
          const file = fs.readdirSync(dir, { recursive: true }).map((r) => path.join(dir, String(r))).find((f) => f.endsWith(`${id}.jsonl`));
          rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).payload || {}; } catch (_) { return {}; } });
        } catch (_) { return null; }
        const text = (o) => (typeof o === 'string' ? o : o && typeof o.content === 'string' ? o.content
          : Array.isArray(o && o.content) ? o.content.map((x) => (x && x.text) || '').join('') : '');
        const args = (p) => { try { return JSON.parse(p.arguments) || {}; } catch (_) { return {}; } };
        const outOf = (callId) => text((rows.find((p) => p.type === 'function_call_output' && p.call_id === callId) || {}).output);
        const launch = rows.find((p) => p.type === 'function_call' && p.name === 'exec_command' && String(args(p).cmd || '').includes(mark));
        if (!launch) return null;
        const first = outOf(launch.call_id);
        const session = (/Process running with session ID (\d+)/.exec(first) || [])[1] || '';
        const polls = session ? rows.filter((p) => p.type === 'function_call' && p.name === 'write_stdin' && String(args(p).session_id) === session) : [];
        return { first, session, polls: polls.map((p) => outOf(p.call_id)) };
      };
      /* The last session exec_command reported as still running is this turn's, since the body holds the whole conversation. */
      const sessionIn = (body) => {
        const all = [...String(body).matchAll(/Process running with session ID (\d+)/g)];
        return all.length ? Number(all[all.length - 1][1]) : 0;
      };

      const quiet = await until(async () => { const g = await now(); return g.green === 0 && !g.running && g; }, 60000, 1000);
      if (!quiet) note(`polled claude --bg: before the turn the conversation still shows work left running: ${JSON.stringify(await now())}`);
      let keeper = null, cmd;
      if (linux) {
        const bin = path.join(profile.home, 'fake-claude-polled');
        fs.mkdirSync(bin, { recursive: true });
        const claude = path.join(bin, 'claude'), session = path.join(bin, 'claude-bg-session');
        fs.writeFileSync(claude, [
          '#!/bin/sh',
          'sessions="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions"',
          'mkdir -p "$sessions"',
          `env -u CODEX_THREAD_ID setsid '${session}' "$sessions" < /dev/null > /dev/null 2>&1 &`,
          'i=0; while [ ! -s "$sessions/$!.json" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done',
          `printf 'backgrounded · ${job}\\n  claude attach ${job}   open in this terminal\\n  claude logs ${job}     show recent output\\n'`,
          `printf '  claude stop ${job}     stop this session\\n'`, ''].join('\n'), { mode: 0o755 });
        /* Removing the record ends the stand-in session. */
        fs.writeFileSync(session, [
          '#!/bin/sh',
          `printf '${record('%s').replace('"%s"', '%s')}\\n' $$ > "$1/$$.json"`,
          'i=0; while [ -e "$1/$$.json" ] && [ $i -lt 240 ]; do sleep 0.5; i=$((i+1)); done', ''].join('\n'), { mode: 0o755 });
        cmd = `sleep 15 && '${claude}' --bg '${mark}' 2>&1 | tail -3`;
      } else {
        keeper = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 180000)'], { stdio: 'ignore' });
        fs.writeFileSync(path.join(sessions, `${keeper.pid}.json`), record(keeper.pid));
        const hint = `echo 'claude logs ${job}  show recent output' # claude --bg '${mark}'`;
        cmd = process.platform === 'win32' ? `Start-Sleep -Seconds 15; ${hint}` : `sleep 15 && ${hint}`;
      }
      const mine = () => {
        try {
          return fs.readdirSync(sessions).filter((n) => n.endsWith('.json')).map((n) => path.join(sessions, n)).filter((f) => {
            try { return JSON.parse(fs.readFileSync(f, 'utf8')).jobId === job; } catch (_) { return false; }
          });
        } catch (_) { return []; }
      };
      try {
        model.script(id, [
          { call: 'exec_command', args: { cmd, yield_time_ms: 1000,
            ...(linux ? { sandbox_permissions: 'require_escalated', justification: 'Start the session outside the sandbox.' } : {}) } },
          { call: 'write_stdin', args: (body) => ({ session_id: sessionIn(body), chars: '', yield_time_ms: 30000 }) },
          { reply: 'Started a session.' }]);
        await exec('notifications.clearAll');
        await tabNamed(title).click();
        await intoComposer(codex);
        await page.keyboard.type('Start the polled claude --bg session and come back.');
        await page.keyboard.press('Enter');
        /* Codex asks before a command runs outside its sandbox, and on Windows before any command. */
        let asked = 0;
        const sent = await until(async () => {
          if (await codex.evaluate(() => !!document.querySelector('[data-codex-approval-surface]')).catch(() => false)) {
            asked++;
            await clearToasts();
            const buttons = codex.locator('[data-codex-approval-surface] button');
            const yes = buttons.filter({ hasText: /^(Yes|Allow once|Allow this time|Approve|Run)\b/ }).first();
            if (await yes.count()) await yes.click();
            const submit = buttons.filter({ hasText: /^Submit$/ }).first();
            if (await submit.count()) await submit.click();
            await sleep(1000);
            return false;
          }
          return model.left() === 0;
        }, 120000, 500);
        const r = await until(() => { const x = polled(); return x && x.polls.some((t) => t.includes(job)) && x; }, 15000, 500) || polled();
        check(!!sent && !!r && !!r.session && !r.first.includes(job) && r.polls.some((t) => t.includes(job)),
          'polled claude --bg: exec_command answers while the command still waits, and the job id is only in what a later write_stdin on its session reads',
          { left: model.left(), asked, rollout: r && { first: r.first.slice(0, 300), session: r.session, polls: r.polls.map((t) => t.slice(0, 300)) } });

        const after = await until(async () => { const g = await now(); return g.tab && g.row && g.running.includes(words) && g; }, 60000, 500);
        const g = after || await now();
        check(g.tab, 'polled claude --bg: after the turn the tab\'s logo shows the green ring', g);
        check(g.row && g.running.includes(words), `polled claude --bg: and the conversation's row in Agent Plus's session list a green ring, its hover saying "${words}"`, g);
        await shot('polled-claude-bg');
        const pill = await until(async () => { const q = await pillNow(); return q && q.dot === 'working' && /\b1 claude --bg\b/.test(q.text) && q; }, 20000, 500);
        const listed = await mapWork();
        check(!!pill && !!listed && listed.some((x) => x.kind === 'claudeBg' && x.dot === 'working' && /window test polled session/.test(x.text) && x.text.includes(`job ${job}`)),
          'polled claude --bg: the Agent map pill is green and counts it, and its dialog lists the session by its name and job id with a green dot',
          { pill: pill || await pillNow(), listed });
      } finally {
        model.script(null);
        for (const f of mine()) fs.rmSync(f, { force: true });
        if (keeper) keeper.kill();
      }
      const gone = await until(async () => { const x = await now(); return x.green === 0 && !/^(green|greenRing)$/.test(x.rowDot || '') && !x.running.includes(words) && x; }, 60000, 1000);
      check(!!gone, 'polled claude --bg: once its record is gone, the green leaves the tab and the row', gone || await now());
    });

    /* Notices about a claude --bg session the conversation launched (src/bg-ends.js). The launch is a command whose
       output has the hint line claude --bg prints, and the session is only its record under this window's HOME, so no Claude
       Code runs and the check also works without /proc. */
    await step('news of a claude --bg session', async () => {
      if (!codex) throw new Error('the conversation did not open in a tab');
      const id = threads[0].id, job = '5e6f7a8b';
      const claude = env.CLAUDE_CONFIG_DIR || path.join(profile.home, '.claude');
      const shared = path.join(profile.codexHome, 'plugins', 'data', 'agent-work-plan-codex-extras', 'shared');
      const seenNow = () => { try { return JSON.parse(fs.readFileSync(path.join(shared, 'background-seen.json'), 'utf8')).jobs || {}; } catch (_) { return {}; } };
      const record = (fields) => {
        const dir = path.join(claude, 'jobs', job), at = new Date().toISOString();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id: job, name: 'window test suite', createdAt: at, updatedAt: at, ...fields }));
      };
      const card = () => codex.evaluate(() => !!document.querySelector('[data-codex-approval-surface]')).catch(() => false);
      const cmd = `echo 'claude logs ${job}  show recent output' # claude --bg 'Run the suite.'`;
      /* Codex's sandbox cannot start a command on every Linux machine, so there it runs outside, once approved. */
      model.script(id, [{ call: 'exec_command', args: process.platform === 'linux'
        ? { cmd, yield_time_ms: 1000, sandbox_permissions: 'require_escalated', justification: 'Start the session.' } : { cmd, yield_time_ms: 1000 } },
      { reply: 'Started a session.' }]);
      await exec('notifications.clearAll');
      await tabNamed(title).click();
      await intoComposer(codex);
      await page.keyboard.type('Start the claude --bg session and come back.');
      await page.keyboard.press('Enter');
      /* On Windows Codex asks before it runs even a sandboxed command. */
      const asked = await until(async () => (await card()) || (process.platform !== 'linux' && model.left() === 0 && 'none'), 30000, 300);
      if (asked === true) {
        const yes = codex.locator('[data-codex-approval-surface] button').filter({ hasText: /^(Yes|Allow once|Allow this time|Approve|Run)\b/ }).first();
        if (await yes.count()) await yes.click();
        const submit = codex.locator('[data-codex-approval-surface] button').filter({ hasText: /^Submit$/ }).first();
        if (await submit.count()) await submit.click();
      }
      const launched = () => {
        try {
          const sessions = path.join(profile.codexHome, 'sessions');
          const file = fs.readdirSync(sessions, { recursive: true }).map((r) => path.join(sessions, String(r))).find((f) => f.endsWith(`${id}.jsonl`));
          return fs.readFileSync(file, 'utf8').split('\n').some((l) => l.includes('function_call_output') && l.includes(`claude logs ${job}`));
        } catch (_) { return false; }
      };
      check(!!await until(() => model.left() === 0 && launched(), 40000, 500), 'the conversation runs a command that launches a claude --bg session',
        { left: model.left(), asked });
      model.script(null);
      record({ state: 'working' });
      const noted = await until(() => seenNow()[job] === 'working' && seenNow(), 60000, 1000);
      check(!!noted, 'Codex Plus finds the session in the command\'s output and notes it as working, without telling anyone yet', seenNow());

      const turns = model.turns();
      record({ state: 'done', lastTerminalAt: new Date().toISOString(), output: { result: 'All 12 window suites passed.' } });
      const told = await until(() => model.sent('All 12 window suites passed.') > 0 && model.turns() > turns, 60000, 1000);
      check(!!told && model.sent(`(${job}) finished`) > 0, 'once it is done, the idle conversation starts a turn with a notice naming the session and its result',
        { sent: model.sent(job), turns: [turns, model.turns()], seen: seenNow() });

      fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
      const live = path.join(claude, 'sessions', `${process.pid}.json`);
      fs.writeFileSync(live, JSON.stringify({ pid: process.pid, kind: 'bg', jobId: job, status: 'idle', name: 'window test suite' }));
      const question = 'Which window region should the suite run in?';
      record({ state: 'blocked', needs: question });
      check(!!await until(() => model.sent(question) > 0, 120000, 1000), 'once it waits for an answer, with its process running, the conversation is told what it asks',
        { sent: model.sent(question), seen: seenNow() });

      await call('await vscode.workspace.getConfiguration("agentPlus").update("tokenMode", "custom", vscode.ConfigurationTarget.Global); return true;');
      await setting('detachedEndNotices', false);
      const quiet = 'Nothing to tell while notices are off.';
      record({ state: 'done', lastTerminalAt: new Date().toISOString(), output: { result: quiet } });
      const noted2 = await until(() => /^done@/.test(seenNow()[job] || ''), 60000, 1000);
      await sleep(25000);
      check(!!noted2 && model.sent(quiet) === 0, 'with codexPlus.detachedEndNotices off in Custom, the next change is noted and nothing is sent',
        { seen: seenNow(), sent: model.sent(quiet) });
      await setting('detachedEndNotices', true);
      await call('await vscode.workspace.getConfiguration("agentPlus").update("tokenMode", undefined, vscode.ConfigurationTarget.Global); return true;');
      await sleep(25000);
      check(model.sent(quiet) === 0, 'and turned back on, what changed meanwhile is not sent either', model.sent(quiet));
      fs.rmSync(live, { force: true });
    });

    await step('images', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const id = threads[0].id;
      const zlib = require('zlib');
      const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
      const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
      const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
      const png = (w, h) => {
        const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
        const row = Buffer.alloc(1 + w * 3);
        for (let x = 0; x < w; x++) { row[1 + x * 3] = x < w / 2 ? 220 : 30; row[2 + x * 3] = 60; row[3 + x * 3] = x < w / 2 ? 40 : 200; }
        return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
          chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
      };
      const fwd = (p) => p.replace(/\\/g, '/');
      const chart = path.join(profile.folder, 'test-chart.png'), diagram = path.join(profile.folder, 'test-diagram.svg');
      fs.writeFileSync(chart, png(160, 90));
      fs.writeFileSync(diagram, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="80" height="90" fill="#2a2"/>'
        + '<rect x="80" width="80" height="90" fill="#a2a"/></svg>');
      const WEB = 'https://example.com/test-logo.png';
      const reply = `Chart: ![test chart](${fwd(chart)})\n\nDiagram: ![test diagram](${fwd(diagram)})\n\n`
        + `Same chart: ![test file url](file://${fwd(chart).replace(/^([A-Za-z]):/, '/$1:')})\n\n`
        + `Inline: ![test inline](data:image/png;base64,${png(12, 12).toString('base64')})\n\nWeb: ![test web](${WEB})`;
      const send = async (text) => {
        await codex.locator('[data-codex-composer-root] [contenteditable="true"]').first().click();
        await page.keyboard.type(text);
        await page.keyboard.press('Enter');
      };
      const drawn = () => codex.evaluate(() => ({
        imgs: [...document.querySelectorAll('img')].filter((i) => /^test /.test(i.alt)).map((i) => [i.alt, i.naturalWidth > 0 && i.getBoundingClientRect().height > 0]),
        stands: [...document.querySelectorAll('[data-codex-extras="img-stand"]:not(style)')].map((n) => [n.tagName.toLowerCase(), n.textContent, n.getAttribute('href') || '']),
        /* For a check that fails: how far up each image's React fibers the media component is, and whether it sits in a reply. */
        depth: [...document.querySelectorAll('img')].filter((i) => /^test /.test(i.alt)).map((i) => {
          const key = Object.keys(i).find((k) => k.startsWith('__reactFiber$'));
          let f = key ? i[key] : null, n = 0;
          for (; f && n < 120; n++, f = f.return) { const p = f.memoizedProps; if (p && typeof p === 'object' && typeof p.src === 'string' && 'blockRemoteMedia' in p) break; }
          return [i.alt, key ? (f ? n : -1) : 'no fiber', !!i.closest('[data-response-annotation-target]')];
        }),
      })).catch((e) => ({ error: String(e) }));
      const bottom = () => codex.evaluate(() => { const s = document.querySelector('[data-app-action-timeline-scroll]'); if (s) s.scrollTop = s.scrollHeight; }).catch(() => {});
      model.script(id, [{ reply }]);
      await send('Show the test images.');
      const shownOn = await until(async () => { await bottom(); const d = await drawn(); return d.imgs && d.imgs.filter((x) => x[1]).length >= 4 && d; }, 30000, 500);
      check(!!shownOn && ['test chart', 'test diagram', 'test file url', 'test inline'].every((a) => shownOn.imgs.some((x) => x[0] === a && x[1])),
        'a PNG and an SVG by absolute path, a file:// URL and a data: URL are drawn in the reply', shownOn || await drawn());
      const linked = await until(async () => { const d = await drawn(); return d.stands && d.stands.some((x) => x[0] === 'a' && x[1] === 'test web' && x[2] === WEB) && d; }, 15000, 500);
      check(!!linked && !linked.imgs.some((x) => x[0] === 'test web'), 'and the image at a web address is a plain link named by its alt text, with no image of its own',
        linked || await drawn());
      await shot('images-on');

      await setting('replyImages', false);
      const off = await until(async () => { const d = await drawn(); return d.stands && d.stands.filter((x) => x[1] === '[Image]').length >= 4 && d; }, 15000, 500);
      check(!!off && !off.imgs.some((x) => x[1]), 'with codexPlus.replyImages off the reply\'s other images are "[Image]", and the web link stays',
        off || await drawn());
      await shot('images-off');
      await setting('replyImages', true);
      const back = await until(async () => { const d = await drawn(); return d.imgs && d.imgs.filter((x) => x[1]).length >= 4 && d; }, 15000, 500);
      check(!!back, 'turned back on, the images are drawn again', back || await drawn());
      model.script(null);
    });

    /* codexPlus.conversationLinks: when a reply names another conversation by its title in corner brackets or by its id,
       the name is a link, and clicking it brings that conversation's tab to the front. */
    await step('links to other conversations in a reply', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const id = threads[0].id, other = threads[1];
      const closeTabsOf = (want) => call(`const mine = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((x) => x.input && x.input.uri && String(x.input.uri).includes(arg));
        if (mine.length) await vscode.window.tabGroups.close(mine); return mine.length;`, want);
      await call('await vscode.commands.executeCommand("codexPlus.openThreadInTab", arg); return true;', other.id);
      const opened = await until(async () => { const t = await frontTab(); return t && bare(t.label) === other.title && t; }, 30000, 500);
      check(!!opened, 'the other conversation is open in a tab of its own', await tabs());
      await tabNamed(title).click();
      if (!await until(async () => { const t = await frontTab(); return t && bare(t.label) === title; }, 15000, 500)) throw new Error(`the tab of "${title}" did not come back to the front`);
      const reply = `That was 「${other.title}」, whose thread ${other.id} has the details.`;
      const links = () => codex.evaluate((want) => [...document.querySelectorAll('[data-codex-extras="convo-link"]')]
        .filter((a) => a.getAttribute('data-agent-plus-mention') === want).map((a) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--vscode-textLink-foreground)';
          a.parentNode.appendChild(probe);
          const theme = getComputedStyle(probe).color;
          probe.remove();
          return { text: a.textContent, inPre: !!a.closest('pre'), coloured: getComputedStyle(a).color === theme };
        }), `codex:${other.id}`).catch((e) => ({ error: String(e) }));
      const bottom = () => codex.evaluate(() => { const s = document.querySelector('[data-app-action-timeline-scroll]'); if (s) s.scrollTop = s.scrollHeight; }).catch(() => {});
      model.script(id, [{ reply }]);
      await intoComposer(codex);
      await page.keyboard.type('Which conversation was that?');
      await page.keyboard.press('Enter');
      const drawn = await until(async () => { await bottom(); const l = await links(); return Array.isArray(l) && l.length >= 2 && l; }, 45000, 500);
      check(!!drawn && drawn.some((l) => l.text === other.title) && drawn.some((l) => l.text === other.id) && drawn.every((l) => l.coloured && !l.inPre),
        'the reply\'s 「title」 of the other conversation and its id are each drawn as a link, in the theme\'s link colour', drawn || await links());
      await shot('conversation-links');
      const named = codex.locator('[data-codex-extras="convo-link"]').filter({ hasText: other.title }).first();
      await named.hover();
      const tip = await until(() => codex.evaluate(() => { const b = document.querySelector('[data-codex-extras="label"]'); return b && b.textContent; }).catch(() => ''), 5000, 200);
      check(!!tip && tip.includes(other.title) && tip.includes(`Codex conversation ${other.id.slice(0, 8)}`),
        'hovering a link shows the conversation and its agent in the page\'s own label', tip);
      await codex.locator('[data-codex-extras="convo-link"]').filter({ hasText: other.id }).first().click();
      const front = await until(async () => { const t = await frontTab(); return t && bare(t.label) === other.title && t; }, 15000, 500);
      check(!!front, 'a click on the link brings the other conversation\'s tab to the front', { front: await frontTab(), agentPlus: agentFront() });
      await tabNamed(title).click();
      await until(async () => { const t = await frontTab(); return t && bare(t.label) === title; }, 15000, 500);
      await setting('conversationLinks', false);
      const gone = await until(async () => { const l = await links(); return Array.isArray(l) && !l.length
        && await codex.evaluate((r) => document.body.innerText.includes(r), reply).catch(() => false); }, 15000, 500);
      check(!!gone, 'with codexPlus.conversationLinks off the reply has no links, and reads as it did', await links());
      await setting('conversationLinks', undefined);
      const back = await until(async () => { const l = await links(); return Array.isArray(l) && l.length >= 2 && l; }, 15000, 500);
      check(!!back, 'and back on, the links are drawn again', await links());
      model.script(null);
      await served();
      await closeTabsOf(other.id);
    });

    /* For the two steps below: the links to other conversations in a reply of the conversation in `codex`. `want` is
       "<agent>:<id>", the way the page marks a link. */
    const mentionLinks = (want) => codex.evaluate((w) => [...document.querySelectorAll('[data-codex-extras="convo-link"]')]
      .filter((a) => a.getAttribute('data-agent-plus-mention') === w).map((a) => a.textContent), want).catch((e) => ({ error: String(e) }));
    const replyNaming = async (text) => {
      await tabNamed(title).click();
      await until(async () => { const t = await frontTab(); return t && bare(t.label) === title; }, 15000, 500);
      model.script(threads[0].id, [{ reply: text }]);
      await intoComposer(codex);
      await page.keyboard.type('Which one was that?');
      await page.keyboard.press('Enter');
    };
    const toBottom = () => codex.evaluate(() => { const s = document.querySelector('[data-app-action-timeline-scroll]'); if (s) s.scrollTop = s.scrollHeight; }).catch(() => {});
    const tabsIn = (folder) => call('return vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => ({ label: t.label, '
      + 'active: t.isActive, front: t.isActive && g.isActive, uri: t.input && t.input.uri ? String(t.input.uri) : "" })));', undefined, 60000, folder).catch(() => []);

    /* The linked conversation is open in a tab of a second window. Agent Plus's open finds no tab of it here and asks
       the other windows (<shared home>/open): the second window takes the request, brings the tab to the front and
       itself with VS Code's command line. Before the steps that reload the window or restart its extension host. */
    await step('a link to a conversation another window shows', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const T = threads[1];
      const folderC = path.join(path.dirname(profile.folder), 'ws-links');
      fs.mkdirSync(folderC, { recursive: true });
      fs.writeFileSync(path.join(folderC, 'notes-links.txt'), 'A file for the window a link opens a conversation in.\n');
      await call(`const mine = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input && t.input.uri && String(t.input.uri).includes(arg));
        if (mine.length) await vscode.window.tabGroups.close(mine); return mine.length;`, T.id);
      const opening = Date.now();
      await call('await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(arg), { forceNewWindow: true }); return true;', folderC);
      const pageC = await w.pageOf(path.basename(folderC), 90000);
      const hostC = pageC ? await w.hostUp(opening, folderC).catch(() => null) : null;
      check(!!pageC && !!hostC, 'a second window opens on a folder of its own, with the test helper in it', { pageC: !!pageC, hostC: !!hostC });
      if (!pageC || !hostC) {
        if (pageC) await pageC.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+W' : 'Control+Shift+W').catch(() => {});
        return;
      }
      w.pin(profile.folder);
      const inC = (body, arg, ms = 60000) => call(body, arg, ms, folderC);
      let watching = true;
      const trustC = (async () => {
        while (watching && !pageC.isClosed()) {
          try {
            const box = pageC.locator('.monaco-dialog-box').filter({ hasText: 'Trust the work plan hooks in Codex?' }).first();
            if (await box.isVisible()) await box.locator('.dialog-buttons .monaco-button').filter({ hasText: 'Cancel' }).first().dispatchEvent('click');
          } catch (_) { /* closing */ }
          await sleep(500);
        }
      })();
      const OPENS = path.join(profile.home, '.agent-work-plan', 'open');
      const taken = () => {
        let names = [];
        try { names = fs.readdirSync(OPENS).filter((n) => n.endsWith('.done')); } catch (_) { return []; }
        const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(OPENS, f), 'utf8')); } catch (_) { return null; } };
        return names.map((n) => { const id = n.slice(0, -5), ask = read(`${id}.taken`) || {}, done = read(n) || {};
          return { id, session: ask.sessionId, from: ask.from, by: done.by, shown: done.shown }; });
      };
      const tabOfT = async (folder) => (await tabsIn(folder)).find((x) => x.uri.includes(T.id) || bare(x.label) === T.title) || null;
      const focusedIn = (folder) => call('return vscode.window.state.focused;', undefined, 15000, folder).catch(() => null);
      try {
        await until(() => inC('const mine = vscode.extensions.getExtension("xnervwang.codex-plus"); return !!(mine && mine.isActive);'), 60000, 1000);
        await inC('await vscode.commands.executeCommand("codexPlus.openThreadInTab", arg); return true;', T.id);
        const inTab = await until(() => tabOfT(folderC), 30000, 500);
        check(!!inTab && !await tabOfT(profile.folder), 'the conversation the link names is open in a tab of the second window and in none here',
          { c: await tabsIn(folderC), here: await tabOfT(profile.folder) });
        /* Behind a text file there, so that bringing it to the front shows. */
        await inC('await vscode.window.showTextDocument(vscode.Uri.file(arg), { preview: false }); return true;', path.join(folderC, 'notes-links.txt'));
        const behind = await until(async () => { const t = await tabOfT(folderC); return t && !t.active && t; }, 15000, 500);
        check(!!behind, 'and is behind a text file there', await tabsIn(folderC));
        await page.bringToFront().catch(() => {});
        await replyNaming(`That is 「${T.title}」, open in the other window.`);
        const drawn = await until(async () => { await toBottom(); const l = await mentionLinks(`codex:${T.id}`); return Array.isArray(l) && l.length && l; }, 45000, 500);
        check(!!drawn && drawn[0] === T.title, 'the reply here names it in corner brackets, drawn as a link to it', drawn || await mentionLinks(`codex:${T.id}`));
        const tabsHere = (await tabsIn(profile.folder)).length, requests = taken().length;
        const focusBefore = { here: await focusedIn(profile.folder), there: await focusedIn(folderC) };
        await codex.locator(`[data-codex-extras="convo-link"][data-agent-plus-mention="codex:${T.id}"]`).first().click();
        const fronted = await until(async () => { const t = await tabOfT(folderC); return t && t.active && t; }, 20000, 500);
        /* The window that takes the request records it only after bringing the tab forward. */
        const took = await until(() => taken().slice(requests).find((r) => r.session === T.id) || null, 15000, 300);
        check(!!fronted && !!took && !!took.by && took.by !== took.from && took.shown === true,
          'a click on it is taken by the second window, which brings the conversation\'s tab to the front there', { fronted, took, c: await tabsIn(folderC) });
        await sleep(1500);
        const here = await tabsIn(profile.folder);
        check(here.length === tabsHere && !here.some((x) => x.uri.includes(T.id) || bare(x.label) === T.title),
          'and this window opens no tab, of that conversation or any other', { before: tabsHere, here });
        /* Agent Plus brings the second window to the front with VS Code's command line, which only the window system can
           be asked about. Each window's vscode.window.state.focused says whether the window system gave it the focus,
           and this is checked only where that reading tells the two windows apart before the click. */
        if (focusBefore.here === true && focusBefore.there === false) {
          const moved = await until(async () => (await focusedIn(folderC)) === true && (await focusedIn(profile.folder)) === false, 15000, 500);
          check(!!moved, 'and the second window takes the focus from this one', { before: focusBefore, after: { here: await focusedIn(profile.folder), there: await focusedIn(folderC) } });
        } else {
          note(`before the click this window ${focusBefore.here ? 'had' : 'did not have'} the focus and the second window ${focusBefore.there ? 'had' : 'did not have'} it on `
            + `${process.platform}, so whether the second window took it was not judged; its request answered shown: ${took ? took.shown : 'none'}`);
        }
        await pageC.screenshot({ path: path.join(shotsDir, `${String(++shotNo).padStart(2, '0')}-conversation-link-other-window.png`) }).catch(() => {});
      } finally {
        model.script(null);
        watching = false;
        /* Closes the conversation's tab first and then the window, and waits until the window's extension host has exited:
           the second window of a later step loads this conversation, and Codex's app-server there refuses it while another
           one still has it ("already has an active writer"). */
        await served([page, pageC]);
        await inC(`const mine = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input && t.input.uri && String(t.input.uri).includes(arg));
          if (mine.length) await vscode.window.tabGroups.close(mine); return mine.length;`, T.id, 15000).catch(() => {});
        await sleep(1500);
        /* Again, since closing the window's last Codex tab can make Codex open a page of its own there. */
        await served([page, pageC]);
        await inC('setTimeout(() => vscode.commands.executeCommand("workbench.action.closeWindow"), 200); return true;', undefined, 15000).catch(() => {});
        await until(() => pageC.isClosed(), 30000, 500);
        const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
        if (!await until(() => !alive(hostC.pid), 30000, 500)) note(`the second window's extension host (pid ${hostC.pid}) was still running 30 s after its window closed`);
        await sleep(2000);
        await trustC;
        await page.bringToFront().catch(() => {});
      }
    });

    /* For a link to another agent's conversation, the test helper registers a source with Agent Plus as "claude-code":
       it lists one conversation machine-wide, none in this window, and records what Agent Plus asks it
       to reveal. Removed again at the end, so the steps after this one see Codex alone. */
    await step('a link to another agent\'s conversation', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const elsewhere = path.join(path.dirname(profile.folder), 'claude-code-elsewhere');
      const Z = { sessionId: 'feedf00d-2222-4333-8444-555555555555', title: 'Tune the cache of the pricing service', cwd: elsewhere,
        state: 'idle', activity: 'stopped', running: false, unseen: false, lastActiveAt: Date.now() - 180000 };
      const reg = await call(`const ap = vscode.extensions.getExtension('xnervwang.agent-plus').exports.agentPlus;
        const changed = new vscode.EventEmitter();
        const st = globalThis.__cxpOtherAgent = { list: arg, revealed: [], changed };
        const r = ap.registerSource({ protocol: 1, id: 'claude-code', label: 'Claude Code', onDidChangeConversations: changed.event,
          listConversations: async () => [], listAllConversations: async () => st.list.map((c) => Object.assign({}, c)),
          reveal: async (sessionId, row) => { st.revealed.push({ sessionId, title: row && row.title, cwd: row && row.cwd }); return true; } });
        st.registration = r.registration;
        changed.fire();
        return { accepted: r.accepted, code: r.code, reason: r.reason, features: ap.features };`, [Z]);
      check(!!reg && reg.accepted && (reg.features || []).includes('allConversations'),
        'a source standing for Claude Code registers with Agent Plus from the test helper, and Agent Plus offers every agent\'s conversations', reg);
      try {
        const want = `claude-code:${Z.sessionId}`;
        await replyNaming(`That is 「${Z.title}」 in Claude Code, thread ${Z.sessionId}.`);
        const drawn = await until(async () => { await toBottom(); const l = await mentionLinks(want); return Array.isArray(l) && l.length >= 2 && l; }, 45000, 500);
        check(!!drawn && drawn.includes(Z.title) && drawn.includes(Z.sessionId), 'the reply\'s 「title」 and id of the other agent\'s conversation are each drawn as a link to it',
          drawn || await mentionLinks(want));
        const link = codex.locator(`[data-codex-extras="convo-link"][data-agent-plus-mention="${want}"]`).filter({ hasText: Z.title }).first();
        await link.hover();
        const tip = await until(() => codex.evaluate(() => { const b = document.querySelector('[data-codex-extras="label"]'); return b && b.textContent; }).catch(() => ''), 5000, 200);
        check(!!tip && tip.startsWith(`${Z.title}\nClaude Code conversation ${Z.sessionId.slice(0, 8)}`), 'hovering it names that agent, Claude Code', tip);
        const tabsHere = (await tabsIn(profile.folder)).length;
        await link.click();
        const revealed = await until(async () => { const r = await call('return globalThis.__cxpOtherAgent.revealed;'); return r && r.length && r; }, 15000, 300);
        check(!!revealed && revealed.length === 1 && revealed[0].sessionId === Z.sessionId && revealed[0].title === Z.title && revealed[0].cwd === elsewhere,
          'a click on it goes through agentPlus.openConversation to that agent\'s own reveal, with its id, title and folder', revealed);
        check((await tabsIn(profile.folder)).length === tabsHere, 'and opens no tab here', await tabsIn(profile.folder));
        await shot('conversation-link-other-agent');
      } finally {
        model.script(null);
        await call('const st = globalThis.__cxpOtherAgent; if (st && st.registration) st.registration.dispose(); delete globalThis.__cxpOtherAgent; return true;').catch(() => {});
      }
    });

    await step('the brief', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const plans = path.join(profile.codexHome, 'plugins', 'data', 'agent-work-plan-codex-extras');
      fs.mkdirSync(plans, { recursive: true });
      const at = new Date().toISOString().replace(/\.\d+Z$/, '+00:00');
      const summary = 'Made up for the window test: the brief of this conversation.';
      fs.writeFileSync(path.join(plans, `${threads[0].id}.json`), JSON.stringify({ nodes: [{ title: 'Check the brief', state: 'doing', since: at }],
        brief: { summary, summaryAt: at, status: { doing: 'Showing the brief', progress: 'Written', next: 'none' }, statusAt: at } }));
      await exec('agentPlus.refreshWorkPlan');
      await clearToasts();
      await exec('agentPlus.showConversations');
      const row = page.locator('[id="workbench.parts.panel"] .monaco-list-row').filter({ hasText: title }).first();
      check(await row.waitFor({ state: 'visible', timeout: 30000 }).then(() => true, () => false), 'the conversation is listed in Agent Plus\'s Conversations panel');
      const stopped = await until(async () => { const r = await panelRow(title); return panelShows(r, 'stopped', null) && r; }, 15000, 500);
      check(!!stopped, 'with a blank where a dot would be, its turn over and nothing left running', await panelRow(title));
      await row.click();
      const brief = await frameWhere((want) => {
        const b = document.getElementById('brief'), t = document.getElementById('btitle');
        return !!b && b.style.display === 'flex' && !!t && t.textContent === want;
      }, 30000, title);
      const shown = brief && await brief.evaluate(() => document.getElementById('bsections').innerText);
      check(!!brief && shown.includes(summary) && /Showing the brief/.test(shown), 'clicking it shows the brief its plan holds in the Answer view', shown);
      await shot('conversation-brief');
      await openNotes();
      await row.hover();
      const arrow = row.locator('.action-label[aria-label*="Go to the Conversation"]').first();
      await arrow.click({ timeout: 10000 });
      const back = await until(async () => { const t = (await tabs()).flatMap((g) => g.tabs).find((x) => x.active); return t && bare(t.label) === title && t; }, 15000, 500);
      check(!!back, 'the arrow at the end of its row goes to the conversation\'s tab', await tabs());
      await openNotes();
      if (brief) await brief.locator('#bopen').click({ timeout: 10000 });
      const again = await until(async () => { const t = (await tabs()).flatMap((g) => g.tabs).find((x) => x.active); return t && bare(t.label) === title && t; }, 15000, 500);
      check(!!again, 'and so does the button at the top of the brief', await tabs());
    });

    /* Requirement 10: the red dot also means a question the work plan put to the user after their last message; a
       question from before that message does not count. */
    await step('a question the work plan put to the user', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const id = threads[0].id;
      await openNotes();
      const counted = await agentCount(), mark = await toastMark();
      askInPlan(id, Date.now());
      await exec('agentPlus.refreshWorkPlan');
      const red = await until(async () => { const d = await dotsOn(title); return d && d.waiting >= 6 && d; }, 20000, 500);
      check(!!red, 'a question its work plan has just put to the user turns the tab\'s dot red', await dotsOn(title));
      const l = await slRowSays(id, (r) => r.dot === 'red');
      check(!!l, 'and its row in Agent Plus\'s session list the red dot of a question asked', l || await slRow(id));
      const p = await panelSays(title, 'waiting', null);
      check(p.ok, 'and the icon of its row in Agent Plus\'s Conversations panel', p.row);
      check(!!await until(async () => (await agentCount()) > counted, 15000, 500), 'Agent Plus counts it', { before: counted, now: await agentCount() });
      if (apWaits) {
        const told = await until(() => waitsOn(id, { kind: 'planQuestion' }), 15000, 500);
        await sleep(5000);
        const said = { reported: attentionOf(id), notifications: await toastsAbout(title, mark) };
        check(!!told && !said.notifications.length,
          'it is reported to the other windows as waiting on a question in its plan, and, its tab being in this window, no notification is shown here', said);
      } else if (await focused()) check(!!await toastSaid(title, 'is waiting for you', mark), 'and says in a notification that it is waiting for you', await toastsAbout(title, mark));
      else {
        await sleep(7000);
        check(!(await toastsAbout(title, mark)).length, `the window does not have the system's focus on ${process.platform}, and no notification is shown`, await toastsAbout(title, mark));
      }
      await shot('plan-question-red');
      askInPlan(id, Date.now() - OLD_QUESTION_MS);
      await exec('agentPlus.refreshWorkPlan');
      const gone = await until(async () => { const d = await dotsOn(title); return d && d.waiting === 0 && d; }, 20000, 500);
      check(!!gone, 'a question dated days before the user\'s last message leaves the tab without the red dot', await dotsOn(title));
      const none = await slRowSays(id, (r) => r.dot === 'none');
      check(!!none, 'and its row in Agent Plus\'s session list without a dot', none || await slRow(id));
      const q = await panelSays(title, 'stopped', null);
      check(q.ok, 'and its row in Agent Plus\'s Conversations panel without one', q.row);
      check(!!await until(async () => (await agentCount()) <= counted, 15000, 500), 'and Agent Plus counts it no more', { before: counted, now: await agentCount() });
      await shot('plan-question-old');
      planFor(id, planTitle(id));
      await exec('agentPlus.refreshWorkPlan');
      await exec('notifications.clearAll');
    });

    /* Agent Plus's pen on a Work plan row: the conversation in front gets "About row 1 (title): " at the end of its message
       box (src/codex-source.js prefill, src/page/codex-extras-page.js takePrefill). */
    await step('the pen on a work plan row', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const id = threads[0].id;
      planFor(id, planTitle(id));
      await exec('agentPlus.refreshWorkPlan');
      await tabNamed(title).click();
      await until(async () => (await frontPage()) === codex, 10000, 300);
      const box = codex.locator(COMPOSER).first();
      const boxText = () => box.innerText().then((t) => t.replace(/\s+/g, ' ').trim()).catch(() => null);
      const clearBox = async () => {
        await box.click();
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await page.keyboard.press('Backspace');
      };
      await clearBox();
      const turns = model.turns();
      await exec('workbench.view.extension.agentPlus');
      const row = page.locator('#workbench\\.parts\\.sidebar .monaco-list-row').filter({ hasText: planTitle(id) }).first();
      await row.hover();
      await row.locator('.action-label[aria-label="Agent Plus: Write About This Row in Its Conversation"]').click({ timeout: 10000 });
      const want = `About row 1 (${planTitle(id)}):`;
      const got = await until(async () => { const t = await boxText(); return t === want && t; }, 15000, 300);
      check(!!got, 'the pen on its Work plan row puts "About row 1 (title):" in the conversation\'s message box', { want, have: await boxText() });
      await sleep(1500);
      check(model.turns() === turns, 'and sends nothing', { turns: model.turns(), before: turns });
      await clearBox();
      await showList();
    });

    /* A question the work plan puts while a turn still runs reaches the user only with the turn's last reply, so until
       then the conversation is not waiting for them: its tab's dot stays green, and Agent Plus does not count it, tell the
       other windows it waits, or show a notification. Once the turn ends, the dot turns red, Agent Plus
       counts it and tells the other windows that it is waiting on a question in its plan; another window shows that as a
       notice, and this window, which has the tab, shows none. */
    await step('a question the work plan put while the turn runs', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const id = threads[0].id;
      await tabNamed(title).click();
      await until(async () => (await frontPage()) === codex, 10000, 300);
      const decided = await asking();
      model.hold();
      const turns = model.turns();
      let mid = null;
      try {
        await intoComposer(codex);
        await page.keyboard.type('One more turn on the cache, please.');
        await page.keyboard.press('Enter');
        if (!await until(() => model.turns() > turns, 20000, 300)) throw new Error('the message reached no model');
        await openNotes();
        const green = await until(async () => { const d = await dotsOn(title); return d && d.working >= 6 && d.waiting === 0 && d; }, 20000, 500);
        check(!!green, 'while the turn runs, its tab carries the green dot', await dotsOn(title));
        await clearToasts();
        const counted = await agentCount(), mark = await toastMark();
        /* Asked a moment after the message, which the rollout has from the turn's start. */
        await sleep(1500);
        askInPlan(id, Date.now());
        await exec('agentPlus.refreshWorkPlan');
        /* A rise in the Conversations entry's count shows that Agent Plus has read the question. */
        const read = await until(async () => (await asking()) > decided, 20000, 500);
        await sleep(7000);
        mid = { read: !!read, dot: await dotsOn(title), row: await slRowSays(id, (r) => r.dot === 'redRing', 10000) || await slRow(id), count: [counted, await agentCount()],
          reported: attentionOf(id), notifications: await toastsAbout(title, mark) };
        check(mid.read && !!mid.dot && mid.dot.working >= 6 && mid.dot.waiting === 0 && !!mid.row && mid.row.dot === 'redRing' && mid.count[1] <= counted
          && !waitsOn(id, { kind: 'planQuestion' }) && !mid.notifications.length,
        'a question its work plan puts while the turn still runs leaves the tab\'s dot green and gives its row in Agent Plus\'s session list the red ring of a question '
          + 'asked while the turn runs, and it is not counted, not reported to the other windows as waiting, and not announced', mid);
        await shot('plan-question-mid-turn');
      } finally { model.release(); }
      const red = await until(async () => { const d = await dotsOn(title); return d && d.waiting >= 6 && d; }, 30000, 500);
      check(!!red, 'once the turn ends, the tab\'s dot turns red', await dotsOn(title));
      const redRow = await slRowSays(id, (r) => r.dot === 'red');
      check(!!redRow, 'and its row\'s red ring a red dot', redRow || await slRow(id));
      const counted = mid ? mid.count[0] : 0;
      check(!!await until(async () => (await agentCount()) > counted, 15000, 500), 'and Agent Plus counts it', { before: counted, now: await agentCount() });
      if (apWaits) {
        const told = await until(() => waitsOn(id, { kind: 'planQuestion' }), 15000, 500);
        check(!!told, 'and reports it to the other windows as waiting on a question in its plan', attentionOf(id));
      } else if (await focused()) check(!!await toastSaid(title, 'is waiting for you', 0), 'and says in a notification that it is waiting for you', await toastsAbout(title, 0));
      await shot('plan-question-turn-ended');
      planFor(id, planTitle(id));
      await exec('agentPlus.refreshWorkPlan');
      await readBack();
      await exec('notifications.clearAll');
    });

    /*
     * Codex's asynchronous question (request_user_input_async): the tool returns at once, its card stays above the
     * message box and the turn goes on. In Codex 26.1117 an answer given while the turn runs, picked on the card or typed
     * into the message box, is a user message sent into that turn, so the conversation does not wait once the turn has
     * ended; a question left unanswered does.
     */
    await step('a question answered while its turn runs', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const id = threads[0].id;
      const sessions = path.join(profile.codexHome, 'sessions');
      const rolloutRows = () => {
        try {
          const file = fs.readdirSync(sessions, { recursive: true }).map((r) => path.join(sessions, String(r))).find((f) => f.endsWith(`${id}.jsonl`));
          return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
        } catch (_) { return []; }
      };
      /* The turn of the rollout that asked `question`: whether it has ended, and the texts of the user messages between
         the question and the turn's end, where an answer given during the turn lands. */
      const turnAsking = (question) => {
        const rows = rolloutRows();
        const at = rows.findIndex((r) => r.type === 'response_item' && (r.payload || {}).type === 'function_call'
          && r.payload.name === 'request_user_input_async' && String(r.payload.arguments || '').includes(question));
        if (at < 0) return null;
        const after = rows.slice(at + 1);
        const end = after.findIndex((r) => r.type === 'event_msg' && /^(task_complete|turn_aborted)$/.test((r.payload || {}).type));
        const users = after.slice(0, end < 0 ? after.length : end).filter((r) => r.type === 'response_item' && (r.payload || {}).type === 'message'
          && r.payload.role === 'user').map((r) => (r.payload.content || []).map((c) => c.text || '').join(''));
        return { ended: end >= 0, users };
      };
      /* What a failure reports: the rollout's last rows and how many model calls the fake model has had. */
      const lastRows = () => ({ calls: model.turns(), rows: rolloutRows().slice(-10).map((r) => { const p = r.payload || {};
        return [r.type, p.type, p.role || p.name || '', (p.content || []).map((c) => c.text || '').join('').slice(0, 80)].filter(Boolean).join(' '); }) });
      const REPLY_BLOCK = '<send_user_message_question_reply>';
      const OPTIONS = ['64 MB', '128 MB'];
      const cardOf = (question) => codex.locator('[data-codex-composer-request-navigation]').filter({ hasText: question }).first();
      /* The card has a box of its own for a written answer inside the same composer, ahead of the message box. */
      const messageBox = () => codex.locator(`${COMPOSER}:not([data-codex-composer-request-navigation] *)`).first();
      const red = (d) => !!d && d.waiting >= 6;
      /* Codex's chatgpt.followUpQueueMode is "queue" by default, which keeps a message sent while a turn runs for a turn
         of its own; with "steer" it goes into the running turn. Its Ctrl+Shift+Enter, which does the same for
         one message, sent nothing in this window. */
      const followUps = (mode) => call(`await vscode.workspace.getConfiguration('chatgpt').update('followUpQueueMode', arg, vscode.ConfigurationTarget.Global); return true;`,
        mode);
      /* Agent Plus's count changes on its list pass, which runs on a source's change or every 30 s; Refresh runs one now.
         Read once three readings agree. */
      const countNow = async () => {
        await exec('agentPlus.refreshWorkPlan');
        let last = -1, same = 0;
        await until(async () => { const c = await agentCount(); same = c === last ? same + 1 : 0; last = c; return same >= 2; }, 15000, 700);
        return last;
      };
      const askCase = async ({ name, question, answer }) => {
        await tabNamed(title).click();
        await until(async () => (await frontPage()) === codex, 10000, 300);
        await clearToasts();
        if (answer === 'typed') await followUps('steer');
        model.script(id, [{ call: 'request_user_input_async', args: { questions: [{ title: question, options: OPTIONS }] } }, { reply: `Noted (${name}).` }]);
        model.hold();
        const turns = model.turns();
        await messageBox().click();
        await page.keyboard.type(`Ask me which cache size to use (${name}), and go on.`);
        await page.keyboard.press('Enter');
        if (!await until(() => model.turns() > turns, 20000, 300)) throw new Error(`${name}: the message reached no model`);
        /* The count before the question, taken while the turn runs, when Agent Plus leaves this conversation out of it. */
        const counted = await countNow();
        /* The question goes out and the model's next answer is held: once Codex has made that call, the turn waits on the
           model and is still running while the user answers. */
        model.release();
        model.hold();
        const card = cardOf(question);
        const shown = await card.waitFor({ state: 'visible', timeout: 20000 }).then(() => true, () => false);
        if (!await until(() => model.turns() >= turns + 2, 20000, 200)) throw new Error(`${name}: Codex made no model call after the question: ${JSON.stringify(lastRows())}`);
        const radios = shown ? await card.locator('button[role="radio"]').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label'))) : [];
        check(shown && OPTIONS.every((o) => radios.includes(o)), `${name}: while the turn runs, Codex's page shows the question's card above the message box, with its options`,
          { radios, page: await pageSays(codex) });
        if (shown) await planBarClear(codex, '[data-codex-composer-request-navigation]', `${name}: the question's card`);
        await shot(`question-${name.replace(/\W+/g, '-')}-card`);
        if (answer === 'card') {
          /* With a single question, picking an option is the answer and goes out a moment later; clicking Send in that moment
             takes the pick back. */
          await card.locator(`button[role="radio"][aria-label="${OPTIONS[1]}"]`).first().click({ timeout: 5000 });
          const sent = await until(() => { const t = turnAsking(question); return t && t.users.some((u) => u.includes(REPLY_BLOCK) && u.includes(OPTIONS[1])) && t; }, 15000, 500);
          check(!!sent && !sent.ended, `${name}: ${OPTIONS[1]} picked on the card goes into the running turn, as a user message holding the ${REPLY_BLOCK} block`,
            { turn: turnAsking(question), card: await card.isVisible().catch(() => false), ...lastRows() });
        } else if (answer === 'typed') {
          const typed = `Take ${OPTIONS[0]} (${name}).`;
          await messageBox().click();
          await page.keyboard.type(typed);
          await page.keyboard.press('Enter');
          const sent = await until(() => { const t = turnAsking(question); return t && t.users.some((u) => u.includes(typed) && !u.includes(REPLY_BLOCK)) && t; }, 15000, 500);
          await followUps(undefined);
          check(!!sent && !sent.ended, `${name}: with chatgpt.followUpQueueMode "steer", a message typed into the message box, the card left alone, goes into the running turn as a plain user message`,
            { turn: turnAsking(question), card: await card.isVisible().catch(() => false), ...lastRows() });
        }
        /* Behind notes.txt when the turn ends, since Agent Plus does not count the conversation in front. */
        await openNotes();
        await sleep(800);
        await hearChimes(codex);
        model.release();
        const over = await until(() => { const t = turnAsking(question); return t && t.ended && t; }, 30000, 500);
        check(!!over, `${name}: the turn ends`, { turn: turnAsking(question), ...lastRows() });
        const waits = !answer;
        /* A turn that ends with its question still open gets the question chime (src/patching.js turnEndChime). */
        const rang = await until(async () => { const h = await chimesHeard(codex); return h && h.length && h; }, 15000, 500) || await chimesHeard(codex);
        check(waits ? !!rang && rang.includes('question') : !!rang && rang.includes('done') && !rang.includes('question'),
          `${name}: the conversation's page is asked to play ${waits ? 'the question chime' : 'the finished-turn chime, not the question one'} as the turn ends`, rang);
        const lit = await until(async () => { const d = await dotsOn(title); return red(d) && d; }, waits ? 20000 : 15000, 500);
        const dots = lit || await dotsOn(title);
        if (waits) check(!!lit, `${name}: once the turn has ended, the tab's logo carries the red dot`, dots);
        else check(!lit && !!dots && dots.waiting === 0, `${name}: once the turn has ended, the tab's logo has no red dot in the 15 s after`, dots);
        await shot(`question-${name.replace(/\W+/g, '-')}-ended`);
        const l = await slRowSays(id, (r) => (waits ? r.dot === 'blue' : !['blue', 'red', 'redRing'].includes(r.dot)), 10000);
        check(!!l, `${name}: and the conversation's row in Agent Plus's session list ${waits ? 'has the blue dot of a question waiting for the user' : 'has no dot of one waiting'}`,
          l || await slRow(id));
        const p = await panelSays(title, waits ? 'dialog' : 'stopped', null);
        check(p.ok, `${name}: and its row in Agent Plus's Conversations panel ${waits ? 'a blue circle: waiting' : 'no circle: stopped, not waiting'}`, p.row);
        /* The reply landed behind another tab, so it is unread, which Agent Plus also counts. */
        if (envelopes(await labelOf(title)) && await slRowSays(id, (r) => r.unread, 10000)) {
          retried(await pick(threads[0], ['Mark as Read']), 'Mark as Read');
          await until(async () => (await labelOf(title)) === title, 15000, 500);
        }
        const settled = await countNow();
        const more = waits ? settled > counted || await until(async () => (await agentCount()) > counted, 15000, 500)
          : settled > counted || (await exec('agentPlus.refreshWorkPlan'), await until(async () => (await agentCount()) > counted, 6000, 500));
        check(waits ? !!more : !more, `${name}: and, its reply marked as read, Agent Plus ${waits ? 'counts it among the conversations that need the user' : 'does not count it'}`,
          { before: counted, settled, now: await agentCount(), label: await labelOf(title), reported: attentionOf(id) });
      };
      try {
        await askCase({ name: 'answered on the card', question: 'Which cache size, picked on the card?', answer: 'card' });
        await askCase({ name: 'answered by typing', question: 'Which cache size, answered in the message box?', answer: 'typed' });
        await askCase({ name: 'left unanswered', question: 'Which cache size, left unanswered?', answer: null });
        /* Once the turn has ended its card is gone from the page, and the user's next message answers the question. */
        model.script(null);
        await tabNamed(title).click();
        await until(async () => (await frontPage()) === codex, 10000, 300);
        await messageBox().click();
        await page.keyboard.type('Use 128 MB.');
        await page.keyboard.press('Enter');
        const answered = await until(() => {
          const rows = rolloutRows();
          const at = rows.findIndex((r) => r.type === 'response_item' && (r.payload || {}).role === 'user' && JSON.stringify(r.payload.content || []).includes('Use 128 MB.'));
          return at >= 0 && rows.slice(at).some((r) => r.type === 'event_msg' && (r.payload || {}).type === 'task_complete');
        }, 30000, 500);
        check(!!answered && !!await until(async () => { const d = await dotsOn(title); return d && !red(d) && d.working === 0 && d; }, 15000, 500),
          'left unanswered: the user\'s next message, once its turn has ended, takes the red dot away', { answered: !!answered, dots: await dotsOn(title), ...lastRows() });
        const off = await slRowSays(id, (r) => !['blue', 'red', 'redRing'].includes(r.dot));
        check(!!off, 'and its dot from its row in Agent Plus\'s session list', off || await slRow(id));
      } finally {
        model.script(null);
        model.release();
        await followUps(undefined).catch(() => {});
        await exec('notifications.clearAll');
      }
    });

    /*
     * The model's blocking question, request_user_input. Codex offers that tool in Plan mode, which its /plan command
     * turns on. It asks this window with item/tool/requestUserInput with isBlocking set and runs no countdown on it, so
     * it waits for the user (src/approvals.js). Asked with the tab behind a text file, the question gives the tab the
     * red dot and the list row the blue waiting dot, makes the page play the question chime and is counted by Agent
     * Plus. Answering it on its card clears the dots, and the turn continues to its reply.
     */
    await step('a blocking question from the model', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const id = threads[0].id;
      const QUESTION = 'Which cache size should the sync use, asked in Plan mode?';
      const OPTIONS = ['64 MB', '128 MB'];
      const card = () => codex.locator('[data-codex-composer-request-navigation]').filter({ hasText: QUESTION }).first();
      const box = () => codex.locator(`${COMPOSER}:not([data-codex-composer-request-navigation] *)`).first();
      const placeholder = () => codex.evaluate(() => { const p = document.querySelector('[data-codex-composer-root] [data-placeholder]'); return p ? p.getAttribute('data-placeholder') : ''; }).catch(() => '');
      const owed = () => call(`${OWN} return own('patching').approvalsOf(arg);`, id).catch((e) => String(e));
      const red = (d) => !!d && d.waiting >= 6;
      /* Codex's /plan offers "Turn plan mode on" or "Turn plan mode off", whichever applies. */
      const planMode = async (on) => {
        await box().click();
        await page.keyboard.type('/plan');
        const item = codex.locator('[role="option"]').filter({ hasText: on ? /Turn plan mode on/ : /Turn plan mode off/ }).first();
        const shown = await item.waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false);
        if (shown) await item.click();
        else for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
        return shown;
      };
      await tabNamed(title).click();
      await until(async () => (await frontPage()) === codex, 10000, 300);
      await exec('notifications.clearAll');
      const planOn = await planMode(true);
      const said = await until(async () => { const p = await placeholder(); return /plan/i.test(p) && p; }, 5000, 300);
      check(planOn && !!said, 'Codex\'s /plan turns Plan mode on in the conversation\'s message box', { offered: planOn, placeholder: await placeholder() });
      if (!planOn) return;
      try {
        const counted = await agentCount();
        model.script(id, [{ call: 'request_user_input', args: { questions: [{ id: 'cache_size', header: 'Cache', question: QUESTION,
          options: OPTIONS.map((label, i) => ({ label, description: i ? 'Larger' : 'Smaller' })) }] } }, { reply: 'Noted the cache size.' }]);
        model.hold();
        const turns = model.turns();
        await box().click();
        await page.keyboard.type('Ask me which cache size to use, and wait for the answer.');
        await page.keyboard.press('Enter');
        check(!!await until(() => model.turns() > turns, 20000, 300), 'a message sent in Plan mode reaches the made-up model', model.seen.slice(-3));
        await openNotes();
        await sleep(800);
        await hearChimes(codex);
        model.release();
        const lit = await until(async () => { const d = await dotsOn(title); return red(d) && d; }, 30000, 500);
        check(!!lit, 'with the tab behind a text file, the model\'s blocking question gives the tab\'s logo the red dot', await dotsOn(title));
        const waits = await until(async () => { const o = await owed(); return o && o.decide === 1 && o; }, 10000, 500);
        check(!!waits, 'Codex Plus takes it as an answer the user owes: Codex runs no countdown on a blocking question', await owed());
        const rang = await until(async () => { const h = await chimesHeard(codex); return h && h.includes('question') && h; }, 15000, 500);
        check(!!rang, 'the conversation\'s page is asked to play the question chime', await chimesHeard(codex));
        const l = await slRowSays(id, (r) => r.dot === 'blue');
        check(!!l, 'its row in Agent Plus\'s session list carries the blue dot of a question waiting for the user', l || await slRow(id));
        check(!!await until(async () => (await agentCount()) > counted, 15000, 500), 'Agent Plus counts it in the status bar', { before: counted, now: await agentCount() });
        const p = await panelSays(title, 'dialog', null);
        check(p.ok, 'and its row in Agent Plus\'s Conversations panel a blue circle', p.row);
        await shot('blocking-question-waiting');
        await tabNamed(title).click();
        await until(async () => (await frontPage()) === codex, 10000, 300);
        await clearToasts();
        const shown = await card().waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false);
        check(shown, 'in the tab, Codex\'s page shows the question\'s card above the message box', await pageSays(codex));
        if (shown) {
          await planBarClear(codex, '[data-codex-composer-request-navigation]', 'the blocking question\'s card');
          await card().locator(`button[role="radio"][aria-label="${OPTIONS[1]}"]`).first().click({ timeout: 5000 });
          const off = await until(async () => { const d = await dotsOn(title); return d && d.waiting === 0 && model.left() === 0 && d; }, 30000, 500);
          check(!!off, `answered on its card with ${OPTIONS[1]}, the red dot leaves the tab and the turn goes on to its reply`, { dots: await dotsOn(title), left: model.left(), owed: await owed() });
          check(((await owed()) || {}).decide === 0, 'and Codex Plus no longer counts an answer owed', await owed());
          const l = await slRowSays(id, (r) => !['blue', 'red', 'redRing'].includes(r.dot));
          check(!!l, 'and the blue dot leaves its row in Agent Plus\'s session list', l || await slRow(id));
          await shot('blocking-question-answered');
        }
      } finally {
        model.script(null);
        model.release();
        await tabNamed(title).click().catch(() => {});
        if (!await planMode(false).catch(() => false)) note('Plan mode could not be turned off again with /plan after the blocking question');
      }
    });

    /* Agent Plus's allConversations, which extensions that link to conversations use, has every conversation of every
       source, the Codex ones through listAllConversations: also one in a folder this window does not open
       (lib/fake-home.js ELSEWHERE), which the session list does not show. */
    await step('a conversation in another folder, in Agent Plus\'s list of every conversation', async () => {
      const other = fakeHome.ELSEWHERE;
      const got = await call(`const ap = vscode.extensions.getExtension('xnervwang.agent-plus');
        const api = ap && ap.exports && ap.exports.agentPlus;
        if (!api || !(api.features || []).includes('allConversations')) return { none: true };
        const listening = api.onDidChangeAllConversations(() => {});
        try {
          for (let i = 0; i < 80; i++) {
            const c = api.allConversations().find((x) => x.sourceId === 'codex' && x.sessionId === arg);
            if (c) return { found: Object.assign({}, c) };
            await new Promise((r) => setTimeout(r, 500));
          }
          return { found: null, codex: api.allConversations().filter((x) => x.sourceId === 'codex').map((x) => [x.sessionId, x.title, x.cwd]) };
        } finally { listening.dispose(); }`, other.id, 90000);
      if (got.none) { note('this Agent Plus has no list of every conversation (its feature allConversations), so the one in another folder was not looked for'); return; }
      const f = got.found;
      check(!!f && f.title === other.title && path.basename(f.cwd || '') === 'elsewhere' && f.label === 'Codex' && Number(f.lastActiveAt) > 0,
        'Agent Plus\'s list of every conversation has the Codex conversation in a folder this window does not open, with its title, folder and last activity', got);
    });

    /* Opening a conversation, setting its goal and unarchiving it each write to the conversation without a reply, and
       Codex Plus gives Agent Plus the end of its latest turn (lastReplyAt), so that this does not pass for a turn that
       ran between two reads. The conversation in another folder ended two days ago. Marked unread, archived and
       unarchived in Codex, it has a newer last activity and a reply not seen, and is not announced as finished. */
    await step('a conversation unarchived with a reply not seen', async () => {
      const other = fakeHome.ELSEWHERE;
      const reported = () => attentionOf(other.id);
      const shelved = () => { try { return fs.readdirSync(path.join(profile.codexHome, 'archived_sessions'), { recursive: true }).some((n) => String(n).includes(other.id)); } catch (_) { return false; } };
      const inCodex = (method) => call(`${OWN} return own('patching').hostRequest(${JSON.stringify(method)}, { threadId: arg });`, other.id).catch((e) => ({ outcome: 'failed', reason: String(e) }));
      await exec('notifications.clearAll');
      await exec('codexPlus.markThreadUnread', other.id);
      await sleep(5000);
      check(!reported().length, 'a conversation whose turn ended two days ago, marked unread, is not among the conversations Agent Plus\'s windows report', reported());
      const archived = await inCodex('thread/archive');
      check(!!await until(shelved, 20000, 500), 'archived, its rollout moves to archived_sessions/', { archived, shelved: shelved() });
      await sleep(4000);
      const mark = await toastMark();
      await inCodex('thread/unarchive');
      const back = await until(() => !shelved() && reported().some((x) => x.activity === 'stopped'), 30000, 500);
      check(!!back, 'unarchived, it is running again by its last activity: Agent Plus\'s windows report it, stopped with a reply not seen', reported());
      /* Past Agent Plus's stable period and a batch. */
      await sleep(12000);
      const said = await toastsAbout(other.title, mark);
      if (await focused()) {
        check(!said.some((x) => x.includes(`"${other.title}" finished`)), 'and Agent Plus does not announce it as finished, as no turn of it ran', said);
      } else note(`the window does not have the system's focus on ${process.platform}, where Agent Plus shows no notification, so the unarchived conversation was not checked for one`);
      await exec('notifications.clearAll');
    });

    await step('a conversation in Codex\'s sidebar', async () => {
      const t = threads[1];
      /* With a text file in front, the sidebar is the only Codex page the user can be looking at. */
      await openNotes();
      /* Open in Sidebar in Agent Plus's session list runs codexPlus.openThreadInSidebar. With the patch it
         navigates the sidebar itself; without it, it opens a vscode:// link, and VS Code asks once before an extension
         opens one. */
      await call('vscode.commands.executeCommand("codexPlus.openThreadInSidebar", arg); return true;', t.id);
      const allow = page.locator('.monaco-dialog-box').filter({ hasText: 'open this URI' }).first();
      if (await allow.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)) {
        await allow.locator('.dialog-buttons .monaco-button').filter({ hasText: 'Open' }).first().click({ timeout: 5000 });
      }
      /* Codex draws a conversation's turns as they come into view. In a short sidebar, as on Windows with Codex's setup
         banner above the message box, it does not draw all of them, even after the conversation is scrolled to its top
         and back to its end, so the check looks for a stamp on each turn it drew, and for at least two such turns. */
      const shownSide = await frameWhere((want) => innerWidth < 800 && document.body.innerText.includes(want)
        && document.querySelectorAll('.codex-extras-stamp-assistant').length >= 1, 90000, t.title);
      if (shownSide) {
        for (const up of [true, false]) {
          await shownSide.evaluate((u) => { const sc = document.querySelector('[data-app-action-timeline-scroll]'); if (sc) sc.scrollTop = u ? 0 : sc.scrollHeight; }, up).catch(() => {});
          await sleep(1500);
        }
      }
      const side = shownSide && await until(() => shownSide.evaluate(() => {
        const turns = document.querySelectorAll('[data-turn-key]').length;
        return turns >= 2 && document.querySelectorAll('.codex-extras-stamp-assistant').length >= turns;
      }).catch(() => false), 30000, 500) ? shownSide : null;
      /* Details for a failed check: each page narrower than 800 px that has a message box, with its size, how many
         turns and reply stamps it has, and whether it names the conversation. */
      const narrowPages = async () => {
        const out = [];
        for (const f of page.frames()) {
          const x = await f.evaluate((want) => (innerWidth < 800 && document.querySelector('[data-codex-composer-root]')
            ? { width: innerWidth, height: innerHeight, turns: document.querySelectorAll('[data-turn-key]').length,
              stamps: document.querySelectorAll('.codex-extras-stamp-assistant').length, names: document.body.innerText.includes(want) } : null), t.title).catch(() => null);
          if (x) out.push(x);
        }
        return out;
      };
      check(!!side, 'Open in Sidebar draws the conversation in Codex\'s sidebar, with a stamp on each reply', side ? undefined : await narrowPages());
      if (!side) { await exec('workbench.action.closeAuxiliaryBar'); return; }
      await shot('sidebar-conversation');
      const fit = await side.evaluate(() => [...document.querySelectorAll('.codex-extras-stamp-assistant')].filter((e) => e.getClientRects().length).map((e) => {
        const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect(), st = getComputedStyle(e);
        return { width: Math.round(r.width), column: Math.round(p.width), past: e.scrollWidth - e.clientWidth, over: Math.round(r.right - p.right),
          lines: Math.round(r.height / (parseFloat(st.fontSize) * 1.4)) };
      }));
      check(fit.length >= 2 && fit.every((x) => x.past <= 0 && x.over <= 1), 'in Codex\'s sidebar every reply\'s stamp stays inside its column', fit);
      if (fit.length && !fit.some((x) => x.lines >= 2)) note('Codex\'s sidebar was wide enough for every stamp, so none had to wrap');

      const how = 'with Codex\'s sidebar showing the conversation and a text file in front';
      check(!!await until(() => agentFront() === `codex ${t.id}`, 15000, 500), `${how}, Agent Plus has that conversation in front`, agentFront());
      await checkCurrent(t.id, how);
      const listed = await until(async () => { const r = await hereRows(); return r && r.includes(t.id) && r; }, 15000, 500);
      check(!!listed, `${how}, its row in Agent Plus's session list has the stripe of a conversation open in this window`, await hereRows());
      await planShown(t.id, how);
      /* Codex's sidebar showing the conversation counts as looking at it, so a reply landing there with the window
         focused is not unread, and Agent Plus neither announces nor counts it. */
      const unseenRow = async () => { const r = await slRow(t.id); return r ? r.unread : null; };
      if (await focused()) {
        const counted0 = await agentCount(), mark0 = await toastMark();
        const replies = () => side.evaluate((r) => document.body.innerText.split(r).length - 1, REPLY).catch(() => 0);
        const had = await replies();
        model.hold();
        const turns0 = model.turns();
        await intoComposer(side);
        await page.keyboard.type('Check the import once more.');
        await page.keyboard.press('Enter');
        check(!!await until(() => model.turns() > turns0, 20000, 300), 'a message sent from Codex\'s sidebar reaches the made-up model', model.seen.slice(-3));
        await openNotes();
        await sleep(800);
        model.release();
        const landed = await until(async () => (await replies()) > had, 30000, 500);
        await sleep(8000);
        const after = { landed: !!landed, sidebar: await auxiliaryShowsCodex(), unseen: (await showList()) ? await unseenRow() : null,
          counted: [counted0, await agentCount()], notifications: await toastsAbout(t.title, mark0) };
        check(after.landed && after.sidebar && after.unseen === false && after.counted[1] <= counted0 && !after.notifications.length,
          'with Codex\'s sidebar left open on it and a text file in front, its reply is not marked unread, not announced and not counted', after);
        await shot('sidebar-open-replied');
      } else note(`the window does not have the system's focus on ${process.platform}, where nothing counts as being looked at, so the open sidebar was not checked`);
      /* A reply that lands while the sidebar is closed is unread until the sidebar is opened on it again. */
      const unseen = unseenRow;
      model.hold();
      const turns = model.turns();
      await intoComposer(side);
      await page.keyboard.type('Check the export once more.');
      await page.keyboard.press('Enter');
      check(!!await until(() => model.turns() > turns, 20000, 300), 'a message sent from Codex\'s sidebar reaches the made-up model', model.seen.slice(-3));
      const counted = await agentCount();
      await exec('workbench.action.closeAuxiliaryBar');
      await sleep(800);
      model.release();
      const marked = await until(async () => (await showList()) && (await unseen()), 30000, 1000);
      check(!!marked, 'once its reply lands with the sidebar closed, its row in Agent Plus\'s session list carries the unread mark', { row: await slRow(t.id) });
      await sleep(3000);
      check((await agentCount()) <= counted, 'and Agent Plus does not count it in the status bar', { before: counted, now: await agentCount() });
      await shot('sidebar-closed-unread');
      await exec('chatgpt.openSidebar');
      const read = await until(async () => (await showList()) && (await unseen()) === false, 30000, 1000);
      const sideNow = await frameWhere(() => innerWidth < 800 && !!document.querySelector('[data-codex-composer-root]'), 10000);
      check(!!read, 'opening Codex\'s sidebar on it again takes the unread mark away', { row: await slRow(t.id), sidebar: await auxiliaryShowsCodex(),
        sidebarPage: await pageSays(sideNow), patch: await call(`${OWN} const p = own('patching'); return { showing: p.sidebarShowing(), last: p.sidebarThread() };`).catch((e) => String(e)) });
      /* This extension's controls by the message box, in Codex's sidebar narrowed until its toolbar row has no room for
         them: they stay inside the box, in a line of their own below Codex's row, as Claude Code's footer wraps its
         buttons onto another line. With the sidebar wide enough they go back into that row. Either way each is within
         Codex's footer grid and covers none of Codex's buttons. */
      {
        const box = await frameWhere((want) => innerWidth < 800 && document.body.innerText.includes(want) && !!document.querySelector('[data-codex-composer-root]'), 30000, t.title);
        const auxWidth = () => page.evaluate(() => { const b = document.getElementById('workbench.parts.auxiliarybar'); return b ? Math.round(b.getBoundingClientRect().width) : 0; });
        const auxTo = async (to) => {
          const edge = await page.evaluate(() => {
            const b = document.getElementById('workbench.parts.auxiliarybar').getBoundingClientRect();
            const e = [...document.querySelectorAll('.monaco-sash.vertical')].map((x) => x.getBoundingClientRect()).find((r) => r.height > 100 && Math.abs((r.left + r.right) / 2 - b.left) < 4);
            return e && { x: (e.left + e.right) / 2, y: b.top + b.height / 2, width: b.width };
          });
          if (!edge) return;
          await page.mouse.move(edge.x, edge.y);
          await page.mouse.down();
          await page.mouse.move(edge.x + (edge.width - to), edge.y, { steps: 10 });
          await page.mouse.up();
          await sleep(1000);
        };
        const placed = () => box.evaluate(() => {
          const root = document.querySelector('[data-codex-composer-root]');
          if (!root) return null;
          const rect = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
          const anchor = root.querySelector('[data-composer-navigation-target="permissions"]') || root.querySelector('[data-composer-navigation-target="add-context"]');
          let grid = null;
          for (let n = anchor && anchor.parentElement; n && n !== root && !grid; n = n.parentElement) if (getComputedStyle(n).display === 'grid') grid = n;
          const ours = [...document.querySelectorAll('[data-codex-extras="bar-button"], [data-codex-extras="meter"], [data-codex-extras="agents"]')]
            .filter((e) => e.getClientRects().length && e.getBoundingClientRect().width > 0);
          const theirs = [...root.querySelectorAll('button')].filter((b) => !b.closest('[data-codex-extras]') && b.getBoundingClientRect().width > 0);
          const g = grid && rect(grid);
          const inside = (x) => !!g && x.l >= g.l - 0.5 && x.r <= g.r + 0.5 && x.t >= g.t - 0.5 && x.b <= g.b + 0.5;
          const meets = (x, y) => x.l < y.r - 0.5 && y.l < x.r - 0.5 && x.t < y.b - 0.5 && y.t < x.b - 0.5;
          return { page: innerWidth, grid: !!grid,
            place: document.querySelector('[data-codex-extras="bar"]') ? 'below the box' : document.querySelector('[data-codex-extras="line"]') ? 'line'
              : ours.length && ours.every((e) => grid && grid.contains(e)) ? 'row' : 'none',
            controls: ours.map((e) => ({ what: e.getAttribute('data-codex-extras'), inside: inside(rect(e)),
              covers: theirs.filter((b) => meets(rect(e), rect(b))).map((b) => b.getAttribute('aria-label') || b.textContent.trim().slice(0, 20)) })) };
        }).catch((e) => ({ error: String(e) }));
        const fine = (x) => !!x && x.grid && x.controls.length >= 2 && x.controls.every((c) => c.inside && !c.covers.length);
        if (!box) check(false, 'Codex\'s sidebar still shows the conversation for its message box to be checked', await narrowPages());
        else {
          const was = await auxWidth();
          await auxTo(300);
          const tight = await until(async () => { const x = await placed(); return x && x.place === 'line' && fine(x) && x; }, 15000, 500) || await placed();
          check(!!tight && tight.place === 'line' && fine(tight), 'in Codex\'s sidebar dragged to 300 px, whose toolbar row has no room for this extension\'s controls, '
            + 'they are in a line of their own inside the message box, each inside the box and covering none of Codex\'s buttons, and none is below the box', tight);
          await shot('sidebar-narrow-box');
          await auxTo(460);
          const roomy = await until(async () => { const x = await placed(); return x && x.place === 'row' && fine(x) && x; }, 15000, 500) || await placed();
          check(!!roomy && (roomy.place === 'row' || roomy.place === 'line') && fine(roomy), 'with the sidebar widened again, they are inside the box too, covering none of Codex\'s buttons', roomy);
          if (roomy && roomy.place === 'line') note(`at a ${roomy.page} px sidebar Codex's toolbar row still had no room for this extension's controls on ${process.platform}, so they stayed in their own line`);
          if (was) await auxTo(was);
        }
      }
      /* In Codex's narrow sidebar the plan bar is the compact one, and a click on it shows the plan of the conversation
         in the sidebar in the Work plan view, though the tab in front shows another. Last in this step: a sidebar page
         that has shown the conversation once draws fewer of its turns when it shows it again, and the checks above must
         not see that. */
      {
        const { since, asked, writeRows, barIn, barSays, noBar, placed, planViewRows } = planBarTools;
        const SIDE_ROWS = [{ title: 'Look at the export logs', state: 'doing', since },
          { title: 'Choose what to log', state: 'waiting', waitingOn: 'user', question: 'Log every skipped row, or a count?', asked, since: asked },
          { title: 'Fix the archive filter', state: 'todo', since }];
        writeRows(t.id, SIDE_ROWS);
        const sidePage = await frameWhere((want) => innerWidth < 800 && document.body.innerText.includes(want) && !!document.querySelector('[data-codex-composer-root]'), 30000, t.title);
        if (!sidePage) check(false, 'Codex\'s sidebar still shows the conversation for its plan bar to be checked', await narrowPages());
        else {
          const SIDE = 'doing 1,todo 1';
          let narrow = await barSays(sidePage, (b) => b.bubbles === SIDE, 30000);
          if (narrow && !narrow.compact) {
            /* The sidebar is wider than the compact width. */
            const edge = await page.evaluate(() => {
              const b = document.getElementById('workbench.parts.auxiliarybar').getBoundingClientRect();
              const e = [...document.querySelectorAll('.monaco-sash.vertical')].map((x) => x.getBoundingClientRect()).find((r) => r.height > 100 && Math.abs((r.left + r.right) / 2 - b.left) < 4);
              return e && { x: (e.left + e.right) / 2, y: b.top + b.height / 2, width: b.width };
            });
            if (edge) {
              await page.mouse.move(edge.x, edge.y);
              await page.mouse.down();
              await page.mouse.move(edge.x + Math.max(0, edge.width - 340), edge.y, { steps: 10 });
              await page.mouse.up();
              await sleep(800);
            }
            narrow = await barSays(sidePage, (b) => b.compact, 10000) || await barIn(sidePage);
          }
          check(!!narrow && narrow.compact && narrow.bubbles === SIDE && narrow.red === '1' && !narrow.name && placed(narrow),
            'in Codex\'s sidebar, narrower than 400 px, the bar is compact: no Plan, the bubbles, and only the number of questions, as wide as the box and just above it',
            narrow || await barIn(sidePage));
          /* The compact bar takes the same room as the full one. */
          fs.rmSync(path.join(PLANS, `${t.id}.json`), { force: true });
          if (await noBar(sidePage)) {
            await railToEnd(sidePage, false, 'in Codex\'s sidebar with its plan gone');
            writeRows(t.id, SIDE_ROWS);
            if (await barSays(sidePage, (b) => b.compact && b.bubbles === SIDE, 20000)) await endInView(sidePage, 'in Codex\'s sidebar with the compact bar drawn again');
            else check(false, 'in Codex\'s sidebar the plan written again draws the compact bar again', await barIn(sidePage));
          } else check(false, 'in Codex\'s sidebar the plan taken away takes the compact bar away', await barIn(sidePage));
          await shot('plan-bar-sidebar');
          await tabNamed(title).click();
          await until(async () => (await frontPage()) === codex, 10000, 300);
          await showList();
          /* The compact bar has no Plan; its list icon is the bar's first part. */
          await sidePage.locator('[data-codex-extras="plan-bar"] > .apb-icon').first().click({ timeout: 10000 });
          const theirs = await until(async () => { const r = await planViewRows(); return r && r.some((x) => x.includes('Look at the export logs')) && r; }, 15000, 500);
          check(!!theirs && !theirs.some((x) => x.includes(planTitle(threads[0].id))),
            'a click on the sidebar\'s bar shows that conversation\'s plan in the Work plan view, not the plan of the tab in front', theirs || await planViewRows());
          await showList();
          await openNotes();
        }
        planFor(t.id, planTitle(t.id));
        await exec('agentPlus.refreshWorkPlan');
      }
      await exec('workbench.action.closeAuxiliaryBar');
    });

    /*
     * Codex's sidebar opened on one conversation while the tab of another stays in front. Agent Plus's conversation in
     * front and its work plan view follow the same one: whichever came to the front last, the sidebar or the active tab
     * (src/codex-source.js onDidFocus and isFocused). Claude Code Plus does the same; there both follow Claude Code's
     * activeSessionId. Closing the sidebar while it was in front gives both back to the tab. Agent Plus's session list
     * draws the conversation of the active tab as current while there is one (its lookNow asks isFocused only when no
     * tab is in front), so the step checks the list's current row only where the tab, not the sidebar, came to the front
     * last.
     */
    await step('Codex\'s sidebar and a Codex tab both open', async () => {
      if (!codex) throw new Error('the conversation did not open in a tab');
      const t = threads[0], s1 = threads[1];
      const same = async (id, how, { row = true } = {}) => {
        check(!!await until(() => agentFront() === `codex ${id}`, 15000, 500), `${how}, Agent Plus has that conversation in front`, { want: id, agentPlus: agentFront() });
        if (row) await checkCurrent(id, how);
        else note(`${how}, Agent Plus's session list draws as current: ${JSON.stringify(await currentRows())}`);
        await checkPlan(planTitle(id), how);
      };
      /* Agent Plus logs the conversation in front only when a tab change or a focus report moves it, not when it reads
         the plans again after they changed (its refreshPlans), so the plans are written well before the first click. */
      for (const id of [t.id, s1.id]) planFor(id, planTitle(id));
      await exec('agentPlus.refreshWorkPlan');
      await sleep(3000);
      await openNotes();
      await sleep(800);
      await tabNamed(title).click();
      await same(t.id, 'with the tab of a conversation in front and Codex\'s sidebar closed');
      await call('vscode.commands.executeCommand("codexPlus.openThreadInSidebar", arg); return true;', s1.id);
      const allow = page.locator('.monaco-dialog-box').filter({ hasText: 'open this URI' }).first();
      if (await allow.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)) {
        await allow.locator('.dialog-buttons .monaco-button').filter({ hasText: 'Open' }).first().click({ timeout: 5000 });
      }
      const side = await frameWhere((want) => innerWidth < 800 && document.body.innerText.includes(want) && !!document.querySelector('[data-codex-composer-root]'), 90000, s1.title);
      check(!!side, 'Open in Sidebar on another conversation draws it in Codex\'s sidebar');
      if (!side) { await exec('workbench.action.closeAuxiliaryBar'); return; }
      const tabStill = await frontTab();
      check(!!tabStill && bare(tabStill.label) === bare(title), 'and the tab stays the active one', tabStill);
      await same(s1.id, 'with Codex\'s sidebar opened on another conversation and that tab still in front', { row: false });
      await shot('sidebar-and-tab');
      await exec('workbench.action.closeAuxiliaryBar');
      await same(t.id, 'with Codex\'s sidebar closed again, the tab still in front');
      await exec('chatgpt.openSidebar');
      const back = await frameWhere((want) => innerWidth < 800 && document.body.innerText.includes(want) && !!document.querySelector('[data-codex-composer-root]'), 30000, s1.title);
      if (back) await same(s1.id, 'with Codex\'s sidebar shown again on its conversation', { row: false });
      else note('Codex\'s sidebar, shown again, did not draw its conversation within 30 s, so that case was not checked');
      await openNotes();
      await tabNamed(title).click();
      await same(t.id, 'with a click on the tab after a text file, the sidebar still open');
      await exec('workbench.action.closeAuxiliaryBar');
    });

    /*
     * A Codex page in an editor tab opens another conversation picked in its Recent chats in an editor tab of its own:
     * the page sends navigate-in-new-editor-tab, and Codex's host runs vscode.open on that conversation's URI, which
     * does not go through Codex Plus's codexGroup. Codex's sidebar page has no route of its own (Codex gives
     * initial-route only to an editor panel's page), so there the same click shows the conversation in the sidebar
     * itself. The new tab is titled by the conversation, Agent Plus has it in front and its session list draws its row
     * as current.
     */
    await step('a conversation opened in a new tab from Codex\'s Recent chats', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const t = threads[1];
      const mine = (x) => x.route === `/local/${t.id}`;
      for (const x of (await codexTabsNow()).filter(mine)) {
        await page.locator('.tabs-container .tab').filter({ hasText: bare(x.label) }).first().click();
        await exec('workbench.action.closeActiveEditor');
      }
      await exec('workbench.action.closeAuxiliaryBar');
      await tabNamed(title).click();
      await until(async () => (await frontPage()) === codex, 10000, 300);
      const columns = (await tabs()).length;
      await codex.locator('button[aria-label^="Recent chats"]').first().click({ timeout: 10000 });
      const menu = codex.locator('[role="menu"]').filter({ hasText: /Search recent chats/ }).first();
      if (!await menu.waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false)) throw new Error('Codex\'s Recent chats did not open');
      const entry = menu.getByText(t.title.slice(0, 30)).first();
      if (!await entry.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) {
        note(`Codex's Recent chats does not list "${t.title}", so opening it from there was not tried`);
        await page.keyboard.press('Escape');
        return;
      }
      await entry.click();
      const opened = await until(async () => { const x = (await codexTabsNow()).find((y) => y.active); return x && mine(x) && x; }, 20000, 500);
      check(!!opened, 'a click on another conversation in Codex\'s Recent chats, in a conversation\'s tab, opens it in an editor tab of its own, in front',
        { want: t.id, tabs: await codexTabsNow() });
      if (!opened) return;
      const now = await tabs();
      if (now.length !== columns) note(`Codex opened that tab with vscode.open, which made ${now.length} editor groups of ${columns}`);
      const titled = await until(async () => { const x = (await codexTabsNow()).find(mine); return x && bare(x.label) === bare(t.title) && x; }, 20000, 500);
      check(!!titled, 'that tab is titled by the conversation', (await codexTabsNow()).find(mine));
      check((await codexTabsNow()).filter(mine).length === 1, 'and it is the only tab on that conversation', await codexTabsNow());
      const how = 'with the tab Codex\'s Recent chats opened in front';
      check(!!await until(() => agentFront() === `codex ${t.id}`, 15000, 500), `${how}, Agent Plus has that conversation in front`, { want: t.id, agentPlus: agentFront() });
      await checkCurrent(t.id, how);
      await shot('recent-chats-tab');
      const f = await until(async () => { const x = await frontPage(); const st = await pageSays(x); return st && st.text.includes(t.title.slice(0, 30)) && x; }, 30000, 1000);
      if (!f) {
        const broke = await brokenInFront();
        const why = `that tab's page draws the conversation${broke ? `: Codex put "${broke}" in it instead` : ''}`;
        /* As for the first message's page above: Codex failing to load its own conversation page has been seen on macOS
           and Windows only, where it is noted; on Linux it would be a failure to look into. */
        if (broke && process.platform !== 'linux') note(`${why}; not checked on ${process.platform}`);
        else check(false, why, await pageSays(await frontPage()));
        return;
      }
      const turns = model.turns();
      await intoComposer(f);
      await page.keyboard.type('One more check from this tab.');
      await page.keyboard.press('Enter');
      check(!!await until(() => model.turns() > turns, 20000, 300), 'a message sent from that tab reaches the made-up model', model.seen.slice(-3));
      await until(() => model.turns() > turns && !model.left(), 20000, 500);
      await sleep(3000);
      const after = (await codexTabsNow()).find(mine);
      check(!!after && bare(after.label) === bare(t.title), 'after a message sent from it, the tab is still titled by the conversation', after);
      await checkCurrent(t.id, `${how}, after a message sent from it`);
      await exec('workbench.action.closeActiveEditor');
    });

    await step('the token mode', async () => {
      /* The hooks read their settings from a file under CODEX_HOME on every message, so a mode chosen in the status bar
         has to be in that file at once. */
      const file = path.join(profile.codexHome, 'plugins', 'data', 'agent-work-plan-codex-extras', 'config.json');
      const hooks = () => { try { const h = JSON.parse(fs.readFileSync(file, 'utf8')); return [h.enabled, h.tellTimeZone, h.brief]; } catch (_) { return null; } };
      const before = hooks();
      check(JSON.stringify(before) === '[true,true,true]', 'with no mode chosen, which is All features, the hooks are given every feature', before);
      await exec('notifications.clearAll');
      const entry = page.locator('.statusbar-item').filter({ has: page.locator('.codicon-dashboard') }).first();
      check(await entry.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false), 'Agent Plus shows the token mode in the status bar');
      const text = (await entry.innerText().catch(() => '')).trim();
      check(text === 'All', 'by its short name', text);
      const tip = await hoverText(entry);
      check(/^Token mode: All features/.test(tip) && /costs no tokens/.test(tip), 'and its hover says what the mode adds to the context', tip);
      await entry.click();
      const list = page.locator('.quick-input-widget .quick-input-list .monaco-list-row');
      check(await list.first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false), 'clicking it opens the list of modes');
      const rows = await list.allInnerTexts();
      check(rows.length === 4 && /Essential features/.test(rows[1] || '') && /the work plan and time-zone note, plus notes for reply images or a steward/.test(rows[1] || ''),
        'four modes, each with a line under its name saying what it runs', rows);
      await shot('token-mode-list');
      await list.filter({ hasText: 'Essential features' }).first().click();
      const after = await until(() => { const h = hooks(); return h && h[2] === false && h; }, 15000, 250);
      check(JSON.stringify(after) === '[true,true,false]',
        'choosing Essential features rewrites the hooks\' settings at once: the work plan and the time zone on, the brief off', after);
      const shown = await until(async () => { const t = (await entry.innerText().catch(() => '')).trim(); return t === 'Essential' && t; }, 10000, 250);
      check(shown === 'Essential', 'and the entry shows the new mode', shown);
      await shot('token-mode-essential');
      await call('await vscode.workspace.getConfiguration("agentPlus").update("tokenMode", undefined, vscode.ConfigurationTarget.Global); return true;');
    });

    await step('how long Codex\'s pages took to open', async () => {
      const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).flatMap((n) => (n.isDirectory() ? walk(path.join(d, n.name)) : [path.join(d, n.name)])); } catch (_) { return []; } };
      const said = () => walk(path.join(profile.user, 'logs')).filter((f) => /Codex Plus\.log$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
      await exec('codexPlus.showOpenTimes');
      const line = await until(() => (said().match(/Opening a Codex page[^\n]*/g) || []).pop(), 10000, 300);
      check(!!line && /\(\d+ found/.test(line), 'Show How Long Opening a Codex Page Took finds in Codex\'s own log the start of the pages this window opened', line);
    });

    /* Runs after every step that types into the conversation, since this step archives it in Codex, through Codex's
       app-server as Codex's own Archive does. */
    await step('a conversation archived while its tab is open', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const t = threads[0];
      const shelvedOnDisk = () => { try { return fs.readdirSync(path.join(profile.codexHome, 'archived_sessions'), { recursive: true }).some((n) => String(n).includes(t.id)); } catch (_) { return false; } };
      const drawn = (composer) => until(() => codex.evaluate((want) => document.querySelectorAll('[data-turn-key]').length > 0
        && !!document.querySelector('[data-codex-composer-root]') === want, composer).catch(() => false), 30000, 500);
      await page.locator('.tabs-container .tab').filter({ hasText: title }).first().click();
      const archived = await call(`${OWN} return own('patching').hostRequest('thread/archive', { threadId: arg });`, t.id).catch((e) => ({ outcome: 'failed', reason: String(e) }));
      check(!!await until(shelvedOnDisk, 30000, 500), 'archived in Codex, the conversation open in the tab has its rollout moved to archived_sessions/', archived);
      const unrecognised = noAnchors().length;
      check(!!await drawn(false), 'the tab still shows the conversation\'s turns, read-only, with no message box');
      await shot('archived-while-open');
      /* The page script reports a missing message box only once the miss has lasted 5 s. */
      await sleep(8000);
      const archivedSays = { warned: await codex.evaluate(() => !!document.querySelector('[data-codex-extras="warn"]')).catch(() => null), logged: noAnchors().slice(unrecognised) };
      check(archivedSays.warned === false && !archivedSays.logged.length, 'and that page is not taken for one whose message box Codex Plus no longer finds: no "!" on it and no such line in Codex Plus\'s log', archivedSays);
      /* A click on its row in Agent Plus's list asks the source to bring forward the tab it is open in (reveal), which
         unarchives it in Codex first and opens it again in that tab. */
      if (await showList()) await slRowOf(t).click().catch(() => {});
      else await exec('codexPlus.openThreadInTab', t.id);
      check(!!await until(() => !shelvedOnDisk(), 30000, 500), 'a click on its row in Agent Plus\'s session list, which brings its tab forward, unarchives it in Codex first');
      check(!!await drawn(true), 'and the tab has its message box again');
      /* The list runs Open in Tab for a conversation not open here. On one Codex archived long ago, it unarchives the
         conversation first and opens it in a new tab with its message box. */
      const shelf = ARCHIVED[1];
      const shelved = () => { try { return fs.readdirSync(path.join(profile.codexHome, 'archived_sessions'), { recursive: true }).some((n) => String(n).includes(shelf.id)); } catch (_) { return false; } };
      if (!shelved()) { note(`"${shelf.title}" is no longer in archived_sessions/, so Open in Tab on a conversation Codex archived was not tried`); return; }
      await exec('codexPlus.openThreadInTab', shelf.id);
      check(!!await until(() => !shelved(), 30000, 500), 'Open in Tab on a conversation Codex archived, not open in this window, unarchives it');
      const writable = await until(async () => { const f = await frontPage(); const said = f && await pageSays(f); return !!said && said.text.includes(shelf.title.slice(0, 20))
        && await f.evaluate(() => document.querySelectorAll('[data-turn-key]').length > 0).catch(() => false) && f; }, 30000, 500);
      check(!!writable, 'and its new tab shows its turns with a message box');
      await call(`const mine = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((x) => x.input && x.input.uri && String(x.input.uri).includes(arg));
        if (mine.length) await vscode.window.tabGroups.close(mine); return mine.length;`, shelf.id).catch(() => 0);
    });

    let begun = null;
    await step('a conversation begun in a tab the tab bar button opened', async () => {
      const inFocus = await focused();
      await panelTrace();
      await exec('notifications.clearAll');
      const fresh = await newTabPage();
      check(!!fresh, 'the tab bar button opens a new conversation page in a tab');
      if (!fresh) return;
      const counted = await agentCount();
      const text = 'Draft the release notes for 1.2.';
      const box = await emptyBox(fresh);
      check(!box.left, 'its message box is empty before the first message is typed', box);
      if (box.had) note(`the new page opened with ${JSON.stringify(box.had.slice(0, 80))} in its message box, the draft Codex keeps for every new conversation page`);
      model.hold();
      const turns = model.turns();
      await settle('the tab bar button\'s new page: before its first message', 0);
      await intoComposer(fresh);
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
      check(!!await until(() => model.turns() > turns, 20000, 300), 'its first message reaches the made-up model', model.seen.slice(-3));
      const id = await until(() => rolloutWith(text), 20000, 500);
      const named = await until(async () => { const t = await frontTab(); return t && t.label !== 'Codex' && t.label.startsWith(text.slice(0, 20)) && t; }, 30000, 500);
      check(!!named, 'while that turn runs, the tab is titled by the conversation Codex made of the message', { thread: id, tab: await frontTab(), patch: await panelTrace() });
      const front = await until(() => agentFront() === `codex ${id}`, 15000, 500);
      check(!!id && !!front, 'and Agent Plus has that conversation in front', { thread: id, agentPlus: agentFront(), patch: await panelTrace() });
      const mark = await toastMark();
      model.release();
      const ended = await until(() => fresh.evaluate((r) => document.body.innerText.includes(r), REPLY).catch(() => false), 30000, 500);
      await sleep(8000);
      const after = { ended: !!ended, counted: await agentCount(), notifications: await toastsAbout(named ? bare(named.label) : text, mark) };
      if (inFocus) {
        check(after.ended && after.counted <= counted && !after.notifications.length,
          'when its reply lands with the tab in front of the focused window, Agent Plus neither announces nor counts it', { before: counted, ...after });
      } else {
        check(after.ended && !after.notifications.length, `without the system's focus on ${process.platform}, its reply in front is not announced`, { before: counted, ...after });
        await exec('notifications.clearAll');
      }
      await shot('tab-bar-conversation');
      if (id) await checkCurrent(id, 'with that tab in front');
      if (id) await planShown(id, 'with that tab in front');
      if (id && named) begun = { id, label: named.label, text };
    });

    await step('a conversation\'s tab brought back to the front', async () => {
      const t = threads[0];
      const toFront = async (label, want, from) => {
        await page.locator('.tabs-container .tab').filter({ hasText: label }).first().click();
        const ok = await until(() => agentFront() === want, 15000, 500);
        check(!!ok, `a click on the tab of a conversation whose URI names it, from ${from}, puts that conversation in front for Agent Plus`,
          { want, agentPlus: agentFront(), tab: await frontTab(), patch: await panelTrace() });
        await checkCurrent(want.replace(/^codex /, ''), `the click from ${from}`);
        await checkPlan(planTitle(want.replace(/^codex /, '')), `the click from ${from}`);
      };
      for (const id of [t.id, begun && begun.id].filter(Boolean)) planFor(id, planTitle(id));
      await exec('agentPlus.refreshWorkPlan');
      await openNotes();
      await checkCurrent('', 'with a text file in front and Codex\'s sidebar closed');
      const empty = await newTabPage();
      if (!empty) throw new Error('the tab bar button opened no new conversation page');
      check(!!await until(() => agentFront() === 'codex (no session yet)', 15000, 500), 'a new tab nothing was typed into has no conversation in front for Agent Plus', agentFront());
      await checkCurrent('', 'with a new tab nothing was typed into in front');
      const blankPlan = await until(async () => { const r = await planRows(); return !r.some((x) => x.includes('Work plan of ')) && r; }, 15000, 500);
      check(!!blankPlan, 'with a new tab nothing was typed into in front: the Work plan view shows no conversation\'s plan', await planRows());
      await toFront(title, `codex ${t.id}`, 'a new tab nothing was typed into');
      if (!begun) { note('no conversation was begun in a tab the tab bar button opened, so the switch from one was not checked'); return; }
      await page.locator('.tabs-container .tab').filter({ hasText: begun.label }).first().click();
      check(!!await until(() => agentFront() === `codex ${begun.id}`, 15000, 500), 'the tab of the conversation begun in a new tab puts it in front', agentFront());
      await checkCurrent(begun.id, 'the click on the tab of the conversation begun in a new tab');
      await checkPlan(planTitle(begun.id), 'the click on the tab of the conversation begun in a new tab');
      await toFront(title, `codex ${t.id}`, 'the tab of a conversation begun in a new tab');
    });

    /*
     * Types a first message into `f`, the page of a tab just opened for a new conversation, and checks what the tab
     * bar button's step checks: the tab takes the conversation's title during its turn, Agent Plus has it in front,
     * its reply in front is neither announced nor counted, and Agent Plus's session list gives its row the stripe of a
     * conversation open here and draws it as current. Resolves to { id, label, text } of the conversation, or null.
     */
    const firstMessage = async (f, text, how) => {
      /* The first message makes the page the conversation's page, which loads more of Codex's code; with VS Code still
         serving what other pages asked for, that code does not come and Codex draws its recovery page instead. */
      await settle(`${how}: before its first message`, 0);
      await exec('notifications.clearAll');
      const counted = await agentCount();
      model.hold();
      const turns = model.turns();
      const box = await emptyBox(f);
      check(!box.left, `${how}: its message box is empty before the first message is typed`, box);
      if (box.had) note(`${how}: the page opened with ${JSON.stringify(box.had.slice(0, 80))} in its message box, the draft Codex keeps for every new conversation page`);
      /* Typing into the message box itself, since keys sent to the window have landed in another tab's box on Windows. */
      await intoComposer(f);
      await f.locator(COMPOSER).first().pressSequentially(text);
      await f.locator(COMPOSER).first().press('Enter');
      check(!!await until(() => model.turns() > turns, 20000, 300), `${how}: its first message reaches the made-up model`, model.seen.slice(-3));
      const id = await until(() => rolloutWith(text), 20000, 500);
      const named = await until(async () => { const t = await frontTab(); return t && bare(t.label).startsWith(text.slice(0, 20)) && t; }, 30000, 500);
      /* A page that fails to load Codex's code as it turns into the conversation's page is built again in place by Codex
         Plus (src/broken-pages.js), and the turn goes on in the new page of the same tab. */
      if (named && await f.evaluate(() => /hit a snag/i.test(document.body.innerText)).catch(() => true)) {
        const g = await until(async () => { const v = await frontPage(); return v && v !== f && v; }, 30000, 500);
        if (g) { note(`${how}: Codex's page failed after the first message, and the conversation went on in the page Codex Plus built again`); f = g; }
      }
      /* The recovery page can be in the page Codex Plus built again rather than in `f`, which is gone by then, so the
         page in front is looked at too. */
      if (!named && (await f.evaluate(() => /hit a snag/i.test(document.body.innerText)).catch(() => false)
        || await brokenInFront() === 'ChatGPT hit a snag')) {
        model.release();
        const why = `${how}: Codex's own page failed after the first message ("ChatGPT hit a snag"), so there was no conversation page to follow`;
        /* Codex's recovery page, drawn when one of its own modules failed to load: never seen on Linux, where it would be a
           failure to look into, and on macOS and Windows it has come from Codex now and then. */
        const fetched = await fetchesOf();
        if (process.platform === 'linux') check(false, why, { page: await pageSays(f), fetched });
        else note(`${why}; not checked on ${process.platform}; its fetches of Codex's code short of a whole 200: ${JSON.stringify(fetched)}`);
        return null;
      }
      /* When the tab is not titled, the conversation's entry in Codex's state database at that moment shows whether
         the title was there to read. */
      const inDb = named || !id ? null : await call(`${OWN} const t = (own('codex-files').listThreads() || []).find((x) => x.id === arg);
        return t ? { title: t.title, updatedMs: t.updatedMs, now: Date.now() } : 'not listed';`, id).catch((e) => String(e));
      check(!!id && !!named, `${how}: while that turn runs, the tab is titled by the conversation Codex made of the message`,
        { thread: id, tab: await frontTab(), inDb, patch: await panelTrace() });
      check(!!id && !!await until(() => agentFront() === `codex ${id}`, 15000, 500), `${how}: and Agent Plus has that conversation in front`, { thread: id, agentPlus: agentFront() });
      model.release();
      const ended = await until(() => f.evaluate((r) => document.body.innerText.includes(r), REPLY).catch(() => false), 30000, 500);
      await sleep(4000);
      /* Agent Plus counts a conversation while it is unread, which its row's unread mark shows; the total can move for
         other conversations meanwhile. */
      const after = { ended: !!ended, unread: id ? await rowUnread(id) : null, notification: await toastAbout(named ? bare(named.label) : text, 'finished'),
        bell: [counted, await agentCount()], unreadRows: await unreadTitles() };
      check(after.ended && after.unread === false && !after.notification, `${how}: its reply, landing with the tab in front, is neither announced nor left unread to count`, after);
      if (!id) return null;
      const open = await until(async () => { const r = await hereRows(); return r && r.includes(id) && r; }, 15000, 500);
      check(!!open, `${how}: its row in Agent Plus's session list has the stripe of a conversation open in this window`, { thread: id, here: await hereRows() });
      await checkCurrent(id, how);
      return named ? { id, label: named.label, text } : null;
    };
    /* Whether `id`'s row in the list carries the unread mark, once the list has the row. */
    const rowUnread = async (id) => {
      const r = await slRowSays(id, () => true);
      return r ? r.unread : null;
    };
    const unreadTitles = () => (sl ? sl.evaluate(() => [...document.querySelectorAll('.sl-section:not([data-key="closed"]) .sl-row')]
      .filter((r) => !!r.querySelector('.sl-unread')).map((r) => r.querySelector('.sl-title').textContent)).catch(() => null) : null);
    /* The page of the conversation tab a press has just opened: a message box and no turns, first looked for among the pages
       added since `before`. On macOS none was found twice in 90 s while the new tab was there and in front, so after
       10 s the page VS Code shows in front is taken as well, if it was not in front before the press (`wasFront`); a note
       says when the page taken is one that was there before the press. */
    const newPageSince = (before, wasFront = null) => {
      const from = Date.now();
      return until(async () => {
        for (const f of page.frames()) {
          if (before.has(f)) continue;
          try { if (await f.evaluate(() => !!document.querySelector('[data-codex-composer-root]') && !document.querySelector('[data-turn-key]') && innerWidth > 600)) return f; } catch (_) { /* gone */ }
        }
        if (Date.now() - from < 10000) return null;
        const v = await frontPage();
        if (!v || v === wasFront || !await v.evaluate(() => !document.querySelector('[data-turn-key]')).catch(() => false)) return null;
        if (before.has(v)) note(`the new conversation page is one that was there before the press, ${Math.round((Date.now() - from) / 1000)} s after it`);
        return v;
      }, 90000, 500);
    };
    /* `press` and the new page it opens (newPageSince). A new page Codex replaced with its recovery page, or one Codex's
       log says did not start, has no conversation for Codex Plus to open again, and is Codex's page failing rather than
       what a step checks: that is noted, its tab closed, and `press` done once more. */
    const newPageAfter = async (what, press) => {
      let before = new Set(page.frames()), wasFront = await frontPage();
      const pressed = Date.now();
      await press();
      let f = await newPageSince(before, wasFront);
      const fetched = f ? null : await fetchesOf();
      const stalled = !f && !fetched && codexStalls().some((t) => t >= pressed - 1000);
      if (fetched || stalled) {
        note(fetched ? `${what}: the new page has Codex's recovery page, so its tab was closed and that was done again; its fetches of Codex's code: ${JSON.stringify(fetched)}`
          : `${what}: Codex's log says the new page did not start within its own wait (renderer_ready_timeout), so its tab was closed and that was done again`);
        await exec('workbench.action.closeActiveEditor');
        before = new Set(page.frames());
        wasFront = await frontPage();
        await press();
        f = await newPageSince(before, wasFront);
      }
      return f;
    };

    /*
     * Codex's own New Codex Agent, the command behind its New button and the + of VS Code's Chat Sessions view. It
     * opens Codex's New route in the group of the text editor last focused, with a fragment of its own once patched
     * (src/host.js, "new conversation tabs"). Pressed twice: "New Codex Agent twice and Codex's New chat in a tab, each a
     * new conversation".
     */
    let agentNew = null;
    await step('a conversation begun in a tab New Codex Agent opened', async () => {
      await openNotes();
      const groups = (await tabs()).length;
      const f = await newPageAfter('New Codex Agent', () => exec('chatgpt.newCodexPanel'));
      check(!!f, 'New Codex Agent, run with notes.txt in front, opens a new conversation page in a tab');
      if (!f) return;
      const where = (await codexTabsNow()).find((x) => x.active);
      check(!!where && where.route === '/extension/panel/new' && /^new-[0-9a-z]+-[0-9a-z]+$/.test(where.fragment || '') && (await tabs()).length === groups,
        'on Codex\'s New route with a fragment of its own, of the shape this extension\'s New tabs carry, in a group already there',
        { tab: where, groups: [groups, (await tabs()).length] });
      if (where) note(`New Codex Agent opened its tab in editor group ${where.column}`);
      agentNew = await firstMessage(f, 'Write the migration guide for 1.2.', 'a conversation begun in a tab New Codex Agent opened');
      await shot('new-codex-agent-conversation');
    });

    /* Codex's new conversation button in its page, pressed in a tab Open in Tab opened on another conversation. Where
       it opens the new one in that same tab, the tab's URI keeps naming the other (src/patching.js nowShowing). */
    let inTabNew = null;
    await step('a conversation begun with Codex\'s new conversation button in a tab', async () => {
      const t = threads[1];
      const f = await shownOrAgain('Open in Tab for another conversation', () => exec('codexPlus.openThreadInTab', t.id),
        async () => { const x = await frontPage(); const s = await pageSays(x); return s && s.turns >= 1 && s.text.includes(t.title.slice(0, 30)) && x; });
      check(!!f, 'Open in Tab opens another conversation in a tab', { page: await pageSays(await frontPage()) });
      if (!f) return;
      await checkCurrent(t.id, 'with that tab in front');
      const button = await f.evaluate(() => {
        const all = [...document.querySelectorAll('button, [role="button"], a')].filter((b) => b.offsetParent);
        const name = (b) => (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
        const hits = all.filter((b) => /^new (chat|thread|task|conversation)$/i.test(name(b)));
        const where = (b) => { const r = b.getBoundingClientRect(); return `${b.tagName.toLowerCase()} "${name(b)}" at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
        /* The one in the page's header, nearest the top. */
        const hit = hits.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
        if (hit) hit.setAttribute('data-cxp-test', 'new-conversation');
        return { found: !!hit, label: hit ? name(hit) : '', candidates: hits.map(where), labels: [...new Set(all.map(name).filter(Boolean))].slice(0, 40) };
      });
      if (!button.found) {
        check(false, `no new conversation button was found in Codex's page by its label; its labelled buttons: ${button.labels.join(' | ')}`);
        return;
      }
      let tabsBefore = [];
      const press = async () => {
        const before = new Set(page.frames());
        tabsBefore = await codexTabsNow();
        await f.locator('[data-cxp-test="new-conversation"]').first().click();
        return before;
      };
      /* Codex 26.1117 opens the new conversation in a tab on its New URI, and an earlier build in the same tab. With a tab
         on that URI open already, it brings that one forward, whatever it shows: one editor per URI. */
      const outcome = (before) => until(async () => {
        if (await f.evaluate(() => !!document.querySelector('[data-codex-composer-root]') && !document.querySelector('[data-turn-key]')).catch(() => false)) return { f, same: true };
        for (const x of page.frames()) {
          if (before.has(x)) continue;
          try { if (await x.evaluate(() => !!document.querySelector('[data-codex-composer-root]') && !document.querySelector('[data-turn-key]') && innerWidth > 600)) return { f: x, same: false }; } catch (_) { /* gone */ }
        }
        const front = (await codexTabsNow()).find((x) => x.active);
        if (front && front.route !== `/local/${t.id}` && tabsBefore.some((y) => y.route === front.route && y.fragment === front.fragment)) return { existing: front };
        return null;
      }, 60000, 500);
      let target = await outcome(await press());
      if (target && target.existing) {
        const was = target.existing;
        note(`Codex's "${button.label}" button brought forward the tab already open on ${was.route}${was.fragment ? `#${was.fragment}` : ''}, "${was.label}", `
          + 'rather than a new conversation: Codex opens one editor per URI, and its New URI carries no fragment');
        if (agentNew && bare(was.label) === bare(agentNew.label)) {
          await checkCurrent(agentNew.id, 'with the tab Codex brought forward in front');
          /* That tab is closed to make room, so the reload step does not look for it. */
          agentNew = null;
        }
        const panels = () => call(`${OWN} return own('patching')._registry.size;`).catch(() => -1);
        const had = await panels();
        await served(); await exec('workbench.action.closeActiveEditor');
        /* Pressed again before Codex has let go of the closed tab's panel, the new tab on the same URI was seen to carry on
           the closed conversation. */
        await until(async () => (await panels()) < had, 10000, 300);
        await sleep(2000);
        await tabNamed(t.title).click();
        await until(async () => (await frontPage()) === f, 15000, 500);
        target = await outcome(await press());
      }
      check(!!target && !target.existing, `Codex's "${button.label}" button opens a new conversation page`, { page: await pageSays(f), tabs: await codexTabsNow(), target: target && target.existing });
      if (!target || target.existing) return;
      const opened = (await codexTabsNow()).find((x) => x.active);
      note(`Codex's "${button.label}" button in a tab ${target.same ? 'turned that tab into a new conversation page'
        : `opened another tab, on ${opened ? opened.route + (opened.fragment ? `#${opened.fragment}` : '') : 'a URI not found'}`}`);
      await shot('in-tab-new-conversation-clicked');
      await checkCurrent('', `with the new conversation page Codex's "${button.label}" button opened in front, nothing typed into it yet`);
      inTabNew = await firstMessage(target.f, 'Plan the cache warm-up for the release.', `a conversation begun from Codex's "${button.label}" button in a tab`);
      await shot('in-tab-new-conversation');
    });

    /*
     * Two presses of Codex's own New Codex Agent with a text file in front, then the New chat button of Codex's page in
     * a tab, which runs the same command there. Codex alone opens every one of them on one URI and so brings the tab it
     * opened before to the front; with the patch each is a tab on a New URI of its own (src/host.js, "new conversation
     * tabs"). Last, a New tab is closed and New chat pressed at once in the tab that comes to the front: on one URI the
     * new page once carried its first message on in the conversation just closed.
     */
    await step('New Codex Agent twice and Codex\'s New chat in a tab, each a new conversation', async () => {
      const NEW_URI = /^new-[0-9a-z]+-[0-9a-z]+$/;
      const sameTab = (x, y) => !!x && !!y && x.route === y.route && x.fragment === y.fragment;
      const front = async () => (await codexTabsNow()).find((x) => x.active);
      const reveal = (x) => call(`await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.from({ scheme: 'openai-codex', authority: 'route',
        path: arg.route, fragment: arg.fragment }), 'chatgpt.conversationEditor', { viewColumn: arg.column, preview: false }); return true;`, x);
      const toFront = async (x, f) => {
        await reveal(x);
        return until(async () => sameTab(await front(), x) && (await frontPage()) === f, 15000, 300);
      };
      const opened = [];
      const newTab = async (press) => {
        const had = await codexTabsNow(), groups = (await tabs()).length;
        const f = await newPageAfter('a new conversation tab', press);
        const tab = f ? await until(async () => { const x = await front(); return x && !had.some((y) => sameTab(x, y)) && x; }, 15000, 500) : null;
        if (tab) opened.push(tab);
        return { f, tab, had, groups: [groups, (await tabs()).length] };
      };
      const fresh = (r) => !!r.f && !!r.tab && r.tab.route === '/extension/panel/new' && NEW_URI.test(r.tab.fragment || '') && r.groups[0] === r.groups[1];
      const newChatButton = (f) => f.evaluate(() => {
        const name = (b) => (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
        const hit = [...document.querySelectorAll('button, [role="button"], a')].filter((b) => b.offsetParent && /^new (chat|thread|task|conversation)$/i.test(name(b)))
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
        if (!hit) return '';
        document.querySelectorAll('[data-cxp-test="new-chat"]').forEach((b) => b.removeAttribute('data-cxp-test'));
        hit.setAttribute('data-cxp-test', 'new-chat');
        return name(hit);
      }).catch(() => '');
      const pressNewChat = async (f) => {
        const label = await newChatButton(f);
        check(!!label, 'Codex\'s page in the tab has its New chat button');
        if (!label) return null;
        return newTab(() => f.locator('[data-cxp-test="new-chat"]').first().click());
      };
      const shows = (f, text) => f.evaluate((t) => document.body.innerText.includes(t), text).catch(() => false);

      await openNotes();
      const one = await newTab(() => exec('chatgpt.newCodexPanel'));
      await openNotes();
      const two = await newTab(() => exec('chatgpt.newCodexPanel'));
      check(fresh(one) && fresh(two) && one.f !== two.f && one.tab.fragment !== two.tab.fragment && two.had.length === one.had.length + 1,
        'New Codex Agent run twice with notes.txt in front opens two new conversation tabs, each on Codex\'s New route with a fragment of its own, in a group already there',
        { one: one.tab, two: two.tab, groups: [one.groups, two.groups], tabs: await codexTabsNow() });
      if (!fresh(one) || !fresh(two)) return;
      await shot('new-codex-agent-twice');
      const b = await firstMessage(two.f, 'Draft the rollback plan for 1.2.', 'the second tab New Codex Agent opened');
      check(!!await toFront(one.tab, one.f), 'the first tab New Codex Agent opened is still there, and comes to the front by its URI', { want: one.tab, tabs: await codexTabsNow() });
      const a = await firstMessage(one.f, 'Write the test plan for 1.2.', 'the first tab New Codex Agent opened');
      check(!!a && !!b && a.id !== b.id && bare(a.label) !== bare(b.label), 'the two tabs hold two different conversations, each titled by its own',
        { a, b, tabs: await codexTabsNow() });
      if (!a || !b) return;
      const listed = await until(async () => { const r = await hereRows(); return r && [a.id, b.id].every((id) => r.includes(id)) && r; }, 15000, 500);
      check(!!listed, 'Agent Plus\'s session list marks both as open in this window', { want: [a.id, b.id], here: await hereRows() });

      const c0 = await pressNewChat(one.f);
      if (!c0) return;
      check(fresh(c0) && ![one.tab, two.tab].some((x) => sameTab(x, c0.tab)),
        'New chat in the page of a tab with a conversation in it opens a new conversation tab on a New URI of its own, in the same group',
        { tab: c0.tab, groups: c0.groups, tabs: await codexTabsNow() });
      if (!fresh(c0)) return;
      await checkCurrent('', 'with the new conversation page New chat opened in front, nothing typed into it yet');
      const c = await firstMessage(c0.f, 'List the risks of the 1.2 rollout.', 'a conversation begun from New chat in a tab New Codex Agent opened');
      check(!!c && ![a.id, b.id].includes(c.id), 'and the conversation begun there is a new one', { a: a.id, b: b.id, c });
      const back = await toFront(one.tab, one.f);
      const kept = (await codexTabsNow()).find((x) => sameTab(x, one.tab));
      check(!!back && !!kept && bare(kept.label) === bare(a.label) && await shows(one.f, a.text),
        'the tab New chat was pressed in still shows its own conversation, titled by it', { kept, a, page: await pageSays(one.f) });
      check(!!await until(() => agentFront() === `codex ${a.id}`, 15000, 500), 'and in front puts that conversation in front for Agent Plus', { want: a.id, agentPlus: agentFront() });
      await checkCurrent(a.id, 'the tab New chat was pressed in, back in front');
      await shot('new-chat-in-a-tab-kept');

      if (!c) return;
      const panels = () => call(`${OWN} return own('patching')._registry.size;`).catch(() => -1);
      await toFront(two.tab, two.f);
      await toFront(c0.tab, c0.f);
      await settle('New Codex Agent twice and Codex\'s New chat in a tab: before a New tab was closed');
      const had = await panels();
      await exec('workbench.action.closeActiveEditor');
      if (!await until(async () => (await frontPage()) === two.f, 5000, 100)) await toFront(two.tab, two.f);
      const e0 = await pressNewChat(two.f);
      const left = await panels();
      note(`New chat was pressed ${left < had ? 'after' : 'before'} Codex let go of the panel of the tab just closed (${had} panels before the close, ${left} at the press)`);
      if (!e0) return;
      check(fresh(e0) && !opened.slice(0, -1).some((x) => sameTab(x, e0.tab)), 'New chat pressed right after a New tab was closed opens a new conversation tab on a New URI of its own',
        { tab: e0.tab, tabs: await codexTabsNow() });
      if (!fresh(e0)) return;
      const text = 'Write the release announcement for 1.2.';
      const e = await firstMessage(e0.f, text, 'a conversation begun from New chat right after a New tab was closed');
      const rollout = (id) => walk(path.join(profile.codexHome, 'sessions')).find((f) => f.endsWith('.jsonl') && path.basename(f).includes(id));
      const intoClosed = !!rollout(c.id) && fs.readFileSync(rollout(c.id), 'utf8').includes(`"message":${JSON.stringify(text).slice(0, -1)}`);
      check(!!e && ![a.id, b.id, c.id].includes(e.id) && !intoClosed, 'its first message starts a new conversation, not one more turn of the conversation just closed',
        { closed: c.id, e, intoClosed });
      await shot('new-chat-after-a-close');

      /* Close the tabs this step opened, so the steps after it start with the tabs they had before. */
      for (const x of opened) {
        const now = (await codexTabsNow()).find((y) => sameTab(x, y));
        if (!now) continue;
        await reveal(now).catch(() => {});
        await settle('New Codex Agent twice and Codex\'s New chat in a tab: before a tab it opened was closed', 0);
        if (sameTab(await front(), now)) await exec('workbench.action.closeActiveEditor');
      }
      const still = (await codexTabsNow()).filter((y) => opened.some((x) => sameTab(x, y)));
      check(!still.length, 'and the tabs this step opened are closed again', still);
    });

    /* The Agent map's row of a sub-agent opens the sub-agent's own conversation in a tab. */
    let subAgent = '';
    await step('a sub-agent opened in a tab from the Agent map', async () => {
      const parent = threads[0];
      await page.locator('.tabs-container .tab').filter({ hasText: title }).first().click();
      const f = await until(async () => { const x = await frontPage(); const s = await pageSays(x); return s && s.text.includes(title.slice(0, 30)) && x; }, 30000, 1000);
      if (!f) throw new Error('the tab of the conversation with the sub-agent did not come to the front');
      await f.locator('[data-codex-extras="agents"]').first().click();
      const agent = await until(() => f.evaluate(() => {
        const b = document.querySelector('[data-codex-extras="map-agent"]');
        return b && b.getAttribute('data-codex-extras-id');
      }).catch(() => null), 10000, 300);
      if (!agent) { note(`the Agent map of "${title}" lists no sub-agent, so opening one was not tried`); await page.keyboard.press('Escape'); return; }
      await f.locator('[data-codex-extras="map-agent"]').first().click();
      const opened = await until(async () => { const x = (await codexTabsNow()).find((y) => y.active); return x && x.route === `/local/${agent}` && x; }, 20000, 500);
      check(!!opened, 'a click on a sub-agent in the Agent map opens its conversation in a tab, in front', { agent, tabs: await codexTabsNow() });
      if (opened) subAgent = agent;
      check(!!await until(() => agentFront() === `codex ${agent}`, 15000, 500), 'and Agent Plus has the sub-agent in front', { agent, agentPlus: agentFront(), parent: parent.id });
      await shot('sub-agent-tab');
    });

    /*
     * The tabs VS Code restores at a reload, as after an update of the patch or a Remote SSH reconnection: the tab
     * from Open in Tab, whose URI names its conversation, and the one from the tab bar button, whose URI names none,
     * left in front. docs/tabs.md says a Codex tab is titled by its conversation.
     */
    let restored = null;
    await step('tabs restored at a reload', async () => {
      if (!begun) throw new Error('no conversation was begun in a New tab, so there is none to restore');
      const t = threads[0];
      const plans = { [t.id]: `Plan of "${title}"`, [begun.id]: 'Plan of the conversation begun in a New tab' };
      for (const [id, rowTitle] of Object.entries(plans)) planFor(id, rowTitle);
      await exec('agentPlus.refreshWorkPlan');
      await page.locator('.tabs-container .tab').filter({ hasText: begun.label }).first().click();
      await until(() => agentFront() === `codex ${begun.id}`, 15000, 500);
      const before = await codexTabsNow();
      const mine = before.find((x) => x.active);
      if (!mine || mine.route !== '/extension/panel/new') throw new Error(`the tab in front is not the New tab: ${JSON.stringify(before)}`);
      await exec('notifications.clearAll');
      await settle('tabs restored at a reload: before the reload');
      const unrecognisedBefore = noAnchors().length;
      await w.reload();
      await until(async () => { const s = await patchState(); return s && s.active; }, 60000, 1000);
      const same = (x) => x.route === mine.route && x.fragment === mine.fragment;
      check(!!await until(async () => (await codexTabsNow()).some(same), 60000, 500), 'after the reload VS Code restores the New tab, on the same URI', await codexTabsNow());
      /* Opening a tab's own URI again brings that tab to the front. */
      const revealTab = (x) => call(`await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.from({ scheme: 'openai-codex', authority: 'route',
        path: arg.route, fragment: arg.fragment }), 'chatgpt.conversationEditor', { viewColumn: arg.column, preview: false }); return true;`, x);
      /* The step "a notice for a tab restored behind another" checks that Codex shows "Codex could not start" if a
         page has not started within 30 s after VS Code restores its tab in the background; on a slow machine, the
         checks below bring the last of those tabs forward more than 30 s after the reload. So each of those tabs is
         brought forward for a moment now to build its page, as codexPlus.loadRestoredTabs does, and then the New tab
         is put back in front. */
      const later = [before.find((x) => x.route === `/local/${t.id}`),
        ...[agentNew, inTabNew].filter(Boolean).map((m) => before.find((x) => bare(x.label) === bare(m.label))),
        subAgent ? before.find((x) => x.route === `/local/${subAgent}`) : null].filter((x) => x && !same(x));
      for (const x of later) { await revealTab(x).catch(() => {}); await sleep(500); }
      if (later.length) { const back = (await codexTabsNow()).find(same); if (back) await revealTab(back).catch(() => {}); }
      /* Long enough for the extension to have reopened any conversation it took to be dropped (src/tab-memory.js). */
      await sleep(10000);
      const after = await codexTabsNow();
      const own = after.find(same);
      if (own && !own.active) await revealTab(own);
      const shownPage = await until(async () => { const f = await frontPage(); const s = await pageSays(f); return s && s.turns >= 1 && s.text.includes(begun.text) && f; }, 60000, 1000);
      /* A New tab is known by its own URI, so one Codex has put its recovery page in cannot be opened again as the same
         tab. */
      const fetchedNew = shownPage ? null : await fetchesOf();
      if (fetchedNew) {
        note(`the restored New tab has Codex's recovery page, so the rest of this step and the steps that use that tab were not run; its fetches of Codex's code short of a whole 200: ${JSON.stringify(fetchedNew)}`);
        return;
      }
      check(!!shownPage, 'the restored New tab shows its conversation again, with its message box', { tab: own, inFrontBeforeTheCheck: own && own.active, page: await pageSays(await frontPage()) });
      check(!!own && bare(own.label) === bare(begun.label), 'and is titled by that conversation, as docs/tabs.md says a Codex tab is', { tab: own, tabs: after, patch: await panelTrace() });
      const twins = after.filter((x) => bare(x.label) === bare(begun.label));
      check(twins.length === 1 && after.length === before.length, 'and no second tab is opened on that conversation: the window has the Codex tabs it had',
        { before, after });
      const both = await labelOf(title);
      check(!!both, 'the tab Open in Tab opened is back too, titled by its conversation', await tabs());
      const inFront = await until(() => agentFront() === `codex ${begun.id}`, 20000, 500);
      check(!!inFront, 'the restored New tab, in front, puts its conversation in front for Agent Plus', { want: begun.id, agentPlus: agentFront(), tab: await frontTab(), patch: await panelTrace() });
      await checkCurrent(begun.id, 'the restored New tab in front');
      const open = await until(async () => { const r = await hereRows(); return r && [t.id, begun.id].every((id) => r.includes(id)) && r; }, 20000, 500);
      check(!!open, 'Agent Plus\'s session list marks the conversations of both restored tabs as open in this window', { want: [t.id, begun.id], here: open || await hereRows() });
      await checkPlan(plans[begun.id], 'the restored New tab in front');
      await shot('restored-new-tab');

      await page.locator('.tabs-container .tab').filter({ hasText: title }).first().click();
      check(!!await until(() => agentFront() === `codex ${t.id}`, 15000, 500), 'a click on the restored tab Open in Tab opened puts its conversation in front', agentFront());
      await checkCurrent(t.id, 'the restored tab of the conversation opened from its row, in front');
      await checkPlan(plans[t.id], 'the restored tab Open in Tab opened in front');
      const back = await labelOf(bare(begun.label));
      await page.locator('.tabs-container .tab').filter({ hasText: bare(begun.label) }).first().click();
      check(!!await until(() => agentFront() === `codex ${begun.id}`, 15000, 500), 'and a click back on the restored New tab puts its conversation in front again', { agentPlus: agentFront(), label: back });
      await checkCurrent(begun.id, 'the restored New tab brought back to the front');
      await checkPlan(plans[begun.id], 'the restored New tab brought back to the front');
      if (shownPage) restored = { page: shownPage, label: bare(begun.label) };

      /* The other tabs whose URI does not name the conversation they showed, each brought to the front by its URI. */
      const others = [agentNew && { what: 'the tab New Codex Agent opened', made: agentNew },
        inTabNew && { what: 'the tab of the conversation begun from Codex\'s New chat button', made: inTabNew }].filter(Boolean);
      for (const o of others) {
        const was = before.find((x) => bare(x.label) === bare(o.made.label));
        if (!was) { check(false, `${o.what} was open before the reload`, before); continue; }
        const at = (x) => x.route === was.route && x.fragment === was.fragment;
        const now = (await codexTabsNow()).find(at);
        if (now) await revealTab(now);
        const p = await until(async () => { const f = await frontPage(); const s = await pageSays(f); return s && s.turns >= 1 && s.text.includes(o.made.text) && f; }, 60000, 1000);
        const tabsAfter = await codexTabsNow();
        const it = tabsAfter.find(at);
        check(!!p && !!it && bare(it.label) === bare(o.made.label) && tabsAfter.filter((x) => bare(x.label) === bare(o.made.label)).length === 1,
          `${o.what} is restored showing the conversation begun in it and titled by it, with no second tab on that conversation`,
          { before: was, after: it, page: await pageSays(await frontPage()), tabs: tabsAfter });
        if (p) {
          check(!!await until(() => agentFront() === `codex ${o.made.id}`, 15000, 500), `${o.what}, restored and in front, puts its conversation in front for Agent Plus`, agentFront());
          await checkCurrent(o.made.id, `${o.what}, restored, in front`);
        }
      }
      /* The step before opened a sub-agent's tab, which the reload restores too. Codex shows a sub-agent's conversation
         read-only, with no message box, and the page script must not report that as a message box it no longer
         recognises. */
      const subTab = subAgent && (await codexTabsNow()).find((x) => x.route === `/local/${subAgent}`);
      if (subTab) {
        await revealTab(subTab);
        const sub = await until(async () => {
          for (const f of page.frames()) {
            try {
              if (!await f.evaluate(() => innerWidth > 600 && document.querySelectorAll('[data-turn-key]').length > 0 && !document.querySelector('[data-codex-composer-root]'))) continue;
              const host = f.parentFrame() && await f.parentFrame().frameElement();
              if (host && await host.isVisible()) return f;
            } catch (_) { /* gone */ }
          }
          return null;
        }, 60000, 1000);
        await sleep(8000);
        const warned = sub ? await sub.evaluate(() => !!document.querySelector('[data-codex-extras="warn"]')).catch(() => null) : null;
        const logged = noAnchors().slice(unrecognisedBefore);
        check(!!sub && warned === false && !logged.length, 'the restored tab of the sub-agent, read-only with no message box, is not taken for a page whose '
          + 'message box Codex Plus no longer finds: no "!" on its page and no such line in Codex Plus\'s log since the reload', { sub: !!sub, warned, logged, tab: subTab });
        const home = (await codexTabsNow()).find(same);
        if (home) await revealTab(home);
      } else note('the step before opened no sub-agent\'s tab, so its page after the reload was not looked at');
      const final = await codexTabsNow();
      check(final.length === before.length, 'after all that the window still has the Codex tabs it had before the reload, and no more', { before, after: final });
    });

    /* A turn sent from the restored New tab, which finishes while the tab is in the background. */
    await step('a turn in a restored New tab', async () => {
      if (!restored) { note('the New tab was not restored with its conversation, so no turn was run in it'); return; }
      const label = restored.label;
      await page.locator('.tabs-container .tab').filter({ hasText: label }).first().click();
      await until(async () => (await frontPage()) === restored.page, 15000, 500);
      model.hold();
      const turns = model.turns();
      await intoComposer(restored.page);
      await page.keyboard.type('Add the upgrade notes too.');
      await page.keyboard.press('Enter');
      check(!!await until(() => model.turns() > turns, 20000, 300), 'a message sent from the restored New tab reaches the made-up model', model.seen.slice(-3));
      const working = await until(async () => { const d = await dotsOn(label); return d && d.working >= 6 && d; }, 20000, 500);
      check(!!working, 'while its turn runs the restored New tab\'s logo carries the green dot', { dots: await dotsOn(label), patch: await panelTrace() });
      await openNotes();
      await sleep(800);
      model.release();
      const unread = await until(async () => { const l = await labelOf(label); return l === `${label} ${ENVELOPE}` && l; }, 30000, 500);
      check(!!unread, 'and once the reply lands with the tab in the background, its title ends in the envelope', { label: await labelOf(label), tabs: await tabs() });
      await shot('restored-new-tab-unread');
      await page.locator('.tabs-container .tab').filter({ hasText: label }).first().click();
      check(!!await until(async () => (await labelOf(label)) === label, 20000, 500), 'and bringing it to the front takes the envelope away', await labelOf(label));
    });

    /* The newest turn drawn on the front page, by its key ('' when there is none). Codex draws only the turns near the
       bottom of a long conversation, so counting them says little. */
    const newestInFront = async () => { const f = await frontPage(); return f ? f.evaluate(() => { const all = document.querySelectorAll('[data-turn-key]');
      return all.length ? all[all.length - 1].getAttribute('data-turn-key') : ''; }).catch(() => '') : ''; };
    /* For a failure's details: the turns the page in front has drawn, by the end of their keys, and where the conversation
       is scrolled, which tells a turn not drawn from one drawn out of view. */
    const drawnInFront = async () => { const f = await frontPage(); return f ? f.evaluate(() => {
      const sc = document.querySelector('[data-app-action-timeline-scroll]');
      return { turns: [...document.querySelectorAll('[data-turn-key]')].map((e) => String(e.getAttribute('data-turn-key')).slice(-12)),
        scroll: sc ? { top: Math.round(sc.scrollTop), height: Math.round(sc.scrollHeight), view: Math.round(sc.clientHeight) } : null };
    }).catch((e) => String(e)) : null; };
    const REOPEN = process.platform === 'darwin' ? 'Meta+Shift+T' : 'Control+Shift+T';
    /* A conversation whose tab is closed comes back from Recently closed in Agent Plus's session list and with
       Ctrl+Shift+T, which belongs to the list while the list is on. One still open is brought back from its row. */
    await step('a closed conversation brought back', async () => {
      const t = threads[0];
      await tabNamed(title).click();
      /* The reload two steps up restored this tab behind others, and where the steps since took more than the 30 s Codex
         gives a page to start, Codex has put "Codex could not start" in it, which the step "a notice for a tab restored behind
         another" checks. Bringing a closed conversation back needs a tab that shows it, so this tab's conversation is opened again first. */
      if (await until(async () => (await gaveUpInFront()) || ((await frontPage()) && 'page'), 10000, 500) === true) {
        note(`the tab of "${title}", restored behind others at the reload and not shown within 30 s of it, has Codex's "Codex could not start", so it is opened again`);
        await call(`const mine = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((x) => x.input && x.input.uri && String(x.input.uri).includes(arg));
          if (mine.length) await vscode.window.tabGroups.close(mine); return mine.length;`, t.id);
        await exec('codexPlus.openThreadInTab', t.id);
      }
      const shown = await until(newestInFront, 30000, 1000);
      if (!shown) throw new Error(`the tab of "${title}" did not come to the front with its turns`);
      /* The newest turn that the rollout says has started, as the key the page gives a turn. The page just brought to the front can
         still be drawing its last turn, as one queued behind another, so what it shows first is not taken for the newest. */
      const newestStarted = (id) => {
        const rollout = walk(path.join(profile.codexHome, 'sessions')).find((f) => f.endsWith('.jsonl') && path.basename(f).includes(id));
        let latest = '';
        if (rollout) {
          for (const l of fs.readFileSync(rollout, 'utf8').split('\n')) {
            try { const r = JSON.parse(l); if (r.type === 'event_msg' && r.payload && r.payload.type === 'task_started' && r.payload.turn_id) latest = String(r.payload.turn_id); } catch (_) { /* a line being written */ }
          }
        }
        return latest ? `history-content:turn:${latest}` : '';
      };
      const had = newestStarted(t.id) || shown;
      const closedIds = () => sl.evaluate(() => [...document.querySelectorAll('.sl-section[data-key="closed"] .sl-row')]
        .map((r) => { try { return JSON.parse(r.dataset.key)[1]; } catch (_) { return r.dataset.key; } })).catch(() => null);
      const firstClosed = (id) => until(async () => { if (!await showList()) return null; const r = await closedIds(); return r && r[0] === id && r; }, 20000, 500);
      /* The reopened page shows the rollout's newest turn as of that moment, which can be one that started after the tab
         was closed: the New tab's conversation can still have one queued. */
      const cameBack = (label, id, turn, ms = 60000) => until(async () => {
        const x = await frontTab();
        return x && bare(x.label) === label && (await newestInFront()) === (newestStarted(id) || turn) && x;
      }, ms, 1000);
      const reopenKeys = async () => {
        /* The keys go to the editor area, where a user's would, rather than to the session list's page. */
        await exec('workbench.action.focusActiveEditorGroup');
        await page.keyboard.press(REOPEN);
      };
      await settle('a closed conversation brought back: before its tab was closed');
      await exec('workbench.action.closeActiveEditor');
      check(!!await firstClosed(t.id), 'closing the tab of a conversation puts it first in Recently closed', await closedIds());
      const fromClosed = async () => {
        await firstClosed(t.id);
        if (!await sl.evaluate(() => document.querySelector('.sl-section[data-key="closed"]').classList.contains('sl-open'))) {
          await sl.locator('.sl-section[data-key="closed"] .sl-head').first().click();
        }
        await slRowOf(t, 'closed').click();
      };
      check(!!await shownOrAgain('a click on it in Recently closed', fromClosed, () => cameBack(title, t.id, had, 0), 60000),
        'a click on it there opens it in a tab again, in front, titled by it and drawn down to its newest turn',
        { tab: await frontTab(), newest: await newestInFront(), had, now: newestStarted(t.id) });
      await checkCurrent(t.id, 'the conversation opened again from Recently closed');
      await shot('reopened-from-recently-closed');
      await settle('a closed conversation brought back: before the tab opened again from Recently closed was closed');
      await exec('workbench.action.closeActiveEditor');
      await firstClosed(t.id);
      check(!!await shownOrAgain(`${REOPEN} for it`, reopenKeys, () => cameBack(title, t.id, had, 0), 60000),
        `closed again, ${REOPEN} opens it again the same way`, { tab: await frontTab(), newest: await newestInFront(), had });
      await checkCurrent(t.id, `the conversation opened again with ${REOPEN}`);
      if (restored) {
        /* The New tab's URI names no conversation, so what it showed comes from its panel (src/tab-memory.js). */
        await tabNamed(restored.label).click();
        const turn = newestStarted(begun.id) || await until(newestInFront, 30000, 1000);
        await settle('a closed conversation brought back: before the New tab was closed');
        await exec('workbench.action.closeActiveEditor');
        check(!!await firstClosed(begun.id), 'closing the New tab a conversation was begun in puts that conversation first in Recently closed', await closedIds());
        if (!check(!!await shownOrAgain(`${REOPEN} for the conversation of a New tab`, reopenKeys, () => cameBack(restored.label, begun.id, turn, 0), 60000),
          `and ${REOPEN} opens that conversation again, titled by it and drawn down to its newest turn`,
          { tab: await frontTab(), newest: await newestInFront(), had: turn, drawn: await drawnInFront(), closed: await closedIds(), codexTabs: await codexTabsNow() })) {
          await shot('reopened-new-tab-not-at-its-newest-turn');
        }
        await checkCurrent(begun.id, `the conversation of a New tab opened again with ${REOPEN}`);
      }
      /* A click on the row of a conversation open here brings its tab to the front (the source's reveal). */
      if (!await showList()) return;
      const other = begun ? begun.id : null;
      if (!other) return;
      await tabNamed(title).click();
      await until(() => agentFront() === `codex ${t.id}`, 15000, 500);
      if (!await showList()) return;
      await slRowOf({ id: other }).click();
      check(!!await until(() => agentFront() === `codex ${other}`, 15000, 500), 'a click on the row of another conversation open in this window brings its tab to the front',
        { want: other, agentPlus: agentFront(), tab: await frontTab() });
      await checkCurrent(other, 'the conversation whose row was clicked');
    });

    /* A conversation that stops to ask the user something while its tab is in the background. A command asked to run
       outside the sandbox waits for approval on every platform. Codex itself shows no VS Code notification of a request
       for approval (its extension host has no notice of one, its page uses no browser notification), so there is no
       notification of Codex's for Codex Plus to suppress when Agent Plus announces waits. With this Agent Plus, one request is
       made with agentPlus.notifications.waiting off and one with it on; neither brings a notification, with the
       conversation's page hidden behind another tab or in front. */
    await step('a conversation waiting for you in the background', async () => {
      const t = threads[0];
      const inFocus = await focused();
      await tabNamed(title).click();
      const f = await until(async () => { const x = await frontPage(); const s = await pageSays(x); return s && s.turns >= 1 && s.text.includes(title.slice(0, 30)) && x; }, 30000, 1000);
      if (!f) throw new Error(`the tab of "${title}" did not come to the front`);
      await exec('notifications.clearAll');
      const counted = await agentCount();
      const outside = (cmd) => ({ call: 'exec_command', args: { cmd, yield_time_ms: 1000, sandbox_permissions: 'require_escalated',
        justification: 'Check the build outside the sandbox.' } });
      model.script(t.id, apWaits ? [outside('echo checked'), outside('true'), { reply: 'Checked.' }] : [outside('echo checked'), { reply: 'Checked.' }]);
      model.hold();
      const turns = model.turns();
      await intoComposer(f);
      await page.keyboard.type('Check the build outside the sandbox.');
      await page.keyboard.press('Enter');
      check(!!await until(() => model.turns() > turns, 20000, 300), 'a message sent from the tab reaches the made-up model', model.seen.slice(-3));
      const redDot = () => until(async () => { const d = await dotsOn(title); return d && d.waiting >= 6 && d; }, 30000, 500);
      /* Yes on the approval in the conversation's tab, once its page draws it. Agent Plus's notice can lie over the
         buttons, so the notices are cleared first. */
      const approve = async () => {
        await tabNamed(title).click();
        await clearToasts();
        const yes = await until(async () => {
          const x = await frontPage();
          const b = x && x.locator('[data-codex-approval-surface] button').filter({ hasText: /^(Yes|Allow once|Allow this time|Approve|Run)\b/ }).first();
          return b && (await b.count()) ? b : null;
        }, 15000, 500);
        if (yes) await yes.click();
        return !!yes;
      };
      if (apWaits) {
        await agentSetting('notifications.waiting', false);
        await openNotes();
        await sleep(800);
        const mark0 = await toastMark();
        model.release();
        const red0 = await redDot();
        await sleep(8000);
        const said0 = { red: !!red0, notices: await waitToasts(page, title, mark0) };
        check(!!red0 && !said0.notices.length, 'with agentPlus.notifications.waiting off, Codex stopping for approval with the tab in the background shows no '
          + 'notification: Codex has none of its own that would come back in place of Agent Plus\'s', said0);
        await agentSetting('notifications.waiting', undefined);
        const before = model.turns();
        model.hold();
        const approved = await approve();
        check(approved && !!await until(() => model.turns() > before, 20000, 300), 'approved in the tab, the command runs and the model is asked again',
          { approved, turns: [before, model.turns()] });
        await until(async () => ((await dotsOn(title)) || {}).waiting === 0, 15000, 500);
      }
      await openNotes();
      await sleep(800);
      const mark = await toastMark();
      model.release();
      const red = await redDot();
      check(!!red, 'when Codex stops to ask for the user\'s approval with the tab in the background, the tab\'s logo carries the red dot', await dotsOn(title));
      let told = '';
      if (apWaits) {
        const reported = await until(() => waitsOn(t.id, { kind: 'permission', tool: 'Bash' }), 15000, 500);
        await sleep(6000);
        const said = { reported: attentionOf(t.id), notices: await waitToasts(page, title, mark) };
        check(!!reported, 'this window tells the others it waits for the user to approve Bash, the name Codex\'s own hook gives a command', said);
        check(!said.notices.length, 'and, its tab being in this window, neither Agent Plus nor Codex shows a notification of it', said);
      } else {
        told = inFocus ? await toastSaid(title, 'is waiting for you', mark) : '';
        if (inFocus) check(!!told, 'Agent Plus says in a notification that the conversation is waiting for you', await toastsAbout(title, mark));
        else {
          await sleep(7000);
          check(!(await toastsAbout(title, mark)).length, `the window does not have the system's focus on ${process.platform}, and Agent Plus shows no notification`, await toastsAbout(title, mark));
        }
      }
      check(!!await until(async () => (await agentCount()) > counted, 10000, 500), 'and counts it in the status bar', { before: counted, now: await agentCount(), asking: await asking() });
      if (await showList()) {
        const l = await slRowSays(t.id, (r) => r.dot === 'blue', 10000);
        check(!!l, 'and its row in Agent Plus\'s session list the blue dot of a dialog waiting for the user', l || await slRow(t.id));
      }
      const p = await panelSays(title, 'dialog', null);
      check(p.ok, 'and its row in Agent Plus\'s Conversations panel a blue circle', p.row);
      await shot('waiting-in-background');
      if (apWaits) {
        const markFront = await toastMark();
        await tabNamed(title).click();
        await until(async () => { const x = await frontTab(); return x && bare(x.label) === title; }, 10000, 300);
        await sleep(5000);
        const said = { red: await dotsOn(title), notices: await waitToasts(page, title, markFront) };
        check(!said.notices.length, 'brought to the front while it waits, with Codex\'s page showing the approval, there is still no notification', said);
      } else if (told) {
        const where = await openFromToast(title);
        const front = await until(async () => { const x = await frontTab(); return x && bare(x.label) === title && x; }, 15000, 500);
        check(!!front, `the notification's Open, clicked in the ${where}, brings the conversation's tab to the front`, await frontTab());
        check(!!await until(async () => !await toastAbout(title, 'is waiting for you'), 15000, 500), 'and the notification closes', await toasts());
      } else await tabNamed(title).click();
      await approve();
      check(!!await until(async () => { const d = await dotsOn(title); return d && d.waiting === 0 && model.left() === 0 && d; }, 30000, 500),
        'approving it in the tab takes the red dot away and the turn goes on', await dotsOn(title));
      model.script(null);
    });

    /* Rename and Mark as Unread where the user reaches them: the pencil on the conversation's row in Agent Plus's
       session list, which hands the name to this extension, and the menus of its tab and of its page. */
    await step('a conversation renamed and marked unread where the user does it', async () => {
      const t = threads[0];
      const stored = () => call(`${OWN} const x = (own('codex-files').listThreads() || []).find((y) => y.id === arg); return x ? x.title : null;`, t.id).catch(() => null);
      const rowTitle = async () => { const r = await slRow(t.id); return r ? r.title : null; };
      const renamedTo = async (name, how) => {
        const ok = await until(async () => (await labelOf(name)) && (await stored()) === name && (await showList()) && (await rowTitle()) === name, 30000, 1000);
        check(!!ok, `${how}: the tab, the name saved in Codex and the row in Agent Plus's session list all take the new name`,
          { tab: await labelOf(name), stored: await stored(), row: await rowTitle() });
      };
      await tabNamed(title).click();
      await until(() => agentFront() === `codex ${t.id}`, 15000, 500);
      if (!await showList()) throw new Error('the session list did not open');
      /* The pencil on the row. */
      const second = `${title} (pencil)`;
      await slRowOf(t).hover();
      await slRowOf(t).locator('.sl-act[data-act="rename"]').first().click();
      await until(() => sl.evaluate(() => !!document.querySelector('.sl-title.sl-editing')), 5000, 200);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.type(second);
      await page.keyboard.press('Enter');
      await renamedTo(second, 'renamed with the pencil on its row in Agent Plus\'s session list');
      const tried = async (what, fn) => { try { return await fn(); } catch (e) { check(false, what, String(e.message || e).split('\n')[0]); return null; } };
      const third = `${title} (tab menu)`;
      const menuText = await tried('a right-click on the conversation\'s tab offers Rename', () => contextPick(second, 'Codex Plus: Rename'));
      const box = page.locator('.quick-input-widget input').first();
      if (menuText && await box.waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false)) {
        check(await box.inputValue() === second, 'Rename in the tab\'s menu asks for the new name, starting from the title', await box.inputValue());
        await box.fill(third);
        await box.press('Enter');
        await renamedTo(third, 'renamed from its tab\'s menu');
      } else if (menuText) check(false, 'Rename in the tab\'s menu asks for the new name', menuText);
      const named = (await labelOf(third)) ? third : second;
      for (const [how, onPage] of [['the tab\'s menu', false], ['the menu of the conversation\'s page', true]]) {
        if (!await tried(`a right-click on ${onPage ? 'the conversation\'s page' : 'the conversation\'s tab'} offers Mark as Unread`,
          () => contextPick(named, 'Codex Plus: Mark as Unread', { onPage }))) continue;
        const unread = await until(async () => { const l = await labelOf(named); return l === `${named} ${ENVELOPE}` && l; }, 15000, 500);
        check(!!unread, `Mark as Unread in ${how} puts the envelope after the tab's title, though the tab is in front`, await labelOf(named));
        await openNotes();
        await tabNamed(named).click();
        /* Codex Plus counts nothing as read while the window has no focus, so the detail records whether it had the focus. */
        check(!!await until(async () => (await labelOf(named)) === named, 20000, 500), `and going to it again after leaving it takes the envelope away (${how})`,
          { label: await labelOf(named), front: await frontTab(), focused: await focused().catch(() => null) });
      }
      /* Puts the name back for the steps after this one. On macOS the box has gone again before the name could be typed
         into it, once, so it is asked for again. */
      for (let tries = 0; tries < 3; tries++) {
        await call('vscode.commands.executeCommand(\'codexPlus.renameThread\', arg); return true;', t.id);
        const back = page.locator('.quick-input-widget input').first();
        if (!await back.waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false)) continue;
        if (await back.fill(title, { timeout: 5000 }).then(() => true, () => false)) { await back.press('Enter'); break; }
        note(`the box to rename the conversation back to "${title}" went before the name was typed into it; asked for again`);
      }
    });

    /*
     * A second window of the same VS Code on a folder of its own, holding a conversation in a tab (Claude Code Plus's
     * ui.js has the same two-window step). An approval Codex asks for during its turn in that window
     * shows in this one through the mark the plugin's PermissionRequest hook leaves. This window does not trust the plugin's hooks, so the hook
     * script is run here with the JSON Codex sends it (the input schema Codex 26.1117 embeds). Codex also asks there for
     * a real approval to run a command outside the sandbox, which is given there. Then the conversation is archived in
     * Codex in the other window and stays open there read-only; until that window closes, the daily pass would not take
     * it. It is archived there because this window's app-server refuses to archive a conversation another app-server
     * has loaded ("already has an active writer").
     */
    await step('a second window', async () => {
      if (!await showList()) throw new Error('the session list did not open');
      const T = threads[1];
      const folderB = path.join(path.dirname(profile.folder), 'ws-b');
      fs.mkdirSync(folderB, { recursive: true });
      fs.writeFileSync(path.join(folderB, 'notes-b.txt'), 'A file for the second window.\n');
      /* On Windows VS Code gives a folder with its drive letter in lower case. */
      const sameFolder = (a, b) => (process.platform === 'win32' ? path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase() : a === b);
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
      const entries = () => {
        const dir = path.join(PLANS, 'windows');
        let names = [];
        try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch (_) { return []; }
        return names.map((n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { return null; } }).filter(Boolean);
      };
      const entryOf = (folder) => entries().find((e) => Array.isArray(e.folders) && e.folders.some((f) => sameFolder(f, folder)) && alive(e.pid));
      /* Earlier steps can leave the conversation in a tab here too, and then this window would take the request itself. */
      await call(`const mine = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => (t.input && t.input.uri && String(t.input.uri).includes(arg[0]))
        || String(t.label || '').replace(/(?:\uD83D\uDCE9|\u2709)[\uFE0E\uFE0F]?/g, '').trim() === arg[1]);
        if (mine.length) await vscode.window.tabGroups.close(mine); return mine.length;`, [T.id, T.title]);
      check(!!await until(() => { const e = entryOf(profile.folder); return e && !e.sessions.includes(T.id); }, 20000, 500),
        'with the conversation in no tab here, this window\'s own entry among the windows does not list it', entryOf(profile.folder));
      /* This window's app-server can keep the conversation, and its writer lock, after the tab that showed it has closed,
         and the second window's app-server is then refused it ("already has an active writer"). So it is asked to let
         the conversation go first. */
      const loadedHere = () => call(`${OWN} const r = await own('patching').hostRequest('thread/loaded/list', {});
        return r && r.outcome === 'done' && r.result ? r.result.data : null;`).catch(() => null);
      const heldHere = await loadedHere();
      if (Array.isArray(heldHere) && heldHere.includes(T.id)) {
        await call(`${OWN} return own('patching').hostRequest('thread/unsubscribe', { threadId: arg });`, T.id).catch(() => null);
        const gone = await until(async () => { const l = await loadedHere(); return Array.isArray(l) && !l.includes(T.id); }, 30000, 1000);
        note(`this window's app-server had the conversation loaded as the step began, and ${gone ? 'let it go when asked to' : 'still had it 30 s after being asked to let it go'}`);
      }
      const before = Date.now();
      await call('await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(arg), { forceNewWindow: true }); return true;', folderB);
      const pageB = await w.pageOf(path.basename(folderB), 90000);
      if (pageB) watched.add(pageB);
      const hostB = pageB ? await w.hostUp(before, folderB).catch(() => null) : null;
      check(!!pageB && !!hostB, 'a second window of the same VS Code opens on another folder, with the test helper in it',
        { pageB: !!pageB, hosts: fs.readdirSync(profile.control).filter((n) => /^host-/.test(n)) });
      if (!pageB || !hostB) {
        /* The second window is closed, or its helper would take the requests of later steps. */
        if (pageB) await pageB.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+W' : 'Control+Shift+W').catch(() => {});
        return;
      }
      w.pin(profile.folder);
      const inB = (body, arg, ms = 60000) => call(body, arg, ms, folderB);
      const shotB = (name) => pageB.screenshot({ path: path.join(shotsDir, `${String(++shotNo).padStart(2, '0')}-${name}.png`) }).catch(() => {});
      /* The second window asks to trust the hooks too, with a dialog that takes every click in it. */
      let watchingB = true;
      const trustB = (async () => {
        while (watchingB && !pageB.isClosed()) {
          try {
            const box = pageB.locator('.monaco-dialog-box').filter({ hasText: 'Trust the work plan hooks in Codex?' }).first();
            if (await box.isVisible()) await box.locator('.dialog-buttons .monaco-button').filter({ hasText: 'Cancel' }).first().dispatchEvent('click');
          } catch (_) { /* closing */ }
          await sleep(500);
        }
      })();
      let closedB = false;
      const closeB = async () => {
        if (closedB) return;
        closedB = true;
        watchingB = false;
        await served([page, pageB]);
        await inB('setTimeout(() => vscode.commands.executeCommand("workbench.action.closeWindow"), 200); return true;', undefined, 15000).catch(() => {});
        await until(() => pageB.isClosed(), 30000, 500);
        await trustB;
      };
      const rolloutOf = (id) => [...walk(path.join(profile.codexHome, 'sessions')), ...walk(path.join(profile.codexHome, 'archived_sessions'))]
        .find((f) => f.endsWith('.jsonl') && path.basename(f).includes(id)) || '';
      /* The id of the newest turn the rollout says has started, which is what Codex gives its hooks as turn_id. */
      const turnOf = (id) => {
        const f = rolloutOf(id);
        let turn = '';
        if (f) {
          for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
            try { const r = JSON.parse(l); if (r.type === 'event_msg' && r.payload && r.payload.type === 'task_started') turn = String(r.payload.turn_id || ''); } catch (_) { /* a line being written */ }
          }
        }
        return turn;
      };
      const rowDot = async () => { const r = await slRow(T.id); return r ? r.dot : null; };
      const marks = () => { try { return fs.readdirSync(path.join(PLANS, 'waiting')).filter((n) => n.endsWith('.json')); } catch (_) { return []; } };
      const cp = require('child_process');
      const py = ['python3', 'python'].find((x) => (cp.spawnSync(x, ['-c', 'import sys; print(sys.version_info[:2] >= (3, 7))'], { encoding: 'utf8' }).stdout || '').trim() === 'True');
      const hookFile = await call('return require("path").join(vscode.extensions.getExtension("xnervwang.codex-plus").extensionPath, "codex-plugin", "agent-work-plan", "hooks", "mark-waiting.py");');
      /* The hook as Codex runs it: the event's JSON on standard input, the plugin's data folder as its argument. */
      const hook = (payload) => cp.spawnSync(py, [hookFile, PLANS], { input: JSON.stringify(payload), encoding: 'utf8' });
      const asCodex = (turn) => ({ session_id: T.id, turn_id: turn, cwd: folderB, model: 'gpt-5.5', permission_mode: 'default', transcript_path: rolloutOf(T.id) });
      /* The tab's page has its panel before the second window's app-server has loaded the conversation, which it then
         does not know; on macOS it was still not loaded half a minute after the tab opened, so it is loaded here. */
      const startTurn = async (text) => {
        let r = null, resumed = null;
        await until(async () => {
          r = await inB(`${OWN} return own('patching').hostRequest('turn/start', { threadId: arg[0], input: [{ type: 'text', text: arg[1], text_elements: [] }] });`,
            [T.id, text]).catch((e) => ({ outcome: 'failed', reason: e.message }));
          const unknown = r.outcome === 'failed' && /not found|not loaded/i.test(r.reason || '');
          if (unknown) {
            resumed = await inB(`${OWN} const x = await own('patching').hostRequest('thread/resume', { threadId: arg }); return { outcome: x.outcome, reason: x.reason || '' };`, T.id)
              .catch((e) => ({ outcome: 'failed', reason: e.message }));
          }
          return !(r.outcome === 'unavailable' || unknown);
        }, 60000, 1000);
        return resumed ? { ...r, resumed } : r;
      };
      const EXT = `const mine = vscode.extensions.getExtension('xnervwang.codex-plus');
        const file = require('path').join(mine.extensionPath, 'extension.js');
        const k = Object.keys(require.cache).find((x) => x.toLowerCase() === file.toLowerCase());
        const ext = k ? require.cache[k].exports : null;`;
      const held = () => call(`${EXT} const r = ext && await ext._holdArchived([arg]); return r ? [...r] : null;`, T.id);
      /* Puts the conversation's tab in the second window behind notes-b.txt. Agent Plus neither announces nor counts the
         conversation the focused window shows in front, and in this run the window opened last counts as focused, under
         xvfb-run and on the CI runners alike. */
      const tabOfT = () => inB('return vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => ({ column: g.viewColumn, '
        + 'uri: t.input && t.input.uri ? String(t.input.uri) : "" }))).find((t) => t.uri.includes(arg)) || null;', T.id).catch(() => null);
      const coverT = async () => {
        const t = await tabOfT();
        await inB('await vscode.window.showTextDocument(vscode.Uri.file(arg[0]), { preview: false, viewColumn: arg[1] }); return true;',
          [path.join(folderB, 'notes-b.txt'), (t && t.column) || 1]);
      };
      const toastIn = (p) => p.evaluate((want) => {
        const n = [...document.querySelectorAll('.notification-toast')].find((e) => e.innerText.includes(`"${want}" is waiting for you`));
        return n ? n.innerText : '';
      }, T.title).catch(() => '');

      /* Go to the conversation (Agent Plus's agentPlus.openConversation) is run in the second window. The window that shows
         the conversation takes the request from <shared home>/open and brings it forward, and with no such window the
         second window offers to open it there. */
      const tabsIn = (folder) => call('return vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => ({ label: t.label, '
        + 'active: t.isActive, front: t.isActive && g.isActive, uri: t.input && t.input.uri ? String(t.input.uri) : "" })));', undefined, 60000, folder).catch(() => []);
      const tabOf = async (folder, t) => (await tabsIn(folder)).find((x) => bare(x.label) === t.title || x.uri.includes(t.id)) || null;
      const toastsIn = (p) => p.evaluate(() => [...document.querySelectorAll('.notification-toast')].map((e) => e.innerText)).catch(() => []);
      const openFromB = (t) => inB('await vscode.commands.executeCommand("agentPlus.openConversation", arg); return true;',
        { sourceId: 'codex', sessionId: t.id, title: t.title, cwd: profile.folder }, 30000).catch((e) => e.message);
      const OPENS = path.join(profile.home, '.agent-work-plan', 'open');
      /* The activities every window's Agent Plus reports to the others for a conversation (<shared home>/attention). */
      const reported = (id) => {
        const dir = path.join(profile.home, '.agent-work-plan', 'attention');
        let names = [];
        try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
        return names.flatMap((n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).items || []; } catch (_) { return []; } })
          .filter((it) => it && it.sessionId === id).map((it) => it.activity);
      };
      /* Whether the rollout's newest turn has ended: a task_complete or turn_aborted after its last task_started. */
      const turnEnded = (id) => {
        const f = rolloutOf(id);
        if (!f) return false;
        let started = -1, ended = -1;
        fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
          try { const r = JSON.parse(l); const t = r.type === 'event_msg' && r.payload && r.payload.type;
            if (t === 'task_started') started = i; else if (t === 'task_complete' || t === 'turn_aborted') ended = i; } catch (_) { /* a line being written */ }
        });
        return ended > started;
      };
      /* Lists the requests another window took, with who asked, who took each and whether it was brought forward. */
      const taken = () => {
        let names = [];
        try { names = fs.readdirSync(OPENS).filter((n) => n.endsWith('.done')); } catch (_) { return []; }
        const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(OPENS, f), 'utf8')); } catch (_) { return null; } };
        return names.map((n) => { const id = n.slice(0, -5), ask = read(`${id}.taken`) || {}, done = read(n) || {};
          return { id, session: ask.sessionId, from: ask.from, by: done.by, shown: done.shown }; });
      };
      try {
        await until(() => inB('const mine = vscode.extensions.getExtension("xnervwang.codex-plus"); return !!(mine && mine.isActive);'), 60000, 1000);
        /* ── Go to the conversation when no window shows it ── */
        const said = await openFromB(T);
        const nowhere = `"${T.title}" is not open in any VS Code window on this machine.`;
        const offered = await until(async () => (await toastsIn(pageB)).find((x) => x.includes(nowhere) && x.includes('Open it here')), 20000, 500);
        check(!!offered && !await tabOf(profile.folder, T),
          'Go to the conversation in the second window, for a conversation no window shows, says so there and offers Open it here; this window opens nothing',
          { said, toasts: await toastsIn(pageB), here: await tabOf(profile.folder, T) });
        await shotB('open-nowhere-offered');
        if (offered) {
          await pageB.locator('.notification-toast').filter({ hasText: nowhere }).locator('a, .monaco-button').filter({ hasText: 'Open it here' }).first().click({ timeout: 5000 });
        } else await inB('await vscode.commands.executeCommand("codexPlus.openThreadInTab", arg); return true;', T.id);
        const inTabB = await until(() => tabOf(folderB, T), 30000, 500);
        check(!!inTabB && !await tabOf(profile.folder, T), 'Open it here opens it in a tab of the second window, and this window is left as it was',
          { b: await tabsIn(folderB), here: await tabOf(profile.folder, T) });
        const shownB = await until(() => { const e = entryOf(folderB); return e && e.sessions.includes(T.id) && e; }, 60000, 1000);
        check(!!shownB, 'the conversation opened in a tab of the second window, and that window\'s entry among the windows lists it',
          { entry: entryOf(folderB), entries: entries() });

        /* ── Go to the conversation when this window shows it in a tab ── */
        const X = threads[0];
        await exec('codexPlus.openThreadInTab', X.id);
        await until(() => tabOf(profile.folder, X), 30000, 500);
        await openNotes();
        await inB('await vscode.commands.executeCommand("notifications.clearAll"); return true;').catch(() => {});
        const before1 = taken().length;
        await openFromB(X);
        const fronted = await until(async () => { const t = await tabOf(profile.folder, X); return t && t.active && t; }, 20000, 500);
        /* As above, this window records that it took the request only once the tab is in front. */
        const took = await until(() => (taken().length > before1 && taken().filter((r) => r.session === X.id).pop()) || null, 15000, 300);
        const notOpen = (await toastsIn(pageB)).filter((x) => /is not open/.test(x));
        check(!!fronted && taken().length > before1 && !!took && !!took.by && took.by !== took.from && took.shown === true,
          'Go to the conversation in the second window, for one a tab of this window shows, is taken by this window, which brings that tab forward',
          { fronted, took, here: await tabsIn(profile.folder) });
        check(!await tabOf(folderB, X) && !notOpen.length, 'and the second window opens no copy of it and says nothing about it not being open',
          { b: await tabsIn(folderB), notOpen });
        await shot('open-elsewhere-brought-forward');

        /* ── the same, when this window shows it only in Codex's sidebar ── */
        try {
          const tab = await call('return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input && t.input.uri && String(t.input.uri).includes(arg)).length;', X.id);
          await served([page, pageB]);
          await call('const mine = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => (t.input && t.input.uri && String(t.input.uri).includes(arg[0])) '
            + '|| String(t.label || "").replace(/(?:\uD83D\uDCE9|\u2709)[\uFE0E\uFE0F]?/g, "").trim() === arg[1]); if (mine.length) await vscode.window.tabGroups.close(mine); return mine.length;', [X.id, X.title]);
          /* Through the patch rather than codexPlus.openThreadInSidebar, whose vscode:// link VS Code hands to the window
             it last saw focused: under xvfb-run that was the second window, which then asked whether to open it. */
          await call(`${OWN} return own('patching').openInSidebar(arg);`, X.id).catch(() => false);
          const inSidebar = await until(() => call(`${OWN} return own('patching').sidebarShowing() === arg;`, X.id), 30000, 500);
          if (!inSidebar) note(`Codex's sidebar in this window did not come to show the conversation on ${process.platform} (it had ${tab} tab(s) of it), so a request for one shown only there was not checked`);
          else {
            await openNotes();
            const before2 = taken().length;
            await openFromB(X);
            const took2 = await until(() => { const r = taken().slice(before2).find((x) => x.session === X.id); return r && r; }, 20000, 500);
            const stillSide = await call(`${OWN} return own('patching').sidebarShowing() === arg;`, X.id);
            check(!!took2 && took2.by !== took2.from && took2.shown === true && stillSide && !await tabOf(folderB, X) && !await tabOf(profile.folder, X),
              'for one this window shows only in Codex\'s sidebar, this window takes the request and its sidebar shows it, with no tab opened in either window',
              { took2, stillSide, b: await tabOf(folderB, X), here: await tabOf(profile.folder, X) });
            await shot('open-elsewhere-sidebar');
          }
        } catch (e) {
          check(false, 'a request for a conversation shown only in Codex\'s sidebar ran to its end', String((e && e.stack) || e).split('\n').slice(0, 3).join(' | '));
        }
        await exec('workbench.action.closeAuxiliaryBar').catch(() => {});
        const pageReady = await until(() => inB(`${OWN} return own('patching').canDeliver(arg);`, T.id), 60000, 1000);
        await until(async () => {
          for (const f of pageB.frames()) { try { if (await f.evaluate(() => document.querySelectorAll('[data-turn-key]').length > 0)) return true; } catch (_) { /* gone */ } }
          return false;
        }, 30000, 500);
        await shotB('second-window');

        /* ── an approval asked for in the second window ── */
        if (!py) note('no Python 3.7+ for the test here, so the PermissionRequest hook was not run and waiting in another window was not checked');
        else if (!pageReady) note('the second window\'s page of the conversation never connected to the patch, so no turn was started there');
        else {
          await showList();
          await exec('notifications.clearAll');
          await inB('await vscode.commands.executeCommand("notifications.clearAll"); return true;').catch(() => {});
          await coverT();
          const was = turnOf(T.id);
          model.hold();
          const started = await startTurn('Check the export from the second window.');
          const turn = await until(() => { const t = turnOf(T.id); return t && t !== was && t; }, 30000, 500);
          check(!!turn, 'a turn of the conversation started in the second window runs, held by the made-up model', { started, was, turn: turnOf(T.id) });
          const green = await until(async () => (await rowDot()) === 'green', 30000, 500);
          check(!!green, 'this window\'s session list shows it working, from its rollout', await rowDot());
          const there = await slRow(T.id);
          check(!!there && there.stripe === 'elsewhere' && there.away === 'window', 'and its row the stripe of a conversation open somewhere else, with the icon of another window before its time', there);
          const counted = await agentCount();
          /* Agent Plus is told that this window has the focus and the second one does not, since under xvfb-run both say they have it. */
          if (apWaits) { await testFocus(true); await testFocus(false, folderB); }
          const markA = (await toastLogOf(page)).now, markB = (await toastLogOf(pageB)).now, askedAt = Date.now();
          const r = hook({ ...asCodex(turn), hook_event_name: 'PermissionRequest', tool_name: 'Bash',
            tool_input: { command: 'make check', description: 'Run the checks outside the sandbox.' } });
          check(r.status === 0 && r.stdout === '' && marks().length === 1,
            'the PermissionRequest hook, run with what Codex sends it, leaves one mark and prints nothing, so the approval goes on as Codex asks it',
            { status: r.status, stdout: r.stdout, stderr: r.stderr, marks: marks() });
          const blue = await until(async () => (await rowDot()) === 'blue', 20000, 500);
          check(!!blue, 'this window\'s session list then shows the conversation the second window runs with the blue dot of a dialog waiting', await rowDot());
          /* A conversation already counted for an unread reply is still counted once when it starts waiting. */
          const countedNow = await until(async () => (await agentCount()) > counted
            || (counted > 0 && reported(T.id).includes('waiting')), 15000, 500);
          check(!!countedNow, 'and Agent Plus counts it in the status bar', { before: counted, now: await agentCount(), reported: reported(T.id) });
          /* Agent Plus shows its notification in the focused window. In this run both windows can count as focused, under
             xvfb-run and on the CI runners alike, so which window shows it, or whether only one does, tells nothing. */
          const focusA = await focused(), focusB = await inB('return vscode.window.state.focused;').catch(() => null);
          const wantNotice = `"${T.title}" is waiting for you to approve Bash.`;
          if (apWaits) {
            const shownA = await until(async () => (await toastLogOf(page)).log.find((x) => x.at >= markA && x.text.includes(wantNotice)), 20000, 300);
            await sleep(3000);
            const said = { here: await waitToasts(page, T.title, markA), second: await waitToasts(pageB, T.title, markB), reported: attentionOf(T.id) };
            const took = shownA ? ((shownA.at - askedAt) / 1000).toFixed(1) : '-';
            check(!!shownA && said.here.length === 1 && !said.second.length,
              `the window with the focus shows one notification of it, naming the tool (${took} s after the hook ran), and the second window, which shows it, none`, said);
            /* Open goes to the window that has the conversation: it takes the request from <shared home>/open and brings the
               conversation's tab forward, then itself through VS Code's command line, which moves no window under xvfb-run. */
            const before = taken().length;
            const where = shownA ? await openFromToast(T.title).catch((e) => `nowhere (${e.message})`) : '';
            const moved = shownA ? await until(async () => {
              const r = taken().slice(before).find((x) => x.session === T.id), tb = await tabOf(folderB, T);
              return r && tb && tb.active && { r, tb };
            }, 20000, 500) : null;
            check(!!moved && moved.r.by !== moved.r.from && moved.r.shown === true,
              `its Open, clicked in the ${where}, is taken by the second window, which brings the conversation's tab to the front there`,
              { moved, taken: taken().slice(before), b: await tabsIn(folderB) });
          } else if (focusA || focusB) {
            const told = await until(async () => ((await toastIn(page)) || (await toastIn(pageB))) && true, 15000, 500);
            await sleep(2000);
            const inA = !!await toastIn(page), inBNow = !!await toastIn(pageB);
            const where = { here: await toasts(), focusA, focusB, inA, inB: inBNow };
            if (focusA && focusB) {
              check(!!told, `and says in a notification that it is waiting for you (shown ${inA && inBNow ? 'in both windows' : inA ? 'in this one' : 'in the second'})`, where);
              note(`both windows count as focused on ${process.platform}, so whether the notification shows in one window only was not judged (${inA && inBNow ? 'it showed in both' : 'it showed in one'})`);
            } else {
              check(!!told && inA === !!focusA && inBNow === !!focusB, `and says in a notification that it is waiting for you, in the focused window (${focusA ? 'this one' : 'the second'}) only`, where);
            }
          } else note(`neither window has the system's focus on ${process.platform}, so Agent Plus shows no notification; not checked`);
          await shot('waiting-in-another-window');
          await shotB('second-window-waiting');
          hook({ ...asCodex(turn), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'make check' }, tool_response: 'ok' });
          const back = await until(async () => marks().length === 0 && (await rowDot()) === 'green', 20000, 500);
          check(!!back, 'once the approved command has run, PostToolUse takes the mark away and the dot here is green again', { marks: marks(), dot: await rowDot() });
          check(!!await until(async () => (await agentCount()) <= counted, 15000, 500), 'and Agent Plus no longer counts it', { before: counted, now: await agentCount() });

          /* ── a wait that begins while no window has the focus ── */
          /* Its tab in the second window is closed, so that neither window shows the conversation and either would announce
             it; its turn goes on in that window's app-server, where the made-up model holds it. */
          if (apWaits) {
            await served([page, pageB]);
            const closedT = await inB('const mine = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input && t.input.uri && String(t.input.uri).includes(arg));'
              + ' if (mine.length) await vscode.window.tabGroups.close(mine); return mine.length;', T.id).catch(() => 0);
            const gone = await until(async () => !await tabOf(folderB, T), 10000, 500);
            await sleep(3000);
            const still = (await rowDot()) === 'green';
            if (!closedT || !gone || !still) {
              note(`the conversation's tab in the second window could not be closed with its turn still running (closed ${closedT}, `
                + `gone ${!!gone}, dot ${await rowDot()}), so a wait begun while no window has the focus was not checked`);
            } else {
              await testFocus(false);
              await testFocus(false, folderB);
              await exec('notifications.clearAll');
              await inB('await vscode.commands.executeCommand("notifications.clearAll"); return true;').catch(() => {});
              const awayA = (await toastLogOf(page)).now, awayB = (await toastLogOf(pageB)).now;
              hook({ ...asCodex(turn), hook_event_name: 'PermissionRequest', tool_name: 'Bash',
                tool_input: { command: 'make lint', description: 'Run the linter outside the sandbox.' } });
              const red2 = await until(async () => (await rowDot()) === 'blue', 20000, 500);
              await sleep(8000);
              const quiet = { red: !!red2, here: await waitToasts(page, T.title, awayA), second: await waitToasts(pageB, T.title, awayB) };
              check(quiet.red && !quiet.here.length && !quiet.second.length,
                'with no window showing it and neither window having the focus, a new approval it waits for brings no notification in either window', quiet);
              await testFocus(true);
              const replayed = await until(async () => (await waitToasts(page, T.title, awayA)).find((x) => x.includes(wantNotice)), 20000, 300);
              await sleep(3000);
              check(!!replayed && (await waitToasts(page, T.title, awayA)).length === 1,
                'once this window has the focus again, it shows that notification, once, naming the tool', { here: await waitToasts(page, T.title, awayA) });
              await testFocus(false);
              await testFocus(true, folderB);
              await sleep(8000);
              const after = { second: await waitToasts(pageB, T.title, awayB), here: await waitToasts(page, T.title, awayA) };
              check(!after.second.length && after.here.length === 1, 'and the second window, getting the focus after it, shows none of it again', after);
              hook({ ...asCodex(turn), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call_2', tool_input: { command: 'make lint' }, tool_response: 'ok' });
              await until(async () => marks().length === 0 && (await rowDot()) === 'green', 20000, 500);
            }
            await testFocus(null);
            await testFocus(null, folderB);
            await exec('notifications.clearAll');
            await inB('await vscode.commands.executeCommand("notifications.clearAll"); return true;').catch(() => {});
            await inB('await vscode.commands.executeCommand("codexPlus.openThreadInTab", arg); return true;', T.id).catch(() => {});
            await until(() => tabOf(folderB, T), 30000, 500);
            await until(async () => {
              for (const f of pageB.frames()) { try { if (await f.evaluate(() => document.querySelectorAll('[data-turn-key]').length > 0)) return true; } catch (_) { /* gone */ } }
              return false;
            }, 30000, 500);
          }
          model.release();
          await until(async () => (await rowDot()) !== 'green', 30000, 500);

          {
            await exec('notifications.clearAll');
            /* The tab's page has to be in front for its approval card to be clicked. */
            await inB('await vscode.commands.executeCommand("codexPlus.openThreadInTab", arg); return true;', T.id);
            const checkCmd = process.platform === 'win32' ? 'Write-Output checked' : 'true';
            model.script(T.id, [{ call: 'exec_command', args: { cmd: checkCmd, yield_time_ms: 1000, sandbox_permissions: 'require_escalated',
              justification: 'Check the export outside the sandbox.' } }, { reply: 'Checked.' }]);
            const was2 = turnOf(T.id);
            await startTurn('Check the export outside the sandbox.');
            const askedB = await until(() => inB(`${OWN} return own('patching').approvalsOf(arg).decide;`, T.id), 30000, 500);
            const turn2 = turnOf(T.id);
            check(!!askedB && turn2 !== was2, 'the second window\'s conversation asks for approval to run a command outside the sandbox', { askedB, turn: turn2 });
            /* Until the mark is left, only the second window can name the tool: its app-server made the request. */
            if (apWaits) {
              const from = Date.now();
              const named = await until(() => waitsOn(T.id, { kind: 'permission', tool: 'Bash' }), 30000, 250);
              const took = (Date.now() - from) / 1000;
              check(!!named && took <= 10, `the second window tells the others it waits for the user to approve Bash, ${took.toFixed(1)} s after its app-server asked`,
                attentionOf(T.id));
            }
            /* Codex runs the hook just before it asks; here it runs just after, and the second window's next poll (every
               three seconds) sees the mark while the request is outstanding. */
            hook({ ...asCodex(turn2), hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: checkCmd, description: 'Check the export outside the sandbox.' } });
            check(!!await until(async () => (await rowDot()) === 'blue', 20000, 500), 'this window shows it waiting', await rowDot());
            await sleep(4000);
            /* The reply after the command is held back, keeping the turn running while the dot is read. Agent Plus's notice sits
               over the bottom right of the window, where the approval's buttons are. */
            model.hold();
            await inB('await vscode.commands.executeCommand("notifications.clearAll"); return true;').catch(() => {});
            await sleep(500);
            /* The page can take a moment to draw the card. */
            const approve = () => until(async () => {
              for (const f of pageB.frames()) {
                try {
                  const yes = f.locator('[data-codex-approval-surface] button').filter({ hasText: /^(Yes|Allow once|Allow this time|Approve|Run)\b/ }).first();
                  if (await yes.count()) { await yes.click({ timeout: 5000 }); return true; }
                } catch (_) { /* another frame */ }
              }
              return false;
            }, 20000, 500);
            let approved = !!await approve();
            /* A recovery page here means Codex's page broke, which is not what this step tests: the tab is closed and
               the conversation opened again there, and its app-server, which still has the request, puts the card in
               the new page. */
            const fetchedB = approved ? null : await fetchesOf(pageB);
            if (fetchedB) {
              note(`the second window's tab has Codex's recovery page, so it was closed and the conversation opened again there; its fetches of Codex's code short of a whole 200: ${JSON.stringify(fetchedB)}`);
              await inB(`const mine = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((x) => x.input && x.input.uri && String(x.input.uri).includes(arg));
                if (mine.length) await vscode.window.tabGroups.close(mine); return mine.length;`, T.id).catch(() => 0);
              await inB('await vscode.commands.executeCommand("codexPlus.openThreadInTab", arg); return true;', T.id);
              approved = !!await until(approve, 60000, 1000);
            }
            check(approved, 'the second window shows the approval with a button to give it', null);
            const cleared = await until(async () => marks().length === 0 && (await rowDot()) === 'green', 15000, 500);
            check(!!cleared, 'approved there, the second window takes the mark away at once, and this window shows the conversation working while its turn goes on',
              { marks: marks(), dot: await rowDot() });
            model.release();
            await until(async () => model.left() === 0 && (await rowDot()) !== 'green', 60000, 500);
            model.script(null);
          }
        }

        /* ── the daily pass while the second window shows it ── */
        /* Codex archives no running conversation, so the turn in that window must end first. */
        await until(() => turnEnded(T.id), 60000, 500);
        await until(async () => (await rowDot()) !== 'green', 30000, 500);
        const archivedOnDisk = () => !!rolloutOf(T.id) && rolloutOf(T.id).includes(`${path.sep}archived_sessions${path.sep}`);
        const inCodexB = (method) => inB(`${OWN} return own('patching').hostRequest(${JSON.stringify(method)}, { threadId: arg });`, T.id)
          .catch((e) => ({ outcome: 'failed', reason: String(e) }));
        let archivedB = null;
        for (let n = 0; n < 3 && !archivedOnDisk(); n++) {
          archivedB = await inCodexB('thread/archive');
          if (await until(archivedOnDisk, 10000, 500)) break;
        }
        check(archivedOnDisk(), 'archived in Codex in the second window, its rollout moves to archived_sessions/',
          { rollout: rolloutOf(T.id), ended: turnEnded(T.id), archived: archivedB, toastsB: await toastsIn(pageB) });
        const stillB = await until(() => { const e = entryOf(folderB); return e && e.sessions.includes(T.id); }, 15000, 500);
        check(!!stillB, 'the second window keeps it in its tab, read-only, and its entry still lists it', entryOf(folderB));
        await shotB('archived-open-in-second-window');
        const kept = await held();
        check(Array.isArray(kept) && kept.includes(T.id), 'the daily pass over archived conversations would leave it for the next pass', kept);
        await closeB();
        const gone = await until(() => !entryOf(folderB), 30000, 500);
        check(!!gone && pageB.isClosed(), 'closed, the second window leaves no entry among the windows', entries());
        /* Its app-server lets go of the conversation's writer lock as it exits, and the holders are read every 10 s or so. */
        const free = await until(async () => { const f = await held(); return Array.isArray(f) && !f.includes(T.id) && f; }, 90000, 2000);
        check(!!free, 'and the daily pass would now take it, once that window\'s Codex has let go of the conversation', free || await held());
        /* The steps after this one open the conversation again. */
        const back = await call(`${OWN} return own('patching').hostRequest('thread/unarchive', { threadId: arg });`, T.id).catch((e) => ({ outcome: 'failed', reason: String(e) }));
        check(!!await until(() => !!rolloutOf(T.id) && !archivedOnDisk(), 30000, 500),
          'unarchived in Codex here, its rollout is back under sessions/', { rollout: rolloutOf(T.id), unarchived: back, toasts: await toasts() });
      } finally {
        await testFocus(null).catch(() => {});
        await closeB();
      }
    });

    /*
     * A conversation whose tab VS Code restored behind another at a reload still gets its notice. VS Code builds a restored
     * webview tab's page only once it is shown, and notices go only to the conversations this window's app-server has
     * loaded (thread/loaded/list). The end of a detached command is recorded for the conversation behind and, to show
     * that this window sends notices at all, for the one in front. Codex gives up on a page not shown within 30 seconds
     * and puts "Codex could not start" in it, so a click after that loads nothing until the conversation is opened
     * again. With codexPlus.loadRestoredTabs on, the tab behind is shown for a moment at the start, so it gets its
     * notice before anyone clicks it, and draws when clicked later. It runs near the end, since each reload leaves behind
     * the pages the steps above hold, but before the extension host restarts for the last step: once that restart had run,
     * on Linux the conversation in front was not loaded again after the reload.
     */
    await step('a notice for a tab restored behind another', async () => {
      const pair = [threads[0], threads[1]];
      const ends = path.join(profile.codexHome, 'plugins', 'data', 'agent-work-plan-codex-extras', 'shared', 'detached-ends');
      const loadedNow = () => call(`${OWN} const r = await own('patching').hostRequest('thread/loaded/list', {});
        return r && r.outcome === 'done' && r.result ? r.result.data : r;`).catch((e) => String(e));
      const end = (t, pid) => {
        const now = Date.now();
        fs.mkdirSync(ends, { recursive: true });
        fs.writeFileSync(path.join(ends, `${t.id}.${pid}.${pid}.json`), JSON.stringify({ thread: t.id, pid, start: String(pid), startMs: now - 60e3,
          cmd: `sleep ${pid} # window test`, endMs: now }));
      };
      /* By URI, since a step above may have left a conversation renamed. */
      const tabOf = async (t) => (await codexTabsNow()).find((x) => x.route === `/local/${t.id}`);
      /* Brings `t`'s tab to the front with a click on it. While the dialog asking to trust the hooks is up, it takes the click, so the click is
         tried again. */
      const toFront = async (t) => {
        for (let i = 0; i < 3; i++) {
          await until(async () => !await trustShown(), 10000, 200);
          const x = await tabOf(t);
          if (!x) return false;
          const at = await page.evaluate((want) => [...document.querySelectorAll('.tabs-container .tab')].findIndex((e) => {
            const n = e.querySelector('.label-name');
            return String((n ? n.textContent : e.innerText) || '').replace(/(?:\uD83D\uDCE9|\u2709)[\uFE0E\uFE0F]?/g, ' ').replace(/\s+/g, ' ').trim() === want;
          }), bare(x.label));
          if (at >= 0) await page.locator('.tabs-container .tab').nth(at).click().catch(() => {});
          if (await until(async () => { const y = await tabOf(t); return y && y.active; }, 5000, 250)) return true;
        }
        return false;
      };
      const codexLog = () => {
        const logs = walk(path.join(profile.user, 'logs')).filter((f) => /Codex Plus\.log$/.test(f)).map((f) => ({ f, at: fs.statSync(f).mtimeMs }))
          .sort((a, b) => b.at - a.at);
        try { return logs.length ? fs.readFileSync(logs[0].f, 'utf8') : ''; } catch (_) { return ''; }
      };
      await exec('workbench.action.closeAuxiliaryBar');
      await exec('workbench.action.joinAllGroups');
      for (const t of [pair[1], pair[0]]) await openShown(t);
      check(await toFront(pair[0]), 'two conversations are open in tabs of one group, one in front of the other', await tabs());
      note(`before the reload, this window's app-server has loaded ${JSON.stringify(await loadedNow())}`);

      let restoredAt = 0;
      /* The pages of both tabs are new (one was opened again before the second reload), so each reload first waits
         for both to finish loading. */
      const reload = async (what) => {
        await exec('notifications.clearAll');
        await settle(`${what}: before the reload`, 2);
        await w.reload();
        restoredAt = Date.now();
        await until(async () => { const st = await patchState(); return st && st.active; }, 60000, 1000);
        check(!!await until(async () => (await tabOf(pair[0])) && (await tabOf(pair[1])), 60000, 500), `${what}: after the reload VS Code restores both tabs`, await tabs());
      };
      /* The conversations in front and behind as the window came back, which has not always been the order before; after
         all the steps above another Codex tab came back in front. When neither came back in front, the first one's
         tab is clicked while Codex still draws a page shown that late. */
      const roles = async (what) => {
        const a = await tabOf(pair[0]), b = await tabOf(pair[1]);
        let front = b && b.active ? pair[1] : pair[0];
        if (!(a && a.active) && !(b && b.active)) {
          note(`${what}: the window came back with another tab in front, so "${bare(a ? a.label : front.title)}" is clicked to the front`);
          check(await toFront(front), `${what}: clicked to the front within 30 seconds of the reload`, await tabs());
        }
        const behind = front === pair[0] ? pair[1] : pair[0];
        const loadedFront = async () => { const l = await loadedNow(); return Array.isArray(l) && l.includes(front.id) && l; };
        let up = await until(loadedFront, 90000, 1000);
        /* When the tab in front has Codex's recovery page, or its "Codex could not start" for a page that has not
           started within 30 s, Codex's page has failed and there is nothing here to check: the tab is closed and its
           conversation opened again in a tab, which then has to load it. */
        const broke = up ? '' : await brokenInFront();
        if (broke) {
          const fetched = broke === 'ChatGPT hit a snag' ? await fetchesOf() : null;
          note(`${what}: the tab in front has Codex's "${broke}", so it was closed and its conversation opened again${fetched ? `; its fetches of Codex's code: ${JSON.stringify(fetched)}` : ''}`);
          await served();
          await call(`const t = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input && x.input.uri && x.input.uri.path === arg);
            if (t) await vscode.window.tabGroups.close(t); return !!t;`, `/local/${front.id}`);
          await exec('codexPlus.openThreadInTab', front.id);
          up = await until(loadedFront, 90000, 1000);
        }
        check(!!up, `${what}: the conversation in front is loaded again`, await loadedNow());
        return { front, behind };
      };
      const pid = { front: 4141, behind: 4242 };
      await reload('codexPlus.loadRestoredTabs off');
      await sleep(Math.max(0, restoredAt + 12000 - Date.now()));
      let { front, behind } = await roles('codexPlus.loadRestoredTabs off');
      end(front, pid.front);
      end(behind, pid.behind);
      const control = await until(() => model.sent(`sleep ${pid.front}`) > 0, 60000, 1000);
      check(!!control, 'codexPlus.loadRestoredTabs off: the conversation in front gets its notice', model.sent(`sleep ${pid.front}`));
      await sleep(20000);
      const unclicked = await loadedNow();
      note(`codexPlus.loadRestoredTabs off: after the reload and before the tab behind is clicked, the app-server has loaded ${JSON.stringify(unclicked)}`);
      check(model.sent(`sleep ${pid.behind}`) === 0 && Array.isArray(unclicked) && !unclicked.includes(behind.id),
        'and the conversation behind is not loaded, and gets none, while its tab has not been shown', { sent: model.sent(`sleep ${pid.behind}`), loaded: unclicked });
      const gaveUp = () => frameWhere(() => document.title === 'Codex could not start', 20000);
      await sleep(Math.max(0, restoredAt + 40000 - Date.now()));
      check(await toFront(behind), 'a click more than 30 seconds after the reload brings the tab behind to the front', await tabs());
      const failed = await gaveUp();
      await sleep(15000);
      const loadedAfter = await loadedNow();
      note(`codexPlus.loadRestoredTabs off: once the tab behind is clicked, the app-server has loaded ${JSON.stringify(loadedAfter)}`);
      await shot('restored-behind-clicked');
      check(!!failed && model.sent(`sleep ${pid.behind}`) === 0 && Array.isArray(loadedAfter) && !loadedAfter.includes(behind.id),
        'and its tab shows Codex\'s own "Codex could not start", so the conversation is still not loaded and gets no notice',
        { page: await pageSays(await frontPage()), sent: model.sent(`sleep ${pid.behind}`), loaded: loadedAfter, toasts: await toasts() });
      /* served() first: until VS Code has served the files that page asked for, the page opened next can find VS Code's
         queue for them full. */
      await served();
      await call(`const t = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input && x.input.uri && x.input.uri.path === arg);
        if (t) await vscode.window.tabGroups.close(t); return !!t;`, `/local/${behind.id}`);
      await exec('codexPlus.openThreadInTab', behind.id);
      const reopened = await until(() => model.sent(`sleep ${pid.behind}`) > 0, 90000, 1000);
      check(!!reopened, 'opened again in a tab of its own, it is loaded and gets the notice that waited for it',
        { sent: model.sent(`sleep ${pid.behind}`), loaded: await loadedNow(), page: await pageSays(await frontPage()), broken: await brokenInFront(), tabs: await tabs() });

      await toFront(front);
      await setting('loadRestoredTabs', true);
      pid.behind += 10;
      await reload('codexPlus.loadRestoredTabs on');
      /* Which tab is in front is read only after the tabs have loaded. */
      const done = await until(() => (/loaded \d+ Codex tab\(s\) VS Code restored behind another, and put tab (\d+) of editor group (\d+) in front again/
        .exec(codexLog()) || null), 90000, 1000);
      check(!!done, 'codexPlus.loadRestoredTabs on: Codex Plus says it has loaded the tabs behind', codexLog().split('\n').slice(-12));
      if (done) {
        const g = (await tabs()).find((x) => x.column === Number(done[2]));
        const t = g && g.tabs[Number(done[1]) - 1];
        check(!!t && t.active, 'and the tab that was in front is in front again', { said: done[0], tabs: await tabs() });
      }
      ({ front, behind } = await roles('codexPlus.loadRestoredTabs on'));
      end(behind, pid.behind);
      const loaded = await until(() => model.sent(`sleep ${pid.behind}`) > 0, 90000, 1000);
      const loadedOn = await loadedNow();
      note(`codexPlus.loadRestoredTabs on: without a click the app-server has loaded ${JSON.stringify(loadedOn)}`);
      check(!!loaded, 'codexPlus.loadRestoredTabs on: the conversation behind gets its notice with its tab never clicked', { sent: model.sent(`sleep ${pid.behind}`), loaded: loadedOn });
      await sleep(Math.max(0, restoredAt + 40000 - Date.now()));
      check(await toFront(behind), 'codexPlus.loadRestoredTabs on: a click more than 30 seconds after the reload brings the tab behind to the front', await tabs());
      /* The page of the tab now in front, not any page of the window: the tabs still behind can show Codex's "Codex could
         not start" from the reload, and a hidden page can hold the same conversation. Codex's header cuts a long title
         short. */
      const drawn = await until(async () => {
        for (const f of page.frames()) {
          try {
            if (!await f.evaluate((want) => !!document.querySelector('[data-codex-composer-root]') && document.querySelectorAll('[data-turn-key]').length >= 1
              && document.body.innerText.includes(want), behind.title.slice(0, 30))) continue;
            const host = f.parentFrame() && await f.parentFrame().frameElement();
            if (host && await host.isVisible()) return f;
          } catch (_) { /* not ready, or gone */ }
        }
        return null;
      }, 30000, 500);
      const gaveUpHere = await gaveUpInFront();
      check(!!drawn && !gaveUpHere, 'and the tab draws its conversation',
        { drawn: !!drawn, gaveUpHere, page: await pageSays(await frontPage()), tabs: await tabs(), toasts: await toasts() });
      await setting('loadRestoredTabs', undefined);
    });

    /*
     * Unread marks through codexPlus.loadRestoredTabs. The loader brings each background Codex tab to the front for a
     * moment, and a conversation in front of the user counts as read. Whether a moment is long enough to clear a mark
     * depends on how quickly the window reports the change, so the test makes the new extension host's loader keep each
     * tab in front until the envelope has gone from its title, or until just before anything else would count it as read
     * (holdInFront): 15 s, or with an Agent Plus whose session list takes a conversation as seen once it has stayed in
     * front SEEN_AFTER_MS (its src/session-list.js), 300 ms less than that. The conversation behind is marked unread
     * from its row in Agent Plus's session list, which also has this extension put the envelope on its tab; the one in
     * front with its tab's Mark as Unread, since the list takes the conversation in front as seen. Once the tabs are
     * loaded, and still a while later, each tab keeps its envelope, and the row of the one behind keeps its unread mark.
     * Like the step above, it runs before the extension host restarts for the last step.
     */
    await step('restored tabs keep their envelopes', async () => {
      const pair = [threads[0], threads[1]];
      const tabOf = async (t) => (await codexTabsNow()).find((x) => x.route === `/local/${t.id}`);
      /* Run in the new extension host right after the reload: it wraps load-tabs.js's loadAll once Codex Plus has
         loaded it, and records each hold, and the time the loader finished, in globalThis.__cxpHolds. */
      const holdMs = (() => {
        try {
          const dir = fs.readdirSync(profile.exts).filter((n) => /^xnervwang\.agent-plus-\d/.test(n)).sort().pop();
          const m = /\bSEEN_AFTER_MS\s*=\s*(\d+)/.exec(fs.readFileSync(path.join(profile.exts, dir, 'src', 'session-list.js'), 'utf8'));
          return m ? Math.max(500, Number(m[1]) - 300) : 15000;
        } catch (_) { return 15000; }
      })();
      const holdInFront = () => call(`
        const path = require('path'), fs = require('fs');
        const mine = vscode.extensions.getExtension('xnervwang.codex-plus');
        if (!mine) throw new Error('Codex Plus is not installed');
        const file = path.join(mine.extensionPath, 'src', 'load-tabs.js');
        let real = file;
        try { real = fs.realpathSync(file); } catch (_) { /* not there */ }
        const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
        const rec = globalThis.__cxpHolds = { t0: Date.now(), holds: [], wrapped: 0, loaded: null };
        const frontLabel = () => { const g = vscode.window.tabGroups.activeTabGroup, t = g && g.activeTab; return t ? String(t.label || '') : ''; };
        const marked = (l) => l.includes('\\u2709') || l.includes('\\uD83D\\uDCE9');
        const wrap = () => {
          const key = Object.keys(require.cache).find((k) => same(k, file) || same(k, real));
          if (!key) return false;
          const mod = require.cache[key].exports, own = mod.loadAll;
          mod.loadAll = (o) => own({ ...o, sleep: async (ms) => {
            const t0 = Date.now();
            await o.sleep(ms);
            /* A tab just restored has Codex's short title until Codex Plus draws the envelope after it, which on a slow
               machine comes after the loader has brought the tab forward. */
            while (!marked(frontLabel()) && Date.now() - t0 < Math.min(10000, arg)) await o.sleep(50);
            const label = frontLabel(), had = marked(label);
            while (had && marked(frontLabel()) && Date.now() - t0 < arg) await o.sleep(50);
            rec.holds.push({ ms: t0 - rec.t0, label: label.slice(0, 48), had, held: Date.now() - t0, cleared: had && !marked(frontLabel()) });
          } }).finally(() => { rec.loaded = Date.now() - rec.t0; });
          rec.wrapped = Date.now() - rec.t0;
          return true;
        };
        if (!wrap()) { const timer = setInterval(() => { if (wrap()) clearInterval(timer); }, 20); }
        return true;`, holdMs);
      const holds = () => call('return globalThis.__cxpHolds || null;').catch(() => null);
      /* Whether `t`'s tab has the envelope and whether its list row has the unread mark, leaving out the row of the
         conversation in front. */
      const envelopesOf = async (t) => {
        const x = await tabOf(t);
        const r = (await showList()) ? await slRow(t.id) : null;
        return { title: t.title.slice(0, 32), tab: x ? envelopes(x.label) === 1 : null, active: !!(x && x.active), row: r ? r.unread : null };
      };
      const everywhere = (e) => e.tab === true && (e.active || e.row === true);

      await exec('workbench.action.closeAuxiliaryBar');
      await settle('restored tabs keep their envelopes: before the tabs left open were closed');
      await exec('workbench.action.closeAllEditors');
      await exec('workbench.action.joinAllGroups');
      for (const t of [pair[1], pair[0]]) await openShown(t);
      check(!!await until(async () => { const a = await tabOf(pair[0]), b = await tabOf(pair[1]); return a && b && a.active && !b.active; }, 15000, 300),
        'two conversations are open in tabs of one group, one in front of the other', await codexTabsNow());
      if (!await showList()) throw new Error('the session list did not open');
      await readInList(pair[1]);
      retried(await pick(pair[1], ['Mark as Unread']), 'Mark as Unread');
      await call('await vscode.commands.executeCommand("codexPlus.markThreadUnread", arg); return true;', pair[0].id);
      const marked = await until(async () => { const e = await Promise.all(pair.map(envelopesOf)); return e.every(everywhere) && e; }, 20000, 500);
      check(!!marked, 'both, marked unread, carry the envelope on their tabs, and the one behind the unread mark on its row in Agent Plus\'s session list, before the reload',
        marked || await Promise.all(pair.map(envelopesOf)));
      if (!await focused()) note(`the window does not have the system's focus on ${process.platform}, where nothing in front counts as read, so a lost mark could not show here`);

      await setting('loadRestoredTabs', true);
      await exec('notifications.clearAll');
      await settle('restored tabs keep their envelopes: before the reload', 2);
      await w.reload();
      await holdInFront();
      await until(async () => { const st = await patchState(); return st && st.active; }, 60000, 1000);
      const ran = await until(async () => { const r = await holds(); return r && r.loaded !== null && r; }, 120000, 1000);
      const behind = [];
      for (const t of pair) { const x = await tabOf(t); if (x && !x.active) behind.push(t); }
      check(!!ran && ran.holds.length >= behind.length && behind.length > 0 && ran.holds.every((h) => h.had),
        'with codexPlus.loadRestoredTabs on, the reload brings each tab behind to the front, its title carrying the envelope, and holds it there',
        { record: ran || await holds(), behind: behind.map((t) => t.title), tabs: await codexTabsNow() });
      if (ran) console.log(`        holds: ${JSON.stringify(ran.holds)}, wrapped at ${ran.wrapped} ms, loader finished at ${ran.loaded} ms`);
      const cleared = ran ? ran.holds.filter((h) => h.cleared) : [];
      check(!cleared.length, 'and no tab held in front loses its envelope while it is there', cleared);
      /* A lost mark shows only after a page reports, and pages go on reporting after the loader has finished. */
      const kept = behind.length ? await until(async () => { const e = await Promise.all(behind.map(envelopesOf)); return e.every(everywhere) && e; }, 10000, 500) : null;
      const lost = kept ? await until(async () => { const e = await Promise.all(behind.map(envelopesOf)); return e.some((x) => !everywhere(x)) && e; }, 15000, 500) : null;
      check(!!kept && !lost, 'once the tabs are loaded, each conversation behind has the envelope on its tab and the unread mark on its row in the session list, and keeps it',
        lost || kept || await Promise.all(behind.map(envelopesOf)));
      await shot('restored-tabs-envelopes');
      /* Read again for the steps after this one: each brought to the front after another editor. */
      for (const t of pair) {
        await openNotes();
        const x = await tabOf(t);
        if (x) await tabNamed(bare(x.label)).click();
        await until(async () => { const y = await tabOf(t); return y && !envelopes(y.label); }, 20000, 500);
      }
      await setting('loadRestoredTabs', undefined);
    });
    /*
     * codexPlus.reopenDroppedTabs. A tab closed while the window cannot reach the extension host is not recorded as
     * closed (src/tab-memory.js), as when a remote window loses its connection, and the tab comes back once the host is
     * up again; with the setting off it stays closed. Last, since the host restarts for it.
     */
    await step('a tab closed while the extension host was away', async () => {
      const t = threads[1];
      const tabUp = () => page.evaluate((want) => [...document.querySelectorAll('.tabs-container .tab')].some((e) => e.textContent.includes(want)), t.title);
      /* The tab is closed the moment the extension host is told to restart, when nothing in the host is left to record it.
         Killing the host instead closes a window started for extension development, as this one is. */
      const dropRound = async (doing, cut) => {
        const next = (what) => { if (cut.done) throw new Error('given up'); doing.now = what; };
        next('opening the tab');
        await exec('codexPlus.openThreadInTab', t.id);
        next('waiting for the tab');
        if (!await until(tabUp, 20000, 500)) throw new Error(`no tab of "${t.title}" opened`);
        next('clicking the tab');
        await tabNamed(t.title).click();
        await sleep(3000);
        const pidNow = () => call('return process.pid;', null, 300).catch(() => 0);
        next('reading the extension host\'s pid');
        const was = await pidNow();
        const at = Date.now();
        next('waiting for Codex\'s pages to settle');
        await settle('a tab closed while the extension host was away: before the extension host restarted');
        next('asking the extension host to restart');
        call('setTimeout(() => vscode.commands.executeCommand("workbench.action.restartExtensionHost"), 50); return true;', null, 3000).catch(() => {});
        /* Watches for a moment when no host answers: the old host gone and the new one not yet up. */
        let gap = false;
        next('watching the extension host restart');
        await until(async () => { const p = await pidNow(); if (!p) { gap = true; return true; } return p !== was; }, 20000, 100);
        next('pressing the key that closes the tab');
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W');
        next('waiting for the tab to close');
        let closed = await until(async () => !await tabUp(), 3000, 100);
        if (!closed) {
          next('closing the tab with its close button');
          await tabNamed(t.title).hover().catch(() => {});
          await tabNamed(t.title).locator('.tab-actions .action-label').first().click({ timeout: 3000 }).catch(() => {});
          closed = await until(async () => !await tabUp(), 3000, 100);
        }
        next('waiting for the new extension host');
        const back = await w.hostUp(at).then(() => true, () => false);
        next('waiting for Codex Plus in the new extension host');
        await until(async () => { const s = await patchState().catch(() => null); return s && s.active; }, 60000, 1000);
        return { closed: !!closed, back, gap, closedAfterMs: Date.now() - at };
      };
      /* On Linux a round once hung after the host's restart, with nothing printed: some call into the window that has
         no time limit of its own never answered. If that call answers after the round was given up, the round stops
         at its next step, so it cannot press keys or restart the host during a later step. */
      const ROUND_MS = 180000;
      const dropOnce = async () => {
        const doing = { now: 'starting' }, cut = { done: false };
        let timer = null;
        const late = new Promise((_, no) => { timer = setTimeout(() => { cut.done = true; no(new Error(`a round of closing the tab took more than ${ROUND_MS / 1000} s; it was ${doing.now}`)); }, ROUND_MS); });
        try { return await Promise.race([dropRound(doing, cut), late]); } finally { clearTimeout(timer); }
      };
      /* If no moment without a host was seen, the close may have been recorded, and the check after it proves nothing. */
      const unmet = (r) => { if (r.gap) return false; note(`no moment without an extension host was seen on ${process.platform} while it restarted (${JSON.stringify(r)}), so the tab may have been closed under a host that recorded it; not checked`); return true; };
      const first = await dropOnce();
      check(first.closed && first.back, 'the tab is closed as the extension host restarts, and a new host starts', first);
      if (!unmet(first)) {
        const back = await until(tabUp, 40000, 1000);
        check(!!back, 'once the host is back, Codex Plus reopens the tab of the conversation that was open, as VS Code did not restore it', { tabs: await tabs(), first });
        await shot('dropped-tab-reopened');
      }
      await setting('reopenDroppedTabs', false);
      const second = await dropOnce();
      check(second.closed && second.back, 'with codexPlus.reopenDroppedTabs off, the tab is closed the same way', second);
      /* The new host reopens dropped tabs 8 s after it starts and reads the setting at that moment, so the setting
         is restored only after that pass, even when this test cannot judge what the pass did: restored earlier, it
         let the tab come back in front during the next step. */
      await sleep(20000);
      if (!unmet(second)) check(!await tabUp(), 'and it is not reopened', await tabs());
      await setting('reopenDroppedTabs', undefined);
    });

    /*
     * A conversation whose writer lock another process holds, as the app-server of the window before holds a
     * conversation's lock after a reload until it exits. Codex's page shows its notice that the conversation is open in
     * another app, and Codex Plus's page script clicks the notice's Retry every few seconds. A Python process holds the
     * lock, with the kind of lock Codex takes, an exclusive flock or on Windows a byte-range lock, on the file Codex
     * locks (codex-rs/rollout/src/writer_lock.rs). The conversation is one this window's app-server has not loaded
     * before (lib/fake-home.js HELD).
     */
    await step('a conversation open in another app', async () => {
      const cp = require('child_process');
      const py = ['python3', 'python'].find((x) => (cp.spawnSync(x, ['-c', 'import sys; print(sys.version_info[:2] >= (3, 7))'], { encoding: 'utf8' }).stdout || '').trim() === 'True');
      if (!py) { note('no Python 3.7 or later here, so no process held a conversation\'s writer lock'); return; }
      const t = fakeHome.held(profile.codexHome, { folder: profile.folder });
      const lockFile = path.join(profile.codexHome, 'thread-writer-locks', `${t.id}.lock`);
      const HOLD = ['import os, sys', 'p = sys.argv[1]', 'os.makedirs(os.path.dirname(p), exist_ok=True)', "f = open(p, 'a+b')",
        "if os.name == 'nt':", '    import msvcrt', '    f.seek(0)', '    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)',
        'else:', '    import fcntl', '    fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)',
        "print('held', flush=True)", 'sys.stdin.read()'].join('\n');
      const holder = cp.spawn(py, ['-c', HOLD, lockFile], { stdio: ['pipe', 'pipe', 'pipe'] });
      let heard = '';
      holder.stdout.on('data', (d) => { heard += d; });
      holder.stderr.on('data', (d) => { heard += d; });
      const exited = new Promise((r) => holder.on('exit', r));
      const letGo = async () => { try { holder.stdin.end(); } catch (_) { /* closed */ } await Promise.race([exited, sleep(5000)]); try { holder.kill(); } catch (_) { /* gone */ } };
      /* The visible Codex page with an alert saying `words` on it, or null. */
      const alertIn = async (words) => {
        for (const f of page.frames()) {
          try {
            if (!await f.evaluate((w) => [...document.querySelectorAll('[role="alert"]')].some((e) => !!e.offsetParent && e.innerText.includes(w)), words)) continue;
            const host = f.parentFrame() && await f.parentFrame().frameElement();
            if (host && await host.isVisible()) return f;
          } catch (_) { /* gone */ }
        }
        return null;
      };
      const noticeIn = () => alertIn('This is open in another app');
      const loaded = () => call(`${OWN} const r = await own('patching').hostRequest('thread/loaded/list', {});
        return r && r.outcome === 'done' && r.result ? r.result.data : r;`).catch((e) => String(e));
      /* No other step makes Codex Plus write these lines. ownLog() joins one file per extension host, so an offset into it
         taken now would not mark where this step began once a file it already holds grows. */
      const said = () => ownLog().split('\n').filter((l) => /open in another app/.test(l));
      try {
        check(!!await until(() => /held/.test(heard), 15000, 200), 'another process holds the conversation\'s writer lock', heard);
        await exec('codexPlus.openThreadInTab', t.id);
        const shown = await until(noticeIn, 60000, 500);
        check(!!shown, 'opened in a tab, its page says the conversation is open in another app', { tabs: await codexTabsNow(), loaded: await loaded() });
        if (!shown) return;
        const started = await until(() => said().some((l) => l.includes(`Codex says conversation ${t.id} is open in another app; clicking its Retry`)), 20000, 500);
        check(!!started, 'Codex Plus starts clicking its Retry and says so in its log', said());
        await sleep(6000);
        check(!!await noticeIn() && !JSON.stringify(await loaded()).includes(t.id), 'while the other process holds the lock, the notice stays and this window has not loaded the conversation',
          { notice: !!await noticeIn(), loaded: await loaded() });
        await shot('writer-conflict-notice');
        await letGo();
        const opened = await until(async () => !await noticeIn() && JSON.stringify(await loaded()).includes(t.id), 30000, 500);
        check(!!opened, 'once the lock is let go, the conversation opens without the user clicking',
          { notice: !!await noticeIn(), loaded: await loaded(), said: said() });
        const cleared = await until(() => said().some((l) => new RegExp(`notice that conversation ${t.id} is open in another app went away after Retry was clicked \\d+ times?`).test(l)), 30000, 500);
        check(!!cleared, 'and Codex Plus says in its log how many times it clicked Retry', said());
        const history = await until(async () => !await alertIn('Couldn\'t load messages'), 20000, 500);
        check(!!history, 'and Codex\'s "Couldn\'t load messages", left by the same conflict, goes too', { history: !!await alertIn('Couldn\'t load messages') });
        await shot('writer-conflict-opened');
      } finally {
        await letGo();
        await call(`const mine = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((x) => x.input && x.input.uri && String(x.input.uri).includes(arg));
          if (mine.length) await vscode.window.tabGroups.close(mine); return mine.length;`, t.id).catch(() => 0);
      }
    });

    /*
     * Where else a conversation is open, in Agent Plus's session list (src/writer-locks.js): a process holding the
     * conversation's writer lock, first a stand-in that only takes the lock, then Codex's own terminal interface on it,
     * started in a pseudo-terminal from the codex program of the Codex extension with --no-daemon.
     */
    await step('a conversation another Codex process has open', async () => {
      if (process.platform !== 'linux') { note('the processes holding Codex\'s writer locks are read from /proc/locks, which only Linux has'); return; }
      const cp = require('child_process');
      const py = ['python3', 'python'].find((x) => (cp.spawnSync(x, ['-c', 'import sys; print(sys.version_info[:2] >= (3, 7))'], { encoding: 'utf8' }).stdout || '').trim() === 'True');
      const here = (await hereRows()) || [];
      const t = fakeHome.THREADS.find((x) => !here.includes(x.id));
      if (!t || !await showList()) { check(false, 'a conversation not open in this window is in Agent Plus\'s session list', { here }); return; }
      const lockFile = path.join(profile.codexHome, 'thread-writer-locks', `${t.id}.lock`);
      const gone = async (what) => check(!!await slRowSays(t.id, (r) => r.stripe !== 'elsewhere' && !r.away, 40000),
        `${what}: once it lets go, the row is no longer drawn as open somewhere else`, await slRow(t.id));
      if (py) {
        const HOLD = ['import os, sys', 'p = sys.argv[1]', 'os.makedirs(os.path.dirname(p), exist_ok=True)', "f = open(p, 'a+b')",
          'import fcntl', 'fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)', "print('held', flush=True)", 'sys.stdin.read()'].join('\n');
        const holder = cp.spawn(py, ['-c', HOLD, lockFile], { stdio: ['pipe', 'pipe', 'pipe'] });
        let heard = '';
        holder.stdout.on('data', (d) => { heard += d; });
        const exited = new Promise((r) => holder.on('exit', r));
        try {
          check(!!await until(() => /held/.test(heard), 15000, 200), 'a stand-in process holds the conversation\'s writer lock', heard);
          const away = await slRowSays(t.id, (r) => r.stripe === 'elsewhere' && r.away === 'terminal', 40000);
          check(!!away, 'held by another process, its row in Agent Plus\'s session list has the outlined stripe and, before its time, the icon of another program', await slRow(t.id));
          check(!!away && /\bOpen in \S+ process \d+/.test(away.hover), 'and its hover names that process and its id, and, with no turn running, says it is open there, not running', away && away.hover);
        } finally {
          try { holder.stdin.end(); } catch (_) { /* closed */ }
          await Promise.race([exited, sleep(5000)]);
          try { holder.kill(); } catch (_) { /* gone */ }
        }
        await gone('the stand-in');
      } else note('no Python 3.7 or later here, so no stand-in process held a conversation\'s writer lock');

      const ext = fs.readdirSync(profile.exts).find((d) => d.startsWith('openai.chatgpt-'));
      const bin = ext ? codexBinary(path.join(profile.exts, ext)) : '';
      const hasScript = cp.spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;
      if (!bin || !hasScript) { note(`${bin ? 'no script(1) here' : 'no codex program in the Codex extension'}, so Codex's terminal interface was not started on the conversation`); return; }
      const quote = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;
      /* The Codex extension's program has no package of its own for the terminal interface, which then runs without
         Codex's background server only when asked to. */
      const tui = cp.spawn('script', ['-qfc', `${quote(bin)} --no-daemon resume ${t.id}`, '/dev/null'],
        { env: { ...env, TERM: 'xterm-256color' }, cwd: profile.folder, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let screen = '';
      tui.stdout.on('data', (d) => { screen = (screen + d).slice(-20000); });
      try {
        const inTerm = await slRowSays(t.id, (r) => r.stripe === 'elsewhere' && r.away === 'terminal' && /Open in terminal (pts\/\d+|tty\w*)/.test(r.hover), 60000);
        if (inTerm) check(true, 'Codex\'s terminal interface on the conversation: its row is drawn as open somewhere else, and its hover says in which terminal', inTerm.hover);
        else {
          const lw = require('../../src/writer-locks'), lr = require('../../src/left-running');
          const argvOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').split('\0'); } catch (_) { return []; } };
          const holders = lw.holders({ codexHome: profile.codexHome, proc: '/proc', all: lr.processes('/proc'), argvOf, isExec: lr.isCodexExec }).filter((h) => h.thread === t.id);
          note(`Codex's terminal interface was not shown as holding the conversation within a minute; holders read now: ${JSON.stringify(holders.map((h) => [h.kind, h.label]))}; row: ${JSON.stringify(await slRow(t.id))}; its screen ended: ${screen.replace(/\x1b\[[0-9;?<>]*[A-Za-z~]/g, ' ').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ' ').replace(/\s+/g, ' ').slice(-800)}`);
        }
      } finally {
        try { process.kill(-tui.pid, 'SIGTERM'); } catch (_) { try { tui.kill(); } catch (__) { /* gone */ } }
        await sleep(2000);
        try { process.kill(-tui.pid, 'SIGKILL'); } catch (_) { /* gone */ }
      }
      await gone('Codex\'s terminal interface');
    });

    /*
     * A tab whose page Codex replaced with its recovery page because one of its own modules failed to load. The module a
     * conversation's page loads when it starts is renamed in Codex's folder while a tab is opened on a conversation, so
     * that page cannot load it; Codex Plus's page script reports the page, the host logs the file it could not load,
     * and the file gets its name back before the host loads the page again (src/broken-pages.js waits 2 s). The new
     * page draws the conversation in the same tab.
     */
    await step('a page that could not load Codex\'s code', async () => {
      /* The conversation of the step before, which no other step touches; threads[2] is deleted by "archive and delete". */
      const t = fakeHome.HELD;
      if (!walk(path.join(profile.codexHome, 'sessions')).some((f) => f.includes(t.id))) fakeHome.held(profile.codexHome, { folder: profile.folder });
      const assets = path.join(await call('return vscode.extensions.getExtension("openai.chatgpt").extensionPath;'), 'webview', 'assets');
      /* The largest of them: Codex has a small module of that name that only imports the one with the code. */
      const name = fs.readdirSync(assets).filter((n) => /^local-conversation-page-[0-9a-f]+\.js$/.test(n))
        .sort((x, y) => fs.statSync(path.join(assets, y)).size - fs.statSync(path.join(assets, x)).size)[0];
      if (!name) { note('this Codex has no local-conversation-page module, so no page was made to fail to load it'); return; }
      const file = path.join(assets, name), away = file + '.away';
      const closeIt = () => call(`const mine = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((x) => x.input && x.input.uri && String(x.input.uri).includes(arg));
        if (mine.length) await vscode.window.tabGroups.close(mine); return mine.length;`, t.id);
      const said = () => ownLog().split('\n').filter((l) => l.includes(`conversation ${t.id}`) && /could not load its code|loaded the page in the tab/.test(l));
      await closeIt();
      await settle('a page that could not load Codex\'s code: before the tab was opened', 0);
      fs.renameSync(file, away);
      let back = false;
      const putBack = () => { if (!back) { back = true; try { fs.renameSync(away, file); } catch (_) { /* already back */ } } };
      try {
        await exec('codexPlus.openThreadInTab', t.id);
        /* The error names the module the page imported, which can be a small one that imports this one. */
        const reported = await until(() => said().some((l) => /could not load its code \([\w.-]+\.js\)\s*$/.test(l)), 30000, 200);
        putBack();
        if (!reported) {
          note(`with ${name} renamed, the page opened on "${t.title}" did not report Codex's recovery page within 30 s, so it was not loaded again; ${JSON.stringify(said())}`);
          return;
        }
        check(true, 'with the module a conversation\'s page needs taken away, its page reports Codex\'s recovery page, and the host logs the file it could not load');
        const before = (await codexTabsNow()).findIndex((x) => x.route === `/local/${t.id}`);
        const reloaded = await until(() => said().find((l) => new RegExp(`loaded the page in the tab of conversation ${t.id} again`).test(l)), 30000, 500);
        check(!!reloaded, 'with the module back, the host loads the page again', said());
        const page2 = await until(async () => { const f = await frontPage(); const s = await pageSays(f); return s && s.turns >= 1 && s.text.includes(t.title.slice(0, 30)) && f; }, 60000, 1000);
        const after = (await codexTabsNow()).findIndex((x) => x.route === `/local/${t.id}`);
        check(!!page2 && after === before, 'and the new page draws the conversation in the same tab, which has kept its position', { before, after, tabs: await codexTabsNow(), page: await pageSays(await frontPage()) });
        await shot('page-loaded-again-after-its-code-failed-to-load');
      } finally {
        putBack();
        await settle('a page that could not load Codex\'s code: before the tab was closed', 0);
        await closeIt();
      }
    });

    /*
     * Each of Agent Plus's token modes in turn, without a reload, checked by what reaches the made-up model: All, Essential,
     * Interface, Custom with the time-zone note and the brief off, and All again. In each, a turn of a conversation
     * already running and the first turn of a new one. Last of all, since it trusts the work plan plugin's hooks, which
     * no step before it runs with.
     */
    await step('what the model is given in each token mode', async () => {
      const hooksFile = path.join(PLANS_DIR, 'config.json');
      const hooksNow = () => { try { const h = JSON.parse(fs.readFileSync(hooksFile, 'utf8')); return [h.enabled, h.tellTimeZone, h.brief]; } catch (_) { return null; } };
      const setZone = (z) => fs.writeFileSync(path.join(PLANS_DIR, 'client-time-zone.json'), JSON.stringify({ timeZone: z }) + '\n');
      const trust = await call(`${OWN} const install = own('plugin-install'), files = own('codex-files');
        const binary = own('appserver').codexBinary(vscode.extensions.getExtension('openai.chatgpt').extensionPath);
        const home = files.codexHome(), cwds = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
        const st = await install.hookStatus({ binary, home, cwds });
        const r = await install.trustHooks({ binary, home, cwds, shown: st.review.map((h) => ({ key: h.key, currentHash: h.currentHash })) });
        const after = await install.hookStatus({ binary, home, cwds });
        return { total: st.total, trusted: r.trusted, left: after.review.length };`, null, 180000).catch((e) => ({ error: String(e) }));
      if (!trust || !trust.total) { note(`the work plan plugin has no hooks here (${JSON.stringify(trust)}), so what each token mode gives the model was not checked`); return; }
      check(!trust.left, 'the work plan plugin\'s hooks are trusted, for this step', trust);
      /* The quiet after a turn: no request for 4 s. */
      const quiet = async () => {
        let n = model.seen.length, at = Date.now();
        await until(() => { if (model.seen.length !== n) { n = model.seen.length; at = Date.now(); } return Date.now() - at > 4000; }, 90000, 300);
      };
      /* Types `text` into `frame` and, once the turn is over, resolves to the context of that turn's request; a side request
         such as the one for a title offers no tools. */
      const turnIn = async (frame, text, zone) => {
        const before = model.seen.length;
        await intoComposer(frame);
        await page.keyboard.type(text);
        setZone(zone);
        await page.keyboard.press('Enter');
        const got = await until(() => model.seen.slice(before).find((x) => x.context && x.context.tools > 0 && x.context.said.includes(text)), 60000, 300);
        await quiet();
        const file = path.join(out, `token-mode-${text.replace(/\W+/g, '-').toLowerCase().slice(0, 60)}.json`);
        /* Saves the request itself, or the last few when none matched, so a reader can see what Codex sent. */
        fs.writeFileSync(file, got ? model.bodyWith(text) : JSON.stringify(model.lastBodies(6).map((b) => { try { return JSON.parse(b); } catch (_) { return b; } }), null, 1));
        return got ? got.context : null;
      };
      /* Opens a new conversation's page and waits until VS Code shows it in front, trying once more if it does not:
         on Windows the page found has stayed hidden, its message box never visible. */
      const freshPage = async () => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          await newTabPage();
          const shown = await until(async () => { const f = await frontPage(); return f && await f.evaluate(() => !document.querySelector('[data-turn-key]')).catch(() => false) && f; }, 30000, 500);
          if (shown) return shown;
          note(`what the model is given: the new conversation's page was not in front within 30 s on try ${attempt}`);
          await exec('workbench.action.closeActiveEditor').catch(() => {});
        }
        return null;
      };
      await exec('workbench.action.closeAllEditors');
      const BEGIN = 'Token mode checks begin here.';
      const first = await freshPage();
      if (!first) throw new Error('no new conversation page opened');
      await emptyBox(first);
      await turnIn(first, BEGIN, 'UTC');
      const id = await until(() => rolloutWith(BEGIN), 30000, 500);
      if (!id) throw new Error('the conversation the checks run in has no rollout');
      /* A row not yet started, which the Stop hook leaves alone. */
      fs.writeFileSync(path.join(PLANS_DIR, `${id}.json`), JSON.stringify({ nodes: [{ title: 'Check each token mode', state: 'todo',
        since: new Date().toISOString().replace(/\.\d+Z$/, '+00:00') }] }));
      await exec('agentPlus.refreshWorkPlan');
      const running = async () => {
        await exec('codexPlus.openThreadInTab', id);
        return until(async () => { const f = await frontPage(); return f && await f.evaluate((w) => document.body.innerText.includes(w), BEGIN).catch(() => false) && f; }, 30000, 500);
      };
      const MODES = [
        { mode: 'all', zone: 'Asia/Tokyo', on: { plan: true, zone: true, brief: true } },
        { mode: 'essential', zone: 'Europe/Berlin', on: { plan: true, zone: true, brief: false } },
        { mode: 'interface', zone: 'America/New_York', on: { plan: false, zone: false, brief: false } },
        { mode: 'custom', zone: 'Asia/Kolkata', own: { tellCodexYourTimeZone: false, conversationBrief: false }, on: { plan: true, zone: false, brief: false } },
        { mode: 'all', zone: 'Australia/Sydney', again: true, on: { plan: true, zone: true, brief: true } },
      ];
      /* The hooks are told that replies show images only for a Codex build listed in src/supported-versions.json
         (extension.js writeHookSettings), and the window installs the newest Codex. */
      const codexVersion = await call("return String(vscode.extensions.getExtension('openai.chatgpt').packageJSON.version || '');");
      const imagesTold = require('../../src/supported').verified(codexVersion);
      if (!imagesTold) note(`Codex ${codexVersion} is not among the builds src/supported-versions.json records, so the note on images is checked to be absent`);
      const imagesSetting = () => { try { return JSON.parse(fs.readFileSync(hooksFile, 'utf8')).replyImages; } catch (_) { return null; } };
      check(await until(() => imagesSetting() === imagesTold, 15000, 300) === true,
        `the hooks' settings say replies show images: ${imagesTold}, as Codex ${codexVersion} is ${imagesTold ? '' : 'not '}a recorded build`, imagesSetting());
      /* The hook works out the user's time with the C library through TZ (tell-time-zone.py clock_in), which Python on
         Windows cannot do, so on Windows the hook never gives the zone. */
      const zones = process.platform !== 'win32';
      if (!zones) note('Python on Windows has no time.tzset, so the time-zone note is checked to be absent in every mode');
      const results = [];
      try {
        for (const [i, m] of MODES.entries()) {
          const name = `${m.mode}${m.again ? ' again' : ''}`;
          const zone = m.on.zone && zones;
          console.log(`  -- ${name}`);
          await agentSetting('tokenMode', m.mode);
          for (const [k, v] of Object.entries(m.own || {})) await setting(k, v);
          const want = [m.on.plan, m.on.zone, m.on.brief];
          const given = await until(() => { const h = hooksNow(); return JSON.stringify(h) === JSON.stringify(want) && h; }, 15000, 300) || hooksNow();
          /* Interface features unloads the plugin, so the hooks' settings file is not checked in that mode. */
          if (m.mode !== 'interface') check(JSON.stringify(given) === JSON.stringify(want), `${name}: the hooks' settings say work plan ${m.on.plan}, time zone ${m.on.zone}, brief ${m.on.brief}`, given);
          /* In Interface features Codex is set to skip the plugin, and a marker file is written beside the plans; the next mode
             loads the plugin again and removes the marker (src/plugin-install.js followTokenMode). */
          const unload = m.mode === 'interface', marker = path.join(PLANS_DIR, require('../../src/plugin-install').UNLOADED_MARKER);
          const followed = await until(() => fs.existsSync(marker) === unload, 60000, 500);
          check(!!followed, `${name}: ${unload ? 'Codex is told to skip the work plan plugin, and the mark of the mode doing so is left' : 'the plugin is loaded, with no mark of a mode unloading it'}`,
            { marked: fs.existsSync(marker) });
          await sleep(3000);
          const r = { mode: name };
          const f = await running();
          r.running = f ? await turnIn(f, `Token mode check, ${name}, a running conversation.`, m.zone) : null;
          /* Codex decides which plugins its loaded conversations run when a conversation starts (extension.js
             followTokenMode), so after Interface features the conversation already running gets the plugin back only once
             a new one has started; the turn after the new conversation below checks that. */
          if (i > 0 && MODES[i - 1].mode === 'interface') {
            note(`${name}: the first turn of the conversation already running after Interface features carried ${JSON.stringify(r.running)}`);
          } else {
            check(!!r.running && r.running.plan === m.on.plan && r.running.zone === zone && r.running.brief === m.on.brief && !r.running.images,
              `${name}: a turn of a conversation already running carries the work plan: ${m.on.plan}, the time-zone note: ${zone}, `
              + `the brief's request for a status: ${m.on.brief}, and no note on images`, r.running || model.seen.slice(-3).map((x) => x.context));
          }
          const fresh = await freshPage();
          if (fresh) {
            await emptyBox(fresh);
            r.fresh = await turnIn(fresh, `Token mode check, ${name}, a new conversation.`, m.zone);
            const plugin = m.mode !== 'interface';
            check(!!r.fresh && r.fresh.images === (plugin && imagesTold) && r.fresh.skill === plugin && r.fresh.zone === zone && !r.fresh.plan,
              `${name}: the first turn of a new conversation carries the note on images: ${plugin && imagesTold}, the work plan skill in Codex's list of `
              + `skills: ${plugin}, the time-zone note: ${zone}, and no work plan, it having none`,
              r.fresh || model.seen.slice(-3).map((x) => x.context));
            await exec('workbench.action.closeActiveEditor');
          } else check(false, `${name}: a new conversation opens`, await tabs());
          const f2 = await running();
          r.runningAgain = f2 ? await turnIn(f2, `Token mode check, ${name}, the running conversation again.`, m.zone) : null;
          /* The time-zone note is repeated only when the last one has gone stale (tell-time-zone.py). */
          check(!!r.runningAgain && r.runningAgain.plan === m.on.plan && r.runningAgain.brief === m.on.brief && !r.runningAgain.zone && !r.runningAgain.images,
            `${name}: after a new conversation has started, a turn of the one already running carries the work plan: ${m.on.plan}, the brief's request `
            + 'for a status: ' + m.on.brief + ', and neither the time-zone note it was given a turn before nor a note on images', r.runningAgain);
          results.push(r);
          for (const k of Object.keys(m.own || {})) await setting(k, undefined);
        }
      } finally {
        fs.writeFileSync(path.join(out, 'token-modes.json'), JSON.stringify(results, null, 2) + '\n');
        await agentSetting('tokenMode', undefined);
      }
    });

  } finally {
    clearInterval(snagWatch);
    watchingTrust = false;
    await trustWatch;
    if (trustCancelled) note(`the dialog asking to trust the work plan hooks was cancelled ${trustCancelled} time(s)`);
    await shot('last');
    await w.close();
  }
}

/*
 * Set up before the window starts (run.js): two conversations Codex archived some time ago, each with the time the
 * archive sweep counts from (src/archive-sweep.js records when it first saw a conversation archived), and
 * codexPlus.deleteArchivedAfterDays lowered from its default. The sweep a minute after the start then deletes the
 * conversation archived longer ago than that and keeps the other.
 */
const ARCHIVED = [{ id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6a', title: 'Clean up the old export buckets', days: 25 },
  { id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6b', title: 'Rotate the staging keys', days: 10 }];
const SETTINGS = { 'codexPlus.deleteArchivedAfterDays': 20 };
function prepare({ profile, fakeHome }) {
  fakeHome.archived(profile.codexHome, { folder: profile.folder, threads: ARCHIVED });
  const dir = path.join(profile.user, 'User', 'globalStorage', 'xnervwang.codex-plus', 'archive-sweep');
  fs.mkdirSync(dir, { recursive: true });
  const key = require('crypto').createHash('sha256').update(String(profile.codexHome)).digest('hex').slice(0, 12);
  fs.writeFileSync(path.join(dir, `archive-sweep-${key}.json`), JSON.stringify({ lastRunMs: 0,
    seen: Object.fromEntries(ARCHIVED.map((t) => [t.id, Date.now() - t.days * 86400e3])) }));
}

module.exports = { run, prepare, SETTINGS, stepsToRun, STEP_BASE, STEP_NEEDS, SHARD_STARTS };
