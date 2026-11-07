<script lang="ts">
  /**
   * The confirmation before a write.
   *
   * A modal is the right instrument exactly once in this interface: `apply`
   * touches the live configuration of four other tools, it cannot be undone
   * from here, and PRODUCT Principle 1 makes 明示確認 a step that must not be
   * skippable. So this interrupts, it lists every path that will be touched
   * rather than a count, it shows **what changes inside each file** (SPEC §9.6),
   * it names the backup directory, and its primary action says what it does.
   *
   * `<dialog showModal()>` is used for the focus trap, the inert background and
   * Escape-to-cancel the platform already implements correctly.
   *
   * Two rules this component is the enforcement point for:
   *
   *  1. **表示 = 実行.** `actions` is the caller's `executable` list, filtered by
   *     the same predicate `apply` uses (`isExecutableAction`, mirroring
   *     `core/diff.ts`). Anything the engine would skip is not listed here — a
   *     `delete` without `--prune` used to be counted in 「以下の N 件を適用し
   *     ます」 and then quietly skipped.
   *  2. **Focus is never dropped.** The confirm button stays enabled while the
   *     write runs (it becomes `aria-busy` and its handler no-ops), because
   *     disabling the element that has focus moves focus to the body — inside a
   *     modal whose every other control is also disabled, during the highest
   *     stakes operation this window has.
   */
  import DiffPreview from "./DiffPreview.svelte";
  import Icon from "./Icon.svelte";
  import { TARGET_FILTER_LABEL, backupsPath, type TargetFilter } from "./assets.js";
  import type { PlanAction } from "./contract.js";
  import { actionNote } from "./notes.js";
  import { ACTION_KIND_LABEL } from "./schematic.js";

  const {
    open,
    actions,
    sourceRoot,
    busy,
    narrowings,
    targetFilter,
    hiddenFromFilter,
    onCancel,
    onConfirm,
  }: {
    open: boolean;
    actions: PlanAction[];
    sourceRoot: string;
    busy: boolean;
    /**
     * SPEC §10.6 — **every** narrowing the list is under while this dialog is
     * open, named (`describeNarrowings`).
     *
     * `apply` ignores all of them, so the dialog must not. The rule is
     * 表示 = 実行, and the honest way to keep it with a narrowed list behind the
     * backdrop is to say plainly that the write is wider than that list and
     * that the authoritative enumeration is this dialog's own.
     */
    narrowings: string[];
    /** The target narrowing alone, for the one count that is about targets. */
    targetFilter: TargetFilter;
    hiddenFromFilter: number;
    onCancel: () => void;
    onConfirm: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);

  $effect(() => {
    const el = dialog;
    if (el === null) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  });

  const summary = $derived(
    Object.entries(
      actions.reduce<Record<string, number>>((acc, a) => {
        acc[a.kind] = (acc[a.kind] ?? 0) + 1;
        return acc;
      }, {}),
    ),
  );
</script>

<dialog
  bind:this={dialog}
  class="confirm"
  aria-labelledby="confirm-title"
  aria-busy={busy}
  oncancel={(event) => {
    event.preventDefault();
    if (!busy) onCancel();
  }}
