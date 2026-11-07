/**
 * The console's table, derived — and nothing else.
 *
 * Every function here is pure: inventory + doctor + plan in, rows out. That is
 * what keeps Product Principle 2 ("CLI と GUI は同じ真実") true in a component
 * tree: the interface may *arrange* the engine's answers, never compute a
 * different one. The one rule this module enforces above all others is SPEC
 * §9.4's last line — when there is no plan, a per-target state cannot be
 * decided, so it is reported as `unknown` ("PLAN 未取得") rather than as 整合.
 * A missing measurement and a measurement of zero are different things.
 */

import {
  isUnsupported,
  type AssetType,
  type Doctor,
  type Finding,
  type Inventory,
  type InventoryTarget,
  type Plan,
  type PlanAction,
  type SourceAgent,
  type SourceCommand,
  type SourceMcp,
  type SourceSkill,
  type TargetId,
} from "./contract.js";

/* ------------------------------------------------------------------ */
/* Delivery state (SPEC §9.4)                                          */
/* ------------------------------------------------------------------ */

/**
 * How one asset stands with one target.
 *
 * `unknown` is the value that exists because the alternative is a lie: without
 * a plan, 「差分あり」 cannot be ruled out, so 「整合」 cannot be asserted.
 */
export type DeliveryState = "unsupported" | "pending" | "match" | "off" | "absent" | "unknown";

export const DELIVERY_LABEL: Record<DeliveryState, string> = {
  unsupported: "非対応",
  pending: "差分あり",
  match: "適用済み(整合)",
  off: "適用済み(ターゲット側で無効)",
  absent: "未配布",
  unknown: "PLAN 未取得",
};

/** The badge glyph each state carries, per the surface brief. */
export const DELIVERY_MARK: Record<DeliveryState, string> = {
  unsupported: "✕",
  pending: "!",
  match: "✓",
  // The same 有効●/無効○ vocabulary the row's own switch uses (surface brief),
  // so 「届いてはいるが動かない」 reads as off rather than as a second fault.
  off: "○",
  absent: "—",
  unknown: "?",
};

export interface Delivery {
  target: TargetId;
  state: DeliveryState;
  /** The plan action that made this `pending`, when there is one. */
  action?: PlanAction;
  /** Where the asset would live in this target; absent when unsupported. */
  path?: string;
  /** Set when the target reads another target's directories (SPEC §4). */
  sharesDiscoveryWith?: TargetId;
  /**
   * SPEC §10.4 — the adapter's own explanation of an `unsupported` verdict.
   *
   * Absent when the engine offered none; the interface then shows 「非対応」
   * alone rather than inventing a rationale for it.
   */
  reason?: string;
  /**
   * SPEC §10.2 — this target's own file for the asset exists and cannot be
   * parsed (the engine's message, path included).
   *
   * A fact about the *target's* copy, which is why it hangs off the delivery
   * and not off the row: the source of truth may be perfectly well-formed while
   * the file opencode actually reads is not. It is not a delivery *state* — the
   * five states answer 「届いているか」 and this answers 「読めるか」 — so it
   * travels beside the state and marks the row 不良 (`AssetRow.hasFault`).
   */
  unreadable?: string;
}

/** Does this target hold the named asset right now? */
function targetHolds(target: InventoryTarget, type: AssetType, name: string): boolean {
  switch (type) {
    case "skill": {
      if (isUnsupported(target.skills)) return false;
      return target.skills.some((s) => s.name === name);
    }
    case "mcp": {
      if (isUnsupported(target.mcp)) return false;
      return target.mcp.some((m) => m.name === name);
    }
    case "agent": {
      if (isUnsupported(target.agents)) return false;
      return target.agents.some((a) => a.name === name);
    }
    case "command": {
      if (isUnsupported(target.commands)) return false;
      return target.commands.some((c) => c.name === name);
    }
  }
}

