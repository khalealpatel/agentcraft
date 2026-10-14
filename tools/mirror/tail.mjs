// The mirror event log, read from a cursor: every complete line after it, across rotations.
// One implementation for everything that follows the log (the Foreman's mirror backend and
// `suzy.mjs notify`). The cursor names a file by inode, so a rotation (a rename) keeps it valid; a
// file rotated away entirely means everything left is newer. Read only: it never writes.
import fs from 'node:fs';
import path from 'node:path';
import { EVENTS_FILE } from './lib.mjs';

/**
 * Complete lines after `cursor` (all of them when there is none), oldest first, and the cursor after
 * them. Files are opened newest first and de-duplicated by inode, so a rotation between two opens
 * never skips a file. A half-written last line is left for the next read.
 *
 * @param {string} dir the mirror directory
 * @param {{ino: number, offset: number} | undefined} cursor
 * @returns {{ lines: string[], cursor: {ino: number, offset: number} | undefined }}
 */
export function readLines(dir, cursor) {
  const opened = [];
  try {
    for (const name of [EVENTS_FILE, `${EVENTS_FILE}.1`, `${EVENTS_FILE}.2`]) {
      let fd;
      try {
        fd = fs.openSync(path.join(dir, name), 'r');
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
      offset = cursor.offset <= files[at].size ? cursor.offset : 0;
    }
    const lines = [];
    let next = cursor;
    for (let i = start; i < files.length; i++) {
      const f = files[i];
      const from = i === start ? offset : 0;
      const len = f.size - from;
      let used = 0;
      if (len > 0) {
        const buf = Buffer.alloc(len);
        fs.readSync(f.fd, buf, 0, len, from);
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
