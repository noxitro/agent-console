/**
 * The wiring sheet's arithmetic.
 *
 * `ui/src/lib/schematic.ts` is plain TypeScript with no Svelte in it, which is
 * the whole reason the drawing's geometry lives there: "does the sixth skill
 * row land on top of the mcp terminal?" should be a failing test, not something
 * the owner discovers by adding a skill to `~/.agents/skills` — the routine
 * operation this tool exists to perform.
 *
 * Two invariants are pinned here:
 *
 *  1. **Nothing collides at any skill count.** Every row, divider, terminal and
 *     block is derived from one number, so the sheet grows instead of
 *     overlapping itself.
 *  2. **One numbering.** The triangle flag on a conductor and the row number in
 *     変更票 come from a single function fed the engine's own action order, so
 *     the digit the owner cross-references means the same change in both views.
 */

import { describe, expect, it } from "vitest";

import type { Inventory, PlanAction, TargetId } from "../ui/src/lib/contract.js";
import {
  buildSchematic,
  geometry,
  omittedTargetsNote,
  revisionKey,
  revisionNumbers,
} from "../ui/src/lib/schematic.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Counts worth checking: empty, the reference sheet, and well past it. */
const COUNTS = [0, 1, 2, 5, 6, 7, 8, 12, 20, 40];

function inventoryWith(skillCount: number): Inventory {
  const skills = Array.from({ length: skillCount }, (_, i) => ({
    name: `skill-${String(i + 1).padStart(2, "0")}`,
    hasSkillMd: true,
    enabled: true,
  }));
  return {
    source: {
      root: "C:\\home\\test\\.agents-manager",
      manifestPresent: true,
      linkMode: "junction",
      skills,
      mcp: [],
      agents: [],
      commands: [],
    },
    targets: [
      {
        id: "claude",
        enabled: true,
        skillsDir: "C:\\home\\test\\.claude\\skills",
        mcpPath: "C:\\home\\test\\.claude.json",
        agentsDir: "C:\\home\\test\\.claude\\agents",
        commandsDir: "unsupported",
        skills: [],
        mcp: [],
        agents: [],
        commands: "unsupported",
      },
      {
        id: "copilot-cli",
        enabled: true,
        skillsDir: "C:\\home\\test\\.copilot\\skills",
        mcpPath: "C:\\home\\test\\.copilot\\mcp-config.json",
        agentsDir: "C:\\home\\test\\.copilot\\agents",
        commandsDir: "unsupported",
        skills: [],
        mcp: [],
        agents: [],
        commands: "unsupported",
      },
      {
        id: "vscode",
        enabled: true,
        skillsDir: "C:\\home\\test\\.agents\\skills",
        mcpPath: "C:\\home\\test\\AppData\\Roaming\\Code\\User\\mcp.json",
        agentsDir: "C:\\home\\test\\.agents\\agents",
        commandsDir: "unsupported",
        skills: [],
        mcp: [],
        agents: [],
        commands: "unsupported",
        sharesDiscoveryWith: "claude",
      },
      {
        id: "vs2026",
        enabled: true,
        skillsDir: "C:\\home\\test\\.agents\\skills",
        mcpPath: "unsupported",
        agentsDir: "C:\\home\\test\\.agents\\agents",
        commandsDir: "unsupported",
        skills: [],
        mcp: "unsupported",
        agents: [],
        commands: "unsupported",
        sharesDiscoveryWith: "claude",
      },
    ],
  };
}