/**
 * Has the target itself switched this asset off?
 *
 * opencode records a per-server `"enabled": false`, and this tool deliberately
 * never flips it back (SPEC §10.3): the switch belongs to whoever set it. So a
 * server can be *delivered* and still never start — a state SPEC §9.4's table
 * has no row for, because before v3 no target had such a switch. Folding it
 * into 「適用済み(整合)」 made the console assert a delivery that does not
 * happen, which is PRODUCT's 追跡 job reporting something untrue.
 *
 * Only MCP has one today. The engine decides it (`Adapter.mcpDisabledNames`);
 * this reads the answer off the wire (Product Principle 2).
 */
function targetSwitchedOff(target: InventoryTarget, type: AssetType, name: string): boolean {
  if (type !== "mcp" || isUnsupported(target.mcp)) return false;
  return target.mcp.some((m) => m.name === name && m.enabled === false);
}

/**
 * The engine's reason for not being able to read this target's own copy, if any.
 *
 * Two kinds reach this, for two different reasons, and both are the engine's
 * finding rather than a decision made here (PRODUCT Principle 2):
 *
 *  - **command** (SPEC §10.2): the file is there and its frontmatter will not
 *    parse.
 *  - **skill** (SPEC §9.7): `lstat` was refused, so what occupies the slot is
 *    unknown. This one used to arrive as `kind: "missing"` and be drawn 未配布 —
 *    the console asserting an absence nobody had been allowed to measure.
 */
function targetUnreadable(
  target: InventoryTarget,
  type: AssetType,
  name: string,
): string | undefined {
  if (type === "command") {
    if (isUnsupported(target.commands)) return undefined;
    return target.commands.find((c) => c.name === name)?.unreadable;
  }
  if (type === "skill") {
    if (isUnsupported(target.skills)) return undefined;
    return target.skills.find((s) => s.name === name)?.unreadable;
  }
  return undefined;
}

function targetSupports(target: InventoryTarget, type: AssetType): boolean {
  switch (type) {
    case "skill":
      return !isUnsupported(target.skills);
    case "mcp":
      return !isUnsupported(target.mcp);
    case "agent":
      return !isUnsupported(target.agents);
    case "command":
      return !isUnsupported(target.commands);
  }
}

function targetPath(target: InventoryTarget, type: AssetType): string | undefined {
  const value =
    type === "skill"
      ? target.skillsDir
      : type === "mcp"
        ? target.mcpPath
        : type === "agent"
          ? target.agentsDir
          : target.commandsDir;
  return isUnsupported(value) ? undefined : value;
}

/** The engine's stated reason for this target refusing this asset kind. */
function unsupportedReason(target: InventoryTarget, type: AssetType): string | undefined {
  return target.unsupportedReasons?.find((r) => r.assetType === type)?.reason;
}

/**
 * SPEC §9.4's derivation table, in order. The order is the specification: an
 * unsupported target is unsupported whatever the plan says, and a planned
 * action outranks "it is already there".
 */
