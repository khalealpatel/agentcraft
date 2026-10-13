// node --test tools/test   (or: npm test --prefix tools)
// The mirror mode hook: scrubbing, scope, allowlist, and that it can never block or slow a lane.
// Fake checkouts are plain directories with a hand-written .git; nothing spawns git.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CMD_MAX, EVENTS_FILE, SCRUB_RULES, buildEvent, findCheckout, handlePayload, laneId, originUrl, relFile,
  repoNameFromOrigin, resolveScope, rotateIfNeeded, scrub,
} from '../mirror/lib.mjs';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mirror', 'hook.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-hook-')));
after(() => {
  for (const d of walkDirs(tmp)) try { fs.chmodSync(d, 0o700); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});
function* walkDirs(d) {
  yield d;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) yield* walkDirs(path.join(d, e.name));
}

let n = 0;
const fresh = (name) => {
  const d = path.join(tmp, `${name}-${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

/** A checkout with origin `url` on `branch`, and optionally a linked worktree of it. */
function checkout(url, { branch = 'dev', worktree } = {}) {
  const root = fresh('repo');
  const git = path.join(root, '.git');
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(git, 'config'), `[core]\n\tbare = false\n${url ? `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ''}[branch "${branch}"]\n\tremote = origin\n`);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  if (!worktree) return { root };
  const wt = fresh('wt');
  const wtGit = path.join(git, 'worktrees', path.basename(wt));
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'HEAD'), `ref: refs/heads/${worktree}\n`);
  fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  return { root, wt };
}

const SUZY = 'https://github.com/khalealpatel/suzy-ai-engine';
const AC = 'git@github.com:khalealpatel/agentcraft.git';
const payload = (cwd, extra) => JSON.stringify({ session_id: 'session-1', transcript_path: '/x/t.jsonl', cwd, ...extra });

