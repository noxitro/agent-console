/**
 * The confirmation, checked against the report.
 *
 * `ConfirmApply` promises "以下の N 件を適用します" and `am apply` recomputes its
 * work from the live filesystem instead of replaying that list. These tests pin
 * the one guarantee the GUI can actually make about the gap: whatever the write
 * did that the dialog did not show gets named, and everything the dialog *did*
 * show stays quiet.
 */

import { describe, expect, it } from "vitest";

import type { AppliedAction, PlanAction, TargetId } from "../ui/src/lib/contract.js";
import { actionKey, unconfirmedActions } from "../ui/src/lib/reconcile.js";

function planned(
  kind: PlanAction["kind"],
  target: TargetId,
  asset: string,
  path = `${target}\\skills\\${asset}`,
): PlanAction {
  return { kind, target, assetType: "skill", asset, path, detail: "" };
}

function done(
  action: PlanAction,
  status: AppliedAction["status"] = "done",
): AppliedAction {
  return { ...action, status };
}

describe("unconfirmedActions", () => {
  const link = planned("link", "claude", "alpha");
  const update = planned("update", "copilot-cli", "beta");

  it("stays silent when the write is exactly what was confirmed", () => {
    expect(unconfirmedActions([link, update], [done(link), done(update)])).toEqual([]);
  });

  it("reports an action that appeared only at write time", () => {
    const surprise = planned("create", "claude", "gamma");
    const found = unconfirmedActions([link], [done(link), done(surprise)]);
    expect(found).toHaveLength(1);
    expect(found[0]?.asset).toBe("gamma");
  });

  it("reports an action whose kind changed between the plan and the write", () => {
    // The slot was empty when the plan was taken and holds a stale copy by the
    // time apply runs: same asset, same target, different work.
    const asPlanned = planned("link", "claude", "alpha");
    const asExecuted = planned("update", "claude", "alpha");
    const found = unconfirmedActions([asPlanned], [done(asExecuted)]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("update");
  });

  it("reports an action whose target path moved", () => {
    const elsewhere = planned("link", "claude", "alpha", "D:\\moved\\alpha");
    expect(unconfirmedActions([link], [done(elsewhere)])).toHaveLength(1);
  });

  it("ignores rows that changed nothing", () => {
    const skipped = done(planned("link", "claude", "delta"), "skipped");
    const failed = done(planned("link", "claude", "epsilon"), "failed");
    const drift = done(planned("drift", "claude", "zeta"));
    const unsupported = done(planned("unsupported", "vs2026", ""));
    expect(unconfirmedActions([], [skipped, failed, drift, unsupported])).toEqual([]);
  });

  it("does not mind the confirmation listing more than the write performed", () => {
    // apply finding less to do than the plan predicted is normal and harmless.
    expect(unconfirmedActions([link, update], [done(link)])).toEqual([]);
  });
});

describe("actionKey", () => {
  it("separates every field that can change independently", () => {
    const base = planned("link", "claude", "alpha");
    const keys = new Set([
      actionKey(base),
      actionKey({ ...base, kind: "update" }),
      actionKey({ ...base, target: "copilot-cli" }),
      actionKey({ ...base, assetType: "mcp" }),
      actionKey({ ...base, asset: "beta" }),
      actionKey({ ...base, path: "D:\\elsewhere" }),
    ]);
    expect(keys.size).toBe(6);
  });

  it("ignores fields that carry no identity", () => {
    const base = planned("link", "claude", "alpha");
    expect(actionKey({ ...base, detail: "different wording" })).toBe(actionKey(base));
  });
});
