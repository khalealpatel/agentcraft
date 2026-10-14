// Types for tools/mirror/tail.mjs (the Foreman's mirror backend reads its log through it).
export interface Cursor {
  /** inode of the file the offset belongs to */
  ino: number;
  /** bytes of that file already read (always just after a newline) */
  offset: number;
}
export declare function readLines(dir: string, cursor: Cursor | undefined): { lines: string[]; cursor: Cursor | undefined };
