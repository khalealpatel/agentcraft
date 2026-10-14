// Mirror backend, lane telemetry: the Numbers section of a lane note, the feed item on Stop and the
// nameplate that counts how long a lane has waited on you. Built on tools/mirror/stats.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeLanes, isTestCommand, numbersMarkdown } from '../../tools/mirror/stats.mjs';
import { MirrorBackend, MIRROR_TEST_RE } from '../src/agents/mirror/index.js';
import { silentLogger } from '../src/context.js';
import { Foreman } from '../src/foreman.js';
import { Notifier } from '../src/notifier.js';
import { rmrf, tempDir, testConfig } from './helpers.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-13T09:00:00Z');
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmrf(h);
});
const home = () => {
  const h = tempDir('ac-mirror-num-');
  homes.push(h);
  return h;
};

type Ev = Record<string, unknown>;
const A = 'a1a1a1a1a1a1a1a1';
const B = 'b2b2b2b2b2b2b2b2';
/** one hook event `m` minutes after T0 */
const ev = (m: number, event: string, extra: Ev = {}, sid = A, branch = 'num-1'): string =>
  JSON.stringify({ v: 1, ts: T0 + m * MIN, sid, event, repo: 'agentcraft', branch, ...extra });

function append(h: string, lines: string[]): void {
  const dir = path.join(h, 'mirror');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'events.jsonl'), lines.map((l) => `${l}\n`).join(''));
}

async function boot(h: string, clock: { now: number }) {
  const cfg = testConfig(h, ['--backend', 'mirror', '--profile', 'mirror']);
  const fm = new Foreman({ config: cfg, logger: silentLogger, now: () => clock.now, notifier: new Notifier({ enabled: false }) });
  const backend = new MirrorBackend(fm, { ...cfg.mirror, pollMs: 60_000 });
  await fm.start(backend);
  return { fm, backend };
}

const LANE_HEAD = [ev(0, 'SessionStart', { model: 'claude-opus-5-5', source: 'startup' }), ev(0.1, 'UserPromptSubmit', { first: true, lane: 'NUM-1' })];
const tool = (m: number, cmd: string, ok = true, sid = A) => [
  ev(m, 'PreToolUse', { tool: 'Bash', cmd }, sid),
  ev(m + 0.1, ok ? 'PostToolUse' : 'PostToolUseFailure', { tool: 'Bash', cmd, ok, ...(ok ? {} : { exit: 1 }) }, sid),
];
const agent = (fm: Foreman, id = 'juniper') => fm.agent(id)!;

