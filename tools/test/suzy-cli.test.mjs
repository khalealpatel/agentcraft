// node --test tools/test   (or: npm test --prefix tools)
// tools/suzy.mjs end to end against throwaway Git repos: a bare "origin" reached through
// url.<bare>.insteadOf (so nothing touches the network) and a fake CI workflow.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { javaHome } from '../lib/java.mjs';

const SUZY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'suzy.mjs');
const ORIGIN = 'https://github.com/khalealpatel/suzy-ai-engine';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suzy-cli-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let hasJava = true;
try { javaHome(); } catch { hasJava = false; }
const needsDoctor = { skip: hasJava ? false : 'doctor needs Java 25' };

const ciYml = (lint = 'echo eslint . --max-warnings 3') => `jobs:
  frontend:
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4
      - name: Install dependencies
        run: npm ci
      - name: Typecheck
        run: echo tsc --noEmit
      - name: Lint
        run: ${lint}
      - name: Tests
        run: echo "Tests  2 passed (2)"
`;

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const git = (cwd, ...args) => sh(cwd, 'git', args);

let n = 0;
/** A studio checkout on dev, its origin, and an AgentCraft home. */
function studio({ lint } = {}) {
  const dir = path.join(tmp, `case-${++n}`);
  const repo = path.join(dir, 'suzy-studio');
  const bare = path.join(dir, 'origin.git');
  fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'frontend', 'node_modules'), { recursive: true });
  git(dir, 'init', '-q', '--bare', bare);
  git(repo, 'init', '-q', '-b', 'dev');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), ciYml(lint));
  fs.writeFileSync(path.join(repo, 'frontend', '.gitignore'), '/node_modules\n.env*\n');
  fs.writeFileSync(path.join(repo, 'frontend', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, '.env.example'), 'KEY=\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', ORIGIN);
  git(repo, 'config', `url.${bare}.insteadOf`, ORIGIN);
  git(repo, 'push', '-q', 'origin', 'dev');
  git(repo, 'fetch', '-q', 'origin');
  const brief = path.join(dir, 'brief.md');
  fs.writeFileSync(brief, '# Goal\nTest lane.\n');
  return { dir, repo, bare, home: path.join(dir, 'home'), brief };
}

function suzy(s, ...args) {
  const r = spawnSync(process.execPath, [SUZY, ...args, '--studio', s.repo, '--home', s.home], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return { code: r.status, out: r.stdout + r.stderr };
}
const branchExists = (s, b) => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: s.repo }).status === 0;

test('doctor passes on a clean studio', needsDoctor, () => {
  const s = studio();
  const r = suzy(s, 'doctor');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /all checks passed/);
});

test('doctor refuses when an env file with keys is present, and names the fix', () => {
  const s = studio();
  fs.writeFileSync(path.join(s.repo, 'frontend', '.env.local'), 'SECRET=x\n');
  const r = suzy(s, 'doctor');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /FAIL\s+env files with possible keys: frontend\/\.env\.local/);
  assert.match(r.out, /fix: .*mv ".*frontend\/\.env\.local" ~\/suzy-keys\//);
});

test('doctor refuses a studio whose origin is not the Suzy repo', () => {
  const s = studio();
  git(s.repo, 'remote', 'set-url', 'origin', 'https://github.com/someone/else');
  const r = suzy(s, 'doctor');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /fix: git -C .* remote set-url origin https:\/\/github.com\/khalealpatel\/suzy-ai-engine/);
});

test('start --dry-run prints the plan and changes nothing', needsDoctor, () => {
  const s = studio();
  const r = suzy(s, 'start', 'T-01', '--brief', s.brief, '--dry-run', '--workers', 'kit', '--max-budget', '2');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[dry run\] would create studio\/t-01 from origin\/dev/);
  assert.match(r.out, /\[dry run\] would launch: .*unix\.mjs launch --backend claude --profile suzy --repo \S+ --use-claude-login/);
  assert.match(r.out, /--foreman-arg --workers --foreman-arg kit --foreman-arg --max-budget --foreman-arg 2 --foreman-arg --ci/);
  assert.match(r.out, /--foreman-arg --goal --foreman-arg "Execute the brief in shared memory \\"Brief: T-01\\"/);
  // either the studio flags pass through, or a clear warning says they could not
  assert.ok(/--setting-sources --foreman-arg project/.test(r.out) || /WARNING: this Foreman does not know --setting-sources/.test(r.out), r.out);
  assert.equal(branchExists(s, 'studio/t-01'), false);
  assert.equal(git(s.repo, 'branch', '--show-current'), 'dev');
  assert.equal(fs.existsSync(s.home), false);
});

