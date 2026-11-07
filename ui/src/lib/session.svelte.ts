/**
 * Session state: what has been read, what is pending, what was written.
 *
 * The ordering rule of PRODUCT Principle 1 lives here, not in the components.
 * Reading (`inventory` + `doctor`) starts on its own the moment the window
 * opens, because reading is harmless. Writing cannot start at all until a plan
 * has been taken and a confirmation has been given, and the button that would
 * skip either step does not exist:
 *
 *   survey ──▶ diff ──▶ confirm ──▶ commit ──▶ survey
 *
 * The same ceremony governs the console's other two writes. `enable`/`disable`
 * and `remove` are engine commands with their own backups (SPEC §9.2), and both
 * re-survey afterwards rather than patching the table in place — the row the
 * owner sees is always a row the engine just reported.
 */

import {
  isExecutableAction,
  type AppliedAction,
  type Apply,
  type AssetType,
  type Doctor,
  type Inventory,
  type Plan,
  type PlanAction,
} from "./contract.js";
import {
  apply as runApply,
  doctor as runDoctor,
  engineMode,
  engineModeLabel,
  EngineError,
  inventory as runInventory,
  STALE_PLAN_MARK,
  plan as runPlan,
  removeAsset,
  setAssetEnabled,
  type EngineMode,
} from "./engine.js";
import { skippedConfirmed, unconfirmedActions } from "./reconcile.js";
import {
  actionsOutsideTarget,
  describeNarrowings,
  filterRows,
  rowsFor,
  type AssetRow,
  type ReadState,
  type RowFilter,
  type TargetFilter,
} from "./assets.js";
import { buildSchematic, type Schematic } from "./schematic.js";

/**
 * The four states a read can be in. Defined in `assets.ts` and re-exported here
 * under the name the components already use: `emptyReason` takes one, and a
 * pure helper should not have to import from the stateful module to say so.
 */
export type Status = ReadState;
export type WriteStatus = "idle" | "confirming" | "running" | "done" | "failed";

/** A pending destructive edit awaiting its confirmation dialog. */
export interface PendingRemoval {
  assetType: AssetType;
  name: string;
}

function toEngineError(err: unknown): EngineError {
  return err instanceof EngineError ? err : new EngineError(String(err));
}

export class Session {
  inventory = $state<Inventory | null>(null);
  findings = $state<Doctor | null>(null);
  plan = $state<Plan | null>(null);
  applied = $state<Apply | null>(null);

  surveyStatus = $state<Status>("idle");
  diffStatus = $state<Status>("idle");
  writeStatus = $state<WriteStatus>("idle");

  surveyError = $state<EngineError | null>(null);
  diffError = $state<EngineError | null>(null);
  writeError = $state<EngineError | null>(null);

  /** When the last successful survey finished. */
  surveyedAt = $state<Date | null>(null);
  /** Conductors repaired by the last `apply`, for the map view's motion. */
  justReconnected = $state<string[]>([]);

  /* ---------------- console navigation ---------------- */

  /** Which tab the table is showing (SKILLS / MCP / AGENTS / COMMANDS). */
  tab = $state<AssetType>("skill");
  /** Free-text search over the current tab's rows. */
  query = $state("");
  /** Which subset of rows to show. */
  filter = $state<RowFilter>("all");
  /**
   * SPEC §10.6 — narrow the list to one agent's assets.
   *
   * Display only. It is deliberately *not* reset when the tab changes: 「今は
   * opencode のことを調べている」 is a question that spans kinds, and clearing
   * it on every tab press would make the control useless for exactly the job it
   * was added for. The search box is cleared instead (see `setTab`), because a
   * query is about one list and this is about one agent.
   */
  targetFilter = $state<TargetFilter>("all");
  /** The selected row's name, per tab, so switching tabs keeps each selection. */
  selection = $state<Record<AssetType, string | null>>({
    skill: null,
    mcp: null,
    agent: null,
    command: null,
  });
  /** The optional wiring map, demoted from the default view by the brief. */
  mapView = $state(false);
  /** Which status-bar drawer is open, if any. */
  drawer = $state<"doctor" | "plan" | null>(null);

