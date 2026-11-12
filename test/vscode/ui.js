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
 *   Codex's page what the patch adds there: the time stamps, the rail, the buttons by the message box, the Agent map,
 *                and the Work plan line on the context meter's hover
 *   the brief    a click on the conversation in Agent Plus's Conversations panel shows the brief its plan holds in the
 *                Answer view; the arrow on its row and the page's button each go back to the conversation's tab
 *   the sidebar  a conversation resumed in Codex's sidebar: each reply's stamp inside its column
 *
 * Every step saves a screenshot to <out>/shots, and crops of the parts this extension draws are compared with the
 * approved copies (lib/baseline.js).
 */
const fs = require('fs');
const path = require('path');
const win = require('./lib/window');
const { baselines } = require('./lib/baseline');
const pixels = require('./lib/pixels');

const { sleep, until } = win;
const TITLES = { tab: 'Codex Plus: New Codex Conversation in a Tab', sidebar: 'Codex Plus: Open Codex Sidebar', codex: 'Open Codex Sidebar' };
/* TAB_DOTS in src/patching.js. */
const DOTS = { working: [0x22, 0xc5, 0x5e], unread: [0xef, 0x44, 0x44], prompt: [0x3b, 0x82, 0xf6] };
/* The theme colour Text Color's Red gives a title, in the Dark Modern theme run.js sets. */
const RED_TITLE = 'rgb(241, 76, 76)';

async function run({ exe, profile, env, playwright, model, threads, out, check, note }) {
  const shotsDir = path.join(out, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const base = baselines({ out, check, note });
  let shotNo = 0;
  const w = await win.open({ exe, profile, env, playwright, log: path.join(out, 'vscode-window.log') });
  const { page, call } = w;
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
     the page itself snaps them: a size such as 258.5 px rounded alone comes out as 258 in one run and 259 in the next. */
  const crop = (box) => {
    const x = Math.round(box.x), y = Math.round(box.y);
    return page.screenshot({ animations: 'disabled', clip: { x, y, width: Math.round(box.x + box.width) - x, height: Math.round(box.y + box.height) - y } });
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
  const trustWatch = (async () => {
    while (watchingTrust) {
      try {
        const box = page.locator('.monaco-dialog-box').filter({ hasText: 'Trust the work plan hooks in Codex?' }).first();
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
        const mine = vscode.extensions.getExtension('xnervwang.codex-plus');
        const p = require(require('path').join(mine.extensionPath, 'src', 'patching'));
        return { sections: await p.hostRequest('threadSection/list', {}),
          thread: await p.hostRequest('thread/read', { threadId: arg }) };`, threads[1].id).catch((e) => e.message) });
      await shot('session-row-grouped');
    });

    /* Delete the made-up conversation that no other step uses: cancel the first confirmation, accept the second. */
    await step('delete', async () => {
      if (!list) throw new Error('the session list did not open');
      const t = threads[2];
      const rollouts = () => fs.readdirSync(path.join(profile.codexHome, 'sessions'), { recursive: true }).filter((n) => String(n).includes(t.id));
      const dialog = () => page.evaluate(() => {
        const d = [...document.querySelectorAll('.monaco-dialog-box')].find((e) => e.offsetParent);
        if (!d) return null;
        const text = (sel) => { const e = d.querySelector(sel); return e ? e.innerText.trim() : ''; };
        return { title: text('.dialog-message-text'), detail: text('.dialog-message-detail'),
          buttons: [...d.querySelectorAll('.dialog-buttons .monaco-button')].map((b) => b.innerText.trim()) };
      });
      const press = (label) => page.locator('.monaco-dialog-box .dialog-buttons .monaco-button').filter({ hasText: label }).first().click({ timeout: 5000 });
      const listed = () => list.evaluate((id) => !!document.querySelector(`.cp-row[data-id="${id}"]`), t.id);
      check(rollouts().length === 1 && await listed(), 'the conversation to delete is listed and has its rollout in the made-up Codex home', rollouts());
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
      const times = await dialog.locator('[data-codex-extras="map-wakeups"] summary span:nth-child(2)').boundingBox().catch(() => null);
      if (dbox) base.compare('agent-map-dialog', await crop(dbox), { masks: within(dbox, [times]) });
      await page.keyboard.press('Escape');
      check(!!await until(() => codex.evaluate(() => !document.querySelector('[data-codex-extras="map-dialog"]')), 5000, 200), 'Esc closes it');

      const infoButton = codex.locator('[data-codex-extras="bar-button"][aria-label^="About this conversation"]').first();
      await infoButton.click();
      const info = await until(() => codex.evaluate(() => {
        const b = document.querySelector('[data-codex-extras="info"]');
        return b && getComputedStyle(b).display !== 'none' && b.innerText;
      }), 10000, 200);
      check(!!info && /Token mode/.test(info) && !/Work plan/.test(info), 'the information box names the token mode, and leaves the work plan to the context meter', info);
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
      await page.mouse.move(0, 0);
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
      await shot('tab-dot-unread');
      const logo = await logoCrop(title);
      if (logo) base.compare('tab-dot-unread', logo);
      await page.locator('.tabs-container .tab').filter({ hasText: title }).first().click();
      await page.bringToFront().catch(() => {});
      const read = await until(async () => { const d = await dotsOn(title); return d && d.unread === 0 && d.working === 0 && d; }, 20000, 500);
      const inFront = await focused();
      if (read || inFront) check(!!read, 'and bringing the tab to the front clears it', { dots: await dotsOn(title), windowFocused: inFront });
      else note(`the window does not have the system's focus on ${process.platform}, so the reply stays unread, as it should; clearing the dot was not checked`);
      await shot('tab-dot-read');
      note('the blue dot of a turn waiting for approval is not made here: the made-up model sends replies only, never a command to approve');
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
  } finally {
    watchingTrust = false;
    await trustWatch;
    if (trustCancelled) note(`the dialog asking to trust the work plan hooks was cancelled ${trustCancelled} time(s)`);
    await shot('last');
    await w.close();
  }
}

module.exports = { run };
