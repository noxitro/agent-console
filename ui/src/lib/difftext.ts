/**
 * A line diff for the confirmation dialog (SPEC §9.6).
 *
 * The bar this exists to clear is GitHub Desktop / Docker Desktop: before
 * committing a write to another tool's live configuration, the owner sees *what
 * changes*, not only *which files change*. Naming `~/.claude.json` tells you
 * nothing about whether a server is being added or your `env` block rewritten.
 *
 * Deliberately small: a standard LCS over whole lines, with unchanged runs
 * collapsed to a context window. No word-level highlighting, no syntax
 * awareness — this renders a config file's changes, and the extra precision
 * would cost more than it tells. The engine caps the payload at 256 KiB
 * (`PREVIEW_MAX_BYTES`), so the quadratic worst case is bounded by that rather
 * than by hope; `MAX_LINES` bounds it again for the pathological one-long-line
 * case.
 */

export type DiffKind = "same" | "add" | "remove" | "gap";

export interface DiffLine {
  kind: DiffKind;
  /** Line number in the old text, when the line exists there. */
  before?: number;
  /** Line number in the new text, when the line exists there. */
  after?: number;
  text: string;
}

/** Unchanged lines kept on each side of a change. */
const CONTEXT = 3;

/**
 * Above this many lines per side the LCS table is not worth building; the
 * preview degrades to "these files differ" rather than freezing the window.
 */
export const MAX_LINES = 4000;

function split(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  // A trailing newline yields a final empty element that is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The full line diff, uncollapsed. `before`/`after` may each be `undefined`,
 * which is how a create (no before) and a delete (no after) are expressed.
 */
export function diffLines(before: string | undefined, after: string | undefined): DiffLine[] {
  const a = before === undefined ? [] : split(before);
  const b = after === undefined ? [] : split(after);

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      {
        kind: "gap",
        text: `${a.length} 行 → ${b.length} 行(大きすぎるため差分表示は省略)`,
      },
    ];
  }

  // Classic LCS length table. Rows are the old text, columns the new.
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = table[i] as number[];
      const next = table[i + 1] as number[];
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", before: i + 1, after: j + 1, text: a[i] as string });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      out.push({ kind: "remove", before: i + 1, text: a[i] as string });
      i += 1;
    } else {
      out.push({ kind: "add", after: j + 1, text: b[j] as string });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ kind: "remove", before: i + 1, text: a[i] as string });
    i += 1;
  }
  while (j < b.length) {
    out.push({ kind: "add", after: j + 1, text: b[j] as string });
    j += 1;
  }
  return out;
}

/**
 * The diff with long unchanged runs replaced by a single `gap` line.
 *
 * `~/.claude.json` is thousands of lines of state this tool does not manage
 * (SPEC §6.1); showing all of it would bury the three lines that change.
 */
export function collapseDiff(lines: readonly DiffLine[], context = CONTEXT): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < lines.length) keep[k] = true;
    }
  });

  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index] === true) {
      if (skipped > 0) {
        out.push({ kind: "gap", text: `⋯ ${skipped} 行省略` });
        skipped = 0;
      }
      out.push(line);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) out.push({ kind: "gap", text: `⋯ ${skipped} 行省略` });
  return out;
}

export interface DiffStat {
  added: number;
  removed: number;
}

export function diffStat(lines: readonly DiffLine[]): DiffStat {
  return {
    added: lines.filter((l) => l.kind === "add").length,
    removed: lines.filter((l) => l.kind === "remove").length,
  };
}

/**
 * The collapsed diff **and** its counts, from one pass.
 *
 * The preview needs both, and computing them from two separate `diffLines`
 * calls built the whole LCS table twice. At the engine's own ceilings — 4000
 * lines a side (`MAX_LINES`) inside a 256 KiB payload (`PREVIEW_MAX_BYTES`) —
 * that is two 16-million-cell tables per action, allocated synchronously on the
 * UI thread, for every action in the confirmation dialog at once. Exactly half
 * of it was waste: the two consumers want different views of the same diff, not
 * two diffs.
 *
 * The counts come from the **uncollapsed** diff, so the `+n −n` summary counts
 * changed lines rather than the ones that survived collapsing.
 */
export function diffSummary(
  before: string | undefined,
  after: string | undefined,
  context = CONTEXT,
): { lines: DiffLine[]; stat: DiffStat } {
  const lines = diffLines(before, after);
  return { lines: collapseDiff(lines, context), stat: diffStat(lines) };
}
