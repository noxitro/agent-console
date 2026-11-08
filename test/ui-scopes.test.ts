/**
 * The console's side of the scope layer: rows, the scope narrowing, and why a
 * scope's list is empty — derived from the fixture machine, which carries one
 * example of every state the scope column draws.
 */

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DELIVERY_LABEL,
  describeNarrowings,
  emptyMessage,
  emptyReason,
  filterRows,
  filterScope,
  isUnmeasured,
  projectLabel,
  relatesToTarget,
  rowsFor,
  type AssetRow,
} from "../ui/src/lib/assets.js";
import type { Inventory, Scopes } from "../ui/src/lib/contract.js";
import { fixtureTransport } from "../ui/src/lib/fixtures.js";

async function machine(scenario: "machine" | "empty" = "machine"): Promise<{ inventory: Inventory; scopes: Scopes }> {
  const transport = fixtureTransport(scenario);
  const inventory = JSON.parse((await transport.run(["inventory"])).stdout) as Inventory;
  const scopes = JSON.parse((await transport.run(["scopes"])).stdout) as Scopes;
  return { inventory, scopes };
}

function find(rows: AssetRow[], name: string, scope: string): AssetRow {
  const row = rows.find((r) => r.name === name && r.scope === scope);
  if (row === undefined) throw new Error(`no ${scope} row ${name}`);
  return row;
}

describe("rows of every scope", () => {
  it("keeps the 個人 rows exactly as before when the scope layer is absent", async () => {
    const { inventory } = await machine();
    const rows = rowsFor("skill", inventory, null, null);
    expect(rows.every((r) => r.scope === "user" && r.key === r.name && !r.readOnly)).toBe(true);
    expect(rows.some((r) => r.scopePath !== undefined)).toBe(false);
  });

  it("adds project and local rows after the 個人 rows, each with its own key", async () => {
    const { inventory, scopes } = await machine();
    const rows = rowsFor("mcp", inventory, null, null, scopes);
    const project = find(rows, "postgres", "project");
    const local = find(rows, "postgres", "local");
    expect(project.key).not.toBe(local.key);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(project.readOnly && local.readOnly).toBe(true);
    expect(local.scopeEntry).toContain("projects[");
  });

  it("draws per target whether it reads the place, is overridden, or is unverified", async () => {
    const { inventory, scopes } = await machine();
    const skill = find(rowsFor("skill", inventory, null, null, scopes), "commit-message", "project");
    const state = (target: string) => skill.deliveries.find((d) => d.target === target)?.state;
    expect(state("claude")).toBe("shadowed");
    expect(state("copilot-cli")).toBe("present");
    // A target that does not read `.claude/skills` at all is not 未配布; it is outside.
    expect(state("vs2026")).toBe("outside");
    expect(skill.shadowedSomewhere).toBe(true);
    expect(skill.deliveries.find((d) => d.target === "claude")?.shadowedBy?.scope).toBe("user");

    const agent = find(rowsFor("agent", inventory, null, null, scopes), "code-reviewer", "project");
    expect(agent.deliveries.find((d) => d.target === "copilot-cli")?.state).toBe("unverified");
    expect(agent.unverified).toBe(true);
    expect(DELIVERY_LABEL.unverified).toContain("未確認");
  });

  it("marks a 個人 row that a project overrides, with the project named", async () => {
    const { inventory, scopes } = await machine();
    const user = find(rowsFor("agent", inventory, null, null, scopes), "code-reviewer", "user");
    expect(user.overriddenIn).toEqual([{ target: "claude", project: "C:\\work\\api-server", by: "project" }]);
    // Negative control: a 個人 row nobody overrides carries nothing.
    const other = find(rowsFor("skill", inventory, null, null, scopes), "test-runner", "user");
    expect(other.overriddenIn).toBeUndefined();
  });

  it("does not count a target that does not read a place as related to it", async () => {
    const { inventory, scopes } = await machine();
    const skill = find(rowsFor("skill", inventory, null, null, scopes), "deploy-check", "project");
    expect(relatesToTarget(skill, "copilot-cli")).toBe(true);
    expect(relatesToTarget(skill, "claude")).toBe(false);
  });
});

