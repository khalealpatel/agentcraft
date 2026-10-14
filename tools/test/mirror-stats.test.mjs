// node --test tools/test   (or: npm test --prefix tools)
// Mirror lane telemetry: per-lane numbers from the hook's events.jsonl. Pure functions, tested on a
// recorded two-lane fixture (tools/test/fixtures/mirror-stats/events.jsonl) and small inline logs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IDLE_MS, addEvent, classifyTool, computeLanes, finishedLine, formatDuration, inferLane, isPrCreate, isTestCommand,
  laneMarkdown, lanesMarkdown, lanesTable, mergeLane, newSession, numbersMarkdown, pushesBranch, readEvents, waitingLabel,
} from '../mirror/stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'mirror-stats', 'events.jsonl');
const fixtureEvents = () => fs.readFileSync(FIXTURE, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-stats-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => fs.mkdirSync(path.join(tmp, `d${++n}`), { recursive: true }) && path.join(tmp, `d${n}`);

const MIN = 60_000;
const T0 = Date.parse('2026-10-12T09:00:00Z');
let seq = 0;
/** One hook event; `at` is minutes (or { s: seconds }) after T0. */
const ev = (at, event, extra = {}, sid = 'aaaaaaaaaaaaaaaa') => ({
  v: 1, ts: T0 + (typeof at === 'number' ? at * MIN : at.s * 1000), sid, event, repo: 'agentcraft', branch: 'lane-x', ...extra, _seq: ++seq,
});
const strip = ({ _seq, ...e }) => e;
const lanesOf = (events, now = T0 + 24 * 60 * MIN) => computeLanes(events.map(strip), { now });
const one = (events, now) => {
  const lanes = lanesOf(events, now);
  assert.equal(lanes.length, 1);
  return lanes[0];
};
const byLane = (lanes, id) => lanes.find((l) => l.lane === id);

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

test('formatDuration: seconds, minutes, h+mm', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(60_000), '1m');
  assert.equal(formatDuration(23 * MIN), '23m');
  assert.equal(formatDuration(130 * MIN), '2h10m');
  assert.equal(formatDuration(125 * MIN), '2h05m');
  assert.equal(formatDuration(26 * 60 * MIN + 10 * MIN), '26h10m');
  assert.equal(formatDuration(-5), '0s');
  assert.equal(formatDuration(Number.NaN), '0s');
});

