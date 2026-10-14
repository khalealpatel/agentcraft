# Suzy studio: the founder flow

The studio runs a Suzy lane with the AgentCraft team in Minecraft, on a dedicated checkout
`~/suzy-studio` (origin `khalealpatel/suzy-ai-engine`). Each lane works on its own branch
`studio/<lane>`, cut from `origin/dev`, and reaches GitHub through the normal PR flow. Nothing
is pushed until you run `ship --apply` yourself.

All commands run from your AgentCraft checkout (`~/agentcraft`). macOS or Linux.

## 1. Doctor

```sh
node tools/suzy.mjs doctor
```

Checks Node 22+, Java 25 (found the way `tools/unix.mjs` finds it), that `~/suzy-studio` is a
checkout whose origin is `khalealpatel/suzy-ai-engine`, that `frontend/node_modules` is
installed (per-task CI links it), and that no `.env*` file other than `.env.example` sits
anywhere outside `node_modules`. Agents can read every file in the studio, so keys stay out.
Each failure prints the exact command that fixes it.

## 2. Start

Write the brief from [STUDIO-BRIEF-TEMPLATE.md](STUDIO-BRIEF-TEMPLATE.md), then:

```sh
node tools/suzy.mjs start STUDIO-07 --brief ~/briefs/STUDIO-07.md
```

`start` runs the doctor, refuses a dirty studio, fetches `origin`, creates and checks out
`studio/studio-07` from `origin/dev`, stores the brief as the shared memory note
`Brief: STUDIO-07`, and launches the Foreman (profile `suzy`, your claude.ai login) and the
game. The lead gets one goal: execute that brief, following `CLAUDE.md` and the `suzy-gates`
skill.

| option | default | |
| --- | --- | --- |
| `--lead-model` / `--worker-model` | `opus` / `sonnet` | |
| `--workers` | `juniper,kit` | comma list from the cast |
| `--max-budget <usd>` | none | per-turn cap |
| `--resume` | | continue an existing `studio/<lane>` branch (no new goal) |
| `--archive-previous` | | move the previous lane's profile aside (`~/.agentcraft/suzy-<lane>-<time>`) |
| `--dry-run` | | print every step and the launch command; change nothing |
| `--no-launch` | | do the branch and brief, print the launch command, start nothing |
| `--studio`, `--home`, `--port` | `~/suzy-studio`, `~/.agentcraft`, 7878 | |

One lane per profile: the Foreman remembers the branch a repo was registered on, so a new
lane refuses to start on a profile that holds another one. Write that lane's report first,
then pass `--archive-previous`. A running `suzy` Foreman must be stopped first
(`node tools/suzy.mjs stop`).

