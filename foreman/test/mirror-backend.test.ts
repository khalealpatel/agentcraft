// Mirror backend: a recorded hook event log drives agents, task cards, CI, the feed, monitor logs
// and lane notes; a restart mid-log (with a rotation while stopped) duplicates nothing.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCRUB_RULES } from '../../tools/mirror/lib.mjs';
import { MirrorBackend, MIRROR_STATUS } from '../src/agents/mirror/index.js';
import { silentLogger } from '../src/context.js';
import { Foreman } from '../src/foreman.js';
import { Notifier } from '../src/notifier.js';
import { rmrf, tempDir, testConfig } from './helpers.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'mirror', 'events.jsonl');
const LINES = fs.readFileSync(FIXTURE, 'utf8').trimEnd().split('\n');
/** the restart test stops the Foreman after this many lines (after session B ended) */
const MID = 17;
const T_END = JSON.parse(LINES[LINES.length - 1]!).ts as number;

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmrf(h);
});

function home(): string {
  const h = tempDir('ac-mirror-');
  homes.push(h);
  return h;
}

function writeEvents(h: string, lines: string[], mode: 'w' | 'a' = 'a'): void {
  const dir = path.join(h, 'mirror');
  fs.mkdirSync(dir, { recursive: true });
  (mode === 'w' ? fs.writeFileSync : fs.appendFileSync)(path.join(dir, 'events.jsonl'), lines.map((l) => `${l}\n`).join(''));
}

/** A mirror Foreman on `h`, with a clock just after the fixture (so nobody idles off shift). */
async function boot(h: string, now = () => T_END + 60_000) {
  const cfg = testConfig(h, ['--backend', 'mirror', '--profile', 'mirror']);
  const fm = new Foreman({ config: cfg, logger: silentLogger, now, notifier: new Notifier({ enabled: false }) });
  const backend = new MirrorBackend(fm, { ...cfg.mirror, pollMs: 60_000 });
  await fm.start(backend);
  return { fm, backend, cfg };
}

const agentById = (fm: Foreman, id: string) => fm.agent(id)!;
const taskByTitle = (fm: Foreman, title: string) => fm.tasks.list().find((t) => t.title === title);
const logTexts = (fm: Foreman, id: string) => fm.store.logTail(id).map((e) => `${e.kind}:${e.text}`);

/** Everything a viewer would see, without timestamps (a restart replays at another wall time). */
function view(fm: Foreman) {
  return {
    agents: fm.agents().map(({ id, state, station, activity, active, taskId, model }) => ({ id, state, station, activity, active, taskId, model })),
    tasks: fm.tasks.list().map(({ id, title, status, assignee, ci, branch }) => ({ id, title, status, assignee, ci, branch })),
    feed: fm.store.data.feed.map((f) => `${f.kind}:${f.agentId ?? ''}:${f.text}`),
    logs: Object.fromEntries(fm.agents().map((a) => [a.id, logTexts(fm, a.id)])),
    memory: fm.memory.list().map((m) => [m.id, m.title, m.body]).sort((x, y) => x[0]!.localeCompare(y[0]!)),
  };
}

