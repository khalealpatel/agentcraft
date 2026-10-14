#!/usr/bin/env node
// Suzy studio launcher: start a Suzy lane on ~/suzy-studio with the AgentCraft team, then ship
// its branch into the normal PR flow. Pure parts live in lib/suzy.mjs.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { javaHome } from './lib/java.mjs';
import { applyRefusal as mirrorApplyRefusal, claudeSettingsFile, hookCommand, hooksBlock, installHooks, restoreBytes, uninstallHooks } from './lib/mirror-settings.mjs';
import { appendEvent, mirrorDir } from './mirror/lib.mjs';
import { computeLanes, laneMarkdown, lanesMarkdown, lanesTable, readEvents, writeLanesCache } from './mirror/stats.mjs';
import {
  BASE, LANE_FILE, PROFILE, STUDIO_FLAGS, applyRefusal, briefNote, changedPaths, ciCommand, fastCiSteps, findEnvFiles,
  fullCiSteps, goalText, laneName, launchArgs, maxWarnings, originMatches, parseJob, parseProbe, prUrl, renderReport, studioFlagGap, testCounts,
} from './lib/suzy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, 'tools');
const CI_FILE = '.github/workflows/ci.yml';

function usage(code = 0) {
  console.log(`Suzy studio launcher
  node tools/suzy.mjs doctor
  node tools/suzy.mjs start <LANE> --brief <file> [--lead-model opus] [--worker-model sonnet]
                       [--workers juniper,kit] [--max-budget <usd per turn>] [--resume]
                       [--archive-previous] [--dry-run] [--no-launch]
  node tools/suzy.mjs status
  node tools/suzy.mjs stop [--game | --foreman]
  node tools/suzy.mjs report <LANE> [--profile NAME] [--out FILE]
  node tools/suzy.mjs ship <LANE> [--apply]
  node tools/suzy.mjs ci --base <branch>          (the per-task CI the Foreman runs in a worktree)

Mirror mode (watch your own Claude Code sessions in the world; no agents, no API, no key):
  node tools/suzy.mjs mirror install [--apply]    add the hook to ~/.claude/settings.json (dry run first)
  node tools/suzy.mjs mirror uninstall [--apply]  remove only the mirror hook's entries
  node tools/suzy.mjs mirror test [--fast]        append a synthetic session so you see an agent move
  node tools/suzy.mjs watch [--no-game]           the Foreman (--backend mirror --profile mirror) plus the game
  node tools/suzy.mjs stats [--lane <ID>] [--since YYYY-MM-DD] [--md | --json]
                                                  per-lane numbers from the mirror events (read only, local):
                                                  wall, active, waited on you, idle, tests, PR

Common: --studio PATH (default ~/suzy-studio, env SUZY_STUDIO), --home PATH (default ~/.agentcraft,
env AGENTCRAFT_HOME), --port N (Foreman, default 7878). Testing only: --backend sim, --no-game.`);
  process.exit(code);
}

const VALUES = new Set(['brief', 'lead-model', 'worker-model', 'workers', 'max-budget', 'studio', 'home', 'port', 'base', 'backend', 'profile', 'out', 'lane', 'since']);
const SWITCHES = new Set(['resume', 'archive-previous', 'dry-run', 'no-launch', 'no-game', 'apply', 'game', 'foreman', 'help', 'fast', 'md', 'json']);

export function options(argv) {
  const out = { action: argv[0], positional: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out.positional.push(a); continue; }
    const key = a.slice(2);
    if (VALUES.has(key)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`--${key} needs a value`);
      out[key] = argv[++i];
    } else if (SWITCHES.has(key)) out[key] = true;
    else throw new Error(`unknown option: --${key}`);
  }
  out.studio = path.resolve(out.studio ?? process.env.SUZY_STUDIO ?? path.join(os.homedir(), 'suzy-studio'));
  out.home = path.resolve(out.home ?? process.env.AGENTCRAFT_HOME ?? path.join(os.homedir(), '.agentcraft'));
  out.profile ??= PROFILE;
  out.backend ??= 'claude';
  if (!['claude', 'sim'].includes(out.backend)) throw new Error('--backend must be claude or sim');
  if (out['max-budget'] !== undefined && !(Number(out['max-budget']) > 0)) throw new Error('--max-budget must be a positive number of USD');
  return out;
}

