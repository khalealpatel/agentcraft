// Suzy studio support: --setting-sources (the agents load the repo's own CLAUDE.md, skills and
// hooks) and --zones suzy (every task carries a write zone, written where Suzy's zone hooks read
// it, and checked again before a merge). Fake SDK as in claude-backend.test.ts: no API calls.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { ClaudeEngine } from '../src/agents/claude/engine.js';
import { inZone, normalizeZone, outOfZone, writeZoneFile, zoneFile } from '../src/zones.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

type ToolServer = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };
const tools = (o: Options) => (o.mcpServers!.agentcraft as unknown as ToolServer).instance._registeredTools;
const callTool = async (o: Options, name: string, args: Record<string, unknown>) => (await tools(o)[name]!.handler(args, {})).content.map((c) => c.text).join('\n');
const m = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: '00000000-0000-4000-8000-000000000000', ...o }) as unknown as SDKMessage;
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const init = (s: string) => m({ type: 'system', subtype: 'init', session_id: s, model: 'fake' });
const ok = (s: string) => m({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.001, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });

const cleanup: string[] = [];
afterAll(() => cleanup.forEach(rmrf));

interface Call {
  agent: string;
  prompt: string;
  options: Options;
  /** the zone file's content and mtime when the turn started (undefined: none) */
  zoneText?: string;
  zoneMtime?: number;
}

type Script = (o: Options, p: string, aborted: Promise<never>) => AsyncGenerator<SDKMessage>;

function fake(calls: Call[], scripts: Record<string, Script>) {
  return ({ prompt, options }: { prompt: string; options: Options }) => {
    const p = String(prompt);
    const agent = 'create_task' in tools(options) ? 'marlow' : (/[\\/](\w+)-t\d+(-\d+)?$/.exec(options.cwd!)?.[1] ?? '?');
    const zf = options.env?.SUZY_ZONE_FILE;
    calls.push({ agent, prompt: p, options, ...(zf && fs.existsSync(zf) ? { zoneText: fs.readFileSync(zf, 'utf8'), zoneMtime: fs.statSync(zf).mtimeMs } : {}) });
    const aborted = new Promise<never>((_, reject) => options.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    aborted.catch(() => undefined);
    return Object.assign(scripts[agent]!(options, p, aborted), { close() {}, accountInfo: async () => ({ email: 'x' }) });
  };
}

async function boot(args: string[], calls: Call[], scripts: Record<string, Script>): Promise<{ h: Harness; repo: string; errors: string[] }> {
  const home = tempDir();
  const repo = await demoRepo();
  cleanup.push(home, path.dirname(repo));
  const h = makeForeman(home, ['--backend', 'claude', '--workers', 'kit,juniper', '--repo', repo, ...args]);
  const errors: string[] = [];
  (h.fm.log as { error: (s: string) => void }).error = (s: string) => errors.push(s);
  await h.fm.start(new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: fake(calls, scripts) as never, skipAuthCheck: true }));
  return { h, repo, errors };
}

const isInside = (p: string, dir: string) => !path.relative(fs.realpathSync(dir), fs.realpathSync(p)).startsWith('..');
const porcelain = (cwd: string) => spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' }).stdout.trim();

describe('zone patterns', () => {
  it('normalizes and refuses bad zones with a reason', () => {
    expect(normalizeZone([' ./src/parser/ ', 'test/*.test.ts', 'src/parser/', ''])).toEqual(['src/parser/', 'test/*.test.ts']);
    expect(() => normalizeZone([])).toThrow(/zone is empty/);
    expect(() => normalizeZone(['/etc/passwd'])).toThrow(/absolute/);
    expect(() => normalizeZone(['C:/x'])).toThrow(/absolute/);
    expect(() => normalizeZone(['src/../..'])).toThrow(/leaves the repository/);
    expect(() => normalizeZone(['src/a b.ts'])).toThrow(/space/);
    expect(() => normalizeZone(['src/#x'])).toThrow(/space or "#"/);
    expect(() => normalizeZone(['*'])).toThrow(/whole repository/);
  });

  it("matches like deny-out-of-zone.sh: whole-path shell globs, '*' crosses '/', a trailing '/' owns the subtree", () => {
    const zone = ['docs/*', 'src/parser/', 'test/p?.ts', 'lib/[ab].js'];
    expect(inZone('docs/audit/HOOKS.md', zone)).toBe(true);
    expect(inZone('src/parser/deep/x.ts', zone)).toBe(true);
    expect(inZone('src/parser', zone)).toBe(false);
    expect(inZone('src/parserx/y.ts', zone)).toBe(false);
    expect(inZone('test/p1.ts', zone)).toBe(true);
    expect(inZone('test/p12.ts', zone)).toBe(false);
    expect(inZone('lib/a.js', zone)).toBe(true);
    expect(inZone('lib/c.js', zone)).toBe(false);
    expect(inZone('xdocs/a', zone)).toBe(false);
    expect(inZone('src/parser.ts', ['src/parser.ts'])).toBe(true);
    expect(inZone('src/parserxts', ['src/parser.ts'])).toBe(false); // '.' is literal
    expect(outOfZone(['docs/a', 'README.md', 'README.md'], zone)).toEqual(['README.md']);
  });

  it("writes zone.sh's format: '#' header lines with Session and Worktree, then one pattern per line", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const f = zoneFile(dir, 'demo-app', 'kit-t1');
    expect(f).toBe(path.join(dir, 'zones', 'demo-app', 'kit-t1.zone'));
    writeZoneFile(f, ['src/cli.ts', 'test/'], { taskId: 't1', agentId: 'kit', worktree: 'kit-t1', session: 'abc-123' });
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    expect(lines.filter((l) => l && !l.startsWith('#'))).toEqual(['src/cli.ts', 'test/']);
    expect(lines).toContain('# Session: abc-123');
    expect(lines).toContain('# Worktree: kit-t1');
    expect(lines.at(-1)).toBe('');
  });
});

