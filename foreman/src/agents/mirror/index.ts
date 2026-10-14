// Mirror backend: the founder's own Claude Code sessions, shown in the world. Read only.
//
// tools/mirror/hook.mjs (a user-level Claude Code hook) appends one allowlisted line per hook event
// to <home>/mirror/events.jsonl. This backend tails that log from a cursor saved in the profile's
// state and drives the world through the Foreman's normal primitives, so tasks, the feed, monitor
// logs and lane notes are ordinary history that survives restarts.
//
//   SessionStart        next free cast member (workers first, Marlow last) goes on shift
//   first prompt        task card titled with the lane ID, `doing`, assigned to that agent
//   PreToolUse          toolActivity(): state, station, nameplate activity
//   PostToolUse(Failure) one monitor line: the label plus ok or error
//   test command        task CI `running`, then `pass` or `fail`
//   git push / gh pr    the merge station; feed "Pushed" / "PR opened" with the branch
//   Notification        `waiting_user` at the user station plus a feed line (display only); the
//                       nameplate then counts "waiting on you 12m" (refreshed once a minute)
//   Stop                task `review`, agent back to the lounge, lane note written (with its
//                       Numbers), feed "<lane> finished: 2h10m, waited on you 23m across 4 stops, tests 6/6"
//   SessionEnd / idle   off shift
//
// It never runs agents, commands or git, never calls an API, and writes only through the Foreman
// (the profile directory). Nothing in the world can answer or change a lane: that stays in Claude Code.
import { LEAD_ID, WORKER_IDS } from '../../cast.js';
import type { MirrorConfig } from '../../config.js';
import { ClientError, type Backend, type Foreman } from '../../foreman.js';
import type { Decision, Goal, Task } from '../../protocol.js';
import { userName } from '../../user.js';
import { slugify } from '../../util/text.js';
import { TEST_CMD_RE, toolActivity } from '../activity.js';
import { modelLabel } from '../models.js';
import { addEvent, finishedLine, inferLane, mergeLane, newSession, numbersMarkdown, waitingLabel } from '../../../../tools/mirror/stats.mjs';
import { EventLog, parseEvent, type Cursor, type MirrorEvent } from './eventlog.js';
import { MAX_ERRORS, MAX_FILES, renderLaneNote, type LaneSession } from './lanes.js';
import type { LaneStats } from '../../../../tools/mirror/stats.mjs';

export const MIRROR_STATUS = 'Mirror of your Claude Code lanes';
/** Order in which cast members take new sessions: workers first, Marlow last. */
export const MIRROR_CAST = [...WORKER_IDS, LEAD_ID];

