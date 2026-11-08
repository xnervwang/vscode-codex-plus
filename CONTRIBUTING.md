# Contributing

## Layout

- `extension.js`: activation, settings, commands, status bar; wires the parts below together.
- `src/codex-files.js`: CODEX_HOME, the state database (read-only), rollouts (plain or `.jsonl.zst`), read receipts.
- `src/codex-tabs.js`: Codex conversation tabs (`chatgpt.conversationEditor`, `openai-codex://route/local/<id>`), opening one in a tab.
- `src/codex-source.js`: Codex as a source of the shared-sidebar protocol (major 3).
- `src/host-link.js`: finding claude-code-extras' `workPlanHost`, registering, the `codexExtras.standalone` / `codexExtras.hosted` keys.
- `src/focus.js`: which conversation is in front when this extension draws the shared views.
- `src/workplan.js`, `src/workplan-view.js`: plan files and their tree (from claude-code-extras, plan directory changed).
- `src/conversations.js`, `src/conversations-view.js`, `src/conversations-text.js`, `src/l10n/`: the Conversations tab.
- `src/logo-dot.js`: an agent's logo with a state dot, written into global storage.
- `src/answer-view.js`, `src/answers.js`: the Answer view and the cross-window answer folder (format 1).
- `src/sessions-view.js`, `src/tab-memory.js`, `src/session-info.js`: the Codex sessions view, recently closed and dropped tabs, session information.
- `src/appserver.js`: a short-lived `codex app-server` client.
- `src/plugin-install.js`: installing, trusting and removing the companion plugin through app-server.
- `codex-plugin/`: the companion Codex plugin (marketplace `codex-extras`, plugin `agent-work-plan`): hooks, skill, MCP server.
- `src/edits.js`, `src/host.js`, `src/webview-inject.js`, `src/adapters.js`, `src/patching.js`, `uninstall.js`: the patch to Codex and its use.
- `src/page/codex-extras-page.js`: the script added to Codex's page.
- `src/webview-limit.js`, `src/request-limit.js`: VS Code's webview request limit.

## Checks

- `node test/check.js`: the whole suite, no dependencies; parts in `test/parts/`, run in name order.
- `node test/e2e-codex.js <codex> <CODEX_HOME>`: the work plan against a real codex; needs model credentials.
- `node test/against-latest.js`: the patch against the newest Codex on the marketplace (`CODEX_EXTRAS_PRERELEASE=1` for pre-releases).
- `node test/against-host.js`: the protocol major and answer format against the newest claude-code-extras on the marketplace.
- `bash build/pack.sh`: runs the suite and builds the `.vsix`.

## Rules

- `package.json` `version` changes only for a release.
- Code, comments and commit messages are English; every source file starts with the BSD 3-Clause header.
- The page script never puts a node inside one Codex draws.
- Every patch edit matches exactly once on a pristine Codex build, or nothing is written.