describe('--setting-sources reaches the Claude engine', () => {
  async function optionsFor(args: string[]): Promise<{ turn: Options; probe: Options }> {
    const home = tempDir();
    cleanup.push(home);
    const h = makeForeman(home, ['--backend', 'claude', '--use-claude-login', ...args]);
    const seen: Options[] = [];
    const q = ({ options }: { options: Options }) => {
      seen.push(options);
      async function* run(): AsyncGenerator<SDKMessage> {
        yield init(sid(9));
        yield ok(sid(9));
      }
      return Object.assign(run(), { close() {}, accountInfo: async () => ({ email: 'x' }) });
    };
    const engine = new ClaudeEngine(h.fm, h.cfg.claude, q as never);
    await engine.runTurn({
      agentId: 'kit',
      role: 'worker',
      cwd: home,
      prompt: 'p',
      instructions: 'i',
      env: {},
      abort: new AbortController(),
      turn: { signal: new AbortController().signal, reason: () => undefined },
      permission: async () => ({ allow: true }),
      tools: [],
      onProcess: () => undefined,
      onSession: () => undefined,
    });
    expect((await engine.checkAuth()).ok).toBe(true);
    await h.fm.close();
    return { turn: seen[0]!, probe: seen[1]! };
  }

  it('passes the configured sources to every turn; the auth probe never loads settings', async () => {
    const { turn, probe } = await optionsFor(['--setting-sources', 'project,local']);
    expect(turn.settingSources).toEqual(['project', 'local']);
    expect(probe.settingSources).toEqual([]);
  });

  it('loads no settings by default (upstream behavior)', async () => {
    const { turn, probe } = await optionsFor([]);
    expect(turn.settingSources).toEqual([]);
    expect(probe.settingSources).toEqual([]);
  });
});

