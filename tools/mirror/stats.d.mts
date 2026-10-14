// Types for the parts of stats.mjs the Foreman's mirror backend imports (foreman/src/agents/mirror).
export interface HookEvent {
  ts: number;
  sid: string;
  event: string;
  repo?: string;
  branch?: string;
  tool?: string;
  file?: string;
  cmd?: string;
  ok?: boolean;
  exit?: number;
  lane?: string;
  model?: string;
  source?: string;
  kind?: string;
}
/** JSON state of one session's numbers (persisted by the backend, folded by addEvent). */
export interface SessionStats {
  sid: string;
  repo: string;
  branch: string;
  lane: string | null;
  resumed: boolean;
  model: string | null;
  first: number;
  last: number;
  n: number;
  skew: number;
  calls: { read: number; edit: number; bash: number; other: number };
  errors: number;
  files: Record<string, number>;
  tests: { runs: number; pass: number; first: Record<string, boolean> };
  pr: string | null;
  pushed: string | null;
  waits: { count: number; ms: number; longest: number; byKind: Record<string, number> };
  openWait: { since: number; kind: string } | null;
  idle: { count: number; ms: number };
  inFlight: number;
  ended: boolean;
  partial?: boolean;
}
export interface LaneStats {
  lane: string | null;
  named: boolean;
  repo: string;
  branch: string;
  sessions: number;
  sids: string[];
  start: number;
  end: number;
  wall: number;
  active: number;
  waits: { count: number; ms: number; longest: number; byKind: Record<string, number>; open: { since: number; ms: number; kind: string } | null };
  idle: { count: number; ms: number };
  calls: { total: number; read: number; edit: number; bash: number; other: number };
  files: { count: number; top: { file: string; edits: number }[] };
  tests: { runs: number; pass: number; fail: number; firstRun: { pass: number; of: number; rate: number | null } };
  pr: { opened: boolean; pushed: boolean; branch: string | null; any: boolean };
  errors: number;
  model: string | null;
  models: string[];
  skew: number;
  partial: boolean;
}
export declare const IDLE_MS: number;
export declare function newSession(e: HookEvent): SessionStats;
export declare function addEvent(s: SessionStats, e: HookEvent): SessionStats;
export declare function inferLane(s: SessionStats, others: SessionStats[]): string | undefined;
export declare function mergeLane(sessions: SessionStats[], opts?: { now?: number; name?: string }): LaneStats | null;
export declare function numbersMarkdown(lane: LaneStats): string;
export declare function finishedLine(lane: LaneStats, title?: string): string;
export declare function waitingLabel(ms: number): string;
export declare function formatDuration(ms: number): string;
export declare function isTestCommand(cmd: unknown): boolean;
