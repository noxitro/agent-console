<script lang="ts">
  /**
   * The right pane: one asset, in full.
   *
   * The brief's second job — 「どのエージェントに、どの状態で届いているか」 —
   * lives here. The state list is the whole reason the pane exists, so it is
   * the tallest thing in it, one line per target, each carrying the path the
   * asset would occupy in that target rather than only a verdict.
   *
   * SPEC §9.4: with no plan the state cannot be decided, and this pane says so
   * once, at the top of the list, instead of drawing four confident ticks.
   */
  import Icon from "./Icon.svelte";
  import {
    DELIVERY_LABEL,
    DELIVERY_MARK,
    DETAIL_FACT_LABEL,
    formatDate,
    secondColumnValue,
    type AssetRow,
  } from "./assets.js";
  import { ASSET_TYPE_LABEL } from "./assets.js";
  import { actionNote, findingNote } from "./notes.js";
  import type { Status } from "./session.svelte.js";

  const {
    row,
    hasPlan,
    diffStatus,
    busy,
    sourceRoot,
    onDiff,
    onApply,
    onToggle,
    onRemove,
    canApply,
  }: {
    row: AssetRow | null;
    hasPlan: boolean;
    /** Same gap as the table's: `plan` is null for the whole of `runPlan()`. */
    diffStatus: Status;
    busy: boolean;
    sourceRoot: string;
    onDiff: () => void;
    onApply: () => void;
    onToggle: (row: AssetRow) => void;
    onRemove: (row: AssetRow) => void;
    canApply: boolean;
  } = $props();
</script>

