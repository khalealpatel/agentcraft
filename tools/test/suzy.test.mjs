// node --test tools/test   (or: npm test --prefix tools)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyRefusal, briefNote, changedPaths, ciCommand, ciRuns, fastCiSteps, findEnvFiles, fullCiSteps, goalText, laneName,
  launchArgs, maxWarnings, originMatches, parseJob, parseProbe, prUrl, renderReport, shellQuote, slugify, testCounts,
} from '../lib/suzy.mjs';

const CI_YML = `name: CI
on:
  push:
    branches: [dev, main]

jobs:
  other:
    name: something else
    steps:
      - name: Not ours
        run: npx tsc --other

  frontend:
    name: typecheck, lint, test, i18n
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "24"

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npx tsc --noEmit

      - name: Lint
        # a comment that mentions run: inside it
        run: npx eslint . --max-warnings 26

      - name: i18n completeness
        run: npm run i18n:check

      - name: Unit tests
        run: |
          npx vitest run
          echo done

  frontend-build:
    name: production build
    steps:
      - run: npm run build
`;

test('laneName validates and lowercases the branch', () => {
  assert.deepEqual(laneName('STUDIO-02'), { lane: 'STUDIO-02', branch: 'studio/studio-02' });
  for (const bad of ['', '-x', 'a/b', 'a b', '../x', undefined]) assert.throws(() => laneName(bad), /bad lane name/);
});

test('originMatches accepts only the Suzy repo', () => {
  for (const ok of ['https://github.com/khalealpatel/suzy-ai-engine', 'https://github.com/khalealpatel/suzy-ai-engine.git',
    'git@github.com:khalealpatel/suzy-ai-engine.git', 'ssh://git@github.com/KhalealPatel/suzy-ai-engine']) assert.equal(originMatches(ok), true, ok);
  for (const bad of ['', '/Users/x/suzy-studio', 'https://github.com/someone/suzy-ai-engine', 'https://github.com/khalealpatel/suzy-ai-engine-fork',
    'https://evil.example/khalealpatel/suzy-ai-engine']) assert.equal(originMatches(bad), false, bad);
});

test('findEnvFiles reports env files outside node_modules and .git, but not .env.example', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suzy-env-'));
  try {
    for (const f of ['.env.example', 'frontend/.env.example', 'frontend/.env.local', '.env', 'node_modules/x/.env', 'frontend/node_modules/y/.env.local', '.git/.env', 'a/b/.env.production']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), 'K=1');
    }
    assert.deepEqual(findEnvFiles(dir), ['.env', path.join('a', 'b', '.env.production'), path.join('frontend', '.env.local')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseJob reads the frontend job only, with its working directory and block runs', () => {
  const job = parseJob(CI_YML);
  assert.equal(job.workingDirectory, 'frontend');
  assert.deepEqual(job.steps.map((s) => s.run), ['npm ci', 'npx tsc --noEmit', 'npx eslint . --max-warnings 26', 'npm run i18n:check', 'npx vitest run\necho done']);
  assert.equal(job.steps[1].name, 'Typecheck');
  assert.equal(maxWarnings(job), 26);
  assert.throws(() => parseJob(CI_YML, 'missing'), /no "missing" job/);
});

test('full CI drops the install step; fast CI is typecheck, lint, and vitest related on changed files', () => {
  const job = parseJob(CI_YML);
  assert.deepEqual(fullCiSteps(job).map((s) => s.name), ['Typecheck', 'Lint', 'i18n completeness', 'Unit tests']);
  assert.deepEqual(fastCiSteps(job, []).map((s) => s.run), ['npx tsc --noEmit', 'npx eslint . --max-warnings 26']);
  const fast = fastCiSteps(job, ['/wt/frontend/src/a.ts', "/wt/it's.ts"]);
  assert.equal(fast[2].run, `npx vitest related --run --passWithNoTests /wt/frontend/src/a.ts '/wt/it'\\''s.ts'`);
  assert.throws(() => fastCiSteps({ steps: [{ run: 'npx tsc' }] }, []), /no tsc or eslint/);
});

test('changedPaths merges git outputs without duplicates or blanks', () => {
  assert.deepEqual(changedPaths('b.ts\na.ts\n', '\na.ts\n', 'c.ts'), ['a.ts', 'b.ts', 'c.ts']);
  assert.deepEqual(changedPaths('', ''), []);
});