test('classifyTool: read, edit, bash, other', () => {
  for (const t of ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']) assert.equal(classifyTool(t), 'read', t);
  for (const t of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) assert.equal(classifyTool(t), 'edit', t);
  for (const t of ['Bash', 'PowerShell']) assert.equal(classifyTool(t), 'bash', t);
  for (const t of ['Task', 'WebFetch', 'TodoWrite', 'mcp__x__y', undefined]) assert.equal(classifyTool(t), 'other', String(t));
});

test('isTestCommand: the mirror backend\'s test commands, and not git or ls', () => {
  for (const c of ['npm test', 'npm run test', 'npm run check', 'pnpm run check', 'npx vitest run a.test.ts', 'vitest', 'pytest -q', 'go test ./...',
    'node --test', 'cd foreman && npm run check', 'tsc --noEmit', 'cargo test']) assert.equal(isTestCommand(c), true, c);
  for (const c of ['git status', 'ls -la', 'npm install', 'npm run build', 'cat tests.txt', '', undefined]) assert.equal(isTestCommand(c), false, String(c));
});

test('isPrCreate and pushesBranch', () => {
  assert.equal(isPrCreate('gh pr create --base suzy --title "x"'), true);
  assert.equal(isPrCreate('git push -u origin lane-x && gh pr create'), true);
  assert.equal(isPrCreate('gh pr view 3'), false);
  assert.equal(pushesBranch('git push', 'lane-x'), true);
  assert.equal(pushesBranch('git push -u origin lane-x', 'lane-x'), true);
  assert.equal(pushesBranch('git push origin HEAD', 'lane-x'), true);
  assert.equal(pushesBranch('git push origin lane-x:lane-x', 'lane-x'), true);
  assert.equal(pushesBranch('git push --force-with-lease origin +lane-x', 'lane-x'), true);
  assert.equal(pushesBranch('git push origin main', 'lane-x'), false);
  assert.equal(pushesBranch('git push origin lane-x:main', 'lane-x'), false);
  assert.equal(pushesBranch('npm test && git push origin lane-x', 'lane-x'), true);
  assert.equal(pushesBranch('git status', 'lane-x'), false);
});

// ---------------------------------------------------------------------------------------------
// the recorded fixture: lane 1 (3 founder waits), lane 2 (resumed the next day)
// ---------------------------------------------------------------------------------------------

test('fixture: two lanes, ordered by start', () => {
  const lanes = computeLanes(fixtureEvents(), { now: Date.parse('2026-10-14T00:00:00Z') });
  assert.deepEqual(lanes.map((l) => l.lane), ['VOICE-PROMPT-02', 'STUDIO-RESUME']);
});

test('fixture lane 1: start, end, wall, active, founder waits, idle', () => {
  const l = byLane(computeLanes(fixtureEvents(), { now: Date.parse('2026-10-14T00:00:00Z') }), 'VOICE-PROMPT-02');
  assert.equal(l.start, Date.parse('2026-10-12T09:00:00Z'));
  assert.equal(l.end, Date.parse('2026-10-12T11:10:00Z'));
  assert.equal(l.wall, 130 * MIN);
  assert.equal(l.waits.count, 3);
  assert.equal(l.waits.ms, 23 * MIN);
  assert.equal(l.waits.longest, 11 * MIN);
  assert.equal(l.waits.open, null);
  assert.deepEqual(l.waits.byKind, { permission_prompt: 2, elicitation_dialog: 1 });
  assert.deepEqual(l.idle, { count: 1, ms: 25 * MIN });
  assert.equal(l.active, 130 * MIN - 23 * MIN - 25 * MIN);
  assert.equal(l.sessions, 1);
  assert.equal(l.model, 'claude-opus-5-5');
});

test('fixture lane 1: tool calls, files, tests, PR, errors', () => {
  const l = byLane(computeLanes(fixtureEvents(), { now: Date.parse('2026-10-14T00:00:00Z') }), 'VOICE-PROMPT-02');
  assert.deepEqual(l.calls, { total: 16, read: 4, edit: 6, bash: 6, other: 0 });
  assert.equal(l.files.count, 3);
  assert.deepEqual(l.files.top, [
    { file: 'foreman/src/voice.ts', edits: 3 }, // the 10:41 edit failed and does not count
    { file: 'docs/suzy/STUDIO-README.md', edits: 1 },
    { file: 'foreman/src/voice-prompt.ts', edits: 1 },
  ]);
  assert.deepEqual(l.tests, { runs: 4, pass: 3, fail: 1, firstRun: { pass: 1, of: 2, rate: 0.5 } });
  assert.deepEqual(l.pr, { opened: true, pushed: true, branch: 'voice-prompt-02', any: true });
  assert.equal(l.errors, 2);
});

test('fixture lane 2: two sessions, resumed the next day, one lane', () => {
  const l = byLane(computeLanes(fixtureEvents(), { now: Date.parse('2026-10-14T00:00:00Z') }), 'STUDIO-RESUME');
  assert.equal(l.sessions, 2);
  assert.deepEqual(l.sids, ['b2b2b2b2b2b2b2b2', 'c3c3c3c3c3c3c3c3']);
  assert.equal(l.start, Date.parse('2026-10-12T17:00:00Z'));
  assert.equal(l.end, Date.parse('2026-10-13T09:10:00Z'));
  assert.equal(l.wall, 970 * MIN);
  assert.deepEqual(l.idle, { count: 1, ms: 890 * MIN }); // the night between the sessions
  assert.equal(l.waits.count, 0);
  assert.equal(l.active, 80 * MIN);
  assert.deepEqual(l.calls, { total: 10, read: 3, edit: 3, bash: 4, other: 0 });
  assert.equal(l.files.count, 2);
  assert.deepEqual(l.tests, { runs: 3, pass: 3, fail: 0, firstRun: { pass: 1, of: 1, rate: 1 } });
  assert.deepEqual(l.pr, { opened: false, pushed: true, branch: 'studio/resume', any: true });
  assert.equal(l.errors, 0);
  assert.equal(l.model, 'claude-sonnet-5-5');
});

// ---------------------------------------------------------------------------------------------
// founder waits
// ---------------------------------------------------------------------------------------------

test('a wait opens at a Notification and closes at the session\'s next non-Notification event', () => {
  const l = one([
    ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'W-1' }),
    ev(1, 'PreToolUse', { tool: 'Bash', cmd: 'ls' }),
    ev(2, 'Notification', { kind: 'permission_prompt' }),
    ev(9, 'PostToolUse', { tool: 'Bash', cmd: 'ls', ok: true }),
    ev(10, 'Stop'),
  ]);
  assert.equal(l.waits.count, 1);
  assert.equal(l.waits.ms, 7 * MIN);
  assert.equal(l.waits.longest, 7 * MIN);
  assert.equal(l.idle.count, 0);
  assert.equal(l.wall, 10 * MIN);
  assert.equal(l.active, 3 * MIN);
});