class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg); };

function run(cmd, args, { cwd, allowFail = false, env, inherit = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, env: env ?? process.env, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${(res.stderr || res.stdout || '').trim()}`);
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}
const git = (cwd, args, o) => run('git', args, { cwd, ...o });
const gitOut = (cwd, args) => git(cwd, args).stdout.trim();

// ---------------------------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------------------------

export function doctorChecks(opt) {
  const checks = [];
  const add = (ok, what, fix) => checks.push({ ok, what, fix });
  const node = Number(process.versions.node.split('.')[0]);
  add(node >= 22, `Node ${process.versions.node} (22+ required)`, 'Install Node 22 or newer (macOS: brew install node@22), then re-run.');
  try { add(true, `Java 25 at ${javaHome()}`); }
  catch (e) { add(false, 'Java 25', e.message); }
  const studio = opt.studio;
  if (!fs.existsSync(path.join(studio, '.git'))) {
    add(false, `${studio} is a Git checkout`, `git clone https://github.com/khalealpatel/suzy-ai-engine ${studio} && git -C ${studio} checkout dev`);
    return checks;
  }
  add(true, `${studio} is a Git checkout`);
  // the configured URL, not `git remote get-url` (that applies url.*.insteadOf rewrites)
  const origin = git(studio, ['config', '--get', 'remote.origin.url'], { allowFail: true }).stdout.trim();
  add(originMatches(origin), `origin is khalealpatel/suzy-ai-engine (${origin || 'none'})`,
    `git -C ${studio} remote ${origin ? 'set-url' : 'add'} origin https://github.com/khalealpatel/suzy-ai-engine`);
  const envFiles = findEnvFiles(studio);
  add(!envFiles.length, envFiles.length ? `env files with possible keys: ${envFiles.join(', ')}` : 'no .env files besides .env.example',
    `Agents can read every file in the studio. Move them out: mkdir -p ~/suzy-keys && ${envFiles.map((f) => `mv ${JSON.stringify(path.join(studio, f))} ~/suzy-keys/`).join(' && ')}`);
  const nm = path.join(studio, 'frontend', 'node_modules');
  add(fs.existsSync(nm), 'frontend/node_modules installed (per-task CI links it)', `cd ${path.join(studio, 'frontend')} && npm ci`);
  return checks;
}

function doctor(opt, { quiet = false } = {}) {
  const checks = doctorChecks(opt);
  for (const c of checks) {
    if (!quiet || !c.ok) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.what}`);
    if (!c.ok) console.log(`      fix: ${c.fix}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) refuse(`doctor: ${failed} check${failed > 1 ? 's' : ''} failed`);
  if (!quiet) console.log('doctor: all checks passed');
}

// ---------------------------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** Which STUDIO-01 flags this checkout's Foreman accepts (loadConfig rejects unknown flags). */
export function foremanFlagSupport() {
  const fmDir = path.join(root, 'foreman');
  if (!fs.existsSync(path.join(fmDir, 'node_modules'))) refuse(`Foreman dependencies are not installed: npm ci --prefix ${fmDir}`);
  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'suzy-probe-'));
  try {
    const argv = ['--backend', 'sim', '--home', probeHome, '--setting-sources', 'project', '--zones', 'suzy'];
    const code = `const { loadConfig } = await import('./src/config.ts');
try { loadConfig(${JSON.stringify(argv)}, {}); console.log('ok'); } catch (e) { console.log('error: ' + e.message); }`;
    const res = run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: fmDir });
    return parseProbe(res.stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(probeHome, { recursive: true, force: true });
  }
}

