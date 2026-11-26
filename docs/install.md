# Installing and turning off Codex Plus

## Install

Agent Plus (`xnervwang.agent-plus`) is a dependency. VS Code installs it from the marketplace along with this extension; when it is not on the marketplace, install its `.vsix` first, then build this extension from a clone of this repository and install it:

```sh
code --install-extension xnervwang.agent-plus-<version>.vsix
bash build/pack.sh
code --install-extension build/xnervwang.codex-plus-<version>.vsix
```

- In a Remote SSH window, install both on the remote.
- At start-up the work plan plugin is installed into Codex and Codex is patched, without asking, as Claude Code Plus does with Claude Code. Trust the plugin's hooks when asked (or in Codex: Settings > Hooks), and reload the window when asked.
- In Restricted Mode nothing is installed into Codex, Codex is not patched, no file is written, and no archived conversation is deleted.

### After an update of this extension

A new build of Codex Plus usually changes what the patch writes into Codex, leaving an older copy in Codex's files. Codex reads `out/extension.js` and `webview/index.html` when its extension starts and when it builds a page. VS Code reads Codex's `package.json` when a window loads. A reload helps only after the new copy is written. A few seconds after Codex Plus starts, it writes the new copy over the old one and offers a reload. You only need to click that reload.

The patch is written once, into the Codex that every window on this machine loads. Only the window that wrote it offers a reload. If Codex was already running in another window, that window offers a reload once, the next time it gets focus. Until then, it runs Codex's own code without this extension's additions.

At start-up, what happens depends on the state of Codex's files:

- This build's patch: nothing happens.
- An older build's patch: it is written over without asking, then a reload is offered.
- Codex's own files, never patched: they are patched without asking, then a reload is offered.
- Codex's own files after `Codex Plus: Remove the Patch from Codex`: they stay untouched until you run `Codex Plus: Turn On` or `Codex Plus: Toggle On/Off` to put the patch back. Codex Plus remembers the removal, as Claude Code Plus remembers its own Remove.

Codex ships a new build about every week. `Codex Plus: Show Status` tells you whether this release of Codex Plus was checked against your installed Codex build. An unchecked build is still patched if every place the patch edits is found. If one is not found, the patch leaves Codex untouched and the status says so. A warning also says that this Codex version is not supported yet, in VS Code's display language (English, Simplified Chinese or Traditional Chinese); its Show Details button runs `Codex Plus: Show Status`.

### Turning it all off

`Codex Plus: Turn Off`, `Codex Plus: Toggle On/Off`, and `codexPlus.enabled` stop drawing the times, rail, colouring, chimes, buttons, context meter in the message box's toolbar, row below the message box, dots on tab logos, and envelopes after tab titles. Codex is not patched or kept patched, but a patch already applied stays in Codex's files. Turning the additions off does not change their settings. Your choices return when you turn them back on.

`Codex Plus: Remove the Patch from Codex` restores Codex's `out/extension.js`, `webview/index.html` and `package.json`. Uninstalling this extension also restores those files. Reload the window afterwards.

The Interface features token mode, set with `agentPlus.tokenMode` or from Agent Plus's token mode entry in the status bar, makes the work plan, brief, time zone and wake-ups add nothing. Codex is set not to load the plugin, as with Stop Loading. Any other mode loads it again unless you stopped loading it yourself.

`Codex Plus: Stop Loading the Work Plan Plugin` keeps the plugin, its marketplace entry and the trust you gave its hooks. It sets `enabled = false` under `[plugins."agent-work-plan@codex-extras"]` in `config.toml`, so Codex does not load it. Run `Codex Plus: Install the Work Plan Plugin into Codex` to load it again; the install at start-up does not do that. Uninstalling this extension instead removes all three, as described next.

Uninstalling this extension puts Codex's own files back in this editor's extensions folder and in the extensions folder of any other editor that no longer has this extension. Once no editor on the machine has it, the work plan plugin is removed from Codex too. The plans are first copied to `agent-work-plan-plans-<time>` under `CODEX_HOME` (Codex's home folder, `~/.codex` unless you set it). If Codex Plus could not remove the plugin, the plugin stops doing anything once VS Code has deleted the folder where VS Code keeps this extension's data: on each run the plugin checks whether that folder still exists.

Notes on settings and status:

- The work plan has its own setting, `codexPlus.workPlan`, and Agent Plus's session list has its `agentPlus.sessions` settings. `Codex Plus: Turn Off` and `codexPlus.enabled` do not cover them.
- `codexPlus.workPlan`, `codexPlus.workPlanOfferMinTurns`, `codexPlus.workPlanOfferMinToolCalls`, `codexPlus.workPlanQuietWhenReplyMatches`, `codexPlus.conversationBrief` and `codexPlus.tellCodexYourTimeZone` are user settings only. Every window and every `codex` run reads them from one file under `CODEX_HOME`; VS Code ignores their workspace or folder values.
- Turning the additions on or off shows no notification, as in Claude Code Plus. After `Codex Plus: Remove the Patch from Codex`, `Codex Plus: Turn On` and `Codex Plus: Toggle On/Off` put the patch back and offer a reload.
- `Codex Plus: Show Status` shows when additions are off, the patch is removed, or the plugin is installed but not loaded.

### Python

The work plan plugin's hooks and MCP server need Python 3.7 or later. On Windows, the install tries `py -3`, `python` and `python3` in that order; elsewhere, it tries `python3` then `python`. It writes the first one that answers into the installed plugin. Each install starts fresh, so it can find Python if you installed it since the last one.

If no Python is found, the plugin is installed without its hooks, MCP server or skill (the instructions that tell Codex how to use the work plan). The work plan then stays empty, and no turn runs a hook that would fail. A line above the plan in Agent Plus's Work plan view, and `Codex Plus: Show Status`, report the missing Python and the commands tried. As in Claude Code Plus, that line shows the problem to fix first: an installation failure (click to retry), missing Python (click to download it or install again), or untrusted hooks (click to trust them). The line goes once that problem is fixed.

On Windows, clicking that line fetches python.org's embeddable build (11 MB) into this extension's own storage, checks it against a recorded SHA-256, and installs the plugin again. The download is also offered once per version of that build at start-up, as Claude Code Plus offers it. It does not install anything system-wide. It fetches nothing before you press a button.

Elsewhere, install Python 3 and click the line, or run `Codex Plus: Install the Work Plan Plugin into Codex`. python.org publishes an embeddable build for Windows only.