test('back to back Notifications are one wait; auth_success is not a wait', () => {
  const l = one([
    ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'W-2' }),
    ev(1, 'Notification', { kind: 'auth_success' }),
    ev(2, 'Notification', { kind: 'permission_prompt' }),
    ev(3, 'Notification', { kind: 'idle_prompt' }),
    ev(8, 'UserPromptSubmit'),
  ]);
  assert.equal(l.waits.count, 1);
  assert.equal(l.waits.ms, 6 * MIN);
});

test('a Notification with no kind still opens a wait (an unknown type is still waiting on you)', () => {
  const l = one([ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'W-3' }), ev(1, 'Notification'), ev(5, 'Stop')]);
  assert.equal(l.waits.count, 1);
  assert.equal(l.waits.ms, 4 * MIN);
});

test('waits are per session: another session\'s events do not close it', () => {
  const A = 'aaaaaaaaaaaaaaaa';
  const B = 'bbbbbbbbbbbbbbbb';
  const l = one([
    ev(0, 'SessionStart', {}, A), ev(0, 'UserPromptSubmit', { first: true, lane: 'W-4' }, A),
    ev(0, 'SessionStart', {}, B), ev(0, 'UserPromptSubmit', { first: true, lane: 'W-4' }, B),
    ev(2, 'Notification', { kind: 'permission_prompt' }, A),
    ev(4, 'PreToolUse', { tool: 'Read' }, B), // B is busy, A is still waiting
    ev(6, 'PostToolUse', { tool: 'Read', ok: true }, B),
    ev(12, 'PostToolUse', { tool: 'Bash', ok: true }, A),
  ]);
  assert.equal(l.sessions, 2);
  assert.equal(l.waits.count, 1);
  assert.equal(l.waits.ms, 10 * MIN);
});

test('edge: an unclosed wait at the end of the file is counted as open, measured to now', () => {
  const events = [
    ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'OPEN-1' }),
    ev(5, 'PreToolUse', { tool: 'Edit', file: 'a.ts' }),
    ev(6, 'Notification', { kind: 'permission_prompt' }),
  ];
  const l = one(events, T0 + 18 * MIN);
  assert.equal(l.waits.count, 1);
  assert.deepEqual(l.waits.open, { since: T0 + 6 * MIN, ms: 12 * MIN, kind: 'permission_prompt' });
  assert.equal(l.waits.ms, 12 * MIN);
  assert.equal(l.waits.longest, 12 * MIN);
  assert.equal(l.end, T0 + 6 * MIN); // the lane's last event; the open wait runs past it
  assert.equal(l.wall, 6 * MIN);
  assert.equal(l.active, 6 * MIN); // never negative, never more than wall
  assert.match(laneMarkdown(l), /still waiting/);
  assert.match(lanesTable([l]), /\(open\)/);
});

test('edge: an open wait of a session that never wrote again closes when the lane\'s next session starts', () => {
  const A = 'aaaaaaaaaaaaaaaa';
  const B = 'bbbbbbbbbbbbbbbb';
  const l = one([
    ev(0, 'SessionStart', {}, A), ev(0, 'UserPromptSubmit', { first: true, lane: 'KILLED-1' }, A),
    ev(10, 'Notification', { kind: 'permission_prompt' }, A), // the terminal was closed here: no SessionEnd
    ev(60, 'SessionStart', { source: 'resume' }, B), ev(60, 'UserPromptSubmit', { first: true, lane: 'KILLED-1' }, B),
    ev(70, 'Stop', {}, B),
  ], T0 + 600 * MIN);
  assert.equal(l.waits.count, 1);
  assert.equal(l.waits.open, null);
  assert.equal(l.waits.ms, 50 * MIN);
  assert.equal(l.idle.count, 0); // the gap is the wait, not idle
  assert.equal(l.active, 70 * MIN - 50 * MIN);
});

// ---------------------------------------------------------------------------------------------
// idle gaps
// ---------------------------------------------------------------------------------------------