describe('mirror backend', () => {
  it('maps a recorded event log to agents, task cards, CI, the feed, monitor logs and lane notes', async () => {
    const h = home();
    writeEvents(h, LINES, 'w');
    const { fm } = await boot(h);
    try {
      expect(fm.status).toMatchObject({ backend: 'mirror', auth: 'ok', message: MIRROR_STATUS });

      // session A (STUDIO-03) took the first worker; B (no lane ID) the next and has ended
      const lane = taskByTitle(fm, 'STUDIO-03')!;
      expect(lane).toMatchObject({ status: 'review', assignee: 'juniper', ci: 'pass', branch: 'suzy-studio-03', createdBy: 'user' });
      expect(agentById(fm, 'juniper')).toMatchObject({ active: true, state: 'idle', station: 'lounge', taskId: lane.id, model: 'Opus 5.5', engine: 'claude' });
      const unnamed = taskByTitle(fm, 'suzy-ai-engine @ dev')!;
      expect(unnamed.status).toBe('review'); // finished, still on the wall

      // >6 live sessions: A plus C..H; H had no avatar until C ended and freed Kit
      const lanes = ['C', 'D', 'E', 'F', 'G', 'H'].map((c) => taskByTitle(fm, `LANE-${c}`)!);
      expect(lanes.map((t) => t.assignee)).toEqual(['kit', 'wren', 'rowan', 'tove', 'marlow', 'kit']);
      expect(lanes.map((t) => t.status)).toEqual(['review', 'doing', 'doing', 'doing', 'doing', 'doing']);
      expect(agentById(fm, 'kit')).toMatchObject({ active: true, taskId: lanes[5]!.id });
      expect(agentById(fm, 'marlow')).toMatchObject({ active: true, taskId: lanes[4]!.id });
      expect(fm.tasks.list()).toHaveLength(8);

      // monitor log: one line per finished tool, ok or error; prompts without their text
      const j = logTexts(fm, 'juniper');
      expect(j).toContain('tool:Read foreman/src/agents/activity.ts: ok');
      expect(j).toContain('tool:Edit foreman/src/agents/mirror/index.ts: ok');
      expect(j).toContain('error:$ npm run check: error (exit 1)');
      expect(j).toContain('tool:$ npm run check: ok');
      expect(j).toContain('text:Prompt 1 from Alex');
      expect(j).toContain('text:Subagent finished');
      expect(j[j.length - 1]).toBe('result:Turn finished: STUDIO-03 waits for your review');
      expect(logTexts(fm, 'kit')).toContain('tool:Grep "...": ok');

      // feed: CI, the push and the PR (branch only), the display-only wait, the off-shift lane
      const feed = fm.store.data.feed.map((f) => `${f.kind}:${f.text}`);
      expect(feed).toContain('ci:Juniper: tests FAILED (npm run check)');
      expect(feed).toContain('ci:Juniper: tests passed (npm run check)');
      expect(feed).toContain('merge:Juniper pushed suzy-studio-03');
      expect(feed).toContain('merge:PR opened from suzy-studio-03 (Juniper)');
      expect(feed).toContain('decision:Juniper is waiting for a permission in Claude Code (STUDIO-03)');
      expect(feed).toContain('task:Lane STUDIO-03 started (Juniper)');
      expect(fm.decisions.open()).toHaveLength(0); // nothing answerable in game
      expect(fm.store.data.decisions).toHaveLength(0);

      // lane notes in the library
      const ids = fm.memory.list().map((m) => m.id).sort();
      expect(ids).toEqual(['lanes/lane-c', 'lanes/studio-03', 'lanes/unnamed-2026-10-13-1']);
      expect(fs.existsSync(path.join(fm.config.dataDir, 'memory', 'lanes', 'studio-03.md'))).toBe(true);
    } finally {
      await fm.close();
    }
  });

  it('writes the lane note from the fixture, with nothing a scrubber would catch', async () => {
    const h = home();
    writeEvents(h, LINES, 'w');
    const { fm } = await boot(h);
    try {
      const note = fm.memory.get('lanes/studio-03')!;
      expect(note.title).toBe('STUDIO-03');
      const body = note.body;
      for (const line of [
        '# STUDIO-03',
        '- Lane: STUDIO-03',
        '- Repo: agentcraft',
        '- Branch: suzy-studio-03',
        '- Agent: Juniper',
        '- Model: Opus 5.5',
        '- Started: 2026-10-13T14:00:01Z',
        '- Ended: still running (last event 2026-10-13T14:00:27Z)',
        '- Duration: 0 min',
        '- PR opened: yes, from branch suzy-studio-03',
        '- Test runs: 3 (1 passed, 2 failed)',
        '  - fail `npm run check` (exit 1) at 2026-10-13T14:00:08Z',
        '  - pass `npm run check` at 2026-10-13T14:00:20Z',
        '### Files touched (2)',
        '- foreman/src/agents/mirror/index.ts',
        '- tools/mirror/hook.mjs',
        '### Errors (2)',
      ]) expect(body).toContain(line);
      expect(body).not.toContain('activity.ts'); // read, not touched
      // the hook scrubs; the note is scrubbed again (this fixture line was hand-written with a token)
      expect(body).toContain('--token=[redacted]');
      expect(body).not.toContain('ghp_');
      for (const r of SCRUB_RULES) {
        const hits = [...body.matchAll(new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : `${r.re.flags}g`))].map((m) => m[0]);
        const real = r.name === 'base64-run' ? hits.filter((m) => typeof r.to === 'function' && r.to(m) !== m) : hits;
        expect(real, r.name).toEqual([]);
      }

      const unnamed = fm.memory.get('lanes/unnamed-2026-10-13-1')!;
      expect(unnamed.body).toContain('- Lane: none (no FIRING BRIEF or Name line in the first prompt)');
      expect(unnamed.body).toContain('- Ended: 2026-10-13T14:00:16Z (session ended: prompt_input_exit)');
      expect(unnamed.body).toContain('- Agent: Kit');
    } finally {
      await fm.close();
    }
  });

  it('restarts mid-log: events written while stopped land, nothing is duplicated, finished tasks stay', async () => {
    // reference: one run over the whole log
    const ref = home();
    writeEvents(ref, LINES, 'w');
    const a = await boot(ref);
    const want = view(a.fm);
    await a.fm.close();

    const h = home();
    writeEvents(h, LINES.slice(0, MID), 'w');
    const first = await boot(h);
    expect(taskByTitle(first.fm, 'suzy-ai-engine @ dev')!.status).toBe('review');
    expect(first.backend.poll()).toBe(0); // nothing new: nothing applied twice
    await first.fm.close();

    // while the Foreman is off: the hook rotates the log and keeps writing
    const dir = path.join(h, 'mirror');
    fs.renameSync(path.join(dir, 'events.jsonl'), path.join(dir, 'events.jsonl.1'));
    writeEvents(h, LINES.slice(MID));

    const second = await boot(h);
    try {
      expect(view(second.fm)).toEqual(want);
      expect(second.fm.tasks.list().map((t) => t.title)).toEqual(['STUDIO-03', 'suzy-ai-engine @ dev', 'LANE-C', 'LANE-D', 'LANE-E', 'LANE-F', 'LANE-G', 'LANE-H']);
      expect(second.backend.poll()).toBe(0);
    } finally {
      await second.fm.close();
    }

    // and once more with nothing new: identical, logs not re-appended on disk either
    const third = await boot(h);
    try {
      expect(view(third.fm)).toEqual(want);
      const onDisk = fs.readFileSync(path.join(h, 'mirror', 'logs', 'juniper.jsonl'), 'utf8').trim().split('\n');
      expect(onDisk.length).toBe(want.logs.juniper!.length);
    } finally {
      await third.fm.close();
    }
  });

  it('follows the log live and picks up a half-written line once it is complete', async () => {
    const h = home();
    writeEvents(h, [], 'w');
    const { fm, backend } = await boot(h);
    try {
      const file = path.join(h, 'mirror', 'events.jsonl');
      fs.appendFileSync(file, `${LINES[0]}\n${LINES[1]!.slice(0, 30)}`);
      expect(backend.poll()).toBe(1);
      expect(agentById(fm, 'juniper').active).toBe(true);
      expect(fm.tasks.list()).toHaveLength(0);
      fs.appendFileSync(file, `${LINES[1]!.slice(30)}\n`);
      expect(backend.poll()).toBe(1);
      expect(taskByTitle(fm, 'STUDIO-03')!.status).toBe('doing');
    } finally {
      await fm.close();
    }
  });

  it('sends a session with no events for 30 minutes off shift; a new event brings it back', async () => {
    const h = home();
    writeEvents(h, LINES.slice(0, 2), 'w');
    let clock = JSON.parse(LINES[1]!).ts as number;
    const { fm, backend } = await boot(h, () => clock);
    try {
      expect(agentById(fm, 'juniper')).toMatchObject({ active: true, taskId: taskByTitle(fm, 'STUDIO-03')!.id });
      clock += 31 * 60_000;
      backend.poll();
      expect(agentById(fm, 'juniper')).toMatchObject({ active: false, station: 'lounge', activity: 'off shift' });
      expect(taskByTitle(fm, 'STUDIO-03')!.status).toBe('review');
      expect(fm.memory.get('lanes/studio-03')!.body).toContain('(no events for 30 min)');
      writeEvents(h, [JSON.stringify({ ...JSON.parse(LINES[2]!), ts: clock })]);
      backend.poll();
      expect(agentById(fm, 'juniper')).toMatchObject({ active: true, state: 'reading', station: 'library' });
    } finally {
      await fm.close();
    }
  });

  it('only shows: goals are refused, decisions are never created, no repo is registered', async () => {
    const h = home();
    writeEvents(h, LINES, 'w');
    const { fm } = await boot(h);
    try {
      await expect(fm.submitGoal('do something')).rejects.toThrow(/no repo connected yet|mirror mode only shows/);
      expect(fm.repos.list()).toEqual([]);
      expect(fm.store.data.decisions).toEqual([]);
      // nothing written outside the profile (which is also the hook's mirror directory)
      expect(fs.readdirSync(h).sort()).toEqual(['foreman.json', 'mirror'].filter((n) => fs.existsSync(path.join(h, n))).sort());
    } finally {
      await fm.close();
    }
  });
});
