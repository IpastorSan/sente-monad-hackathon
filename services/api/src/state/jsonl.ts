// Read a JSONL file line by line without holding it as one string (SEN-205).
//
// The file stores read their logs whole with `readFileSync(path, 'utf8')`,
// which is fine at boot sizes but has a hard ceiling (V8 strings stop at
// ~512 MiB) and doubles the memory a large log costs. The SQLite import walks
// the same files with this instead: fixed-size chunks, decoded across chunk
// boundaries, one line at a time. Read-only: it never repairs or rewrites.
//
// Erasable syntax only (CLAUDE.md gotcha 10).

import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface JsonlLine {
  /** The line, without its `\n`. */
  readonly text: string;
  /** 1-based. */
  readonly lineNo: number;
  /** No more lines follow (a last line with or without its newline). */
  readonly isLast: boolean;
}

const CHUNK = 1 << 20;

/** Every line of `path` in order, empty ones included, the trailing empty "line" after a final `\n` excluded. */
export function* readJsonlLines(path: string): Generator<JsonlLine> {
  const fd = openSync(path, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(CHUNK);
    let pending = '';
    let lineNo = 0;
    let held: string | undefined;
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK, null);
      pending += read > 0 ? decoder.write(buffer.subarray(0, read)) : decoder.end();
      let start = 0;
      for (let newline = pending.indexOf('\n'); newline !== -1;) {
        // A line is yielded only once the next one is known to exist, so `isLast` is exact.
        if (held !== undefined) yield { text: held, lineNo: ++lineNo, isLast: false };
        held = pending.slice(start, newline);
        start = newline + 1;
        newline = pending.indexOf('\n', start);
      }
      pending = pending.slice(start);
      if (read === 0) break;
    }
    if (held !== undefined) yield { text: held, lineNo: ++lineNo, isLast: pending === '' };
    if (pending !== '') yield { text: pending, lineNo: ++lineNo, isLast: true };
  } finally {
    closeSync(fd);
  }
}