>
  <form method="dialog" onsubmit={(event) => event.preventDefault()}>
    <header>
      <h2 id="confirm-title">実環境へ書き込みます</h2>
      <p>
        以下の {actions.length} 件を適用します。ここに出ている操作はすべて実行され、出ていない操作は実行されません。対象は他ツールが実際に読み込んでいる設定です。
      </p>
    </header>

    <!--
      Dashed, because it is a 但し書き rather than a fault: nothing is wrong,
      the list behind this dialog is simply narrower than the write. Placed
      above the summary so it is read before the counts it qualifies.

      Always shown, and it no longer claims the write is visible behind the
      backdrop. The table draws one asset kind at a time (SPEC §10.6 keeps the
      tab axis on the kind) and search, the state filter and the target
      narrowing each cut it further, while `apply` obeys none of them. The old
      version counted only the target narrowing and, when that count was zero,
      asserted 「すべて一覧に出ているものです」 — false for any plan that touches
      more than the visible tab's kind, which is most of them, and false in a
      sentence that invites the owner to go and check. What is true is that the
      authoritative list is the one in this dialog, so that is what it says.
    -->
    <p class="scope-note">
      背後の一覧は <span class="narrowings">{narrowings.join(" / ")}</span> で絞り込み表示中です。<strong
        >適用はこの絞り込みを無視し、下記 {actions.length} 件すべてを実行します</strong
      >。実行される操作の全体は下記の一覧であり、背後の一覧に行が出ていない資産への書き込みも含みます{targetFilter !==
        "all" && hiddenFromFilter > 0
        ? `(うち ${hiddenFromFilter} 件は ${TARGET_FILTER_LABEL[targetFilter]} 以外のターゲットへの書き込みです)`
        : ""}。
    </p>

    <dl class="summary">
      {#each summary as [kind, count] (kind)}
        <div>
          <dt>{ACTION_KIND_LABEL[kind as PlanAction["kind"]]}</dt>
          <dd class="num">{count}</dd>
        </div>
      {/each}
    </dl>

    <div class="targets">
      <p class="annotation" id="confirm-targets-label">書き込み対象と変更内容</p>
      <!--
        Focusable scroller: the dialog's focus trap contains only the footer
        buttons, so without `tabindex` a keyboard user cannot reach the rows
        below the fold of the very list this dialog promises to show them.
      -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <ul tabindex="0" role="region" aria-labelledby="confirm-targets-label">
        {#each actions as action, i (action.target + action.asset + i)}
          {@const note = actionNote(action)}
          <li>
            <p class="row">
              <span class="num tag">{action.target}</span>
              <span class="kind">{ACTION_KIND_LABEL[action.kind]}</span>
              <span class="path">{action.path}</span>
            </p>
            <!--
              PRODUCT fixes the display language as Japanese, and this is the
              screen where reading matters most — every line here is a write
              about to happen. `notes.ts` has carried the readings all along and
              only the demoted map view was calling it, so the ceremony ran in
              the engine's English ("physical copy matches source; back up and
              replace with junction") while the overview ran in Japanese.

              The engine's own sentence stays on screen beneath the reading
              rather than being replaced by it: DESIGN's 「エンジンの報告をそのまま
              描く」 is the reason this dialog can be trusted, and an unrecognised
              string still appears here verbatim as its only line.
            -->
            <p class="detail">{note ?? action.detail}</p>
            {#if note !== null}
              <p class="detail detail--source">{action.detail}</p>
            {/if}
            <DiffPreview {action} />
          </li>
        {/each}
      </ul>
    </div>

    <p class="backup">
      変更前の内容は
      <span class="path">{backupsPath(sourceRoot)}</span>
      に元のパス構造のまま退避されます。実際の退避先は適用後に PLAN の記録に載ります。
    </p>

    <footer>
      <button type="button" class="btn" onclick={onCancel} disabled={busy}>取消</button>
      <!--
        Enabled during the write on purpose (see the header comment): the guard
        is in the handler, not in `disabled`, so focus stays where the owner
        left it.
      -->
      <button
        type="button"
        class="btn btn--commit"
        aria-busy={busy}
        onclick={() => {
          if (!busy) onConfirm();
        }}
      >
        <Icon name="connect" />
        {busy ? "適用中…" : "適用する"}
      </button>
    </footer>
  </form>
</dialog>

<style>
  .confirm {
    width: min(48rem, calc(100vw - 3rem));
    max-height: calc(100dvh - 4rem);
    padding: 0;
    border: 1.5px solid var(--ink);
    border-radius: 2px;
    background: var(--paper);
    color: var(--ink);
    box-shadow:
      0 2px 4px rgba(26, 43, 60, 0.12),
      0 28px 56px -28px rgba(26, 43, 60, 0.55);
  }

  .confirm::backdrop {
    background: rgba(26, 43, 60, 0.42);
    backdrop-filter: blur(1.5px);
  }

  .confirm[open] {
    animation: rise 200ms var(--ease-out);
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }

  /* The dialog still announces itself, it just stops travelling to do it. */
  @media (prefers-reduced-motion: reduce) {
    .confirm[open] {
      animation: rise-still 200ms var(--ease-out);
    }

    @keyframes rise-still {
      from {
        opacity: 0;
      }
    }
  }

  form {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
    padding: var(--gap-5);
    max-height: calc(100dvh - 4rem);
  }

  header {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
  }

  h2 {
    font-size: var(--t-lg);
    letter-spacing: 0.03em;
  }

  header p {
    color: var(--ink-2);
    max-width: 62ch;
  }

  /* 破線は「実在しない/未確定/但し書き」の記号 (DESIGN: Shapes). */
  .scope-note {
    padding: var(--gap-2) var(--gap-3);
    border: 1px dashed var(--rule-strong);
    background: var(--paper-inset);
    max-width: 66ch;
  }

  .scope-note strong {
    font-weight: 700;
  }

  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    margin: 0;
    border: 1px solid var(--rule-strong);
  }

  .summary div {
    display: flex;
    align-items: baseline;
    gap: var(--gap-2);
    padding: var(--gap-2) var(--gap-4);
    border-right: 1px solid var(--rule);
  }

  .summary div:last-child {
    border-right: 0;
  }

  dt {
    font-size: var(--t-micro);
    letter-spacing: 0.08em;
    color: var(--ink-2);
  }

  dd {
    margin: 0;
    font-size: var(--t-lg);
    font-weight: 700;
  }

  .targets {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .targets ul {
    list-style: none;
    margin: var(--gap-2) 0 0;
    padding: 0;
    max-height: 22rem;
    overflow-y: auto;
    border: 1px solid var(--rule);
    background: var(--paper-panel);
  }

  .targets ul:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -2px;
  }

  .targets li {
    padding: var(--gap-2) var(--gap-3);
    border-bottom: 1px solid var(--rule);
  }

  .targets li:last-child {
    border-bottom: 0;
  }

  .row {
    display: flex;
    gap: var(--gap-3);
    align-items: baseline;
    flex-wrap: wrap;
  }

  .tag {
    flex: none;
    width: 6rem;
    font-size: var(--t-micro);
    color: var(--ink-2);
  }

  .kind {
    flex: none;
    font-size: var(--t-small);
  }

  .detail {
    font-size: var(--t-small);
    color: var(--ink-2);
  }

  /* The engine's own sentence, kept below its Japanese reading.
     Not mono: DESIGN's 等幅は識別子ルール lists パス・バージョン・件数・時刻・
     ターゲット名・コード・差分本文 and then says 「文章には決して使わない」 —
     unconditionally. 「機械の引用だから」 is not one of the listed cases, and
     StatusDrawer already sets this same string in the interface's own face.
     Not --ink-3 either: that token is for disabled framing and dormant
     conductors (「本文には使わない」), and on this dialog's --paper-panel ground
     it measures 3.27:1 — under the 4.5:1 this size needs. --ink-2 is 5.29:1 and
     is quiet enough to keep the reading first. */
  .detail--source {
    font-size: var(--t-micro);
    color: var(--ink-2);
  }

  /* DESIGN: 等幅は識別子ルール — the narrowings are a Japanese sentence
     (「種別: SKILLS / 検索: 「foo」」), not identifiers, so they are set in the
     interface's own face and merely weighted. */
  .narrowings {
    font-weight: 500;
  }

  .backup {
    padding: var(--gap-3);
    border: 1px solid var(--rule-strong);
    background: var(--paper-inset);
    max-width: 66ch;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--gap-3);
  }
</style>
