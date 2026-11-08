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

## Sampling a conversation's layout

- `Codex Extras: Sample the Conversation Layout` is for the additions that have to attach to what Codex draws at run time, such as a time tick on each message.
- A troubleshooting tool, so it is in the command palette and on no title bar.

| | |
| --- | --- |
| What it sends | Tag names, class names, attribute **names**, depth, child counts, rounded sizes, and for each text node its length with the shape of its first eight characters (`d` digit, `a` letter, `o` other) |
| What it never sends | Any text of the conversation; the value of any attribute, `title`, `aria-label`, `alt`, `href`, `src`, `value` and `data-*` included; the page's query string; anything thread-id-shaped in an `id` |
| Needs | The patch (`Codex Extras: Patch Codex`) **and** a window reload after it, since a page runs the script as it was when the page was built |
| Where it writes | `conversation-layout-<YYYYMMDD-HHMMSS>.json` in this extension's own global storage; the absolute path is shown with a **Copy Path** button and written to the Codex Extras output channel |

- Bring the Codex conversation tab to the front first: the sample is of the page in front, and the command says so rather than sampling the wrong page.
- Nothing is sampled until the command is run, and nothing is left watching the page afterwards.