function archiveName(home, lane) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return path.join(home, `${PROFILE}-${String(lane ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-${stamp}`);
}

function start(opt) {
  const { lane, branch } = laneName(opt.positional[0]);
  if (!opt.brief) refuse('start needs --brief <file> (template: docs/suzy/STUDIO-BRIEF-TEMPLATE.md)');
  const briefFile = path.resolve(opt.brief);
  if (!fs.existsSync(briefFile) || !fs.readFileSync(briefFile, 'utf8').trim()) refuse(`brief file is missing or empty: ${briefFile}`);
  const dry = !!opt['dry-run'];
  const step = (text) => console.log(`${dry ? '[dry run] would ' : ''}${text}`);

  doctor(opt, { quiet: true });
  const studio = opt.studio;

  // before any change to the studio: a real lane without STUDIO-01's flags runs weaker than allowed
  const probe = foremanFlagSupport();
  const gap = studioFlagGap(opt.backend, probe.unknown);
  if (gap.refusal) refuse(gap.refusal);
  for (const w of gap.warnings) console.warn(w);

  // one Foreman per profile; a running one would ignore the new goal, models and CI command
  const dataDir = path.join(opt.home, PROFILE);
  const owner = readJson(path.join(dataDir, 'foreman.json'));
  if (owner && pidAlive(owner.pid)) refuse(`the ${PROFILE} Foreman is running (pid ${owner.pid}). Stop it first: node tools/suzy.mjs stop`);

  // the profile's registered repo keeps the base branch it was added with: one lane per profile
  const laneInfo = readJson(path.join(dataDir, LANE_FILE));
  const used = fs.existsSync(path.join(dataDir, 'state.json'));
  if (used && laneInfo?.lane !== lane) {
    const prev = laneInfo?.lane ?? 'an unknown lane';
    if (!opt['archive-previous']) {
      refuse(`profile ${dataDir} holds ${prev}. Write its report (node tools/suzy.mjs report ${laneInfo?.lane ?? '<LANE>'}), then re-run with --archive-previous to move it aside.`);
    }
    const state = readJson(path.join(dataDir, 'state.json')) ?? {};
    const active = (state.repos ?? []).flatMap((r) => r.worktrees ?? []).filter((w) => w.status === 'active');
    if (active.length) refuse(`${prev} still has active worktrees (${active.map((w) => w.id).join(', ')}): merge, reject or stop those tasks first.`);
    const to = archiveName(opt.home, laneInfo?.lane);
    step(`archive ${dataDir} -> ${to} (report it later with --profile ${path.basename(to)})`);
    if (!dry) fs.renameSync(dataDir, to);
  }

  const dirty = gitOut(studio, ['status', '--porcelain']);
  if (dirty) refuse(`${studio} has uncommitted changes; commit or stash them first:\n${dirty}`);

  step(`fetch: git -C ${studio} fetch origin`);
  if (!dry) git(studio, ['fetch', 'origin'], { inherit: true });
  const exists = git(studio, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }).code === 0;
  if (exists && !opt.resume) refuse(`branch ${branch} already exists in ${studio}. Continue it with --resume, or pick a new lane name.`);
  if (!exists && opt.resume) refuse(`--resume: branch ${branch} does not exist in ${studio}`);
  if (!exists && git(studio, ['rev-parse', '--verify', '--quiet', BASE], { allowFail: true }).code !== 0) refuse(`${BASE} not found in ${studio} (fetch failed?)`);
  if (exists) {
    step(`check out the existing ${branch}`);
    if (!dry) git(studio, ['checkout', branch]);
  } else {
    step(`create ${branch} from ${BASE} and check it out`);
    if (!dry) git(studio, ['checkout', '--no-track', '-b', branch, BASE]);
  }

  const note = briefNote(lane, fs.readFileSync(briefFile, 'utf8'));
  const noteFile = path.join(dataDir, note.relPath);
  step(`write the brief to shared memory "Brief: ${lane}" (${noteFile})`);
  if (!dry) {
    fs.mkdirSync(path.dirname(noteFile), { recursive: true });
    fs.writeFileSync(noteFile, note.text);
    fs.writeFileSync(path.join(dataDir, LANE_FILE), JSON.stringify({ lane, branch, studio, brief: briefFile, startedAt: new Date().toISOString() }, null, 2) + '\n');
  }

  const ci = ciCommand({ root, studio, branch });
  const args = launchArgs({
    backend: opt.backend, studio, home: opt.home, port: opt.port, noGame: opt['no-game'],
    leadModel: opt['lead-model'] ?? 'opus', workerModel: opt['worker-model'] ?? 'sonnet', workers: opt.workers ?? 'juniper,kit',
    maxBudget: opt['max-budget'] !== undefined ? Number(opt['max-budget']) : undefined, ci,
    goal: opt.resume ? undefined : goalText(lane), supported: probe.supported,
  });
  console.log(`per-task CI: ${ci}`);
  const shown = ['node', path.join(tools, 'unix.mjs'), ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
  if (dry || opt['no-launch']) {
    console.log(`${dry ? '[dry run] would launch' : 'launch (not started, --no-launch)'}: ${shown}`);
    return 0;
  }
  console.log(`launch: ${shown}`);
  return run(process.execPath, [path.join(tools, 'unix.mjs'), ...args], { cwd: root, allowFail: true, inherit: true }).code ?? 1;
}

