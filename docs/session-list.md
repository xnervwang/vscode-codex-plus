# The session list

Open Conversations in the activity bar to see this workspace's conversations from all your installed agent extensions. [Agent Plus](https://github.com/xnervwang/vscode-agent-plus) provides the list and documents its shared features and `agentPlus.sessions.*` settings. Codex Plus decides which Codex conversations appear and reports what each one is doing and where else it's open.

## Which conversations

The list includes Codex conversations whose folders are at or below any workspace folder in this window. If you opened a workspace folder through a symbolic link, the list also finds conversations Codex recorded under the real path. Conversations started in another worktree (a linked checkout) of the folder's git repository are listed too, with the worktree's folder name on the row.

Sub-agents appear by nickname under the conversation that started them. Sub-agents, `codex exec` runs (Codex run from a command line without its interface) and approval reviews are background runs. In an approval review, Codex checks whether the conversation can take the action it requested. To see background runs, turn off `agentPlus.sessions.hideBackground`, which is on by default.

Each row shows when the conversation's last message was sent. Renaming the conversation, moving it between Codex sections or archiving it in Codex leaves that time unchanged.

## Status dots and unread replies

Agent Plus uses a dot or ring on each Codex conversation's row to show the status Codex Plus reports.

- Green dot: a turn is running.
- Green ring: the turn has ended, but work it started is still running.
- Blue dot: Codex is waiting for your approval.
- Red dot: after your last message, a turn added a question for you to the [work plan](work-plan.md). The conversation has stopped.
- Red ring: after your last message, a turn added a question for you to the work plan. The conversation is still running.
- No dot: the conversation has stopped.

Hover over a row with a green ring to see what's running. It can be a sub-agent, a Codex background command, a shell detached with `setsid` or `nohup`, a `codex exec` or `claude -p` run started from a command line, or a `claude --bg` session (Claude Code running in the background). Codex Plus finds detached shells and command-line runs through `/proc`, so it detects those only on Linux.

A reply is unread if its turn ended after you last viewed the conversation in a focused window, either in its tab or in Codex's visible sidebar. Codex Plus keeps its own read record because nothing inside VS Code clears Codex's unread marks. Mark as Read and Mark as Unread update that record.

Codex Plus notifies a conversation when a command it left running detached stops. If the conversation started a `claude --bg` session, it gets a notice when the session finishes, fails, waits for an answer or is stopped. These notices require the All features token mode, or Custom with `codexPlus.detachedEndNotices` on. See [Token costs](token-costs.md).

## Where else a conversation is open

A Codex process holds a lock while it has a conversation loaded, even when the conversation is idle. Only one process can hold the lock, at `thread-writer-locks/<conversation id>.lock` in Codex's home folder. On Linux, Codex Plus reads `/proc/locks` to find the process without taking a lock itself. It does this during its scan for work left running. The windows on the machine share one scan, which runs about every 12 seconds.

The list marks conversations open elsewhere and excludes this window's own Codex process. Hover over the row to see whether the lock belongs to the Codex extension in another VS Code window, Codex's terminal interface or a `codex exec` run. For the terminal interface, the hover shows the terminal (such as `pts/3`), the folder the terminal interface runs in, and whether it runs in tmux or a VS Code terminal.

If a tab or Codex's sidebar in this window also shows the conversation, the row warns that two processes have it open. Only the other process holds the writer lock, so Codex shows that this window cannot write to the conversation.

On any system, Agent Plus can identify another VS Code window running Codex Plus by its window title, using the record that window keeps of its open conversations. On macOS and Windows, the list detects a conversation open elsewhere only if it's open in another VS Code window. After you close a conversation in another VS Code window, Codex can keep its lock for up to a minute, so the list can still show it as open there.

### Clicking a conversation that is open elsewhere

If a conversation is open in another VS Code window, clicking its row asks that window to bring the conversation to the front. If the other window doesn't respond, the list tells you so and asks you to close the conversation there or reload that window. This can happen when the other window doesn't have Agent Plus.

Clicking the row opens nothing when a terminal or a `codex exec` run has the conversation open. The list asks you to close the conversation first and shows you where it is open. If two processes wrote to the same conversation, turns would be lost.

## Opening, renaming and deleting

Click a row to open the conversation in a tab or in Codex's sidebar, just as you would with Codex Plus's commands. See [Tabs](tabs.md) for which editor group gets the tab. New starts a Codex conversation in a tab or in the sidebar. Codex cannot show an archived conversation, so Codex Plus unarchives it in Codex before opening it.

Rename trims extra spaces from the name before sending it to Codex through this window's connection. Codex won't rename a conversation while it's archived, so Codex Plus takes it out of the archive, renames it and puts it back. Delete and the goal actions (see [Goals](#goals)) use the same connection. Until its patch to Codex's files takes effect in this window, Codex Plus runs these actions through a short-lived Codex process instead. In Restricted Mode, the list can only open conversations. Codex Plus makes no changes, so opening an archived conversation leaves it archived.

Delete is available only for conversations archived in the list and asks for confirmation. Codex Plus then checks the conversation and its sub-agents itself. It skips deletion if this window has any of them open or running, or if another VS Code window or Codex process has any of them open. The list shows which conversation or sub-agent prevented deletion.

Codex deletes the conversation's log and its sub-agents' logs. For each deleted conversation, Codex Plus removes its work plan, wake-ups, title colour and entry in this window's recently closed tabs. The Codex Plus output channel lists each deleted conversation on its own line.

## Goals

Ask Codex to set a goal in the conversation. Codex starts another turn whenever the conversation is idle and the goal is active. Codex stops starting turns when the goal is complete, blocked or paused, or when Codex reaches a usage limit or the goal exhausts its token budget.

The row shows `goal`, `goal paused`, `goal blocked`, `goal: usage limit` or `goal: budget spent`. The badge is dimmed unless the goal is active. Hover over it to see the goal and how many tokens it has used from its budget.

In the row's menu, use Pause Goal to pause an active goal or Clear Goal to remove it. Resume Goal is available if the goal is paused, blocked or stopped by a limit.

For the conversation in front of you, use `Codex Plus: Pause Goal`, `Codex Plus: Resume Goal` or `Codex Plus: Clear Goal` in the Command Palette. Codex treats each change as a request from you. Resuming lets Codex start turns again and uses Codex's model calls.

## Account & usage

The Codex part of Account & usage, at the top of the session list, shows how you're signed in: Amazon Bedrock, an API key, or the email and plan of a ChatGPT account. For each rate limit, you can see how much you've used and when it resets. Token counts cover today's usage, total usage and the Codex conversation you last viewed.

These figures require the Codex Plus patch to be active in this window. Codex Plus requests these figures from this window's Codex at most once a minute. Between requests, it uses the notifications Codex already sends to keep the figures current. Codex reports no rate limits for Amazon Bedrock, so those accounts show sign-in details and token counts. No account shows a price or balance.

## What the list takes over from Codex

When Codex conversations first appear in the list, it imports the ones Codex archived and keeps their archive times. Codex sections become groups with the same names. The list pins conversations from Codex's built-in Pinned section and any others Codex marked as pinned. The import also carries over title colours from the former Codex Plus list.

After this one-time import, Agent Plus keeps groups, pins and archive status. Changing them in the list does not move conversations between Codex sections or archive them in Codex.

Codex Plus normally checks daily for conversations Codex archived at least `codexPlus.deleteArchivedAfterDays` days ago (30 by default). In a window where the Agent Plus list handles archiving and deletion, the Codex Plus check does not run. The list uses `agentPlus.sessions.deleteAfterDays` there.
