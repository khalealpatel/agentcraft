// Pure helpers for tools/suzy.mjs (the Suzy studio launcher): names, checks, CI parsing, the
// launch command, the brief memory note and the lane report. No process spawning here, so
// everything is unit-testable (tools/test/suzy.test.mjs).
import fs from 'node:fs';
import path from 'node:path';

export const SUZY_REPO = 'khalealpatel/suzy-ai-engine';
export const PROFILE = 'suzy';
export const BASE = 'origin/dev';
/** written into the profile by `start`: which lane owns this profile's state */
export const LANE_FILE = 'studio-lane.json';

/** "STUDIO-02" -> { lane: "STUDIO-02", branch: "studio/studio-02" } */
export function laneName(raw) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(raw)) {
    throw new Error(`bad lane name "${raw ?? ''}" (letters, digits, _ and -, like STUDIO-02)`);
  }
  return { lane: raw, branch: `studio/${raw.toLowerCase()}` };
}

/** origin must be the Suzy repo: https or ssh form, with or without .git */
export function originMatches(url) {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return !!m && m[1].toLowerCase() === SUZY_REPO;
}

/** `.env*` files other than `.env.example`, relative to root (node_modules and .git skipped) */
export function findEnvFiles(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.startsWith('.env') && e.name !== '.env.example') found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found.sort();
}

/**
 * The `frontend:` job of a GitHub Actions workflow: its working directory and the `run:` steps,
 * in order. A minimal line parser for the shapes ci.yml uses (single line and `|` block runs).
 */
export function parseJob(yaml, jobName = 'frontend') {
  const lines = String(yaml).replace(/\r\n/g, '\n').split('\n');
  const startIdx = lines.findIndex((l) => new RegExp(`^  ${jobName}:\\s*$`).test(l));
  if (startIdx < 0) throw new Error(`no "${jobName}" job in the workflow`);
  let end = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]) || /^\S/.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(startIdx + 1, end);
  const job = { name: jobName, workingDirectory: undefined, steps: [] };
  let stepName;
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (/^\s*#/.test(line)) continue;
    const wd = /^\s*working-directory:\s*(.+?)\s*$/.exec(line);
    if (wd && !job.workingDirectory && !job.steps.length) { job.workingDirectory = unquote(wd[1]); continue; }
    const name = /^\s*- name:\s*(.+?)\s*$/.exec(line);
    if (name) { stepName = unquote(name[1]); continue; }
    if (/^\s*- uses:/.test(line)) { stepName = undefined; continue; }
    const run = /^(\s*)(?:- )?run:\s*(.*?)\s*$/.exec(line);
    if (!run) continue;
    let value = run[2];
    if (value === '') continue; // `defaults: run:` mapping, not a command
    if (value === '|' || value === '>') {
      const indent = run[1].length;
      const block = [];
      while (i + 1 < body.length && (body[i + 1].trim() === '' || body[i + 1].search(/\S/) > indent)) block.push(body[++i]);
      const cut = Math.min(...block.filter((b) => b.trim()).map((b) => b.search(/\S/)));
      value = block.map((b) => b.slice(cut)).join('\n').trim();
    } else value = unquote(value);
    job.steps.push({ name: stepName ?? value, run: value });
    stepName = undefined;
  }
  return job;
}

