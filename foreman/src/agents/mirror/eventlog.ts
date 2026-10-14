// The mirror hook's event log (<home>/mirror/events.jsonl, rotated to .1 and .2): read every
// complete line after a saved cursor, across rotations. The reading itself is shared with
// `suzy.mjs notify` (tools/mirror/tail.mjs); this file parses what it returns.
import path from 'node:path';
import { z } from 'zod';
import { EVENTS_FILE, HOOK_EVENTS } from '../../../../tools/mirror/lib.mjs';
import { readLines } from '../../../../tools/mirror/tail.mjs';
import type { Cursor } from '../../../../tools/mirror/tail.mjs';

export type { Cursor };

const Str = z.string().max(400);
export const MirrorEvent = z.object({
  v: z.literal(1),
  ts: z.number().int().nonnegative(),
  sid: z.string().regex(/^[0-9a-z_-]{4,64}$/i),
  event: z.string().refine((e) => HOOK_EVENTS.includes(e)),
  repo: Str,
  branch: Str,
  tool: Str.optional(),
  file: Str.optional(),
  cmd: Str.optional(),
  ok: z.boolean().optional(),
  exit: z.number().int().optional(),
  interrupted: z.boolean().optional(),
  lane: Str.optional(),
  first: z.boolean().optional(),
  model: Str.optional(),
  source: Str.optional(),
  kind: Str.optional(),
  reason: Str.optional(),
});
export type MirrorEvent = z.infer<typeof MirrorEvent>;

export function parseEvent(line: string): MirrorEvent | undefined {
  try {
    const r = MirrorEvent.safeParse(JSON.parse(line));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

export class EventLog {
  readonly file: string;

  constructor(readonly dir: string) {
    this.file = path.join(dir, EVENTS_FILE);
  }

  /** Complete lines after `cursor`, oldest first, and the cursor after them (tools/mirror/tail.mjs). */
  read(cursor: Cursor | undefined): { lines: string[]; cursor: Cursor | undefined } {
    return readLines(this.dir, cursor);
  }
}