test('idle gaps: over 10 minutes without events, not waiting; exactly 10 is not idle', () => {
  const l = one([
    ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'IDLE-1' }),
    ev(1, 'Stop'),
    ev(11, 'UserPromptSubmit'), // exactly 10 min: not idle
    ev(12, 'Stop'),
    ev(40, 'UserPromptSubmit'), // 28 min: idle
    ev(41, 'Stop'),
    ev(60, 'UserPromptSubmit'), // 19 min: idle
    ev(61, 'Stop'),
  ]);
  assert.equal(IDLE_MS, 10 * MIN);
  assert.deepEqual(l.idle, { count: 2, ms: 47 * MIN });
  assert.equal(l.wall, 61 * MIN);
  assert.equal(l.active, 14 * MIN);
});

test('a tool that runs for a long time (Pre ... Post) is work, not an idle gap', () => {
  const l = one([
    ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'LONG-1' }),
    ev(1, 'PreToolUse', { tool: 'Bash', cmd: 'npm run build' }),
    ev(21, 'PostToolUse', { tool: 'Bash', cmd: 'npm run build', ok: true }),
    ev(22, 'Stop'),
  ]);
  assert.deepEqual(l.idle, { count: 0, ms: 0 });
  assert.equal(l.active, 22 * MIN);
});

test('an idle_prompt wait is waiting on the founder, not an idle gap', () => {
  const l = one([
    ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'IDLE-2' }),
    ev(5, 'Stop'),
    ev(6, 'Notification', { kind: 'idle_prompt' }),
    ev(66, 'UserPromptSubmit'),
    ev(67, 'Stop'),
  ]);
  assert.equal(l.waits.count, 1);
  assert.equal(l.waits.ms, 60 * MIN);
  assert.deepEqual(l.idle, { count: 0, ms: 0 });
  assert.equal(l.active, 7 * MIN);
});

// ---------------------------------------------------------------------------------------------
// tool calls, files, tests, PR, errors, model
// ---------------------------------------------------------------------------------------------

test('tool calls by type; one call is one PreToolUse', () => {
  const l = one([
    ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'T-1' }),
    ev(1, 'PreToolUse', { tool: 'Read', file: 'a.ts' }), ev(1, 'PostToolUse', { tool: 'Read', file: 'a.ts', ok: true }),
    ev(2, 'PreToolUse', { tool: 'Grep' }), ev(2, 'PostToolUse', { tool: 'Grep', ok: true }),
    ev(3, 'PreToolUse', { tool: 'Edit', file: 'a.ts' }), ev(3, 'PostToolUse', { tool: 'Edit', file: 'a.ts', ok: true }),
    ev(4, 'PreToolUse', { tool: 'Bash', cmd: 'ls' }), ev(4, 'PostToolUse', { tool: 'Bash', cmd: 'ls', ok: true }),
    ev(5, 'PreToolUse', { tool: 'WebFetch' }), ev(5, 'PostToolUse', { tool: 'WebFetch', ok: true }),
    ev(6, 'PreToolUse', { tool: 'Bash', cmd: 'exit 3' }), ev(6, 'PostToolUseFailure', { tool: 'Bash', cmd: 'exit 3', ok: false, exit: 3 }),
  ]);
  assert.deepEqual(l.calls, { total: 6, read: 2, edit: 1, bash: 2, other: 1 });
  assert.equal(l.errors, 1);
});

test('errors: PostToolUseFailure and a PostToolUse with ok:false', () => {
  const l = one([
    ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'E-1' }),
    ev(1, 'PostToolUseFailure', { tool: 'Bash', ok: false }),
    ev(2, 'PostToolUse', { tool: 'Bash', ok: false, exit: 2 }),
    ev(3, 'PostToolUse', { tool: 'Bash', ok: true }),
  ]);
  assert.equal(l.errors, 2);
});

test('files touched: unique, edit tools only, successful only, top 10 by edits then name; placeholders are skipped', () => {
  const events = [ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'F-1' })];
  let t = 1;
  const edit = (file, ok = true) => {
    events.push(ev(t, 'PreToolUse', { tool: 'Edit', file }));
    events.push(ev(t, ok ? 'PostToolUse' : 'PostToolUseFailure', { tool: 'Edit', file, ok }));
    t += 0.5;
  };
  for (let i = 0; i < 12; i++) edit(`src/f${String(i).padStart(2, '0')}.ts`);
  edit('src/f11.ts');
  edit('src/f11.ts');
  edit('src/f05.ts');
  edit('src/never.ts', false);
  edit('[env file]');
  edit('[outside repo]');
  events.push(ev(t, 'PreToolUse', { tool: 'Read', file: 'src/read-only.ts' }), ev(t, 'PostToolUse', { tool: 'Read', file: 'src/read-only.ts', ok: true }));
  const l = one(events);
  assert.equal(l.files.count, 12);
  assert.equal(l.files.top.length, 10);
  assert.deepEqual(l.files.top.slice(0, 3), [
    { file: 'src/f11.ts', edits: 3 }, { file: 'src/f05.ts', edits: 2 }, { file: 'src/f00.ts', edits: 1 },
  ]);
  assert.ok(!l.files.top.some((f) => f.file === 'src/never.ts' || f.file === 'src/read-only.ts' || f.file.startsWith('[')));
});