describe("the scope narrowing", () => {
  it("defaults to 個人, which is the console as it was", async () => {
    const { inventory, scopes } = await machine();
    const all = rowsFor("skill", inventory, null, null, scopes);
    const user = filterScope(all, "user");
    expect(user.map((r) => r.name)).toEqual(rowsFor("skill", inventory, null, null).map((r) => r.name));
    expect(filterScope(all, "all")).toHaveLength(all.length);
  });

  it("narrows the project and local scopes to one project, never hiding 個人 rows under すべて", async () => {
    const { inventory, scopes } = await machine();
    const all = rowsFor("skill", inventory, null, null, scopes);
    const web = filterScope(all, "project", "C:\\work\\web-app");
    expect(web.map((r) => r.name).sort()).toEqual(["commit-message", "deploy-check"]);
    expect(filterScope(all, "project", "C:\\work\\api-server")).toEqual([]);
    const mixed = filterScope(all, "all", "C:\\work\\api-server");
    expect(mixed.filter((r) => r.scope === "user")).toHaveLength(filterScope(all, "user").length);
  });

  it("composes with the target narrowing", async () => {
    const { inventory, scopes } = await machine();
    const project = filterScope(rowsFor("skill", inventory, null, null, scopes), "project");
    expect(filterRows(project, "", "all", "claude").map((r) => r.name)).toEqual(["commit-message"]);
  });

  it("names a non-default scope among the narrowings the confirmation lists", () => {
    expect(describeNarrowings("skill", "all", "all", "")).toEqual(["種別: SKILLS"]);
    expect(describeNarrowings("skill", "all", "all", "", "project", "C:\\x")).toEqual([
      "種別: SKILLS",
      "単位: プロジェクト",
      "プロジェクト: C:\\x",
    ]);
  });

  it("labels a project by its last folder", () => {
    expect(projectLabel("C:\\work\\web-app")).toBe("web-app");
    expect(projectLabel("/home/u/repo/")).toBe("repo");
  });
});

describe("why a scope's list is empty", () => {
  const base = {
    surveyStatus: "ready" as const,
    diffStatus: "idle" as const,
    total: 0,
    totalIgnoringTarget: 0,
    filter: "all" as const,
    targetFilter: "all" as const,
    hasPlan: false,
  };

  it("is not 「無い」 while the scope layer is unread or failed", () => {
    const reading = emptyReason({ ...base, scope: "project", scopesStatus: "running", projectCount: 0 });
    const failed = emptyReason({ ...base, scope: "local", scopesStatus: "failed", projectCount: 0 });
    expect(reading.kind).toBe("scopes-reading");
    expect(failed.kind).toBe("scopes-failed");
    expect(isUnmeasured(reading) && isUnmeasured(failed)).toBe(true);
  });

  it("tells no projects apart from a project with nothing of this kind", () => {
    expect(emptyReason({ ...base, scope: "project", scopesStatus: "ready", projectCount: 0 }).kind).toBe(
      "no-projects",
    );
    const none = emptyReason({ ...base, scope: "project", scopesStatus: "ready", projectCount: 2 });
    expect(none).toEqual({ kind: "none-in-scope", scope: "project" });
    expect(emptyMessage(none)).toContain("プロジェクト");
  });

  it("is unchanged under 個人 (negative control)", () => {
    expect(emptyReason({ ...base, scopesStatus: "failed", projectCount: 0 }).kind).toBe("none-of-kind");
  });
});

describe("read-only rows draw no write control", () => {
  const table = fs.readFileSync(new URL("../ui/src/lib/AssetTable.svelte", import.meta.url), "utf8");
  const detail = fs.readFileSync(new URL("../ui/src/lib/DetailPane.svelte", import.meta.url), "utf8");

  it("wraps the switch and the delete button in the table behind `readOnly`", () => {
    const body = table.slice(table.indexOf("<tbody>"), table.indexOf("</tbody>"));
    const guarded = body.slice(body.indexOf("{#if row.readOnly}"));
    expect(guarded.indexOf('role="switch"')).toBeGreaterThan(0);
    expect(body).toContain("{#if !row.readOnly}");
    expect(body.indexOf("{#if !row.readOnly}")).toBeLessThan(body.indexOf('name="trash"'));
  });

  it("does the same in the detail pane", () => {
    expect(detail).toContain("{#if row.readOnly}");
    expect(detail.indexOf("{#if !row.readOnly}\n    <footer") >= 0 || detail.includes("{#if !row.readOnly}\r\n    <footer")).toBe(true);
  });

  it("shows overrides as text on the row, not only in a tooltip", () => {
    expect(table).toContain("上書きされて効いていない");
    expect(table).toContain("プロジェクトで上書きあり");
  });
});

describe("the empty fixture scenario", () => {
  it("has no projects, so the project scope says so", async () => {
    const { scopes } = await machine("empty");
    expect(scopes.projects).toEqual([]);
  });
});
