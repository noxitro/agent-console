import { describe, expect, it } from "vitest";

import {
  AmError,
  TARGET_IDS,
  agentsForTarget,
  isTargetId,
  isTransport,
  isValidAssetName,
  resolveTargets,
  serversForTarget,
  skillsForDelivery,
  type AgentDef,
  type McpServer,
  type SkillRef,
} from "./model.js";

describe("target / transport vocabulary", () => {
  it("lists the five targets from SPEC §1 + §10", () => {
    expect([...TARGET_IDS]).toEqual([
      "claude",
      "copilot-cli",
      "vscode",
      "vs2026",
      "opencode",
    ]);
  });

  it("validates target ids", () => {
    expect(isTargetId("claude")).toBe(true);
    expect(isTargetId("emacs")).toBe(false);
    expect(isTargetId(1)).toBe(false);
  });

  it("validates the normalized transport vocabulary", () => {
    expect(isTransport("stdio")).toBe(true);
    expect(isTransport("http")).toBe(true);
    expect(isTransport("sse")).toBe(true);
    expect(isTransport("local")).toBe(false);
  });
});

describe("resolveTargets", () => {
  const enabled = ["claude", "copilot-cli", "vscode"] as const;

  it("returns all enabled targets when targets is omitted (SPEC §3)", () => {
    expect(resolveTargets(undefined, enabled)).toEqual([...enabled]);
  });

  it("intersects an explicit list with the enabled set", () => {
    expect(resolveTargets(["claude", "vs2026"], enabled)).toEqual(["claude"]);
  });

  it("returns an empty list when nothing intersects", () => {
    expect(resolveTargets(["vs2026"], enabled)).toEqual([]);
  });
});

describe("serversForTarget", () => {
  const servers: Record<string, McpServer> = {
    zeta: { transport: "stdio", command: "npx" },
    alpha: { transport: "http", url: "https://x", targets: ["vscode"] },
  };
  const enabled = ["claude", "vscode"] as const;

  it("includes servers without an explicit targets list", () => {
    expect(Object.keys(serversForTarget(servers, "claude", enabled))).toEqual(["zeta"]);
  });

  it("honours an explicit targets list", () => {
    expect(Object.keys(serversForTarget(servers, "vscode", enabled)).sort()).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("returns keys in sorted order for deterministic rendering", () => {
    expect(Object.keys(serversForTarget(servers, "vscode", enabled))).toEqual(["alpha", "zeta"]);
  });
});

describe("agentsForTarget", () => {
  const agents: AgentDef[] = [
    { name: "zebra", description: "d", body: "b" },
    { name: "alpha", description: "d", targets: ["vs2026"], body: "b" },
  ];

  it("filters and sorts by name", () => {
    expect(agentsForTarget(agents, "claude", ["claude", "vs2026"]).map((a) => a.name)).toEqual([
      "zebra",
    ]);
    expect(agentsForTarget(agents, "vs2026", ["claude", "vs2026"]).map((a) => a.name)).toEqual([
      "alpha",
      "zebra",
    ]);
  });
});

describe("skillsForDelivery", () => {
  const skills: SkillRef[] = [
    { name: "beta", sourcePath: "b" },
    { name: "alpha", sourcePath: "a" },
    { name: "secret", sourcePath: "s" },
  ];

  it("drops excluded skills and sorts the rest", () => {
    expect(skillsForDelivery(skills, ["secret"]).map((s) => s.name)).toEqual(["alpha", "beta"]);
  });

  it("keeps everything when exclude is empty", () => {
    expect(skillsForDelivery(skills, [])).toHaveLength(3);
  });
});

describe("isValidAssetName (SPEC §3)", () => {
  it("accepts lowercase-hyphen names", () => {
    expect(isValidAssetName("code-reviewer")).toBe(true);
    expect(isValidAssetName("a1")).toBe(true);
  });

  it("rejects uppercase, underscores, spaces, and edge hyphens", () => {
    for (const bad of ["Code", "a_b", "a b", "-a", "a-", "a--b", ""]) {
      expect(isValidAssetName(bad)).toBe(false);
    }
  });

  it("rejects names longer than 64 characters", () => {
    expect(isValidAssetName("a".repeat(64))).toBe(true);
    expect(isValidAssetName("a".repeat(65))).toBe(false);
  });
});

describe("AmError", () => {
  it("carries the offending path", () => {
    const err = new AmError("boom", { path: "C:\\x.json" });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AmError");
    expect(err.path).toBe("C:\\x.json");
  });

  it("path is undefined when not provided", () => {
    expect(new AmError("boom").path).toBeUndefined();
  });
});
