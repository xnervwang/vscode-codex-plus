# What it costs in tokens

Codex Plus adds work plan text at the start of each turn while the conversation's plan has open rows (rows not `done` or `dropped`); see [How big the work plan is](#how-big-the-work-plan-is).

A request at the end of a turn (an end-of-turn reminder or one of the brief's requests, under [Added now and then](#added-now-and-then)) has a separate cost: Codex answers it with two more model calls that each send the whole context again. The work plan's text, given at the start of the turn, asks for the status before the final reply, so Codex sends the `set_status` call with the turn's other tool calls.

| Feature | Interface features | Essential features | All features | Custom |
| --- | --- | --- | --- | --- |
| Work plan | Off, plugin not loaded | On | On | `codexPlus.workPlan` |
| Time zone | Off | On | On | `codexPlus.tellCodexYourTimeZone` |
| Conversation brief | Off | Off | On | `codexPlus.conversationBrief` |
| Wake-ups | Off | Off | On | `codexPlus.wakeUps` |
| Detached command notices | Off | Off | On | `codexPlus.detachedEndNotices` |
| `claude --bg` session notices | Off | Off | On | `codexPlus.detachedEndNotices` |

Codex Plus follows Agent Plus's `agentPlus.tokenMode` setting, which defaults to All features. Outside Custom, the five settings in the table's Custom column have no effect. Changing modes does not change them. Changing one of those settings outside Custom shows a notice with a Switch to Custom button.

In Interface features, Codex does not load the work plan plugin, just as when you run `Codex Plus: Stop Loading the Work Plan Plugin`. Choosing another mode loads it again unless you stopped loading it yourself. Only conversations started in other modes include the work plan skill (the instructions that tell Codex how to use the work plan) and the `work_plan` tools; changing modes does not add or remove them in open conversations (see Sent with every call). When you switch to Interface features, Codex Plus tells the plugin's hooks (the scripts through which the plugin adds its text) that every feature is off. The hooks keep running in open conversations but stop adding text starting with the next message. After you leave Interface features, the hooks add no text to open conversations until a new conversation starts in Codex. They resume adding text with the next message in each open conversation.

For other mode changes, the work plan and its reminders, conversation brief requests, and the time-zone note follow the new mode starting with the next message in each open conversation. Whenever a wake-up (a prompt the model set to be sent to its conversation later) comes due, Codex Plus checks the current mode to decide whether to send it. `Codex Plus: Show Status` shows the mode and which features run. The information button in a conversation's message box names the mode.

The tables below show the text Codex Plus adds to what Codex sends the model. All of it comes from the work plan plugin Codex Plus installs into Codex; what Codex Plus draws in VS Code sends nothing to the model. Text added to a conversation stays in context and goes with every later model call until compaction replaces the conversation with a summary. A token is about four characters of English.

## Added to every message

| What | When | At most | Turned off by |
| --- | --- | --- | --- |
| The work plan | Each message, while the conversation's plan has a row that is not `done` or `dropped`. The whole block, with what the states mean and how to change a row, on the first message that finds a row open and the first after each compaction; a short head in its place otherwise; one line when no row has changed since the message before | 6,000 characters, the brief included; the one line is about 160 characters and the plan's path (240 with the brief on) | `codexPlus.workPlan` |

## Added now and then

| What | When | At most | Turned off by |
| --- | --- | --- | --- |
| End-of-turn reminders | At the end of a turn that left rows `doing`, asked you something while no row waited on you, or changed things without reading or updating the plan | About 2,550 characters when every reminder and both of the brief's requests come at once, plus the plan's path, which appears four times in that text | `codexPlus.workPlan` |
| The brief's requests | The work plan's text on each message ends with one sentence asking Codex to write the status before its final reply. At the end of a turn: the status once per turn, after a turn that did work without writing it; the summary when there is none, after a top-level row was added, removed or closed, and after a compaction | The sentence counts toward the work plan's limit; the rest counts toward the end-of-turn reminders' limit above | `codexPlus.conversationBrief` |
| No row `doing` | At most once per turn, when the turn has started working and no row is `doing` | About 460 characters and the plan's path | `codexPlus.workPlan` |
| Before a compaction | At 70% and 85% of where Codex compacts, once each between compactions | About 850 characters and the plan's path | `codexPlus.workPlan` |
| After a compaction | Once per compaction | About 970 characters, the plan's path, and the path of its closed rows when it has any. About 360 characters and no path when no row of the plan is open | `codexPlus.workPlan` |
| The offer of a plan | Once, in a conversation with no plan, after your third message, in a turn of at least 25 tool calls | About 480 characters and the plan's path | `codexPlus.workPlan`; `codexPlus.workPlanOfferMinTurns`, `codexPlus.workPlanOfferMinToolCalls` |
| A direct write to the plan, refused | When the model edits the plan file instead of using the tools | About 310 characters | `codexPlus.workPlan` |
| Your time zone | When Codex runs on another machine and its page has not told it the same zone since the last compaction | About 310 characters | `codexPlus.tellCodexYourTimeZone` |
| Images in replies | In Codex's VS Code panel, when a conversation starts and after each compaction, while `codexPlus.replyImages` is on and Codex Plus has been checked against the installed Codex; once on the next message after it is turned off, if the conversation was told | About 450 characters, the conversation's folder included; 68 characters for the sentence after it is turned off | `codexPlus.replyImages` |
| A wake-up | Every interval while one is set, as a message of its own, so a whole turn | The prompt the model set, up to 4,000 characters, every 1 to 1,440 minutes, for 7 days | `codexPlus.wakeUps`; `clear_wakeup` |
| A detached command has stopped | On Linux, when a conversation leaves a command running detached and that command stops: one notice for the commands that stopped within a minute of each other, in All features token mode or in Custom while `codexPlus.detachedEndNotices` is on. If the conversation is idle, the notice starts a turn | About 200 characters, and up to 370 more per command | `codexPlus.detachedEndNotices` |
| A `claude --bg` session has changed | When a conversation starts a `claude --bg` session and the session finishes, fails, stops, dies or waits for an answer: one notice groups session changes that happen within a minute of each other, in All features token mode or in Custom while `codexPlus.detachedEndNotices` is on. If the conversation is idle, the notice starts a turn | About 200 characters, and up to 440 more per session | `codexPlus.detachedEndNotices` |

- The work plan and the wake-up prompt are cut or refused at those sizes by the plugin. The reminders have no cut: each is fixed text with at most six row titles of 60 characters.
- Rows closed more than a day ago are moved out of the plan file to `closed/<thread id>.json` beside it, so reading the plan after a compaction costs less too; Agent Plus's views read both files.

## Sent with every call

| What | When | At most | Turned off by |
| --- | --- | --- | --- |
| The work plan plugin's two skills in Codex's list of skills | Every call | Their names and descriptions of 573 and 94 characters, which Codex shortens to fit the list's budget | `Codex Plus: Stop Loading the Work Plan Plugin`, or the Interface features token mode |
| The `work_plan` MCP server's seven tools | Codex 0.167 finds MCP tools through its tool search, so their definitions join the context once a search returns them | 8,521 characters for all seven | `Codex Plus: Stop Loading the Work Plan Plugin`, or the Interface features token mode |
| Codex's own list of skills, when `codexPlus.skillsListBudget` is not 0 | Every call | That many tokens | `codexPlus.skillsListBudget` at 0, the default |

## Costing nothing

- Everything Codex Plus and Agent Plus draw in VS Code.
- The exceptions are two actions in VS Code that start Codex's own model calls: clicking the context meter compacts the conversation, and Resume Goal lets the goal start turns.
- Hovering the context meter shows, for the conversation in front, how many times the work plan was added since the last compaction, how many characters that came to, and about what share of the context in use.

## How big the work plan is

The hook adds the open rows to the first message with an open plan and explains the row states and the command for changing a row's state. It does this again after each compaction. On later messages, if the rows have changed, the hook includes the open rows with a short header in place of the explanation.

Each open row shows its title, cut to 80 characters. The line for a doing row, or for a row that asks for your answer, also holds its note or question and is cut to 200 characters in all. If nothing but the time spent in each state has changed, the hook adds one line with the counts of `doing` and `waiting` rows and the plan file path, regardless of how many rows are open.

The text stays within 6,000 characters, including the brief's summary and status. When not every open row fits, it says how many it left out.

## Codex's own list of skills

On each turn, Codex puts a list of installed skills in the model's context. Each skill gets one line with its name, description and the path to its `SKILL.md` file. The entries come from Codex's own skills folders and plugins.

Codex budgets the list in tokens, counting about 4 bytes per token. If `skills.max_context_tokens` is set in `config.toml`, Codex uses that value up to a maximum of 10k tokens. Otherwise, the budget is 2% of the model's context window.

When `codexPlus.skillsListBudget` is nonzero, Codex Plus writes its value to `skills.max_context_tokens` in Codex's `config.toml`. The default value of `0` leaves Codex's setting alone.

If the list exceeds the budget, Codex keeps each skill's name and path first. It divides the remaining space among the descriptions, one character per description at a time, so long descriptions are cut to about the same length. If the names and paths alone exceed the budget, Codex drops all descriptions and leaves out skills from the end of the list.

For `gpt-6.1-sol`, Codex uses a 475k-token window, so the default budget is about 9,500 tokens.

Codex does not read `~/.claude/skills`, Claude Code's folder for personal skills. Codex Plus does not add skills from that folder to Codex's list.

`codexPlus.disabledSkills` names skills to turn off. Codex Plus writes each as a `[[skills.config]]` entry with `enabled = false`. Codex leaves the skill out of its list and does not run it when you name it with `$name`. Name a plugin's skill with its plugin, as `Plugin-name:skill-name`. Removing a name removes only the entry this setting added. A value you wrote into `config.toml` yourself is never changed.