test('shellQuote leaves plain words alone and quotes the rest', () => {
  assert.equal(shellQuote('/a/b-c.mjs'), '/a/b-c.mjs');
  assert.equal(shellQuote('a b'), `'a b'`);
  assert.equal(shellQuote(`x'y`), `'x'\\''y'`);
});

test('ciCommand calls suzy.mjs ci with the studio and the lane branch', () => {
  assert.equal(ciCommand({ root: '/ac', studio: '/home/k/suzy studio', branch: 'studio/x-1' }), `node /ac/tools/suzy.mjs ci --studio '/home/k/suzy studio' --base studio/x-1`);
});

test('briefNote is a shared memory note in the Foreman format', () => {
  const n = briefNote('STUDIO-02', '# Goal\r\nDo it\n\n\n', 1234);
  assert.equal(n.id, 'shared/brief-studio-02');
  assert.equal(n.relPath, path.join('memory', 'shared', 'brief-studio-02.md'));
  assert.equal(n.text, '---\ntitle: Brief: STUDIO-02\nauthor: user\nupdated: 1234\n---\n# Goal\nDo it\n');
  assert.equal(slugify('Brief: A_B 1', 48), 'brief-a-b-1');
});

test('parseProbe: ok, unknown studio flags, and other refusals', () => {
  assert.deepEqual(parseProbe('ok'), { supported: ['setting-sources', 'zones'], unknown: [] });
  assert.deepEqual(parseProbe('error: unknown options "--setting-sources", "--zones" (see --help)'), { supported: [], unknown: ['setting-sources', 'zones'] });
  assert.deepEqual(parseProbe('error: unknown option "--zones" (see --help)'), { supported: ['setting-sources'], unknown: ['zones'] });
  assert.throws(() => parseProbe('error: unknown zone "suzy"'), /refused the studio flags: unknown zone/);
  assert.throws(() => parseProbe('error: unknown option "--backend" (see --help)'), /unexpected options: backend/);
});

test('launchArgs: profile suzy, claude login, models, workers, budget, CI, goal, and only supported studio flags', () => {
  const base = { backend: 'claude', studio: '/s', leadModel: 'opus', workerModel: 'sonnet', workers: 'juniper,kit', ci: 'node ci', goal: goalText('L1') };
  const all = launchArgs({ ...base, maxBudget: 2.5, supported: ['setting-sources', 'zones'] });
  assert.deepEqual(all.slice(0, 8), ['launch', '--backend', 'claude', '--profile', 'suzy', '--repo', '/s', '--use-claude-login']);
  const fm = all.filter((_, i) => all[i - 1] === '--foreman-arg');
  assert.deepEqual(fm, ['--lead-model', 'opus', '--worker-model', 'sonnet', '--workers', 'juniper,kit', '--max-budget', '2.5', '--ci', 'node ci',
    '--goal', 'Execute the brief in shared memory "Brief: L1". Follow CLAUDE.md and the suzy-gates skill.', '--setting-sources', 'project', '--zones', 'suzy']);
  const none = launchArgs({ ...base, supported: [], goal: undefined, backend: 'sim', home: '/h', port: 9, noGame: true });
  assert.ok(!none.includes('--use-claude-login') && !none.includes('--setting-sources') && !none.includes('--zones') && !none.includes('--goal') && !none.includes('--max-budget'));
  assert.deepEqual(none.slice(7, 12), ['--home', '/h', '--port', '9', '--no-game']);
});

test('prUrl and the --apply TTY guard', () => {
  assert.equal(prUrl('studio/x'), 'https://github.com/khalealpatel/suzy-ai-engine/compare/dev...studio/x?expand=1');
  assert.match(applyRefusal(false), /interactive terminal/);
  assert.equal(applyRefusal(true), undefined);
});

test('testCounts finds the last vitest Tests line, colors stripped', () => {
  assert.equal(testCounts('\x1b[2m Test Files \x1b[22m 1 passed (1)\n\x1b[2m      Tests \x1b[22m \x1b[32m7 passed\x1b[39m (7)\n'), 'Tests 7 passed (7)');
  assert.equal(testCounts('all 3 steps passed in 60.4s | Tests 7 passed (7)'), 'Tests 7 passed (7)');
  assert.equal(testCounts('Tests  1 failed | 4 passed (5)\nlater\n Tests  5 passed (5)'), 'Tests 5 passed (5)');
  assert.equal(testCounts('Test Files  1 passed (1)'), undefined);
});