  /** A `remove` waiting for its confirmation. */
  pendingRemoval = $state<PendingRemoval | null>(null);
  /** True while an `enable`/`disable`/`remove` is in flight. */
  assetBusy = $state(false);
  /**
   * What the last asset command did, for the live region.
   *
   * Set **after** the re-survey that follows the write, and cleared by every
   * other operation that starts. It is announced ahead of the survey and diff
   * results (App.svelte), so a value left standing here silenced both of them
   * for the rest of the session: one toggle, and 差分を取る announced 「foo を
   * 有効にしました。」 on every press from then on — resurrecting the
   * 「差分を取ったのに無音」 defect the live region was rewritten to close, and
   * saying something false while it did.
   */
  lastAssetResult = $state<string>("");

  /**
   * Actions the engine carried out that were **not** in the list the owner
   * confirmed.
   *
   * `am apply` recomputes its work from the live filesystem at write time
   * (`src/commands/apply.ts` `runApply`), while the dialog lists the snapshot
   * `am plan` took earlier. If anything moved in between — another `am` run,
   * an editor, Claude Code rewriting `~/.claude.json` — the write can legally
   * include something the dialog never showed. The engine is right to work from
   * the machine as it is; what would be wrong is stamping that run as a clean
   * success. So the difference is measured and reported instead of being
   * assumed away.
   */
  unconfirmed = $state<AppliedAction[]>([]);

  /**
   * The opposite discrepancy: actions the dialog listed that the write did not
   * perform. The dialog says 「以下の N 件を適用します」, so this being non-empty
   * means the interface over-promised, and that has to be said out loud rather
   * than absorbed into a green completion strip.
   */
  notApplied = $state<PlanAction[]>([]);

  /**
   * Which transport answered. Recorded after the first call rather than at
   * construction, because the fixture fallback is only chosen once a command
   * has actually gone looking for the agent-console server.
   */
  mode = $state<EngineMode>(engineMode());
  modeLabel = $state(engineModeLabel());

  schematic = $derived<Schematic | null>(
    this.inventory === null ? null : buildSchematic(this.inventory, this.findings, this.plan),
  );

  /** Any error at all — the fault plate shows the most recent one. */
  fault = $derived<EngineError | null>(
    this.writeError ?? this.diffError ?? this.surveyError ?? null,
  );

  /** A plan exists and something in it would actually change the machine. */
  hasChanges = $derived(
    this.plan !== null &&
      this.plan.actions.some((a) => a.kind !== "unsupported" && a.kind !== "preserve"),
  );

  /** SPEC §6.6: unresolved drift makes `apply` refuse, so the GUI must too. */
  hasDrift = $derived(this.plan !== null && this.plan.actions.some((a) => a.kind === "drift"));

  /**
   * Actions `apply` would carry out, in order — the exact list the dialog shows.
   *
   * The filter is `isExecutableAction`, which mirrors the engine's own
   * `isExecutable` **including its `--prune` rule**. The GUI never passes
   * `--prune`, so `delete` is excluded here for the same reason `apply` skips
   * it. Listing it anyway is how a dialog headed 「以下の N 件を適用します」
   * came to promise a deletion that never happened.
   */
  executable = $derived(
    this.plan === null ? [] : this.plan.actions.filter((a) => isExecutableAction(a)),
  );

  /** Actions the plan reports but this run will not perform — shown apart. */
  notes = $derived(
    this.plan === null
      ? []
      : this.plan.actions.filter((a) => a.kind === "preserve" || a.kind === "unsupported"),
  );

  errorCount = $derived(this.findings?.findings.filter((f) => f.level === "error").length ?? 0);
  warnCount = $derived(this.findings?.findings.filter((f) => f.level === "warn").length ?? 0);

  /* ---------------- table ---------------- */

  /** Every row of the current tab, before search and filter. */
  allRows = $derived<AssetRow[]>(
    this.inventory === null ? [] : rowsFor(this.tab, this.inventory, this.findings, this.plan),
  );

  /** The rows the table actually draws. */
  rows = $derived<AssetRow[]>(
    filterRows(this.allRows, this.query, this.filter, this.targetFilter),
  );

  /**
   * The same list without the target narrowing — what the empty state needs in
   * order to name the narrowing as the reason the list is empty, and to say how
   * many rows dropping it brings back.
   */
  rowsIgnoringTarget = $derived<AssetRow[]>(filterRows(this.allRows, this.query, this.filter));

