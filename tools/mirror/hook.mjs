#!/usr/bin/env node
// Mirror mode hook: installed in ~/.claude/settings.json by `node tools/suzy.mjs mirror install`.
// Claude Code runs it (async) on every hook event of every session. For Suzy and AgentCraft
// checkouts it appends one allowlisted, scrubbed line to ~/.agentcraft/mirror/events.jsonl, which
// the Foreman's mirror backend shows in the world. It never blocks or slows a lane: no output on
// stdout or stderr, exit code 0 on every path, no network, no child processes.
import { handlePayload } from './lib.mjs';

process.exitCode = 0;
const quit = () => process.exit(0);
process.on('uncaughtException', quit);
process.on('unhandledRejection', quit);
for (const s of [process.stdout, process.stderr]) {
  try { s.write = () => true; } catch { /* nothing may ever be printed */ }
}

if (process.stdin.isTTY) quit();
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', quit);
process.stdin.on('end', () => {
  try {
    handlePayload(Buffer.concat(chunks).toString('utf8'));
  } catch {
    /* garbage input, missing or read-only dirs, a full disk: never the lane's problem */
  }
  quit();
});
