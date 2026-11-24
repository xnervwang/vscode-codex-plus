# Codex Plus in Codex's page

## Inside a Codex conversation

Timestamps, the rail and the colouring of your own messages are all drawn into Codex's own page. Each needs the patch and then a window reload, since a page runs the script it was built with.

| | |
| --- | --- |
| Where a reply's time comes from | The element Codex marks `data-assistant-message-sent-time` in every reply block. The attribute's value is always `true`, so the time is the clock Codex renders as that element's text. A value that does read as an epoch count, a date string or a clock is taken first, for a build that puts a time there. A message from an earlier day has its clock after the day's name, as `Sunday 9:02 AM`: the date is taken from the date divider Codex draws above the turn, and left off when no divider is in the page. Text that fits none of these is left alone, and its shape (length, class of the first character, whether it is all digits) goes to the Codex Plus output channel. From 26.1117 Codex draws no time on a reply, and a reply then takes the rollout's time for its place in the turn when the rollout holds as many replies in that turn as the page shows. The page's count includes a reply Codex draws in the turn's activity part, above its "Worked for", as in a turn a Stop hook continued. |
| Where your own message's time comes from | First the clock Codex itself renders beside the message, which it shows on hover and which is hidden while this extension's time is on, read as a reply's is. Then, as a second source, the conversation's rollout: the rollout's seconds are used where its minute is the one Codex rendered. The page's messages are matched to the rollout's by the turn id Codex puts on each turn, among that turn's messages of yours when the rollout holds as many of them as the page shows, and failing that by position in the whole conversation when the rollout holds exactly as many messages of yours as the page shows. |
| Seconds on a reply | Codex renders a reply's time to the minute. The rollout's time for that reply is used instead when it is the only reply of its turn in the minute Codex shows. Where no date divider is in the page for a turn, the minute is compared as a clock, and the rollout's date is the one shown. |
| Why seconds are sometimes missing | A drawn time is `HH:MM:SS` when its source carried seconds and `HH:MM` when it did not. |
| A message of another day | Its time starts with the date, `MM/DD HH:MM:SS`, and with the year as well when it is not this year (`YYYY/MM/DD`), as Claude Code Plus writes it. The list of your messages shows the same. |
| What goes on Codex's elements | Class names, and two attributes of this extension's own: one on an image of a reply that stands behind a link or "[Image]", which hides it, and one on the bubble of a Stop hook's prompt, which folds it to one line and which a click on the bubble toggles. Three rules of the stylesheet change Codex's layout: while the rail is drawn the conversation keeps clear of the rail's column on the right, 28 px, by padding on the right of what is inside the element it scrolls in, so the scrollbar stays at the page's right edge; while the row below the message box is drawn the box sits 4 px higher, which that row needs; while the plan bar is drawn the box has 32 px more margin on top, which the bar sits in and which the conversation above gives up. Those class names are styled from one stylesheet of this extension's own, so turning a setting off removes its rules. |
| Where the plan bar goes | It is an element of this extension's own on `<body>`, placed by measuring `[data-codex-composer-root]`: the box's left edge and width, and its top 32 px above the box (26 px of bar, 6 px of gap). A redraw that takes it or its style out of the page has it put back. A click sends back only which part was clicked, `open` or `answer`, and no text from the page. |
| What the page watches | One observer for the times, the rail and the colouring, on the element the conversation scrolls, debounced. It is dropped while the page is hidden, and dropped altogether when all three are off. `Codex Plus: Remove the Patch from Codex` clears every mark (those class names) out of the pages still open before restoring Codex's files. The approval card has its own observer, which keeps running while the page is hidden and is not dropped when these three are off. See [The approval card](#the-approval-card). |

- Which of Codex's attributes these select by is checked against a real sample of a Codex conversation (`test/fixtures/`), so a Codex release that drops one fails a check.
- The opening words on a row of the rail are read in the page and shown there, and are not sent anywhere.
- A compaction point is placed by how many of your messages came before it in the conversation's rollout, so it is shown only while the page shows exactly as many messages of yours as the rollout holds.

## The approval card

| | |
| --- | --- |
| What the page adds | One flag: whether an approval card is on its screen. It finds one with Codex's own selector, the same `[data-codex-approval-surface]:not([data-app-shell-active-page="false"] *)` Codex queries to decide whether an approval surface is up |
| Why the page has a second observer | An approval card is drawn above the message box, outside the element the conversation scrolls, so the observer the timestamps use (see [Inside a Codex conversation](#inside-a-codex-conversation)) cannot see it appear. This one is on a parent element that holds both the conversation and the card, and it keeps running while the page is hidden |

## Sampling a conversation's layout

- The page script can take a sample of the conversation's layout: tag names, class names, attribute names, depth, child counts and rounded sizes, and for each text node its length with the shape of its first eight characters, never any text or attribute value.
- There is no command for it. The render check samples the page it draws and compares the drawn page's `data-*` names with the sample in `test/fixtures/`, taken in a real window.

## Checking what the page found

- Everything in [Inside a Codex conversation](#inside-a-codex-conversation) is drawn inside Codex's page, so only the page can tell whether it found what it looks for.
- The end of `Codex Plus: Show Status` asks the Codex page in front; there is no separate command, as in Claude Code Plus.

| | |
| --- | --- |
| What it reports | The page script's own version; how many turns, messages of yours (and how many of those, such as one sent while a turn ran, had no `data-local-conversation-user-anchor`, the attribute Codex puts on a message that starts a turn), reply blocks, sent-time elements and bubbles were recognised; how many timestamps were drawn on replies and on your messages and which source those on your messages came from (see below); the rail's rows and buttons; how many of your messages were coloured and given a bar; how many images in replies were read and how many of them stand behind a link or "[Image]"; how many Stop hook prompts were folded; whether an approval card is up and which element its watcher is on; whether the row below the message box is drawn; and how many elements this extension added are in the page |
| What it never sends | Any text of the conversation, any title, any time as a string, and no selector read off the page. Every string in the page's report is one of this extension's own constants, and a test checks this |
| Needs | The patch (`Codex Plus: Turn On` after a Remove) **and** a window reload after it, plus a Codex conversation tab in front |
| Where it comes out | The end of `Show Status`, in the Codex Plus output channel |

- The page also speaks up by itself: when a Codex page shows turns and the script has recognised none of the messages in those turns on three checks in a row and for five seconds, one line goes to the Codex Plus output channel and stays in `Show Status`. The page also shows a yellow 16 px "!" at the top right of the conversation, as Claude Code Plus does; hovering over it explains it, and it goes once the messages are found again. The line carries how many turns there were and whether the element the conversation scrolls in was found, and is said only once while the messages stay unfound.
- A window with no patch, with a page left on an older copy of the script, or with no Codex tab in front gets one line saying which of those it is.
- The time on your messages has two possible sources and the report names the one used, because the drawn time looks the same either way: `clock` is the one Codex renders beside the message on hover, `rollout` is the conversation's own record.
- On a hidden page the report also says which of the two observers is running: the one for the times, the rail and the colouring should be gone, and the approval card's should still be there.