  /**
   * Executable actions aimed at a target the list is currently hiding.
   *
   * SPEC §10.6 makes the narrowing a display control, so `apply` still writes
   * every target. That is only acceptable if the confirmation says so, and it
   * cannot say so in the abstract — 「絞り込み中でも全件やります」 is a policy,
   * while 「うち 4 件は opencode 以外です」 is a fact the owner can check
   * against the list right below it. This is that number.
   */
  hiddenFromFilter = $derived(actionsOutsideTarget(this.executable, this.targetFilter));

  /**
   * Every narrowing the list is under right now, named.
   *
   * The tab is in the list and is never absent, because it is the narrowing the
   * old caveat forgot: the table shows exactly one asset kind (SPEC §10.6 keeps
   * the axis on the kind), so a write touching two kinds always has rows with
   * no counterpart on screen. Counting only `hiddenFromFilter` and then, when
   * it was zero, asserting 「すべて一覧に出ているものです」 made a false claim
   * on almost every apply — and it was a claim the dialog itself invited the
   * owner to check against the list behind it. Search and the state filter cut
   * further still, and neither produced any caveat at all while the target
   * narrowing was 「すべて」.
   */
  listNarrowings = $derived<string[]>(
    describeNarrowings(this.tab, this.targetFilter, this.filter, this.query),
  );

  /** The selected row of the current tab, if it still exists after a re-survey. */
  selected = $derived<AssetRow | null>(
    this.allRows.find((row) => row.name === this.selection[this.tab]) ?? null,
  );

  select(name: string | null): void {
    this.selection = { ...this.selection, [this.tab]: name };
  }

