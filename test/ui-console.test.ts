/**
 * The console's derivations, pinned.
 *
 * Every case here corresponds to a defect review confirmed in the previous
 * interface, and every one of them is a *pure function* question — which is the
 * point of keeping the derivations out of the components:
 *
 *  - SPEC §9.4: with no plan, a per-target state cannot be decided. The old
 *    diagram drew 「0 件 — 一致」 over three undelivered MCP servers.
 *  - 表示 = 実行: the confirmation dialog's list is `isExecutableAction`, the
 *    same predicate `apply` uses, `--prune` rule included. The old list counted
 *    un-prunable deletions in 「以下の N 件を適用します」.
 *  - Both directions of the confirmation gap: work that was not shown, and
 *    work that was shown and not done.
 *  - Search and filter exist at all — the quality bar the brief sets (VS Code's
 *    extensions view) makes "scan the whole list by eye" a failure.
 */

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ASSET_TABS,
  DELIVERY_LABEL,
  DELIVERY_MARK,
  SECOND_COLUMN_LABEL,
  TARGET_FILTERS,
  actionsOutsideTarget,
  deliveryFor,
  describeNarrowings,
  emptyMessage,
  emptyReason,
  filterRows,
  formatDate,
  isUnmeasured,
  relatesToTarget,
  rowsFor,
  secondColumnValue,
  type RowFilter,
} from "../ui/src/lib/assets.js";
import { isExecutableAction, type Inventory, type Plan, type PlanAction, type Doctor } from "../ui/src/lib/contract.js";
import { actionNote, findingNote } from "../ui/src/lib/notes.js";
import { skippedConfirmed, unconfirmedActions } from "../ui/src/lib/reconcile.js";
import { collapseDiff, diffLines, diffStat, diffSummary } from "../ui/src/lib/difftext.js";
import { stepRemovalFocus } from "../ui/src/lib/modalfocus.js";
import { ASSET_KIND_IDS, TARGET_IDS } from "../src/core/model.js";
import { ASSET_KINDS, TARGETS, validateArgs } from "../src/server/vocabulary.js";
import { buildSchematic } from "../ui/src/lib/schematic.js";
import {
  ROW_ITSELF,
  activeRowIndex,
  isTextSelectionClick,
  nextControlIndex,
  nextRowIndex,
  rowTabIndex,
} from "../ui/src/lib/rownav.js";
import { nextSegmentIndex, segmentTabIndex } from "../ui/src/lib/segment.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Three MCP servers in the source, an empty `~/.claude.json` in the target. */
function inventory(): Inventory {
  return {
    source: {
      root: "C:\\home\\t\\.agents-manager",
      manifestPresent: true,
      linkMode: "junction",
      skills: [
        { name: "style-guide", hasSkillMd: true, enabled: true, version: "1.0.0" },
        { name: "lint-rules", hasSkillMd: true, enabled: false },
        { name: "broken-skill", hasSkillMd: false, enabled: true },
      ],
      mcp: [
        { name: "docs", transport: "http", enabled: true },
        { name: "files", transport: "stdio", enabled: true },
        { name: "search", transport: "sse", enabled: true },
      ],
      agents: [{ name: "code-reviewer", description: "Reviews changes.", enabled: true }],
      // SPEC §10.2 — one command that names its agent and one that does not.
      commands: [
        {
          name: "run-task",
          description: "Run the task.",
          enabled: true,
          agent: "coordinator",
        },
        { name: "spec-check", description: "Check the diff against SPEC.", enabled: true },
      ],
    },
    targets: [
      {
        id: "claude",
        enabled: true,
        skillsDir: "C:\\home\\t\\.claude\\skills",
        mcpPath: "C:\\home\\t\\.claude.json",
        agentsDir: "C:\\home\\t\\.claude\\agents",
        commandsDir: "unsupported",
        skills: [{ name: "style-guide", kind: "junction" }],
        mcp: [],
        agents: [],
        commands: "unsupported",
      },
      {
        id: "vs2026",
        enabled: true,
        skillsDir: "C:\\home\\t\\.agents\\skills",
        mcpPath: "unsupported",
        agentsDir: "C:\\home\\t\\.github\\agents",
        commandsDir: "unsupported",
        skills: [],
        mcp: "unsupported",
        agents: [],
        commands: "unsupported",
        sharesDiscoveryWith: "copilot-cli",
      },
      {
        // SPEC §10: the fifth target — commands and MCP carried; agents
        // refused with the engine's own reason. Skills are shared discovery
        // (SPEC §10.1, revised): the source root is listed like vscode's.
        id: "opencode",
        enabled: true,
        skillsDir: "C:\\home\\t\\.agents\\skills",
        mcpPath: "C:\\home\\t\\.config\\opencode\\opencode.jsonc",
        agentsDir: "unsupported",
        commandsDir: "C:\\home\\t\\.config\\opencode\\command",
        skills: [{ name: "style-guide", kind: "directory" }],
        mcp: [],
        agents: "unsupported",
        commands: [{ name: "run-task", description: "Run the task.", agent: "coordinator" }],
        unsupportedReasons: [
          { assetType: "agent", reason: "no safe conversion exists (SPEC §10.4)" },
        ],
      },
    ],
  };
}

const doctor: Doctor = {
  findings: [
    {
      level: "error",
      code: "skill.drift",
      target: "claude",
      asset: "style-guide",
      detail: "physical copy differs from the source",
    },
  ],
};

