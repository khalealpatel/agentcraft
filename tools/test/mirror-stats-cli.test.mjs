// node --test tools/test   (or: npm test --prefix tools)
// `node tools/suzy.mjs stats`: the table, --lane --md, --json, and that it writes nothing but lanes.json.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUZY = path.resolve(HERE, '..', 'suzy.mjs');
const FIXTURE = path.join(HERE, 'fixtures', 'mirror-stats', 'events.jsonl');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-stats-cli-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** A throwaway AgentCraft home holding the recorded fixture as its mirror log. */
function home({ events = true } = {}) {
  const h = path.join(tmp, `home-${++n}`);
  const dir = path.join(h, 'mirror');
  fs.mkdirSync(h, { recursive: true });
  if (events) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(FIXTURE, path.join(dir, 'events.jsonl'));
    fs.chmodSync(path.join(dir, 'events.jsonl'), 0o600);
  }
  return { h, dir };
}

function stats(h, ...args) {
  const r = spawnSync(process.execPath, [SUZY, 'stats', '--home', h, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: h, AGENTCRAFT_HOME: '' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('stats: the default table lists each lane since a date', () => {
  const { h } = home();
  const r = stats(h, '--since', '2026-10-01');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /lane\s+wall\s+active\s+waited\s+stops\s+longest\s+idle\s+tests\s+PR/);
  assert.match(r.out, /VOICE-PROMPT-02\s+2h10m\s+1h22m\s+23m\s+3\s+11m\s+25m \(1\)\s+3\/1\s+yes/);
  assert.match(r.out, /STUDIO-RESUME\s+16h10m\s+1h20m\s+0m\s+0\s+0m\s+14h50m \(1\)\s+3\/0\s+yes/);
});

test('stats: lanes that ended before --since are left out', () => {
  const { h } = home();
  const r = stats(h, '--since', '2026-10-13');
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.out.includes('VOICE-PROMPT-02'));
  assert.match(r.out, /STUDIO-RESUME/); // ended 2026-10-13T09:10Z
  const none = stats(h, '--since', '2026-10-14');
  assert.equal(none.code, 0);
  assert.match(none.out, /no lanes/);
});

test('stats --lane X --md: one lane as a block for a PR body (case-insensitive, not limited to 7 days)', () => {
  const { h } = home();
  const r = stats(h, '--lane', 'voice-prompt-02', '--md');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^### Lane numbers: VOICE-PROMPT-02\n/);
  assert.match(r.out, /\| Waited on you \| 23m across 3 stops \(longest 11m\) \|/);
  assert.match(r.out, /\| PR \| yes: opened from `voice-prompt-02` \|/);
  assert.ok(!r.out.includes('STUDIO-RESUME'));
});

test('stats --md without --lane: one markdown table of every lane', () => {
  const { h } = home();
  const r = stats(h, '--since', '2026-10-01', '--md');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\| Lane \| Wall \| Active \| Waited on you \| Idle \| Tests \| PR \|/);
  assert.match(r.out, /\| STUDIO-RESUME \| 16h10m/);
});

test('stats --json: machine output with the raw numbers', () => {
  const { h } = home();
  const r = stats(h, '--since', '2026-10-01', '--json');
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.since, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(j.lanes.map((l) => l.lane), ['VOICE-PROMPT-02', 'STUDIO-RESUME']);
  assert.equal(j.lanes[0].waits.count, 3);
  assert.equal(j.lanes[0].waits.ms, 23 * 60_000);
  assert.equal(j.lanes[1].sessions, 2);
  const one = JSON.parse(stats(h, '--lane', 'STUDIO-RESUME', '--json').out);
  assert.deepEqual(one.lanes.map((l) => l.lane), ['STUDIO-RESUME']);
});

test('stats writes nothing but lanes.json (mode 600, all lanes), and leaves the events alone', () => {
  const { h, dir } = home();
  const before = fs.readFileSync(path.join(dir, 'events.jsonl'));
  const r = stats(h, '--since', '2026-10-13');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(fs.readdirSync(h), ['mirror']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['events.jsonl', 'lanes.json']);
  assert.equal(fs.statSync(path.join(dir, 'lanes.json')).mode & 0o777, 0o600);
  assert.ok(before.equals(fs.readFileSync(path.join(dir, 'events.jsonl'))));
  const cache = JSON.parse(fs.readFileSync(path.join(dir, 'lanes.json'), 'utf8'));
  assert.deepEqual(cache.lanes.map((l) => l.lane), ['VOICE-PROMPT-02', 'STUDIO-RESUME']); // the cache is not filtered
  assert.equal(cache.v, 1);
  // a second run replaces it (rebuilt from the events), still 600
  fs.chmodSync(path.join(dir, 'lanes.json'), 0o644);
  assert.equal(stats(h, '--lane', 'STUDIO-RESUME', '--md').code, 0);
  assert.equal(fs.statSync(path.join(dir, 'lanes.json')).mode & 0o777, 0o600);
});

test('stats reads the rotated files too', () => {
  const { h, dir } = home({ events: false });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lines = fs.readFileSync(FIXTURE, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl.1'), `${lines.slice(0, 30).join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${lines.slice(30).join('\n')}\n`);
  const r = stats(h, '--since', '2026-10-01', '--json');
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.lanes.find((l) => l.lane === 'VOICE-PROMPT-02').waits.count, 3);
});

test('stats with no mirror directory: says so, creates nothing, exits 0', () => {
  const { h } = home({ events: false });
  const r = stats(h);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /no mirror events/i);
  assert.deepEqual(fs.readdirSync(h), []);
});

test('stats refusals exit 2: unknown lane, bad --since, --md with --json, a stray argument', () => {
  const { h } = home();
  const lane = stats(h, '--lane', 'NOPE-9');
  assert.equal(lane.code, 2);
  assert.match(lane.err, /no lane NOPE-9/);
  assert.match(lane.err, /VOICE-PROMPT-02/);
  assert.equal(stats(h, '--since', 'last-week').code, 2);
  assert.equal(stats(h, '--since', '2026-13-45').code, 2);
  assert.equal(stats(h, '--md', '--json').code, 2);
  assert.equal(stats(h, 'extra').code, 2);
});

test('stats: with no --since it shows the last 7 days (clock injected)', async () => {
  const { statsReport } = await import('../suzy.mjs');
  const events = fs.readFileSync(FIXTURE, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  const day = 24 * 60 * 60_000;
  const ended = Date.parse('2026-10-13T09:10:00Z');
  assert.deepEqual(statsReport(events, {}, ended + 6 * day).lanes.map((l) => l.lane), ['VOICE-PROMPT-02', 'STUDIO-RESUME']);
  assert.deepEqual(statsReport(events, {}, ended + 7.2 * day).lanes.map((l) => l.lane), []); // both older than 7 days
  assert.deepEqual(statsReport(events, {}, Date.parse('2026-10-12T11:10:00Z') + 8 * day).lanes.map((l) => l.lane), []);
  assert.deepEqual(statsReport(events, {}, Date.parse('2026-10-19T12:00:00Z')).lanes.map((l) => l.lane), ['STUDIO-RESUME']);
});