  /**
   * Switch tabs. The search box is cleared because a query typed against skills
   * almost never means anything against MCP servers, and a table that silently
   * hides rows on arrival is worse than one that starts complete.
   */
  setTab(tab: AssetType): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.query = "";
  }

  /**
   * Read the machine. Runs on open and after every write; never writes, so it
   * needs no confirmation (PRODUCT Principle 1).
   */
  async survey(): Promise<void> {
    // Coalesce, do not drop.
    //
    // The controls that start a read are `aria-busy` instead of `disabled` now
    // (a disabled element that has focus drops it on `<body>`), so a second
    // press is stopped by a guard in a handler — and `FaultPlate`'s own 再走査
    // has none. Two concurrent reads are wasteful, so the first instinct was to
    // return early when one was already running. **That was wrong**, and in a
    // way that broke the rule this whole class exists to keep.
    //
    // `setEnabled()` and `confirmRemove()` write and then `await this.survey()`
    // *because the write happened*: the row on screen has to be a row the
    // engine reported afterwards. An early return handed them a reading that
    // had started before their write, and they went on to announce 「X を有効に
    // しました。」 over a table still showing the old state — 塗り潰さない,
    // inverted, by the very guard meant to be cheap insurance.
    //
    // So a call that arrives during a read does not get that read: it queues one
    // more and waits for it. At most one extra pass, and every caller is
    // guaranteed a reading that began no earlier than its own call.
    if (this.surveyRun !== null) {
      this.surveyAgain = true;
      return this.surveyRun;
    }
    const run = (async () => {
      try {
        do {
          this.surveyAgain = false;
          await this.readMachine();
        } while (this.surveyAgain);
      } finally {
        this.surveyRun = null;
        this.surveyAgain = false;
      }
    })();
    this.surveyRun = run;
    return run;
  }

  /** The in-flight read, or null. Not `$state`: nothing renders from it. */
  private surveyRun: Promise<void> | null = null;
  /** A read was asked for while one was running; run once more when it lands. */
  private surveyAgain = false;

  /** One pass of the read. Every caller reaches it through `survey()`. */
  private async readMachine(): Promise<void> {
    // A fresh reading replaces the verdict the last write left behind. Without
    // this, the green 「適用が完了しました」 strip survives into a re-survey that
    // has just found new drift, putting two contradictory verdicts on screen at
    // once (PRODUCT Principle 3: 状態を塗り潰さない).
    // "running" is left alone: `commit()` surveys while its own write is still
    // in flight, and clearing it there would drop the write's own result.
    if (this.writeStatus === "done" || this.writeStatus === "failed") {
      this.writeStatus = "idle";
      this.justReconnected = [];
      this.unconfirmed = [];
      this.notApplied = [];
      // `applied` is deliberately kept: the backup directory it names is the
      // way back from that write, and it stays on the record.
    }

    // A new reading is a new announcement. The asset-command result outranks
    // the survey result in the live region, so it has to stop being current the
    // moment anything else starts; `setEnabled` / `confirmRemove` set theirs
    // again after this returns.
    this.lastAssetResult = "";

    this.surveyStatus = "running";
    this.surveyError = null;
    try {
      const [inventory, findings] = await Promise.all([runInventory(), runDoctor()]);
      this.inventory = inventory;
      this.findings = findings;
      this.surveyedAt = new Date();
      this.surveyStatus = "ready";
    } catch (err) {
      // Nothing is kept from a failed read: half of a previous reading beside a
      // fresh error would be a picture of a machine that never existed.
      this.inventory = null;
      this.findings = null;
      this.plan = null;
      // The plan is gone, so an error *about producing that plan* has to go with
      // it. `fault` is `writeError ?? diffError ?? surveyError`, so a standing
      // `diffError` outranked the failure that just happened: the table said
      // 「読み取れませんでした … 上の障害の内容を確認して」 while the plate above
      // described an earlier `am plan` run, and `onDismiss` is null while the
      // survey is failed, so the 閉じる that would have revealed the real error
      // was not even offered. `writeError` is deliberately not cleared here —
      // a partial write is about a machine that *was* changed, and it stays on
      // the plate until it is dealt with.
      this.diffError = null;
      this.diffStatus = "idle";
      this.surveyError = toEngineError(err);
      this.surveyStatus = "failed";
    } finally {
      this.mode = engineMode();
      this.modeLabel = engineModeLabel();
    }
  }

  /** Take a difference. Read-only — `am plan` writes nothing (SPEC §6.5). */
  async diff(): Promise<void> {
    // Re-entry guard. Unlike `survey()` this one may drop the call rather than
    // queue it: nothing awaits `diff()` for a reading it depends on — `commit()`
    // calls `runPlan()` directly — so a second press during a run wants the
    // result already coming, not another one after it. There are now four
    // places that offer 差分を取る — the status bar, the detail pane, the
    // detail pane's PLAN 未取得 note and the table's empty state — and each of
    // them relies on `busy` alone to stop a second press.
    if (this.diffStatus === "running") return;
    this.diffStatus = "running";
    this.diffError = null;
    this.writeStatus = "idle";
    // A stale-plan refusal wrote nothing and asked for exactly this; it must not
    // stand beside the new plan (and its 閉じる must not throw that plan away).
    if (this.writeError?.message.includes(STALE_PLAN_MARK) === true) this.writeError = null;
    this.lastAssetResult = "";
    this.applied = null;
    this.justReconnected = [];
    this.unconfirmed = [];
    this.notApplied = [];
    try {
      this.plan = await runPlan();
      this.diffStatus = "ready";
    } catch (err) {
      this.plan = null;
      this.diffError = toEngineError(err);
      this.diffStatus = "failed";
    }
  }

  /** Open the confirmation. Refuses on drift, exactly as the engine would. */
  requestApply(): void {
    if (!this.hasChanges || this.hasDrift) return;
    this.writeError = null;
    this.writeStatus = "confirming";
  }

  cancelApply(): void {
    if (this.writeStatus === "confirming") this.writeStatus = "idle";
  }

  /**
   * The write. `--yes` is passed because the confirmation the flag stands for
   * has just been given in the dialog; nothing else about the engine's refusals
   * is bypassed.
   */
  async commit(): Promise<void> {
    if (this.writeStatus !== "confirming") return;
    const before = new Set(
      (this.schematic?.wires ?? []).filter((w) => w.state !== "linked").map((w) => w.id),
    );
    // Exactly what the dialog listed, captured before the write.
    const confirmed = [...this.executable];

    this.writeStatus = "running";
    this.writeError = null;
    this.unconfirmed = [];
    this.notApplied = [];
    try {
      this.applied = await runApply({ yes: true });
    } catch (err) {
      const error = toEngineError(err);
      this.writeError = error;
      // A failed write that still reported what it managed to do keeps that
      // record on screen: the applied rows (including the one marked 失敗) and
      // the backup directory are how the owner finds out what changed.
      if (error.partial !== undefined) {
        this.applied = error.partial;
        this.unconfirmed = unconfirmedActions(confirmed, error.partial.applied);
      }
      if (error.message.includes(STALE_PLAN_MARK)) {
        // The server refused because the machine moved after the dialog: the
        // plan on screen describes a state that no longer exists, and offering
        // it again would only be refused again. Nothing was written.
        this.plan = null;
        this.diffStatus = "idle";
      }
      this.writeStatus = "failed";
      return;
    }

    // What the engine actually did, against what was shown — in both
    // directions. `unconfirmedActions` reports work that was done without being
    // listed; `skippedConfirmed` reports the opposite, which is what a
    // `delete` in the dialog used to produce silently.
    this.unconfirmed = unconfirmedActions(confirmed, this.applied.applied);
    this.notApplied = skippedConfirmed(confirmed, this.applied.applied);

    // Re-read rather than assume. The completion strip is only allowed to
    // describe a machine that was measured again after the write.
    await this.survey();
    if (this.surveyStatus === "failed") {
      this.writeStatus = "failed";
      return;
    }
    try {
      this.plan = await runPlan();
      this.diffStatus = "ready";
    } catch (err) {
      this.plan = null;
      this.diffError = toEngineError(err);
      this.diffStatus = "failed";
    }

    this.justReconnected = (this.schematic?.wires ?? [])
      .filter((w) => w.state === "linked" && before.has(w.id))
      .map((w) => w.id);
    this.writeStatus = "done";
  }

  /* ---------------- asset commands (SPEC §9.2) ---------------- */

  /**
   * Flip an asset between delivered and excluded.
   *
   * No confirmation dialog: this writes one line of `manifest.json`, backs it up
   * first, changes nothing in any target, and is reversed by clicking the same
   * control again. The ceremony of Principle 1 is proportionate to the blast
   * radius, and this one is one file inside `~/.agents-manager`. The *plan* is
   * dropped afterwards because it was computed against the old delivery set —
   * keeping it would leave the table's 「差分あり」 badges describing a machine
   * that no longer exists.
   */
  async setEnabled(assetType: AssetType, name: string, enabled: boolean): Promise<void> {
    if (this.assetBusy) return;
    this.assetBusy = true;
    this.writeError = null;
    try {
      const result = await setAssetEnabled(assetType, name, enabled);
      this.plan = null;
      this.diffStatus = "idle";
      await this.survey();
      // After the survey, which clears this: the outcome the owner is waiting
      // to hear is the one the live region should be holding when the operation
      // finishes, and it must not outlive the next operation.
      this.lastAssetResult = result.changed
        ? `${name} を${enabled ? "有効" : "無効"}にしました。`
        : `${name} はすでに${enabled ? "有効" : "無効"}です。`;
    } catch (err) {
      this.writeError = toEngineError(err);
      this.writeStatus = "failed";
    } finally {
      this.assetBusy = false;
    }
  }

  /** Open the confirmation for a `remove`. */
  requestRemove(assetType: AssetType, name: string): void {
    this.pendingRemoval = { assetType, name };
  }

  cancelRemove(): void {
    this.pendingRemoval = null;
  }

  /**
   * Delete the asset from the source of truth, after confirmation.
   *
   * This *does* get a dialog: it removes a file, and unlike a toggle there is no
   * second click that undoes it — the way back is the backup directory the
   * engine names in its report.
   */
  async confirmRemove(): Promise<void> {
    const pending = this.pendingRemoval;
    if (pending === null || this.assetBusy) return;
    this.assetBusy = true;
    this.writeError = null;
    try {
      const result = await removeAsset(pending.assetType, pending.name);
      const backup = result.backupDir ?? "";
      this.pendingRemoval = null;
      this.select(null);
      this.plan = null;
      this.diffStatus = "idle";
      await this.survey();
      // After the survey, for the reason given in `setEnabled`.
      this.lastAssetResult = `${pending.name} をソースから削除しました。退避先: ${backup}`;
    } catch (err) {
      this.writeError = toEngineError(err);
      this.writeStatus = "failed";
      this.pendingRemoval = null;
    } finally {
      this.assetBusy = false;
    }
  }

  /** Drop the plan and the write record, returning to plain monitoring. */
  clearPlan(): void {
    this.plan = null;
    this.applied = null;
    this.diffStatus = "idle";
    this.writeStatus = "idle";
    this.diffError = null;
    this.writeError = null;
    this.justReconnected = [];
    this.unconfirmed = [];
    this.notApplied = [];
    this.lastAssetResult = "";
  }
}