test('start refuses a dirty studio', needsDoctor, () => {
  const s = studio();
  fs.appendFileSync(path.join(s.repo, 'frontend', 'a.ts'), '// edit\n');
  const r = suzy(s, 'start', 'T-02', '--brief', s.brief, '--no-launch');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /uncommitted changes/);
  assert.equal(branchExists(s, 'studio/t-02'), false);
});

test('start refuses when the studio holds keys', () => {
  const s = studio();
  fs.writeFileSync(path.join(s.repo, '.env'), 'KEY=1\n');
  const r = suzy(s, 'start', 'T-03', '--brief', s.brief, '--no-launch');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /FAIL\s+env files with possible keys: \.env/);
  assert.equal(branchExists(s, 'studio/t-03'), false);
});

test('start creates the lane branch and the brief note; a second start needs --resume; another lane needs --archive-previous', needsDoctor, () => {
  const s = studio();
  let r = suzy(s, 'start', 'T-04', '--brief', s.brief, '--no-launch');
  assert.equal(r.code, 0, r.out);
  assert.equal(git(s.repo, 'branch', '--show-current'), 'studio/t-04');
  assert.equal(git(s.repo, 'rev-parse', 'HEAD'), git(s.repo, 'rev-parse', 'origin/dev'));
  const note = fs.readFileSync(path.join(s.home, 'suzy', 'memory', 'shared', 'brief-t-04.md'), 'utf8');
  assert.match(note, /^---\ntitle: Brief: T-04\nauthor: user\nupdated: \d+\n---\n# Goal\nTest lane\.\n$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'suzy', 'studio-lane.json'), 'utf8')).branch, 'studio/t-04');
  assert.match(r.out, /launch \(not started, --no-launch\)/);

  r = suzy(s, 'start', 'T-04', '--brief', s.brief, '--no-launch');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /studio\/t-04 already exists .* --resume/);
  r = suzy(s, 'start', 'T-04', '--brief', s.brief, '--no-launch', '--resume');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /--goal/, 'a resumed lane keeps its goal');

  fs.writeFileSync(path.join(s.home, 'suzy', 'state.json'), JSON.stringify({ repos: [] }));
  git(s.repo, 'checkout', '-q', 'dev');
  r = suzy(s, 'start', 'T-05', '--brief', s.brief, '--no-launch');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /holds T-04.*report T-04.*--archive-previous/s);
  r = suzy(s, 'start', 'T-05', '--brief', s.brief, '--no-launch', '--archive-previous');
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.readdirSync(s.home).some((d) => /^suzy-t-04-\d{8}-\d{6}$/.test(d)), fs.readdirSync(s.home).join(','));
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'suzy', 'studio-lane.json'), 'utf8')).lane, 'T-05');
});

/** a studio on studio/<lane> with one committed change */
function laneStudio(lane, opts) {
  const s = studio(opts);
  git(s.repo, 'checkout', '-q', '--no-track', '-b', `studio/${lane.toLowerCase()}`, 'origin/dev');
  fs.appendFileSync(path.join(s.repo, 'frontend', 'a.ts'), 'export const b = 2;\n');
  git(s.repo, 'commit', '-q', '-am', 'lane work');
  return s;
}
const remoteHas = (s, b) => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: s.bare }).status === 0;

test('ship dry run runs the full frontend job, prints log, diffstat and PR URL, pushes nothing', () => {
  const s = laneStudio('S-01');
  const r = suzy(s, 'ship', 'S-01');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /== Typecheck: echo tsc --noEmit/);
  assert.doesNotMatch(r.out, /npm ci/);
  assert.match(r.out, /all 3 steps passed in [\d.]+s \| Tests 2 passed \(2\)/);
  assert.match(r.out, /git log --oneline origin\/dev\.\.HEAD\n\w+ lane work/);
  assert.match(r.out, /frontend\/a\.ts \| 1 \+/);
  assert.match(r.out, /PR \(after --apply\): https:\/\/github.com\/khalealpatel\/suzy-ai-engine\/compare\/dev\.\.\.studio\/s-01\?expand=1/);
  assert.equal(remoteHas(s, 'studio/s-01'), false);
});