// ---------------------------------------------------------------------------------------------
// ci (inside a worker worktree)
// ---------------------------------------------------------------------------------------------

/** Run each step in a shell, streaming its output; the last line carries the vitest counts (the Foreman logs the tail). */
async function runSteps(steps, cwd) {
  const env = { ...process.env, CI: '1', npm_config_offline: 'true' };
  const t0 = Date.now();
  let counts;
  for (const s of steps) {
    const t = Date.now();
    console.log(`\n== ${s.name}: ${s.run}`);
    let tail = '';
    const code = await new Promise((resolve) => {
      const child = spawn(s.run, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const keep = (out) => (chunk) => { out.write(chunk); tail = (tail + chunk.toString()).slice(-8192); };
      child.stdout.on('data', keep(process.stdout));
      child.stderr.on('data', keep(process.stderr));
      child.on('error', () => resolve(127));
      child.on('close', (c, signal) => resolve(c ?? signal));
    });
    counts = testCounts(tail) ?? counts;
    const secs = ((Date.now() - t) / 1000).toFixed(1);
    if (code !== 0) {
      console.log(`== FAILED (${secs}s, exit ${code}): ${s.name}${counts ? ` | ${counts}` : ''}`);
      return 1;
    }
    console.log(`== ok (${secs}s)`);
  }
  console.log(`\nall ${steps.length} steps passed in ${((Date.now() - t0) / 1000).toFixed(1)}s${counts ? ` | ${counts}` : ''}`);
  return 0;
}

/** ci.yml as the base branch has it, so a task cannot loosen its own gate; else the working file. */
function readWorkflow(cwd, ref) {
  const shown = git(cwd, ['show', `${ref}:${CI_FILE}`], { allowFail: true });
  if (shown.code === 0) return shown.stdout;
  console.warn(`suzy ci: ${ref} has no ${CI_FILE}; using the working tree's copy`);
  return fs.readFileSync(path.join(cwd, CI_FILE), 'utf8');
}

async function ci(opt) {
  if (!opt.base) refuse('ci needs --base <branch>');
  const wt = process.cwd();
  const frontend = path.join(wt, 'frontend');
  if (!fs.existsSync(frontend)) refuse(`no frontend/ in ${wt}`);
  const link = path.join(frontend, 'node_modules');
  if (!fs.existsSync(link)) {
    const target = path.join(opt.studio, 'frontend', 'node_modules');
    if (!fs.existsSync(target)) refuse(`${target} is missing: cd ${path.dirname(target)} && npm ci`);
    if (path.resolve(wt) !== path.resolve(opt.studio)) {
      fs.symlinkSync(target, link, 'dir');
      console.log(`linked frontend/node_modules -> ${target}`);
    }
  }
  const job = parseJob(readWorkflow(wt, opt.base));
  const mergeBase = gitOut(wt, ['merge-base', opt.base, 'HEAD']);
  const changed = changedPaths(
    gitOut(wt, ['diff', '--name-only', mergeBase, 'HEAD']),
    gitOut(wt, ['diff', '--name-only', 'HEAD']),
    gitOut(wt, ['ls-files', '--others', '--exclude-standard']),
  ).map((p) => path.join(wt, p)).filter((p) => fs.existsSync(p));
  console.log(`changed files vs ${opt.base}: ${changed.length}${changed.length ? '' : ' (vitest skipped)'}`);
  return runSteps(fastCiSteps(job, changed), path.join(wt, job.workingDirectory ?? 'frontend'));
}

// ---------------------------------------------------------------------------------------------
// ship
// ---------------------------------------------------------------------------------------------

async function ship(opt) {
  const { lane, branch } = laneName(opt.positional[0]);
  // checked before any work, like Suzy's own --apply scripts
  if (opt.apply) {
    const why = applyRefusal(Boolean(process.stdin.isTTY && process.stdout.isTTY));
    if (why) refuse(why);
  }
  const studio = opt.studio;
  if (!fs.existsSync(path.join(studio, '.git'))) refuse(`${studio} is not a Git checkout`);
  const current = git(studio, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true }).stdout.trim();
  if (current !== branch) refuse(`${studio} is on ${current || 'a detached HEAD'}, not ${branch}: git -C ${studio} checkout ${branch}`);
  const dirty = gitOut(studio, ['status', '--porcelain']);
  if (dirty) refuse(`${studio} has uncommitted changes; ship only what is committed:\n${dirty}`);
  if (git(studio, ['rev-parse', '--verify', '--quiet', BASE], { allowFail: true }).code !== 0) refuse(`${BASE} not found in ${studio}: git -C ${studio} fetch origin`);

  const job = parseJob(readWorkflow(studio, BASE));
  console.log(`ship ${lane}: full "${job.name}" CI job (${BASE}'s ${CI_FILE}, lint cap ${maxWarnings(job) ?? 'none'})`);
  const code = await runSteps(fullCiSteps(job), path.join(studio, job.workingDirectory ?? '.'));
  if (code !== 0) refuse(`CI failed: not shipping ${branch}`);

  const log = gitOut(studio, ['log', '--oneline', `${BASE}..HEAD`]);
  console.log(`\ngit log --oneline ${BASE}..HEAD\n${log || '(no commits)'}`);
  console.log(`\ngit diff --stat ${BASE}...HEAD\n${gitOut(studio, ['diff', '--stat', `${BASE}...HEAD`]) || '(no changes)'}`);
  if (!log) refuse(`nothing to ship: ${branch} has no commits beyond ${BASE}`);
  if (!opt.apply) {
    console.log(`\nDry run: nothing pushed. To push and open the PR: node tools/suzy.mjs ship ${lane} --apply`);
    console.log(`PR (after --apply): ${prUrl(branch)}`);
    return 0;
  }
  git(studio, ['push', 'origin', branch], { inherit: true });
  console.log(`\nPushed ${branch}. Open the PR: ${prUrl(branch)}`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// report, status, stop
// ---------------------------------------------------------------------------------------------

function readLogs(dir) {
  const logs = {};
  if (!fs.existsSync(dir)) return logs;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort((a, b) => (b.includes('.1.') ? 1 : 0) - (a.includes('.1.') ? 1 : 0));
  for (const f of files) {
    const id = f.replace(/(\.1)?\.jsonl$/, '');
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { (logs[id] ??= []).push(JSON.parse(line)); } catch { /* a torn last line */ }
    }
  }
  return logs;
}

function report(opt) {
  const { lane, branch } = laneName(opt.positional[0]);
  const dataDir = path.join(opt.home, opt.profile);
  const state = readJson(path.join(dataDir, 'state.json'));
  if (!state) refuse(`no state.json in ${dataDir}`);
  const studio = opt.studio;
  const g = {};
  if (git(studio, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }).code === 0) {
    g.log = gitOut(studio, ['log', '--oneline', `${BASE}..${branch}`]);
    g.diffstat = gitOut(studio, ['diff', '--stat', `${BASE}...${branch}`]);
    g.shortstat = gitOut(studio, ['diff', '--shortstat', `${BASE}...${branch}`]);
  }
  const md = renderReport({ lane, branch, studio, dataDir, state, logs: readLogs(path.join(dataDir, 'logs')), git: g });
  const out = path.resolve(opt.out ?? path.join(root, 'artifacts', 'reports', `${lane}.md`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md);
  console.log(`wrote ${out}`);
  return 0;
}

function status(opt) {
  const info = readJson(path.join(opt.home, PROFILE, LANE_FILE));
  console.log(info ? `lane ${info.lane} on ${info.branch} (started ${info.startedAt})` : `no lane recorded in ${path.join(opt.home, PROFILE)}`);
  return run(process.execPath, [path.join(tools, 'foremancli.mjs'), 'status', ...(opt.port ? ['--port', opt.port] : [])], { cwd: root, allowFail: true, inherit: true }).code ?? 1;
}

function stop(opt) {
  const args = ['stop', '--profile', PROFILE, ...(opt.game ? ['--game'] : []), ...(opt.foreman ? ['--foreman'] : [])];
  return run(process.execPath, [path.join(tools, 'unix.mjs'), ...args], { cwd: root, allowFail: true, inherit: true }).code ?? 1;
}

// ---------------------------------------------------------------------------------------------
// mirror mode: watch, mirror install | uninstall | test
// ---------------------------------------------------------------------------------------------

const MIRROR_PROFILE = 'mirror';
const HOOK = path.join(tools, 'mirror', 'hook.mjs');

function watch(opt) {
  const args = ['launch', '--backend', 'mirror', '--profile', MIRROR_PROFILE, '--home', opt.home,
    ...(opt.port ? ['--port', String(opt.port)] : []), ...(opt['no-game'] ? ['--no-game'] : [])];
  console.log(`watch: node ${path.join(tools, 'unix.mjs')} ${args.join(' ')}`);
  return run(process.execPath, [path.join(tools, 'unix.mjs'), ...args], { cwd: root, allowFail: true, inherit: true }).code ?? 1;
}

function writeSettings(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600 });
  fs.renameSync(tmp, file);
}

