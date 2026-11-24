# Codex Plus

Codex Plus is a VS Code extension that adds features to Codex, OpenAI's VS Code extension (`openai.chatgpt`). It adds a work plan for each Codex conversation alongside your conversations in Agent Plus's views, and a sidebar list of Codex conversations laid out like Claude Code's list. It also adds times, a rail of your own messages, a context meter, chimes and dots on tabs to Codex's conversation page, message box and tabs, plus wake-ups for Codex itself. It depends on Agent Plus (`xnervwang.agent-plus`), which VS Code installs along with it, and it installs a work plan plugin into Codex and edits Codex's installed files.

## Getting started

1. Install Codex Plus. VS Code installs Agent Plus along with it. To install from `.vsix` files instead, see [Install](docs/install.md#install).
2. When Codex Plus starts, it installs the work plan plugin into Codex and edits Codex's installed files without asking. This README calls the file edit "the patch". When Codex asks whether to trust the plugin's hooks (scripts Codex runs at set points, such as when you send a message or when Codex has finished working on it), trust them. You can also do this later in Codex: Settings > Hooks. When Codex Plus offers to reload the window, reload it.
3. After the reload, you see a Codex Plus sidebar listing your Codex sessions. In a Codex conversation, you see the time above every message, a rail of your own messages at the right edge, and an information button, a note button and a context meter in the message box's toolbar. A coloured dot appears on a Codex tab's logo while its conversation is working, has a reply you have not read, or waits for your permission. Your Codex conversations also appear in Agent Plus's Work plan and Conversations views.
4. To turn things off, `Codex Plus: Turn Off` stops drawing what Codex Plus adds to Codex's page and tabs. Agent Plus's token mode (`agentPlus.tokenMode`) decides which features may add text to what Codex sends the model. Set it to Interface features to stop Codex Plus adding anything to what Codex sends the model. `Codex Plus: Remove the Patch from Codex` puts Codex's own files back. All three are in [Turning it all off](docs/install.md#turning-it-all-off).

`Codex Plus: Show Status` shows what is installed, what is patched and what is registered with Agent Plus.

## What it looks like

A Codex conversation, with its work plan (the task list the agent keeps for it) on the left, in Agent Plus, the extension installed with this one:

![A Codex conversation beside its work plan in Agent Plus](images/codex-plus-work-plan.png)

The Codex sessions list in the Codex Plus sidebar:

![The Codex sessions list](images/codex-plus-sessions.png)

## Features

Most of what Codex Plus draws in Codex's page, message box and tabs needs the patch.

| Feature | Where |
| --- | --- |
| Your Codex conversations, with their work plans and the questions in them ([Work plan](docs/work-plan.md#work-plan)) | Agent Plus's Work plan, Conversations and Answer views |
| A work plan for each conversation, which Codex keeps up to date and is given every turn ([Work plan](docs/work-plan.md#work-plan)) | Agent Plus's Work plan view; Codex's context |
| Reminders to Codex at the end of a turn and around a compaction to keep the plan current ([Work plan](docs/work-plan.md#work-plan)) | Codex's context |
| The conversation's brief: its summary and where it stands, written by Codex ([The brief](docs/work-plan.md#the-brief)) | Agent Plus's Answer view |
| Answers to plan questions, sent from Agent Plus into the conversation ([Answering a plan question](docs/work-plan.md#answering-a-plan-question)) | Agent Plus's Answer view; Codex's message box |
| Your time zone, told to Codex when it runs on another machine ([Your time zone](docs/work-plan.md#your-time-zone)) | Codex's context |
| Images in replies: a chart or screenshot the model saves, shown in the reply, and web images shown as links ([Images in replies](docs/conversation.md#images-in-replies)) | Codex conversation; Codex's context |
| Codex's own list of skills: the share of the context it gets, and skills left out of it ([Codex's own list of skills](docs/token-costs.md#codexs-own-list-of-skills)) | Codex's `config.toml` |
| Wake-ups: prompts the model schedules to keep an idle conversation going ([Wake-ups](docs/work-plan.md#wake-ups)) | Codex conversations open in this window |
| A list of your Codex conversations laid out like Claude Code's, with groups, search, status dots, unread envelopes and account usage ([The session list](docs/session-list.md)) | Codex sessions view, in the Codex Plus sidebar |
| Archiving and deleting conversations, and deleting old archived ones ([Archive and delete](docs/session-list.md#archive-and-delete)) | Codex sessions view |
| Pausing, resuming and clearing a conversation's goal ([Goals](docs/session-list.md#goals)) | Codex sessions view; command palette |
| A Codex button on the tab bar, dropped and closed tabs reopened, and dots, titles and unread envelopes on Codex tabs ([Tabs](docs/tabs.md)) | Editor tab bar and tabs |
| A time on every message and reply, a rail of your own messages, your messages marked, and a Stop hook's prompt folded to one line ([In a conversation](docs/conversation.md)) | Codex conversation |
| Each reply's context share, model, effort and duration, and the tool call and commands still running ([In a conversation](docs/conversation.md)) | Codex conversation; the row below the message box |
| Links that open your other conversations when a reply mentions them by a title in 「」, a whole title or a conversation ID ([In a conversation](docs/conversation.md)) | Codex conversation |
| An information button, a chime button, a context meter that compacts on a click, and the Agent map ([The message box's toolbar](docs/message-box-toolbar.md)) | Codex message box's toolbar |
| Chimes when a turn finishes, a question waits for you, or Codex stops for your permission ([Chimes](docs/waiting-and-chimes.md#chimes)) | Codex tab; Codex's sidebar |
| A conversation stopped for your permission, shown as waiting ([Waiting for your permission](docs/waiting-and-chimes.md#waiting-for-your-permission)) | Agent Plus's Conversations view; editor tabs |
| What is installed and running, and how long Codex's pages took to open ([Show Status](docs/status-and-load.md#show-status)) | Command palette; Codex Plus output channel |
| The token mode, which decides which of these add to what Codex sends the model ([What it costs in tokens](docs/token-costs.md)) | Agent Plus's status bar entry |

## For developers

How Codex Plus is checked against each new Codex build, and the render check that draws Codex's real page with this extension's script in it, are in [CONTRIBUTING.md](CONTRIBUTING.md). How the script this extension adds to Codex's page finds what it draws on, and how to see what it found, are in [docs/codex-page.md](docs/codex-page.md).
