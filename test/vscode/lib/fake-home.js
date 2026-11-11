// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The CODEX_HOME the window runs against: one conversation written by test/render/lib/fake-codex-home.js for each
 * entry of THREADS, and a config.toml that sends every turn to fake-model.js. Each conversation's cwd is changed to the folder
 * the window opens, since the session list shows only conversations whose cwd is in the workspace. The provider sets
 * requires_openai_auth = false, so Codex's page does not ask anyone to sign in.
 *
 * Codex listens on <CODEX_HOME>/ipc/ipc.sock, and a Unix socket's path is limited to about 104 bytes, so the home has to
 * be under a short folder: run.js puts it in the system's temporary folder.
 *
 * The first conversation also has a work plan block (PLAN_BLOCK) after its first message, recorded the way Codex records
 * the plugin's injection, so that the information box shows a Work plan line.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const render = require('../../render/lib/fake-codex-home');

const THREADS = [
  { id: render.THREAD, title: 'Can you find where the retry delay for the inventory sync is set?' },
  { id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61', title: 'Why does the nightly export skip archived rows?' },
  { id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a62', title: 'Add a dry-run flag to the cleanup script' },
];
const PROVIDER = 'fake';
const PLAN_DIR = path.join('plugins', 'data', 'agent-work-plan-codex-extras');
const PLAN_BLOCK = "This conversation's work plan (1 doing). Only open rows are shown.\n\n> 1. Find the retry delay   [doing]";

/* A developer message holding the work plan block, after the line of the conversation's first message. */
function withPlan(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.includes('"id":"msg_u0"'));
  if (at < 0) return text;
  const stamp = JSON.parse(lines[at]).timestamp;
  lines.splice(at + 1, 0, JSON.stringify({ timestamp: stamp, type: 'response_item', payload: { type: 'message', role: 'developer',
    content: [{ type: 'input_text', text: PLAN_BLOCK }] } }));
  return lines.join('\n');
}

function write(home, { folder, modelUrl }) {
  const cwd = JSON.stringify(folder).slice(1, -1);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cxp-fake-'));
  try {
    THREADS.forEach((t, i) => {
      const made = render.write(path.join(scratch, String(i)), { days: [[i, render.FOUR.length]] });
      const sessions = path.join(made.codexHome, 'sessions');
      for (const rel of fs.readdirSync(sessions, { recursive: true })) {
        const from = path.join(sessions, rel);
        if (!from.endsWith('.jsonl')) continue;
        const text = fs.readFileSync(from, 'utf8').split(render.THREAD).join(t.id).split(render.CWD).join(cwd)
          .split('"model_provider":"openai"').join(`"model_provider":"${PROVIDER}"`)
          .split(render.FOUR[0].user).join(t.title);
        const to = path.join(home, 'sessions', path.dirname(rel), path.basename(rel).split(render.THREAD).join(t.id));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, i === 0 ? withPlan(text) : text);
      }
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(home, 'config.toml'), [
    `model = "${render.MODEL}"`, `model_provider = "${PROVIDER}"`, 'model_reasoning_effort = "high"', '',
    `[model_providers.${PROVIDER}]`, 'name = "Made-up model for the tests"', `base_url = "${modelUrl}"`, 'wire_api = "responses"',
    'requires_openai_auth = false', '', '[analytics]', 'enabled = false', ''].join('\n'));
  return { home, threads: THREADS };
}

/* A wake-up of `thread`, as the work plan's set_wakeup tool writes one (src/wakeup.js), so the Agent map has a timer. */
function wakeup(home, thread, { everyMinutes = 45, prompt = 'Check whether the nightly export has finished.' } = {}) {
  const dir = path.join(home, PLAN_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(dir, `${thread}.wakeup`), JSON.stringify({ everyMinutes, prompt, setAt: now, expiresAt: now + 7 * 86400 }));
}

module.exports = { write, wakeup, THREADS, PLAN_BLOCK };
