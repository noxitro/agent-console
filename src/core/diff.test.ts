import { describe, expect, it } from "vitest";

import {
  diffFiles,
  diffSkills,
  driftAction,
  hasChanges,
  hasDrift,
  isExecutable,
  mergeActions,
  planExitCode,
  sortActions,
  summarizeActions,
  unsupportedAction,
  type Action,
  type SkillDiffEntry,
} from "./diff.js";
import type { SkillLink } from "./model.js";

const A = "C:\\home\\.claude\\agents\\a.md";
const B = "C:\\home\\.claude\\agents\\b.md";

describe("diffFiles", () => {
  it("reports create for a file absent from the target", () => {
    const actions = diffFiles({
      target: "claude",
      asset: "agent",
      desired: [{ path: A, content: "x" }],
      actual: [{ path: A, content: null }],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("create");
    expect(actions[0]?.content).toBe("x");
  });

  it("treats an unlisted path as absent", () => {
    const actions = diffFiles({
      target: "claude",
      asset: "agent",
      desired: [{ path: A, content: "x" }],
      actual: [],
    });
    expect(actions[0]?.kind).toBe("create");
  });

  it("reports update when content differs", () => {
    const actions = diffFiles({
      target: "claude",
      asset: "agent",
      desired: [{ path: A, content: "new" }],
      actual: [{ path: A, content: "old" }],
    });
    expect(actions[0]?.kind).toBe("update");
  });

  it("reports nothing when content matches", () => {
    const actions = diffFiles({
      target: "claude",
      asset: "agent",
      desired: [{ path: A, content: "same" }],
      actual: [{ path: A, content: "same" }],
    });
    expect(actions).toEqual([]);
    expect(planExitCode(actions)).toBe(0);
  });

  it("matches paths case-insensitively and across separators (Windows)", () => {
    const actions = diffFiles({
      target: "claude",
      asset: "agent",
      desired: [{ path: "C:\\Home\\A.md", content: "same" }],
      actual: [{ path: "c:/home/a.md", content: "same" }],
    });
    expect(actions).toEqual([]);
  });

  it("ignores target-only files unless reportDeletes is set", () => {
    const input = {
      target: "claude" as const,
      asset: "agent" as const,
      desired: [{ path: A, content: "x" }],
      actual: [
        { path: A, content: "x" },
        { path: B, content: "stale" },
      ],
    };
    expect(diffFiles(input)).toEqual([]);
    const withDeletes = diffFiles({ ...input, reportDeletes: true });
    expect(withDeletes).toHaveLength(1);
    expect(withDeletes[0]?.kind).toBe("delete");
    expect(withDeletes[0]?.path).toBe(B);
  });

  it("does not report delete for a path that does not exist", () => {
    const actions = diffFiles({
      target: "claude",
      asset: "agent",
      desired: [],
      actual: [{ path: B, content: null }],
      reportDeletes: true,
    });
    expect(actions).toEqual([]);
  });

  it("uses nameOf for display names", () => {
    const actions = diffFiles({
      target: "claude",
      asset: "agent",
      desired: [{ path: A, content: "x" }],
      actual: [],
      nameOf: () => "alpha",
    });
    expect(actions[0]?.name).toBe("alpha");
  });
});

/* ------------------------------------------------------------------ */

const SRC = "C:\\home\\.agents\\skills\\demo";
const DST = "C:\\home\\.claude\\skills\\demo";

function link(kind: SkillLink["kind"], linkTarget?: string): SkillLink {
  const l: SkillLink = { name: "demo", path: DST, kind };
  if (linkTarget !== undefined) l.linkTarget = linkTarget;
  return l;
}

function entry(overrides: Partial<SkillDiffEntry> & { link: SkillLink }): SkillDiffEntry {
  return { name: "demo", sourcePath: SRC, targetPath: DST, ...overrides };
}

describe("diffSkills (SPEC §6.6)", () => {
  it("plans a link when nothing is there", () => {
    const actions = diffSkills({
      target: "claude",
      linkMode: "junction",
      entries: [entry({ link: link("missing") })],
    });
    expect(actions[0]?.kind).toBe("link");
    expect(actions[0]?.sourcePath).toBe(SRC);
    expect(actions[0]?.linkMode).toBe("junction");
  });

  /*
   * SPEC §9.7 — the slot could not be read, so nothing may be written over it.
   * Before this, `lstat` failing with EACCES arrived here as `missing` and the
   * plan proposed a junction over whatever is actually sitting there: a write
   * derived from a reading nobody was able to take.
   */
  it("refuses rather than plans when the slot could not be read", () => {
    const unreadable: SkillLink = {
      name: "demo",
      path: DST,
      kind: "unreadable",
      unreadable: "EACCES: permission denied, lstat",
    };
    const actions = diffSkills({
      target: "claude",
      linkMode: "junction",
      entries: [entry({ link: unreadable })],
    });
    // `drift` is what `apply` refuses on (SPEC §6.6) — the same treatment an
    // incomparable physical copy gets, for the same reason.
    expect(actions[0]?.kind).toBe("drift");
    expect(actions.some((a) => a.kind === "link")).toBe(false);
    // The engine's own reason travels with it; the console prints it verbatim.
    expect(actions[0]?.detail).toContain("EACCES");
  });

  it("is a no-op for a junction already pointing at the source", () => {
    const actions = diffSkills({
      target: "claude",
      linkMode: "junction",
      entries: [entry({ link: link("junction", SRC), linkResolvesToSource: true })],
    });
    expect(actions).toEqual([]);
  });

  it("updates a junction pointing somewhere else", () => {
    const actions = diffSkills({
      target: "claude",
      linkMode: "junction",
      entries: [
        entry({ link: link("junction", "C:\\elsewhere"), linkResolvesToSource: false }),
      ],
    });
    expect(actions[0]?.kind).toBe("update");
    expect(actions[0]?.detail).toContain("C:\\elsewhere");
  });

  it("updates a broken link", () => {
    const actions = diffSkills({
      target: "claude",
      linkMode: "junction",
      entries: [entry({ link: link("broken", "C:\\gone") })],
    });
    expect(actions[0]?.kind).toBe("update");
    expect(actions[0]?.detail).toContain("broken link");
  });

  it("replaces an identical physical copy with a junction", () => {
    const actions = diffSkills({
      target: "claude",
      linkMode: "junction",
      entries: [entry({ link: link("directory"), contentIdentical: true })],
    });
    expect(actions[0]?.kind).toBe("link");
    expect(actions[0]?.detail).toContain("back up");
  });

  it("reports drift for a divergent physical copy instead of replacing it", () => {
    const actions = diffSkills({
      target: "claude",
      linkMode: "junction",
      entries: [entry({ link: link("directory"), contentIdentical: false })],
    });
    expect(actions[0]?.kind).toBe("drift");
    expect(hasDrift(actions)).toBe(true);
    expect(isExecutable(actions[0] as Action, { prune: true })).toBe(false);
  });

  it("reports a tree it could not hash as drift that says so (SPEC §9.5)", () => {
    for (const linkMode of ["junction", "copy"] as const) {
      const actions = diffSkills({
        target: "claude",
        linkMode,
        entries: [
          entry({ link: link("directory"), contentIncomparable: "more than 5000 files under X" }),
        ],
      });
      expect(actions[0]?.kind).toBe("drift");
      // Not "differs": the detail has to name the reason the comparison did
      // not happen, so the finding is neither a silent success nor a silent
      // failure.
      expect(actions[0]?.detail).toContain("could not be compared");
      expect(actions[0]?.detail).toContain("5000 files");
    }
  });

  it("treats an unknown-content directory as drift (fail closed)", () => {
    const actions = diffSkills({
      target: "claude",
      linkMode: "junction",
      entries: [entry({ link: link("directory") })],
    });
    expect(actions[0]?.kind).toBe("drift");
  });

  it("reports drift when a file occupies the skill path", () => {
    const actions = diffSkills({
      target: "claude",
      linkMode: "junction",
      entries: [entry({ link: link("file") })],
    });
    expect(actions[0]?.kind).toBe("drift");
  });

  it("under copy mode, an identical directory is a no-op", () => {
    const actions = diffSkills({
      target: "claude",
      linkMode: "copy",
      entries: [entry({ link: link("directory"), contentIdentical: true })],
    });
    expect(actions).toEqual([]);
  });

  it("under copy mode, a divergent directory is an update, not drift", () => {
    const actions = diffSkills({
      target: "claude",
      linkMode: "copy",
      entries: [entry({ link: link("directory"), contentIdentical: false })],
    });
    expect(actions[0]?.kind).toBe("update");
  });

  it("under copy mode, an existing junction is converted", () => {
    const actions = diffSkills({
      target: "claude",
      linkMode: "copy",
      entries: [entry({ link: link("junction", SRC), linkResolvesToSource: true })],
    });
    expect(actions[0]?.kind).toBe("update");
    expect(actions[0]?.detail).toContain("physical copy");
  });

  it("reports orphaned target skills as delete", () => {
    const actions = diffSkills({
      target: "claude",
      linkMode: "junction",
      entries: [],
      orphans: [{ name: "gone", path: "C:\\home\\.claude\\skills\\gone", kind: "directory" }],
    });
    expect(actions[0]?.kind).toBe("delete");
    expect(actions[0]?.name).toBe("gone");
  });
});

/* ------------------------------------------------------------------ */

describe("action helpers", () => {
  it("isExecutable gates delete behind prune and blocks drift/unsupported", () => {
    const del = { kind: "delete", target: "claude", asset: "agent", path: A, detail: "" } as Action;
    expect(isExecutable(del)).toBe(false);
    expect(isExecutable(del, { prune: true })).toBe(true);
    expect(isExecutable(driftAction("claude", "skill", A, "d"))).toBe(false);
    expect(isExecutable(unsupportedAction("vs2026", "mcp", "no spec"), { prune: true })).toBe(false);
  });

  it("hasChanges ignores unsupported-only results", () => {
    const actions = [unsupportedAction("vs2026", "mcp", "v1 does not support MCP for vs2026")];
    expect(hasChanges(actions)).toBe(false);
    expect(planExitCode(actions)).toBe(0);
  });

  it("hasChanges is true for a drift-only result", () => {
    expect(hasChanges([driftAction("claude", "skill", DST, "d")])).toBe(true);
    expect(planExitCode([driftAction("claude", "skill", DST, "d")])).toBe(1);
  });

  it("sortActions orders by target, then asset, then kind", () => {
    const unsorted: Action[] = [
      { kind: "update", target: "vscode", asset: "mcp", path: "z", detail: "" },
      { kind: "create", target: "claude", asset: "agent", path: "b", detail: "" },
      { kind: "link", target: "claude", asset: "skill", path: "a", detail: "" },
    ];
    expect(sortActions(unsorted).map((a) => `${a.target}:${a.asset}`)).toEqual([
      "claude:skill",
      "claude:agent",
      "vscode:mcp",
    ]);
  });

  it("mergeActions concatenates and sorts", () => {
    const merged = mergeActions(
      [{ kind: "update", target: "vscode", asset: "mcp", path: "z", detail: "" }],
      [{ kind: "create", target: "claude", asset: "agent", path: "b", detail: "" }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]?.target).toBe("claude");
  });

  it("summarizeActions counts each kind", () => {
    const summary = summarizeActions([
      { kind: "create", target: "claude", asset: "agent", path: "a", detail: "" },
      { kind: "create", target: "claude", asset: "agent", path: "b", detail: "" },
      driftAction("claude", "skill", DST, "d"),
    ]);
    expect(summary.create).toBe(2);
    expect(summary.drift).toBe(1);
    expect(summary.update).toBe(0);
  });

  it("omits undefined optional keys from constructed actions", () => {
    const actions = diffFiles({
      target: "claude",
      asset: "agent",
      desired: [{ path: A, content: "x" }],
      actual: [],
    });
    expect(Object.keys(actions[0] as Action)).not.toContain("name");
    expect(Object.keys(actions[0] as Action)).not.toContain("sourcePath");
  });
});
