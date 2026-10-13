// Per-task write zones (--zones suzy): the repo-relative globs a task may change.
//
// A repository that guards its lanes with Suzy's zone hooks (deny-out-of-zone.sh refuses an
// Edit/Write outside the zone, zone-commit-gate.sh refuses a commit with no zone or out-of-zone
// paths) reads the zone from a file. For an AgentCraft worktree those hooks resolve the worktree as
// "main" (its git toplevel is the hooks' own checkout), and every native zone path for "main" is
// keyed by a session id the Foreman only learns once the turn is running. All three of Suzy's zone
// readers honor SUZY_ZONE_FILE first, so the Foreman writes the zone (in zone.sh's format) to
// <profile>/zones/<repo>/<worktree>.zone, outside every git tree, and points the worker's
// SUZY_ZONE_FILE at it. Being outside the worktree, it can never be committed or merged.
//
// Matching follows deny-out-of-zone.sh: a shell glob against the whole repo-relative path, where
// `*` also crosses `/`, and a pattern ending in `/` owns everything beneath it.
import fs from 'node:fs';
import path from 'node:path';
import type { Foreman } from './foreman.js';
import type { Task } from './protocol.js';
import { ensureDir, writeFileAtomic } from './util/fsx.js';

export const ZONE_ENV = 'SUZY_ZONE_FILE';

/** Trim and check a zone; returns the patterns or throws with what is wrong. */
export function normalizeZone(patterns: string[]): string[] {
  const out: string[] = [];
  for (const raw of patterns) {
    let p = raw.trim().replace(/\\/g, '/');
    while (p.startsWith('./')) p = p.slice(2);
    if (!p) continue;
    if (/[\s#]/.test(p)) throw new Error(`zone pattern "${raw}" has a space or "#" (one path or glob per entry, no spaces)`);
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new Error(`zone pattern "${raw}" is absolute (use a path relative to the repository root, like "src/parser/")`);
    if (p.split('/').includes('..')) throw new Error(`zone pattern "${raw}" leaves the repository ("..")`);
    if (/^[*/]+$/.test(p)) throw new Error(`zone pattern "${raw}" owns the whole repository (name the files or directories this task changes)`);
    if (!out.includes(p)) out.push(p);
  }
  if (!out.length) throw new Error('the zone is empty (give the repo-relative paths or globs this task may change)');
  return out;
}

/** Where the Foreman keeps the zone of one worktree (outside the worktree). */
export function zoneFile(dataDir: string, repoId: string, worktreeId: string): string {
  return path.join(dataDir, 'zones', repoId, `${worktreeId}.zone`);
}

/**
 * Write a zone in zone.sh's format: `#` header lines (Session, Worktree), then one pattern per
 * line. Rewritten at every turn start, which also renews Suzy's 24h expiry (taken from the mtime).
 */
export function writeZoneFile(file: string, patterns: string[], meta: { taskId: string; agentId: string; worktree: string; session?: string }): void {
  ensureDir(path.dirname(file));
  const lines = [
    `# Suzy lane write zone, declared by the AgentCraft Foreman for task ${meta.taskId} (${meta.agentId}).`,
    `# Read through ${ZONE_ENV} by .claude/hooks/deny-out-of-zone.sh and .claude/hooks/zone-commit-gate.sh.`,
    `# Session: ${meta.session ?? 'NONE (AgentCraft sets this file per worker through SUZY_ZONE_FILE)'}`,
    `# Worktree: ${meta.worktree}`,
    `# Declared ${new Date().toISOString()}. Rewritten by the Foreman at every turn start.`,
    ...patterns,
  ];
  writeFileAtomic(file, `${lines.join('\n')}\n`);
}

/**
 * (Re)write the zone file of a task's active worktree from the task's zone. Returns the file, or
 * undefined when the task has no active worktree or no zone (then a stale file is removed, so a
 * withdrawn zone is never enforced from an old copy).
 */
export function syncTaskZone(fm: Foreman, t: Task, session?: string): string | undefined {
  const wt = t.repoId && t.worktree ? fm.repos.findWorktree(t.repoId, t.worktree) : undefined;
  if (!wt || wt.status !== 'active') return undefined;
  const file = zoneFile(fm.config.dataDir, t.repoId!, wt.id);
  if (!t.zone?.length) {
    fs.rmSync(file, { force: true });
    return undefined;
  }
  writeZoneFile(file, t.zone, { taskId: t.id, agentId: wt.agentId, worktree: wt.id, ...(session ? { session } : {}) });
  return file;
}

/** A shell glob (bash `case` semantics: `*` and `?` also match `/`) as a whole-string regex. */
function globRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '\\' && i + 1 < glob.length) re += escape(glob[++i]!);
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) {
        re += '\\[';
        continue;
      }
      let body = glob.slice(i + 1, end);
      if (body.startsWith('!') || body.startsWith('^')) body = `^${body.slice(1)}`;
      re += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else re += escape(c);
  }
  return new RegExp(`^${re}$`, 's');
}

function escape(c: string): string {
  return /[.+^${}()|[\]\\/]/.test(c) ? `\\${c}` : c;
}

/** Is this repo-relative path inside the zone? */
export function inZone(rel: string, patterns: string[]): boolean {
  const p = rel.replace(/\\/g, '/');
  return patterns.some((g) => globRegex(g).test(p) || (g.endsWith('/') && globRegex(`${g}*`).test(p)));
}

/** The paths (repo-relative) that fall outside the zone. */
export function outOfZone(paths: string[], patterns: string[]): string[] {
  return [...new Set(paths)].filter((p) => !inZone(p, patterns));
}