test('test runs: count, pass, fail, and the first-run pass rate over distinct commands', () => {
  const run = (t, cmd, ok) => [
    ev(t, 'PreToolUse', { tool: 'Bash', cmd }),
    ev(t, ok ? 'PostToolUse' : 'PostToolUseFailure', { tool: 'Bash', cmd, ok, ...(ok ? {} : { exit: 1 }) }),
  ];
  const l = one([
    ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'TR-1' }),
    ...run(1, 'npm run check', false), ...run(2, 'npm run check', true),
    ...run(3, 'npx vitest run a.test.ts', true), ...run(4, 'npx vitest run a.test.ts', true),
    ...run(5, 'node --test', false),
    ...run(6, 'git status', true),
  ]);
  assert.deepEqual(l.tests, { runs: 5, pass: 3, fail: 2, firstRun: { pass: 1, of: 3, rate: 1 / 3 } });
});

test('no test runs: zero everything, no rate', () => {
  const l = one([ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'TR-2' })]);
  assert.deepEqual(l.tests, { runs: 0, pass: 0, fail: 0, firstRun: { pass: 0, of: 0, rate: null } });
});

test('PR: gh pr create or a push of the lane branch; a failed push or another branch does not count', () => {
  const post = (t, cmd, ok = true) => [ev(t, 'PreToolUse', { tool: 'Bash', cmd }), ev(t, ok ? 'PostToolUse' : 'PostToolUseFailure', { tool: 'Bash', cmd, ok })];
  const head = (lane) => [ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane })];
  assert.deepEqual(one([...head('P-1'), ...post(1, 'gh pr create --base suzy')]).pr, { opened: true, pushed: false, branch: 'lane-x', any: true });
  assert.deepEqual(one([...head('P-2'), ...post(1, 'git push -u origin lane-x')]).pr, { opened: false, pushed: true, branch: 'lane-x', any: true });
  assert.deepEqual(one([...head('P-3'), ...post(1, 'git push origin main')]).pr, { opened: false, pushed: false, branch: null, any: false });
  assert.deepEqual(one([...head('P-4'), ...post(1, 'git push origin lane-x', false), ...post(2, 'gh pr create', false)]).pr, { opened: false, pushed: false, branch: null, any: false });
});

test('model: the lane\'s latest recorded model; none when not recorded', () => {
  const l = one([
    ev(0, 'SessionStart', { model: 'claude-opus-5-5' }), ev(0, 'UserPromptSubmit', { first: true, lane: 'M-1' }),
    ev(30, 'SessionStart', { model: 'claude-sonnet-5-5', source: 'resume' }, 'bbbbbbbbbbbbbbbb'), ev(30, 'UserPromptSubmit', { first: true, lane: 'M-1' }, 'bbbbbbbbbbbbbbbb'),
  ]);
  assert.equal(l.model, 'claude-sonnet-5-5');
  assert.deepEqual(l.models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(one([ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'M-2' })]).model, null);
});

// ---------------------------------------------------------------------------------------------
// grouping: by lane ID, not by session
// ---------------------------------------------------------------------------------------------

test('two sessions with the same lane ID are one lane; two lanes stay apart', () => {
  const lanes = lanesOf([
    ev(0, 'SessionStart', {}, 'aaaaaaaaaaaaaaaa'), ev(0, 'UserPromptSubmit', { first: true, lane: 'G-1' }, 'aaaaaaaaaaaaaaaa'),
    ev(5, 'SessionStart', {}, 'bbbbbbbbbbbbbbbb'), ev(5, 'UserPromptSubmit', { first: true, lane: 'G-2' }, 'bbbbbbbbbbbbbbbb'),
    ev(9, 'SessionStart', {}, 'cccccccccccccccc'), ev(9, 'UserPromptSubmit', { first: true, lane: 'G-1' }, 'cccccccccccccccc'),
  ]);
  assert.deepEqual(lanes.map((l) => [l.lane, l.sessions]), [['G-1', 2], ['G-2', 1]]);
});

