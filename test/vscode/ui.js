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
 *   list         the session list (this extension's webview): its rows, the right-click menu with no VS Code menu over
 *                it, Text Color and Add to Group, each acting when clicked
 *   delete       Delete on a row: VS Code's modal confirmation, drawn in the window (run.js sets window.dialogStyle),
 *                cancelled and then accepted, and the rollout gone from the Codex home
 *   a tab        a conversation resumed in a tab from the list: its title, then the dot on its logo during a turn sent
 *                through fake-model.js, and after the reply arrives while the tab is in the background
 *   left running a conversation stays green, on its tab and in the session list, until the work its turn started is
 *                done: a background command, a sub-agent, and on Linux a detached shell, a program run under setsid and
 *                a codex exec. The last three need Codex's approval to run outside its sandbox, and the tab shows the
 *                blue dot until it is given. The setsid program also appears in the Agent map, and once the shell or
 *                the program stops, the conversation gets a notice
 *   images       a reply's images: a PNG and an SVG by absolute path, a file:// URL and a data: URL drawn, an image at
 *                a web address shown as a plain link; with codexPlus.replyImages off the others are "[Image]", and
 *                drawn again once it is back on. What the model is told is left to the hook's own self-test, since
 *                this window does not trust the plugin's hooks
 *   Codex's page what the patch adds there: the time stamps, the rail, the buttons by the message box, the Agent map,
 *                and the Work plan line on the context meter's hover
 *   the brief    a click on the conversation in Agent Plus's Conversations panel shows the brief its plan holds in the
 *                Answer view; the arrow on its row and the page's button each go back to the conversation's tab
 *   the sidebar  a conversation resumed in Codex's sidebar: each reply's stamp inside its column
 *   archived     the conversation in the tab archived while open: the tab keeps its turns, read-only, and opening it
 *                from the list unarchives it and gives the tab its message box back
 *   a New tab    a first message typed into a tab the tab bar button opened: the tab is titled by the conversation, and
 *                Agent Plus has it in front, so its reply is neither announced nor counted
 *   to the front a conversation's tab clicked from a New tab with nothing typed into it, and from the tab above: Agent
 *                Plus has the conversation the clicked tab shows in front at once, although VS Code says which panel is
 *                visible only after it reports the switch
 *
 * Every step saves a screenshot to <out>/shots, and crops of the parts this extension draws are compared with the
 * approved copies (lib/baseline.js).
 */
const fs = require('fs');
const path = require('path');
const win = require('./lib/window');
const { baselines } = require('./lib/baseline');
const pixels = require('./lib/pixels');
const { codexBinary } = require('../../src/appserver');

const { sleep, until } = win;
const TITLES = { tab: 'Codex Plus: New Codex Conversation in a Tab', sidebar: 'Codex Plus: Open Codex Sidebar', codex: 'Open Codex Sidebar' };
/* TAB_DOTS in src/patching.js. */
const DOTS = { working: [0x22, 0xc5, 0x5e], unread: [0xef, 0x44, 0x44], prompt: [0x3b, 0x82, 0xf6] };
const COMPOSER = '[data-codex-composer-root] [contenteditable="true"]';
/* What lib/fake-model.js answers a turn with when no script is set. */
const REPLY = 'Done. The cap is configurable.';
/* The theme colour Text Color's Red gives a title, in the Dark Modern theme run.js sets. */
const RED_TITLE = 'rgb(241, 76, 76)';

async function run({ exe, profile, env, playwright, model, threads, out, check, note }) {
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
  const step = async (name, fn) => {
    console.log(`\n── ${name}`);
    try { await fn(); } catch (e) { check(false, `${name}: ran to its end`, String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ')); await shot(`${name}-error`); }
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
  const focused = () => call('return vscode.window.state.focused;');
  /* The number on Agent Plus's bell in the status bar, 0 while the bell is hidden. */
  const bellCount = () => page.evaluate(() => {
    const e = [...document.querySelectorAll('.statusbar-item')].find((x) => x.querySelector('.codicon-bell-dot'));
    return e ? Number(e.innerText.trim()) || 0 : 0;
  });
  const toastAbout = (t, words) => page.evaluate(([want, w]) => {
    const n = [...document.querySelectorAll('.notification-toast')].find((e) => e.innerText.includes(`"${want}" ${w}`));
    return n ? n.innerText : '';
  }, [t, words]);
  const frontTab = async () => { const g = (await tabs()).find((x) => x.active); return g && g.tabs.find((x) => x.active); };
  /* The conversation Agent Plus last said is in front, as its output channel has it: "codex <id>",
     "codex (no session yet)", "(none)", or '' before it said any. */
  const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).flatMap((n) => (n.isDirectory() ? walk(path.join(d, n.name)) : [path.join(d, n.name)])); } catch (_) { return []; } };
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
  const newTabPage = async () => {
    await openNotes();
    await until(async () => { const b = await codexButtons(); return b.length === 1 && b[0] === TITLES.tab; }, 15000, 500);
    const before = new Set(page.frames());
    await codexButton().click();
    /* Codex keeps the page of its hidden sidebar, which also shows a message box and no turns. */
    return until(async () => {
      for (const f of page.frames()) {
        if (before.has(f)) continue;
        try { if (await f.evaluate(() => !!document.querySelector('[data-codex-composer-root]') && !document.querySelector('[data-turn-key]') && innerWidth > 600)) return f; } catch (_) { /* gone */ }
      }
      return null;
    }, 90000, 500);
  };
  const visibleNativeMenu = () => page.evaluate(() => !![...document.querySelectorAll('.context-view .monaco-menu, .monaco-menu-container')].find((e) => e.offsetParent));
  const auxiliaryShowsCodex = () => page.evaluate(() => {
    const part = document.getElementById('workbench.parts.auxiliarybar');
    return !!(part && part.offsetWidth > 0 && part.offsetHeight > 0 && /Codex/.test(part.innerText));
  });

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
  /* How many pixels of each tab dot's colour the tab named `label` shows on its logo. */
  const dotsOn = async (label) => {
    const tab = page.locator('.tabs-container .tab').filter({ hasText: label }).first();
    const box = await tab.boundingBox();
    if (!box) return null;
    const img = pixels.decode(await crop({ x: box.x, y: box.y, width: Math.min(40, box.width), height: box.height }));
    const count = {};
    for (const [k, c] of Object.entries(DOTS)) {
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        if (Math.abs(img.data[i] - c[0]) <= 24 && Math.abs(img.data[i + 1] - c[1]) <= 24 && Math.abs(img.data[i + 2] - c[2]) <= 24) n++;
      }
      count[k] = n;
    }
    return count;
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
      await codexButton().click();
      const opened = await until(async () => {
        const t = await tabs();
        const front = t.find((g) => g.active).tabs.find((x) => x.active);
        return front && front.view === 'chatgpt.conversationEditor' && front.label === 'Codex' && { t, front };
      }, 20000, 500);
      check(!!opened && opened.t.length === groups, 'a click opens a new Codex conversation in a tab titled Codex, in the group already there rather than a new split',
        opened || await tabs());
      const loaded = await frameWhere(() => !!document.querySelector('[data-codex-composer-root]'), 90000);
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
      await setting('tabBarButton', 'tab');

      await setting('enabled', false);
      const off = await until(async () => { const b = await codexButtons(); return b.length === 1 && b[0] === TITLES.codex && b; }, 15000, 500);
      check(!!off, 'turned off, the tab bar has Codex\'s own button again, and only that one', await codexButtons());
      await shot('tab-bar-turned-off');
      await setting('enabled', true);
      const on = await until(async () => { const b = await codexButtons(); return b.length === 1 && b[0] === TITLES.tab && b; }, 15000, 500);
      check(!!on, 'turned back on, this extension\'s button is back in its place', await codexButtons());
      await exec('notifications.clearAll');
    });

    let list = null;
    const row = (t) => list.locator(`.cp-group .cp-row[data-id="${t.id}"]`).first();
    /*
     * Right-clicks `t`'s row and clicks the menu item labels[0], or, given labels[1], that item of its submenu.
     * The page closes its menu when its window loses focus, like VS Code's own menus, and another webview of the
     * window (Codex's page in a tab) can take the focus at any moment; a click then lands on whatever was under the
     * menu. So the page records where each click lands, and a click that missed the item while the page lost the focus
     * is retried, at most twice.
     */
    /* A press outside the page's menus closes them and does nothing else (sessions-page.js); the bottom of the list is empty. */
    const closeMenus = async () => {
      if (!await list.evaluate(() => !!document.querySelector('.cp-ctx'))) return;
      const box = await (await list.frameElement()).boundingBox();
      await page.mouse.click(box.x + 20, box.y + box.height - 12);
      await until(() => list.evaluate(() => !document.querySelector('.cp-ctx')), 3000, 100);
    };
    /* In a narrow side bar the submenu can open on top of `item` itself, and Playwright would keep waiting for `item` to
       be uncovered. */
    const subOpenFor = (item) => item.evaluate((b) => b.getAttribute('aria-expanded') === 'true' && !!document.querySelector('.cp-ctx-sub')).catch(() => false);
    const openSubOf = async (item) => {
      for (let n = 1; n <= 3; n++) {
        if (await subOpenFor(item)) return n;
        if (n === 1) await item.hover({ timeout: 3000 }).catch(() => {});
        else await item.press('ArrowRight', { timeout: 3000 }).catch(() => {});
        if (await until(() => subOpenFor(item), 2000, 100)) return n;
      }
      return 0;
    };
    const hovered = (n, what) => { if (n > 1) note(`${what}: its submenu opened on try ${n}, with →, after resting on it opened none`); };
    const pick = async (t, labels) => {
      await list.evaluate(() => {
        window.__landed = [];
        if (window.__landedHook) return;
        window.__landedHook = true;
        window.addEventListener('click', (e) => {
          const item = e.target.closest && e.target.closest('.cp-ctx-item');
          window.__landed.push(item ? item.textContent.trim() : `outside the menu (${e.target.className || e.target.tagName})`);
        }, true);
        window.addEventListener('blur', () => window.__landed.push('the page lost the focus'));
      });
      const said = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        await closeMenus();
        await list.evaluate(() => { window.__landed = []; });
        await row(t).click({ button: 'right' });
        await until(() => list.evaluate(() => !!document.querySelector('.cp-ctx')), 5000, 100);
        const main = list.locator('.cp-ctx:not(.cp-ctx-sub) .cp-ctx-item').filter({ hasText: labels[0] }).first();
        const lostFocus = () => list.evaluate(() => window.__landed.includes('the page lost the focus'));
        try {
          if (labels.length > 1) {
            const n = await openSubOf(main);
            if (!n) throw new Error(`${labels[0]} opened no submenu in three hovers`);
            hovered(n, labels[0]);
            await list.locator('.cp-ctx-sub .cp-ctx-item').filter({ hasText: labels[1] }).first().click({ timeout: 5000 });
          } else await main.click({ timeout: 5000 });
        } catch (e) {
          if (!await lostFocus()) throw e;
          said.push(`the menu closed before the click: ${e.message.split('\n')[0]}`);
          continue;
        }
        const landed = await list.evaluate(() => window.__landed.slice());
        const last = labels[labels.length - 1];
        if (landed.some((x) => x === last || x.startsWith(last))) return attempt;
        said.push(landed.join(', ') || 'nothing recorded');
        if (!landed.includes('the page lost the focus')) throw new Error(`the click on ${labels.join(' > ')} landed elsewhere: ${said.join('; ')}`);
        await sleep(500);
      }
      throw new Error(`the menu kept closing before ${labels.join(' > ')} could be clicked: ${said.join('; ')}`);
    };
    const retried = (n, what) => { if (n > 1) note(`${what} took ${n} tries: the session list lost the focus while its menu was open`); };
    await step('session list', async () => {
      await exec('workbench.view.extension.codexPlus');
      list = await frameWhere(() => !!document.querySelector('.cp-root'), 30000);
      check(!!list, 'the session list opens in its own activity bar container');
      if (!list) return;
      const titles = await until(async () => {
        const got = await list.evaluate(() => [...document.querySelectorAll('.cp-row .cp-title')].map((e) => e.textContent));
        return threads.every((t) => got.includes(t.title)) && got;
      }, 30000, 500);
      check(!!titles, `it lists the ${threads.length} made-up conversations by their titles`, titles);
      /* On macOS and Windows the window is 1024 px, which makes the list narrow enough to test this. */
      const icons = await list.evaluate(() => [...document.querySelectorAll('.cp-new')].map((b) => {
        const i = b.querySelector('svg');
        return i ? Math.round(i.getBoundingClientRect().width) : 0;
      }));
      check(icons.length === 2 && icons.every((x) => x === 16), 'New in tab and New in sidebar each keep their 16 px icon', icons);
      await page.mouse.move(5, 880);
      await sleep(300);
      await shot('session-list');
      await still(row(threads[1]));
      const r = await row(threads[1]).boundingBox();
      const time = await row(threads[1]).locator('.cp-time').boundingBox();
      /* The mask starts 40 px left of the time: "1m" is narrower than "now", and the title's ellipsis moves with it. */
      if (r) base.compare('session-row', await crop(r), { masks: within(r, [time && { ...time, x: time.x - 40, width: time.width + 40 }]) });

      await list.evaluate(() => {
        window.__ctx = [];
        window.addEventListener('contextmenu', (e) => window.__ctx.push({ prevented: e.defaultPrevented }));
      });
      await row(threads[1]).click({ button: 'right' });
      const menu = await until(() => list.evaluate(() => {
        const m = [...document.querySelectorAll('.cp-ctx')].filter((x) => !x.classList.contains('cp-ctx-sub'));
        return m.length && { count: m.length, labels: [...m[0].querySelectorAll('.cp-ctx-item')].map((x) => (x.childNodes[0] ? x.childNodes[0].textContent : '')) };
      }), 5000, 200);
      const ctx = await list.evaluate(() => window.__ctx);
      check(!!menu && menu.count === 1 && ['Codex Plus: Resume in Tab', 'Codex Plus: Text Color'].every((l) => menu.labels.includes(l))
        && !menu.labels.includes('Codex Plus: Add to Group'), 'a right-click on a row opens the list\'s own menu, with Resume in Tab and Text Color, and no Add to Group while there is no group', menu);
      check(ctx.length === 1 && ctx[0].prevented && !await visibleNativeMenu(), 'the right-click is cancelled in the page, and no menu of VS Code\'s opens over it', { ctx, nativeMenu: await visibleNativeMenu() });
      await shot('session-row-menu');
      await still(list.locator('.cp-ctx:not(.cp-ctx-sub)').first());
      const mbox = await list.locator('.cp-ctx:not(.cp-ctx-sub)').first().boundingBox();
      if (mbox) base.compare('row-menu', await crop(mbox));

      const item = (label) => list.locator('.cp-ctx-item').filter({ hasText: label }).first();
      hovered(await openSubOf(item('Codex Plus: Text Color')), 'Text Color');
      const sub = await until(() => list.evaluate(() => { const s = document.querySelector('.cp-ctx-sub'); return s && [...s.querySelectorAll('.cp-ctx-item')].map((x) => x.textContent.trim()); }), 5000, 200);
      check(!!sub && sub[0].startsWith('Default') && ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange', 'Pink', 'Cyan'].every((c) => sub.includes(c)),
        'resting on Text Color opens its submenu beside it: Default and the eight colours', sub);
      await shot('session-text-color');
      await still(list.locator('.cp-ctx-sub').first());
      const sbox = await list.locator('.cp-ctx-sub').first().boundingBox();
      if (sbox) base.compare('text-color-submenu', await crop(sbox));
      const colourOf = () => row(threads[1]).locator('.cp-title').evaluate((e) => getComputedStyle(e).color);
      const was = await colourOf();
      retried(await pick(threads[1], ['Codex Plus: Text Color', 'Red']), 'Text Color > Red');
      const now = await until(async () => { const c = await colourOf(); return c === RED_TITLE && c; }, 10000, 300);
      check(!!now && (await list.evaluate(() => document.querySelectorAll('.cp-ctx').length)) === 0,
        'clicking Red closes the menu and draws that row\'s title in the theme\'s red', { was, now: await colourOf() });
      await shot('session-row-red');

      await start('codexPlus.newGroup');
      const input = page.locator('.quick-input-widget input').first();
      await input.waitFor({ state: 'visible', timeout: 10000 });
      await input.fill('Release 1.2');
      await input.press('Enter');
      const made = await until(() => list.evaluate(() => [...document.querySelectorAll('.cp-group-name')].map((e) => e.textContent).includes('Release 1.2')), 20000, 500);
      if (!made) {
        note('New group did not put a group in the list, so Add to Group was not tried: Codex\'s app-server here may not have its section methods');
        await shot('session-no-group');
        return;
      }
      check(true, 'New group makes a group the list shows');
      await row(threads[1]).click({ button: 'right' });
      await until(() => list.evaluate(() => !!document.querySelector('.cp-ctx')), 5000, 200);
      hovered(await openSubOf(item('Codex Plus: Add to Group')), 'Add to Group');
      const groupsSub = await until(() => list.evaluate(() => { const s = document.querySelector('.cp-ctx-sub'); return s && [...s.querySelectorAll('.cp-ctx-item')].map((x) => x.textContent.trim()); }), 5000, 200);
      check(!!groupsSub && groupsSub.includes('Release 1.2'), 'resting on Add to Group opens a submenu of the groups made', groupsSub);
      await shot('session-add-to-group');
      await still(list.locator('.cp-ctx-sub').first());
      const gbox = await list.locator('.cp-ctx-sub').first().boundingBox();
      if (gbox) base.compare('add-to-group-submenu', await crop(gbox));
      retried(await pick(threads[1], ['Codex Plus: Add to Group', 'Release 1.2']), 'Add to Group > Release 1.2');
      const moved = await until(() => list.evaluate((id) => {
        const g = [...document.querySelectorAll('.cp-group')].find((x) => (x.querySelector('.cp-group-name') || {}).textContent === 'Release 1.2');
        return !!(g && g.querySelector(`.cp-row[data-id="${id}"]`));
      }, threads[1].id), 20000, 500);
      check(!!moved, 'and clicking the group moves the row into it', moved ? undefined : { toasts: await toasts(), codex: await call(`
        ${OWN}
        const p = own('patching');
        return { sections: await p.hostRequest('threadSection/list', {}),
          thread: await p.hostRequest('thread/read', { threadId: arg }) };`, threads[1].id).catch((e) => e.message) });
      await shot('session-row-grouped');

      /* The side bar is widened by dragging its edge for this menu, as the window gives it room to be, then put back, so
         the steps after it draw at the width they always had. */
      const sideWidth = () => page.evaluate(() => Math.round(document.getElementById('workbench.parts.sidebar').getBoundingClientRect().width));
      const dragSide = async (by) => {
        const edge = await page.evaluate(() => {
          const b = document.getElementById('workbench.parts.sidebar').getBoundingClientRect();
          const s = [...document.querySelectorAll('.monaco-sash.vertical')].map((e) => e.getBoundingClientRect())
            .find((r) => r.height > 100 && Math.abs((r.left + r.right) / 2 - b.right) < 4);
          return s && { x: (s.left + s.right) / 2, y: b.top + b.height / 2 };
        });
        if (!edge) return;
        await page.mouse.move(edge.x, edge.y);
        await page.mouse.down();
        await page.mouse.move(edge.x + by, edge.y, { steps: 10 });
        await page.mouse.up();
        await sleep(600);
      };
      const narrow = await sideWidth();
      await dragSide(160);
      const wide = await sideWidth();
      await list.locator('.cp-group-head').filter({ hasText: 'Release 1.2' }).first().click({ button: 'right' });
      const headMenu = await until(() => list.evaluate(() => {
        const m = document.querySelector('.cp-ctx:not(.cp-ctx-sub)');
        return m && { width: Math.round(m.getBoundingClientRect().width), view: innerWidth,
          items: [...m.querySelectorAll('.cp-ctx-item')].map((x) => ({ label: x.textContent.trim(), cut: x.scrollWidth > x.clientWidth })) };
      }), 5000, 200);
      await still(list.locator('.cp-ctx:not(.cp-ctx-sub)').first());
      await shot('session-group-menu');
      check(wide >= narrow + 100 && !!headMenu && headMenu.items.some((i) => i.label === 'Codex Plus: Start New Session in This Group') && headMenu.items.every((i) => !i.cut),
        'a right-click on a group\'s header in a side bar with room opens its menu, with Start New Session in This Group, and every label in it shown whole',
        { sideBar: [narrow, wide], menu: headMenu });
      await closeMenus();
      await dragSide(narrow - await sideWidth());
      const back = await sideWidth();
      if (Math.abs(back - narrow) > 1) note(`the side bar went back to ${back} px, not the ${narrow} px it had`);
    });

    /* The made-up conversation that no other step uses is archived, unarchived and archived again, then deleted from
       Archived sessions: the first confirmation is cancelled and the second accepted. */
    await step('archive and delete', async () => {
      if (!list) throw new Error('the session list did not open');
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
      /* How many lines the size in the confirmation's detail, such as "11.6 KB", is drawn on. */
      const sizeLines = () => page.evaluate(() => {
        const d = [...document.querySelectorAll('.monaco-dialog-box')].find((e) => e.offsetParent);
        const el = d && d.querySelector('.dialog-message-detail');
        if (!el) return null;
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const m = /\d+(?:\.\d+)?\s(?:B|KB|MB)\)/.exec(n.nodeValue);
          if (!m) continue;
          const r = document.createRange();
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
          return new Set([...r.getClientRects()].filter((b) => b.width > 0).map((b) => Math.round(b.top))).size;
        }
        return 0;
      });
      const listed = () => list.evaluate((id) => !!document.querySelector(`.cp-row[data-id="${id}"]`), t.id);
      const shelved = () => list.evaluate((id) => !!document.querySelector(`.cp-group[data-key="archived"] .cp-row[data-id="${id}"]`), t.id);
      const shelfOpen = () => list.evaluate(() => { const g = document.querySelector('.cp-group[data-key="archived"]'); return g ? g.classList.contains('cp-open') : null; });
      check(under('sessions').length === 1 && await listed(), 'the conversation to archive is listed and has its rollout in the made-up Codex home', rollouts());
      retried(await pick(t, ['Codex Plus: Archive']), 'Archive');
      const archived = await until(async () => await shelved() && under('archived_sessions').length === 1 && under('sessions').length === 0, 30000, 500);
      check(!!archived, 'Archive puts it in Archived sessions, and Codex moves its rollout to archived_sessions/', { rollouts: rollouts(), toasts: await toasts() });
      check(await shelfOpen() === false, 'Archived sessions is drawn collapsed until it is opened', await shelfOpen());
      await list.locator('.cp-group[data-key="archived"] .cp-group-head').first().click();
      await until(async () => await shelfOpen() === true, 5000, 200);
      await shot('archived-sessions');
      retried(await pick(t, ['Codex Plus: Unarchive']), 'Unarchive');
      const back = await until(async () => !await shelved() && await listed() && under('sessions').length === 1, 30000, 500);
      check(!!back, 'Unarchive puts it back among the others, and its rollout back under sessions/', { rollouts: rollouts(), toasts: await toasts() });
      retried(await pick(t, ['Codex Plus: Archive']), 'Archive');
      if (!await until(shelved, 30000, 500)) throw new Error('the second Archive did not put it in Archived sessions');
      retried(await pick(t, ['Codex Plus: Delete Conversation...']), 'Delete Conversation...');
      const asked = await until(dialog, 15000, 300);
      if (!asked) {
        note(`no confirmation drawn in the window was found on ${process.platform}, so Delete was not tried here: VS Code may have shown the system's own dialog`);
        await shot('delete-no-dialog');
        return;
      }
      await shot('delete-confirmation');
      check(asked.title === `Delete "${t.title}" from disk?` && asked.buttons.includes('Delete') && asked.buttons.includes('Cancel')
        && asked.detail.startsWith(`"${t.title}": the rollout`) && /This cannot be undone\.$/.test(asked.detail),
      'Delete Conversation... opens VS Code\'s modal confirmation, naming the conversation and what goes, with Delete and Cancel', asked);
      const sizeOn = await sizeLines();
      check(sizeOn === 1, 'the size in the confirmation is drawn on one line, its number beside its unit', { lines: sizeOn, detail: asked.detail });
      await press('Cancel');
      await until(async () => !await dialog(), 5000, 200);
      await sleep(1500);
      check(!await dialog() && await listed() && rollouts().length === 1, 'Cancel closes it and deletes nothing', { dialog: await dialog(), rollouts: rollouts() });
      retried(await pick(t, ['Codex Plus: Delete Conversation...']), 'Delete Conversation...');
      if (!await until(dialog, 15000, 300)) throw new Error('the second Delete opened no confirmation');
      await press('Delete');
      const gone = await until(async () => !await listed() && rollouts().length === 0, 30000, 500);
      check(!!gone, 'Delete deletes it: its row leaves the list and its rollout the Codex home', { listed: await listed(), rollouts: rollouts(), toasts: await toasts() });
      await shot('delete-done');
    });

    let codex = null;
    const title = threads[0].title;
    await step('a conversation in a tab', async () => {
      if (!list) throw new Error('the session list did not open');
      const groups = (await tabs()).length;
      retried(await pick(threads[0], ['Codex Plus: Resume in Tab']), 'Resume in Tab');
      const open = await until(async () => { const t = await tabs(); const x = t.flatMap((g) => g.tabs).find((y) => y.label === title); return x && x.active && t; }, 20000, 500);
      check(!!open && open.length === groups, 'Resume in Tab opens the conversation in a tab of the group there, titled by the conversation', open || await tabs());
      codex = await frameWhere((want) => {
        return !!document.querySelector('[data-codex-composer-root]') && document.querySelectorAll('[data-turn-key]').length >= 4
          && document.body.innerText.includes(want);
      }, 90000, title);
      check(!!codex, 'Codex draws the conversation in that tab, every turn of it, with its message box');
      await shot('conversation-tab');
    });

    await step('Codex\'s page', async () => {
      if (!codex) throw new Error('the conversation did not open');
      await sleep(2000);
      const seen = await codex.evaluate(() => ({
        user: document.querySelectorAll('.codex-extras-stamp-user').length, assistant: document.querySelectorAll('.codex-extras-stamp-assistant').length,
        rail: !!document.querySelector('.codex-extras-rail'),
        railAt: (() => { const r = document.querySelector('.codex-extras-rail'); if (!r) return null; const b = r.getBoundingClientRect();
          return { top: b.top, off: Math.abs(b.top + b.height / 2 - innerHeight / 2) }; })(),
        buttons: document.querySelectorAll('[data-codex-extras="bar-button"]').length,
        meter: !!document.querySelector('[data-codex-extras="meter"]'), pill: ((document.querySelector('[data-codex-extras="agents"]') || {}).innerText || '').trim(),
        turns: document.querySelectorAll('[data-turn-key]').length }));
      check(seen.user === 4 && seen.assistant >= 4, 'each of the four messages and replies carries a time stamp', seen);
      check(seen.rail, 'the rail at the right edge is drawn', seen);
      check(!!seen.railAt && Number.isInteger(seen.railAt.top) && seen.railAt.off <= 1, 'and is centred on a whole pixel, so its arrows are drawn sharp', seen.railAt);
      check(seen.buttons === 2 && seen.meter, 'the information and chime buttons and the context meter are by the message box', seen);
      check(/1 timer/.test(seen.pill), 'the Agent map pill names the wake-up the conversation has', seen.pill);
      /* Each crop is one control, so none takes in Codex's buttons or the gap before the pill, which moves by a pixel. */
      const frameBox = await (await codex.frameElement()).boundingBox();
      for (const [name, sel] of [['composer-buttons', '[data-codex-extras="bar-button"]'], ['composer-meter', '[data-codex-extras="meter"]'], ['composer-pill', '[data-codex-extras="agents"]']]) {
        const r = await codex.evaluate((q) => {
          const all = [...document.querySelectorAll(q)].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0);
          return all.length ? { x0: Math.min(...all.map((b) => b.left)), y0: Math.min(...all.map((b) => b.top)), x1: Math.max(...all.map((b) => b.right)), y1: Math.max(...all.map((b) => b.bottom)) } : null;
        }, sel);
        if (r && frameBox) base.compare(name, await crop({ x: frameBox.x + r.x0 - 2, y: frameBox.y + r.y0 - 2, width: r.x1 - r.x0 + 4, height: r.y1 - r.y0 + 4 }));
      }

      await codex.locator('.codex-extras-rail-handle').first().click();
      const rows = await until(() => codex.evaluate(() => {
        const p = document.querySelector('.codex-extras-panel');
        return p && getComputedStyle(p).display !== 'none' && [...p.querySelectorAll('.codex-extras-row')].map((x) => x.textContent);
      }), 5000, 200);
      check(!!rows && rows.length === 4 && rows.every((t) => /^(\d\d\/\d\d )?\d\d:\d\d:\d\d {2}\S/.test(t)), 'the rail\'s handle opens the list of your messages, one row each with its time', rows);
      await shot('conversation-rail-list');
      await codex.locator('.codex-extras-rail-handle').first().click();

      await codex.locator('[data-codex-extras="agents"]').first().click();
      const map = await until(() => codex.evaluate(() => {
        const d = document.querySelector('[data-codex-extras="map-dialog"]');
        const s = d && d.querySelector('[data-codex-extras="map-wakeups"]');
        return d && { text: d.innerText, prompt: s ? s.textContent : '', wakeups: !!s, remove: !!d.querySelector('[data-codex-extras-act="removeWakeup"]') };
      }), 5000, 200);
      check(!!map && map.wakeups && map.remove && /every 45 min/.test(map.text) && /nightly export/.test(map.prompt),
        'the pill opens the Agent map, with the wake-up\'s interval, its prompt and Remove', map);
      await shot('agent-map');
      const dialog = codex.locator('[data-codex-extras="map-dialog"]').first();
      await still(dialog);
      const dbox = await dialog.boundingBox();
      check(!!dbox && [dbox.x, dbox.y].every((v) => Math.abs(v - Math.round(v)) < 0.01),
        'the Agent map sits on whole pixels, so its lines of text are drawn in the same place every time', dbox);
      const times = await dialog.locator('[data-codex-extras="map-wakeups"] summary span:nth-child(2)').boundingBox().catch(() => null);
      /* A next wake-up after midnight carries its date, which widens the dialog past the approved copy. */
      const dated = !!map && /next \d\d\/\d\d/.test(map.text);
      if (dbox && !dated) base.compare('agent-map-dialog', await crop(dbox), { masks: within(dbox, [times]) });
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
      await shot('context-meter-hover');
      /* Jumping the pointer from the meter to the window's corner leaves the hover open. The hover takes the click meant
         for the message box, and every click after it. The pointer goes to the top of the conversation, above the hover,
         which reaches up over the middle of it. */
      const talk = await codex.locator('[data-app-action-timeline-scroll]').first().boundingBox();
      await page.mouse.move(talk ? talk.x + 30 : 0, talk ? talk.y + 15 : 0);
      check(!!await until(() => codex.evaluate(() => {
        const b = document.querySelector('[data-codex-extras="context"]');
        return !b || getComputedStyle(b).display === 'none';
      }), 5000, 200), 'and closes once the pointer leaves the meter');
    });

    await step('the dot on a tab', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const before = await dotsOn(title);
      check(!!before && before.working === 0 && before.unread === 0, 'an idle conversation\'s tab has no dot', before);
      model.hold();
      const turns = model.turns();
      await codex.locator('[data-codex-composer-root] [contenteditable="true"]').first().click();
      await page.keyboard.type('Run the tests again.');
      await page.keyboard.press('Enter');
      check(!!await until(() => model.turns() > turns, 20000, 300), 'a message sent from the tab reaches the made-up model', model.seen.slice(-3));
      const working = await until(async () => { const d = await dotsOn(title); return d && d.working >= 6 && d; }, 20000, 500);
      check(!!working, 'while the turn runs the tab\'s logo carries the green dot', await dotsOn(title));
      await shot('tab-dot-working');
      await openNotes();
      await sleep(800);
      model.release();
      const unread = await until(async () => { const d = await dotsOn(title); return d && d.unread >= 6 && d.working === 0 && d; }, 30000, 500);
      check(!!unread, 'once the reply lands with the tab not in front, the dot turns red', await dotsOn(title));
      const bell = await until(() => page.evaluate(() => {
        const e = [...document.querySelectorAll('.statusbar-item')].find((x) => x.querySelector('.codicon-bell-dot'));
        return e ? e.innerText.trim() : '';
      }), 15000, 500);
      check(Number(bell) >= 1, 'Agent Plus counts it in the status bar among the conversations that need the user', bell);
      const toast = () => page.evaluate((t) => {
        const n = [...document.querySelectorAll('.notification-toast')].find((e) => e.innerText.includes(`"${t}" finished`));
        return n ? n.innerText : '';
      }, title);
      const notified = await focused() ? await until(toast, 15000, 500) : '';
      if (await focused()) check(!!notified, 'and, the window having the focus, says in a notification that it finished, with a link to open it', notified);
      else note(`the window does not have the system's focus on ${process.platform}, so Agent Plus showed no notification, as it should`);
      await shot('tab-dot-unread');
      const logo = await logoCrop(title);
      if (logo) base.compare('tab-dot-unread', logo);
      await page.locator('.tabs-container .tab').filter({ hasText: title }).first().click();
      await page.bringToFront().catch(() => {});
      const read = await until(async () => { const d = await dotsOn(title); return d && d.unread === 0 && d.working === 0 && d; }, 20000, 500);
      const inFront = await focused();
      if (read || inFront) check(!!read, 'and bringing the tab to the front clears it', { dots: await dotsOn(title), windowFocused: inFront });
      if (read && notified) check(!!await until(async () => !(await toast()), 15000, 500), 'and closes the notification that it finished');
      else note(`the window does not have the system's focus on ${process.platform}, so the reply stays unread, as it should; clearing the dot was not checked`);
      await shot('tab-dot-read');
    });

    await step('a conversation watched while its turn finishes', async () => {
      if (!codex) throw new Error('the conversation did not open');
      if (!await focused()) {
        note(`the window does not have the system's focus on ${process.platform}, so Agent Plus shows no notification anyway; not checked`);
        return;
      }
      await exec('notifications.clearAll');
      const counted = await bellCount();
      model.hold();
      const turns = model.turns();
      await codex.locator('[data-codex-composer-root] [contenteditable="true"]').first().click();
      await page.keyboard.type('Check the build once more.');
      await page.keyboard.press('Enter');
      const working = await until(async () => model.turns() > turns && ((await dotsOn(title)) || {}).working >= 6, 20000, 300);
      check(!!working, 'with its tab in front, a message sent from it starts a turn', await dotsOn(title));
      model.release();
      const ended = await until(async () => { const d = await dotsOn(title); return d && d.working === 0 && d; }, 30000, 500);
      await sleep(5000);
      const after = { ended: !!ended, dots: await dotsOn(title), counted: await bellCount(), notification: await toastAbout(title, 'finished') };
      check(after.ended && !!after.dots && after.dots.unread === 0 && after.counted <= counted && !after.notification,
        'when the reply lands with the tab in front of the focused window, the tab gets no red dot and Agent Plus neither announces nor counts it',
        { before: counted, ...after });
      await shot('tab-in-front-finished');
    });

    await step('work left running after a turn', async () => {
      if (!codex || !list) throw new Error('the conversation or the session list did not open');
      const id = threads[0].id;
      const rowNow = () => list.evaluate((want) => {
        const r = document.querySelector(`.cp-row[data-id="${want}"]`);
        return r && r._row ? { dot: String(r._row.dot || ''), running: String(r._row.running || '') } : null;
      }, id).catch(() => null);
      const now = async () => {
        const d = await dotsOn(title), r = await rowNow();
        return { tab: !!d && d.working >= 6, row: !!r && /^working/.test(r.dot), running: (r && r.running) || '', dots: d, rowDot: r && r.dot };
      };
      const send = async (text) => {
        await codex.locator('[data-codex-composer-root] [contenteditable="true"]').first().click();
        await page.keyboard.type(text);
        await page.keyboard.press('Enter');
      };
      const card = () => codex.evaluate(() => {
        const s = document.querySelector('[data-codex-approval-surface]');
        return s ? { text: s.innerText.slice(0, 300), buttons: [...s.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean) } : null;
      }).catch(() => null);
      const approve = async (name) => {
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
      const leftCase = async ({ name, words, steps, ask, end, ms = 45000, during, notice }) => {
        const notices = model.sent('Codex Plus notice');
        const counted = await bellCount();
        model.script(id, steps);
        await send(`Start the ${name} and come back.`);
        /* On Windows Codex asks before it runs even a sandboxed command; elsewhere only a command asked to run outside. */
        const shown = await until(async () => (await card()) || (!ask && model.left() === 0 && 'none'), 20000, 300);
        if (ask) check(!!shown && shown !== 'none', `${name}: Codex shows its card asking to run the command outside the sandbox`);
        if (shown && shown !== 'none') {
          note(`${name}: the card reads ${JSON.stringify(shown)}`);
          const blue = await until(async () => { const d = await dotsOn(title); return d && d.prompt >= 6 && d; }, 20000, 500);
          check(!!blue, `${name}: while Codex waits for the approval, the tab's logo carries the blue dot`, await dotsOn(title));
          if (await focused()) {
            await sleep(4000);
            const held = { counted: await bellCount(), notification: await toastAbout(title, 'is waiting for you') };
            check(held.counted <= counted && !held.notification,
              `${name}: and with the tab in front of the focused window, Agent Plus neither announces nor counts it`, { before: counted, ...held });
          }
          await shot(`left-${name.replace(/\W+/g, '-')}-approval`);
          await approve(name);
        }
        const after = await until(async () => { const g = await now(); return model.left() === 0 && g.running.includes(words) && g.tab && g.row && g; }, 40000, 500);
        check(!!after, `${name}: after its turn has ended, the tab's logo and the conversation's row in the session list stay green, and the row's hover says "${words}"`,
          after || { left: model.left(), ...await now(), held: await call(`${OWN}
            const a = own('patching')._approvals;
            return { waiting: a.of(arg), threads: a.threads(), sinceMs: a.since ? a.since(arg) : null };`, id).catch((e) => String(e)) });
        await shot(`left-${name.replace(/\W+/g, '-')}`);
        if (during) await during();
        if (end) end();
        const gone = await until(async () => { const g = await now(); return !g.tab && !g.row && !g.running.includes(words) && g; }, ms, 1000);
        check(!!gone, `${name}: once that has finished, the green leaves both`, gone || { ...await now(), ...await why() });
        if (notice) {
          const told = await until(() => model.sent('Codex Plus notice') > notices && model.sent(notice) > 0, 60000, 1000);
          check(!!told, `${name}: and the conversation is sent a notice that it is no longer running, naming it and saying its exit code `
            + 'cannot be known', { notices: model.sent('Codex Plus notice'), named: model.sent(notice), exitCode: model.sent('exit code cannot be known') });
          await until(async () => !(await dotsOn(title) || {}).working, 30000, 1000);
        }
      };
      await leftCase({ name: 'background command', words: 'A background command is still running',
        steps: [{ call: 'exec_command', args: { cmd: process.platform === 'win32' ? 'Start-Sleep -Seconds 25' : 'sleep 25', yield_time_ms: 1000 } },
          { reply: 'Started the job.' }] });
      await leftCase({ name: 'sub-agent', words: 'A sub-agent is still running', end: () => model.releaseOthers(),
        steps: [{ call: 'spawn_agent', namespace: 'collaboration', args: { task_name: 'job', message: 'Wait for the job.', fork_turns: 'none' } },
          { reply: 'Started a helper.' }] });
      if (process.platform === 'linux') {
        const outside = (cmd) => ({ call: 'exec_command', args: { cmd, yield_time_ms: 1000, sandbox_permissions: 'require_escalated',
          justification: 'Start the job outside the sandbox.' } });
        await leftCase({ name: 'detached shell', words: 'A command it detached is still running', ask: true, ms: 70000,
          notice: 'sleep 45; true', steps: [outside("setsid nohup bash -c 'sleep 45; true' >/dev/null 2>&1 &"), { reply: 'Started the job.' }] });
        await leftCase({ name: 'program setsid started', words: 'A command it detached is still running', ask: true, ms: 70000,
          notice: 'sleep 47', steps: [outside('setsid sleep 47 >/dev/null 2>&1 < /dev/null &'), { reply: 'Started the job.' }],
          during: async () => {
            const pill = await until(async () => { const t = await pillText(); return /\b1 detached\b/.test(t) && t; }, 20000, 500);
            check(!!pill, 'program setsid started: the Agent map button counts it as detached', await pillText());
          } });
        const ext = fs.readdirSync(profile.exts).find((d) => d.startsWith('openai.chatgpt-'));
        const bin = ext ? codexBinary(path.join(profile.exts, ext)) : '';
        check(!!bin, 'the codex program of the Codex extension is found, for a codex exec to start', profile.exts);
        if (bin) {
          await leftCase({ name: 'codex exec', words: 'A codex exec it started is still running', ask: true, end: () => model.releaseOthers(),
            steps: [outside(`setsid nohup '${bin}' exec --skip-git-repo-check 'Wait for the job.' >/dev/null 2>&1 &`), { reply: 'Started a worker.' }] });
        }
      } else {
        note(`a detached shell, a program setsid started and a codex exec are found through /proc, which ${process.platform} does not have, `
          + 'so none of them is made here' + (process.platform === 'win32' ? '' : ', and no command waits for approval, so the blue dot is not checked'));
      }
      model.script(null);
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

    await step('the brief', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const plans = path.join(profile.codexHome, 'plugins', 'data', 'agent-work-plan-codex-extras');
      fs.mkdirSync(plans, { recursive: true });
      const at = new Date().toISOString().replace(/\.\d+Z$/, '+00:00');
      const summary = 'Made up for the window test: the brief of this conversation.';
      fs.writeFileSync(path.join(plans, `${threads[0].id}.json`), JSON.stringify({ nodes: [{ title: 'Check the brief', state: 'doing', since: at }],
        brief: { summary, summaryAt: at, status: { doing: 'Showing the brief', progress: 'Written', next: 'none' }, statusAt: at } }));
      await exec('agentPlus.refreshWorkPlan');
      await exec('agentPlus.showConversations');
      const row = page.locator('[id="workbench.parts.panel"] .monaco-list-row').filter({ hasText: title }).first();
      check(await row.waitFor({ state: 'visible', timeout: 30000 }).then(() => true, () => false), 'the conversation is listed in Agent Plus\'s Conversations panel');
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
      const back = await until(async () => { const t = (await tabs()).flatMap((g) => g.tabs).find((x) => x.active); return t && t.label === title && t; }, 15000, 500);
      check(!!back, 'the arrow at the end of its row goes to the conversation\'s tab', await tabs());
      await openNotes();
      if (brief) await brief.locator('#bopen').click({ timeout: 10000 });
      const again = await until(async () => { const t = (await tabs()).flatMap((g) => g.tabs).find((x) => x.active); return t && t.label === title && t; }, 15000, 500);
      check(!!again, 'and so does the button at the top of the brief', await tabs());
    });

    await step('a conversation in Codex\'s sidebar', async () => {
      const t = threads[1];
      /* Resume in Sidebar opens Codex's sidebar through a vscode:// link, and VS Code asks once before an extension
         opens one. */
      await call('vscode.commands.executeCommand("codexPlus.openThreadInSidebar", arg); return true;', t.id);
      const allow = page.locator('.monaco-dialog-box').filter({ hasText: 'open this URI' }).first();
      if (await allow.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)) {
        await allow.locator('.dialog-buttons .monaco-button').filter({ hasText: 'Open' }).first().click({ timeout: 5000 });
      }
      const side = await frameWhere((want) => innerWidth < 800 && document.body.innerText.includes(want)
        && document.querySelectorAll('.codex-extras-stamp-assistant').length >= 4, 90000, t.title);
      check(!!side, 'Resume in Sidebar draws the conversation in Codex\'s sidebar, with a stamp on each reply');
      if (!side) return;
      await shot('sidebar-conversation');
      const fit = await side.evaluate(() => [...document.querySelectorAll('.codex-extras-stamp-assistant')].filter((e) => e.getClientRects().length).map((e) => {
        const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect(), st = getComputedStyle(e);
        return { width: Math.round(r.width), column: Math.round(p.width), past: e.scrollWidth - e.clientWidth, over: Math.round(r.right - p.right),
          lines: Math.round(r.height / (parseFloat(st.fontSize) * 1.4)) };
      }));
      check(fit.length >= 4 && fit.every((x) => x.past <= 0 && x.over <= 1), 'in Codex\'s sidebar every reply\'s stamp stays inside its column', fit);
      if (fit.length && !fit.some((x) => x.lines >= 2)) note('Codex\'s sidebar was wide enough for every stamp, so none had to wrap');
      await exec('workbench.action.closeAuxiliaryBar');
    });

    await step('the token mode', async () => {
      /* The hooks read their settings from a file under CODEX_HOME on every message, so a mode chosen in the status bar
         has to be in that file at once. */
      const file = path.join(profile.codexHome, 'plugins', 'data', 'agent-work-plan-codex-extras', 'config.json');
      const hooks = () => { try { const h = JSON.parse(fs.readFileSync(file, 'utf8')); return [h.enabled, h.tellTimeZone, h.brief, h.skillRoute]; } catch (_) { return null; } };
      const before = hooks();
      check(JSON.stringify(before) === '[true,true,true,true]', 'with no mode chosen, which is All features, the hooks are given every feature', before);
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
      check(rows.length === 4 && /Essential features/.test(rows[1] || '') && /the work plan and the time-zone note, nothing else/.test(rows[1] || ''),
        'four modes, each with a line under its name saying what it runs', rows);
      await shot('token-mode-list');
      await list.filter({ hasText: 'Essential features' }).first().click();
      const after = await until(() => { const h = hooks(); return h && h[2] === false && h; }, 15000, 250);
      check(JSON.stringify(after) === '[true,true,false,false]',
        'choosing Essential features rewrites the hooks\' settings at once: the work plan and the time zone on, the brief and the skill search off', after);
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

    /* After every step that types into the conversation, since it is archived here. */
    await step('a conversation archived while its tab is open', async () => {
      if (!codex) throw new Error('the conversation did not open');
      const t = threads[0];
      const shelvedOnDisk = () => { try { return fs.readdirSync(path.join(profile.codexHome, 'archived_sessions'), { recursive: true }).some((n) => String(n).includes(t.id)); } catch (_) { return false; } };
      const drawn = (composer) => until(() => codex.evaluate((want) => document.querySelectorAll('[data-turn-key]').length > 0
        && !!document.querySelector('[data-codex-composer-root]') === want, composer).catch(() => false), 30000, 500);
      await page.locator('.tabs-container .tab').filter({ hasText: title }).first().click();
      await exec('codexPlus.archiveThread', { webviewSection: 'thread', threadId: t.id, webview: 'codexPlus.sessions' }, [t.id]);
      check(!!await until(shelvedOnDisk, 30000, 500), 'Archive moves the rollout of the conversation open in the tab to archived_sessions/');
      check(!!await drawn(false), 'the tab still shows the conversation\'s turns, read-only, with no message box');
      await shot('archived-while-open');
      await exec('codexPlus.openThreadInTab', t.id);
      check(!!await until(() => !shelvedOnDisk(), 30000, 500), 'opening it from the list unarchives it');
      check(!!await drawn(true), 'and the tab has its message box again');
    });

    let begun = null;
    await step('a conversation begun in a tab the tab bar button opened', async () => {
      if (!await focused()) {
        note(`the window does not have the system's focus on ${process.platform}, so Agent Plus shows no notification anyway; not checked`);
        return;
      }
      await panelTrace();
      await exec('notifications.clearAll');
      const fresh = await newTabPage();
      check(!!fresh, 'the tab bar button opens a new conversation page in a tab');
      if (!fresh) return;
      const counted = await bellCount();
      const text = 'Draft the release notes for 1.2.';
      model.hold();
      const turns = model.turns();
      await fresh.locator(COMPOSER).first().click();
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
      check(!!await until(() => model.turns() > turns, 20000, 300), 'its first message reaches the made-up model', model.seen.slice(-3));
      const id = await until(() => rolloutWith(text), 20000, 500);
      const named = await until(async () => { const t = await frontTab(); return t && t.label !== 'Codex' && t.label.startsWith(text.slice(0, 20)) && t; }, 30000, 500);
      check(!!named, 'while that turn runs, the tab is titled by the conversation Codex made of the message', { thread: id, tab: await frontTab(), patch: await panelTrace() });
      const front = await until(() => agentFront() === `codex ${id}`, 15000, 500);
      check(!!id && !!front, 'and Agent Plus has that conversation in front', { thread: id, agentPlus: agentFront(), patch: await panelTrace() });
      model.release();
      const ended = await until(() => fresh.evaluate((r) => document.body.innerText.includes(r), REPLY).catch(() => false), 30000, 500);
      await sleep(5000);
      const after = { ended: !!ended, counted: await bellCount(), notification: await toastAbout(named ? named.label : text, 'finished') };
      check(after.ended && after.counted <= counted && !after.notification,
        'when its reply lands with the tab in front of the focused window, Agent Plus neither announces nor counts it', { before: counted, ...after });
      await shot('tab-bar-conversation');
      if (id && named) begun = { id, label: named.label };
    });

    await step('a conversation\'s tab brought back to the front', async () => {
      const t = threads[0];
      const toFront = async (label, want, from) => {
        await page.locator('.tabs-container .tab').filter({ hasText: label }).first().click();
        const ok = await until(() => agentFront() === want, 15000, 500);
        check(!!ok, `a click on the tab of a conversation whose URI names it, from ${from}, puts that conversation in front for Agent Plus`,
          { want, agentPlus: agentFront(), tab: await frontTab(), patch: await panelTrace() });
      };
      const empty = await newTabPage();
      if (!empty) throw new Error('the tab bar button opened no new conversation page');
      check(!!await until(() => agentFront() === 'codex (no session yet)', 15000, 500), 'a new tab nothing was typed into has no conversation in front for Agent Plus', agentFront());
      await toFront(title, `codex ${t.id}`, 'a new tab nothing was typed into');
      if (!begun) { note('no conversation was begun in a tab the tab bar button opened, so the switch from one was not checked'); return; }
      await page.locator('.tabs-container .tab').filter({ hasText: begun.label }).first().click();
      check(!!await until(() => agentFront() === `codex ${begun.id}`, 15000, 500), 'the tab of the conversation begun in a new tab puts it in front', agentFront());
      await toFront(title, `codex ${t.id}`, 'the tab of a conversation begun in a new tab');
    });
  } finally {
    watchingTrust = false;
    await trustWatch;
    if (trustCancelled) note(`the dialog asking to trust the work plan hooks was cancelled ${trustCancelled} time(s)`);
    await shot('last');
    await w.close();
  }
}

module.exports = { run };
