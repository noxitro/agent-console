/**
 * The Installed view's arithmetic, kept out of the component for the same
 * reason `rownav.ts` is: "does a plugin's skill say which plugin it came from?"
 * and "does ↓ cross from one section into the next?" should be failing tests.
 *
 * Nothing here touches the DOM or the engine. It shapes what `ac installed`
 * reported; it does not add facts the engine did not report.
 */

import {
  SCOPE_LABEL,
  SECTION_ORDER,
  type HarnessId,
  type InstalledKind,
  type InstalledRow,
  type ReachState,
} from "./scope-contract.js";

export interface Section {
  kind: InstalledKind;
  rows: InstalledRow[];
}

/** Rows grouped into the view's sections, in section order; empty sections are left out. */
export function sections(rows: readonly InstalledRow[]): Section[] {
  return SECTION_ORDER.map((kind) => ({ kind, rows: rows.filter((r) => r.kind === kind) })).filter((s) => s.rows.length > 0);
}

/** How many rows of each kind, for the section badges and the type filter's options. */
export function kindCounts(rows: readonly InstalledRow[]): Record<InstalledKind, number> {
  const out = Object.fromEntries(SECTION_ORDER.map((k) => [k, 0])) as Record<InstalledKind, number>;
  for (const r of rows) out[r.kind]++;
  return out;
}

/** A row a plugin brought (not the plugin's own row). */
export function isPluginPart(row: InstalledRow): boolean {
  return row.kind !== "plugin" && row.plugin !== undefined;
}

/** The unit as the second line says it: 個人, プロジェクト: <name>, ローカル. */
export function unitLabel(row: InstalledRow, projectName: string | undefined): string {
  if (row.scope === "project" && projectName !== undefined) return `${SCOPE_LABEL.project}: ${projectName}`;
  return SCOPE_LABEL[row.scope];
}

/**
 * The row's second line: where it came from.
 *
 * A part names its plugin; a plugin names its marketplace; everything else
 * names its unit. A plugin or a part outside the user unit also names the
 * unit, because "Plugin: x" alone would hide that it only applies here.
 */
export function originLine(row: InstalledRow, projectName: string | undefined): string {
  let source: string | null = null;
  if (isPluginPart(row)) source = `Plugin: ${row.plugin!.name}`;
  else if (row.kind === "plugin") source = row.plugin?.marketplace !== undefined ? `Marketplace: ${row.plugin.marketplace}` : "直接導入";
  const unit = unitLabel(row, projectName);
  if (source === null) return unit;
  return row.scope === "user" ? source : `${source} · ${unit}`;
}

/** Location not established: some harness's reach is unconfirmed, by state or by certainty. */
export function isUnconfirmed(row: InstalledRow): boolean {
  return row.reach.some((r) => r.state === "unconfirmed" || r.certainty === "unconfirmed");
}

/** The strongest state per harness, the word the row shows for it. */
const RANK: readonly ReachState[] = ["enabled", "conditional", "via-import", "unknown", "unconfirmed", "disabled", "not-loaded"];
export function headlineState(row: InstalledRow, harness: HarnessId): ReachState | null {
  const states = row.reach.filter((r) => r.harness === harness).map((r) => r.state);
  if (states.length === 0) return null;
  return [...states].sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0] ?? null;
}

export interface SectionCost {
  chars: number;
  tokens: number;
  /** Rows loaded every session whose cost is not measured (MCP servers). */
  unmeasured: number;
}

/**
 * What a section carries every session for one harness — the same rule as the
 * engine's per-unit totals (`src/scope/installed.ts` `totals`): one counted
 * `enabled` reach per row, plugin parts counted on the plugin.
 */
export function sectionCost(rows: readonly InstalledRow[], harness: HarnessId): SectionCost {
  const out: SectionCost = { chars: 0, tokens: 0, unmeasured: 0 };
  for (const row of rows) {
    if (isPluginPart(row)) continue;
    const enabled = row.reach.filter((r) => r.harness === harness && r.state === "enabled");
    if (enabled.length === 0) continue;
    const counted = enabled.find((r) => r.cost !== undefined);
    if (counted?.cost === undefined) out.unmeasured++;
    else {
      out.chars += counted.cost.chars;
      out.tokens += counted.cost.tokens;
    }
  }
  return out;
}

/** Narrow by the search text (name, description, path, and where it came from). */
export function matchesQuery(row: InstalledRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [row.name, row.description ?? "", row.path, row.plugin?.id ?? "", row.plugin?.name ?? "", row.plugin?.marketplace ?? ""].some((s) =>
    s.toLowerCase().includes(q),
  );
}

/**
 * PageDown / PageUp: the first row of the next or previous section.
 *
 * `starts` are the flat indices at which each section begins (ascending,
 * starting at 0). From inside a section PageUp goes to that section's own first
 * row before it goes further back — the way a document's heading navigation
 * does. Edges clamp. `null` when the key is not ours.
 */
export function nextSectionStart(key: string, index: number, starts: readonly number[]): number | null {
  if (starts.length === 0) return null;
  const from = Math.max(index, 0);
  if (key === "PageDown") {
    const next = starts.find((s) => s > from);
    return next ?? starts[starts.length - 1]!;
  }
  if (key === "PageUp") {
    const prev = [...starts].reverse().find((s) => s < from);
    return prev ?? 0;
  }
  return null;
}

/** Flat indices where each section starts, for `nextSectionStart`. */
export function sectionStarts(list: readonly Section[]): number[] {
  const out: number[] = [];
  let i = 0;
  for (const s of list) {
    out.push(i);
    i += s.rows.length;
  }
  return out;
}