test('a session whose first prompt carries no lane ID is unnamed-<date>-<n>, numbered per day in start order', () => {
  const day2 = 24 * 60;
  const lanes = lanesOf([
    ev(0, 'SessionStart', {}, 'aaaaaaaaaaaaaaaa'), ev(0, 'UserPromptSubmit', { first: true }, 'aaaaaaaaaaaaaaaa'),
    ev(3, 'SessionStart', {}, 'bbbbbbbbbbbbbbbb'), ev(3, 'UserPromptSubmit', { first: true }, 'bbbbbbbbbbbbbbbb'),
    ev(day2, 'SessionStart', {}, 'cccccccccccccccc'), ev(day2, 'UserPromptSubmit', { first: true }, 'cccccccccccccccc'),
  ], T0 + 3 * 24 * 60 * MIN);
  assert.deepEqual(lanes.map((l) => l.lane), ['unnamed-2026-10-12-1', 'unnamed-2026-10-12-2', 'unnamed-2026-10-13-1']);
  assert.ok(lanes.every((l) => l.named === false));
});

test('the same session id coming back the next day (a resume that keeps its id) stays one session of one lane', () => {
  const day2 = 24 * 60;
  const l = one([
    ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'SAME-1' }),
    ev(10, 'Stop'), ev(11, 'SessionEnd', { reason: 'prompt_input_exit' }),
    ev(day2, 'SessionStart', { source: 'resume' }), ev(day2, 'UserPromptSubmit', { first: true }),
    ev(day2 + 5, 'Stop'),
  ]);
  assert.equal(l.lane, 'SAME-1');
  assert.equal(l.sessions, 1);
  assert.equal(l.wall, (day2 + 5) * MIN);
  assert.deepEqual(l.idle, { count: 1, ms: (day2 - 11) * MIN });
  assert.equal(l.active, 16 * MIN);
});

test('a resumed session without the brief joins the lane most recently seen on its repo and branch', () => {
  const day2 = 24 * 60;
  const lanes = lanesOf([
    ev(0, 'SessionStart', {}, 'aaaaaaaaaaaaaaaa'), ev(0, 'UserPromptSubmit', { first: true, lane: 'R-1' }, 'aaaaaaaaaaaaaaaa'),
    ev(10, 'Stop', {}, 'aaaaaaaaaaaaaaaa'),
    ev(day2, 'SessionStart', { source: 'resume' }, 'bbbbbbbbbbbbbbbb'), ev(day2, 'UserPromptSubmit', { first: true }, 'bbbbbbbbbbbbbbbb'),
    ev(day2 + 4, 'Stop', {}, 'bbbbbbbbbbbbbbbb'),
    // a plain new session on the same branch is its own (unnamed) lane
    ev(day2 + 30, 'SessionStart', { source: 'startup' }, 'cccccccccccccccc'), ev(day2 + 30, 'UserPromptSubmit', { first: true }, 'cccccccccccccccc'),
  ], T0 + 5 * 24 * 60 * MIN);
  assert.deepEqual(lanes.map((l) => [l.lane, l.sessions]), [['R-1', 2], ['unnamed-2026-10-13-1', 1]]);
});

test('inferLane: other repo, other branch, startup source, or a laned session: no inference', () => {
  const prior = { sid: 'a', repo: 'agentcraft', branch: 'x', lane: 'L-1', first: 1, last: 5 };
  const sess = (o) => ({ sid: 'b', repo: 'agentcraft', branch: 'x', resumed: true, first: 10, last: 12, ...o });
  assert.equal(inferLane(sess({}), [prior]), 'L-1');
  assert.equal(inferLane(sess({ branch: 'y' }), [prior]), undefined);
  assert.equal(inferLane(sess({ repo: 'suzy-ai-engine' }), [prior]), undefined);
  assert.equal(inferLane(sess({ resumed: false }), [prior]), undefined);
  assert.equal(inferLane(sess({ lane: 'L-2' }), [prior]), undefined);
  assert.equal(inferLane(sess({ first: 0 }), [prior]), undefined); // not before it
});

// ---------------------------------------------------------------------------------------------
// edge cases: clock skew, rotation, robustness
// ---------------------------------------------------------------------------------------------