function runHook(input, env) {
  const t = process.hrtime.bigint();
  const full = Object.fromEntries(Object.entries({ PATH: process.env.PATH, ...env }).filter(([, v]) => v !== undefined));
  const r = spawnSync(process.execPath, [HOOK], { input, env: full, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}
const eventsOf = (home) => {
  const f = path.join(home, '.agentcraft', 'mirror', EVENTS_FILE);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

// ---------------------------------------------------------------------------------------------
// scrub: one test per pattern
// ---------------------------------------------------------------------------------------------

const SECRETS = {
  'sk-ant': ['curl -H x sk-ant-api03-AbCdEf123_456-xyz', 'sk-ant-api03-AbCdEf123_456-xyz'],
  sk: ['OPENAI=sk-proj-abc123DEF456 node x', 'sk-proj-abc123DEF456'],
  'github-token gho': ['gh auth token gho_16C7e42F292c6912E7710c838347Ae178B4a', 'gho_16C7e42F292c6912E7710c838347Ae178B4a'],
  'github-token ghp': ['git push https://ghp_abcDEF123 x', 'ghp_abcDEF123'],
  'github-token ghs/ghu/ghr': ['a ghs_aaa111 b ghu_bbb222 c ghr_ccc333', 'ghs_aaa111'],
  'slack-token': ['post xoxb-1234-5678-abcdEFGH', 'xoxb-1234-5678-abcdEFGH'],
  'slack-token xoxp/xoxa': ['a xoxp-99-88 b xoxa-77', 'xoxp-99-88'],
  'aws-key-id': ['export AWS=AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  bearer: ['curl -H "x: Bearer abc.def.ghi" url', 'abc.def.ghi'],
  'authorization-header': ['curl -H "Authorization: Basic dXNlcjpwYXNz" u', 'dXNlcjpwYXNz'],
  '*_KEY=': ['STRIPE_SECRET_KEY=rk_live_12 npm start', 'rk_live_12'],
  '*_TOKEN=': ['NPM_TOKEN=npm_abc123 npm publish', 'npm_abc123'],
  '*_SECRET=': ['CLIENT_SECRET="hunter two" node a', 'hunter two'],
  'PASSWORD=': ['PGPASSWORD=s3cret psql', 's3cret'],
  'PASSWORD= (bare)': ['PASSWORD=letmein ./run', 'letmein'],
  'url-credentials': ['git clone https://me:pa55@github.com/x/y', 'me:pa55'],
  'url-credentials (user only)': ['psql postgres://admin@db.internal/x', 'admin@'],
  'hex-run 32+': ['echo 0123456789abcdef0123456789abcdef01 done', '0123456789abcdef0123456789abcdef01'],
  'base64-run 32+': ['echo QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYz1Kb2huRG9lMTIz | x', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYz1Kb2huRG9lMTIz'],
};

for (const [name, [text, secret]] of Object.entries(SECRETS)) {
  test(`scrub: ${name}`, () => {
    const out = scrub(text);
    assert.ok(!out.includes(secret), `"${secret}" survived: ${out}`);
    assert.match(out, /\[redacted\]/);
  });
}

test('scrub keeps ordinary commands, paths and words', () => {
  for (const s of ['npm run check', 'git push origin suzy-studio-03', 'node tools/suzy.mjs mirror install', 'cat foreman/src/agents/mirror/MirrorBackend2.ts',
    'vitest run test/mirror-backend.test.ts', 'task-list --disk-size 3', 'gh pr create --base suzy', 'echo "Authentication passed"']) {
    assert.equal(scrub(s), s);
  }
});

test('every scrub rule is covered by a test above', () => {
  const covered = new Set(Object.keys(SECRETS).map((k) => k.split(' ')[0]));
  const ruleNames = { 'secret-assignment': ['*_KEY=', '*_TOKEN=', '*_SECRET='], 'password-assignment': ['PASSWORD='] };
  for (const r of SCRUB_RULES) for (const k of ruleNames[r.name] ?? [r.name]) assert.ok(covered.has(k), `no test for ${r.name}`);
});

// ---------------------------------------------------------------------------------------------
// scope
// ---------------------------------------------------------------------------------------------

test('origin parsing and the repo allowlist', () => {
  assert.equal(originUrl('[remote "upstream"]\n url = https://github.com/blendi-remade/agentcraft\n[remote "origin"]\n\turl = https://github.com/khalealpatel/agentcraft\n'), 'https://github.com/khalealpatel/agentcraft');
  assert.equal(repoNameFromOrigin(SUZY), 'suzy-ai-engine');
  assert.equal(repoNameFromOrigin(`${SUZY}.git`), 'suzy-ai-engine');
  assert.equal(repoNameFromOrigin(AC), 'agentcraft');
  assert.equal(repoNameFromOrigin('ssh://git@github.com/KhalealPatel/AgentCraft'), 'agentcraft');
  for (const url of ['https://github.com/blendi-remade/agentcraft', 'https://github.com/khalealpatel/agentcraft-fork', 'https://github.com/evilkhalealpatel/agentcraft', 'https://github.com/khalealpatel/other', undefined]) {
    assert.equal(repoNameFromOrigin(url), undefined, String(url));
  }
});

test('scope: Suzy and AgentCraft checkouts and their worktrees are in; other repos and plain dirs are out', () => {
  const dir = fresh('scope-cache');
  const suzy = checkout(SUZY, { branch: 'dev', worktree: 'studio/lane-a' });
  const ac = checkout(AC, { branch: 'suzy', worktree: 'suzy-studio-03' });
  const other = checkout('https://github.com/someone/else');
  const upstreamOnly = checkout(undefined);
  const plain = fresh('plain');

  const s = resolveScope(path.join(suzy.root, 'src'), dir);
  assert.equal(s.repo, 'suzy-ai-engine');
  assert.equal(s.root, suzy.root);
  const sw = resolveScope(suzy.wt, dir);
  assert.equal(sw.repo, 'suzy-ai-engine');
  assert.equal(sw.root, suzy.wt);
  assert.equal(resolveScope(ac.root, dir).repo, 'agentcraft');
  assert.equal(resolveScope(ac.wt, dir).repo, 'agentcraft');
  assert.equal(resolveScope(other.root, dir), null);
  assert.equal(resolveScope(upstreamOnly.root, dir), null);
  assert.equal(resolveScope(plain, dir), null);

  assert.equal(findCheckout(ac.wt).commonDir, path.join(ac.root, '.git'));
  const e = buildEvent({ hook_event_name: 'SessionStart', session_id: 'x' }, sw);
  assert.equal(e.branch, 'studio/lane-a');

  // cached per cwd, with hashed keys only (no other project's path is stored)
  const cache = fs.readFileSync(path.join(dir, 'scope-cache.json'), 'utf8');
  assert.ok(!cache.includes(other.root) && !cache.includes(plain));
  assert.equal(Object.keys(JSON.parse(cache)).length, 7);
  assert.equal(resolveScope(other.root, dir), null);
});

test('out-of-scope sessions write nothing and create nothing', () => {
  const home = fresh('home');
  const other = checkout('https://github.com/someone/else');
  const r = runHook(payload(other.root, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(other.root, 'a') } }), { HOME: home });
  assert.equal(r.code, 0);
  assert.equal(r.out + r.err, '');
  assert.equal(fs.existsSync(path.join(home, '.agentcraft')), false);
});

// ---------------------------------------------------------------------------------------------
// allowlist
// ---------------------------------------------------------------------------------------------

test('allowlist: only the listed fields, prompt text never, lane ID from the first prompt only', () => {
  const home = fresh('home');
  const { root } = checkout(SUZY, { branch: 'studio/lane-x' });
  const env = { HOME: home };
  const prompt = '# FIRING BRIEF: STUDIO-03 (fork: Mirror mode)\nsecret plan: sk-ant-abc123 and more prompt words';
  runHook(payload(root, { hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' }), env);
  runHook(payload(root, { hook_event_name: 'UserPromptSubmit', prompt }), env);
  runHook(payload(root, { hook_event_name: 'UserPromptSubmit', prompt: '# FIRING BRIEF: OTHER-1' }), env);
  runHook(payload(root, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(root, 'src', 'a.ts') } }), env);
  runHook(payload(root, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(root, 'src', 'a.ts') }, tool_response: { file: { content: 'FILE CONTENTS' } } }), env);
  runHook(payload(root, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(root, '.env.local') } }), env);
  runHook(payload(root, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(root, '.env.example') } }), env);
  runHook(payload(root, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } }), env);
  runHook(payload(root, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat .env && echo hi' } }), env);
  runHook(payload(root, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `GH_TOKEN=ghp_xyz789 gh pr create --title "${'x'.repeat(200)}"` } }), env);
  runHook(payload(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'OUTPUT TEXT', stderr: '', interrupted: false } }), env);
  runHook(payload(root, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1\nFAIL OUTPUT TEXT' }), env);
  runHook(payload(root, { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }), env);
  runHook(payload(root, { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'ASSISTANT TEXT' }), env);
  runHook(payload(root, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }), env);

  const events = eventsOf(home);
  const raw = fs.readFileSync(path.join(home, '.agentcraft', 'mirror', EVENTS_FILE), 'utf8');
  for (const leak of ['secret plan', 'prompt words', 'sk-ant', 'FILE CONTENTS', 'OUTPUT TEXT', 'ASSISTANT TEXT', 'needs your permission', 'session-1', 'ghp_xyz789', '/etc/passwd', 'transcript', 'OTHER-1']) {
    assert.ok(!raw.includes(leak), `leaked: ${leak}`);
  }
  const allowed = new Set(['v', 'ts', 'sid', 'event', 'repo', 'branch', 'tool', 'file', 'cmd', 'ok', 'exit', 'interrupted', 'lane', 'first', 'model', 'source', 'kind', 'reason']);
  for (const e of events) for (const k of Object.keys(e)) assert.ok(allowed.has(k), `unexpected field ${k}`);
  assert.equal(events.length, 15);
  assert.ok(events.every((e) => e.repo === 'suzy-ai-engine' && e.branch === 'studio/lane-x' && /^[0-9a-f]{16}$/.test(e.sid)));
  assert.equal(events[0].model, 'claude-opus-5-5');
  assert.deepEqual([events[1].lane, events[1].first], ['STUDIO-03', true]);
  assert.deepEqual([events[2].lane, events[2].first], [undefined, false]);
  assert.equal(events[3].file, 'src/a.ts');
  assert.equal(events[4].ok, true);
  assert.equal(events[5].file, '[env file]');
  assert.equal(events[6].file, '.env.example');
  assert.equal(events[7].file, '[outside repo]');
  assert.equal(events[8].cmd, '[env file]');
  assert.ok(events[9].cmd.startsWith('GH_TOKEN=[redacted] gh pr create'));
  assert.equal(events[9].cmd.length, CMD_MAX);
  assert.deepEqual([events[10].ok, events[10].cmd], [true, 'npm test']);
  assert.deepEqual([events[11].event, events[11].ok, events[11].exit], ['PostToolUseFailure', false, 1]);
  assert.equal(events[12].kind, 'permission_prompt');
  assert.equal(events[14].reason, 'prompt_input_exit');
});

