# Codex Extras

| Feature | Where | Needs |
| --- | --- | --- |
| Codex conversations in the work plan, Conversations and Answer views | Agent Work Plan's views | Agent Work Plan (installed with this extension) |
| Work plan per conversation: rows with states, numbered, kept across turns and compactions | Agent Work Plan's Work plan view; Codex's context every turn | Work plan plugin, its hooks trusted |
| Plan changes through MCP tools `set_row` / `add_row`, no sandbox approval | Codex | Work plan plugin |
| End-of-turn reminders: rows left `doing`, questions not on a row, plan not reconciled | Codex | Work plan plugin |
| Reminder to bring `doing` rows up to date before an automatic compaction, at 70% and 85% of where Codex compacts (90% of the model's window, or `model_auto_compact_token_limit` in `config.toml` when that is lower); pointer to the plan after one | Codex | Work plan plugin |
| Your time zone told to Codex when it runs on another machine, with this machine's zone and the time now; quiet while Codex's own page has told it the same zone since the last compaction (`<codex_apps_client_time_context>`) | Codex's context | Work plan plugin; the patch; `codexExtras.tellCodexYourTimeZone` |
| Answer a plan question from Agent Work Plan's Answer view: put in the conversation's message box (only when the box is empty) and sent, as Enter would send it; while a turn runs, Codex queues it or steers with it. The Answer view says whether it was sent, left as a draft, or refused because the box held a draft of yours | Codex tab, or Codex's sidebar when it shows the conversation | Patch; `codexExtras.sendAnswers` off leaves it as a draft; without the patch the answer stays in the Answer view |
| Open sessions, Recently closed, Pinned, the sections you made in Codex's own sidebar, Ungrouped, Archived sessions, each with its count | Codex sessions view, in the Codex Extras sidebar | — |
| Other folders: every conversation outside this workspace, by the folder it started in | Codex sessions view | — |
| Open sessions covers tabs Codex opened with its own New button, whose URI names no conversation | Codex sessions view | Patch |
| Open sessions also lists the conversation Codex's sidebar shows while the sidebar is visible; clicking it goes to the sidebar. It is the conversation the sidebar last went to, so on the sidebar's own new-conversation page the one before is still listed | Codex sessions view | Patch |
| New in tab / New in sidebar; Resume in tab / Resume in sidebar | Codex sessions view | — (the sidebar ones open Codex's own link, `vscode://openai.chatgpt/local/<id>` in this editor's scheme) |
| Thread ID and group on hover; find by title or four hex characters of the ID | Codex sessions view | — |
| How long since it was last used and the first and last day it was, as `11d · 09/05→09/16`; title colours; conversations started by `codex exec` left out | Codex sessions view | `codexExtras.hideBackgroundSessions` |
| Delete an archived conversation | Codex sessions view, right-click | — |
| Codex button on the tab bar: a new Codex conversation, in a tab or in the sidebar | Editor title bar | `codexExtras.openButtonTarget`: `tab` (default) or `sidebar`; `codexExtras.newConversationGroup`: `main` (default, the first editor group) or `active` (the group the button was pressed in) |
| Tabs VS Code did not restore after a reconnect are opened again | Editor tabs | — |
| Session information: thread ID, the process id of Codex's server for this window, folder, the conversation log Codex writes (its rollout) and its size, how much of the context window is in use, tokens the conversation used | Command | — |
| Green / red / orange dot on a Codex tab's logo while working / replied and unread / stopped for your permission | Editor tabs | Patch |
| A conversation stopped for your permission shows as waiting in the Conversations view, counts in the status bar, and chimes | Conversations view; status bar; Codex tab | Patch; `codexExtras.waitingInStatusBar`, `codexExtras.chime` |
| Chime when a turn finishes, the plan asks a question, the model asks you something and waits for the answer (a blocking input request), or Codex stops for your permission; a question has a sound of its own, rising, and a permission three notes | Codex tab | Patch |
| The last turn's context share, model and effort; the tool call running now. A turn's duration is left to Codex's own "Worked for" | Codex tab, bottom right | Patch; `codexExtras.turnFigures` |
| Beside each reply's time: that turn's context share, model and effort, as `14:02:11 · ctx 33% · gpt-6.1-sol high`, matched to the reply by the turn id Codex puts on it | Codex conversation | Patch; `codexExtras.turnFigures` |
| An outline round Codex's own context meter in the message box once 85% or more of the context window is used. Codex draws that meter only with its own setting on, which is off by default: in Codex's settings, General, Composer, **Show context window usage**; hovering it shows the tokens used and the window | Codex message box | Patch; `codexExtras.lowContextOutline` |
| The time above every message and every reply block, in your own time zone | Codex conversation | Patch; `codexExtras.timestamps` |
| Your own messages by time and opening words, and where Codex compacted the context; click to scroll, step with the arrows or `,` and `.`, filter, or jump to the top or bottom | Right edge of a Codex conversation | Patch; `codexExtras.conversationNavigation` |
| Your own messages picked out by their text colour and a bar down their leading edge, in the theme's focus colour | Codex conversation | Patch; `codexExtras.userMessageColor`, `codexExtras.userMessageEdge` |
| How long each Codex page (the sidebar or a tab) took to open, and how long its stages took: Codex's page script run, first screen, the conversation or home page shown, restoring the conversation; pages that gave up | `Show How Long Opening a Codex Page Took`; the last three in `Show Status` | — (read from Codex's own log, `Codex.log`, in every window's log folder) |
| The layout of the conversation in front, written to a file, to find the elements a later addition can attach to | Command | Patch, and the window reloaded since it was applied |

- Codex's own button on the tab bar can be hidden: right-click it and choose Hide.
- In Restricted Mode nothing is installed into Codex, Codex is not patched, and no file is written.
- **Replied and unread** means a turn ended after you last had that conversation in front of you in a focused window, in its tab or in Codex's sidebar. Bringing it to the front clears it in every window. Codex's own unread marks are not used: inside VS Code nothing ever marks them read.

## Waiting for your permission

Codex asks its client for an approval as a request, and records it in no file of its own. So it is read from the requests going through this window's extension host, which the patch hands over, and from the approval card on a Codex page.

| | |
| --- | --- |
| What counts in the status bar | Only the requests that wait indefinitely: the three `requestApproval` methods, the two older `execCommandApproval` / `applyPatchApproval`, a blocking input request, and a request for input from an MCP server (an elicitation) for which Codex set no countdown |
| What shows but is not counted | The requests Codex answers by itself when its countdown runs out: an empty input, or a declined elicitation. Counting those would put a number in the status bar for something about to go away on its own, usually within 90 seconds |
| What ends a wait | The answer this window sent, or the notification that somebody else answered it. Failing both, the conversation's turn no longer running, which takes two polls so that a request arriving between them is never dropped |
| Where the chime can be heard | In a Codex tab of this window, since the sound is made in that tab's page. A conversation with no tab open still shows and still counts; it just makes no sound |
| What the page adds | One flag: whether an approval card is on its screen. It finds one with Codex's own selector, the same `[data-codex-approval-surface]:not([data-app-shell-active-page="false"] *)` Codex queries to decide whether an approval surface is up |
| Why the page has a second observer | An approval card is drawn above the message box, outside the element the conversation scrolls, so the observer the timestamps use cannot see it appear. This one is on the activity root, which holds both, and it keeps running while the page is hidden, which is when a tab in the background needs it |

### What it cannot see

| Where the conversation is | Why |
| --- | --- |
| In another VS Code window | Each window starts its own Codex app-server, so its requests go to its own extension host and are not visible here. Its own window shows them. |
| Started with `codex exec` | It runs in its own process with its own app-server and no extension host at all, so nothing in VS Code sees it. That is also why it is not in the Conversations list. |
| Running here with no tab open | Shown and counted, from the requests this window's app-server makes. The approval card on a page adds the conversation the sidebar is showing; one the sidebar is not showing is still covered by the requests. |

## Not here

| What Claude Code's session list has | Why Codex's does not |
| --- | --- |
| Account & usage | The account is the model provider Codex is set to use and its region, read from `config.toml`, as `Amazon Bedrock · <region>`: in `Show Status` and Session Information. Usage is not here: nothing this extension can read holds a plan, a quota, a credit balance or a price for an Amazon Bedrock account. Codex's rate-limit records carry a `limit_id` and nothing else (every other field is null in all 1199 such records across the 49 conversation logs on this machine), and Codex's own `account/rateLimits/read` answers that it needs a Codex account. Tokens are recorded, and Session Information shows those. |
| Session manager | That is Claude Code's own collapsible section holding its session list. The Codex sessions view is already that list. |

## Install

Agent Work Plan (`xnervwang.agent-work-plan`) is a dependency. VS Code installs it from the marketplace along with this extension; when it is not on the marketplace, install its `.vsix` first.

```sh
code --install-extension xnervwang.agent-work-plan-1.0.0.vsix
bash build/pack.sh
code --install-extension build/xnervwang.codex-extras-0.1.0.vsix
```

- In a Remote SSH window, install both on the remote.
- Then run `Codex Extras: Install the Work Plan Plugin into Codex` and trust its hooks when asked (or in Codex: Settings > Hooks).
- Optional: `Codex Extras: Patch Codex (…)`, then reload the window.
- `Codex Extras: Show Status` shows what is installed, patched and registered.

### After an update of this extension

- A new build usually changes what the patch writes into Codex, so the copy already in Codex's files is an older one.
- A reload on its own cannot carry that across: Codex reads those files when its extension starts and when it builds a page, so the new copy has to be **written first**, and only a reload then hands it over.
- Writing it is not something to run by hand. A few seconds after this extension starts it writes the new copy over the old one and offers a reload. Clicking that reload is the whole of it.
- No question is put for this: the one already answered was whether to patch this Codex at all.
- The patch is written once, into the Codex every window of this machine loads. Only the window that wrote it offers the reload; any other window whose Codex was already running offers it once, the next time it gets the focus, since until then it runs Codex's own code and shows no dots, delivers no answers and plays no chimes.

| State of Codex's files | What happens |
| --- | --- |
| This build's patch | Nothing. |
| An older build's patch | Written over without asking, then a reload is offered. |
| Codex's own files, never patched | Asked about once per Codex version (`codexExtras.patchCodex`). |
| Codex's own files, after `Remove the Patch from Codex` | Left alone. That command also sets `codexExtras.patchCodex` to `off`. |

### Turning it all off

Three states, and three different acts, because each leaves something different behind.

| | |
| --- | --- |
| Off, but ready | `Codex Extras: Turn All the Additions Off`, or `Toggle`, or the `codexExtras.enabled` setting. Nothing is drawn: no times, no message list, no colouring, no chimes, no figures strip, no dot on a tab's logo, no count in the status bar, and Codex is not patched or kept patched. **An applied patch stays in Codex's files.** Each setting keeps its own value, so turning it back on gives back the choices you had rather than the defaults. |
| Codex's own files back | `Codex Extras: Remove the Patch from Codex`. This is the one that restores `out/extension.js` and `webview/index.html`, and it is also what uninstalling this extension does. Reload the window afterwards. |
| The plugin left alone | `Codex Extras: Stop Loading the Work Plan Plugin`. Codex keeps the plugin, its marketplace entry and the trust you gave its hooks, and is set not to load it (`enabled = false` under `[plugins."agent-work-plan@codex-extras"]` in `config.toml`). `Load the Work Plan Plugin in Codex` is the way back. `Remove the Work Plan Plugin from Codex` instead takes all three away, and getting back from that means installing and trusting again. |

- The work plan and the Codex session list are not covered by the master switch. They have their own settings (`codexExtras.workPlan`, `codexExtras.sessionList`), because a work plan the model is keeping is not an adornment to be switched off along with a chime.
- `Codex Extras: Patch Codex` turns the master switch back on if it was off: the patch exists only to serve the additions, so applying it while they are all off would leave Codex patched with nothing drawing through it.
- `Codex Extras: Show Status` names all three states, including a plugin that is installed but not loaded, which nothing else in Codex shows.

### Python

The work plan's hooks and its MCP server need Python 3.7 or later. `py -3`, `python` and `python3` are tried in that order on Windows, `python3` then `python` elsewhere, and whichever answers first is written into the installed plugin.

| | |
| --- | --- |
| No Python found | The plugin is installed without its hooks, its MCP server or its skill (the instructions that tell Codex how to use the work plan), so the work plan stays empty rather than putting a failed hook in every turn. `Codex Extras: Show Status` says which names were tried. |
| No Python, on Windows | `Codex Extras: Download Python for the Work Plan Hooks` fetches python.org's embeddable build (11 MB) into this extension's own storage, checks it against a recorded SHA-256, and installs the plugin again. It installs nothing system-wide, and it fetches nothing until you run the command or press its button. |
| No Python, elsewhere | Install Python 3 and run `Codex Extras: Install the Work Plan Plugin into Codex` again. python.org publishes an embeddable build for Windows only. |
| A Python installed later | The next install finds it. Nothing is remembered between installs. |

## Verified Codex builds

Everything this extension adds to Codex depends on the exact shape of one build, and Codex ships weekly. The patch matches a fixed set of places in Codex's own bundle, the page script selects elements by Codex's `data-*` attributes, and the conversation list reads columns out of Codex's state database. None of those three is an API.

- The builds each release was checked against are recorded in `src/supported-versions.json`, with the date and what was checked on each.
- `Codex Extras: Show Status` says whether the installed build is one of them. An unrecorded build also puts one line in the Codex Extras output channel, and never a dialog.
- An unrecorded build is not a broken one. The patch is all or nothing, so a rule that no longer fits leaves Codex untouched and says so in the status.

## Inside a Codex conversation

Timestamps, the navigation strip and the colouring of your own messages are all drawn into Codex's own page, so each needs the patch **and** a window reload after it, since a page runs the script it was built with.

| | |
| --- | --- |
| Where a reply's time comes from | `data-assistant-message-sent-time`, which Codex puts on every reply block. Its value is read as an epoch count, a date string or a clock, whichever it turns out to be. A value that fits none of the three is left alone, and its shape (length, class of the first character, whether it is all digits) goes to the Codex Extras output channel so the next parser can be written. |
| Where your own message's time comes from | First the clock Codex itself renders beside the message, which it shows on hover. Then, as a second source, the conversation's rollout: the rollout's seconds are used where its minute is the one Codex rendered, and its times are used at all only when it holds exactly as many messages of yours as the page shows. |
| Why seconds are sometimes missing | A stamp is `HH:MM:SS` when the source carried seconds and `HH:MM` when it did not, rather than showing a `:00` nothing recorded. |
| What goes on Codex's elements | Only class names. No node of Codex's is moved, removed or given an inline style. Those class names are styled from one stylesheet of this extension's own, so turning a setting off takes its rules with it. |
| What the page watches | One observer for all three, on the element the conversation scrolls, debounced. It is dropped while the page is hidden, and dropped altogether when all three are off. `Codex Extras: Remove the Patch from Codex` clears every mark out of the pages still open before restoring Codex's files. The approval card has its own observer, which keeps running while the page is hidden and is not dropped when these three are off. See Waiting for your permission. |

- Which of Codex's attributes these select by is checked against a real sample of a Codex conversation (`test/fixtures/`), so a Codex release that drops one fails a check rather than quietly showing nothing.
- The opening words on a navigation row are read in the page and shown there, and are not sent anywhere.
- A compaction point is placed by how many of your messages came before it in the conversation's rollout, so it is shown only while the page shows exactly as many messages of yours as the rollout holds.

## Sampling a conversation's layout

- `Codex Extras: Sample the Conversation Layout` is for the additions that have to attach to what Codex draws at run time. The three above were written from a sample, and that sample is now the fixture their checks run against.
- It is a troubleshooting tool, so it is in the command palette only.

| | |
| --- | --- |
| What it sends | Tag names, class names, attribute names, depth, child counts, rounded sizes, and for each text node its length with the shape of its first eight characters (`d` digit, `a` letter, `o` other) |
| The list of `data-*` names | Capped, with the total count sent beside it, so a cut-short list cannot be mistaken for Codex having dropped a name |
| What it never sends | Any text of the conversation; the value of any attribute, `title`, `aria-label`, `alt`, `href`, `src`, `value` and `data-*` included; the page's query string; anything thread-id-shaped in an `id` |
| Needs | The patch (`Codex Extras: Patch Codex`) **and** a window reload after it, since a page runs the script as it was when the page was built |
| Where it writes | `conversation-layout-<YYYYMMDD-HHMMSS>.json` in this extension's own global storage; the absolute path is shown with a **Copy Path** button and written to the Codex Extras output channel |

- Bring the Codex conversation tab to the front first: the sample is of the page in front, and the command says so rather than sampling the wrong page.
- It samples only when you run the command, and leaves nothing watching the page.

## Checking what the page found

Everything in **Inside a Codex conversation** is drawn inside Codex's page, which used to leave one question answerable only by looking at it: whether any of it found what it was looking for. `Codex Extras: Check What the Page Script Found in This Conversation` asks the page instead, and the same lines are added to the end of `Codex Extras: Show Status`.

| | |
| --- | --- |
| What it reports | The page script's own version; how many turns, messages of yours, reply blocks, sent-time elements and bubbles were recognised; how many times were drawn on each side and which source your side's came from; the navigation rows and rail buttons; how many of your messages were coloured and given a bar; whether an approval card is up and which element its watcher is on; whether the figures strip is drawn; and how many elements of its own are in the page |
| What it never sends | Any text of the conversation, any title, any time as a string, and no selector read off the page. Every string in the reply is one of this extension's own constants, which a check holds it to |
| Needs | The patch (`Codex Extras: Patch Codex`) **and** a window reload after it, plus a Codex conversation tab in front |
| Where it comes out | The Codex Extras output channel, with a **Copy** button for pasting the whole of it back |

- The page also speaks up by itself, without the command: when a Codex page shows turns and the script has recognised none of the messages in them for three passes and five seconds, which is what a Codex release that renamed an anchor looks like, one line goes to the Codex Extras output channel and stays in `Show Status`. It carries how many turns there were and whether the scroller was found, nothing else, and is said once until the messages are found again.
- A window with no patch, with a page left on an older copy of the script, or with no Codex tab in front gets one line saying which of those it is, rather than a report of zeroes that would read as a Codex release having moved an anchor.
- Your side's time has two possible sources and the report names the one used, because the stamp looks the same either way: `clock` is the one Codex renders beside the message on hover, `rollout` is the conversation's own record.
- Taken on a hidden page it is also how the two observers are told apart: the one for the marks is meant to be gone and the approval card's is meant to have stayed.