function unquote(s) {
  const t = s.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

const isInstall = (run) => /^npm (ci|install)\b/.test(run);

/** Steps of the full frontend job, without the dependency install (ship runs these). */
export function fullCiSteps(job) {
  return job.steps.filter((s) => !isInstall(s.run));
}

/** The fast per-task subset: typecheck and lint as in CI, then vitest on the changed files only. */
export function fastCiSteps(job, changed) {
  const tsc = job.steps.find((s) => /\btsc\b/.test(s.run));
  const lint = job.steps.find((s) => /\beslint\b/.test(s.run));
  if (!tsc || !lint) throw new Error('the frontend job has no tsc or eslint step');
  const steps = [{ name: tsc.name, run: tsc.run }, { name: lint.name, run: lint.run }];
  if (changed.length) steps.push({ name: 'vitest on related files', run: `npx vitest related --run --passWithNoTests ${changed.map(shellQuote).join(' ')}` });
  return steps;
}

export function maxWarnings(job) {
  const lint = job.steps.find((s) => /\beslint\b/.test(s.run));
  const m = lint && /--max-warnings[ =](\d+)/.exec(lint.run);
  return m ? Number(m[1]) : undefined;
}

export function shellQuote(s) {
  const v = String(s);
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** The last vitest "Tests  N passed (N)" line in some output, ANSI colors stripped. */
export function testCounts(output) {
  const all = [...String(output).replace(/\x1b\[[0-9;]*m/g, '').matchAll(/\bTests\s+(\d+ (?:passed|failed)[^\n]*)/g)];
  return all.length ? `Tests ${all.at(-1)[1].trim().replace(/\s+/g, ' ')}` : undefined;
}

/** Changed paths from `git diff --name-only` and `git ls-files --others` outputs, deduplicated. */
export function changedPaths(...outputs) {
  return [...new Set(outputs.flatMap((o) => String(o).split('\n')).map((l) => l.trim()).filter(Boolean))].sort();
}

/** The per-task CI command the Foreman runs inside each worker worktree. */
export function ciCommand({ root, studio, branch }) {
  return ['node', path.join(root, 'tools', 'suzy.mjs'), 'ci', '--studio', studio, '--base', branch].map(shellQuote).join(' ');
}

export function goalText(lane) {
  return `Execute the brief in shared memory "Brief: ${lane}". Follow CLAUDE.md and the suzy-gates skill.`;
}

/** Same rules as foreman/src/util/text.ts slugify (the Memory store names files this way). */
export function slugify(text, max = 32) {
  const s = String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/g, '') || 'item';
}

/** The brief as a shared memory note, in foreman/src/memory.ts's file format. */
export function briefNote(lane, body, now = Date.now()) {
  const title = `Brief: ${lane}`;
  const slug = slugify(title, 48);
  return {
    id: `shared/${slug}`,
    relPath: path.join('memory', 'shared', `${slug}.md`),
    text: `---\ntitle: ${title}\nauthor: user\nupdated: ${now}\n---\n${String(body).replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n`,
  };
}

/** Foreman flags from STUDIO-01 that a lane asks for. */
export const STUDIO_FLAGS = ['setting-sources', 'zones'];

/**
 * Output of the Foreman flag probe (loadConfig with the studio flags): "ok", or
 * "error: unknown options "--a", "--b" (see --help)". Any other error is a real problem.
 */
export function parseProbe(output, flags = STUDIO_FLAGS) {
  const text = String(output).trim();
  if (text === 'ok') return { supported: [...flags], unknown: [] };
  const m = /^error: unknown options? (.+?) \(see --help\)$/.exec(text);
  if (!m) throw new Error(`the Foreman refused the studio flags: ${text.replace(/^error: /, '')}`);
  const named = [...m[1].matchAll(/"--([\w-]+)"/g)].map((x) => x[1]);
  const extra = named.filter((f) => !flags.includes(f));
  if (extra.length) throw new Error(`the Foreman rejected unexpected options: ${extra.join(', ')}`);
  return { supported: flags.filter((f) => !named.includes(f)), unknown: named };
}

/** unix.mjs launch arguments for a lane. */
export function launchArgs(o) {
  // STUDIO-01's Foreman flags, only when this Foreman knows them (see foremanFlagSupport in suzy.mjs)
  const fm = [];
  if (o.supported.includes('setting-sources')) fm.push('--setting-sources', 'project');
  if (o.supported.includes('zones')) fm.push('--zones', 'suzy');
  const extra = [
    '--lead-model', o.leadModel, '--worker-model', o.workerModel, '--workers', o.workers,
    ...(o.maxBudget !== undefined ? ['--max-budget', String(o.maxBudget)] : []),
    '--ci', o.ci,
    ...(o.goal ? ['--goal', o.goal] : []),
    ...fm,
  ];
  return [
    'launch', '--backend', o.backend, '--profile', PROFILE, '--repo', o.studio,
    ...(o.backend === 'claude' ? ['--use-claude-login'] : []),
    ...(o.home ? ['--home', o.home] : []),
    ...(o.port ? ['--port', String(o.port)] : []),
    ...(o.noGame ? ['--no-game'] : []),
    ...extra.flatMap((a) => ['--foreman-arg', a]),
  ];
}

export function prUrl(branch) {
  return `https://github.com/${SUZY_REPO}/compare/dev...${branch}?expand=1`;
}

/** --apply writes outside this machine; only a person at a terminal may run it. */
export function applyRefusal(isTTY) {
  return isTTY ? undefined : 'refused: --apply pushes to GitHub and only runs from an interactive terminal. The founder runs it by hand.';
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim() || '-';
const clip = (s, n = 120) => { const t = cell(s); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };

function zoneOf(task) {
  if (task.zone) return Array.isArray(task.zone) ? task.zone.join(', ') : String(task.zone);
  const m = /^\s*zones?\s*:\s*(.+)$/im.exec(task.description ?? '');
  return m ? m[1].trim() : undefined;
}

/** Commands the Foreman ran as CI, from agent logs ("CI: <cmd>") and results ("CI passed"/"CI FAILED"). */
export function ciRuns(logs) {
  const runs = [];
  for (const [agentId, entries] of Object.entries(logs)) {
    let pending;
    for (const e of entries) {
      const cmd = e.kind === 'tool' && /^CI: (.+)$/.exec(e.text ?? '');
      if (cmd) { pending = { agentId, command: cmd[1], ts: e.ts }; continue; }
      const res = /^CI (passed|FAILED) \(([\d.]+)s\)/.exec(e.text ?? '');
      if (res && pending) {
        const counts = testCounts(e.text)?.replace(/^Tests /, '');
        runs.push({ ...pending, pass: res[1] === 'passed', seconds: Number(res[2]), ...(counts ? { counts: counts.trim() } : {}) });
        pending = undefined;
      }
    }
  }
  return runs.sort((a, b) => a.ts - b.ts);
}

export function renderReport({ lane, branch, studio, dataDir, state, logs = {}, git = {}, generatedAt = new Date().toISOString() }) {
  const unverified = [];
  const goals = (state.goals ?? []).filter((g) => g.text?.includes(`"Brief: ${lane}"`));
  const goalIds = new Set(goals.map((g) => g.id));
  let tasks = state.tasks ?? [];
  if (goalIds.size) tasks = tasks.filter((t) => t.goalId && goalIds.has(t.goalId));
  else if (tasks.length) unverified.push(`No goal in state.json names "Brief: ${lane}"; every task in the profile is listed.`);
  const decisions = state.decisions ?? [];
  const mergeFor = (t) => [...decisions].reverse().find((d) => d.kind === 'merge' && d.taskId === t.id);
  const review = (t) => {
    const d = mergeFor(t);
    if (!d) return 'no merge decision';
    if (d.status === 'open') return 'awaiting you';
    if (d.status === 'cancelled') return 'cancelled';
    return [d.answer?.option, d.answer?.text].filter(Boolean).join(': ') || 'answered';
  };
  const runs = ciRuns(logs);
  const answered = decisions.filter((d) => d.status === 'answered' && (!d.taskId || tasks.some((t) => t.id === d.taskId) || !goalIds.size));
  const sessions = Object.entries(state.sessions ?? {});
  const spend = sessions.reduce((sum, [, s]) => sum + (Number(s.costUsd) || 0), 0);
  const byStatus = tasks.reduce((m, t) => ({ ...m, [t.status]: (m[t.status] ?? 0) + 1 }), {});
  const zoneless = tasks.filter((t) => !zoneOf(t)).map((t) => t.id);

  const out = [];
  out.push(`# ${lane}: studio lane report`, '');
  out.push(`Generated ${generatedAt} by \`node tools/suzy.mjs report ${lane}\` from \`${path.join(dataDir, 'state.json')}\`, the agent logs and git.`);
  out.push(`Branch \`${branch}\` in \`${studio}\`, compared with \`${BASE}\`.`, '');
  if (goals.length) {
    out.push('## Goal', '');
    for (const g of goals) out.push(`- ${g.id} (${g.status}, ${Math.round((g.progress ?? 0) * 100)}%): ${cell(g.text)}`);
    out.push('');
  }

  out.push('## What changed', '');
  out.push(git.log ? '```\n' + git.log.trim() + '\n```' : '_No commits on the branch beyond the base._', '');
  out.push('### Files changed', '');
  out.push(git.diffstat ? '```\n' + git.diffstat.trimEnd() + '\n```' : '_None._', '');

  out.push('## Tasks', '');
  if (tasks.length) {
    out.push('| task | title | assignee | zone | status | CI | review |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const t of tasks) out.push(`| ${t.id} | ${clip(t.title, 60)} | ${cell(t.assignee)} | ${cell(zoneOf(t) ?? 'not recorded')} | ${t.status} | ${t.ci ?? 'unknown'} | ${clip(review(t), 60)} |`);
  } else out.push('_No tasks._');
  out.push('');

  out.push('## Decisions the founder answered', '');
  if (answered.length) {
    out.push('| decision | kind | agent | task | question | answer |', '| --- | --- | --- | --- | --- | --- |');
    for (const d of answered) out.push(`| ${d.id} | ${d.kind} | ${cell(d.agentId)} | ${cell(d.taskId)} | ${clip(d.question, 80)} | ${clip([d.answer?.option, d.answer?.text].filter(Boolean).join(': '), 80)} |`);
  } else out.push('_None._');
  out.push('');

  out.push('## Proof', '', '### Commands that ran as tests', '');
  if (runs.length) {
    out.push('| when | agent | command | result | time | counts |', '| --- | --- | --- | --- | --- | --- |');
    for (const r of runs) out.push(`| ${new Date(r.ts).toISOString()} | ${r.agentId} | \`${cell(r.command)}\` | ${r.pass ? 'pass' : 'FAIL'} | ${r.seconds}s | ${cell(r.counts ?? 'not in log tail')} |`);
  } else out.push('_No CI runs in the agent logs._');
  out.push('');

  out.push('## Counts', '');
  out.push(`- Tasks: ${tasks.length}${Object.keys(byStatus).length ? ` (${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  out.push(`- CI runs: ${runs.length} (pass ${runs.filter((r) => r.pass).length}, fail ${runs.filter((r) => !r.pass).length})`);
  out.push(`- Decisions answered: ${answered.length}; still open: ${decisions.filter((d) => d.status === 'open').length}`);
  out.push(`- Commits: ${git.log ? git.log.trim().split('\n').length : 0}; ${git.shortstat?.trim() || 'no file changes'}`);
  out.push(`- Spend: ${sessions.length ? `$${spend.toFixed(2)} over ${sessions.length} sessions, ${sessions.reduce((n, [, s]) => n + (s.turns ?? 0), 0)} turns (Foreman estimate)` : 'not recorded'}`, '');

  if (!runs.length) unverified.push('No CI command ran in this profile: nothing in this report was tested.');
  if (tasks.some((t) => t.ci === 'unknown')) unverified.push(`CI result unknown for ${tasks.filter((t) => t.ci === 'unknown').map((t) => t.id).join(', ')}.`);
  if (zoneless.length) unverified.push(`Zone not recorded for ${zoneless.join(', ')}.`);
  if (!sessions.length) unverified.push('Spend not recorded (no agent sessions in state.json).');
  unverified.push('Per-task CI is the fast subset (typecheck, lint, vitest on related files). The full frontend job runs at `node tools/suzy.mjs ship`.');
  unverified.push('This report reads recorded state; it re-runs nothing.');
  out.push('## UNVERIFIED', '', ...unverified.map((u) => `- ${u}`), '');
  return out.join('\n');
}