test('laneId reads both brief forms and nothing else', () => {
  assert.equal(laneId('# FIRING BRIEF: STUDIO-03 (fork: x)'), 'STUDIO-03');
  assert.equal(laneId('intro\n- **Session:** NEW session. Name `STUDIO-03`.'), 'STUDIO-03');
  assert.equal(laneId('please fix the bug'), undefined);
  assert.equal(relFile('/r/a/b.ts', '/r'), 'a/b.ts');
  assert.equal(relFile('sub/.envrc', '/r'), '[env file]');
});

// ---------------------------------------------------------------------------------------------
// never blocks a lane
// ---------------------------------------------------------------------------------------------

test('exit 0 and silent on garbage stdin, empty stdin and odd payloads', () => {
  const home = fresh('home');
  const { root } = checkout(AC);
  for (const input of ['', 'garbage', '{', '[]', 'null', '{"cwd": 5}', JSON.stringify({ cwd: root }), JSON.stringify({ cwd: root, session_id: 's', hook_event_name: 'Bogus' }),
    JSON.stringify({ cwd: root, session_id: 's', hook_event_name: 'PreToolUse', tool_input: 'not an object' }), '\u0000\u0001binary']) {
    const r = runHook(input, { HOME: home });
    assert.equal(r.code, 0, `input ${JSON.stringify(input)}`);
    assert.equal(r.out + r.err, '', `input ${JSON.stringify(input)}`);
  }
});

