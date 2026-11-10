# Codex Plus

## What it looks like

A Codex conversation, with Agent Plus's work plan for it on the left:

![A Codex conversation beside its work plan in Agent Plus](images/codex-plus-work-plan.png)

The Codex sessions list in the Codex Plus sidebar:

![The Codex sessions list](images/codex-plus-sessions.png)

## Features

| Feature | Where | Needs |
| --- | --- | --- |
| Codex conversations in the work plan, Conversations and Answer views | Agent Plus's views | Agent Plus (installed with this extension) |
| Work plan per conversation: rows with states, numbered, kept across turns and compactions | Agent Plus's Work plan view; Codex's context every turn | Work plan plugin, its hooks trusted |
| Plan changes through MCP tools `set_row` / `add_row`, no sandbox approval | Codex | Work plan plugin |
| End-of-turn reminders: rows left `doing`, questions not on a row, plan not reconciled | Codex | Work plan plugin |
| Reminder to bring `doing` rows up to date before an automatic compaction, at 70% and 85% of where Codex compacts (90% of the model's window, or `model_auto_compact_token_limit` in `config.toml` when that is lower); pointer to the plan after one | Codex | Work plan plugin |
| Your time zone told to Codex when it runs on another machine, with this machine's zone and the time now; quiet while Codex's own page has told it the same zone since the last compaction (`<codex_apps_client_time_context>`) | Codex's context | Work plan plugin; the patch; `codexPlus.tellCodexYourTimeZone` |
| Answer a plan question from Agent Plus's Answer view: put in the conversation's message box (only when the box is empty) and sent, as Enter would send it; while a turn runs, Codex queues it or steers with it. The Answer view says whether it was sent, left as a draft, or refused because the box held a draft of yours | Codex tab, or Codex's sidebar when it shows the conversation | Patch; without the patch the answer stays in the Answer view |
| Recently closed, Open sessions, Pinned, the sections you made in Codex's own sidebar, Ungrouped, Archived sessions, each with its count. Recently closed has the conversation a tab showed when it closed, a tab opened with a New button included | Codex sessions view, in the Codex Plus sidebar | Patch, for a tab whose URI names no conversation |
| Each row's status dot, as Claude Code's list draws it: running green, waiting for you blue, replied and unread red, a failed last turn red, idle grey; running or waiting in another window, a ring of that colour | Codex sessions view | — |
| Open sessions covers tabs Codex opened with its own New button, whose URI names no conversation | Codex sessions view | Patch |
| Open sessions also lists the conversation Codex's sidebar shows while the sidebar is visible; clicking it goes to the sidebar. It is the conversation the sidebar last went to, so on the sidebar's own new-conversation page the one before is still listed | Codex sessions view | Patch |
| New in tab / New in sidebar; Resume in tab / Resume in sidebar | Codex sessions view | — (the sidebar ones open Codex's own link, `vscode://openai.chatgpt/local/<id>` in this editor's scheme) |
| Thread ID and group on hover; find by title or four hex characters of the ID | Codex sessions view | — |
| How long since it was last used and the first and last day it was, as `11d · 09/05→09/16`, how long written `now`, `5m`, `3h`, `2d`, `1mo` or `1y` and a date of another year with its year, as Claude Code's list writes them; title colours; conversations started by `codex exec` left out | Codex sessions view | `codexPlus.hideBackgroundSessions` |
| Delete archived conversations, one or several selected together | Codex sessions view, right-click | — |
| Rename, Archive (buttons on a row when hovered, and in its right-click menu), Unarchive, Move to Section (Codex's own sections; Claude Code calls it Add to Group) and Mark as Unread, several rows at once where that makes sense. All but the last are sent to this window's Codex app-server on Codex's own connection, or before the patch is in effect to a short-lived one; Mark as Unread is this extension's own read record | Codex sessions view | — |
| Rename, Mark as Unread and Move to Section in a Codex conversation tab's own right-click menu, as Claude Code has its three | Codex conversation tab | — |
| The row of the conversation in front is selected and scrolled to, as Claude Code's list follows it, while the list is visible; the focus stays where it was | Codex sessions view | — |
| Codex button on the tab bar, and New in tab: a new Codex conversation in a tab, in a group already holding only Codex tabs, else one holding any, else the first group (the main editor area); it never opens a new split. Codex's own button beside it opens its sidebar | Editor title bar; Codex sessions view | — |
| Tabs VS Code did not restore after a reconnect are opened again, and the status bar says how many for ten seconds, as Claude Code Plus says it | Editor tabs; status bar | `codexPlus.reopenDroppedTabs` |
| Session information: thread ID, the process id of Codex's server for this window, folder, the conversation log Codex writes (its rollout) and its size, how much of the context window is in use, tokens the conversation used, the account | The information button in the message box's toolbar, where clicking a value copies it | Patch; `codexPlus.infoButton` |
| Chimes on or off from the note button beside the information button; struck through while they are off | Codex message box's toolbar, after the permissions button | Patch; `codexPlus.chime`, `codexPlus.chimeButton` |
| Green / red / blue dot on a Codex tab's logo while working / replied and unread / stopped for your permission, in Claude Code Extras' colours and size; the tab titled by its conversation, kept in step as Codex names it, including a conversation started in a tab | Editor tabs | Patch |
| A conversation stopped for your permission shows as waiting in the Conversations view, puts the blue dot on its tab, and chimes | Conversations view; editor tabs; Codex tab | Patch; `codexPlus.chime` |
| Chime when a turn finishes, the model asks you something and waits for the answer (a blocking input request), or Codex stops for your permission; the three sounds are Claude Code Extras' own: rising for a finished turn, three equal notes for a permission, falling for a question | Codex tab; Codex's sidebar | Patch |
| The tool call running now, as `exec_command running for 2m55s (since 11:11:18)`, while Codex's own row for that call is out of view; with that row in view Codex already says it. The context, model and effort are beside each reply's time instead, and so is a turn's duration where Codex shows no "Worked for" | Codex tab, the right end of the row below the message box | Patch; `codexPlus.turnFigures` |
| Commands Codex started that are still running, such as a build or a `sleep` it left in the background: counted at the right end of the row below the message box, and listed with their folder and start time, until Codex reports the process ended. Only this window's Codex is seen, and a window reloaded while one runs learns of it only when it ends | Codex tab, below the message box; `Show Status` | Patch |
| Beside each reply's time: that turn's context share, model and effort, as `14:02:11 · ctx 33% · gpt-6.1-sol high`, matched to the reply by the turn id Codex puts on it | Codex conversation | Patch; `codexPlus.turnFigures` |
| After a reply's time, how long its turn took, as `14:02:11 9s · ctx 33% · …`, in a turn where Codex shows no "Worked for" of its own (it draws that only for a turn that did something before its reply) | Codex conversation | Patch; `codexPlus.replyDuration` |
| Context meter: a ring and the share of the context window in use. Hover: tokens in use and free, where Codex compacts and how far off that is, the conversation's input, cached input, output and reasoning tokens, model and effort. Click: compact the conversation now; refused while a turn runs, in Codex's own words | Codex message box's toolbar, left of the model picker | Patch; `codexPlus.contextMeter` |
| An outline round the context meter once 80% or more of the context window is used, 15 points before Codex compacts (about 94.7% on the meter), as Claude Code Extras outlines its meter 15% before a compaction. It is this extension's meter while that is drawn, and Codex's own otherwise, which Codex draws only with its own setting on: in Codex's settings, General, Composer, **Show context window usage** | Codex message box | Patch; `codexPlus.lowContextOutline` |
| The time above every message and every reply block, in your own time zone, including a message you send while a turn is running; under a reply it replaces Codex's own time | Codex conversation | Patch; `codexPlus.timestamps` |
| Your own messages by time and opening words, and where Codex compacted the context; click to scroll, step with the arrows or `,` and `.`, filter, or jump to the top or bottom. As Claude Code Plus's: the list is 280 px wide with 44 characters a row, resting on a row shows its time and first 220 characters in a box beside the list at once, every button of the rail explains itself in a box of its own, and after a jump the view is held on the message for about a second while Codex's turns still move (a wheel, a touch or a key lets go) | Right edge of a Codex conversation | Patch; `codexPlus.conversationNavigation` |
| Your own messages picked out by their text colour and a bar down their leading edge, in the theme's focus colour | Codex conversation | Patch; `codexPlus.userMessageColor`, `codexPlus.userMessageEdge` |
| How long each Codex page (the sidebar or a tab) took to open, and how long its stages took: Codex's page script run, first screen, the conversation or home page shown, restoring the conversation; pages that gave up | `Show How Long Opening a Codex Page Took`; the last three in `Show Status` | — (read from Codex's own log, `Codex.log`, in every window's log folder) |

- Codex's own button on the tab bar can be hidden: right-click it and choose Hide.
- In Restricted Mode nothing is installed into Codex, Codex is not patched, and no file is written.
- **Replied and unread** means a turn ended after you last had that conversation in front of you in a focused window, in its tab or in Codex's sidebar while the sidebar is visible. Bringing it to the front clears it in every window. Codex's own unread marks are not used: inside VS Code nothing ever marks them read.

## Waiting for your permission

Codex asks its client for an approval as a request, and records it in no file of its own. So it is read from the requests going through this window's extension host, which the patch hands over, and from the approval card on a Codex page.

| | |
| --- | --- |
| What counts as waiting | Only the requests that wait indefinitely: the three `requestApproval` methods, the two older `execCommandApproval` / `applyPatchApproval`, a blocking input request, and a request for input from an MCP server (an elicitation) for which Codex set no countdown |
| What is not counted | The requests Codex answers by itself when its countdown runs out: an empty input, or a declined elicitation. Counting those would show a conversation as waiting for something about to go away on its own, usually within 90 seconds |
| What ends a wait | The answer this window sent, or the notification that somebody else answered it. Failing both, the conversation's turn no longer running, which takes two polls so that a request arriving between them is never dropped |
| Where the chime can be heard | In a Codex tab of this window, or in Codex's sidebar while it shows the conversation, since the sound is made in that page. A conversation shown in a tab and in the sidebar rings in the tab alone. One shown in neither still shows and still counts; it just makes no sound |
| What the page adds | One flag: whether an approval card is on its screen. It finds one with Codex's own selector, the same `[data-codex-approval-surface]:not([data-app-shell-active-page="false"] *)` Codex queries to decide whether an approval surface is up |
| Why the page has a second observer | An approval card is drawn above the message box, outside the element the conversation scrolls, so the observer the timestamps use cannot see it appear. This one is on the activity root, which holds both, and it keeps running while the page is hidden, which is when a tab in the background needs it |

### What it cannot see

| Where the conversation is | Why |
| --- | --- |
| In another VS Code window | Each window starts its own Codex app-server, so its requests go to its own extension host and are not visible here. Its own window shows them. |
| Started with `codex exec` | It runs in its own process with its own app-server and no extension host at all, so nothing in VS Code sees it. That is also why it is not in the Conversations list. |
| Running here with no tab open | Shown and counted, from the requests this window's app-server makes. The approval card on a page adds the conversation the sidebar is showing; one the sidebar is not showing is still covered by the requests. |

## The message box's toolbar

| | |
| --- | --- |
| Where the controls go | Into Codex's own toolbar row: the information and note buttons after the permissions button, the context meter left of the model picker, where Codex puts its own meter |
| How they look | Each takes the classes of a Codex button in the same row, read off the page: the add-context button for the two icons, the permissions pill for the meter. Same size, colour and hover |
| What they leave alone | None of Codex's buttons moves or changes size. A press does not take the caret out of the message box, and a click goes no further than the button. Typing, keys, pasting and dropping in the box are unchanged |
| When the row has no room | All three go to the row below the message box instead, and come back once the row is wider again. They are never squeezed in |
| Codex's own meter | Hidden while this extension's is drawn, so the row shows one reading; back with `codexPlus.contextMeter` off |
| Why the two can differ | Codex divides the last model call's input and output by the window. This meter divides the input alone, as the line beside each reply and the work plan plugin's compaction reminders do |
| How fresh the figures are | Read from the conversation's rollout, every 3 seconds. Codex's own meter follows the app-server live |
| How the click compacts | `thread/compact/start` on this window's app-server, the request Codex's own `/compact` sends; Codex draws the compaction in the conversation |
| Why not `/compact` itself | Codex offers `/compact` only on an empty message box. The meter never touches the box, so a draft stays |
| When it does not compact | While a turn runs or an approval waits, as Codex refuses its own `/compact` then: "Compact is disabled while a chat is in progress" |
| Where Codex compacts | 90% of the model's full window, or `model_auto_compact_token_limit` in `config.toml` when that is lower |

## Not here

| What Claude Code's session list has | Why Codex's does not |
| --- | --- |
| Account & usage | The account is the model provider Codex is set to use and its region, read from `config.toml`, as `Amazon Bedrock · <region>`: in `Show Status` and the session information. Usage is not here: nothing this extension can read holds a plan, a quota, a credit balance or a price for an Amazon Bedrock account. Codex's rate-limit records carry a `limit_id` and nothing else (every other field is null in all 1199 such records across the 49 conversation logs on this machine), and Codex's own `account/rateLimits/read` answers that it needs a Codex account. Tokens are recorded, and the session information shows those. |
| Session manager | That is Claude Code's own collapsible section holding its session list. The Codex sessions view is already that list. |

| What Codex's page shows twice | Why it stays |
| --- | --- |
| Your message's time, ours above it and Codex's own beside it on hover | Codex's own carries no attribute of its own to hide it by, only class names, which change with each build. A reply's time, which does carry one, is shown once. |

## Install

Agent Plus (`xnervwang.agent-plus`) is a dependency. VS Code installs it from the marketplace along with this extension; when it is not on the marketplace, install its `.vsix` first.

```sh
code --install-extension xnervwang.agent-plus-1.0.0.vsix
bash build/pack.sh
code --install-extension build/xnervwang.codex-plus-1.0.0.vsix
```

- In a Remote SSH window, install both on the remote.
- At start-up the work plan plugin is installed into Codex and Codex is patched, without asking, as Claude Code Plus does with Claude Code. Trust the plugin's hooks when asked (or in Codex: Settings > Hooks), and reload the window when asked.
- `Codex Plus: Show Status` shows what is installed, patched and registered.

### After an update of this extension

- A new build usually changes what the patch writes into Codex, so the copy already in Codex's files is an older one.
- A reload on its own cannot carry that across: Codex reads those files when its extension starts and when it builds a page, so the new copy has to be **written first**, and only a reload then hands it over.
- Writing it is not something to run by hand. A few seconds after this extension starts it writes the new copy over the old one and offers a reload. Clicking that reload is the whole of it.
- No question is put for this, as none is for the first patch.
- The patch is written once, into the Codex every window of this machine loads. Only the window that wrote it offers the reload; any other window whose Codex was already running offers it once, the next time it gets the focus, since until then it runs Codex's own code and shows no dots, delivers no answers and plays no chimes.

| State of Codex's files | What happens |
| --- | --- |
| This build's patch | Nothing. |
| An older build's patch | Written over without asking, then a reload is offered. |
| Codex's own files, never patched | Patched without asking, then a reload is offered. |
| Codex's own files, after `Remove the Patch from Codex` | Left alone until `Codex Plus: Turn On` or `Toggle On/Off` is run, which puts the patch back; the removal is remembered, as Claude Code Plus remembers its own Remove. |

### Turning it all off

Four different acts, because each leaves something different behind.

| | |
| --- | --- |
| Off, but ready | `Codex Plus: Turn Off`, or `Toggle On/Off`, or the `codexPlus.enabled` setting. Nothing is drawn: no times, no message list, no colouring, no chimes, no buttons or context meter in the message box's toolbar, no figures strip, no dot on a tab's logo, and Codex is not patched or kept patched. **An applied patch stays in Codex's files.** Each setting keeps its own value, so turning it back on gives back the choices you had rather than the defaults. |
| Codex's own files back | `Codex Plus: Remove the Patch from Codex`. This is the one that restores `out/extension.js` and `webview/index.html`, and it is also what uninstalling this extension does. Reload the window afterwards. |
| The plugin left alone | `Codex Plus: Stop Loading the Work Plan Plugin`. Codex keeps the plugin, its marketplace entry and the trust you gave its hooks, and is set not to load it (`enabled = false` under `[plugins."agent-work-plan@codex-extras"]` in `config.toml`). `Install the Work Plan Plugin into Codex` is the way back; the install at start-up leaves it not loaded. Uninstalling this extension instead takes all three away (below). |
| Uninstalling this extension | Codex's own files are put back, in this editor's extensions folder and in any other editor's that no longer has this extension. Once no editor on the machine has it, the work plan plugin is removed from Codex too, with the plans copied to `agent-work-plan-plans-<time>` under `CODEX_HOME` first. A plugin it could not remove stops doing anything once VS Code has deleted this extension's global storage. |

- The work plan and the Codex session list are not covered by the master switch. They have their own settings (`codexPlus.workPlan`, `codexPlus.sessionList`), because a work plan the model is keeping is not an adornment to be switched off along with a chime.
- The work plan's own settings (`codexPlus.workPlan`, `codexPlus.workPlanOfferMinTurns`, `codexPlus.workPlanOfferMinToolCalls`, `codexPlus.workPlanQuietWhenReplyMatches`) and `codexPlus.tellCodexYourTimeZone` are user settings only. Every window and every `codex` run on the machine reads them from one file under `CODEX_HOME`, so VS Code ignores a value of theirs in workspace or folder settings.
- Turning the additions on and off says nothing, as in Claude Code Plus. After `Remove the Patch from Codex`, `Turn On` and `Toggle On/Off` put the patch back, and a reload is offered.
- `Codex Plus: Show Status` names all three states, including a plugin that is installed but not loaded, which nothing else in Codex shows.

### Python

The work plan's hooks and its MCP server need Python 3.7 or later. `py -3`, `python` and `python3` are tried in that order on Windows, `python3` then `python` elsewhere, and whichever answers first is written into the installed plugin.

| | |
| --- | --- |
| No Python found | The plugin is installed without its hooks, its MCP server or its skill (the instructions that tell Codex how to use the work plan), so the work plan stays empty rather than putting a failed hook in every turn. A row above the work plan says so, and which names were tried; so does `Codex Plus: Show Status`. |
| No Python, on Windows | Clicking that row fetches python.org's embeddable build (11 MB) into this extension's own storage, checks it against a recorded SHA-256, and installs the plugin again; the download is also offered once per version of that build at start-up, as Claude Code Plus offers it. It installs nothing system-wide, and it fetches nothing until you press a button. |
| No Python, elsewhere | Install Python 3 and click that row, or run `Codex Plus: Install the Work Plan Plugin into Codex`. python.org publishes an embeddable build for Windows only. |
| The row above the work plan | As Claude Code Plus draws it: the plugin could not be installed (click to try again), there is no Python (click to download it, or to install again), or Codex has not been told to trust the plugin's hooks (click to trust them). The one to fix first is shown, and it goes once that is fixed. |
| A Python installed later | The next install finds it. Nothing is remembered between installs. |

## Verified Codex builds

Everything this extension adds to Codex depends on the exact shape of one build, and Codex ships weekly. The patch matches a fixed set of places in Codex's own bundle, the page script selects elements by Codex's `data-*` attributes, and the conversation list reads columns out of Codex's state database. None of those three is an API.

- The builds each release was checked against are recorded in `src/supported-versions.json`, with the date and what was checked on each.
- `Codex Plus: Show Status` says whether the installed build is one of them. An unrecorded build also puts one line in the Codex Plus output channel, and never a dialog.
- An unrecorded build is not a broken one. The patch is all or nothing, so a rule that no longer fits leaves Codex untouched and says so in the status.

## The render check

- `test/render/run.js` draws Codex's real conversation page, from the installed Codex extension, with this repository's page script in it, and checks what can only be seen in a drawn page.
- It is not part of `test/check.js` and not in the package.

```sh
node test/render/run.js [--out <dir>] [--codex <Codex extension folder>] [--only <scenes>]
```

| | |
| --- | --- |
| When to run it | Once for every new Codex build, before adding it to `src/supported-versions.json`, and after a change to how the page script draws |
| What it draws | A made-up conversation, in eight states: four turns at 1100, 400 and 1600 pixels wide; a turn stopped on an approval; a command still running in the background with Codex's own context meter on; a chime before and after a click in the page; 25 turns over two days; Codex's model menu and conversation menu open |
| What it asserts | The page script finds the conversation and draws a time on every message; nothing of this extension's overlaps Codex's bubbles, buttons, message box, approval card, context meter or tool rows; nothing of Codex's is in the rail's column; the row below the message box is 2 px below its frame, with no background, its glyphs inked within the heights of Codex's toolbar icons; Codex's own reply time is hidden where ours is drawn; an approval card is reported; nothing of ours is over Codex's menus |
| What it writes | Screenshots in `<out>/shots`, the measurements in `<out>/results.json`, and the page script's layout sample of the drawn page in `<out>/layout-sample.json`, with the `data-*` names it does not share with the fixture in `test/fixtures/` printed. `<out>` is a new folder in the system's temporary folder unless given |
| What it needs | A headless Chromium (Playwright's `chromium_headless_shell`, or `CHROME`), `unshare -rn` for an unprivileged user, and an installed Codex extension. Without one of them it says which and exits 0 |
| What leaves the machine | Nothing. The browser fails every request not to `127.0.0.1` and the run prints how many it failed; Codex's app-server runs in a namespace with no network. Codex's installed files are only read |
| How long | About four minutes: each scene starts Codex's app-server and loads Codex's page afresh. `--only narrow,approval` runs some of them (`conversation`, `narrow`, `wide`, `approval`, `background`, `compact`, `chime`, `long`) |

- A new Codex build may need the stand-ins updated (`test/render/harness/`): they answer the page's host services and its app-server requests the way Codex's host does.
- The browser keeps its own autoplay rule, as Codex's webview does: an audio context made before anyone clicked or typed in the page stays suspended. The `chime` scene checks that a chime then reports `suspended` to the host and plays nothing, and that after one click (`Input.dispatchMouseEvent`) the next chime runs in a running context and starts its oscillators. With the rule turned off, as it once was, the first half could not fail, and a chime nobody hears passed.
- `test/against-latest.js`, run once a day against the newest Codex in the marketplace, also holds that build to `src/protocol-known.js`: every request its app-server can make of its client, listed by its own `codex app-server generate-json-schema`, and every `request_user_input…` name in its page. Each is marked handled or left alone on purpose, and one in neither list fails the check, printed by name. A question tool that is not an app-server request, as `request_user_input_async` is, is invisible to a check that knows only the requests.
- `test/parts/52a-known-protocol.js` checks that what those lists mark handled is recognised by the code they name, and compares them with the installed Codex when there is one.

## Inside a Codex conversation

Timestamps, the navigation strip and the colouring of your own messages are all drawn into Codex's own page, so each needs the patch **and** a window reload after it, since a page runs the script it was built with.

| | |
| --- | --- |
| Where a reply's time comes from | The element Codex marks `data-assistant-message-sent-time` in every reply block. The attribute's value is always `true`, so the time is the clock Codex renders as that element's text. A value that does read as an epoch count, a date string or a clock is taken first, for a build that puts a time there. A message from an earlier day has its clock after the day's name, as `Sunday 9:02 AM`: that is read with the day of the date divider Codex draws above the turn, and left off when no divider is in the page, rather than put on today. Text that fits none of these is left alone, and its shape (length, class of the first character, whether it is all digits) goes to the Codex Plus output channel so the next parser can be written. |
| Where your own message's time comes from | First the clock Codex itself renders beside the message, which it shows on hover, read as a reply's is. Then, as a second source, the conversation's rollout: the rollout's seconds are used where its minute is the one Codex rendered. They are matched by the turn id Codex puts on each turn, among that turn's messages of yours when the rollout holds as many there as the page shows, and failing that by position in the whole conversation when the rollout holds exactly as many messages of yours as the page shows. |
| Seconds on a reply | Codex renders a reply's time to the minute. The rollout's time for that reply is used instead when it is the one reply of that turn in the minute Codex shows. Where no date divider is in the page for a turn, the minute is compared as a clock, and the rollout's date is the one shown. |
| Why seconds are sometimes missing | A stamp is `HH:MM:SS` when the source carried seconds and `HH:MM` when it did not, rather than showing a `:00` nothing recorded. |
| A message of another day | Its stamp starts with the date, `MM/DD HH:MM:SS`, and with the year as well when it is not this year (`YYYY/MM/DD`), as Claude Code Plus writes it. The list of your messages shows the same. |
| What goes on Codex's elements | Only class names. No node of Codex's is moved, removed or given an inline style. Two rules of the stylesheet change Codex's layout: while the list is drawn the conversation keeps clear of its column on the right, 28 px, by a transparent border on the element it scrolls in; while the row below the message box is drawn the box sits 4 px higher, which that row needs. Those class names are styled from one stylesheet of this extension's own, so turning a setting off takes its rules with it. |
| What the page watches | One observer for all three, on the element the conversation scrolls, debounced. It is dropped while the page is hidden, and dropped altogether when all three are off. `Codex Plus: Remove the Patch from Codex` clears every mark out of the pages still open before restoring Codex's files. The approval card has its own observer, which keeps running while the page is hidden and is not dropped when these three are off. See Waiting for your permission. |

- Which of Codex's attributes these select by is checked against a real sample of a Codex conversation (`test/fixtures/`), so a Codex release that drops one fails a check rather than quietly showing nothing.
- The opening words on a navigation row are read in the page and shown there, and are not sent anywhere.
- A compaction point is placed by how many of your messages came before it in the conversation's rollout, so it is shown only while the page shows exactly as many messages of yours as the rollout holds.

## Sampling a conversation's layout

- The page script can take a sample of the conversation's layout: tag names, class names, attribute names, depth, child counts and rounded sizes, and for each text node its length with the shape of its first eight characters, never any text or attribute value.
- The render check asks for one of the page it draws and compares its `data-*` names with the sample in `test/fixtures/`, taken in a real window; there is no command for it.

## Checking what the page found

- Everything in **Inside a Codex conversation** is drawn inside Codex's page, which leaves one question answerable only by looking at it: whether any of it found what it was looking for.
- The end of `Codex Plus: Show Status` asks the Codex page in front instead, as Claude Code Plus's page reports itself with a mark and no command of its own.

| | |
| --- | --- |
| What it reports | The page script's own version; how many turns, messages of yours (and how many of those Codex gave no anchor, such as one sent while a turn ran), reply blocks, sent-time elements and bubbles were recognised; how many times were drawn on each side and which source your side's came from; the navigation rows and rail buttons; how many of your messages were coloured and given a bar; whether an approval card is up and which element its watcher is on; whether the figures strip is drawn; and how many elements of its own are in the page |
| What it never sends | Any text of the conversation, any title, any time as a string, and no selector read off the page. Every string in the reply is one of this extension's own constants, which a check holds it to |
| Needs | The patch (`Codex Plus: Turn On` after a Remove) **and** a window reload after it, plus a Codex conversation tab in front |
| Where it comes out | The end of `Show Status`, in the Codex Plus output channel |

- The page also speaks up by itself: when a Codex page shows turns and the script has recognised none of the messages in them for three passes and five seconds, which is what a Codex release that renamed an anchor looks like, one line goes to the Codex Plus output channel and stays in `Show Status`, and the page shows a yellow 16 px "!" at the top right of the conversation, as Claude Code Plus does, which explains itself on hover and goes once the messages are found again. It carries how many turns there were and whether the scroller was found, nothing else, and is said once until the messages are found again.
- A window with no patch, with a page left on an older copy of the script, or with no Codex tab in front gets one line saying which of those it is, rather than a report of zeroes that would read as a Codex release having moved an anchor.
- Your side's time has two possible sources and the report names the one used, because the stamp looks the same either way: `clock` is the one Codex renders beside the message on hover, `rollout` is the conversation's own record.
- Taken on a hidden page it is also how the two observers are told apart: the one for the marks is meant to be gone and the approval card's is meant to have stayed.
