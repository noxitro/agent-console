/**
 * The API's fixed vocabulary — the tests of the former desktop shell's
 * (`validate_args`) carried over to TypeScript, so the guard that used to need
 * `cargo test` now runs with the rest of the suite.
 */

import { describe, expect, it } from "vitest";

import { ASSET_KIND_IDS, TARGET_IDS } from "../core/model.js";
import {
  ASSET_COMMANDS,
  ASSET_KINDS,
  boundPlanArgs,
  COMMANDS,
  isWrite,
  planArgsOf,
  TARGETS,
  validateArgs,
  WRITE_COMMANDS,
} from "./vocabulary.js";

const ok = (args: unknown): boolean => validateArgs(args).ok;

describe("the API vocabulary (ported from the former desktop shell)", () => {
  it("accepts every documented command, and every asset kind for the three that take one", () => {
    for (const command of COMMANDS) {
      if (ASSET_COMMANDS.includes(command)) {
        for (const kind of ASSET_KINDS) expect(ok([command, kind, "demo-asset"]), `${command} ${kind}`).toBe(true);
      } else {
        expect(ok([command]), command).toBe(true);
      }
    }
  });

  it("keeps the asset commands reachable from the GUI (SPEC §9.2 / §10.5)", () => {
    expect(ok(["enable", "mcp", "docs"])).toBe(true);
    expect(ok(["disable", "agent", "code-reviewer"])).toBe(true);
    expect(ok(["remove", "skill", "demo-skill", "--yes"])).toBe(true);
    expect(ok(["enable", "command", "run-task"])).toBe(true);
    expect(ok(["disable", "command", "run-task"])).toBe(true);
    expect(ok(["remove", "command", "run-task", "--yes"])).toBe(true);
  });

  it("covers every kind and target the engine has (the hand-kept half of the pincer)", () => {
    expect([...ASSET_KINDS].sort()).toEqual([...ASSET_KIND_IDS].sort());
    expect([...TARGETS].sort()).toEqual([...TARGET_IDS].sort());
  });

  it("needs a known kind and a name for an asset command", () => {
    expect(ok(["enable"])).toBe(false);
    expect(ok(["enable", "skill"])).toBe(false);
    expect(ok(["enable", "widget", "x"])).toBe(false);
  });

  it("holds an asset name to a charset", () => {
    expect(ok(["remove", "skill", "--yes"])).toBe(false);
    expect(ok(["remove", "skill", "../evil"])).toBe(false);
    expect(ok(["remove", "skill", "a b"])).toBe(false);
    expect(ok(["remove", "skill", "a&calc"])).toBe(false);
    expect(ok(["remove", "skill", "x".repeat(65)])).toBe(false);
    expect(ok(["remove", "skill", "x".repeat(64)])).toBe(true);
    expect(ok(["remove", "mcp", "server.one_two-3"])).toBe(true);
  });

  it("refuses an unknown command, an empty argv and a non-array", () => {
    expect(ok(["rm"])).toBe(false);
    expect(ok([])).toBe(false);
    expect(ok("inventory")).toBe(false);
    expect(ok([1])).toBe(false);
    expect(ok(null)).toBe(false);
  });

  it("refuses an unknown flag, and --json (the server appends it)", () => {
    expect(ok(["plan", "--exec"])).toBe(false);
    expect(ok(["plan", "--json"])).toBe(false);
  });

  it("requires a known target for --prefer", () => {
    for (const target of TARGETS) expect(ok(["import", "--prefer", target]), target).toBe(true);
    expect(ok(["import", "--prefer", "opencode"])).toBe(true);
    expect(ok(["import", "--prefer", "nope"])).toBe(false);
    expect(ok(["import", "--prefer"])).toBe(false);
  });

  it("refuses an argv longer than any the GUI builds", () => {
    expect(ok(["plan", "--prune", "--prune", "--prune", "--prune", "--prune", "--prune", "--prune", "--prune"])).toBe(false);
  });

  it("classifies writes exactly as SPEC §9.5 does; apply --dry-run is a read", () => {
    for (const command of ["apply", "import", "remove", "enable", "disable"]) {
      expect(WRITE_COMMANDS).toContain(command);
    }
    expect(isWrite(["apply", "--yes"])).toBe(true);
    expect(isWrite(["apply", "--dry-run"])).toBe(false);
    for (const command of ["inventory", "doctor", "plan"]) expect(isWrite([command])).toBe(false);
  });

  it("binds apply to the plan with the same --prune", () => {
    expect(boundPlanArgs(["apply", "--yes"])).toEqual(["plan"]);
    expect(boundPlanArgs(["apply", "--prune", "--yes"])).toEqual(["plan", "--prune"]);
    expect(boundPlanArgs(["apply", "--dry-run"])).toBeNull();
    expect(boundPlanArgs(["remove", "skill", "x", "--yes"])).toBeNull();
    expect(planArgsOf(["plan", "--prune"])).toEqual(["plan", "--prune"]);
    // A dry-run answers in the apply-report shape, so its digest could never
    // match a fresh plan's: it carries none.
    expect(planArgsOf(["apply", "--dry-run"])).toBeNull();
    expect(planArgsOf(["inventory"])).toBeNull();
  });
});
