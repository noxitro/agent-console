<script lang="ts">
  /**
   * What a write would change, line by line (SPEC §9.6).
   *
   * The bar is GitHub Desktop: naming `~/.claude.json` is not a preview,
   * because the question the owner is actually being asked is "may I overwrite
   * a file another tool is using right now" and the answer depends entirely on
   * *what* changes. So each action opens to a collapsed line diff.
   *
   * Closed by default: the list of paths is the summary, and expanding is one
   * click. `<details>` is used rather than a hand-rolled disclosure so keyboard
   * and screen-reader behaviour come from the platform.
   */
  import { diffSummary } from "./difftext.js";
  import type { PlanAction } from "./contract.js";

  const { action }: { action: PlanAction } = $props();

  const hasPreview = $derived(action.before !== undefined || action.after !== undefined);
  /*
   * One LCS pass for both readers. The summary line and the table are rendered
   * from the same diff, and `<details>` does not defer either of them — the
   * markup inside a closed disclosure is still built — so two `diffLines` calls
   * meant two full tables per action, every one of them the moment `session.plan`
   * is assigned. See `diffSummary`.
   */
  const summary = $derived(
    hasPreview
      ? diffSummary(action.before, action.after)
      : { lines: [], stat: { added: 0, removed: 0 } },
  );
  const lines = $derived(summary.lines);
  const stat = $derived(summary.stat);
</script>

{#if action.previewOmitted !== undefined}
  <!-- A truncated diff that looked complete would be worse than none. -->
  <p class="unavailable">内容が大きいため差分表示は省略しました({action.previewOmitted})。</p>
{:else if !hasPreview}
  <p class="unavailable">
    {action.assetType === "skill"
      ? "skill はディレクトリのため、テキスト差分はありません(リンクの作成・張り替えです)。"
      : "この操作にはテキスト差分がありません。"}
  </p>
{:else}
  <details>
    <summary>
      差分を表示
      <span class="stat num">
        <span class="stat--add">+{stat.added}</span>
        <span class="stat--remove">−{stat.removed}</span>
      </span>
    </summary>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- A scroller with no focusable children: keyboard access depends on the
         scroller itself being focusable. -->
    <div class="diff" tabindex="0" role="region" aria-label="{action.path} の差分">
      <table>
        <tbody>
          {#each lines as line, i (i)}
            <tr class="line line--{line.kind}">
              <td class="gutter num">{line.before ?? ""}</td>
              <td class="gutter num">{line.after ?? ""}</td>
              <td class="sign" aria-hidden="true">
                {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}
              </td>
              <td class="text">{line.text}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </details>
{/if}

<style>
  .unavailable {
    font-size: var(--t-small);
    color: var(--ink-2);
  }

  summary {
    font-size: var(--t-small);
    cursor: pointer;
    color: var(--ink-2);
  }

  summary:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 2px;
  }

  .stat {
    margin-left: var(--gap-2);
    font-size: var(--t-micro);
  }

  .stat--add {
    color: var(--pass-text);
  }

  .stat--remove {
    color: var(--fault-text);
  }

  /* Focusable: the page does not scroll, so this is the only way in. */
  .diff {
    max-height: 14rem;
    overflow: auto;
    margin-top: var(--gap-2);
    border: 1px solid var(--rule);
    background: var(--paper-panel);
  }

  .diff:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -2px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--mono);
    font-size: var(--t-micro);
    line-height: 1.55;
  }

  td {
    padding: 0 var(--gap-1);
    vertical-align: top;
  }

  .gutter {
    width: 2.5rem;
    text-align: right;
    /* --ink-2: --ink-3 fell to 2.9:1 on the added-line wash (WCAG 1.4.3). */
    color: var(--ink-2);
    user-select: none;
    border-right: 1px solid var(--rule);
  }

  .sign {
    width: 1rem;
    text-align: center;
  }

  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /*
   * Colour is the accent, never the only signal: every changed line also
   * carries its +/− sign, so the diff survives a monochrome or colour-blind
   * reading.
   */
  .line--add {
    background: var(--pass-wash);
    color: var(--pass-text);
  }

  .line--remove {
    background: var(--fault-wash);
    color: var(--fault-text);
  }

  .line--gap td {
    color: var(--ink-2);
    background: var(--paper-inset);
    text-align: center;
  }
</style>