/** Test commands: the shared TEST_CMD_RE plus the repos' own check scripts. */
export const MIRROR_TEST_RE = new RegExp(`${TEST_CMD_RE.source}|(^|[\\s;&|(])(npm|pnpm|yarn)\\s+run\\s+check\\b|(^|[\\s;&|(])vitest\\b`);
const PUSH_RE = /(^|[\s;&|(])git\s+push\b/;
const PR_RE = /(^|[\s;&|(])gh\s+pr\s+create\b/;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** the nameplate shows a wait at most once a minute */
export const WAIT_REFRESH_MS = 60_000;
/** a lane waiting on you stays on shift this long past the idle sweep; an abandoned prompt does not hold an avatar */
export const WAIT_SHOW_MAX_MS = 2 * 60 * 60_000;

interface MirrorState {
  cursor?: Cursor;
  sessions: Record<string, LaneSession>;
  /** lane ID -> its task, so a lane picked up again in a new session keeps one card */
  laneTasks: Record<string, string>;
  /** unnamed lane notes per day: date -> last n */
  unnamed: Record<string, number>;
}

export class MirrorBackend implements Backend {
  readonly name = 'mirror' as const;
  private readonly log: EventLog;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private fm: Foreman,
    private cfg: MirrorConfig,
  ) {
    this.log = new EventLog(cfg.dir);
  }

  get state(): MirrorState {
    const b = this.fm.store.data.backend;
    let st = b.mirror as MirrorState | undefined;
    if (!st) {
      st = { sessions: {}, laneTasks: {}, unnamed: {} };
      b.mirror = st;
      this.fm.store.markDirty();
    }
    return st;
  }

  async start(): Promise<void> {
    this.fm.setStatus({ backend: 'mirror', auth: 'ok', message: MIRROR_STATUS });
    // nobody is on shift except the agents showing a live session
    const busy = new Set(Object.values(this.state.sessions).filter((s) => s.live && s.agentId).map((s) => s.agentId));
    for (const id of MIRROR_CAST) {
      if (!busy.has(id) && this.fm.agent(id)) this.fm.setAgent(id, { active: false, state: 'idle', station: 'lounge', activity: 'off shift', taskId: null });
    }
    this.poll();
    this.timer = setInterval(() => this.poll(), this.cfg.pollMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.fm.store.flush();
  }

  /** Apply every new event, save the cursor, then send idle sessions off shift. Public for tests. */
  poll(): number {
    if (this.stopped) return 0;
    let applied = 0;
    try {
      const st = this.state;
      const { lines, cursor } = this.log.read(st.cursor);
      for (const line of lines) {
        const e = parseEvent(line);
        if (!e) continue;
        try {
          this.apply(e);
          applied++;
        } catch (err) {
          this.fm.log.warn(`mirror: event ${e.event} skipped: ${(err as Error).message}`);
        }
      }
      if (cursor && (cursor.ino !== st.cursor?.ino || cursor.offset !== st.cursor?.offset)) st.cursor = cursor;
      this.refreshWaits();
      this.sweepIdle();
      if (applied || this.fm.store.isDirty) {
        this.fm.flushLogs();
        this.fm.store.flush(); // the cursor and what it applied land on disk together
      }
    } catch (err) {
      this.fm.log.warn(`mirror: reading ${this.log.file}: ${(err as Error).message}`);
    }
    return applied;
  }

  // ---- events --------------------------------------------------------------------------------

  private apply(e: MirrorEvent): void {
    const s = this.session(e);
    s.lastTs = Math.max(s.lastTs, e.ts);
    this.count(s, e);
    switch (e.event) {
      case 'SessionStart':
        if (e.model) s.model = modelLabel(e.model) ?? e.model;
        if (s.agentId) this.fm.setAgent(s.agentId, { ...(s.model ? { model: s.model } : {}) });
        break;
      case 'UserPromptSubmit':
        return this.onPrompt(s, e);
      case 'PreToolUse':
        return this.onPreTool(s, e);
      case 'PostToolUse':
      case 'PostToolUseFailure':
        return this.onPostTool(s, e);
      case 'Notification':
        return this.onNotification(s, e);
      case 'Stop':
        return this.onStop(s);
      case 'SubagentStop':
        if (s.agentId) this.fm.agentLog(s.agentId, 'text', 'Subagent finished');
        return;
      case 'SessionEnd':
        return this.offShift(s, e.ts, e.reason ? `session ended: ${e.reason}` : 'session ended');
    }
  }

  /** The session for an event: created (and put on shift) on its first event, revived after idling off. */
  private session(e: MirrorEvent): LaneSession {
    const st = this.state;
    let s = st.sessions[e.sid];
    if (!s) {
      s = { sid: e.sid, repo: e.repo, branch: e.branch, live: false, startedAt: e.ts, lastTs: e.ts, turns: 0, files: [], tests: [], errors: [] };
      st.sessions[e.sid] = s;
    }
    s.branch = e.branch; // a lane may switch branches (git checkout -b)
    if (!s.live && e.event !== 'SessionEnd') {
      s.live = true;
      delete s.endedAt;
      delete s.endReason;
      this.assignAgent(s);
      this.fm.bus.feed('system', `${s.agentId ? this.fm.nameOf(s.agentId) : 'A lane with no free avatar'} is on a Claude Code session in ${s.repo} (${s.branch})`, s.agentId ? { agentId: s.agentId } : {});
    }
    this.fm.store.markDirty();
    return s;
  }

  /** Fold the event into the session's numbers, and end a wait on the founder the event answers. */
  private count(s: LaneSession, e: MirrorEvent): void {
    if (!s.stats) {
      s.stats = newSession(e);
      if (s.startedAt < e.ts) {
        // saved by a Foreman that did not count yet: the numbers start where this view did
        s.stats.first = s.startedAt;
        s.stats.partial = true;
      }
    }
    addEvent(s.stats, e);
    if (e.event === 'Notification' || s.waitingSince === undefined) return;
    delete s.waitingSince;
    delete s.waitShownAt;
    if (s.agentId && this.fm.agent(s.agentId)?.state === 'waiting_user' && (e.event === 'PostToolUse' || e.event === 'PostToolUseFailure')) {
      const task = s.taskId ? this.fm.tasks.get(s.taskId) : undefined;
      this.fm.setAgent(s.agentId, { state: 'thinking', station: 'desk', activity: task ? `thinking (${task.title})` : 'thinking' });
    }
  }

  /** A resumed session without the brief belongs to the lane most recently seen on its repo and branch. */
  private resumedLane(s: LaneSession): string | undefined {
    if (s.lane || !s.stats) return undefined;
    const others = Object.values(this.state.sessions).filter((x) => x.sid !== s.sid && x.stats).map((x) => ({ ...x.stats!, lane: x.lane ?? x.stats!.lane }));
    return inferLane({ ...s.stats, lane: null }, others);
  }

  private freeAgent(): string | undefined {
    const busy = new Set(Object.values(this.state.sessions).filter((x) => x.live && x.agentId).map((x) => x.agentId));
    return MIRROR_CAST.find((id) => !busy.has(id) && this.fm.agent(id));
  }

  private assignAgent(s: LaneSession): void {
    const id = this.freeAgent();
    if (!id) {
      delete s.agentId;
      return;
    }
    s.agentId = id;
    s.agentName = this.fm.nameOf(id);
    const task = s.taskId ? this.fm.tasks.get(s.taskId) : undefined;
    this.fm.setAgent(id, {
      active: true,
      paused: false,
      engine: 'claude',
      ...(s.model ? { model: s.model } : {}),
      state: 'thinking',
      station: 'desk',
      activity: `on ${s.repo} ${s.branch}`,
      taskId: task?.id ?? null,
    });
    if (task && task.assignee !== id) this.fm.tasks.update(task.id, { assignee: id });
    this.fm.agentLog(id, 'text', `On shift: mirroring a Claude Code session in ${s.repo} on ${s.branch}`);
  }

  private onPrompt(s: LaneSession, e: MirrorEvent): void {
    s.turns++;
    if (e.first && e.lane && !s.lane) s.lane = e.lane;
    if (s.turns === 1 && !s.lane) s.lane = this.resumedLane(s);
    let task = s.taskId ? this.fm.tasks.get(s.taskId) : undefined;
    if (!task && s.lane && this.state.laneTasks[s.lane]) task = this.fm.tasks.get(this.state.laneTasks[s.lane]!);
    if (!task) {
      task = this.fm.tasks.create({
        title: s.lane ?? `${s.repo} @ ${s.branch}`,
        description: `Claude Code session in ${s.repo} on ${s.branch} (mirror mode: read only)`,
        createdBy: 'user',
        ...(s.agentId ? { assignee: s.agentId } : {}),
      });
      this.fm.bus.feed('task', `Lane ${task.title} started${s.agentId ? ` (${this.fm.nameOf(s.agentId)})` : ''}`, s.agentId ? { agentId: s.agentId } : {});
    }
    s.taskId = task.id;
    if (s.lane) this.state.laneTasks[s.lane] = task.id;
    this.fm.tasks.update(task.id, { branch: s.branch, assignee: s.agentId ?? null });
    if (task.status !== 'doing') this.fm.tasks.setStatus(task.id, 'doing', { force: true });
    if (s.agentId) {
      this.fm.setAgent(s.agentId, { taskId: task.id, state: 'thinking', station: 'desk', activity: `thinking (${task.title})` });
      this.fm.agentLog(s.agentId, 'text', `Prompt ${s.turns} from ${userName()}`);
    }
  }

  private input(e: MirrorEvent): Record<string, unknown> {
    // toolActivity reads the same keys as a real tool input; patterns and contents are never logged
    return { ...(e.file ? { file_path: e.file } : {}), ...(e.cmd ? { command: e.cmd } : {}), ...(e.tool === 'Grep' ? { pattern: '...' } : {}) };
  }

  private onPreTool(s: LaneSession, e: MirrorEvent): void {
    const tool = e.tool ?? 'tool';
    const cmd = e.cmd ?? '';
    if (e.file && EDIT_TOOLS.has(tool) && !s.files.includes(e.file) && s.files.length < MAX_FILES) s.files.push(e.file);
    const task = s.taskId ? this.fm.tasks.get(s.taskId) : undefined;
    if (cmd && MIRROR_TEST_RE.test(cmd)) {
      s.testRunning = true;
      if (task) this.fm.tasks.update(task.id, { ci: 'running' });
    }
    if (!s.agentId) return;
    if (cmd && (PR_RE.test(cmd) || PUSH_RE.test(cmd))) {
      this.fm.setAgent(s.agentId, { state: 'running', station: 'mergestation', activity: PR_RE.test(cmd) ? `opening a PR from ${s.branch}` : `pushing ${s.branch}` });
      return;
    }
    const act = toolActivity(tool, this.input(e));
    const testing = cmd && MIRROR_TEST_RE.test(cmd);
    this.fm.setAgent(s.agentId, testing ? { state: 'testing', station: 'testbench', activity: `testing: ${cmd.slice(0, 32)}` } : { state: act.state, station: act.station, activity: act.activity });
  }

  private onPostTool(s: LaneSession, e: MirrorEvent): void {
    const tool = e.tool ?? 'tool';
    const cmd = e.cmd ?? '';
    const ok = e.ok !== false;
    const label = toolActivity(tool, this.input(e)).label;
    const result = ok ? 'ok' : `error${e.exit !== undefined ? ` (exit ${e.exit})` : ''}${e.interrupted ? ' (interrupted)' : ''}`;
    if (s.agentId) this.fm.agentLog(s.agentId, ok ? 'tool' : 'error', `${label}: ${result}`);
    if (!ok && s.errors.length < MAX_ERRORS) s.errors.push(`${label}: ${result}`);
    const task = s.taskId ? this.fm.tasks.get(s.taskId) : undefined;
    const who = s.agentId ? this.fm.nameOf(s.agentId) : (task?.title ?? s.branch);
    const by = s.agentId ? { agentId: s.agentId } : {};
    if (cmd && MIRROR_TEST_RE.test(cmd)) {
      s.testRunning = false;
      s.tests.push({ cmd, ok, ts: e.ts, ...(e.exit !== undefined ? { exit: e.exit } : {}) });
      if (task) this.fm.tasks.update(task.id, { ci: ok ? 'pass' : 'fail' });
      this.fm.bus.feed('ci', `${who}: tests ${ok ? 'passed' : 'FAILED'} (${cmd})`, by);
    }
    if (ok && cmd && PR_RE.test(cmd)) {
      s.pr = s.branch;
      this.fm.bus.feed('merge', `PR opened from ${s.branch} (${who})`, by);
    } else if (ok && cmd && PUSH_RE.test(cmd)) {
      s.pushed = s.branch;
      this.fm.bus.feed('merge', `${who} pushed ${s.branch}`, by);
    }
  }

  private onNotification(s: LaneSession, e: MirrorEvent): void {
    if (e.kind === 'auth_success') return;
    const what = e.kind === 'permission_prompt' ? 'a permission' : e.kind === 'idle_prompt' ? 'your next prompt' : 'you';
    s.waitingSince ??= e.ts;
    const now = this.fm.ctx.now();
    s.waitShownAt = now;
    if (s.agentId) this.fm.setAgent(s.agentId, { state: 'waiting_user', station: 'user', activity: waitingLabel(Math.max(0, now - s.waitingSince)) });
    // display only: no Decision, nothing to answer here; the answer is given in Claude Code
    this.fm.bus.feed('decision', `${s.agentId ? this.fm.nameOf(s.agentId) : s.branch} is waiting for ${what} in Claude Code (${s.lane ?? s.branch})`, s.agentId ? { agentId: s.agentId, to: 'user' } : { to: 'user' });
  }

  private onStop(s: LaneSession): void {
    const task = s.taskId ? this.fm.tasks.get(s.taskId) : undefined;
    if (task && task.status === 'doing') this.fm.tasks.setStatus(task.id, 'review', { force: true });
    if (s.testRunning && task) this.fm.tasks.update(task.id, { ci: 'unknown' });
    s.testRunning = false;
    if (s.agentId) {
      this.fm.setAgent(s.agentId, { state: 'idle', station: 'lounge', activity: task ? `${task.title}: ready for review` : 'turn finished' });
      this.fm.agentLog(s.agentId, 'result', `Turn finished${task ? `: ${task.title} waits for your review` : ''}`);
    }
    const lane = this.writeNote(s);
    if (lane) this.fm.bus.feed('task', finishedLine(lane, s.lane ?? task?.title ?? s.branch), s.agentId ? { agentId: s.agentId } : {});
  }

  /** SessionEnd, or no events for the idle time: off shift; a lane waiting for an avatar gets this one. */
  private offShift(s: LaneSession, ts: number, reason: string): void {
    if (!s.live) return;
    s.live = false;
    s.endedAt = ts;
    s.endReason = reason;
    delete s.waitingSince;
    delete s.waitShownAt;
    const task = s.taskId ? this.fm.tasks.get(s.taskId) : undefined;
    if (task && task.status === 'doing') this.fm.tasks.setStatus(task.id, 'review', { force: true });
    const freed = s.agentId;
    if (freed) {
      this.fm.setAgent(freed, { active: false, state: 'idle', station: 'lounge', activity: 'off shift', taskId: null });
      this.fm.agentLog(freed, 'text', `Off shift (${reason})`);
    }
    delete s.agentId;
    this.writeNote(s);
    this.fm.store.markDirty();
    const waiting = Object.values(this.state.sessions).filter((x) => x.live && !x.agentId).sort((a, b) => a.startedAt - b.startedAt)[0];
    if (waiting) {
      this.assignAgent(waiting);
      if (waiting.agentId && waiting.taskId) this.fm.setAgent(waiting.agentId, { taskId: waiting.taskId });
    }
  }

  /** Nameplates of lanes waiting on you say for how long; the text changes by the minute, so once a minute is plenty. */
  private refreshWaits(): void {
    const now = this.fm.ctx.now();
    for (const s of Object.values(this.state.sessions)) {
      if (!s.live || !s.agentId || s.waitingSince === undefined) continue;
      if (s.waitShownAt !== undefined && now - s.waitShownAt < WAIT_REFRESH_MS) continue;
      const label = waitingLabel(Math.max(0, now - s.waitingSince));
      s.waitShownAt = now;
      const a = this.fm.agent(s.agentId);
      if (a?.state === 'waiting_user' && a.activity !== label) this.fm.setAgent(s.agentId, { activity: label });
    }
  }

  private sweepIdle(): void {
    const now = this.fm.ctx.now();
    for (const s of Object.values(this.state.sessions)) {
      // waiting on you is exactly when no events come: stay on shift for a while
      if (s.waitingSince !== undefined && now - s.waitingSince < WAIT_SHOW_MAX_MS) continue;
      if (s.live && now - s.lastTs > this.cfg.idleMs) this.offShift(s, s.lastTs, `no events for ${Math.round(this.cfg.idleMs / 60_000)} min`);
    }
  }

  // ---- lane notes ------------------------------------------------------------------------------

  /** Write the lane's note (its sessions, then the Numbers) and return the lane's numbers. */
  private writeNote(s: LaneSession): LaneStats | null {
    const st = this.state;
    if (!s.note) {
      if (s.lane) s.note = slugify(s.lane, 48);
      else {
        const day = new Date(s.startedAt).toISOString().slice(0, 10);
        st.unnamed[day] = (st.unnamed[day] ?? 0) + 1;
        s.note = `unnamed-${day}-${st.unnamed[day]}`;
      }
    }
    const sessions = Object.values(st.sessions).filter((x) => x.note === s.note);
    const title = s.lane ?? `Unnamed lane ${s.note.replace(/^unnamed-/, '')}`;
    const lane = mergeLane(sessions.flatMap((x) => (x.stats ? [x.stats] : [])), { now: this.fm.ctx.now(), name: title });
    this.fm.memory.write({ scope: 'lanes', slug: s.note, title, body: renderLaneNote(title, sessions, lane ? numbersMarkdown(lane) : undefined), author: s.agentId ?? 'user' });
    return lane;
  }

  // ---- the world asks: a mirror only shows ------------------------------------------------------

  async submitGoal(goal: Goal): Promise<void> {
    this.fm.setGoal(goal.id, { status: 'cancelled' });
    throw new ClientError('mirror mode only shows your Claude Code sessions: start work in Claude Code');
  }

  onUserMessage(to: string): void {
    const id = to === 'all' ? undefined : to;
    if (id && this.fm.agent(id)) this.fm.agentLog(id, 'text', 'Mirror mode is read only: talk to this lane in Claude Code.');
  }

  onDecisionSettled(_d: Decision): void {
    // the mirror never creates decisions
  }

  onTaskAction(task: Task, action: string): void {
    this.fm.log.info(`mirror: ${action} on ${task.id} changes only the card; the lane itself runs in Claude Code`);
  }

  onAgentAction(agentId: string, action: string): void {
    this.fm.agentLog(agentId, 'text', `Mirror mode is read only (${action}): the session runs in Claude Code.`);
  }
}