test('ciRuns pairs CI commands with their results', () => {
  const runs = ciRuns({
    kit: [
      { ts: 1, kind: 'tool', text: 'CI: node ci --base studio/x' },
      { ts: 2, kind: 'error', text: 'CI FAILED (3.5s)\n Tests  1 failed | 4 passed (5)' },
      { ts: 3, kind: 'tool', text: 'CI: node ci --base studio/x' },
      { ts: 4, kind: 'result', text: 'CI passed (2.0s)\n      Tests  5 passed (5)' },
    ],
    wren: [{ ts: 5, kind: 'result', text: 'CI passed (1s)' }],
  });
  assert.deepEqual(runs.map((r) => [r.agentId, r.pass, r.seconds, r.counts]), [['kit', false, 3.5, '1 failed | 4 passed (5)'], ['kit', true, 2, '5 passed (5)']]);
});

test('renderReport: tasks with zone, CI and review, answered decisions, proof, counts, spend, UNVERIFIED', () => {
  const state = {
    goals: [{ id: 'g1', text: goalText('L1'), status: 'active', progress: 0.5 }, { id: 'g0', text: 'old goal', status: 'done', progress: 1 }],
    tasks: [
      { id: 't1', title: 'Fix the | parser', status: 'done', assignee: 'kit', goalId: 'g1', ci: 'pass', description: 'Zone: frontend/src/lib/parser.ts' },
      { id: 't2', title: 'Add docs', status: 'review', assignee: 'juniper', goalId: 'g1', ci: 'unknown' },
      { id: 't0', title: 'Old task', status: 'done', goalId: 'g0', ci: 'pass' },
    ],
    decisions: [
      { id: 'd1', kind: 'merge', agentId: 'lead', taskId: 't1', question: 'Merge t1?', status: 'answered', answer: { option: 'Merge', ts: 1 } },
      { id: 'd2', kind: 'question', agentId: 'kit', taskId: 't1', question: 'Which file?', status: 'answered', answer: { option: 'parser.ts', text: 'the new one', ts: 2 } },
      { id: 'd3', kind: 'merge', agentId: 'lead', taskId: 't2', question: 'Merge t2?', status: 'open' },
    ],
    sessions: { 'kit:t1': { costUsd: 1.25, turns: 7 }, 'lead:g1': { costUsd: 0.5, turns: 3 } },
  };
  const logs = { kit: [{ ts: 10, kind: 'tool', text: 'CI: node ci' }, { ts: 11, kind: 'result', text: 'CI passed (4.2s)\nTests  3 passed (3)' }] };
  const md = renderReport({ lane: 'L1', branch: 'studio/l1', studio: '/s', dataDir: '/h/suzy', state, logs, git: { log: 'abc123 t1 parser\n', diffstat: ' a.ts | 2 +-\n', shortstat: '1 file changed' }, generatedAt: 'NOW' });
  for (const s of ['# L1: studio lane report', '## What changed', 'abc123 t1 parser', '## Tasks', '## Decisions the founder answered', '## Proof', '## Counts', '## UNVERIFIED']) assert.ok(md.includes(s), s);
  assert.match(md, /\| t1 \| Fix the \\\| parser \| kit \| frontend\/src\/lib\/parser.ts \| done \| pass \| Merge \|/);
  assert.match(md, /\| t2 \| Add docs \| juniper \| not recorded \| review \| unknown \| awaiting you \|/);
  assert.ok(!md.includes('Old task'), 'tasks of other goals are left out');
  assert.match(md, /\| d2 \| question \| kit \| t1 \| Which file\? \| parser.ts: the new one \|/);
  assert.match(md, /`node ci` \| pass \| 4.2s \| 3 passed \(3\)/);
  assert.match(md, /Spend: \$1.75 over 2 sessions, 10 turns/);
  assert.match(md, /CI result unknown for t2/);
  assert.match(md, /Zone not recorded for t2/);
});

test('renderReport with an empty profile says what is not verified', () => {
  const md = renderReport({ lane: 'L2', branch: 'studio/l2', studio: '/s', dataDir: '/h/suzy', state: {}, generatedAt: 'NOW' });
  assert.match(md, /_No tasks._/);
  assert.match(md, /No CI command ran/);
  assert.match(md, /Spend: not recorded/);
});