describe('--zones suzy (fake SDK)', () => {
  it('refuses a task without a zone, writes the zone outside the worktree for the hooks, and refuses an out-of-zone merge', async () => {
    const calls: Call[] = [];
    const replies: Record<string, string[]> = { create: [], merge: [], update: [] };
    let worktreeStatusAtStart: string | undefined;
    const marlow: Script = async function* (o, p) {
      yield init(sid(1));
      if (p.startsWith('New goal')) {
        replies.create!.push(await callTool(o, 'create_task', { title: 'Add a version flag', description: 'x', assignee: 'kit' }));
        replies.create!.push(await callTool(o, 'create_task', { title: 'Add a version flag', description: 'x', assignee: 'kit', zone: ['./src/cli.ts', 'test/'] }));
      }
      const review = /Review request: (t\d+)/.exec(p)?.[1];
      if (review) {
        replies.merge!.push(await callTool(o, 'request_merge', { task_id: review, summary: 'ok' }));
        // the out-of-zone file really belongs to the task: widen the zone, then ask again
        replies.update!.push(await callTool(o, 'update_task', { task_id: review, zone: ['src/cli.ts', 'test/', 'NOTES.md'] }));
        replies.merge!.push(await callTool(o, 'request_merge', { task_id: review, summary: 'ok' }));
      }
      yield ok(sid(1));
    };
    const kit: Script = async function* (o) {
      yield init(sid(2));
      worktreeStatusAtStart = porcelain(o.cwd!);
      fs.appendFileSync(path.join(o.cwd!, 'src', 'cli.ts'), '\n// --version\n');
      fs.writeFileSync(path.join(o.cwd!, 'NOTES.md'), 'out of zone\n'); // e.g. written through Bash
      const r = await callTool(o, 'update_task', { task_id: 't1', zone: ['*.md'] });
      expect(r).toMatch(/only the lead can change .*zone/);
      await callTool(o, 'update_task', { task_id: 't1', status: 'review', summary: 'done' });
      yield ok(sid(2));
    };
    const { h, repo, errors } = await boot(['--zones', 'suzy', '--setting-sources', 'project'], calls, { marlow, kit, juniper: kit });
    const fm = h.fm;
    await fm.submitGoal('version flag');
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 30_000);
    expect(errors).toEqual([]);

    // create_task: refused without a zone, with a message that says what to do
    expect(replies.create![0]).toMatch(/Error: this team runs with write zones \(--zones suzy\): every task needs a zone/);
    expect(replies.create![1]).toMatch(/Created t1/);
    expect(fm.tasks.list()).toHaveLength(1);

    // the lead is told to give zones; lead and workers load the project's settings
    const lead = calls.find((c) => c.agent === 'marlow')!;
    expect((lead.options.systemPrompt as { append: string }).append).toContain('Every task needs a write zone');
    expect(lead.options.settingSources).toEqual(['project']);
    expect(lead.options.env!.SUZY_ZONE_FILE).toBeUndefined();

    // the worker: SUZY_ZONE_FILE names a zone in Suzy's format, outside the worktree and the repo
    const turn = calls.find((c) => c.agent === 'kit')!;
    const wt = fm.repos.findWorktree('demo-app', 'kit-t1')!;
    const zf = turn.options.env!.SUZY_ZONE_FILE!;
    expect(zf).toBe(zoneFile(h.cfg.dataDir, 'demo-app', 'kit-t1'));
    expect(turn.options.settingSources).toEqual(['project']);
    expect(turn.zoneText!.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['src/cli.ts', 'test/']);
    expect(turn.zoneText).toContain('# Worktree: kit-t1');
    expect(isInside(zf, wt.path)).toBe(false);
    expect(isInside(zf, repo)).toBe(false);
    expect(worktreeStatusAtStart).toBe('');
    expect((turn.options.systemPrompt as { append: string }).append).toContain('Your write zone (repo-relative): src/cli.ts, test/.');

    // request_merge: refused while NOTES.md is outside the zone; allowed once the lead widens it
    expect(replies.merge![0]).toMatch(/t1 changes files outside its write zone \(src\/cli\.ts, test\/\): NOTES\.md\./);
    expect(replies.update![0]).toMatch(/Updated t1/);
    expect(fs.readFileSync(zf, 'utf8')).toContain('\nNOTES.md\n'); // a running worker's hooks see it at once
    expect(replies.merge![1]).toMatch(/Merge decision .* sent/);

    // the merge never carries the zone file
    const d = fm.decisions.open().find((x) => x.kind === 'merge' && x.taskId === 't1')!;
    await fm.answerDecision(d.id, 'Merge');
    expect(fm.tasks.get('t1')!.status).toBe('done');
    const tracked = spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout;
    expect(tracked).toContain('NOTES.md');
    expect(tracked).not.toMatch(/\.zone\b/);
    await fm.close();
  });

  it('moves the zone with a handed-off task', async () => {
    const calls: Call[] = [];
    const marlow: Script = async function* (o, p) {
      yield init(sid(1));
      if (p.startsWith('New goal')) await callTool(o, 'create_task', { title: 'Add a version flag', description: 'x', assignee: 'kit', zone: ['src/'] });
      yield ok(sid(1));
    };
    const kit: Script = async function* (_o, _p, aborted) {
      yield init(sid(2));
      await aborted; // works until stopped
    };
    const juniper: Script = async function* () {
      yield init(sid(3));
      yield ok(sid(3));
    };
    const { h } = await boot(['--zones', 'suzy'], calls, { marlow, kit, juniper });
    const fm = h.fm;
    await fm.submitGoal('version flag');
    await until(() => calls.some((c) => c.agent === 'kit'));
    const kitZone = zoneFile(h.cfg.dataDir, 'demo-app', 'kit-t1');
    expect(fs.existsSync(kitZone)).toBe(true);
    await fm.agentAction('kit', 'stop');
    await until(() => calls.some((c) => c.agent === 'juniper'), 30_000);
    const turn = calls.find((c) => c.agent === 'juniper')!;
    expect(turn.options.env!.SUZY_ZONE_FILE).toBe(zoneFile(h.cfg.dataDir, 'demo-app', 'juniper-t1'));
    expect(turn.zoneText).toContain('# Worktree: juniper-t1');
    expect(turn.zoneText!.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['src/']);
    expect(fs.existsSync(kitZone)).toBe(false);
    await fm.close();
  });

  it("rewrites the zone at every worker turn, so Suzy's 24h expiry never lapses mid-task", async () => {
    const calls: Call[] = [];
    const marlow: Script = async function* (o, p) {
      yield init(sid(1));
      if (p.startsWith('New goal')) await callTool(o, 'create_task', { title: 'Add a version flag', description: 'x', assignee: 'kit', zone: ['src/'] });
      yield ok(sid(1));
    };
    let turns = 0;
    const kit: Script = async function* (o) {
      yield init(sid(2));
      if (++turns === 1) {
        // the first turn ends without update_task (the Foreman nudges, a second turn follows);
        // meanwhile the zone has aged past Suzy's 24h and lost its pattern
        const zf = o.env!.SUZY_ZONE_FILE!;
        fs.writeFileSync(zf, '# stale\n');
        const old = new Date(Date.now() - 2 * 86_400_000);
        fs.utimesSync(zf, old, old);
      } else await callTool(o, 'update_task', { task_id: 't1', status: 'review', summary: 'done' });
      yield ok(sid(2));
    };
    const { h } = await boot(['--zones', 'suzy'], calls, { marlow, kit, juniper: kit });
    await h.fm.submitGoal('version flag');
    await until(() => calls.filter((c) => c.agent === 'kit').length >= 2, 30_000);
    const second = calls.filter((c) => c.agent === 'kit')[1]!;
    expect(second.zoneText!.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['src/']);
    expect(Date.now() - second.zoneMtime!).toBeLessThan(60_000);
    await h.fm.close();
  });

  it('blocks a task that has no zone instead of running a worker without one', async () => {
    const calls: Call[] = [];
    let h: Harness | undefined;
    const marlow: Script = async function* (_o, p) {
      yield init(sid(1));
      // a task from before --zones suzy was turned on
      if (p.startsWith('New goal')) h!.fm.tasks.create({ title: 'old task', assignee: 'kit', createdBy: 'marlow', goalId: h!.fm.currentGoal()!.id, repoId: 'demo-app' });
      yield ok(sid(1));
    };
    const idle: Script = async function* () {
      yield init(sid(2));
      yield ok(sid(2));
    };
    const booted = await boot(['--zones', 'suzy'], calls, { marlow, kit: idle, juniper: idle });
    h = booted.h;
    await h.fm.submitGoal('old work');
    await until(() => h!.fm.tasks.get('t1')?.status === 'blocked');
    expect(h.fm.tasks.get('t1')!.blockedReason).toMatch(/no write zone \(--zones suzy\)/);
    expect(calls.some((c) => c.agent === 'kit')).toBe(false);
    await h.fm.close();
  });
});

