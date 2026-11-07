/**
 * Did the write do what the owner agreed to?
 *
 * The confirmation dialog lists the actions from the `am plan` snapshot taken
 * when 差分を取る was pressed. `am apply` does not replay that list: it
 * recomputes its work from the live filesystem at write time
 * (`src/commands/apply.ts` `runApply`). That is the correct behaviour — the
 * machine at the moment of writing is the only thing worth acting on, and it is
 * what keeps the CLI and the GUI honest about being one engine. But it means
 * anything that moved in between (another `am` run, an editor, Claude Code
 * rewriting `~/.claude.json`) can legally end up in the write without ever
 * having appeared in the dialog.
 *
 * The blast radius is small by construction: deletions need `--prune`, which
 * the GUI never passes; unresolved drift still aborts at write time; and every
 * touched file is backed up first. What is *not* small is the claim the dialog
 * makes — "以下の N 件を適用します" — so the discrepancy is measured against the
 * report and named, rather than the run being stamped as a clean success.
 *
 * Kept in its own plain module, with no runes in it, so the comparison is a
 * unit test rather than something only a live machine can demonstrate.
 */

import type { AppliedAction, PlanAction } from "./contract.js";

/**
 * Identity of one action.
 *
 * All five fields, because each can differ on its own: the same asset on the
 * same target can change `kind` (a slot that was empty at plan time and holds a
 * stale copy at write time turns `link` into `update`) or `path` (the target's
 * configured directory moved).
 */
export function actionKey(action: PlanAction): string {
  return `${action.kind}:${action.target}:${action.assetType}:${action.asset}:${action.path}`;
}

/**
 * Actions the engine carried out that the confirmation did not list.
 *
 * Only actions that actually touched the machine count. `skipped` changed
 * nothing; `drift` and `unsupported` are reports the engine emits rather than
 * writes it performs, and neither is ever offered for confirmation in the first
 * place.
 */
export function unconfirmedActions(
  confirmed: readonly PlanAction[],
  report: readonly AppliedAction[],
): AppliedAction[] {
  const agreed = new Set(confirmed.map(actionKey));
  return report.filter(
    (action) =>
      action.status === "done" &&
      action.kind !== "unsupported" &&
      action.kind !== "drift" &&
      !agreed.has(actionKey(action)),
  );
}

/**
 * The other direction: actions the dialog listed that the write did **not**
 * carry out.
 *
 * This half was missing, and its absence is what let a real divergence pass as
 * a clean success. The dialog used to include un-prunable `delete` actions; the
 * engine recorded them as `skipped`; nothing compared the two, so the run
 * finished 「適用が完了しました」 while the deletion the owner had just approved
 * never happened. The engine has since stopped calling those `delete`
 * (they are `preserve` now) and the dialog filters on the same predicate
 * `apply` uses — but a promise this specific deserves a check that does not
 * depend on three other things staying correct.
 *
 * A `failed` entry is deliberately *not* reported here: it already surfaces as
 * an error with its own message, and naming it twice would suggest two
 * problems.
 */
export function skippedConfirmed(
  confirmed: readonly PlanAction[],
  report: readonly AppliedAction[],
): PlanAction[] {
  const done = new Map(report.map((entry) => [actionKey(entry), entry.status]));
  return confirmed.filter((action) => {
    const status = done.get(actionKey(action));
    return status === undefined || status === "skipped";
  });
}