test('exit 0 and silent with a missing HOME dir', () => {
  const { root } = checkout(AC);
  const input = payload(root, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} });
  for (const env of [{ HOME: '/nonexistent-agentcraft-home/x' }, { HOME: '' }, {}]) {
    const r = runHook(input, { ...env, AGENTCRAFT_HOME: env.HOME ? undefined : '/nonexistent-agentcraft-home/y' });
    assert.equal(r.code, 0);
    assert.equal(r.out + r.err, '');
  }
});

test('exit 0 and silent with a read-only events dir (and a read-only events file)', { skip: process.platform === 'win32' ? 'POSIX permissions' : false }, () => {
  const home = fresh('home');
  const { root } = checkout(AC);
  const dir = path.join(home, '.agentcraft', 'mirror');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o500);
  const input = payload(root, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} });
  let r = runHook(input, { HOME: home });
  assert.deepEqual([r.code, r.out + r.err], [0, '']);
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, EVENTS_FILE), '');
  fs.chmodSync(path.join(dir, EVENTS_FILE), 0o400);
  r = runHook(input, { HOME: home });
  assert.deepEqual([r.code, r.out + r.err], [0, '']);
});

test('files: events 600, dir 700; rotation at the size cap keeps two old files', { skip: process.platform === 'win32' ? 'POSIX permissions' : false }, () => {
  const home = fresh('home');
  const { root } = checkout(AC);
  const env = { HOME: home };
  handlePayload(payload(root, { hook_event_name: 'SessionStart' }), { env });
  const dir = path.join(home, '.agentcraft', 'mirror');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, EVENTS_FILE)).mode & 0o777, 0o600);
  const f = path.join(dir, EVENTS_FILE);
  for (let i = 1; i <= 3; i++) {
    fs.appendFileSync(f, 'x'.repeat(100));
    rotateIfNeeded(dir, 50);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.startsWith(EVENTS_FILE)).sort(), [`${EVENTS_FILE}.1`, `${EVENTS_FILE}.2`]);
  handlePayload(payload(root, { hook_event_name: 'Stop' }), { env });
  assert.equal(eventsOf(home).length, 1);
});

test('timing: the hook finishes under 50 ms (its own work is well under 5 ms)', () => {
  const home = fresh('home');
  const { root } = checkout(AC);
  const input = payload(root, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src', 'a.ts') } });
  const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const inProc = [];
  for (let i = 0; i < 100; i++) {
    const t = process.hrtime.bigint();
    handlePayload(input, { env: { HOME: home } });
    inProc.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const bare = [];
  const hook = [];
  for (let i = 0; i < 15; i++) {
    const t = process.hrtime.bigint();
    spawnSync(process.execPath, ['-e', '0']);
    bare.push(Number(process.hrtime.bigint() - t) / 1e6);
    hook.push(runHook(input, { HOME: home }).ms);
  }
  const [mIn, mBare, mHook] = [median(inProc), median(bare), median(hook)];
  console.log(`# mirror hook timing: work ${mIn.toFixed(2)} ms in-process; process ${mHook.toFixed(1)} ms median (bare node ${mBare.toFixed(1)} ms)`);
  assert.ok(mIn < 5, `in-process ${mIn} ms`);
  assert.ok(mHook - mBare < 25, `hook adds ${mHook - mBare} ms over bare node`);
  // the absolute bound is meaningful on a machine where Node itself starts well inside it
  if (mBare < 40) assert.ok(mHook < 50, `hook ${mHook} ms`);
});