describe('mirror backend: lane numbers', () => {
  it('writes a Numbers section into the lane note and a finished line into the feed on Stop', async () => {
    const h = home();
    append(h, [
      ...LANE_HEAD,
      ev(1, 'PreToolUse', { tool: 'Edit', file: 'tools/mirror/stats.mjs' }),
      ev(1.1, 'PostToolUse', { tool: 'Edit', file: 'tools/mirror/stats.mjs', ok: true }),
      ...tool(2, 'npm run check', false),
      ev(3, 'PreToolUse', { tool: 'Edit', file: 'tools/suzy.mjs' }),
      ev(3.1, 'Notification', { kind: 'permission_prompt' }),
      ev(12.1, 'PostToolUse', { tool: 'Edit', file: 'tools/suzy.mjs', ok: true }),
      ...tool(13, 'npm run check', true),
      ev(15, 'Stop'),
    ]);
    const clock = { now: T0 + 20 * MIN };
    const { fm } = await boot(h, clock);
    try {
      const body = fm.memory.get('lanes/num-1')!.body;
      expect(body).toContain('## Numbers');
      expect(body).toContain('- Wall time: 15m (2026-10-13 09:00 to 09:15 UTC)');
      // the permission wait (9m), and the Stop 5 minutes ago that made the lane wait for your next message
      expect(body).toContain('- Waited on you: 14m across 2 stops (longest 9m), still waiting');
      expect(body).toContain('- Active: 6m');
      expect(body).toContain('- Idle gaps: none');
      expect(body).toContain('- Tool calls: 4 (read 0, edit 2, bash 2, other 0)');
      expect(body).toContain('- Files touched: 2');
      expect(body).toContain('- Tests: 2 runs: 1 passed, 1 failed (first run passed 0 of 1)');
      expect(body).toContain('- Model: claude-opus-5-5');
      expect(body.indexOf('## Numbers')).toBeLessThan(body.indexOf('## Session'));
      const feed = fm.store.data.feed.map((f) => f.text);
      expect(feed).toContain('NUM-1 finished: 15m, waited on you 9m across 1 stop, tests 1/2');
    } finally {
      await fm.close();
    }
  });

  it('counts a lane across sessions (same lane ID) in one note and one task card', async () => {
    const h = home();
    append(h, [
      ...LANE_HEAD,
      ...tool(1, 'node --test'),
      ev(5, 'Stop'),
      ev(6, 'SessionEnd', { reason: 'prompt_input_exit' }),
      ev(24 * 60, 'SessionStart', { model: 'claude-opus-5-5', source: 'resume' }, B),
      ev(24 * 60 + 0.1, 'UserPromptSubmit', { first: true }, B), // resumed without the brief
      ...tool(24 * 60 + 1, 'node --test', true, B),
      ev(24 * 60 + 5, 'Stop', {}, B),
    ]);
    const { fm } = await boot(h, { now: T0 + 25 * 60 * MIN });
    try {
      expect(fm.tasks.list().map((t) => t.title)).toEqual(['NUM-1']); // one card, not two
      const body = fm.memory.get('lanes/num-1')!.body;
      expect(body).toContain('- Sessions: 2');
      expect(body).toContain('- Wall time: 24h05m');
      expect(body).toContain('- Idle gaps: 23h54m (1)');
      expect(body).toContain('- Tests: 2 runs: 2 passed, 0 failed (first run passed 1 of 1)');
      expect(fm.store.data.feed.map((f) => f.text)).toContain('NUM-1 finished: 11m, never waited on you, tests 2/2');
    } finally {
      await fm.close();
    }
  });

  it('shows how long a lane has waited on you on its nameplate, refreshed at most once a minute', async () => {
    const h = home();
    append(h, [...LANE_HEAD, ...tool(1, 'ls'), ev(2, 'PreToolUse', { tool: 'Bash', cmd: 'git push' }), ev(2.1, 'Notification', { kind: 'permission_prompt' })]);
    const clock = { now: T0 + 2.1 * MIN };
    const { fm, backend } = await boot(h, clock);
    try {
      expect(agent(fm)).toMatchObject({ state: 'waiting_user', station: 'user', activity: 'waiting on you' });
      clock.now = T0 + (2.1 + 12) * MIN + 20_000;
      backend.poll();
      expect(agent(fm).activity).toBe('waiting on you 12m');
      clock.now += 40_000; // 12m 60s: a minute has not passed since it was shown
      backend.poll();
      expect(agent(fm).activity).toBe('waiting on you 12m');
      clock.now += 30_000; // 13m 10s
      backend.poll();
      expect(agent(fm).activity).toBe('waiting on you 13m');
      // the founder answers: the next event ends the wait and the nameplate moves on
      append(h, [ev(2.1 + 13.2, 'PostToolUse', { tool: 'Bash', cmd: 'git push', ok: true })]);
      backend.poll();
      expect(agent(fm).activity).not.toMatch(/waiting on you/);
      clock.now += 5 * MIN;
      backend.poll();
      expect(agent(fm).activity).not.toMatch(/waiting on you/);
    } finally {
      await fm.close();
    }
  });

  it('keeps a lane that waits on you at the podium past the 30 minute idle sweep, up to 2 hours', async () => {
    const h = home();
    append(h, [...LANE_HEAD, ev(2, 'Notification', { kind: 'permission_prompt' })]);
    const clock = { now: T0 + 2 * MIN };
    const { fm, backend } = await boot(h, clock);
    try {
      clock.now = T0 + 90 * MIN;
      backend.poll();
      expect(agent(fm)).toMatchObject({ active: true, state: 'waiting_user', activity: 'waiting on you 1h28m' });
      clock.now = T0 + 130 * MIN; // more than 2 hours: an abandoned prompt does not hold an avatar forever
      backend.poll();
      expect(agent(fm)).toMatchObject({ active: false, activity: 'off shift' });
      // and the note says the wait is still open
      expect(fm.memory.get('lanes/num-1')!.body).toContain('still waiting');
    } finally {
      await fm.close();
    }
  });

  it('a restart in the middle of a lane keeps its numbers (state is saved, nothing is counted twice)', async () => {
    const lines = [...LANE_HEAD, ...tool(1, 'npm test', false), ev(2, 'Notification', { kind: 'idle_prompt' }), ev(10, 'UserPromptSubmit'), ...tool(11, 'npm test'), ev(12, 'Stop')];
    const ref = home();
    append(ref, lines);
    const a = await boot(ref, { now: T0 + 30 * MIN });
    const want = a.fm.memory.get('lanes/num-1')!.body;
    const wantFeed = a.fm.store.data.feed.map((f) => f.text);
    await a.fm.close();
    expect(want).toContain('- Waited on you: 26m across 2 stops (longest 18m), still waiting'); // 8m, then the Stop 18m ago

    const h = home();
    append(h, lines.slice(0, 4));
    const first = await boot(h, { now: T0 + 30 * MIN });
    await first.fm.close();
    append(h, lines.slice(4));
    const second = await boot(h, { now: T0 + 30 * MIN });
    try {
      expect(second.fm.memory.get('lanes/num-1')!.body).toBe(want);
      expect(second.fm.store.data.feed.map((f) => f.text)).toEqual(wantFeed);
    } finally {
      await second.fm.close();
    }
  });

  it('a session saved before the counter existed is marked partial in its note', async () => {
    const h = home();
    append(h, [...LANE_HEAD, ...tool(1, 'ls')]);
    const clock = { now: T0 + 5 * MIN };
    const first = await boot(h, clock);
    const st = first.fm.store.data.backend.mirror as { sessions: Record<string, { stats?: unknown }> };
    for (const s of Object.values(st.sessions)) delete s.stats; // what an older Foreman saved
    first.fm.store.markDirty();
    await first.fm.close();
    append(h, [ev(3, 'Stop')]);
    const second = await boot(h, clock);
    try {
      const body = second.fm.memory.get('lanes/num-1')!.body;
      expect(body).toContain('counted from the first event this view saw');
      expect(body).toContain('- Wall time: 3m');
    } finally {
      await second.fm.close();
    }
  });

  it('the stats test-command detector agrees with the backend\'s', () => {
    for (const c of ['npm test', 'npm run test', 'npm run check', 'pnpm run check', 'npx vitest run a.test.ts', 'vitest', 'pytest -q', 'go test ./...', 'node --test', 'cd foreman && npm run check', 'tsc --noEmit', 'cargo test', 'git status', 'ls -la', 'npm install', 'npm run build', 'cat tests.txt', 'echo npm test', 'yarn test', 'bun run test']) {
      expect(isTestCommand(c), c).toBe(MIRROR_TEST_RE.test(c));
    }
  });
});

