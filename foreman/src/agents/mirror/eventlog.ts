// The mirror hook's event log (<home>/mirror/events.jsonl, rotated to .1 and .2): read every
// complete line after a saved cursor, across rotations. The cursor names a file by inode, so a
// rotation (a rename) keeps it valid; a file rotated away entirely means everything left is newer.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { EVENTS_FILE, HOOK_EVENTS } from '../../../../tools/mirror/lib.mjs';

export interface Cursor {
  /** inode of the file the offset belongs to */
  ino: number;
  /** bytes of that file already applied (always just after a newline) */
  offset: number;
}

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

interface Open {
  fd: number;
  ino: number;
  size: number;
}

export class EventLog {
  readonly file: string;

  constructor(readonly dir: string) {
    this.file = path.join(dir, EVENTS_FILE);
  }

  /**
   * Complete lines after `cursor`, oldest first, and the cursor after them. Files are opened newest
   * first and de-duplicated by inode, so a rotation between two opens never skips a file.
   */
  read(cursor: Cursor | undefined): { lines: string[]; cursor: Cursor | undefined } {
    const opened: Open[] = [];
    try {
      for (const name of [EVENTS_FILE, `${EVENTS_FILE}.1`, `${EVENTS_FILE}.2`]) {
        let fd: number;
        try {
          fd = fs.openSync(path.join(this.dir, name), 'r');
        } catch {
          continue;
        }
        const st = fs.fstatSync(fd);
        if (opened.some((o) => o.ino === st.ino)) {
          fs.closeSync(fd);
          continue;
        }
        opened.push({ fd, ino: st.ino, size: st.size });
      }
      const files = opened.reverse(); // oldest first
      if (!files.length) return { lines: [], cursor };
      let start = 0;
      let offset = 0;
      const at = cursor ? files.findIndex((f) => f.ino === cursor.ino) : -1;
      if (at >= 0) {
        start = at;
        offset = cursor!.offset <= files[at]!.size ? cursor!.offset : 0;
      }
      const lines: string[] = [];
      let next: Cursor | undefined = cursor;
      for (let i = start; i < files.length; i++) {
        const f = files[i]!;
        const from = i === start ? offset : 0;
        const len = f.size - from;
        let used = 0;
        if (len > 0) {
          const buf = Buffer.alloc(len);
          fs.readSync(f.fd, buf, 0, len, from);
          // only complete lines: a half-written last line is read on the next poll
          const end = buf.lastIndexOf(0x0a);
          if (end >= 0) {
            used = end + 1;
            for (const l of buf.subarray(0, used).toString('utf8').split('\n')) if (l.trim()) lines.push(l);
          }
        }
        next = { ino: f.ino, offset: from + used };
      }
      return { lines, cursor: next };
    } finally {
      for (const o of opened) fs.closeSync(o.fd);
    }
  }
}