function action(over: Partial<PlanAction> = {}): PlanAction {
  return {
    kind: "create",
    target: "claude",
    assetType: "mcp",
    asset: "docs",
    path: "C:\\home\\t\\.claude.json",
    detail: "not present in target",
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* SPEC §9.4 — no plan, no verdict                                     */
/* ------------------------------------------------------------------ */

describe("SPEC §9.4 delivery state", () => {
  const inv = inventory();
  const claude = inv.targets[0]!;
  const vs2026 = inv.targets[1]!;

  it("reports `unknown` for every asset kind when no plan has been taken", () => {
    // The regression: this used to come back as 「一致」 for MCP and agents —
    // asserting a comparison that had never been made.
    expect(deliveryFor(claude, "mcp", "docs", null).state).toBe("unknown");
    expect(deliveryFor(claude, "agent", "code-reviewer", null).state).toBe("unknown");
    expect(deliveryFor(claude, "skill", "style-guide", null).state).toBe("unknown");
  });

  it("still reports `unsupported` without a plan — that fact needs no plan", () => {
    expect(deliveryFor(vs2026, "mcp", "docs", null).state).toBe("unsupported");
  });

  it("distinguishes 未配布 from 整合 once a plan exists", () => {
    const empty: Plan = { actions: [] };
    expect(deliveryFor(claude, "skill", "style-guide", empty).state).toBe("match");
    // Three servers in the source, none in the target: absent, not 整合.
    expect(deliveryFor(claude, "mcp", "docs", empty).state).toBe("absent");
  });

  it("lets a whole-file MCP action cover every server in that file", () => {
    // SPEC §4: a server is a key inside one shared config, so the engine's
    // action names no asset. Matching strictly on the name would leave three
    // servers reading 未配布 while the plan says the file is about to be
    // written.
    const plan: Plan = { actions: [action({ asset: "" })] };
    expect(deliveryFor(claude, "mcp", "docs", plan).state).toBe("pending");
    expect(deliveryFor(claude, "mcp", "files", plan).state).toBe("pending");
    // The same rule does *not* leak to the other kinds, which are one file each.
    const agentPlan: Plan = { actions: [action({ assetType: "agent", asset: "" })] };
    expect(deliveryFor(claude, "agent", "code-reviewer", agentPlan).state).toBe("absent");
  });

  it("does not treat a note as a difference", () => {
    // `preserve` and `unsupported` describe the environment; a server that is
    // merely being kept is not 「差分あり」.
    const plan: Plan = { actions: [action({ kind: "preserve", asset: "docs" })] };
    expect(deliveryFor(claude, "mcp", "docs", plan).state).not.toBe("pending");
  });

  it("reports 差分あり when the plan names the asset, and carries the action", () => {
    const plan: Plan = { actions: [action({ asset: "docs" })] };
    const delivery = deliveryFor(claude, "mcp", "docs", plan);
    expect(delivery.state).toBe("pending");
    expect(delivery.action?.detail).toBe("not present in target");
  });

  it("draws the map view's terminals as un-measured too, not as sound", () => {
    // The same rule applied to the demoted diagram: `plan === null` there used
    // to yield state "match" and the note 「0 件 — 一致」.
    const schematic = buildSchematic(inventory(), null, null);
    const claudePanel = schematic.targets.find((t) => t.id === "claude");
    const mcp = claudePanel?.terminals.find((t) => t.asset === "mcp");
    expect(mcp?.state).toBe("unknown");
    expect(mcp?.note).toContain("PLAN 未取得");
    expect(mcp?.note).not.toContain("一致");
  });
});

/* ------------------------------------------------------------------ */
/* Rows, search, filter                                                */
/* ------------------------------------------------------------------ */

describe("asset rows", () => {
  const inv = inventory();

  it("lists individual MCP servers and agents, not a count", () => {
    expect(rowsFor("mcp", inv, null, null).map((r) => r.name)).toEqual(["docs", "files", "search"]);
    expect(rowsFor("agent", inv, null, null).map((r) => r.name)).toEqual(["code-reviewer"]);
  });

  it("carries enabled, version and findings onto the row", () => {
    const rows = rowsFor("skill", inv, doctor, null);
    const styleGuide = rows.find((r) => r.name === "style-guide");
    expect(styleGuide?.version).toBe("1.0.0");
    expect(styleGuide?.hasFault).toBe(true);
    expect(rows.find((r) => r.name === "lint-rules")?.enabled).toBe(false);
    // Absent rather than defaulted: the interface draws 「—」 for this.
    expect(rows.find((r) => r.name === "lint-rules")?.version).toBeUndefined();
  });

  it("marks a skill with no SKILL.md instead of hiding the problem", () => {
    const rows = rowsFor("skill", inv, null, null);
    expect(rows.find((r) => r.name === "broken-skill")?.missingManifest).toBe(true);
  });
});

describe("search and filter", () => {
  const rows = rowsFor("skill", inventory(), doctor, null);

  it("matches on a substring of the name", () => {
    expect(filterRows(rows, "lint-r", "all").map((r) => r.name)).toEqual(["lint-rules"]);
    expect(filterRows(rows, "LINT-R", "all").map((r) => r.name)).toEqual(["lint-rules"]);
  });

  it("narrows to the broken ones — the whole point of having a filter", () => {
    expect(filterRows(rows, "", "fault").map((r) => r.name)).toEqual([
      "style-guide",
      "broken-skill",
    ]);
  });

  it("narrows to the disabled ones", () => {
    expect(filterRows(rows, "", "disabled").map((r) => r.name)).toEqual(["lint-rules"]);
  });

  it("narrows to the ones with a difference", () => {
    const plan: Plan = { actions: [action({ assetType: "skill", asset: "style-guide" })] };
    const planned = rowsFor("skill", inventory(), null, plan);
    expect(filterRows(planned, "", "pending").map((r) => r.name)).toEqual(["style-guide"]);
  });

  it("combines search and filter rather than choosing one", () => {
    const filters: RowFilter[] = ["all", "fault"];
    expect(filterRows(rows, "style-g", filters[0]!).map((r) => r.name)).toEqual(["style-guide"]);
    expect(filterRows(rows, "lint-r", filters[1]!)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* SPEC §10 — commands, opencode, and the target narrowing              */
/* ------------------------------------------------------------------ */

describe("SPEC §10.2 commands", () => {
  const inv = inventory();

  it("is a tab of its own, on the asset-kind axis", () => {
    // SPEC §10.6 fixes the axis: four kinds, not five agents. Tabbing by agent
    // would make 「1資産がどこへ届いているか」 a round trip through four tabs.
    expect(ASSET_TABS.map((t) => t.type)).toEqual(["skill", "mcp", "agent", "command"]);
    expect(ASSET_TABS.map((t) => t.label)).toContain("COMMANDS");
  });

  it("lists each command with the agent that runs it in the second column", () => {
    const rows = rowsFor("command", inv, null, null);
    expect(rows.map((r) => r.name)).toEqual(["run-task", "spec-check"]);
    expect(secondColumnValue(rows[0]!)).toBe("coordinator");
  });

  it("draws the dash for a command whose frontmatter names no agent", () => {
    // `agent` is optional in SPEC §10.2, so most commands genuinely have none.
    // Inventing an owner here would be the same defect as inventing a version.
    const rows = rowsFor("command", inv, null, null);
    expect(rows.find((r) => r.name === "spec-check")?.kindNote).toBeUndefined();
    expect(secondColumnValue(rows.find((r) => r.name === "spec-check")!)).toBe("—");
  });

  it("names the second column for the kind in it, never one label for all four", () => {
    expect(SECOND_COLUMN_LABEL.skill).toBe("version");
    expect(SECOND_COLUMN_LABEL.mcp).toBe("transport");
    expect(SECOND_COLUMN_LABEL.command).toBe("agent");
  });

  it("reports every target but opencode as 非対応 for a command", () => {
    const claude = inv.targets.find((t) => t.id === "claude")!;
    const opencode = inv.targets.find((t) => t.id === "opencode")!;
    // No plan needed: 「このターゲットはこの種別を運べない」 is a fact about the
    // adapter, not about any difference (SPEC §9.4's first row).
    expect(deliveryFor(claude, "command", "run-task", null).state).toBe("unsupported");
    expect(deliveryFor(opencode, "command", "run-task", null).state).toBe("unknown");
    expect(deliveryFor(opencode, "command", "run-task", { actions: [] }).state).toBe("match");
    expect(deliveryFor(opencode, "command", "spec-check", { actions: [] }).state).toBe("absent");
  });

  it("carries the engine's stated reason for a refusal, and none where there is none", () => {
    // SPEC §10.4: 非対応 with nothing behind it reads as a hole in this tool.
    const opencode = inv.targets.find((t) => t.id === "opencode")!;
    const claude = inv.targets.find((t) => t.id === "claude")!;
    expect(deliveryFor(opencode, "agent", "code-reviewer", null).reason).toContain("SPEC §10.4");
    // Skills are shared discovery now (SPEC §10.1, revised): held, so the
    // verdict is the ordinary one — and no reason is invented for it.
    expect(deliveryFor(opencode, "skill", "style-guide", { actions: [] }).state).toBe("match");
    expect(deliveryFor(opencode, "skill", "style-guide", null).state).toBe("unknown");
    expect(deliveryFor(opencode, "skill", "style-guide", null).reason).toBeUndefined();
    // claude's adapter offers no reason for commands; the interface must then
    // show 非対応 alone rather than inventing a rationale.
    expect(deliveryFor(claude, "command", "run-task", null).reason).toBeUndefined();
  });
});

/**
 * SPEC §10.2 — a target-side command file the engine could not parse.
 *
 * `inventory` now keeps such a file as a row flagged `unreadable` instead of
 * exiting 2 and taking the console's whole survey with it. The console's part of
 * the bargain is to *show* the flag: doctor's `command.unreadable` names a target
 * and a path but no asset, so nothing attaches it to a row, and without this the
 * one broken command in the list looked exactly like the working ones.
 */
describe("SPEC §10.2 an unreadable target command file", () => {
  /** The same fixture, with opencode's copy of `run-task` unparseable. */
  function withUnreadable(): Inventory {
    const inv = inventory();
    const opencode = inv.targets.find((t) => t.id === "opencode")!;
    opencode.commands = [
      { name: "run-task", unreadable: "Failed to parse YAML frontmatter: ...\\run-task.md" },
    ];
    return inv;
  }

  it("hangs the parse error off the delivery for that target alone", () => {
    const inv = withUnreadable();
    const opencode = inv.targets.find((t) => t.id === "opencode")!;
    const claude = inv.targets.find((t) => t.id === "claude")!;
    expect(deliveryFor(opencode, "command", "run-task", null).unreadable).toContain("YAML");
    expect(deliveryFor(opencode, "command", "spec-check", null).unreadable).toBeUndefined();
    expect(deliveryFor(claude, "command", "run-task", null).unreadable).toBeUndefined();
  });

  it("does not disturb the delivery state, which answers a different question", () => {
    // 「届いているか」 and 「読めるか」 are two facts. SPEC §9.4's table decides
    // the first; folding the second into it would drop one of them.
    const inv = withUnreadable();
    const opencode = inv.targets.find((t) => t.id === "opencode")!;
    expect(deliveryFor(opencode, "command", "run-task", null).state).toBe("unknown");
    expect(deliveryFor(opencode, "command", "run-task", { actions: [] }).state).toBe("match");
  });

  it("marks the row 不良 and puts it in the 「不良のみ」 filter", () => {
    const rows = rowsFor("command", withUnreadable(), null, { actions: [] });
    const row = rows.find((r) => r.name === "run-task")!;
    expect(row.hasFault).toBe(true);
    expect(filterRows(rows, "", "fault").map((r) => r.name)).toEqual(["run-task"]);
  });

  it("leaves every other row alone", () => {
    const rows = rowsFor("command", inventory(), null, { actions: [] });
    expect(rows.every((r) => !r.hasFault)).toBe(true);
    expect(filterRows(rows, "", "fault")).toEqual([]);
  });
});

describe("SPEC §10.6 target narrowing", () => {
  const inv = inventory();

  it("offers all and the five targets, in the order the SPEC lists them", () => {
    expect([...TARGET_FILTERS]).toEqual([
      "all",
      "claude",
      "opencode",
      "copilot-cli",
      "vscode",
      "vs2026",
    ]);
  });

  it("drops assets the target cannot carry at all", () => {
    const commands = rowsFor("command", inv, null, null);
    expect(filterRows(commands, "", "all", "claude")).toEqual([]);
    expect(filterRows(commands, "", "all", "opencode").map((r) => r.name)).toEqual([
      "run-task",
      "spec-check",
    ]);
    // vs2026 cannot carry MCP either (SPEC §4), so no server relates to it.
    expect(filterRows(rowsFor("mcp", inv, null, null), "", "all", "vs2026")).toEqual([]);
  });

  it("keeps 未配布 assets — a relationship with a target is not delivery", () => {
    // The narrowing answers 「opencode に関係あるのはどれか」. Hiding what is
    // not yet delivered would make it answer 「何が届いているか」 instead, which
    // is the state filter's question.
    const rows = rowsFor("mcp", inv, null, { actions: [] });
    expect(filterRows(rows, "", "all", "claude").map((r) => r.name)).toEqual([
      "docs",
      "files",
      "search",
    ]);
  });

  it("honours an asset's own target selector", () => {
    // SPEC §3: `targets: [claude]` on a server means opencode is not its
    // business, however capable opencode is of carrying servers.
    const [row] = rowsFor("mcp", inv, null, null);
    const scoped = { ...row!, declaredTargets: ["claude" as const] };
    expect(relatesToTarget(scoped, "claude")).toBe(true);
    expect(relatesToTarget(scoped, "opencode")).toBe(false);
  });

  it("defaults to no narrowing, so every existing caller is unchanged", () => {
    const rows = rowsFor("skill", inv, doctor, null);
    expect(filterRows(rows, "", "all")).toEqual(filterRows(rows, "", "all", "all"));
  });

  it("combines with search and the state filter rather than replacing them", () => {
    const commands = rowsFor("command", inv, null, null);
    expect(filterRows(commands, "run", "all", "opencode").map((r) => r.name)).toEqual(["run-task"]);
    expect(filterRows(commands, "", "disabled", "opencode")).toEqual([]);
  });
});

describe("表示 = 実行 survives a narrowed list", () => {
  const write = (target: PlanAction["target"]): PlanAction =>
    action({ kind: "create", target, assetType: "command", asset: "run-task" });

  it("counts the work the narrowed list is not showing", () => {
    // SPEC §10.6: `apply` ignores the narrowing, so the confirmation has to say
    // so with a number the owner can check against the rows below it.
    const actions = [write("opencode"), write("claude"), write("vscode")];
    expect(actionsOutsideTarget(actions, "opencode")).toBe(2);
    expect(actionsOutsideTarget(actions, "claude")).toBe(2);
  });

  it("counts nothing when no narrowing is active", () => {
    expect(actionsOutsideTarget([write("opencode"), write("claude")], "all")).toBe(0);
  });

  it("leaves the executable list itself untouched — the narrowing is display only", () => {
    const plan: Plan = { actions: [write("opencode"), write("claude")] };
    const shown = plan.actions.filter((a) => isExecutableAction(a));
    // Whatever the list is narrowed to, this is the list the dialog enumerates
    // and the list `apply` performs. They are the same list or the promise is
    // broken.
    expect(shown).toHaveLength(2);
    expect(actionsOutsideTarget(shown, "opencode")).toBe(1);
  });
});

describe("formatDate", () => {
  it("draws an em dash for an absent or unreadable date, never a guess", () => {
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("not a date")).toBe("—");
    expect(formatDate("2026-01-15T09:14:00.000Z")).toMatch(/^2026-01-1[56]$/);
  });
});

/* ------------------------------------------------------------------ */
/* 表示 = 実行                                                          */
/* ------------------------------------------------------------------ */

describe("the confirmation list is exactly what apply will do", () => {
  it("excludes a delete, because the GUI never passes --prune", () => {
    // The confirmed defect: a `delete` for `~/.claude.json` was counted in
    // 「以下の N 件を適用します」 and then skipped by the engine.
    expect(isExecutableAction(action({ kind: "delete" }))).toBe(false);
    expect(isExecutableAction(action({ kind: "delete" }), { prune: true })).toBe(true);
  });

  it("excludes the two informational kinds", () => {
    expect(isExecutableAction(action({ kind: "preserve" }))).toBe(false);
    expect(isExecutableAction(action({ kind: "unsupported" }))).toBe(false);
    expect(isExecutableAction(action({ kind: "drift" }))).toBe(false);
  });

  it("includes the kinds that really write", () => {
    for (const kind of ["create", "update", "link"] as const) {
      expect(isExecutableAction(action({ kind }))).toBe(true);
    }
  });

  it("filtering a plan the way the dialog does leaves no preserved deletion", () => {
    const plan: Plan = {
      actions: [
        action({ kind: "link", assetType: "skill", asset: "style-guide" }),
        action({ kind: "preserve", asset: "their-server" }),
        action({ kind: "unsupported", target: "vs2026", asset: "" }),
      ],
    };
    const shown = plan.actions.filter((a) => isExecutableAction(a));
    expect(shown.map((a) => a.asset)).toEqual(["style-guide"]);
  });
});

describe("both directions of the confirmation gap", () => {
  const link = action({ kind: "link", assetType: "skill", asset: "style-guide" });
  const create = action({ kind: "create", assetType: "agent", asset: "code-reviewer" });

  it("names work that was done without being shown", () => {
    const report = [
      { ...link, status: "done" as const },
      { ...create, status: "done" as const },
    ];
    expect(unconfirmedActions([link], report).map((a) => a.asset)).toEqual(["code-reviewer"]);
  });

  it("names work that was shown and then skipped", () => {
    // The half that was missing: a confirmed action the engine reported as
    // `skipped` used to pass as a clean success.
    const report = [
      { ...link, status: "done" as const },
      { ...create, status: "skipped" as const },
    ];
    expect(skippedConfirmed([link, create], report).map((a) => a.asset)).toEqual(["code-reviewer"]);
  });

  it("stays silent when the write is exactly what was confirmed", () => {
    const report = [
      { ...link, status: "done" as const },
      { ...create, status: "done" as const },
    ];
    expect(unconfirmedActions([link, create], report)).toEqual([]);
    expect(skippedConfirmed([link, create], report)).toEqual([]);
  });

  it("counts an action missing from the report entirely as not applied", () => {
    expect(skippedConfirmed([link], []).map((a) => a.asset)).toEqual(["style-guide"]);
  });
});

/* ------------------------------------------------------------------ */
/* SPEC §9.6 — the content preview                                     */
/* ------------------------------------------------------------------ */

describe("the diff preview", () => {
  const before = "a\nb\nc\n";
  const after = "a\nB\nc\n";

  it("marks the changed line on both sides", () => {
    const lines = diffLines(before, after);
    expect(diffStat(lines)).toEqual({ added: 1, removed: 1 });
    expect(lines.find((l) => l.kind === "remove")?.text).toBe("b");
    expect(lines.find((l) => l.kind === "add")?.text).toBe("B");
  });

  it("treats a create as all-added and a delete as all-removed", () => {
    expect(diffStat(diffLines(undefined, "x\ny\n"))).toEqual({ added: 2, removed: 0 });
    expect(diffStat(diffLines("x\ny\n", undefined))).toEqual({ added: 0, removed: 2 });
  });

  it("reports nothing changed when nothing changed", () => {
    expect(diffStat(diffLines(before, before))).toEqual({ added: 0, removed: 0 });
  });

  it("collapses the untouched bulk of a large live file", () => {
    // `~/.claude.json` is thousands of lines this tool does not manage
    // (SPEC §6.1); showing them all would bury the one line that changes.
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const changed = [...big];
    changed[100] = "line 100 changed";
    const collapsed = collapseDiff(diffLines(big.join("\n"), changed.join("\n")));
    expect(collapsed.length).toBeLessThan(20);
    expect(collapsed.some((l) => l.kind === "gap")).toBe(true);
    expect(collapsed.some((l) => l.text === "line 100 changed")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The list as a composite widget — hit area and roving tabindex        */
/* ------------------------------------------------------------------ */

describe("roving tabindex: one tab stop, whatever the asset count", () => {
  it("hands the tab stop to exactly one row at every list length", () => {
    // The measured defect: three tab stops per row meant five assets cost
    // fifteen stops between the toolbar and the detail pane, growing linearly.
    for (const count of [1, 2, 5, 12, 40]) {
      const stops = Array.from({ length: count }, (_, i) => rowTabIndex(i, 3, count));
      expect(stops.filter((t) => t === 0)).toHaveLength(1);
    }
  });

  it("parks the tab stop on the first row when nothing is active yet", () => {
    expect(rowTabIndex(0, -1, 5)).toBe(0);
    // Out of range (the active row was filtered away) falls back the same way.
    expect(rowTabIndex(0, 99, 5)).toBe(0);
    expect(rowTabIndex(3, 99, 5)).toBe(-1);
  });

  it("gives an empty list no tab stop at all", () => {
    expect(rowTabIndex(0, 0, 0)).toBe(-1);
  });
});

describe("row movement", () => {
  it("walks with ↑↓ and jumps with Home/End", () => {
    expect(nextRowIndex("ArrowDown", 0, 5)).toBe(1);
    expect(nextRowIndex("ArrowUp", 3, 5)).toBe(2);
    expect(nextRowIndex("Home", 3, 5)).toBe(0);
    expect(nextRowIndex("End", 0, 5)).toBe(4);
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(nextRowIndex("ArrowUp", 0, 5)).toBe(0);
    expect(nextRowIndex("ArrowDown", 4, 5)).toBe(4);
  });

  it("declines keys that are not its own, so Tab still leaves the list", () => {
    expect(nextRowIndex("Tab", 1, 5)).toBeNull();
    expect(nextRowIndex("Enter", 1, 5)).toBeNull();
    expect(nextRowIndex("a", 1, 5)).toBeNull();
    expect(nextRowIndex("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("reaching the controls inside a row", () => {
  it("steps out with → and back with ←", () => {
    expect(nextControlIndex("ArrowRight", ROW_ITSELF, 2)).toBe(0);
    expect(nextControlIndex("ArrowRight", 0, 2)).toBe(1);
    expect(nextControlIndex("ArrowLeft", 1, 2)).toBe(0);
    expect(nextControlIndex("ArrowLeft", 0, 2)).toBe(ROW_ITSELF);
  });

  it("stops at the last control and at the row itself", () => {
    expect(nextControlIndex("ArrowRight", 1, 2)).toBeNull();
    expect(nextControlIndex("ArrowLeft", ROW_ITSELF, 2)).toBeNull();
  });

  it("has nowhere to go when every control is disabled (busy)", () => {
    expect(nextControlIndex("ArrowRight", ROW_ITSELF, 0)).toBeNull();
  });

  it("returns to the row on Escape, and only from a control", () => {
    expect(nextControlIndex("Escape", 1, 2)).toBe(ROW_ITSELF);
    expect(nextControlIndex("Escape", ROW_ITSELF, 2)).toBeNull();
  });
});

describe("which row is active", () => {
  const names = ["style-guide", "lint-rules", "broken-skill"];

  it("prefers the focused row, then the selected one, then the first", () => {
    expect(activeRowIndex(names, "broken-skill", "style-guide")).toBe(2);
    expect(activeRowIndex(names, null, "lint-rules")).toBe(1);
    expect(activeRowIndex(names, null, null)).toBe(0);
  });

  it("keys on the name, so filtering cannot move the tab stop to another asset", () => {
    // The focused row was filtered out; the tab stop falls back to selection.
    expect(activeRowIndex(["lint-rules"], "style-guide", "lint-rules")).toBe(0);
    expect(activeRowIndex([], "style-guide", "lint-rules")).toBe(-1);
  });
});

describe("the row as a click target", () => {
  it("ignores the click that merely ended a text drag", () => {
    // Making the whole row clickable must not cost the ability to copy a name.
    expect(isTextSelectionClick("style-guide")).toBe(true);
    expect(isTextSelectionClick("")).toBe(false);
    expect(isTextSelectionClick("   ")).toBe(false);
    expect(isTextSelectionClick(null)).toBe(false);
    expect(isTextSelectionClick(undefined)).toBe(false);
  });
});

describe("the rendered row keeps the composite-widget contract", () => {
  const source = fs.readFileSync(
    new URL("../ui/src/lib/AssetTable.svelte", import.meta.url),
    "utf8",
  );
  const body = source.slice(source.indexOf("<section"), source.indexOf("<style>"));
  const rowMarkup = body.slice(body.indexOf("<tbody>"), body.indexOf("</tbody>"));

  it("selects from the whole row, not from a 64px button inside it", () => {
    expect(rowMarkup).toMatch(/<tr[^>]*\n?[^]*?onclick=\{\(\) => handleRowClick/);
    // The old name button is gone: the row is the control, and a button inside
    // it would be announced a second time by a screen reader.
    expect(rowMarkup).not.toMatch(/class="row-name"[^>]*onclick/);
    expect(rowMarkup).not.toContain('<button type="button" class="row-name"');
  });

  it("keeps a control's click from reading as a row choice", () => {
    const clicks = rowMarkup.match(/onclick=\{\(event\) => \{/g) ?? [];
    expect(clicks).toHaveLength(2); // the state switch and the delete button
    expect(rowMarkup.match(/event\.stopPropagation\(\);/g) ?? []).toHaveLength(2);
  });

  it("takes the in-row controls out of the tab order and marks them for →/←", () => {
    expect(rowMarkup.match(/data-row-control/g) ?? []).toHaveLength(2);
    expect(rowMarkup.match(/tabindex="-1"/g) ?? []).toHaveLength(2);
    // The row's own tabindex is the roving one, never a literal.
    expect(rowMarkup).toContain("tabindex={rowTabIndex(index, activeIndex, rows.length)}");
  });

  it("announces the row's selected state and gives the table grid semantics", () => {
    // By key: a project row and a 個人 row may share a name (a 個人 row's key is its name).
    expect(rowMarkup).toContain("aria-selected={row.key === selected}");
    expect(body).toContain('<table role="grid"');
  });

  it("no longer makes the scrolling box a tab stop of its own", () => {
    // Two roles for one job: the region stop announced nothing the grid does
    // not now announce better.
    expect(body).not.toMatch(/class="scroller"[^>]*tabindex/);
    expect(body).not.toMatch(/class="scroller"[^>]*role=/);
  });
});

/* ------------------------------------------------------------------ */
/* The toolbar's narrowings are composite widgets too                   */
/* ------------------------------------------------------------------ */

describe("segmented controls cost one tab stop each, not one per option", () => {
  it("hands the stop to exactly one option at every option count", () => {
    // SPEC §10.6 added six more buttons to a toolbar that already had four. As
    // individually-tabbable buttons that is ten presses between the search box
    // and the asset list, and it grows every time a target is added.
    for (const count of [2, 4, 6, 12]) {
      const stops = Array.from({ length: count }, (_, i) => segmentTabIndex(i, 2, count));
      expect(stops.filter((t) => t === 0)).toHaveLength(1);
    }
  });

  it("parks the stop on the checked option, so Tab lands on the current answer", () => {
    expect(segmentTabIndex(3, 3, 6)).toBe(0);
    expect(segmentTabIndex(0, 3, 6)).toBe(-1);
    // Nothing checked (cannot happen while `all` exists) falls back to first.
    expect(segmentTabIndex(0, -1, 6)).toBe(0);
  });

  it("wraps at both ends — a radio group is a ring, not a list", () => {
    // `rownav.ts` clamps for the opposite reason: a list has a first and last
    // row the reader is tracking, and wrapping there loses their place.
    expect(nextSegmentIndex("ArrowRight", 5, 6)).toBe(0);
    expect(nextSegmentIndex("ArrowLeft", 0, 6)).toBe(5);
    expect(nextSegmentIndex("ArrowDown", 0, 6)).toBe(1);
    expect(nextSegmentIndex("ArrowUp", 1, 6)).toBe(0);
    expect(nextSegmentIndex("Home", 4, 6)).toBe(0);
    expect(nextSegmentIndex("End", 0, 6)).toBe(5);
  });

  it("declines keys that are not its own, so Tab still leaves the group", () => {
    expect(nextSegmentIndex("Tab", 0, 6)).toBeNull();
    expect(nextSegmentIndex("Enter", 0, 6)).toBeNull();
    expect(nextSegmentIndex("ArrowRight", 0, 0)).toBeNull();
  });

  it("wires every group in the markup rather than only the new one", () => {
    const source = fs.readFileSync(
      new URL("../ui/src/lib/AssetTable.svelte", import.meta.url),
      "utf8",
    );
    const toolbar = source.slice(source.indexOf('<div class="toolbar">'), source.indexOf("<!-- The scroller"));
    // 単位 (the scope segment), the state filter and TARGET.
    expect(toolbar.match(/role="radiogroup"/g) ?? []).toHaveLength(3);
    expect(toolbar.match(/tabindex=\{segmentTabIndex\(/g) ?? []).toHaveLength(3);
    expect(toolbar.match(/moveSegment\(/g) ?? []).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ */
/* SPEC §10.3 — a target's own switch is not 「整合」                    */
/* ------------------------------------------------------------------ */

describe("a server opencode has switched off", () => {
  /** The opencode target, holding `files` with its own `enabled: false`. */
  function withDisabledServer(): Inventory {
    const inv = inventory();
    const opencode = inv.targets.find((t) => t.id === "opencode")!;
    opencode.mcp = [
      { name: "files", transport: "stdio", enabled: false },
      { name: "docs", transport: "http", enabled: true },
    ];
    return inv;
  }

  const empty: Plan = { actions: [] };

  it("reads as 適用済み(ターゲット側で無効), not as 整合", () => {
    // The regression: `plan` emits no action for a server that is present and
    // correct on disk, so the row fell through to 「適用済み(整合)」 — the
    // console asserting a delivery opencode will never act on. The write path
    // is designed never to flip the switch back, so the claim was permanent.
    const opencode = withDisabledServer().targets.find((t) => t.id === "opencode")!;
    expect(deliveryFor(opencode, "mcp", "files", empty).state).toBe("off");
    expect(deliveryFor(opencode, "mcp", "docs", empty).state).toBe("match");
    expect(DELIVERY_LABEL.off).toContain("無効");
  });

  it("does not invent a switch for a target that has none", () => {
    // Absent is absent: claude has no per-server enabled flag, so its servers
    // are 整合 or nothing — never 「無効」 by omission.
    const inv = inventory();
    const claude = inv.targets.find((t) => t.id === "claude")!;
    claude.mcp = [{ name: "docs", transport: "http" }];
    expect(deliveryFor(claude, "mcp", "docs", empty).state).toBe("match");
  });

  it("lets a pending write still outrank the switch", () => {
    const opencode = withDisabledServer().targets.find((t) => t.id === "opencode")!;
    const plan: Plan = { actions: [action({ target: "opencode", asset: "" })] };
    expect(deliveryFor(opencode, "mcp", "files", plan).state).toBe("pending");
  });

  it("says so on the map view's terminal as well", () => {
    // The map is drawn at four blocks and opencode is not one of them (the
    // surface brief fixes the scale, and the console names the omission), so
    // this exercises the *contract* field rather than one adapter:
    // `TargetMcp.enabled` is 「the target's own switch, when it has one」, and a
    // terminal that reads a plain 「一致」 over it is the same untruth as the
    // row badge, in a smaller font.
    const inv = inventory();
    const claude = inv.targets.find((t) => t.id === "claude")!;
    claude.mcp = [
      { name: "docs", transport: "http", enabled: false },
      { name: "files", transport: "stdio", enabled: true },
    ];
    const schematic = buildSchematic(inv, null, { actions: [] });
    const mcp = schematic.targets
      .find((t) => t.id === "claude")
      ?.terminals.find((t) => t.asset === "mcp");
    expect(mcp?.note).toContain("ターゲット側で無効");
    expect(mcp?.note).toContain("1 件");
  });
});

/* ------------------------------------------------------------------ */
/* SPEC §10.6 — a settled state is not hidden behind PLAN 未取得        */
/* ------------------------------------------------------------------ */

describe("the 適用先 column draws every target's badge", () => {
  const source = fs.readFileSync(
    new URL("../ui/src/lib/AssetTable.svelte", import.meta.url),
    "utf8",
  );
  const body = source.slice(source.indexOf("<section"), source.indexOf("<style>"));
  const cell = body.slice(
    body.indexOf('<td class="col-targets">'),
    body.indexOf('<td class="col-date'),
  );

  it("never collapses the column into a single PLAN 未取得 chip", () => {
    // `deliveryFor` already settles what a plan is not needed for — 非対応 is
    // decided by inventory alone — so blanking the column threw that away.
    // With no plan the COMMANDS tab said nothing at all about the four targets
    // that cannot carry a command (SPEC §10.6), while the map view, from the
    // same data, drew them correctly.
    expect(cell).toContain("{#each row.deliveries as delivery");
    expect(cell).not.toContain("{#if !hasPlan}");
    expect(cell).not.toContain("PLAN 未取得</span>");
  });

  it("keeps `unsupported` decidable without a plan, which is what the column now shows", () => {
    const inv = inventory();
    const claude = inv.targets.find((t) => t.id === "claude")!;
    expect(deliveryFor(claude, "command", "run-task", null).state).toBe("unsupported");
    expect(DELIVERY_MARK.unsupported).toBe("✕");
    // Everything a plan *is* needed for still refuses to guess.
    expect(deliveryFor(claude, "mcp", "docs", null).state).toBe("unknown");
  });

  it("reports the same in the detail pane rather than painting over it", () => {
    const detail = fs.readFileSync(
      new URL("../ui/src/lib/DetailPane.svelte", import.meta.url),
      "utf8",
    );
    const list = detail.slice(detail.indexOf("{#each row.deliveries"), detail.indexOf("</ul>"));
    expect(list).not.toContain("hasPlan ? delivery.state");
    expect(list).not.toContain("hasPlan ? DELIVERY_LABEL[delivery.state]");
    // The explanation of what a missing plan costs stays, above the list.
    expect(detail).toContain("PLAN 未取得 — 差分の有無は判定できません。");
  });
});

/* ------------------------------------------------------------------ */
/* notes.ts annotates the engine; it does not replace it               */
/* ------------------------------------------------------------------ */

describe("the Japanese reading of an engine report", () => {
  /** Exactly as `src/core/diff.ts` writes them. */
  const DIFF_DETAILS = [
    "not present in target",
    "content differs from source",
    "present in target but absent from source",
    "create junction to source skill",
    "copy source skill into target",
    "linkMode is \"copy\"; replace link with a physical copy",
    "copy differs from source",
    "physical copy matches source; back up and replace with junction",
    "physical copy differs from source; refusing to replace it (resolve manually or re-import)",
    "a file occupies the skill directory path",
  ] as const;

  function action(detail: string): PlanAction {
    return { kind: "link", target: "claude", assetType: "skill", asset: "x", path: "p", detail };
  }

  it("recognises the sentences the engine actually writes", () => {
    // The table is matched with anchored regexes against strings that live in
    // another file. Nothing but a test keeps the two in step: a reworded
    // `detail` silently falls through to the English original, which is safe
    // but is not what the table claims to do.
    for (const detail of DIFF_DETAILS) {
      expect(actionNote(action(detail)), detail).not.toBeNull();
    }
  });

  it("keeps the values the engine put in the sentence", () => {
    // Two of the patterns capture. A note that dropped the destination would be
    // 「塗り潰す」 with extra steps: 「断線したリンクを張り直します」 does not say
    // which link, and that is the only thing the owner needs.
    expect(actionNote(action("broken link (D:\gone\skill); recreate"))).toContain(
      "D:\gone\skill",
    );
    expect(
      actionNote(action("link points at D:\elsewhere, expected the source skill")),
    ).toContain("D:\elsewhere");
  });

  it("falls through to the original when the engine says something new", () => {
    // `plan.ts` appends 「; preserved (use --prune to remove)」 to a preserved
    // action's detail, which no pattern matches — by design. The caller shows
    // the engine's own words, so nothing is lost; this pins that it is a
    // fall-through and not a silent partial match.
    expect(
      actionNote(action("present in target but absent from source; preserved (use --prune to remove)")),
    ).toBeNull();
    expect(actionNote(action("something the table has never seen"))).toBeNull();
  });

  it("cannot carry a finding's values, which is why the original stays on screen", () => {
    // `FINDING_NOTES` is keyed on the code alone while `doctor` writes the
    // values into its message — the field name here, elsewhere a declared name
    // or a character count. The note is a reading of the *kind* of finding; the
    // engine's sentence is the finding. Both are drawn (DESIGN: エンジンの報告を
    // そのまま描く), and this is the reason.
    const detail =
      'skill "style-guide": frontmatter field "author" is outside the agentskills.io schema';
    const note = findingNote({ level: "warn", code: "skill.non-spec-frontmatter", detail });
    expect(note).not.toBeNull();
    expect(note).not.toContain("author");
  });
});

/* ------------------------------------------------------------------ */
/* Why the list is empty — 存在しない値を描かない, at the four states    */
/* ------------------------------------------------------------------ */

describe("an empty table says which kind of empty it is", () => {
  /** The settled case: read, measured, nothing narrowed. */
  const base = {
    surveyStatus: "ready",
    diffStatus: "idle",
    total: 12,
    totalIgnoringTarget: 12,
    filter: "all",
    targetFilter: "all",
    hasPlan: true,
  } as const;

  it("does not call an unread machine empty", () => {
    // The whole defect, in one line: before this the scroller printed
    // 「この種別の資産はまだありません。」 during the very first survey — a
    // confident assertion about a machine nobody had managed to read.
    const surveying = emptyReason({ ...base, surveyStatus: "running", total: 0 });
    expect(surveying.kind).toBe("surveying");
    expect(isUnmeasured(surveying)).toBe(true);
    expect(emptyMessage(surveying)).not.toContain("ありません");
  });

  it("does not call a failed read empty either, and says so where the fault plate is", () => {
    const failed = emptyReason({ ...base, surveyStatus: "failed", total: 0 });
    expect(failed.kind).toBe("survey-failed");
    expect(isUnmeasured(failed)).toBe(true);
    // It contradicted the fault plate directly above it, which says the
    // opposite: the reading is not to be trusted.
    expect(emptyMessage(failed)).toContain("空ではなく");
  });

  it("keeps a re-survey from disguising a search that found nothing", () => {
    // `survey()` only clears the inventory when it *fails*, so a re-survey runs
    // with the old rows still on screen. Without the `total === 0` half of the
    // test, a list emptied by the search box claimed 「走査中」 while the counter
    // beside it read 「0 / 12 件」 — the inverse of the defect above.
    const narrowed = emptyReason({ ...base, surveyStatus: "running", total: 12 });
    expect(narrowed.kind).toBe("narrowed");
    expect(isUnmeasured(narrowed)).toBe(false);
  });

  it("refuses to let 「差分ありのみ」 read as 「差分なし = 整合」 (SPEC §9.4)", () => {
    // With no plan every state that needs one is `unknown`, so the filter
    // matches nothing — and the generic 「検索語かフィルタを変えてください」
    // invited exactly the reading the rest of the console refuses to make.
    const needsPlan = emptyReason({ ...base, filter: "pending", hasPlan: false });
    expect(needsPlan.kind).toBe("needs-plan");
    expect(emptyMessage(needsPlan)).toContain("PLAN 未取得");
  });

  it("stops offering 差分を取る once it is already being taken", () => {
    // `plan` stays null for the whole of `runPlan()`, so `hasPlan` alone kept
    // the empty state asking for an action that was already under way, while
    // the status bar beside it read 「PLAN 取得中…」.
    const running = emptyReason({
      ...base,
      filter: "pending",
      hasPlan: false,
      diffStatus: "running",
    });
    expect(running.kind).toBe("plan-running");
    expect(emptyMessage(running)).not.toContain("PLAN 未取得");
  });

  it("tells 「まだ無い」 from 「絞り込みで消えた」 and names what the narrowing hides", () => {
    expect(emptyReason({ ...base, total: 0 }).kind).toBe("none-of-kind");

    const byTarget = emptyReason({
      ...base,
      targetFilter: "opencode",
      totalIgnoringTarget: 7,
    });
    expect(byTarget).toEqual({ kind: "target-narrowed", target: "opencode", restored: 7 });
    // The count is in the sentence so the owner knows what dropping it costs.
    expect(emptyMessage(byTarget)).toContain("7 件");

    expect(emptyReason({ ...base, totalIgnoringTarget: 0 }).kind).toBe("narrowed");
  });
});

/* ------------------------------------------------------------------ */
/* The 適用先 legend is aligned by count, so the count must be fixed    */
/* ------------------------------------------------------------------ */

describe("every row's badge strip has the same shape", () => {
  it("carries one delivery per inventory target, in the inventory's order", () => {
    // `AssetTable` draws one legend above the column and relies on label *i*
    // landing over badge *i* of every row — the two share a grid and are
    // aligned by position alone, so a row whose `deliveries` were shorter or
    // reordered would sit under the wrong labels with nothing to catch it.
    const inv = inventory();
    const order = inv.targets.map((t) => t.id);
    for (const tab of ASSET_TABS) {
      const rows = rowsFor(tab.type, inv, null, null);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.deliveries.map((d) => d.target)).toEqual(order);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* SPEC §10.6 — the confirmation's caveat names every narrowing        */
/* ------------------------------------------------------------------ */

describe("the confirmation dialog's scope note", () => {
  it("always names the tab, because the table only ever shows one kind", () => {
    expect(describeNarrowings("skill", "all", "all", "")).toEqual(["種別: SKILLS"]);
    expect(describeNarrowings("command", "all", "all", "")).toEqual(["種別: COMMANDS"]);
  });

  it("names the target, state filter and search when they are active", () => {
    expect(describeNarrowings("mcp", "claude", "fault", "  docs ")).toEqual([
      "種別: MCP",
      "ターゲット: claude",
      "表示: 不良のみ",
      "検索: 「docs」",
    ]);
  });

  it("no longer claims that a write of one kind is all visible on another tab", () => {
    // The defect: `hiddenFromFilter` counts only `a.target !== targetFilter`,
    // so a SKILLS tab narrowed to claude, over a plan that also writes an MCP
    // file and an agent to claude, produced 0 — and the dialog asserted
    // 「すべて一覧に出ているものです」 about rows that tab does not have.
    const executable = [
      action({ target: "claude", assetType: "skill", asset: "style-guide", kind: "link" }),
      action({ target: "claude", assetType: "mcp", asset: "" }),
      action({ target: "claude", assetType: "agent", asset: "code-reviewer" }),
    ];
    expect(actionsOutsideTarget(executable, "claude")).toBe(0);

    const confirm = fs.readFileSync(
      new URL("../ui/src/lib/ConfirmApply.svelte", import.meta.url),
      "utf8",
    );
    const note = confirm.slice(confirm.indexOf('<p class="scope-note">'), confirm.indexOf("<dl"));
    expect(note).not.toContain("すべて一覧に出ているものです");
    // What it says instead is true whatever the narrowing: this dialog's own
    // list is the authoritative enumeration.
    expect(note).toContain("実行される操作の全体は下記の一覧");
    expect(note).toContain("narrowings.join");
  });

  it("is shown even when the target narrowing is 「すべて」", () => {
    // Search and the state filter used to produce no caveat at all, because the
    // whole block sat behind `targetFilter !== "all"`.
    const confirm = fs.readFileSync(
      new URL("../ui/src/lib/ConfirmApply.svelte", import.meta.url),
      "utf8",
    );
    const form = confirm.slice(confirm.indexOf("<form"), confirm.indexOf("<dl"));
    expect(form).not.toContain('{#if targetFilter !== "all"}');
  });

  it("still counts the actions aimed outside the target narrowing", () => {
    const executable = [
      action({ target: "claude" }),
      action({ target: "opencode" }),
      action({ target: "opencode" }),
    ];
    expect(actionsOutsideTarget(executable, "claude")).toBe(2);
    expect(actionsOutsideTarget(executable, "all")).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Focus after a modal write                                           */
/* ------------------------------------------------------------------ */

describe("the refocus after a removal", () => {
  /** Replay one flush sequence, returning the steps where focus would move. */
  function replay(steps: readonly { busy: boolean; pending: boolean }[]): number[] {
    let previous = false;
    const fired: number[] = [];
    steps.forEach((step, index) => {
      const next = stepRemovalFocus(previous, step.busy, step.pending);
      previous = next.inFlight;
      if (next.finished) fired.push(index);
    });
    return fired;
  }

  it("fires once when a removal that succeeded finishes", () => {
    // The exact flush sequence `Session.confirmRemove` produces: it clears
    // `pendingRemoval` *before* awaiting the re-survey, so the middle flush sees
    // busy with nothing pending. The old rule recomputed the bit from scratch
    // there, went false, and the last flush no longer knew a removal had run —
    // focus stayed on the deleted row's trash button, i.e. on `<body>`.
    expect(
      replay([
        { busy: true, pending: true },
        { busy: true, pending: false },
        { busy: false, pending: false },
      ]),
    ).toEqual([2]);
  });

  it("fires when the removal fails, so focus is never stranded either way", () => {
    expect(
      replay([
        { busy: true, pending: true },
        { busy: false, pending: false },
      ]),
    ).toEqual([1]);
  });

  it("stays out of the way of an enable/disable toggle", () => {
    // A toggle is also `assetBusy`, but it has no dialog and no vanished row,
    // so the browser's own focus restoration is correct and must be left alone.
    expect(
      replay([
        { busy: true, pending: false },
        { busy: false, pending: false },
      ]),
    ).toEqual([]);
  });

  it("does not fire while nothing is happening", () => {
    expect(
      replay([
        { busy: false, pending: false },
        { busy: false, pending: false },
      ]),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* SPEC §9.6 — the preview builds its LCS table once                   */
/* ------------------------------------------------------------------ */

describe("diffSummary", () => {
  const before = ["a", "b", "c", "d"].join("\n");
  const after = ["a", "x", "c", "d", "e"].join("\n");

  it("returns exactly what the two separate calls did", () => {
    const raw = diffLines(before, after);
    expect(diffSummary(before, after)).toEqual({
      lines: collapseDiff(raw),
      stat: diffStat(raw),
    });
  });

  it("counts the whole diff, not just the lines that survived collapsing", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const changed = [...long];
    changed[0] = "changed";
    changed[39] = "changed too";
    const summary = diffSummary(long.join("\n"), changed.join("\n"));
    expect(summary.stat).toEqual({ added: 2, removed: 2 });
    // …while the rendered lines are collapsed around the changes.
    expect(summary.lines.some((l) => l.kind === "gap")).toBe(true);
  });

  it("handles a create and a delete, where one side does not exist", () => {
    expect(diffSummary(undefined, "a\nb").stat).toEqual({ added: 2, removed: 0 });
    expect(diffSummary("a\nb", undefined).stat).toEqual({ added: 0, removed: 2 });
  });

  it("is what the preview component uses, so the table is built once", () => {
    // The cost this replaces: two full (a+1)×(b+1) LCS tables per action — up
    // to 16 million cells each at the engine's own ceilings — allocated on the
    // UI thread for every action in the confirmation dialog at once.
    const preview = fs.readFileSync(
      new URL("../ui/src/lib/DiffPreview.svelte", import.meta.url),
      "utf8",
    );
    expect(preview).toContain("diffSummary(");
    expect(preview.match(/diffLines\(/g) ?? []).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* The live region is not stuck on an old asset result                 */
/* ------------------------------------------------------------------ */

describe("the announcement's asset result", () => {
  const session = fs.readFileSync(
    new URL("../ui/src/lib/session.svelte.ts", import.meta.url),
    "utf8",
  );

  /** The body of one method, up to its closing brace at method indentation. */
  function methodBody(name: string): string {
    const start = session.indexOf(`${name}(`);
    expect(start).toBeGreaterThan(-1);
    const rest = session.slice(start);
    const end = rest.indexOf("\n  }\n");
    return rest.slice(0, end === -1 ? rest.length : end);
  }

  it("is cleared by every operation that starts", () => {
    // `lastAssetResult` is announced ahead of the survey and diff results
    // (App.svelte), and nothing ever cleared it. One toggle, and 差分を取る
    // announced 「foo を有効にしました。」 on every press for the rest of the
    // session — resurrecting the 「差分を取ったのに無音」 defect the live region
    // was rewritten to close, and saying something false while doing it.
    // `survey()` is the coalescing wrapper; `readMachine()` is the pass that
    // actually reads, and each pass has to clear the result — a queued re-run
    // is a new reading and so a new announcement.
    expect(methodBody("async readMachine")).toContain('this.lastAssetResult = ""');
    expect(methodBody("async diff")).toContain('this.lastAssetResult = ""');
    expect(methodBody("clearPlan")).toContain('this.lastAssetResult = ""');
  });

  it("never lets a write's own re-read be skipped by the re-entry guard", () => {
    // `setEnabled`/`confirmRemove` await `survey()` *because* they just wrote:
    // the row on screen has to be one the engine reported afterwards. An early
    // `return` when another survey was in flight handed them a reading that
    // had started before their write, and they announced 「有効にしました」 over
    // a table still showing the old state. A call that arrives during a read
    // queues one more pass and waits for it instead.
    const body = methodBody("async survey");
    expect(body).not.toContain('if (this.surveyStatus === "running") return;');
    expect(body).toContain("this.surveyAgain = true");
    expect(body).toContain("return this.surveyRun");
    expect(body).toContain("while (this.surveyAgain)");
  });

  it("is set after the re-survey, not before it", () => {
    for (const name of ["async setEnabled", "async confirmRemove"]) {
      const text = methodBody(name);
      const survey = text.indexOf("await this.survey()");
      const assign = text.indexOf("this.lastAssetResult =");
      expect(survey).toBeGreaterThan(-1);
      expect(assign).toBeGreaterThan(survey);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The server's API speaks the same vocabulary as the engine           */
/* ------------------------------------------------------------------ */

/*
 * Formerly checked against `src-tauri/src/engine.rs`. The Tauri shell is gone
 * (ARCHITECTURE.md「am から引き継いだもの」) and its hand-maintained lists now live in
 * `src/server/vocabulary.ts`, which the HTTP API validates every argv against.
 * The pincer is the same: the API half is hand-kept, the engine derives its own
 * from `ASSET_KIND_IDS` / `TARGET_IDS`, and these tests fail the moment they
 * disagree.
 */
describe("the GUI bridge's argument vocabulary", () => {
  /**
   * `command` arrived with SPEC §10.5 and never reached the Rust bridge: every
   * toggle and delete on the console's COMMANDS tab was refused before the
   * engine was started, while the same command worked from the terminal.
   */
  it("accepts every asset kind the engine has", () => {
    expect([...ASSET_KINDS].sort()).toEqual([...ASSET_KIND_IDS].sort());
  });

  it("accepts every target id the engine has", () => {
    expect([...TARGETS].sort()).toEqual([...TARGET_IDS].sort());
  });

  it("keeps every asset kind reachable from a row the table actually draws", () => {
    // `ASSET_TABS` is what puts a row on screen, and `AssetTable` draws the
    // toggle and the trash button on every row whatever its kind.
    for (const tab of ASSET_TABS) {
      expect(ASSET_KINDS as readonly string[]).toContain(tab.type);
      for (const command of ["enable", "disable"]) {
        expect(validateArgs([command, tab.type, "demo-asset"]).ok).toBe(true);
      }
      expect(validateArgs(["remove", tab.type, "demo-asset", "--yes"]).ok).toBe(true);
    }
  });
});