describe('mirror backend: who is waiting on you (STUDIO-05)', () => {
  const LANE = 'NUM-1';
  const edit = (m: number, sid = A) => [ev(m, 'PreToolUse', { tool: 'Edit', file: 'a.ts' }, sid), ev(m + 0.1, 'PostToolUse', { tool: 'Edit', file: 'a.ts', ok: true }, sid)];

  it('a lane whose turn ended waits on you for its next message, counting up until you answer', async () => {
    const h = home();
    append(h, [...LANE_HEAD, ...edit(1), ev(5, 'Stop')]);
    const clock = { now: T0 + 5 * MIN };
    const { fm, backend } = await boot(h, clock);
    try {
      expect(agent(fm)).toMatchObject({ state: 'waiting_user', station: 'user', activity: 'waiting on you' });
      expect(fm.tasks.list()[0]).toMatchObject({ title: LANE, status: 'review' });
      clock.now = T0 + 5 * MIN + 42 * MIN + 10_000;
      backend.poll();
      expect(agent(fm).activity).toBe('waiting on you 42m');
      append(h, [ev(48, 'UserPromptSubmit')]);
      backend.poll();
      expect(agent(fm)).toMatchObject({ state: 'thinking', station: 'desk' });
      expect(agent(fm).activity).not.toMatch(/waiting on you/);
      expect(fm.tasks.list()[0]!.status).toBe('doing');
    } finally {
      await fm.close();
    }
  });

  it('a lane that opened its PR is finished, not waiting: back to the lounge', async () => {
    const h = home();
    append(h, [...LANE_HEAD, ...tool(1, 'gh pr create --base suzy --title x'), ev(5, 'Stop'), ev(6, 'Notification', { kind: 'idle_prompt' })]);
    const { fm } = await boot(h, { now: T0 + 7 * MIN });
    try {
      expect(agent(fm)).toMatchObject({ state: 'idle', station: 'lounge', activity: `${LANE}: ready for review` });
      expect(fm.store.data.feed.map((f) => f.text).some((x) => /waiting for/.test(x))).toBe(false);
      expect(fm.memory.get('lanes/num-1')!.body).not.toContain('still waiting');
    } finally {
      await fm.close();
    }
  });

  it('an open AskUserQuestion is a wait from the question to the answer', async () => {
    const h = home();
    append(h, [...LANE_HEAD, ev(2, 'PreToolUse', { tool: 'AskUserQuestion' })]);
    const clock = { now: T0 + 2 * MIN };
    const { fm, backend } = await boot(h, clock);
    try {
      expect(agent(fm)).toMatchObject({ state: 'waiting_user', station: 'user', activity: 'waiting on you' });
      expect(fm.store.data.feed.map((f) => f.text)).toContain(`Juniper is waiting for your answer in Claude Code (${LANE})`);
      clock.now = T0 + 2 * MIN + 16 * 60 * MIN;
      backend.poll(); // more than 2 hours: an abandoned question does not hold an avatar
      expect(agent(fm)).toMatchObject({ active: false });
      append(h, [ev(2 + 16 * 60, 'PostToolUse', { tool: 'AskUserQuestion', ok: true })]);
      backend.poll();
      expect(agent(fm)).toMatchObject({ active: true, state: 'thinking' });
      expect(agent(fm).activity).not.toMatch(/waiting on you/);
    } finally {
      await fm.close();
    }
  });

  it('an unanswered question keeps the lane on the podium for up to 2 hours and says how long', async () => {
    const h = home();
    append(h, [...LANE_HEAD, ev(2, 'PreToolUse', { tool: 'AskUserQuestion' })]);
    const clock = { now: T0 + 2 * MIN };
    const { fm, backend } = await boot(h, clock);
    try {
      clock.now = T0 + 90 * MIN;
      backend.poll();
      expect(agent(fm)).toMatchObject({ active: true, state: 'waiting_user', activity: 'waiting on you 1h28m' });
    } finally {
      await fm.close();
    }
  });

  it('a Stop followed by the session ending is a lane that is done: off shift, no wait counted', async () => {
    const h = home();
    append(h, [...LANE_HEAD, ...edit(1), ev(5, 'Stop'), ev(65, 'SessionEnd', { reason: 'prompt_input_exit' })]);
    const { fm } = await boot(h, { now: T0 + 66 * MIN });
    try {
      expect(agent(fm)).toMatchObject({ active: false, activity: 'off shift' });
      const body = fm.memory.get('lanes/num-1')!.body;
      expect(body).toContain('- Waited on you: none');
      expect(body).toContain('- Idle gaps: 1h00m (1)');
    } finally {
      await fm.close();
    }
  });

  it('agrees with tools/mirror/stats.mjs on the founder\'s two real shapes (the drift guard)', async () => {
    const fixture = path.join(import.meta.dirname, '..', '..', 'tools', 'test', 'fixtures', 'mirror-stats', 'founder-waits.jsonl');
    const lines = fs.readFileSync(fixture, 'utf8').trimEnd().split('\n');
    const events = lines.map((l) => JSON.parse(l));
    const now = Date.parse('2026-10-14T10:00:00Z');
    const h = home();
    append(h, lines);
    const { fm } = await boot(h, { now });
    try {
      const want = computeLanes(events, { now });
      expect(want.map((l) => l.lane)).toEqual(['VOICE-PROMPT-03', 'SMS-CONSENT-02']);
      for (const lane of want) {
        const body = fm.memory.get(`lanes/${lane.lane!.toLowerCase()}`)!.body;
        // the note's line is the line stats.mjs computes for the same events
        expect(body).toContain(numbersMarkdown(lane).split('\n').find((l) => l.startsWith('- Waited on you'))!);
        expect(body).toContain(`- Waited on you: ${lane.lane === 'VOICE-PROMPT-03' ? '16h52m across 1 stop (longest 16h52m)' : '16h32m across 2 stops (longest 16h26m)'}`);
        expect(body).toContain(`- Active: ${lane.lane === 'VOICE-PROMPT-03' ? '23m' : '12m'}`);
        expect(body).toContain('- Idle gaps: none');
      }
    } finally {
      await fm.close();
    }
  });
});