function backupSettings(file) {
  if (!fs.existsSync(file)) return undefined;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  let bak = `${file}.bak-${stamp}`;
  for (let i = 2; fs.existsSync(bak); i++) bak = `${file}.bak-${stamp}-${i}`;
  fs.copyFileSync(file, bak);
  return bak;
}

const backupsOf = (file) => {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith(`${path.basename(file)}.bak-`)).sort().reverse().map((n) => fs.readFileSync(path.join(dir, n), 'utf8'));
};

function mirrorInstall(opt, remove) {
  if (opt.apply) {
    const why = mirrorApplyRefusal(Boolean(process.stdin.isTTY && process.stdout.isTTY));
    if (why) refuse(why);
  }
  const file = claudeSettingsFile();
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  const command = hookCommand(process.execPath, HOOK);
  let res;
  try {
    res = remove ? uninstallHooks(before) : installHooks(before, command);
  } catch (e) {
    refuse(`${file}: ${e.message}`);
  }
  console.log(`Claude Code user settings: ${file}${before === undefined ? ' (does not exist yet)' : ''}`);
  if (!remove) {
    console.log(`\nThe hooks block this merges in (existing hooks are kept, in order; ours is appended per event):\n`);
    console.log(JSON.stringify(hooksBlock(command), null, 2));
    console.log(`\nThe hook is async (it never blocks a lane), writes only to ${mirrorDir({ ...process.env, AGENTCRAFT_HOME: opt.home })}, and only for khalealpatel/suzy-ai-engine and khalealpatel/agentcraft checkouts.`);
  }
  if (!res.changed) {
    console.log(remove ? '\nNo mirror hook entries found: nothing to remove.' : '\nAlready installed: nothing to change.');
    return 0;
  }
  const what = remove ? `remove ${res.removed} mirror hook entr${res.removed === 1 ? 'y' : 'ies'}` : `add ${res.added} and update ${res.updated} mirror hook entr${res.added + res.updated === 1 ? 'y' : 'ies'}`;
  if (!opt.apply) {
    console.log(`\nDry run: this would ${what}. Nothing was written. To apply: node tools/suzy.mjs mirror ${remove ? 'uninstall' : 'install'} --apply`);
    return 0;
  }
  const bak = backupSettings(file);
  const text = remove ? restoreBytes(res.text, backupsOf(file)) : res.text;
  writeSettings(file, text);
  console.log(`\nDone: ${what.replace(/^add/, 'added').replace(/^remove/, 'removed').replace(' and update ', ', updated ')}.${bak ? ` Backup: ${bak}` : ''}`);
  if (!remove) console.log('New Claude Code sessions pick it up. Watch them with: node tools/suzy.mjs watch');
  return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A synthetic session (start, read, edit, test pass, stop), as the hook would have written it. */
export function syntheticSession(sid, t0 = Date.now()) {
  const base = { v: 1, sid, repo: 'agentcraft', branch: 'mirror-test' };
  const steps = [
    { event: 'SessionStart', model: 'claude-opus-5-5', source: 'startup' },
    { event: 'UserPromptSubmit', first: true, lane: 'MIRROR-TEST' },
    { event: 'PreToolUse', tool: 'Read', file: 'tools/README.md' },
    { event: 'PostToolUse', tool: 'Read', file: 'tools/README.md', ok: true },
    { event: 'PreToolUse', tool: 'Edit', file: 'docs/suzy/STUDIO-README.md' },
    { event: 'PostToolUse', tool: 'Edit', file: 'docs/suzy/STUDIO-README.md', ok: true },
    { event: 'PreToolUse', tool: 'Bash', cmd: 'npm test' },
    { event: 'PostToolUse', tool: 'Bash', cmd: 'npm test', ok: true },
    { event: 'Stop' },
  ];
  return steps.map((s, i) => ({ ...base, ts: t0 + i, ...s }));
}

async function mirrorTest(opt) {
  const dir = mirrorDir({ ...process.env, AGENTCRAFT_HOME: opt.home });
  const sid = crypto.randomBytes(8).toString('hex');
  const events = syntheticSession(sid);
  console.log(`mirror test: a synthetic session (lane MIRROR-TEST, agentcraft @ mirror-test) into ${path.join(dir, 'events.jsonl')}`);
  for (const [i, e] of events.entries()) {
    if (i && !opt.fast) await sleep(1500);
    appendEvent(dir, { ...e, ts: Date.now() });
    console.log(`  ${e.event}${e.tool ? ` ${e.tool}` : ''}${e.file ? ` ${e.file}` : ''}${e.cmd ? ` $ ${e.cmd}` : ''}`);
  }
  console.log('Done. With `node tools/suzy.mjs watch` running, an agent ran through it; its task card MIRROR-TEST is in review.');
  return 0;
}

function mirror(opt) {
  const sub = opt.positional[0];
  if (sub === 'install') return mirrorInstall(opt, false);
  if (sub === 'uninstall') return mirrorInstall(opt, true);
  if (sub === 'test') return mirrorTest(opt);
  refuse('usage: node tools/suzy.mjs mirror install|uninstall [--apply] | mirror test [--fast]');
}

// ---------------------------------------------------------------------------------------------
// stats: per-lane numbers from the mirror events (tools/mirror/stats.mjs)
// ---------------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60_000;

/** `--since YYYY-MM-DD` as UTC midnight. */
function parseSince(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const ts = m ? Date.parse(`${text}T00:00:00Z`) : Number.NaN;
  if (!m || Number.isNaN(ts) || new Date(ts).toISOString().slice(0, 10) !== text) refuse(`--since must be a date like 2026-10-01 (UTC), got "${text}"`);
  return ts;
}

/**
 * The lanes `stats` shows: all of them (what the cache keeps), and the ones in the window. With no
 * --since the window is the last 7 days, except for --lane, which looks at everything.
 */
export function statsReport(events, opt, now = Date.now()) {
  const all = computeLanes(events, { now });
  let since = opt.since !== undefined ? parseSince(opt.since) : opt.lane ? null : now - 7 * DAY_MS;
  let lanes = since === null ? all : all.filter((l) => l.end >= since);
  if (opt.lane) {
    const want = String(opt.lane).toLowerCase();
    lanes = lanes.filter((l) => l.lane.toLowerCase() === want);
    if (!lanes.length) {
      const known = all.map((l) => l.lane);
      refuse(`no lane ${opt.lane} in the mirror events${known.length ? ` (known: ${known.slice(-10).join(', ')})` : ''}`);
    }
  }
  return { all, lanes, since };
}

function stats(opt) {
  if (opt.positional.length) refuse(`stats takes no argument (got ${opt.positional.join(' ')}); use --lane <ID>`);
  if (opt.md && opt.json) refuse('--md and --json are two formats: pick one');
  if (opt.since !== undefined) parseSince(opt.since);
  const dir = mirrorDir({ ...process.env, AGENTCRAFT_HOME: opt.home });
  const { events, files } = readEvents(dir);
  if (!files.length) {
    console.log(`no mirror events yet in ${dir}: install the hook once (node tools/suzy.mjs mirror install), then use Claude Code as usual`);
    return 0;
  }
  const now = Date.now();
  const { all, lanes, since } = statsReport(events, opt, now);
  try {
    writeLanesCache(dir, all, { now, files });
  } catch (e) {
    console.warn(`suzy stats: could not write the lanes.json cache: ${e.message}`);
  }
  if (opt.json) {
    console.log(JSON.stringify({ generatedAt: new Date(now).toISOString(), since: since === null ? null : new Date(since).toISOString(), lanes }, null, 2));
  } else if (opt.md) {
    console.log(opt.lane ? laneMarkdown(lanes[0]) : lanesMarkdown(lanes));
  } else {
    console.log(`lanes${since === null ? '' : ` since ${new Date(since).toISOString().slice(0, 10)} (UTC)`}, from ${dir}`);
    console.log(lanesTable(lanes));
  }
  return 0;
}

const ACTIONS = { doctor: (o) => (doctor(o), 0), start, ci, ship, report, status, stop, watch, mirror, stats };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opt = options(process.argv.slice(2));
    if (opt.help || !ACTIONS[opt.action]) usage(opt.help || !opt.action ? 0 : 2);
    process.exitCode = await ACTIONS[opt.action](opt);
  } catch (e) {
    console.error(`suzy: ${e.message}`);
    process.exitCode = e instanceof Refusal ? 2 : 1;
  }
}
