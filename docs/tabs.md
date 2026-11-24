# Tabs

## Opening a conversation in a tab

The Codex button on the editor's tab bar and New in tab in the session list open a new Codex conversation in a tab. They use an editor group holding only Codex tabs if one exists, otherwise a group holding any Codex tab, otherwise the first group (the main editor area). They never open a new split.

With the patch in effect, the tab bar shows Codex Plus's button instead of Codex's own. It opens what `codexPlus.tabBarButton` specifies: `tab` by default, or `sidebar`. Its hover says *New Codex Conversation in a Tab* or *Open Codex Sidebar* to match. VS Code takes that hover from the command's title in the extension's `package.json`, so the patch adds a condition to Codex's `package.json` that hides Codex's button while this extension's is shown. The button appears once the window has been reloaded after the patch is written.

The patched `Codex: New Codex Agent` command opens a new conversation in a separate tab each time you run it, including when you click `New chat` on a Codex page in an editor tab. The patch gives each tab's address, the URI VS Code opens it on, a unique `#…` ending, just as Codex Plus's tab bar button and `New in tab` in the session list do.

If you turn off `codexPlus.enabled` or run `Codex Plus: Remove the Patch from Codex`, Codex reuses the same address, so VS Code brings the tab already open at that address, with its conversation, back to the front. This is a Codex bug: [openai/codex#15807](https://github.com/openai/codex/issues/15807).

## Reopening tabs

Codex Plus reopens tabs that VS Code did not restore after a reconnect. The status bar reports how many for ten seconds, as Claude Code Plus does. `codexPlus.reopenDroppedTabs` turns this off. After a window reload, VS Code restores Codex tabs. If you open a tab with the Codex Plus tab bar's New button, the session list's New in tab, or Codex's New Codex Agent, Codex shows an empty conversation in the restored tab. Codex Plus remembers which conversation the tab showed and reopens it in the same tab with its name.

VS Code builds a restored Codex tab's page only when the tab is shown, so a conversation in a background tab gets no wake-ups or notices until you click it. If the tab is not shown within about 30 seconds of the window starting, Codex gives up and shows "Codex could not start" in that tab. Close the tab and open the conversation again. If you turn on `codexPlus.loadRestoredTabs` (off by default), Codex Plus briefly shows each restored background Codex tab when the window starts, then brings back the tab you had in front.

If the last tab you closed was a Codex tab, Ctrl+Shift+T (Cmd+Shift+T on a Mac) reopens its conversation, just as Claude Code's shortcut reopens its last session. After any other tab, it runs VS Code's Reopen Closed Editor. `codexPlus.reopenClosedSessionShortcut` turns this off.

## Dots, titles and the tab menu

The dot on a Codex tab's logo matches Claude Code Plus's dots in colour and size. The tab shows a green dot while a turn runs, a green ring when only work started by the conversation is still running, and a red dot while the conversation waits for your permission or answer. If a turn adds a question for you to the conversation's work plan after your last message, both the tab and the conversation's row in the session list show the red dot once that turn ends. A stopped conversation keeps Codex's own logo with no dot.

The tab title follows the conversation name in Codex, including when you start the conversation in a tab. While you have an unread reply, the title ends with an envelope (📩). In a light theme you see the plain envelope's text form (✉︎). The envelope appears only on screen and is not part of the conversation name.

Rename opens without the envelope and does not save one you type into the new name. When the tab bar cannot fit the whole title, VS Code cuts off the end, including the envelope. The session list draws the envelope separately, so it stays visible there.

The right-click menu on a Codex tab has the same three actions as on a Claude Code tab (Rename, Mark as Unread and Add to Group), and each acts on the conversation in the tab you right-clicked, even when another tab is in front. Add to Group opens a list at the top of the window. You need the patch for the dots, titles and tab bar button.