function action(
  kind: PlanAction["kind"],
  target: TargetId,
  asset: string,
  assetType: PlanAction["assetType"] = "skill",
): PlanAction {
  return { kind, target, assetType, asset, path: `${target}\\${asset}`, detail: "" };
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

describe("sheet geometry grows with the skill count", () => {
  it.each(COUNTS)("keeps the source block's rows clear of its outlets (%i skills)", (count) => {
    const g = geometry(count);
    const lastRow = count > 0 ? g.skillY0 + (count - 1) * g.skillRowGap : -Infinity;

    // The divider closes the skill list: below every row, above both outlets.
    expect(lastRow).toBeLessThan(g.srcDividerY);
    expect(g.srcDividerY).toBeLessThan(g.srcMcpY);
    expect(g.srcMcpY).toBeLessThan(g.srcAgentY);
    // And the whole stack stays inside the block it is drawn in.
    expect(g.skillY0).toBeGreaterThan(g.source.y);
    expect(g.srcAgentY).toBeLessThan(g.source.y + g.source.h);
  });

  it.each(COUNTS)("stacks the four target blocks without overlap (%i skills)", (count) => {
    const g = geometry(count);
    const boxes = [...g.boxes];
    expect(boxes).toHaveLength(4);

    for (let i = 1; i < boxes.length; i += 1) {
      const above = boxes[i - 1];
      const below = boxes[i];
      expect(above).toBeDefined();
      expect(below).toBeDefined();
      if (above === undefined || below === undefined) continue;
      expect(above.top + above.height).toBeLessThanOrEqual(below.top);
    }

    // Nothing runs off the bottom edge of the sheet — neither the last block
    // nor the legend, which is what sets the sheet height at low skill counts.
    const last = boxes[boxes.length - 1];
    expect(last).toBeDefined();
    if (last !== undefined) expect(last.top + last.height).toBeLessThan(g.sheet.h);
    expect(g.legend.y + g.legend.h).toBeLessThan(g.sheet.h);
    for (const y of g.legend.rowY) expect(y).toBeLessThan(g.legend.y + g.legend.h);
  });

  it.each(COUNTS)("keeps every drawn pin inside its own block (%i skills)", (count) => {
    const schematic = buildSchematic(inventoryWith(count), null, null);

    for (const target of schematic.targets) {
      const top = target.y;
      const bottom = target.y + target.h;
      const mcp = target.terminals.find((t) => t.asset === "mcp");
      const agent = target.terminals.find((t) => t.asset === "agent");
      expect(mcp).toBeDefined();
      expect(agent).toBeDefined();
      if (mcp === undefined || agent === undefined) continue;

      // Skill rows start below the block's header rule (y + 38) and finish
      // above the mcp outlet. This is the collision the fixed layout had: at
      // six skills, row six landed exactly on the mcp terminal.
      for (const pin of target.pins) {
        expect(pin.at.y).toBeGreaterThan(top + 38);
        expect(pin.at.y).toBeLessThan(mcp.at.y);
      }
      expect(mcp.at.y).toBeLessThan(agent.at.y);
      expect(agent.at.y).toBeLessThan(bottom);

      // The same rule for every *labelled* row, not just the pin strip: the two
      // shared blocks (vscode / vs2026) carry no pins at all, and their three
      // rows were the ones drawn through the block title and its note.
      const rows = [...target.terminals].sort((a, b) => a.at.y - b.at.y);
      // Clearing the row above by a hair is not clearing it: the lettering is
      // ~12.5 sheet units tall, so consecutive rows need a real pitch.
      const PITCH = 14;
      let previous = top + 38;
      for (const row of rows) {
        expect(row.at.y - previous).toBeGreaterThanOrEqual(PITCH);
        previous = row.at.y;
      }
      expect(bottom - previous).toBeGreaterThanOrEqual(PITCH);
    }

    // The junction bundle grows with the strand count too, and stays on sheet.
    const j = schematic.junction;
    expect(j.y).toBeGreaterThan(0);
    expect(j.y + j.h).toBeLessThan(schematic.geometry.sheet.h);
  });

  it("draws the reference sheet at the proportion the direction was approved on", () => {
    // A landscape drafting sheet: wide enough that conductors get long runs and
    // break symbols get room, short enough that the 検印 stamp still shares the
    // screen. The floor moved from 2.3 to 2.2 when the two shared blocks stopped
    // overlapping their own titles and grew to three properly pitched rows.
    const five = geometry(5);
    expect(five.sheet.w / five.sheet.h).toBeGreaterThan(2.2);
    expect(five.sheet.w / five.sheet.h).toBeLessThan(2.9);
    // Past the reference count the sheet gets taller rather than denser.
    expect(geometry(12).sheet.h).toBeGreaterThan(five.sheet.h);
    expect(geometry(12).sheet.w).toBe(five.sheet.w);
  });
});

/* ------------------------------------------------------------------ */
/* Revision numbering                                                  */
/* ------------------------------------------------------------------ */

describe("revision numbering", () => {
  /**
   * The engine sorts by target → assetType → kind → path, so a `link` sorts
   * after an `update` regardless of the skill's name. A drawing that numbered
   * conductors in source (alphabetical) order would put flag 1 on "alpha" while
   * 変更票 row 01 was "zeta" — the owner reads the wrong change and then
   * confirms a write to live configuration.
   */
  const engineOrder: PlanAction[] = [
    action("update", "claude", "zeta"),
    action("link", "claude", "alpha"),
    action("link", "copilot-cli", "alpha"),
  ];

  it("follows the engine's action order, not the source's alphabetical order", () => {
    const numbers = revisionNumbers(engineOrder);
    expect(numbers.get(revisionKey("claude", "skill", "zeta"))).toBe(1);
    expect(numbers.get(revisionKey("claude", "skill", "alpha"))).toBe(2);
    expect(numbers.get(revisionKey("copilot-cli", "skill", "alpha"))).toBe(3);
  });

  it("hands the drawing the same digits the sheet lists", () => {
    // What 変更票 does: number the rows as they come off the engine.
    const rowNumbers = revisionNumbers(engineOrder);
    // What the drawing does: look each conductor up by identity.
    const schematic = buildSchematic(inventoryWith(0), null, { actions: engineOrder });
    const flagged = revisionNumbers(engineOrder);

    for (const [key, no] of rowNumbers) expect(flagged.get(key)).toBe(no);
    expect(schematic.geometry.sheet.w).toBeGreaterThan(0);
  });

  it("numbers only the conductors the drawing can flag", () => {
    const numbers = revisionNumbers([
      action("unsupported", "vs2026", "", "mcp"),
      action("update", "claude", "", "mcp"),
      action("drift", "claude", "beta"),
      action("link", "claude", "gamma"),
    ]);
    // `unsupported` and the file-backed assets get no number in either view;
    // `drift` does, because the drawing flags it as 要手当て on a conductor.
    expect(numbers.size).toBe(2);
    expect(numbers.get(revisionKey("claude", "skill", "beta"))).toBe(1);
    expect(numbers.get(revisionKey("claude", "skill", "gamma"))).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* SPEC §10 — the sheet's own scope                                    */
/* ------------------------------------------------------------------ */

describe("the map states what it does not draw", () => {
  /**
   * The sheet's proportion was approved at four blocks and SPEC §10 added a
   * fifth target. A demoted overview is allowed to be partial; it is not
   * allowed to be partial in silence, which would be the same failure as a
   * 「一致」 badge drawn with no plan behind it.
   */
  it("names a target the inventory reports and the sheet has no block for", () => {
    const inv = inventoryWith(3);
    inv.targets.push({
      id: "opencode",
      enabled: true,
      skillsDir: "unsupported",
      mcpPath: "C:\\home\\test\\.config\\opencode\\opencode.jsonc",
      agentsDir: "unsupported",
      commandsDir: "C:\\home\\test\\.config\\opencode\\command",
      skills: "unsupported",
      mcp: [],
      agents: "unsupported",
      commands: [],
    });

    const schematic = buildSchematic(inv, null, null);
    expect(schematic.targets.map((t) => t.id)).not.toContain("opencode");
    expect(schematic.omittedTargets).toEqual(["opencode"]);
    expect(omittedTargetsNote(schematic.omittedTargets)).toContain("opencode");
  });

  it("says nothing when the sheet is complete", () => {
    expect(buildSchematic(inventoryWith(5), null, null).omittedTargets).toEqual([]);
  });

  it("counts commands when deciding whether the source is empty", () => {
    // 「ソースに資産がありません。am import を実行してください」 over a source
    // holding two commands would be a false instruction.
    const inv = inventoryWith(0);
    expect(buildSchematic(inv, null, null).sourceEmpty).toBe(true);
    inv.source.commands = [{ name: "run-task", description: "Run it.", enabled: true }];
    expect(buildSchematic(inv, null, null).sourceEmpty).toBe(false);
  });
});
