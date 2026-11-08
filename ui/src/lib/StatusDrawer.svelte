<script lang="ts">
  /**
   * The drawer the status bar opens: the full doctor findings, or the full plan
   * and the record of the last write.
   *
   * It is a panel, not a dialog — nothing here needs confirming, and trapping
   * focus to read a list is a cost with no benefit. It closes on Escape and on
   * the same status-bar cell that opened it.
   */
  import Icon from "./Icon.svelte";
  import { actionNote, findingNote } from "./notes.js";
  import { ACTION_KIND_LABEL } from "./schematic.js";
  import type { Apply, AppliedAction, Doctor, Plan, PlanAction } from "./contract.js";

  const {
    which,
    doctor,
    surveyStatus,
    plan,
    applied,
    unconfirmed,
    onClose,
  }: {
    which: "doctor" | "plan";
    doctor: Doctor | null;
    surveyStatus: string;
    plan: Plan | null;
    applied: Apply | null;
    unconfirmed: AppliedAction[];
    onClose: () => void;
  } = $props();

  const findings = $derived(doctor?.findings ?? []);
  /** Real work, separated from notes — they mean opposite things (SPEC §5). */
  const changes = $derived(
    (plan?.actions ?? []).filter((a) => a.kind !== "preserve" && a.kind !== "unsupported"),
  );
  const notes = $derived(
    (plan?.actions ?? []).filter((a) => a.kind === "preserve" || a.kind === "unsupported"),
  );

  /**
   * Focus goes into the drawer when it opens.
   *
   * 「不良 3件」 is a button because the answer is always 「どの3件か」, and the
   * drawer is that answer — but it sits *before* its trigger in the DOM, so Tab
   * from the cell went on to 差分を取る and the list needed Shift+Tab to reach.
   * A keyboard press on the cell therefore opened something the keyboard could
   * not read. Moving focus is not a focus trap: the panel is still a panel, Tab
   * still leaves it, and Escape hands focus back to the cell (App.svelte).
   *
   * `which` is in the dependency, so switching DOCTOR → PLAN with the drawer
   * already open re-enters the body rather than leaving focus on a list that has
   * just been replaced.
   */
  let bodyEl = $state<HTMLElement | null>(null);

  $effect(() => {
    void which;
    bodyEl?.focus();
  });

  function rowClass(action: PlanAction): string {
    if (action.kind === "drift") return "is-fault";
    if (action.kind === "preserve" || action.kind === "unsupported") return "is-note";
    return "";
  }
</script>

<!--
  Escape closes this panel — but only when Escape was not already someone
  else's. A bare `window` listener made this drawer the *last* thing to consume
  every Escape in the window: returning from a row's controls to the row
  (`rownav.ts` marks it handled), clearing the search box, and cancelling either
  confirmation dialog all closed the plan or the doctor findings the owner had
  deliberately opened behind them.

  Two guards, because the two cases are different: a handled keystroke is marked
  as such, while a `<dialog>` in the top layer never sees its Escape reach a
  handler at all — the platform turns it into `cancel` on the dialog. So the
  presence of an open modal is itself the signal that this Escape was not ours.
-->
<svelte:window
  onkeydown={(event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (document.querySelector("dialog[open]") !== null) return;
    onClose();
  }}
/>

<section
  id="statusbar-drawer"
  class="drawer"
  aria-label={which === "doctor" ? "doctor 所見" : "plan の内容"}
