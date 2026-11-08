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
| Open in this window, recently closed, Codex's sections, archived | Codex sessions view, in the Codex Extras sidebar | — |
| New in tab / New in sidebar; Resume in tab / Resume in sidebar | Codex sessions view | Patch for Resume in sidebar |
| Thread ID and group on hover; find by title or four hex characters of the ID | Codex sessions view | — |
| Date span `11d · 09/05→09/16`; title colours; background threads left out | Codex sessions view | — |
| Delete an archived conversation | Codex sessions view, right-click | — |
| Codex button on the tab bar: the Codex conversation last in front, in a tab, or a new one | Editor title bar | `codexExtras.openButtonTarget`: `tab` (default) or `sidebar` |
| Tabs VS Code did not restore after a reconnect are opened again | Editor tabs | — |
| Session information: thread ID, app-server PID, folder, rollout and size | Command | — |
| Green / red dot on a Codex tab's logo while working / replied and unread | Editor tabs | Patch |
| Chime when a turn finishes or the plan asks a question | Codex tab | Patch |
| Last turn's duration, context share, model and effort; the tool call running now | Codex tab, bottom right | Patch |

- Codex's own button on the tab bar can be hidden: right-click it and choose Hide.
- In Restricted Mode nothing is installed into Codex, Codex is not patched, and no file is written.

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
