# <LANE>: <one line: what this lane delivers>

Copy this file, fill every section, and start the lane with
`node tools/suzy.mjs start <LANE> --brief <this file>`. The launcher stores it as the shared
memory note `Brief: <LANE>`; the lead reads it from there and plans the tasks. Delete these
instruction lines and anything in angle brackets before you start.

## Goal

<Two or three sentences: the outcome for the founder or a guest, not the activity. Name the
one number or behavior that tells us it worked.>

## Context (files to read)

Read these before planning. The lead passes the relevant ones to each worker.

- `CLAUDE.md` (always)
- `.claude/skills/suzy-gates/SKILL.md` (always: the six gates and the self-audit)
- `.claude/skills/suzy-lane/SKILL.md` (router: which other suzy-* skill applies)
- <path>: <why it matters to this lane>
- <path>: <why>

## Tasks

One task per worker-sized change. Each task names its Zone: the only paths it may edit.
A task that needs a file outside its Zone stops and asks; it does not widen its own Zone.

1. **<task title>**
   Zone: `<path/or/glob>`, `<path>`
   Do: <what changes>
   Test: <the test file that proves it, new or existing>
2. **<task title>**
   Zone: `<path>`
   Do: <...>
   Test: <...>

## Done-criteria

- <observable behavior 1>
- <observable behavior 2>
- Per-task CI green on every task (typecheck, lint at the repo's warning cap, vitest on the
  changed files). The full frontend job runs at `node tools/suzy.mjs ship <LANE>`.
- No file changed outside the Zones above.

## Proof required

- **Red then green** for every new or changed test: show it failing with the fix undone by a
  hand edit, then passing with the fix in place. Paste both outputs, trimmed.
- **Suite counts** before and after: `npx vitest run` totals (files, tests, passed, failed,
  skipped) on the base and on the lane branch. The after count is the before count plus the
  new tests, or the report explains each difference.
- Lint warning count before and after (it may only stay the same or drop).

## Forbidden

Any of these is a STOP: the agent stops and asks the founder in game. No workaround.

- n8n imports or any write to live n8n (`scripts/n8n-import.js --apply`, `--restore`, the n8n API).
- Vapi pushes (`scripts/vapi-assistant.js` against the live assistant, any Vapi API write).
- Twilio: sending SMS or calls, changing numbers, webhooks or messaging services.
- Stripe: any API call, product, price, webhook or billing change.
- Guest data: reading, copying or pasting real guest names, phone numbers, emails, messages or
  reservations. Use fixtures only.
- Keys: creating, reading, printing or committing any key, token or `.env*` file
  (`.env.example` excepted, with empty values).
- The crisis path: `frontend/src/lib/crisisGate.ts`,
  `workflows/Suzy_Inbound_Shield_v1.json` and anything they import, unless this brief's
  Tasks name them in a Zone and the founder approved that in writing here.
- Pushing, merging into `dev` or `main`, or opening PRs. The founder ships with
  `node tools/suzy.mjs ship <LANE>`.

## Report

At the end the lead writes a short summary into shared memory as `Report: <LANE>`, in this
order:

1. What changed: one line per file.
2. Proof: red then green per test, suite counts before and after, lint count.
3. Counts: tasks done, CI runs and results, decisions asked.
4. UNVERIFIED: everything claimed but not proven by a command that ran.

The founder then runs `node tools/suzy.mjs report <LANE>`, which writes
`artifacts/reports/<LANE>.md` from the Foreman's own records (tasks, CI runs, decisions,
spend, git) as the cross-check.
