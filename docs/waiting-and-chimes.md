# Chimes and waiting for your permission

Codex Plus chimes when a turn finishes, when the model waits for your answer and when Codex stops for your permission. A conversation waiting for permission shows as waiting in Agent Plus and on its tab.

## Chimes

Codex Plus chimes when a turn finishes, when the model asks you something and waits for your answer (a blocking input request), and when Codex stops for your permission. The three sounds are Claude Code Plus's own: rising for a finished turn, falling for a question, and three equal notes for permission. The sound plays in the page showing the conversation: a Codex tab in this window or Codex's sidebar while it shows the conversation. If both show it, only the tab rings.

The note button beside the information button in the message box's toolbar turns chimes on and off. It is struck through while chimes are off. `codexPlus.chime` turns chimes off; `codexPlus.chimeButton` hides the note button without changing `codexPlus.chime`. Chimes need the patch.

## Waiting for your permission

A conversation stopped for your permission shows as waiting in Agent Plus's Conversations view, puts a red dot on its tab, and chimes. This needs the patch. Codex asks its client for approval in a request but does not save that request in its own files. Codex Plus reads requests passing through this window's extension host (the process VS Code runs extensions in), which the patch hands over, and reads the approval card on a Codex page.

Only requests that wait indefinitely count as waiting. These include the three `requestApproval` methods (for a command, a file change, and permissions), the older `execCommandApproval` and `applyPatchApproval` methods, a blocking input request, and an input request from an MCP server (an elicitation) for which Codex set no countdown. Requests Codex answers itself when a countdown runs out do not count. That usually happens within 90 seconds, with an empty input or a declined elicitation.

A wait ends when this window sends the answer or a notification says somebody else answered it. If neither happens, it ends when two Codex Plus polls in a row find that the conversation's turn is no longer running. A conversation shown in neither a tab nor the sidebar still shows as waiting in the Conversations view and is counted there. It makes no sound.

Each VS Code window runs its own Codex app-server. Approval requests from another window or from Codex's terminal interface do not pass through this window. Just before Codex asks for approval, the work plan plugin's `PermissionRequest` hook leaves a mark in `waiting/` beside the plans. The conversation then shows as waiting here too. This requires trust in the plugin's hooks. The mark clears when the tool has run, when the window whose app-server sent the approval request receives the answer, or when the turn ends. When you approve a request in the terminal interface, the mark stays until the command finishes. After a refusal there, the mark clears when the turn ends or the next message arrives.

Codex Plus tells Agent Plus what the conversation needs from you: tool approval, an answer to a question from Codex, or an answer to a question in the conversation's work plan. It uses the names Codex's hooks use, such as `Bash`, `apply_patch`, `request_permissions`, or `mcp__<server>__<tool>` for an MCP tool, so a notification can read "is waiting for you to approve Bash". For approvals in another window or in Codex's terminal interface, Codex Plus reads the tool name from the mark.

Codex itself shows no VS Code notification when it waits for approval; only Agent Plus does, and you can turn these notifications off with `agentPlus.notifications.waiting`. Agent Plus shows a notification only in the focused window and only if that window doesn't show the conversation, even in a tab behind other tabs or in Codex's sidebar. If no window has focus when the conversation starts waiting, Agent Plus shows the notification once, in the next window to get focus.

`codex exec` runs Codex from the command line for one task outside VS Code. It refuses each approval request immediately. Its conversation does not appear in Agent Plus's Conversations view.

How the page finds the approval card is documented in [docs/codex-page.md](codex-page.md#the-approval-card).
