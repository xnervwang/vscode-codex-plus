# Show Status, CPU and disk

## Show Status

`Codex Plus: Show Status` writes to the Codex Plus output channel and shows:

- What is installed, what is patched, and what is registered with Agent Plus.
- The token mode and which of the five features that add to Codex's context run (the five are listed under [What it costs in tokens](token-costs.md)).
- Whether the additions are turned off, the patch was removed, or the plugin is installed but not loaded.
- Whether this release was checked against the installed Codex build.
- Any part of the patch that Codex Plus left out because it did not recognize the code it edits in this Codex build, and what stops working without it. Codex Plus also writes this to the output channel when it starts.
- Whether Python is missing, and which commands were tried to find it (see [Python](install.md#python)).
- The wake-ups that are set.
- Commands Codex started that are still running, when each started, and which conversation it belongs to.
- The last three times a Codex page opened and how long each took.
- At the end, what the page script found in the Codex page in front, explained in [docs/codex-page.md](codex-page.md#checking-what-the-page-found).

`Codex Plus: Show How Long Opening a Codex Page Took` shows how long each Codex page, in the sidebar or a tab, took to open. It shows how long it took to run Codex's page script, show the first screen, show the conversation or home page, and restore the conversation. It also shows which pages gave up.

Codex logs these stages only when a setting it fetches from OpenAI allows it. When it does not, for example with no network or with a model provider other than OpenAI, the command shows only how long each page took to start. This command reads Codex's own log, `Codex.log`, in every window's log folder. It needs nothing else.

## CPU and disk

In the background, Codex Plus checks every 3 seconds whether Codex's files have changed. About every 12 seconds, it scans the machine's processes (`/proc`, so on Linux) for work a conversation started that is still running after its turn. VS Code windows on one machine share a scan: a window uses one another window wrote less than 9 seconds ago instead of scanning itself. If a conversation log has not changed since the last read, it is skipped.

The table below shows single operations measured in isolated runs on one machine on 2026-11-15. Each result is the median of 12 runs.

| What | How often | CPU | Read |
| --- | --- | --- | --- |
| Checking whether Codex's files changed, when none did | Every 3 seconds | 0.23 ms | 105 bytes |
| Scanning processes for work left running | About every 12 seconds | 38.5 ms; 45 ms when it also writes the shared result | 0.49 MB |
| Using the scan another window wrote | In place of a scan | 0.07 ms | 258 bytes |
| Reading the conversations, with the five largest open in tabs | When a file changed | 92 ms the first time, then 0.6 to 1.5 ms while those files do not change | 28.8 MB the first time, then about 100 bytes |

Turning `codexPlus.enabled` off stops the process scan. The 3-second check keeps running because the session list and Agent Plus's views use it. To stop that check too, disable Codex Plus in VS Code's Extensions view.
