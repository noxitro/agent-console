<script lang="ts">
  /**
   * The persistent status bar.
   *
   * Replaces the retired inspection stamp. Two numbers that are always true —
   * 不良 X件 / 注意 Y件 — plus the plan's state and the one bulk action. The
   * counts are buttons because the answer to "3 faults" is always "which
   * three", and the drawer above is where that lives.
   *
   * SPEC §9.4: 「PLAN 未取得」 is a state of its own here too. A bar that read
   * 「差分 0」 before any plan had run would be claiming a measurement nobody
   * took.
   */
  import Icon from "./Icon.svelte";

  const {
    errorCount,
    warnCount,
    hasPlan,
    changeCount,
    noteCount,
    hasDrift,
    surveyStatus,
    diffStatus,
    drawer,
    busy,
    canApply,
    onDrawer,
    onDiff,
    onApply,
  }: {
    errorCount: number;
    warnCount: number;
    hasPlan: boolean;
    changeCount: number;
    noteCount: number;
    hasDrift: boolean;
    surveyStatus: string;
    diffStatus: string;
    drawer: "doctor" | "plan" | null;
    busy: boolean;
    canApply: boolean;
    onDrawer: (which: "doctor" | "plan" | null) => void;
    onDiff: () => void;
    onApply: () => void;
  } = $props();

  const planLabel = $derived(
    diffStatus === "running"
      ? "PLAN 取得中…"
      : !hasPlan
        ? "PLAN 未取得"
        : hasDrift
          ? "drift のため適用不可"
          : changeCount === 0
            ? "差分なし"
            : `差分 ${changeCount} 件`,
  );
</script>

<footer class="statusbar">
  <!-- `id` so the drawer can hand focus back to the cell that opened it. -->
  <button
    id="statusbar-doctor"
    type="button"
    class="cell"
    class:is-open={drawer === "doctor"}
    aria-expanded={drawer === "doctor"}
    aria-controls="statusbar-drawer"
    aria-label="doctor 所見: 不良 {errorCount} 件、注意 {warnCount} 件。開いて一覧を見る"
    onclick={() => onDrawer(drawer === "doctor" ? null : "doctor")}
  >
    <span class="cell__label">DOCTOR</span>
    {#if surveyStatus === "running"}
      <span class="cell__value">走査中…</span>
    {:else if surveyStatus !== "ready"}
      <span class="cell__value">—</span>
    {:else}
      <span class="cell__value num" class:is-fault={errorCount > 0}>不良 {errorCount}件</span>
      <span class="cell__value num" class:is-warn={warnCount > 0}>注意 {warnCount}件</span>
    {/if}
  </button>

  <!--
    Also the focus destination after a write (see App.svelte): a stable control
    that is still enabled when the dialog closes, and the one the completion
    announcement tells the owner to look at.
  -->
  <button
    id="statusbar-plan"
    type="button"
    class="cell"
    class:is-open={drawer === "plan"}
    aria-expanded={drawer === "plan"}
    aria-controls="statusbar-drawer"
    aria-label="plan の状態: {planLabel}。開いて内容と適用記録を見る"
    onclick={() => onDrawer(drawer === "plan" ? null : "plan")}
  >
    <span class="cell__label">PLAN</span>
    <span class="cell__value" class:is-fault={hasDrift} class:is-pending={changeCount > 0}>
      {planLabel}
    </span>
    {#if hasPlan && noteCount > 0}
      <!-- Notes are not differences (SPEC §5); they are counted apart so the
           two can never be added together into a phantom "difference". -->
      <span class="cell__value num cell__value--quiet">注記 {noteCount}件</span>
    {/if}
  </button>

  <!--
    `aria-busy` while an operation runs, `disabled` only for 一括適用… and only
    on the standing fact that there is nothing to apply. Pressing either of
    these is what makes `busy` true, so disabling on it took focus off the
    element the owner had just pressed (app.css: 「A control that is working
    rather than unavailable」).
  -->
  <div class="ops">
    <button
      type="button"
      class="btn btn--sm"
      aria-busy={busy}
      onclick={() => {
        if (!busy) onDiff();
      }}
    >
      <Icon name="diff" size={14} />差分を取る
    </button>
    <button
      type="button"
      class="btn btn--sm btn--primary"
      aria-busy={busy}
      disabled={!canApply}
      onclick={() => {
        if (!busy) onApply();
      }}
    >
      <Icon name="connect" size={14} />一括適用…
    </button>
  </div>
</footer>

<style>
  /* Wraps on a narrow window: the two buttons drop to their own line at the trailing edge. */
  .statusbar {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: 0;
    border: 1px solid var(--rule-strong);
    background: var(--paper-panel);
  }

  .cell {
    display: flex;
    align-items: baseline;
    gap: var(--gap-3);
    padding: var(--gap-2) var(--gap-4);
    border: 0;
    border-right: 1px solid var(--rule);
    background: transparent;
    font-size: var(--t-small);
    cursor: pointer;
  }

  .cell:hover {
    background: var(--paper);
  }

  .cell.is-open {
    background: var(--paper);
    box-shadow: inset 0 -2px 0 var(--ink);
  }

  .cell:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -2px;
  }

  .cell__label {
    font-size: var(--t-micro);
    letter-spacing: 0.1em;
    color: var(--ink-2);
  }

  .cell__value--quiet {
    color: var(--ink-2);
  }

  .is-fault {
    color: var(--fault-text);
    font-weight: 500;
  }

  .is-warn,
  .is-pending {
    color: var(--ink);
    font-weight: 500;
  }

  .ops {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    margin-left: auto;
    padding: var(--gap-2) var(--gap-3);
  }
</style>
