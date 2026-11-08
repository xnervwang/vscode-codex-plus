# Codex Extras

| Feature | Where | Needs |
| --- | --- | --- |
| Codex conversations in the work plan, Conversations and Answer views | Agent Work Plan's views | Agent Work Plan (installed with this extension) |
| Work plan per conversation: rows with states, numbered, kept across turns and compactions | Agent Work Plan's Work plan view; Codex's context every turn | Work plan plugin, its hooks trusted |
| Plan changes through MCP tools `set_row` / `add_row`, no sandbox approval | Codex | Work plan plugin |
| End-of-turn reminders: rows left `doing`, questions not on a row, plan not reconciled | Codex | Work plan plugin |
| Reminder to bring `doing` rows up to date before an automatic compaction; pointer to the plan after one | Codex | Work plan plugin |
| Your time zone told to Codex when it runs on another machine | Codex's context | Work plan plugin; the patch |
| Answer a plan question from Agent Work Plan's Answer view, drafted into the conversation's message box | Codex tab | Patch; otherwise the answer stays in the Answer view |
| Open sessions, Recently closed, Pinned, Codex's sections, Ungrouped, Archived sessions, each with its count | Codex sessions view, in the Codex Extras sidebar | — |
| Other folders: every conversation outside this workspace, by the folder it started in | Codex sessions view | — |
| Open sessions covers tabs Codex opened with its own New button, which name no conversation in their URI | Codex sessions view | Patch |
| New in tab / New in sidebar; Resume in tab / Resume in sidebar | Codex sessions view | Patch for Resume in sidebar |
| Thread ID and group on hover; find by title or four hex characters of the ID | Codex sessions view | — |
| Date span `11d · 09/05→09/16`; title colours; background threads left out | Codex sessions view | — |
| Delete an archived conversation | Codex sessions view, right-click | — |
| Codex button on the tab bar: a new Codex conversation, in a tab or in the sidebar | Editor title bar | `codexExtras.openButtonTarget`: `tab` (default) or `sidebar`; `codexExtras.newConversationGroup`: `main` (default) or `active` |
| Tabs VS Code did not restore after a reconnect are opened again | Editor tabs | — |
| Session information: thread ID, app-server PID, folder, rollout and size, context share, tokens the conversation used | Command | — |
| Green / red dot on a Codex tab's logo while working / replied and unread | Editor tabs | Patch |
| Chime when a turn finishes or the plan asks a question | Codex tab | Patch |
| Last turn's duration, context share, model and effort; the tool call running now | Codex tab, bottom right | Patch |
| **Timestamps:** the time above every message and every reply block, in your own time zone | Codex conversation | Patch; `codexExtras.timestamps` |
| **Conversation navigation:** your own messages by time and opening words; click to scroll, step with the arrows or `,` and `.`, filter, or jump to the top or bottom | Right edge of a Codex conversation | Patch; `codexExtras.conversationNavigation` |
| **Your own messages marked:** their text colour, and a bar down their leading edge in the theme's focus colour | Codex conversation | Patch; `codexExtras.userMessageColor`, `codexExtras.userMessageEdge` |
| Sample of the layout of the conversation in front, written to a file, for working out which elements a later addition can hang on | Command | Patch, and the window reloaded since it was applied |

- Codex's own button on the tab bar can be hidden: right-click it and choose Hide.
- In Restricted Mode nothing is installed into Codex, Codex is not patched, and no file is written.

## Not here

| What Claude Code's session list has | Why Codex's does not |
| --- | --- |
| Account & usage | Codex records no plan, quota, credit or price anywhere this extension can read. Its rate-limit records hold only `limit_id`; every other field is null in all 1198 records of the 49 rollouts here, and there is no account file under `CODEX_HOME`. What it does record is tokens, which Session Information shows. |
| Session manager | It is Claude Code's own collapsible section holding its session list. The Codex sessions view is that list, so there is no second thing to add. |

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

## Inside a Codex conversation

These three are drawn into Codex's own page, so each needs the patch **and** a window reload after it: a page runs the script it was built with.

| | |
| --- | --- |
| Where a reply's time comes from | `data-assistant-message-sent-time`, which Codex puts on every reply block. Its value is read as an epoch count, a date string or a clock, whichever it turns out to be; a form none of the three fits is left alone, and its shape — length, class of the first character, whether it is all digits — goes to the Codex Extras output channel so the next parser can be written. |
| Where your own message's time comes from | First the clock Codex itself renders beside the message, which it shows on hover. Then, as a second source, the conversation's rollout: the rollout's seconds are used where its minute is the one Codex rendered, and its times are used at all only when it holds exactly as many messages of yours as the page shows. |
| Why seconds are sometimes missing | A stamp is `HH:MM:SS` when the source carried seconds and `HH:MM` when it did not. A zero in that place would be a time nobody wrote. |
| What goes on Codex's elements | Class names, and nothing else: no node of Codex's is moved, removed or given an inline style. What those class names mean is in one stylesheet of this extension's own, so a setting going off takes its rules with it. |
| What the page watches | One observer, on the element the conversation scrolls, debounced; dropped while the page is hidden, and dropped altogether when all three are off. `Codex Extras: Remove the Patch from Codex` clears every mark out of the pages still open before restoring Codex's files. |

- Which of Codex's attributes these select by is checked against a real sample of a Codex conversation (`test/fixtures/`), so a Codex release that drops one fails a check rather than quietly showing nothing.
- Nothing read out of the conversation leaves the page: the opening words on a navigation row are read in the page and shown in the page.

## Sampling a conversation's layout

- `Codex Extras: Sample the Conversation Layout` is for the additions that have to attach to what Codex draws at run time. The three above were written from one, and the sample is kept as the material their checks run against.
- A troubleshooting tool, so it is in the command palette and on no title bar.

| | |
| --- | --- |
| What it sends | Tag names, class names, attribute **names**, depth, child counts, rounded sizes, and for each text node its length with the shape of its first eight characters (`d` digit, `a` letter, `o` other) |
| The list of `data-*` names | Capped, and the count of them is sent beside it, so a name missing from the list because the list was cut short does not read like a name Codex has dropped |
| What it never sends | Any text of the conversation; the value of any attribute, `title`, `aria-label`, `alt`, `href`, `src`, `value` and `data-*` included; the page's query string; anything thread-id-shaped in an `id` |
| Needs | The patch (`Codex Extras: Patch Codex`) **and** a window reload after it, since a page runs the script as it was when the page was built |
| Where it writes | `conversation-layout-<YYYYMMDD-HHMMSS>.json` in this extension's own global storage; the absolute path is shown with a **Copy Path** button and written to the Codex Extras output channel |

- Bring the Codex conversation tab to the front first: the sample is of the page in front, and the command says so rather than sampling the wrong page.
- Nothing is sampled until the command is run, and nothing is left watching the page afterwards.