test('edge: clock skew (a timestamp that goes backwards) is clamped, counted, and never crashes or goes negative', () => {
  const l = one([
    ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'SKEW-1' }),
    ev(10, 'PreToolUse', { tool: 'Read' }),
    ev(5, 'PostToolUse', { tool: 'Read', ok: true }), // the clock stepped back 5 minutes
    ev(6, 'Notification', { kind: 'permission_prompt' }),
    ev(4, 'PostToolUse', { tool: 'Bash', ok: true }), // and again: a wait that would be negative
    ev(20, 'Stop'),
  ]);
  assert.equal(l.skew, 3);
  assert.equal(l.start, T0);
  assert.equal(l.end, T0 + 20 * MIN);
  assert.equal(l.wall, 20 * MIN);
  assert.equal(l.waits.count, 1);
  assert.equal(l.waits.ms, 0);
  assert.ok(l.active >= 0 && l.active <= l.wall);
  assert.ok(l.idle.ms >= 0);
});

test('edge: junk (NaN timestamp, missing sid, unknown event) is skipped, not fatal', () => {
  const lanes = computeLanes([
    { v: 1, ts: T0, sid: 'aaaaaaaaaaaaaaaa', event: 'SessionStart', repo: 'r', branch: 'b' },
    { v: 1, ts: Number.NaN, sid: 'aaaaaaaaaaaaaaaa', event: 'Stop', repo: 'r', branch: 'b' },
    { v: 1, ts: T0 + 1, event: 'Stop', repo: 'r', branch: 'b' },
    null,
    'text',
    { v: 1, ts: T0 + MIN, sid: 'aaaaaaaaaaaaaaaa', event: 'Mystery', repo: 'r', branch: 'b' },
    { v: 1, ts: T0 + 2 * MIN, sid: 'aaaaaaaaaaaaaaaa', event: 'Stop', repo: 'r', branch: 'b' },
  ], { now: T0 + 10 * MIN });
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].wall, 2 * MIN);
});

test('mergeLane of no sessions does not throw', () => {
  assert.equal(mergeLane([], { now: T0 }), null);
});

test('incremental and batch agree: addEvent one by one gives what computeLanes gives', () => {
  const events = fixtureEvents().filter((e) => e.sid === 'a1a1a1a1a1a1a1a1');
  let s;
  for (const e of events) s = addEvent(s ?? newSession(e), e);
  const viaState = mergeLane([JSON.parse(JSON.stringify(s))], { now: Date.parse('2026-10-14T00:00:00Z') });
  const viaBatch = byLane(computeLanes(events, { now: Date.parse('2026-10-14T00:00:00Z') }), 'VOICE-PROMPT-02');
  assert.deepEqual({ ...viaState, lane: null, named: null }, { ...viaBatch, lane: null, named: null });
});