<aside class="detail" aria-label="資産の詳細">
  {#if row === null}
    <div class="detail__empty">
      <p>左の一覧から資産を選ぶと、説明と適用先の状態がここに出ます。</p>
    </div>
  {:else}
    <header class="detail__head">
      <p class="annotation">{ASSET_TYPE_LABEL[row.type]}</p>
      <h2 id="detail-name">{row.name}</h2>
      {#if row.description !== undefined}
        <p class="detail__desc">{row.description}</p>
      {/if}
    </header>

    <dl class="facts">
      <div>
        <dt>状態</dt>
        <dd>
          <!-- Busy, not disabled; and the name is composed from the heading and
               the switch's own visible word, so voice control can say what it
               sees (WCAG 2.5.3). See AssetTable for the full note. -->
          <button
            type="button"
            class="toggle"
            role="switch"
            aria-checked={row.enabled}
            aria-labelledby="detail-name detail-toggle-state"
            aria-busy={busy}
            onclick={() => {
              if (!busy) onToggle(row);
            }}
          >
            <span class="toggle__dot" aria-hidden="true"></span>
            <span id="detail-toggle-state"
              >{row.enabled ? "有効(配布する)" : "無効(配布しない)"}</span
            >
          </button>
        </dd>
      </div>
      <div>
        <!--
          One slot, named for the kind in it: バージョン for a skill,
          トランスポート for a server, 担当エージェント for a command. A fixed
          「バージョン」 row put 「—」 against every MCP server on the grounds
          that servers have no version — true, and not a fact worth a row.
        -->
        <dt>{DETAIL_FACT_LABEL[row.type]}</dt>
        <!-- PRODUCT: a skill without a version gets a dash, not a fiction. -->
        <dd class="num">{secondColumnValue(row)}</dd>
      </div>
      <div>
        <dt>最終更新</dt>
        <dd class="num">{formatDate(row.modified)}</dd>
      </div>
      <div>
        <dt>提供元</dt>
        <dd>
          {#if row.origin === undefined}
            —
          {:else}
            {row.origin.source}
            {#if row.origin.sourceUrl !== undefined}
              <span class="path">{row.origin.sourceUrl}</span>
            {/if}
          {/if}
        </dd>
      </div>
      <div class="facts__wide">
        <dt>配布先の指定</dt>
        <dd>
          {row.declaredTargets === undefined
            ? "指定なし(有効な全ターゲット)"
            : row.declaredTargets.join(", ")}
        </dd>
      </div>
    </dl>

    <section class="targets" aria-label="適用先エージェントの状態">
      <h3>適用先エージェント</h3>
      {#if !hasPlan}
        <!--
          SPEC §9.4, stated rather than implied. Without a plan the three states
          cannot be told apart, so the list shows what it *does* know (the path)
          and refuses to assert what it does not.
        -->
        <p class="targets__unknown">
          {#if diffStatus === "running"}
            <!-- Not 「未取得」 while it is being taken: `plan` stays null for the
                 whole of `runPlan()`, so `hasPlan` alone kept offering the
                 action that was already under way. -->
            差分を取得中です — 判定できしだいこの一覧に反映されます。
          {:else}
            PLAN 未取得 — 差分の有無は判定できません。<button
              type="button"
              class="linklike"
              aria-busy={busy}
              onclick={() => {
                if (!busy) onDiff();
              }}>差分を取る</button
            >と状態が確定します。
          {/if}
        </p>
      {/if}
      <ul>
        {#each row.deliveries as delivery (delivery.target)}
          <li>
            <!--
              `deliveryFor` has already applied SPEC §9.4 in order: without a
              plan every state that needs one is `unknown` 「PLAN 未取得」, and
              `unsupported` — which inventory settles by itself — is not. Painting
              the whole list `unknown` also painted over the refusal, so this row
              read 「PLAN 未取得」 directly above the SPEC §10.4 reason explaining
              why the target cannot carry the asset at all.
            -->
            <span class="badge badge--{delivery.state}" aria-hidden="true">
              {DELIVERY_MARK[delivery.state]}
            </span>
            <span class="targets__name">{delivery.target}</span>
            <span class="targets__state">{DELIVERY_LABEL[delivery.state]}</span>
            <span class="path">
              {delivery.path ?? "—"}
              {#if delivery.sharesDiscoveryWith !== undefined && delivery.state !== "unsupported"}
                <!--
                  SPEC §4's shared discovery is about the directories this
                  target *does* read. Printing it beside 非対応 said that a
                  command reaches vscode by way of copilot-cli's directory —
                  which is not true of any kind vscode cannot carry.
                -->
                <span class="shares">(発見パス共有: {delivery.sharesDiscoveryWith})</span>
              {/if}
            </span>
            {#if delivery.unreadable !== undefined}
              <!--
                Separate from the state above rather than folded into it:
                「差分あり」 says a write is pending, and says nothing about the
                thing being unusable where it stands.

                Two kinds arrive here and the sentence has to fit both: a command
                file whose frontmatter will not parse (SPEC §10.2), and a skill
                slot `lstat` was refused (SPEC §9.7). 「解析できません」 was true
                only of the first. What they share is that the engine looked and
                could not — so that is what it says, with the engine's own reason
                after it, verbatim.
              -->
              <span class="targets__detail targets__detail--fault">
                このターゲットの実体を読み取れません: {delivery.unreadable}
              </span>
            {/if}
            {#if delivery.action !== undefined}
              <!--
                PRODUCT: 表示言語は日本語 — and DESIGN: エンジンの報告をそのまま
                描く. Both, in that order: the note reads first and the engine's
                own sentence stays under it.

                It used to be in a `title=`. That is 「ツールチップやホバーだけに
                隠さない」 with extra steps, and it is not survivable for
                findings, whose notes are keyed on the code alone and so drop
                every variable the engine put in the message. `notes.ts`
                annotates; it does not replace.
              -->
              {@const note = actionNote(delivery.action)}
              <span class="targets__detail">{note ?? delivery.action.detail}</span>
              {#if note !== null}
                <span class="targets__detail targets__detail--source"
                  >{delivery.action.detail}</span
                >
              {/if}
            {:else if delivery.state === "unsupported" && delivery.reason !== undefined}
              <!--
                SPEC §10.4: 非対応 is a decision with a reason (opencode's agent
                frontmatter has no safe conversion; VS 2026 has no verified MCP
                format). Showing the verdict alone leaves it looking like an
                unfinished corner of this tool rather than a refusal to fake a
                conversion.
              -->
              <span class="targets__detail">{delivery.reason}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>

    {#if row.findings.length > 0}
      <section class="findings" aria-label="この資産の所見">
        <h3>doctor 所見</h3>
        <ul>
          {#each row.findings as finding, i (finding.code + i)}
            <!--
              The note, then the engine's own sentence — and this is the list
              where that matters most. `FINDING_NOTES` is keyed on the code
              alone, while `doctor` writes the values into the message: which
              frontmatter field is non-spec, what name the directory declared,
              how many characters the body ran to. 「6フィールド外の項目が
              あります」 is a true sentence with the answer removed. The code
              names *which* report; the original carries *what it found*.
            -->
            {@const note = findingNote(finding)}
            <li class:is-error={finding.level === "error"}>
              <span class="level">{finding.level === "error" ? "不良" : "注意"}</span>
              <!-- 等幅は識別子ルール — a SPEC §5 diagnostic code. -->
              <span class="finding-code">{finding.code}</span>
              <span>{note ?? finding.detail}</span>
              {#if note !== null}<span class="finding-source">{finding.detail}</span>{/if}
              {#if finding.path !== undefined}<span class="path">{finding.path}</span>{/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!--
      `busy` marks these as working rather than removing them from the tab
      order; `canApply` is a standing fact about the plan and legitimately
      disables. The distinction matters because pressing one of these is what
      makes `busy` true — `disabled={busy}` dropped focus on `<body>` at the
      moment of every operation this pane offers.

      「一括適用…」, not 「適用する」: this button sits in a pane about *one*
      asset and calls the same `requestApply()` the status bar does, which
      applies the entire plan. The dialog's scope note said so after the fact;
      the label now says so before the press, and the ellipsis marks it as the
      one that opens a confirmation.
    -->
    <footer class="detail__ops">
      <button
        type="button"
        class="btn"
        aria-busy={busy}
        onclick={() => {
          if (!busy) onDiff();
        }}
      >
        <Icon name="diff" />差分を取る
      </button>
      <button
        type="button"
        class="btn btn--primary"
        aria-busy={busy}
        disabled={!canApply}
        onclick={() => {
          if (!busy) onApply();
        }}
      >
        <Icon name="connect" />一括適用…
      </button>
      <button
        type="button"
        class="btn btn--danger"
        aria-busy={busy}
        onclick={() => {
          if (!busy) onRemove(row);
        }}
      >
        <Icon name="trash" />ソースから削除
      </button>
      <p class="detail__note">
        「一括適用…」は選択中の資産だけでなく、<strong>差分のある全件</strong>が対象です(内訳は確認画面に出ます)。
        削除はソース(<span class="path">{sourceRoot}</span
        >)からのみ。各ツールに配布済みの実体は <code>apply --prune</code> の担当です。
      </p>
    </footer>
  {/if}
</aside>

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
    min-height: 0;
    min-width: 0;
    padding: var(--gap-4);
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-panel);
  }

  .detail__empty {
    margin: auto;
    max-width: 26ch;
    text-align: center;
    color: var(--fg-2);
  }

  .detail__head {
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
  }

  h2 {
    font-size: var(--t-lg);
    overflow-wrap: anywhere;
  }

  h3 {
    font-size: var(--t-small);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-2);
    margin-bottom: var(--gap-2);
  }

  .detail__desc {
    color: var(--fg-2);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--gap-3);
    margin: 0;
    padding: var(--gap-3);
    border: 1px solid var(--line);
    background: var(--surface-inset);
  }

  .facts__wide {
    grid-column: 1 / -1;
  }

  dt {
    font-size: var(--t-micro);
    letter-spacing: 0.08em;
    color: var(--fg-2);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  /* Targets ----------------------------------------------------------- */

  .targets ul,
  .findings ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .targets li {
    display: grid;
    grid-template-columns: 1.5rem minmax(5rem, auto) minmax(6rem, auto);
    align-items: baseline;
    column-gap: var(--gap-2);
    padding: var(--gap-2) 0;
    border-bottom: 1px solid var(--line);
  }

  .targets li .path,
  .targets__detail {
    grid-column: 2 / -1;
  }

  .targets__name {
    font-family: var(--mono);
    font-size: var(--t-small);
  }

  .targets__state {
    font-size: var(--t-small);
  }

  .targets__detail {
    font-size: var(--t-small);
    color: var(--fg-2);
  }

  /*
   * The engine's own sentence, under its Japanese reading.
   *
   * Smaller and quieter so the note reads first, but on screen — not mono:
   * DESIGN's 等幅は識別子ルール ends 「文章には決して使わない」, and this is a
   * sentence. --fg-2 rather than --fg-3, which is for disabled framing and
   * dormant conductors and measures 3.7:1 (DESIGN.md Colors) here.
   */
  .targets__detail--source,
  .finding-source {
    font-size: var(--t-micro);
    color: var(--fg-2);
  }

  .finding-source {
    flex-basis: 100%;
  }

  /* 二段インクルール: body-size text takes the text-weight signal red. */
  .targets__detail--fault {
    color: var(--fault-text);
    overflow-wrap: anywhere;
  }

  .shares {
    color: var(--fg-2);
  }

  .targets__unknown {
    padding: var(--gap-2);
    margin-bottom: var(--gap-2);
    border: 1px dashed var(--line-strong);
    background: var(--surface-inset);
    color: var(--fg-2);
  }

  /* The switch and the badge are shared with the table (app.css). The pane has
     room for a taller switch, and a ring set a little further out. */
  .toggle {
    min-height: 1.9rem;
  }

  .toggle:focus-visible {
    outline-offset: 2px;
  }

  /* Findings ---------------------------------------------------------- */

  .findings li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
    padding: var(--gap-2) 0;
    border-bottom: 1px solid var(--line);
  }

  .level {
    flex: none;
    padding: 0 var(--gap-1);
    border: 1px solid currentColor;
    font-size: var(--t-micro);
    color: var(--fg-2);
  }

  .findings li.is-error .level {
    color: var(--fault-text);
  }

  /* DESIGN: 等幅は識別子ルール — a diagnostic code is issued by the engine. */
  .finding-code {
    flex: none;
    font-family: var(--mono);
    font-size: var(--t-micro);
    color: var(--fg-2);
  }

  /* Ops --------------------------------------------------------------- */

  .detail__ops {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
    margin-top: auto;
    padding-top: var(--gap-3);
    border-top: 1px solid var(--line);
  }

  .detail__note {
    flex: 1 1 100%;
    font-size: var(--t-small);
    color: var(--fg-2);
  }

  code {
    font-family: var(--mono);
    background: var(--surface-inset);
    padding: 0 0.15em;
  }

</style>
