# The session list

Open Conversations in the activity bar to see this workspace's conversations from all your installed agent extensions. [Agent Plus](https://github.com/xnervwang/vscode-agent-plus) provides the list and documents its shared features and `agentPlus.sessions.*` settings.

## Which conversations

Codex Plus lists a Codex conversation if its folder is a workspace folder in this window or is below one. If you opened a workspace folder through a symbolic link, the list also finds conversations Codex recorded under the real path. Conversations archived in Codex appear as archived.

Sub-agents appear by nickname under the conversation that started them. Sub-agents, `codex exec` runs and approval reviews are background runs. Codex starts an approval review to decide whether to allow an action a conversation requested. To see background runs, turn off `agentPlus.sessions.hideBackground`, which is on by default.

The time on a row is the time of the last message. Renaming the conversation, moving it between Codex sections or archiving it in Codex leaves that time unchanged.

## Status dots and unread replies

- Green dot: a turn is running.
- Green ring: the turn has ended, but work it started is still running.
- Blue dot: Codex is waiting for your approval.
- Red dot: after your last message, a turn added a question for you to the work plan. The conversation has stopped.
- Red ring: the work plan has a question added after your last message, and the conversation is still running.
- No dot: the conversation has stopped.

Hover over a row with a green ring to see what's running. It can be a sub-agent, a Codex background command, a shell detached with `setsid` or `nohup`, a `codex exec` or `claude -p` run started from a command line, or a `claude --bg` session. Codex Plus finds detached shells and command-line runs through `/proc`, so it detects those only on Linux.

A reply is unread if its turn ended after you last viewed the conversation in a focused window, either in its tab or in Codex's visible sidebar. Codex Plus keeps its own read record because nothing inside VS Code clears Codex's unread marks. Mark as Read and Mark as Unread update the Codex Plus record.

When a conversation leaves a command running detached, Codex Plus tells the conversation when the command stops. It also tells the conversation when a `claude --bg` session it started finishes, fails, waits for an answer or is stopped. These notices require the All features token mode, or Custom with `codexPlus.detachedEndNotices` on. See [Token costs](token-costs.md).

## Where else a conversation is open

A Codex process holds a lock while it has a conversation loaded, even when the conversation is idle. Only one process can hold the lock, at `thread-writer-locks/<conversation id>.lock` in Codex's home folder. On Linux, Codex Plus reads `/proc/locks` to find the process without taking a lock itself. It does this during its scan for work left running. The windows on the machine share one scan, which runs about every 12 seconds.

The list marks conversations open elsewhere and excludes this window's own Codex process. Hover over the row to see whether the lock belongs to the Codex extension in another VS Code window, Codex's terminal interface or a `codex exec` run. For the terminal interface, the hover shows the terminal (such as `pts/3`), its folder and whether it runs in tmux or a VS Code terminal. If a tab or Codex's sidebar in this window shows the conversation too, the row warns that two processes have it open at once.

On any system, Agent Plus can identify another VS Code window running Codex Plus by its window title, using that window's own record. On macOS and Windows, these are the only places the list detects. After you close a conversation in another VS Code window, Codex can keep its lock for up to a minute, so the list can still show it as open there.

If a conversation is open in another VS Code window, clicking its row asks that window to bring the conversation to the front. A window without Agent Plus may not answer. If the window does not answer, the list tells you so and asks you to close the conversation there or reload that window. The conversation does not open in this window. If a conversation is open in a terminal or a `codex exec` run, clicking its row opens nothing. The list tells you where it is open and asks you to close it there first because two processes writing to the same conversation would lose turns.

## Opening, renaming and deleting

Click a row to open the conversation in a tab or in Codex's sidebar, just as you would with Codex Plus's commands. See [Tabs](tabs.md) for which editor group gets the tab. New starts a Codex conversation in a tab or in the sidebar. If Codex archived a conversation, opening it first unarchives it in Codex because Codex cannot show an archived conversation.

Rename removes extra spaces and sends the name to Codex. Rename, Delete and goal actions use this window's connection to Codex. Until the Codex Plus patch to Codex's files takes effect in the window, Codex Plus starts a short-lived Codex process for these actions. In Restricted Mode, the list can only open conversations; Codex Plus makes no changes.

Delete is available only for archived conversations and asks for confirmation. Codex Plus then checks the conversation and its sub-agents again. It skips deletion if any of them is open or running in this window, open in another VS Code window or held open by another Codex process. The list shows which one prevented deletion.

Codex deletes the conversation's log and its sub-agents' logs. For each deleted conversation, Codex Plus removes its work plan, wake-up timer, title colour and entry in this window's recently closed tabs. The Codex Plus output channel lists each deleted conversation on its own line.

## Goals

Ask Codex to set a goal in the conversation. Codex starts another turn whenever the conversation is idle until the goal is done, blocked or out of its token budget.

The row shows `goal`, `goal paused`, `goal blocked`, `goal: usage limit` or `goal: budget spent`. The badge is dimmed unless the goal is active. Hover over it to see the goal and how many tokens it has used from its budget.

Use Pause Goal in the row's menu while a goal is active. Resume Goal is available when a goal is paused, blocked or stopped by a limit. Clear Goal removes the goal.

For the conversation in front of you, use `Codex Plus: Pause Goal`, `Codex Plus: Resume Goal` or `Codex Plus: Clear Goal` in the Command Palette. Codex receives each change as yours. Resuming lets Codex start turns again and uses Codex's model calls.

## Account & usage

The Codex part of Account & usage shows how you're signed in: Amazon Bedrock, an API key, or the email and plan of a ChatGPT account. For each rate limit, it shows the share used and the reset time. It also shows tokens used today, tokens used in total and the token count for the Codex conversation you last viewed.

These figures require the Codex Plus patch to be active in this window. Codex Plus asks this window's Codex for them at most once a minute and updates them from notifications Codex already sends. Codex reports no rate limits for Amazon Bedrock, so those accounts show sign-in details and token counts. No account shows a price or balance.

## What the list takes over from Codex

The first time Codex conversations appear in the list, it imports archived conversations with the time Codex archived them. Codex sections become groups with the same names. The built-in Pinned section and pinned conversations keep their pins. The list also imports title colours from the former Codex Plus list.

After this one-time import, Agent Plus keeps groups, pins and archive status. Changing them in the list does not move conversations between Codex sections or archive them in Codex.

Codex Plus normally checks daily for conversations Codex archived at least `codexPlus.deleteArchivedAfterDays` days ago (30 by default). In a window where the Agent Plus list handles archiving and deletion, the Codex Plus check does not run. The list uses `agentPlus.sessions.deleteAfterDays` there.
