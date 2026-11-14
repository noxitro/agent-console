/**
 * The Installed view's arithmetic (ui/src/lib/installed-view.ts): sections in
 * the Copilot app's order, the second line that says where a row came from,
 * per-section cost counted the engine's way, and section-to-section keys.
 */

import { describe, expect, it } from "vitest";

import {
  headlineState,
  isUnconfirmed,
  kindCounts,
  matchesQuery,
  nextSectionStart,
  originLine,
  sectionCost,
  sectionStarts,
  sections,
} from "../ui/src/lib/installed-view.js";
import { fixtureInstalled, newScopeMachine } from "../ui/src/lib/scope-fixtures.js";
import type { InstalledRow } from "../ui/src/lib/scope-contract.js";

const project = fixtureInstalled(newScopeMachine(), "a1b2c3d4e5f6");
const byName = (name: string, kind?: string): InstalledRow => project.rows.find((r) => r.name === name && (kind === undefined || r.kind === kind))!;

describe("sections", () => {
  it("are Plugins, MCP Servers, Skills, Agents, Commands, 指示ファイル, and empty ones are left out", () => {
    expect(sections(project.rows).map((s) => s.kind)).toEqual(["plugin", "mcp", "skill", "agent", "command", "instructions"]);
    expect(sections(project.rows.filter((r) => r.kind === "skill")).map((s) => s.kind)).toEqual(["skill"]);
    const counts = kindCounts(project.rows);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(project.rows.length);
  });
});

describe("the second line: where a row came from", () => {
  it("names the plugin for a part, the marketplace for a plugin, the unit otherwise", () => {
    expect(originLine(byName("paper-search"), "orbit-web")).toBe("Plugin: research-kit");
    expect(originLine(byName("research-kit@team-market"), "orbit-web")).toBe("Marketplace: team-market");
    expect(originLine(byName("design-kit@demo-market"), "orbit-web")).toBe("Marketplace: demo-market · プロジェクト: orbit-web");
    expect(originLine(byName("db-read"), "orbit-web")).toBe("プロジェクト: orbit-web");
    expect(originLine(byName("scratch-db"), "orbit-web")).toBe("ローカル");
    expect(originLine(byName("release-notes"), undefined)).toBe("個人");
  });

  it("finds a part by its plugin's name", () => {
    expect(matchesQuery(byName("cite-sources"), "research-kit")).toBe(true);
    expect(matchesQuery(byName("release-notes"), "research-kit")).toBe(false);
  });

  it("marks a name held in two units on both rows, and an unconfirmed location", () => {
    expect(project.rows.filter((r) => r.name === "reviewer").map((r) => r.alsoIn)).toEqual([["project"], ["user"]]);
    const dotClaude = project.rows.find((r) => r.id === "instructions:project:dot-claude")!;
    expect(isUnconfirmed(dotClaude)).toBe(true);
    expect(headlineState(dotClaude, "copilot")).toBe("unconfirmed");
    expect(headlineState(byName("release-notes"), "claude")).toBe("enabled");
  });
});

describe("section cost", () => {
  it("counts a plugin's parts on the plugin, not twice", () => {
    const plugins = project.rows.filter((r) => r.kind === "plugin");
    const mcp = project.rows.filter((r) => r.kind === "mcp");
    expect(sectionCost(plugins, "copilot").chars).toBe(214);
    // paper-search (a part) is enabled but its cost is the plugin's.
    expect(sectionCost(mcp, "copilot")).toEqual({ chars: 0, tokens: 0, unmeasured: 1 });
    expect(sectionCost(mcp, "claude").unmeasured).toBe(2);
  });

  it("adds up, over all sections, to the engine's per-unit totals", () => {
    for (const harness of ["claude", "copilot"] as const) {
      const bySection = sections(project.rows).reduce((n, s) => n + sectionCost(s.rows, harness).chars, 0);
      const byUnit = project.totals.filter((t) => t.harness === harness).reduce((n, t) => n + t.chars, 0);
      expect(bySection).toBe(byUnit);
    }
  });
});

describe("PageDown / PageUp move between sections", () => {
  const starts = sectionStarts([
    { kind: "plugin", rows: [byName("lint-pack@demo-market"), byName("research-kit@team-market")] },
    { kind: "mcp", rows: [byName("db-read")] },
    { kind: "skill", rows: [byName("release-notes"), byName("diagram-kit"), byName("web-capture")] },
  ]);

  it("to the next section's first row, clamped at the last", () => {
    expect(starts).toEqual([0, 2, 3]);
    expect(nextSectionStart("PageDown", 0, starts)).toBe(2);
    expect(nextSectionStart("PageDown", 2, starts)).toBe(3);
    expect(nextSectionStart("PageDown", 4, starts)).toBe(3);
  });

  it("to this section's first row first, then the one before", () => {
    expect(nextSectionStart("PageUp", 4, starts)).toBe(3);
    expect(nextSectionStart("PageUp", 3, starts)).toBe(2);
    expect(nextSectionStart("PageUp", 0, starts)).toBe(0);
  });

  it("leave other keys alone", () => {
    expect(nextSectionStart("ArrowDown", 0, starts)).toBeNull();
    expect(nextSectionStart("PageDown", 0, [])).toBeNull();
  });
});