test('edge: the file rotating mid-lane: the rotated files are read too, in order, once', () => {
  const dir = fresh();
  const lines = fs.readFileSync(FIXTURE, 'utf8').trimEnd().split('\n');
  const a = lines.slice(0, 20);
  const b = lines.slice(20, 45);
  const c = lines.slice(45);
  fs.writeFileSync(path.join(dir, 'events.jsonl.2'), `${a.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'events.jsonl.1'), `${b.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${c.join('\n')}\nthis line is not JSON\n`);
  const got = readEvents(dir);
  assert.equal(got.events.length, lines.length);
  assert.deepEqual(got.files.map((f) => path.basename(f)), ['events.jsonl.2', 'events.jsonl.1', 'events.jsonl']);
  const now = Date.parse('2026-10-14T00:00:00Z');
  assert.deepEqual(computeLanes(got.events, { now }), computeLanes(fixtureEvents(), { now }));
});

test('readEvents: a rotation between two reads (same file under two names) is read once; a missing dir is empty', () => {
  const dir = fresh();
  const text = `${fs.readFileSync(FIXTURE, 'utf8')}`;
  fs.writeFileSync(path.join(dir, 'events.jsonl.1'), text);
  fs.linkSync(path.join(dir, 'events.jsonl.1'), path.join(dir, 'events.jsonl')); // same inode
  assert.equal(readEvents(dir).events.length, text.trimEnd().split('\n').length);
  assert.deepEqual(readEvents(path.join(dir, 'nope')), { events: [], files: [] });
});

// ---------------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------------

const NOW = Date.parse('2026-10-14T00:00:00Z');
const fixtureLanes = () => computeLanes(fixtureEvents(), { now: NOW });

test('lanesTable: lane, wall, active, waited (total, count, longest), idle, tests, PR', () => {
  const table = lanesTable(fixtureLanes());
  const rows = table.split('\n');
  assert.match(rows[0], /lane\s+wall\s+active\s+waited\s+stops\s+longest\s+idle\s+tests\s+PR/);
  const v = rows.find((r) => r.startsWith('VOICE-PROMPT-02'));
  assert.match(v, /2h10m\s+1h22m\s+23m\s+3\s+11m\s+25m \(1\)\s+3\/1\s+yes/);
  const s = rows.find((r) => r.startsWith('STUDIO-RESUME'));
  assert.match(s, /16h10m\s+1h20m\s+0m\s+0\s+0m\s+14h50m \(1\)\s+3\/0\s+yes/);
});

test('lanesTable: nothing to show', () => {
  assert.match(lanesTable([]), /no lanes/i);
});

test('laneMarkdown: a block ready for a PR body', () => {
  const md = laneMarkdown(byLane(fixtureLanes(), 'VOICE-PROMPT-02'));
  assert.match(md, /^### Lane numbers: VOICE-PROMPT-02/m);
  assert.match(md, /Wall time \| 2h10m/);
  assert.match(md, /Active \| 1h22m/);
  assert.match(md, /Waited on you \| 23m across 3 stops \(longest 11m\)/);
  assert.match(md, /Idle gaps \| 25m \(1\)/);
  assert.match(md, /Tool calls \| 16 \(read 4, edit 6, bash 6, other 0\)/);
  assert.match(md, /Files touched \| 3/);
  assert.match(md, /Tests \| 4 runs: 3 passed, 1 failed \(first run passed 1 of 2\)/);
  assert.match(md, /PR \| yes: opened from `voice-prompt-02`/);
  assert.match(md, /Errors \| 2/);
  assert.match(md, /Model \| claude-opus-5-5/);
  assert.match(laneMarkdown(byLane(fixtureLanes(), 'STUDIO-RESUME')), /PR \| pushed `studio\/resume`, no PR opened/);
  assert.ok(!md.includes(String.fromCharCode(0x2014)), 'no em dashes');
});

test('lanesMarkdown: a markdown table of every lane', () => {
  const md = lanesMarkdown(fixtureLanes());
  assert.match(md, /\| Lane \| Wall \| Active \| Waited on you \| Idle \| Tests \| PR \|/);
  assert.match(md, /\| VOICE-PROMPT-02 \| 2h10m \| 1h22m \| 23m across 3 stops \(longest 11m\) \| 25m \(1\) \| 3\/1 \| yes \|/);
});

test('finishedLine: the feed item on Stop', () => {
  assert.equal(finishedLine(byLane(fixtureLanes(), 'VOICE-PROMPT-02')), 'VOICE-PROMPT-02 finished: 1h45m, waited on you 23m across 3 stops, tests 3/4');
  assert.equal(finishedLine(byLane(fixtureLanes(), 'STUDIO-RESUME')), 'STUDIO-RESUME finished: 1h20m, never waited on you, tests 3/3');
  const bare = one([ev(0, 'SessionStart'), ev(0, 'UserPromptSubmit', { first: true, lane: 'B-1' }), ev(2, 'Stop')]);
  assert.equal(finishedLine(bare), 'B-1 finished: 2m, never waited on you');
  assert.equal(finishedLine(bare, 'a title'), 'a title finished: 2m, never waited on you');
});

test('numbersMarkdown: the Numbers section of a lane note', () => {
  const md = numbersMarkdown(byLane(fixtureLanes(), 'VOICE-PROMPT-02'));
  assert.match(md, /^## Numbers/);
  assert.match(md, /- Wall time: 2h10m/);
  assert.match(md, /- Waited on you: 23m across 3 stops \(longest 11m\)/);
  assert.match(md, /- Top files: foreman\/src\/voice\.ts \(3\)/);
  assert.match(numbersMarkdown({ ...byLane(fixtureLanes(), 'VOICE-PROMPT-02'), partial: true }), /counted from the first event this view saw/);
});

test('waitingLabel: "waiting on you" first, then the minutes', () => {
  assert.equal(waitingLabel(0), 'waiting on you');
  assert.equal(waitingLabel(59_000), 'waiting on you');
  assert.equal(waitingLabel(12 * MIN + 20_000), 'waiting on you 12m');
  assert.equal(waitingLabel(75 * MIN), 'waiting on you 1h15m');
});