The Foreman also gets `--setting-sources project` (agents load only the studio's own Claude
settings) and `--zones suzy` (edits limited to each task's Zone). If your Foreman does not
know those flags, `start` refuses before it touches the studio and names the fix (merge
STUDIO-01 / update the fork): without `--setting-sources` the agents would load no Claude
settings at all (no `CLAUDE.md`, no skills, no hooks), and without `--zones` no write zones are
set. Only `--backend sim` (testing) still launches, with a WARNING that says what is missing.

**Per-task CI.** After each task the Foreman runs, in the worker's worktree,
`node tools/suzy.mjs ci --studio ~/suzy-studio --base studio/<lane>`: it links
`frontend/node_modules` from the studio (no install per task), then runs the `frontend` job's
typecheck and lint (with the repo's warning cap) as `ci.yml` on the lane branch has them, and
`vitest related` on the files the task changed. Measured on a throwaway worktree with one
changed file: about 60 s (tsc 22 s, eslint 31 s, vitest 7 s).

## 3. Watch and answer

Play. Workers ask questions and permissions at their desks; the lead brings each finished task
to the merge station with its CI result and review. Status from a terminal:

```sh
node tools/suzy.mjs status
```

## 4. Merge in game

Approve, request changes or reject each task at the merge station. Approved tasks merge into
`studio/<lane>` in `~/suzy-studio` (never into `dev`). Merges are refused while the studio has
uncommitted changes, so leave that checkout alone while a lane runs.

## 5. Report

```sh
node tools/suzy.mjs report STUDIO-07
```

Writes `artifacts/reports/STUDIO-07.md` from the profile's `state.json`, the agent logs and git:
what changed (commits, diffstat), each task with assignee, zone, CI result and review outcome,
the decisions you answered, the commands that ran as tests, counts, spend, and an UNVERIFIED
list. It re-runs nothing.

## 6. Ship

```sh
node tools/suzy.mjs stop
node tools/suzy.mjs ship STUDIO-07
node tools/suzy.mjs ship STUDIO-07 --apply
```

`ship` refuses unless `~/suzy-studio` is on `studio/<lane>` and clean, runs the full `frontend`
CI job (typecheck, lint, i18n, all vitest; `npm ci` skipped, the installed modules are used),
and prints `git log --oneline origin/dev..HEAD` and the diffstat. That is the dry run. With
`--apply`, from an interactive terminal only, it runs `git push origin studio/<lane>` and
prints the PR link (`compare/dev...studio/<lane>`). It never pushes anything else.

## Mirror mode: watch your own Claude Code lanes

Keep working exactly as you do now: Claude web writes a brief, you paste it into a normal
Claude Code session. Mirror mode shows every such session in the AgentCraft world as an agent:
it walks to the library, desk, testbench and merge station, its nameplate says what it is
doing, its task card is titled with the lane ID, its monitor shows each tool call with ok or
error, the CI lamp follows its test runs, and it stands at the podium when Claude Code waits
for you. It is a read-only mirror: it runs no agents, calls no API, needs no key, and never
changes, answers or blocks a lane. Answering a permission prompt stays in Claude Code.

**Install once.** From `~/agentcraft`:

```sh
node tools/suzy.mjs mirror install
node tools/suzy.mjs mirror install --apply
```

The first command is a dry run: it prints your settings path (`~/.claude/settings.json`) and
the exact hooks block. Read it, then run the second from your own terminal (it refuses
anywhere else). It backs the file up to `settings.json.bak-<time>`, appends one async hook per
event without changing or reordering any hook you already have, and does nothing if it is
already installed. Re-run it after moving to another Node version (the hook command names
this Node by its full path). `mirror uninstall [--apply]` removes only these entries.

**Watch whenever you want.**

```sh
node tools/suzy.mjs watch
```

starts the Foreman (`--backend mirror --profile mirror`) and the game. New Claude Code sessions
in a `khalealpatel/suzy-ai-engine` or `khalealpatel/agentcraft` checkout (any worktree of
them) show up; sessions in any other repo are ignored. Events written while the game or the
Foreman was off are applied on the next `watch`, without duplicates. To see an agent move
without opening Claude Code: `node tools/suzy.mjs mirror test`.

| Claude Code | In the world |
| --- | --- |
| session starts | the next free cast member goes on shift (workers first, Marlow last), with the session's model |
| first prompt with `# FIRING BRIEF: <ID>` or ``Name `<ID>` `` | a task card titled with the lane ID, `doing` |
| Read, Grep, Edit, Write, Bash... | state, station and nameplate activity; one monitor line per call (ok or error) |
| a test command (`npm test`, `npm run check`, `vitest`...) | CI lamp `running`, then `pass` or `fail` |
| `git push`, `gh pr create` | the merge station; feed "Pushed ..." / "PR opened from <branch>" |
| waiting for a permission or your next prompt | at the podium, "waiting on you 12m" (display only; the minutes refresh once a minute) |
| the turn ends | the card goes to `review`, the agent back to the lounge, and the feed says `VOICE-PROMPT-02 finished: 2h10m, waited on you 23m across 4 stops, tests 6/6` |
| session ends, or 30 min without events | off shift |

More than six live sessions: the extra lanes get task cards without an avatar, and take the
next agent that goes off shift. History is permanent: finished cards stay in the done column
of the Task Wall, the monitor logs and feed survive restarts, and each lane gets a record in
the library (`memory/lanes/<lane>.md`, unnamed sessions as `unnamed-<date>-<n>`): repo, branch,
agent, start, end, duration, files touched (up to 40), test runs with pass or fail, whether a
PR was opened, and errors.

**What the hook writes.** `~/.agentcraft/mirror/events.jsonl` (file mode 600, folder 700,
rotated at 5 MB keeping two old files), one line per event: a hash of the session id, repo,
branch, event, tool name, the file path relative to the repo, the first 80 characters of a
Bash command, ok or error with the exit code, and the lane ID. Never your prompt text, file
contents, tool output or environment; an `.env*` file other than `.env.example` shows as
`[env file]`. Tokens and keys (`sk-ant-`, `sk-`, `ghp_` and friends, `xoxb-`, `AKIA`, `Bearer`,
`Authorization:`, `*_KEY=`, `*_TOKEN=`, `*_SECRET=`, `PASSWORD=`, URLs with credentials, long
base64 or hex runs) become `[redacted]`. The hook prints nothing, always exits 0, never touches
the network, and Claude Code runs it in the background (`"async": true`), so it cannot slow a
lane.

## Numbers: where each lane's time went

Every mirrored lane gets numbers computed from the same events, locally, with no API and no
network. They show where the time went, above all how long each lane waited on you.

```sh
node tools/suzy.mjs stats                              # lanes of the last 7 days, as a table
node tools/suzy.mjs stats --since 2026-10-01           # from a date (UTC)
node tools/suzy.mjs stats --lane VOICE-PROMPT-02 --md  # one lane as a block to paste into a PR body
node tools/suzy.mjs stats --json                       # machine output for later tooling
```

`stats` is read only. It writes nothing except `~/.agentcraft/mirror/lanes.json` (mode 600), a
cache rebuilt from the events on every run. It reads `events.jsonl` and its two rotated files.
`--lane` looks at every lane unless you give `--since`. Example (the recorded fixture in
`tools/test/fixtures/mirror-stats/`):

```text
lane             wall    active  waited  stops  longest  idle        tests  PR
---------------  ------  ------  ------  -----  -------  ----------  -----  ---
VOICE-PROMPT-02  2h10m   1h22m   23m     3      11m      25m (1)     3/1    yes
STUDIO-RESUME    16h10m  1h20m   0m      0      0m       14h50m (1)  3/0    yes
```

| Number | Definition |
| --- | --- |
| lane | The lane ID from the brief. A lane can span several sessions, so numbers group by lane ID, not by session. A session without one is `unnamed-<date>-<n>` (UTC date, numbered in start order) |
| wall | First to last event of the lane, overnight gaps included |
| waited on you (stops, longest) | Each Notification (a permission prompt, your next prompt, a question) opens a wait; it closes at that session's next event that is not a Notification. Back to back Notifications are one wait. `auth_success` is not a wait |
| idle | No events for over 10 minutes while not waiting: the lane is stuck or you are away. A tool that was started and has not reported back is running, not idle |
| active | wall minus waited minus idle |
| tool calls | read (Read, Grep, Glob, LS), edit (Edit, MultiEdit, Write, NotebookEdit), bash, other |
| files touched | Repo-relative, unique, files an edit tool changed successfully; the count and the top 10 by edits |
| tests | Runs of a test command (the ones that move the CI lamp), passed and failed; the first-run pass rate is the share of distinct commands whose first run passed |
| PR | `yes` if the lane ran `gh pr create` or pushed its own branch (branch name only) |
| errors | Tool calls that failed |
| model | The model the session reported on start (the latest, when it changed) |

Edge cases, each tested:

- **A wait still open** at the end of the log is counted as open and measured up to now
  (`12m (open)`). If its session never wrote again but the lane has a later session, the wait
  ends where that session starts.
- **Clock skew**: a timestamp that goes backwards is clamped to the previous one and counted
  (`skew` in `--json`); no duration is ever negative.
- **Rotation**: the log is rotated at 5 MB keeping two old files; `stats` reads all three, once
  each. Anything older than that is gone, and so are its numbers.
- **A lane resumed the next day** is one lane. If the resumed session reports `resume` and carries
  no brief, it joins the lane most recently seen on the same repo and branch; a plain new session
  on the same branch stays its own unnamed lane.

**In the world.** The lane's library note (`memory/lanes/<lane>.md`) opens with a `## Numbers`
section with the same numbers; a lane waiting on you shows `waiting on you 12m` on its nameplate
(refreshed at most once a minute) and stays on shift for up to 2 hours instead of being sent off
shift after 30 quiet minutes; and when a turn ends the feed says how long the lane took (wall minus
idle, waiting included), how long it waited on you and across how many stops, and its tests
passed over runs. Numbers need events the Foreman applied: a session that was already saved when
this version first ran counts from its next event, and its note says so.
