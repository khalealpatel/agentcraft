// Lane records: one markdown note per lane under memory/lanes/, shown in the in-game Memory
// Archive. Built only from the hook's allowlisted fields (no prompt text, file contents or output),
// scrubbed once more on the way out.
import { scrub } from '../../../../tools/mirror/lib.mjs';
import type { SessionStats } from '../../../../tools/mirror/stats.mjs';

export const MAX_FILES = 40;
export const MAX_ERRORS = 20;

export interface TestRun {
  cmd: string;
  ok: boolean;
  exit?: number;
  ts: number;
}

/** One Claude Code session as the mirror saw it (persisted in the profile's state). */
export interface LaneSession {
  sid: string;
  repo: string;
  branch: string;
  lane?: string;
  /** memory slug of the lane note (lane ID, or unnamed-<date>-<n>) */
  note?: string;
  agentId?: string;
  /** the agent that last showed it (kept after it went off shift, for the note) */
  agentName?: string;
  taskId?: string;
  model?: string;
  live: boolean;
  startedAt: number;
  lastTs: number;
  endedAt?: number;
  endReason?: string;
  turns: number;
  files: string[];
  tests: TestRun[];
  /** a test command is running (PreToolUse seen, result not yet) */
  testRunning?: boolean;
  pushed?: string;
  pr?: string;
  errors: string[];
  /** the session's numbers (tools/mirror/stats.mjs), folded in as events arrive */
  stats?: SessionStats;
  /** when the current wait on the founder began (a Notification not yet followed by another event) */
  waitingSince?: number;
  /** when the nameplate last showed the wait's duration */
  waitShownAt?: number;
}

const iso = (ts: number) => new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

function sessionBlock(s: LaneSession, n: number, total: number): string[] {
  const end = s.endedAt ?? s.lastTs;
  const out = [
    total > 1 ? `## Session ${n} of ${total}` : '## Session',
    '',
    `- Repo: ${s.repo}`,
    `- Branch: ${s.branch}`,
    `- Agent: ${s.agentName ?? 'none (more than six live lanes)'}`,
    ...(s.model ? [`- Model: ${s.model}`] : []),
    `- Started: ${iso(s.startedAt)}`,
    `- Ended: ${s.live ? `still running (last event ${iso(s.lastTs)})` : `${iso(end)}${s.endReason ? ` (${s.endReason})` : ''}`}`,
    `- Duration: ${duration(end - s.startedAt)}`,
    `- Prompts: ${s.turns}`,
    `- PR opened: ${s.pr ? `yes, from branch ${s.pr}` : 'no'}${s.pushed && !s.pr ? ` (pushed ${s.pushed})` : ''}`,
  ];
  const passed = s.tests.filter((t) => t.ok).length;
  out.push(`- Test runs: ${s.tests.length}${s.tests.length ? ` (${passed} passed, ${s.tests.length - passed} failed)` : ''}`);
  for (const t of s.tests) out.push(`  - ${t.ok ? 'pass' : 'fail'} ${code(t.cmd)}${t.exit !== undefined && !t.ok ? ` (exit ${t.exit})` : ''} at ${iso(t.ts)}`);
  out.push('', `### Files touched (${s.files.length}${s.files.length >= MAX_FILES ? `, first ${MAX_FILES}` : ''})`, '');
  out.push(...(s.files.length ? s.files.map((f) => `- ${f}`) : ['- none']));
  out.push('', `### Errors (${s.errors.length})`, '');
  out.push(...(s.errors.length ? s.errors.map((e) => `- ${e}`) : ['- none']));
  return out;
}

/**
 * The note for one lane: every session that carried its lane ID (or the one unnamed session).
 * `numbers` is the lane's "## Numbers" section (tools/mirror/stats.mjs), shown before the sessions.
 */
export function renderLaneNote(title: string, sessions: LaneSession[], numbers?: string): string {
  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  const lines = [
    `# ${title}`,
    '',
    'Lane record from mirror mode: what the Claude Code session did, from its hook events. It holds no prompt text, file contents or tool output.',
    '',
    `- Lane: ${ordered[0]?.lane ?? 'none (no FIRING BRIEF or Name line in the first prompt)'}`,
    `- Sessions: ${ordered.length}`,
    '',
    ...(numbers ? [numbers, ''] : []),
    ...ordered.flatMap((s, i) => [...sessionBlock(s, i + 1, ordered.length), '']),
  ];
  return scrub(lines.join('\n').trimEnd());
}