export function deliveryFor(
  target: InventoryTarget,
  type: AssetType,
  name: string,
  plan: Plan | null,
): Delivery {
  const unreadable = targetUnreadable(target, type, name);
  const base = {
    target: target.id,
    ...(targetPath(target, type) !== undefined ? { path: targetPath(target, type) as string } : {}),
    ...(target.sharesDiscoveryWith !== undefined
      ? { sharesDiscoveryWith: target.sharesDiscoveryWith }
      : {}),
    // Independent of the state below: a file can be delivered *and* unreadable,
    // and the state alone would report only the first half.
    ...(unreadable !== undefined ? { unreadable } : {}),
  };

  if (!targetSupports(target, type)) {
    const reason = unsupportedReason(target, type);
    return { ...base, state: "unsupported", ...(reason !== undefined ? { reason } : {}) };
  }

  if (plan === null) {
    // The whole point of this branch: no plan means no verdict. Falling through
    // to "match" here would draw 「0 件 — 一致」 over three undelivered servers.
    return { ...base, state: "unknown" };
  }

  const action = plan.actions.find(
    (a) =>
      a.target === target.id &&
      a.assetType === type &&
      // SPEC §9.4 matches on `(target, assetType, asset)`. An MCP action names
      // no asset because a server is a key inside one shared config file
      // (SPEC §4), and a pending write to that file is a pending write to every
      // server it carries — so a nameless action covers them all. Without this,
      // three servers about to be written would each read 「未配布」 while the
      // plan plainly says otherwise.
      (a.asset === name || (a.asset === "" && type === "mcp")) &&
      a.kind !== "preserve" &&
      a.kind !== "unsupported",
  );
  if (action !== undefined) return { ...base, state: "pending", action };

  if (!targetHolds(target, type, name)) return { ...base, state: "absent" };
  return { ...base, state: targetSwitchedOff(target, type, name) ? "off" : "match" };
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

/** One line of the asset table, whatever its kind. */
export interface AssetRow {
  type: AssetType;
  name: string;
  /** Present for skills and agents; MCP servers have no description. */
  description?: string;
  version?: string;
  enabled: boolean;
  modified?: string;
  /**
   * The second column's value for every kind but `skill`: transport for MCP,
   * model for an agent, the owning agent for a command. Absent means absent —
   * the column draws 「—」 rather than a default (PRODUCT: 捏造しない).
   */
  kindNote?: string;
  origin?: { source: string; sourceUrl?: string };
  /** Explicit target selector from the source, when the asset declares one. */
  declaredTargets?: TargetId[];
  /** Per-target state, one entry per target in the inventory. */
  deliveries: Delivery[];
  /** doctor findings naming this asset. */
  findings: Finding[];
  /** True when any delivery is `pending`. */
  hasPending: boolean;
  /**
   * True when any finding is an error, a `drift` action names this asset, or a
   * target's own copy of it cannot be parsed (SPEC §10.2). All three are 障害,
   * and the 「不良のみ」 filter is how the owner finds them.
   */
  hasFault: boolean;
  /** Set for a skill whose `SKILL.md` is missing — a real, showable defect. */
  missingManifest?: boolean;
}

function findingsFor(doctor: Doctor | null, name: string): Finding[] {
  if (doctor === null) return [];
  return doctor.findings.filter((f) => f.asset === name);
}

function buildRow(
  type: AssetType,
  name: string,
  enabled: boolean,
  inventory: Inventory,
  doctor: Doctor | null,
  plan: Plan | null,
  extra: Partial<AssetRow>,
): AssetRow {
  const deliveries = inventory.targets.map((t) => deliveryFor(t, type, name, plan));
  const findings = findingsFor(doctor, name);
  const hasPending = deliveries.some((d) => d.state === "pending");
  const hasFault =
    findings.some((f) => f.level === "error") ||
    deliveries.some((d) => d.action?.kind === "drift") ||
    // SPEC §10.2: doctor's `command.unreadable` names a target and a path but
    // no asset, so `findingsFor` cannot attach it to this row. Without this the
    // row read 「差分あり」 and nothing else about a file the target cannot use.
    deliveries.some((d) => d.unreadable !== undefined);
  return { type, name, enabled, deliveries, findings, hasPending, hasFault, ...extra };
}

export function skillRows(
  inventory: Inventory,
  doctor: Doctor | null,
  plan: Plan | null,
): AssetRow[] {
  return inventory.source.skills.map((skill: SourceSkill) =>
    buildRow("skill", skill.name, skill.enabled, inventory, doctor, plan, {
      ...(skill.description !== undefined ? { description: skill.description } : {}),
      ...(skill.version !== undefined ? { version: skill.version } : {}),
      ...(skill.modified !== undefined ? { modified: skill.modified } : {}),
      ...(skill.origin !== undefined ? { origin: skill.origin } : {}),
      ...(skill.hasSkillMd ? {} : { missingManifest: true }),
    }),
  );
}

export function mcpRows(
  inventory: Inventory,
  doctor: Doctor | null,
  plan: Plan | null,
): AssetRow[] {
  return inventory.source.mcp.map((server: SourceMcp) =>
    buildRow("mcp", server.name, server.enabled, inventory, doctor, plan, {
      kindNote: server.transport,
      ...(server.endpoint !== undefined ? { description: server.endpoint } : {}),
      ...(server.modified !== undefined ? { modified: server.modified } : {}),
      ...(server.targets !== undefined ? { declaredTargets: server.targets } : {}),
    }),
  );
}

export function agentRows(
  inventory: Inventory,
  doctor: Doctor | null,
  plan: Plan | null,
): AssetRow[] {
  return inventory.source.agents.map((agent: SourceAgent) =>
    buildRow("agent", agent.name, agent.enabled, inventory, doctor, plan, {
      description: agent.description,
      ...(agent.model !== undefined ? { kindNote: agent.model } : {}),
      ...(agent.modified !== undefined ? { modified: agent.modified } : {}),
      ...(agent.targets !== undefined ? { declaredTargets: agent.targets } : {}),
    }),
  );
}

/**
 * SPEC §10.2 — commands, whose one distinguishing fact is the agent that runs
 * them. It goes in `kindNote` because that is what the list's second column
 * reads, exactly as `transport` does for a server.
 */
export function commandRows(
  inventory: Inventory,
  doctor: Doctor | null,
  plan: Plan | null,
): AssetRow[] {
  return inventory.source.commands.map((command: SourceCommand) =>
    buildRow("command", command.name, command.enabled, inventory, doctor, plan, {
      description: command.description,
      ...(command.agent !== undefined ? { kindNote: command.agent } : {}),
      ...(command.modified !== undefined ? { modified: command.modified } : {}),
      ...(command.targets !== undefined ? { declaredTargets: command.targets } : {}),
    }),
  );
}

export function rowsFor(
  type: AssetType,
  inventory: Inventory,
  doctor: Doctor | null,
  plan: Plan | null,
): AssetRow[] {
  switch (type) {
    case "skill":
      return skillRows(inventory, doctor, plan);
    case "mcp":
      return mcpRows(inventory, doctor, plan);
    case "agent":
      return agentRows(inventory, doctor, plan);
    case "command":
      return commandRows(inventory, doctor, plan);
  }
}

/* ------------------------------------------------------------------ */
/* Search and filter                                                   */
/* ------------------------------------------------------------------ */

/**
 * The filter vocabulary, kept to the four questions this tool is actually
 * asked. Anything richer would be a query language nobody needs on a list of a
 * dozen rows; anything less puts the owner back to visually scanning for the
 * one broken thing, which is what demoted the previous interface.
 */
export type RowFilter = "all" | "fault" | "pending" | "disabled";

export const FILTER_LABEL: Record<RowFilter, string> = {
  all: "すべて",
  fault: "不良のみ",
  pending: "差分ありのみ",
  disabled: "無効のみ",
};

/**
 * SPEC §10.6 — the target narrowing that sits beside the state filter.
 *
 * `all` is a real member rather than `null`: the control is a segmented radio
 * group, and "no narrowing" has to be a position in it that can be selected,
 * announced and returned to.
 */
export type TargetFilter = "all" | TargetId;

export const TARGET_FILTERS: readonly TargetFilter[] = [
  "all",
  "claude",
  "opencode",
  "copilot-cli",
  "vscode",
  "vs2026",
] as const;

export const TARGET_FILTER_LABEL: Record<TargetFilter, string> = {
  all: "すべて",
  claude: "claude",
  opencode: "opencode",
  "copilot-cli": "copilot-cli",
  vscode: "vscode",
  vs2026: "vs2026",
};

/**
 * Is this asset **anything to do with** the given target?
 *
 * Two facts decide it, both of them the engine's:
 *
 *  1. the target can carry this asset kind at all — a `command` row is nothing
 *     to do with claude, and no plan is needed to know that (SPEC §10.2);
 *  2. the asset's own target selector, when it declares one, names this target
 *     (SPEC §3) — a server marked `targets: [claude]` is nothing to do with
 *     opencode however capable opencode is.
 *
 * Everything else stays: 未配布 is a relationship with a target, and hiding it
 * would turn the narrowing into "what is already delivered", which is the one
 * question the state filter already answers.
 */
export function relatesToTarget(row: AssetRow, target: TargetFilter): boolean {
  if (target === "all") return true;
  if (row.declaredTargets !== undefined && !row.declaredTargets.includes(target)) return false;
  const delivery = row.deliveries.find((d) => d.target === target);
  if (delivery === undefined) return false;
  return delivery.state !== "unsupported";
}

/**
 * How much of a write the narrowed list is not showing.
 *
 * SPEC §10.6 keeps the narrowing off `plan` and `apply`, so a confirmation
 * raised while it is active promises more than the list behind it displays.
 * 表示 = 実行 survives that only if the dialog says so with a number the owner
 * can check, and this is the number: actions `apply` will carry out that are
 * aimed somewhere the list is currently hiding.
 */
export function actionsOutsideTarget(
  actions: readonly PlanAction[],
  target: TargetFilter,
): number {
  if (target === "all") return 0;
  return actions.filter((a) => a.target !== target).length;
}

/**
 * Every narrowing the list is under, named — the caveat's raw material.
 *
 * `actionsOutsideTarget` above answers one question (how much of the write is
 * aimed outside the target narrowing); this answers the prior one: *what is the
 * list narrowed by at all*. The tab is always in the answer, because the table
 * always shows exactly one asset kind — which is why a confirmation that
 * counted only the target narrowing could report zero and then assert that
 * everything it was about to do was visible below, on a plan that also touched
 * an MCP file and an agent the tab was not showing.
 */
export function describeNarrowings(
  tab: AssetType,
  target: TargetFilter,
  filter: RowFilter,
  query: string,
): string[] {
  return [
    `種別: ${ASSET_TABS.find((t) => t.type === tab)?.label ?? tab}`,
    ...(target !== "all" ? [`ターゲット: ${TARGET_FILTER_LABEL[target]}`] : []),
    ...(filter !== "all" ? [`表示: ${FILTER_LABEL[filter]}`] : []),
    ...(query.trim() !== "" ? [`検索: 「${query.trim()}」`] : []),
  ];
}

/** Case-insensitive substring match over the fields a person would search by. */
function matchesQuery(row: AssetRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const haystack = [row.name, row.description ?? "", row.kindNote ?? "", row.version ?? ""]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

function matchesFilter(row: AssetRow, filter: RowFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "fault":
      return row.hasFault || row.missingManifest === true;
    case "pending":
      return row.hasPending;
    case "disabled":
      return !row.enabled;
  }
}

/**
 * The three narrowings, applied together.
 *
 * SPEC §10.6: all three are **display only**. `plan` and `apply` work from the
 * engine's own view of the machine and never from this list, which is why the
 * confirmation dialog has to say so out loud when a narrowing is active.
 */
export function filterRows(
  rows: readonly AssetRow[],
  query: string,
  filter: RowFilter,
  target: TargetFilter = "all",
): AssetRow[] {
  return rows.filter(
    (row) => matchesFilter(row, filter) && relatesToTarget(row, target) && matchesQuery(row, query),
  );
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/**
 * A date the owner can read, or the em dash.
 *
 * The dash is not a placeholder for a value we failed to fetch — it is the
 * honest rendering of "this asset has no such fact" (PRODUCT: 捏造しない).
 */
export function formatDate(iso: string | undefined): string {
  if (iso === undefined) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* Why the list is empty                                               */
/* ------------------------------------------------------------------ */

/**
 * The four states a read can be in. `Session.Status` is an alias of this: the
 * predicate below needs it, and a pure helper module should not have to import
 * from the stateful one to say what it takes.
 */
export type ReadState = "idle" | "running" | "ready" | "failed";

/**
 * Why the table has no rows — as a decision, not a sentence.
 *
 * Four of these are not emptiness at all, and telling them apart is the whole
 * job: 「まだ無い」, 「絞り込みで消えた」, 「まだ測っていない」 and 「測ろうとして
 * 失敗した」 have four different next actions, and printing 「ありません」 for
 * the last two is the 存在しない値を描く that DESIGN forbids.
 *
 * It lives here rather than in the component because it depends on behaviour
 * that lives elsewhere — `survey()` keeps the old inventory during a re-survey
 * and discards it on failure, which is why `total === 0` is part of the
 * unmeasured test — and a component cannot hold that invariant down. As a pure
 * function it can, in a test.
 */
export type EmptyReason =
  /** A read is running and there is nothing yet to be empty. */
  | { kind: "surveying" }
  /** A read failed. The list is not empty, it is unread. */
  | { kind: "survey-failed" }
  /** Nothing has been read yet. */
  | { kind: "unsurveyed" }
  /** 「差分ありのみ」 with the plan it needs already being taken. */
  | { kind: "plan-running" }
  /** 「差分ありのみ」 with no plan: every state is `unknown` (SPEC §9.4). */
  | { kind: "needs-plan" }
  /** Read, measured, and this kind genuinely has no assets. */
  | { kind: "none-of-kind" }
  /** The target narrowing alone emptied it, and dropping it brings back N. */
  | { kind: "target-narrowed"; target: TargetFilter; restored: number }
  /** Search or the state filter emptied it. */
  | { kind: "narrowed" };

export function emptyReason(input: {
  surveyStatus: ReadState;
  diffStatus: ReadState;
  /** Rows before search and filter. */
  total: number;
  /** Rows the search and state filter alone would leave. */
  totalIgnoringTarget: number;
  filter: RowFilter;
  targetFilter: TargetFilter;
  hasPlan: boolean;
}): EmptyReason {
  const { surveyStatus, diffStatus, total, totalIgnoringTarget } = input;

  // `total === 0` is part of the test, not an optimisation. A *re-survey* runs
  // against an inventory that is still on screen (`survey()` only clears it on
  // failure), so a list emptied by the search box would otherwise claim to be
  // unmeasured while the counter beside it read 「0 / 12 件」. On the paths where
  // nothing has been read, `total` is 0 anyway.
  if (surveyStatus !== "ready" && total === 0) {
    if (surveyStatus === "running") return { kind: "surveying" };
    if (surveyStatus === "failed") return { kind: "survey-failed" };
    return { kind: "unsurveyed" };
  }

  if (total > 0 && input.filter === "pending" && !input.hasPlan) {
    return diffStatus === "running" ? { kind: "plan-running" } : { kind: "needs-plan" };
  }

  if (total === 0) return { kind: "none-of-kind" };

  if (input.targetFilter !== "all" && totalIgnoringTarget > 0) {
    return { kind: "target-narrowed", target: input.targetFilter, restored: totalIgnoringTarget };
  }

  return { kind: "narrowed" };
}

/** The sentence for a reason. Split from the decision so both can be tested. */
export function emptyMessage(reason: EmptyReason): string {
  switch (reason.kind) {
    case "surveying":
      return "走査中 — 実環境を読み取っています。";
    case "survey-failed":
      return "実環境を読み取れませんでした。この一覧は空ではなく、未取得です。上の障害の内容を確認してから再走査してください。";
    case "unsurveyed":
      return "まだ走査していません。「再走査」で実環境を読み取ります。";
    case "plan-running":
      return "差分を取得中です — 判定できしだいこの一覧に出ます。";
    case "needs-plan":
      return "PLAN 未取得 — 差分の有無はまだ判定できません。";
    case "none-of-kind":
      return "この種別の資産はまだありません。";
    case "target-narrowed":
      return `${TARGET_FILTER_LABEL[reason.target]} に関係する資産はありません(ターゲット絞り込みを「すべて」に戻すと ${reason.restored} 件が出ます)。`;
    case "narrowed":
      return "条件に一致する資産はありません(検索語かフィルタを変えてください)。";
  }
}

/**
 * Reasons that are not a measured zero — drawn 破線 (DESIGN: Shapes), and
 * counted as 「—」 rather than 「0 件」.
 */
export function isUnmeasured(reason: EmptyReason): boolean {
  return (
    reason.kind === "surveying" ||
    reason.kind === "survey-failed" ||
    reason.kind === "unsurveyed"
  );
}

/**
 * Where a write's backup will land, spelled the way the source root is spelled.
 *
 * The dialogs used to compose this literally as `` `${sourceRoot}\backups\…` ``,
 * which printed 「~/.agents-manager\backups\&lt;timestamp&gt;\」 — a path with two
 * different separators in it, issued by the interface rather than reported by
 * the engine, on the screen that asks for permission to write. The engine's own
 * `backupDir` only exists *after* the write, so what the dialog can honestly
 * show beforehand is the pattern; this at least makes it a pattern the machine
 * would recognise.
 */
export function backupsPath(sourceRoot: string): string {
  const sep = sourceRoot.includes("\\") ? "\\" : "/";
  // Trim *either* separator, not just the chosen one: a root that mixes them
  // (`C:\home\me\x/`) would otherwise be joined as `…x/\backups\`, which is
  // the doubled-separator version of the defect this function exists to fix.
  const root = sourceRoot.replace(/[\\/]+$/, "");
  return `${root}${sep}backups${sep}<timestamp>${sep}`;
}

/**
 * Tab labels, in the order the brief fixes them.
 *
 * SPEC §10.6: the axis stays **asset kind**, not agent. Tabbing by agent would
 * make 「1資産がどこへ届いているか」 — PRODUCT's second job — a round trip
 * through four tabs. Per-agent narrowing is the toolbar's job instead.
 */
export const ASSET_TABS: readonly { type: AssetType; label: string }[] = [
  { type: "skill", label: "SKILLS" },
  { type: "mcp", label: "MCP" },
  { type: "agent", label: "AGENTS" },
  { type: "command", label: "COMMANDS" },
] as const;

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  skill: "skill",
  mcp: "MCP サーバー",
  agent: "agent",
  command: "command",
};

/**
 * What the list's second column holds, per kind.
 *
 * One column, four meanings — the same shape VS Code's extensions list uses for
 * its own kind-dependent metadata. The header is `text-transform: uppercase`,
 * so these are written in the engine's own vocabulary and read as VERSION /
 * TRANSPORT / MODEL / AGENT.
 */
export const SECOND_COLUMN_LABEL: Record<AssetType, string> = {
  skill: "version",
  mcp: "transport",
  agent: "model",
  command: "agent",
};

/**
 * The same fact, named for the detail pane.
 *
 * Two maps rather than one because they speak in two registers, and both are
 * correct in their place: a column header in a technical table is the engine's
 * own field name (VERSION / TRANSPORT / AGENT), while a `dt` in a pane of
 * Japanese prose is Japanese (PRODUCT: 表示言語は日本語 — 資産名・ターゲット名
 * だけが英語のまま).
 */
export const DETAIL_FACT_LABEL: Record<AssetType, string> = {
  skill: "バージョン",
  mcp: "トランスポート",
  agent: "モデル",
  command: "担当エージェント",
};

/**
 * The second column's value, or the dash.
 *
 * The dash is the honest rendering of 「この資産にその事実は無い」 — a command
 * with no `agent:` in its frontmatter, a skill with no `version` — and never a
 * value we failed to read (PRODUCT: 捏造しない).
 */
export function secondColumnValue(row: AssetRow): string {
  if (row.type === "skill") return row.version ?? "—";
  return row.kindNote ?? "—";
}
