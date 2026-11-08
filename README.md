# Codex Extras

| Feature | Where | Needs |
| --- | --- | --- |
| Work plan per conversation: rows with states, numbered, kept across turns and compactions | Work plan view; Codex's context every turn | Work plan plugin, its hooks trusted |
| Plan changes through MCP tools `set_row` / `add_row`, no sandbox approval | Codex | Work plan plugin |
| End-of-turn reminders: rows left `doing`, questions not on a row, plan not reconciled | Codex | Work plan plugin |
| Reminder to bring `doing` rows up to date before an automatic compaction; pointer to the plan after one | Codex | Work plan plugin |
| Your time zone told to Codex when it runs on another machine | Codex's context | Work plan plugin; the Answer view or the patch |
| Conversations of this workspace: state, plan questions, `doing` rows, stopped ones with open rows | Conversations tab in the panel | — |
| Answer a plan question from the Conversations tab | Answer view | Patch for a draft in the message box; clipboard otherwise |
| `N to decide` / `Conversations M` | Status bar | — |
| Open in this window, recently closed, Codex's sections, archived | Codex sessions view | — |
| New in tab / New in sidebar; Resume in tab / Resume in sidebar | Codex sessions view | Patch for Resume in sidebar |
| Thread ID and group on hover; find by title or four hex characters of the ID | Codex sessions view | — |
| Date span `11d · 09/05→09/16`; title colours; background threads left out | Codex sessions view | — |
| Delete an archived conversation | Codex sessions view, right-click | — |
| Tabs VS Code did not restore after a reconnect are opened again | Editor tabs | — |
| Session information: thread ID, app-server PID, folder, rollout and size | Command | — |
| Green / red dot on a Codex tab's logo while working / replied and unread | Editor tabs | Patch |
| Chime when a turn finishes or the plan asks a question | Codex tab | Patch |
| Last turn's duration, context share, model and effort; the tool call running now | Codex tab, bottom right | Patch |
| VS Code's webview request limit raised from 32 | VS Code's files | Your consent |
| One sidebar and one Conversations tab with Claude Code Extras when both are installed | Claude Code Extras' views | Claude Code Extras with protocol 3 |

## Install

```sh
bash build/pack.sh
code --install-extension build/xnervwang.codex-extras-0.1.0.vsix
```

- In a Remote SSH window, install it on the remote.
- Then run `Codex Extras: Install the Work Plan Plugin into Codex` and trust its hooks when asked (or in Codex: Settings > Hooks).
- Optional: `Codex Extras: Patch Codex (…)`, then reload the window.
- `Codex Extras: Show Status` shows what is installed and patched.