describe('without --zones (upstream behavior)', () => {
  it('needs no zone, sets no SUZY_ZONE_FILE, writes no zone files and loads no settings', async () => {
    const calls: Call[] = [];
    const replies: string[] = [];
    const marlow: Script = async function* (o, p) {
      yield init(sid(1));
      if (p.startsWith('New goal')) replies.push(await callTool(o, 'create_task', { title: 'Add a version flag', description: 'x', assignee: 'kit' }));
      const review = /Review request: (t\d+)/.exec(p)?.[1];
      if (review) replies.push(await callTool(o, 'request_merge', { task_id: review, summary: 'ok' }));
      yield ok(sid(1));
    };
    const kit: Script = async function* (o) {
      yield init(sid(2));
      fs.writeFileSync(path.join(o.cwd!, 'NOTES.md'), 'anything\n');
      await callTool(o, 'update_task', { task_id: 't1', status: 'review', summary: 'done' });
      yield ok(sid(2));
    };
    const { h } = await boot([], calls, { marlow, kit, juniper: kit });
    await h.fm.submitGoal('version flag');
    await until(() => h.fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 30_000);
    expect(replies[0]).toMatch(/Created t1/);
    expect(replies[1]).toMatch(/Merge decision .* sent/);
    expect(h.fm.tasks.get('t1')!.zone).toBeUndefined();
    for (const c of calls) {
      expect(c.options.env!.SUZY_ZONE_FILE).toBeUndefined();
      expect(c.options.settingSources).toEqual([]);
      expect((c.options.systemPrompt as { append: string }).append).not.toMatch(/write zone/);
    }
    expect(fs.existsSync(path.join(h.cfg.dataDir, 'zones'))).toBe(false);
    await h.fm.close();
  });
});