test('ship refuses the wrong branch', () => {
  const s = laneStudio('S-02');
  git(s.repo, 'checkout', '-q', 'dev');
  const r = suzy(s, 'ship', 'S-02');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /is on dev, not studio\/s-02/);
});

test('ship refuses a dirty studio', () => {
  const s = laneStudio('S-03');
  fs.appendFileSync(path.join(s.repo, 'frontend', 'a.ts'), '// wip\n');
  const r = suzy(s, 'ship', 'S-03');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /uncommitted changes/);
});

test('ship --apply refuses without an interactive terminal, before running anything', () => {
  const s = laneStudio('S-04');
  const r = suzy(s, 'ship', 'S-04', '--apply');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /refused: --apply pushes to GitHub and only runs from an interactive terminal/);
  assert.doesNotMatch(r.out, /== Typecheck/);
  assert.equal(remoteHas(s, 'studio/s-04'), false);
});

test('ship refuses when CI fails', () => {
  const s = laneStudio('S-05', { lint: 'node -e "process.exit(3)" # eslint . --max-warnings 3' });
  const r = suzy(s, 'ship', 'S-05');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /== FAILED .*exit 3.*Lint/);
  assert.match(r.out, /CI failed: not shipping studio\/s-05/);
});

test('ci in a worker worktree links node_modules and tests only the changed files', () => {
  const s = laneStudio('C-01');
  const wt = path.join(s.dir, 'wt');
  git(s.repo, 'worktree', 'add', '-q', '-b', 'agentcraft/kit/t1-x', wt, 'studio/c-01');
  fs.writeFileSync(path.join(wt, 'frontend', 'new.ts'), 'export {};\n');
  // vitest is not installed in the fake studio: stub npx so the related run is visible
  const bin = path.join(s.dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\necho "npx $*"\necho " Tests  1 passed (1)"\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [SUZY, 'ci', '--studio', s.repo, '--base', 'studio/c-01'], { cwd: wt, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.equal(fs.readlinkSync(path.join(wt, 'frontend', 'node_modules')), path.join(s.repo, 'frontend', 'node_modules'));
  assert.match(out, /changed files vs studio\/c-01: 1/);
  assert.match(out, /npx vitest related --run --passWithNoTests \S*\/wt\/frontend\/new\.ts/);
  assert.match(out, /all 3 steps passed .*\| Tests 1 passed \(1\)/);
  assert.equal(git(wt, 'status', '--porcelain'), '?? frontend/new.ts', 'the node_modules link stays ignored');
});

test('report writes the lane report from state.json, logs and git', () => {
  const s = laneStudio('R-01');
  const data = path.join(s.home, 'suzy');
  fs.mkdirSync(path.join(data, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({
    goals: [{ id: 'g1', text: 'Execute the brief in shared memory "Brief: R-01". Follow CLAUDE.md and the suzy-gates skill.', status: 'active', progress: 1 }],
    tasks: [{ id: 't1', title: 'Do it', status: 'done', assignee: 'kit', goalId: 'g1', ci: 'pass', description: 'Zone: frontend/a.ts' }],
    decisions: [{ id: 'd1', kind: 'merge', agentId: 'lead', taskId: 't1', question: 'Merge t1?', status: 'answered', answer: { option: 'Merge', ts: 1 } }],
    sessions: { 'kit:t1': { costUsd: 0.4, turns: 2 } },
  }));
  fs.writeFileSync(path.join(data, 'logs', 'kit.jsonl'), [{ ts: 1, kind: 'tool', text: 'CI: node ci' }, { ts: 2, kind: 'result', text: 'CI passed (1.0s)\nall 3 steps passed | Tests 4 passed (4)' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const out = path.join(s.dir, 'R-01.md');
  const r = suzy(s, 'report', 'R-01', '--out', out);
  assert.equal(r.code, 0, r.out);
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /\w+ lane work/);
  assert.match(md, /frontend\/a\.ts \| 1 \+/);
  assert.match(md, /\| t1 \| Do it \| kit \| frontend\/a\.ts \| done \| pass \| Merge \|/);
  assert.match(md, /`node ci` \| pass \| 1s \| 4 passed \(4\)/);
  assert.match(md, /Spend: \$0\.40/);
});

test('report refuses a profile without state', () => {
  const s = studio();
  const r = suzy(s, 'report', 'R-02');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /no state\.json/);
});
