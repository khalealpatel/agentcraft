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
know those flags yet, `start` says so in a WARNING and launches without them.

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