>
  <header>
    <h2>{which === "doctor" ? "doctor 所見" : "plan の内容"}</h2>
    <button type="button" class="icon-btn" aria-label="閉じる" onclick={onClose}>
      <Icon name="close" size={14} />
    </button>
  </header>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- Focusable scroller: the page does not scroll, so this is the only route
       to the rows below the fold for a keyboard. -->
  <div
    bind:this={bodyEl}
    class="drawer__body"
    tabindex="0"
    role="region"
    aria-label="一覧(スクロール)"
  >
    {#if which === "doctor"}
      <!--
        No reading is not a clean reading. `doctor` is null before the first
        survey, during it, and after one that failed (the session keeps nothing
        from a failed read), and all three used to say 「所見はありません。」.
      -->
      {#if doctor === null}
        <p class="empty">
          {#if surveyStatus === "running"}
            DOCTOR 未取得 — 走査中です。終わると所見が出ます。
          {:else if surveyStatus === "failed"}
            DOCTOR 未取得 — 走査が失敗したため、所見はありません。画面上部の障害の内容を確認し、「再走査」で取り直してください。
          {:else}
            DOCTOR 未取得 — 走査が終わると所見が出ます。
          {/if}
        </p>
      {:else if findings.length === 0}
        <p class="empty">所見はありません。</p>
      {:else}
        <ul class="list">
          <!--
            PRODUCT: 表示言語は日本語 — and DESIGN: エンジンの報告をそのまま描く.
            `FINDING_NOTES` is keyed on the code alone while `doctor` writes its
            values into the message (which field, what name, how many
            characters), so the note is the reading and the original is the
            finding. It goes under it, not into a `title`.
          -->
          {#each findings as finding, i (finding.code + i)}
            {@const note = findingNote(finding)}
            <li class:is-fault={finding.level === "error"}>
              <span class="tag">{finding.level === "error" ? "不良" : "注意"}</span>
              <span class="mono">{finding.code}</span>
              <span class="detail">{note ?? finding.detail}</span>
              {#if note !== null}<span class="detail detail--source">{finding.detail}</span>{/if}
              {#if finding.path !== undefined}<span class="path">{finding.path}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    {:else if plan === null}
      <p class="empty">PLAN 未取得 — 「差分を取る」を実行すると内容が出ます。</p>
    {:else}
      {#if changes.length === 0}
        <p class="empty">差分はありません。実環境はソースと一致しています。</p>
      {:else}
        <ul class="list">
          {#each changes as action, i (action.target + action.asset + i)}
            {@const note = actionNote(action)}
            <li class={rowClass(action)}>
              <span class="tag">{ACTION_KIND_LABEL[action.kind]}</span>
              <span class="mono">{action.target}</span>
              <span class="detail">{action.asset === "" ? action.assetType : action.asset}</span>
              <span class="path">{action.path}</span>
              <span class="detail detail--quiet">{note ?? action.detail}</span>
              {#if note !== null}<span class="detail detail--source">{action.detail}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if notes.length > 0}
        <!--
          Notes are listed *below* the work and labelled as notes: `preserve`
          means "seen and deliberately left alone", the exact opposite of the
          `delete` it used to be spelled as.
        -->
        <h3>注記(適用されません)</h3>
        <ul class="list">
          {#each notes as action, i (action.target + action.asset + i)}
            {@const note = actionNote(action)}
            <li class="is-note">
              <span class="tag">{ACTION_KIND_LABEL[action.kind]}</span>
              <span class="mono">{action.target}</span>
              <span class="detail">{action.asset === "" ? action.assetType : action.asset}</span>
              <span class="detail detail--quiet">{note ?? action.detail}</span>
              {#if note !== null}<span class="detail detail--source">{action.detail}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if applied !== null}
        <h3>直近の適用記録</h3>
        {#if applied.backupDir !== undefined}
          <p class="backup">退避先 <span class="path">{applied.backupDir}</span></p>
        {/if}
        {#if unconfirmed.length > 0}
          <p class="warn">
            確認画面に無かった変更が {unconfirmed.length} 件含まれています(差分取得後に実環境が変化しています)。
          </p>
        {/if}
        <ul class="list">
          {#each applied.applied as entry, i (entry.target + entry.asset + i)}
            <li class:is-fault={entry.status === "failed"}>
              <span class="tag">{entry.status === "done" ? "実行" : entry.status === "skipped" ? "対象外" : "失敗"}</span>
              <span class="mono">{entry.target}</span>
              <span class="detail">{entry.asset === "" ? entry.assetType : entry.asset}</span>
              <span class="path">{entry.path}</span>
              {#if entry.error !== undefined}<span class="detail">{entry.error}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</section>

<style>
  .drawer {
    flex: none;
    display: flex;
    flex-direction: column;
    max-height: 18rem;
    border: 1px solid var(--rule-strong);
    border-bottom: 0;
    background: var(--paper);
  }

  header {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--gap-2) var(--gap-3);
    border-bottom: 1px solid var(--rule);
    background: var(--paper-panel);
  }

  h2 {
    font-size: var(--t-small);
    letter-spacing: 0.08em;
  }

  h3 {
    margin: var(--gap-3) 0 var(--gap-1);
    font-size: var(--t-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-2);
  }

  /* Focusable so a keyboard can scroll it; the page itself does not scroll. */
  .drawer__body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: var(--gap-2) var(--gap-3) var(--gap-3);
  }

  .drawer__body:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -2px;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .list li {
    display: grid;
    grid-template-columns: 4.5rem 7rem minmax(6rem, 1fr);
    align-items: baseline;
    column-gap: var(--gap-3);
    padding: var(--gap-1) 0;
    border-bottom: 1px solid var(--rule);
    font-size: var(--t-small);
  }

  .list li .path,
  .detail--quiet {
    grid-column: 2 / -1;
  }

  .tag {
    padding: 0 var(--gap-1);
    border: 1px solid var(--rule-strong);
    font-size: var(--t-micro);
    text-align: center;
    color: var(--ink-2);
  }

  .is-fault .tag {
    color: var(--fault-text);
    border-color: var(--fault);
  }

  .is-note .tag {
    border-style: dashed;
  }

  .mono {
    font-family: var(--mono);
    font-size: var(--t-micro);
    color: var(--ink-2);
  }

  .detail--quiet {
    color: var(--ink-2);
  }

  /*
   * The engine's own sentence, under its reading. Not mono (DESIGN: 等幅は
   * 識別子ルール — 「文章には決して使わない」) and not --ink-3 (that token is for
   * disabled framing and dormant conductors, and measures 3.27:1 here).
   */
  .detail--source {
    grid-column: 2 / -1;
    font-size: var(--t-micro);
    color: var(--ink-2);
  }

  .empty {
    padding: var(--gap-3) 0;
    color: var(--ink-2);
  }

  .warn {
    padding: var(--gap-2);
    border: 1px solid var(--fault);
    background: var(--fault-wash);
    color: var(--fault-text);
  }

  .backup {
    padding: var(--gap-1) 0;
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.9rem;
    height: 1.9rem;
    border: 1px solid transparent;
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
  }

  .icon-btn:hover {
    border-color: var(--rule-strong);
    color: var(--ink);
  }

  .icon-btn:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }
</style>
