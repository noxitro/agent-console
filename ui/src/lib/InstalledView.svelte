<script lang="ts">
  /*
   * Installed (ARCHITECTURE.md「単位とプロジェクト」): what Claude Code and
   * Copilot load, for the unit chosen in the header (ScopePicker).
   *
   * The structure of the GitHub Copilot app's Installed screen (PRODUCT.md
   * Brand Commitments): one page of sections by kind — Plugins, MCP Servers,
   * Skills, Agents, Commands, 指示ファイル — each with a count; every row is a
   * name over where it came from (Plugin: x, Marketplace: x, 個人, プロジェクト: x,
   * ローカル); a search and a type filter above. The detail pane on the right
   * answers "who reads this, through which path, decided by which setting, how
   * sure are we, and what does it cost every session".
   *
   * Read-only until P4: nothing here looks like a switch or a button that
   * changes an asset. The state words are plain text in a frame, not toggles.
   *
   * One tab stop for the whole list (rownav.ts): ↑↓ walk the rows across
   * sections, Home/End jump to the ends, PageDown/PageUp to the next or previous
   * section's first row.
   */

  import { tick } from "svelte";

  import Icon from "./Icon.svelte";
  import { InstalledState, needsAttention, type KindFilter } from "./installed.svelte.js";
  import {
    headlineState,
    isPluginPart,
    isUnconfirmed,
    kindCounts,
    nextSectionStart,
    originLine,
    sectionCost,
    sectionStarts,
    sections,
  } from "./installed-view.js";
  import { activeRowIndex, isTextSelectionClick, nextRowIndex, rowTabIndex } from "./rownav.js";
  import {
    CERTAINTY_LABEL,
    HARNESSES,
    KIND_LABEL,
    ORIGIN_LABEL,
    SCOPE_LABEL,
    SECTION_LABEL,
    SECTION_ORDER,
    STATE_LABEL,
    type InstalledRow,
  } from "./scope-contract.js";

  interface Props {
    state: InstalledState;
    frozen: boolean;
  }

  let { state: s, frozen }: Props = $props();

  const nf = new Intl.NumberFormat("ja-JP");
  const n = (v: number): string => nf.format(v);
  const tokens = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v));

  /* ---- the list -------------------------------------------------------- */

  const view = $derived(sections(s.rows));
  const flat = $derived(view.flatMap((sec) => sec.rows));
  const starts = $derived(sectionStarts(view));
  const counts = $derived(kindCounts(s.searched));
  const projectName = $derived(s.project?.name);

  let focusedId = $state<string | null>(null);
  const ids = $derived(flat.map((r) => r.id));
  const active = $derived(activeRowIndex(ids, focusedId, s.selectedId));

  let listEl = $state<HTMLElement | null>(null);
  let detail = $state<HTMLElement | null>(null);

  async function select(row: InstalledRow): Promise<void> {
    s.selectedId = row.id;
    await tick();
    detail?.scrollTo({ top: 0 });
  }

  function onRowClick(row: InstalledRow): void {
    if (isTextSelectionClick(window.getSelection()?.toString())) return;
    void select(row);
  }

  /** ↑↓ Home End across every section, PageDown/PageUp between sections, Enter/Space selects. */
  function onRowKey(event: KeyboardEvent, row: InstalledRow): void {
    const i = ids.indexOf(row.id);
    if (i === -1) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void select(row);
      return;
    }
    const next = nextRowIndex(event.key, i, flat.length) ?? nextSectionStart(event.key, i, starts);
    if (next === null) return;
    event.preventDefault();
    const target = flat[next];
    if (target === undefined) return;
    listEl?.querySelector<HTMLElement>(`[data-id="${CSS.escape(target.id)}"]`)?.focus();
    void select(target);
  }

  /** The type filter's options carry the count after search, like the section badges. */
  const kindOptions = $derived<{ value: KindFilter; label: string }[]>([
    { value: "all", label: `すべての種類(${s.searched.length})` },
    ...SECTION_ORDER.map((k) => ({ value: k as KindFilter, label: `${SECTION_LABEL[k]}(${counts[k]})` })),
  ]);

  function stateWords(row: InstalledRow): { harness: string; state: string; word: string }[] {
    return HARNESSES.flatMap((h) => {
      const st = headlineState(row, h.id);
      return st === null ? [] : [{ harness: h.label, state: st, word: STATE_LABEL[st] }];
    });
  }

  /* ---- the detail pane ------------------------------------------------- */

  const harnessTotals = $derived(HARNESSES.map((h) => ({ ...h, sum: s.sessionTotal(h.id) })));
  const unreadableSources = $derived((s.data?.sources ?? []).filter((x) => x.status === "unreadable"));
  /** For a part a plugin brought: the plugin's own row, which carries its state and cost. */
  const parent = $derived<InstalledRow | null>(
    s.selected !== null && isPluginPart(s.selected)
      ? (s.allRows.find((r) => r.kind === "plugin" && r.plugin?.id === s.selected?.plugin?.id && r.scope === s.selected?.scope) ?? null)
      : null,
  );
</script>

<main class="installed" inert={frozen} aria-label="Installed">
  <section class="list-panel" aria-labelledby="inst-title">
    <header class="list-head">
      <div class="list-head__name">
        <h2 id="inst-title">{s.project?.name ?? "個人"}</h2>
        {#if s.project !== null}
          <p class="path" translate="no">{s.project.root}</p>
        {:else}
          <p class="list-head__sub">すべてのプロジェクトに効く設定</p>
        {/if}
      </div>
      <div class="toolbar">
        <label class="search">
          <Icon name="search" size={14} />
          <span class="sr-only">資産を検索</span>
          <input type="search" name="asset-filter" autocomplete="off" placeholder="名前・説明・パス・プラグインで検索…" bind:value={s.query} />
        </label>
        <label class="type">
          <span class="sr-only">種類</span>
          <select name="kind-filter" bind:value={s.kind}>
            {#each kindOptions as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
          </select>
        </label>
        <p class="count"><span class="num">{s.rows.length}</span> / <span class="num">{s.allRows.length}</span> 件</p>
      </div>
    </header>

    <div class="scroller">
      {#if s.status === "failed"}
        <div class="list-fault" role="alert">
          <p><Icon name="fault" size={14} />読み取れませんでした: {s.error}</p>
          <button type="button" class="btn btn--sm" onclick={() => void s.load()}>もう一度読む</button>
        </div>
      {:else if s.data === null}
        <p class="list-empty">{s.status === "running" ? "読み取り中です…" : "—"}</p>
      {:else if flat.length === 0}
        <p class="list-empty">
          {s.allRows.length === 0 ? "この単位には、Claude と Copilot が読むものがありません。" : "絞り込みに当てはまる行がありません。"}
        </p>
      {:else}
        <div class="sections" bind:this={listEl} aria-busy={s.status === "running"}>
          {#each view as sec (sec.kind)}
            {@const cost = HARNESSES.map((h) => ({ ...h, c: sectionCost(sec.rows, h.id) })).filter((x) => x.c.chars > 0 || x.c.unmeasured > 0)}
            <section class="sec" aria-labelledby="sec-{sec.kind}">
              <header class="sec__head">
                <h3 id="sec-{sec.kind}">
                  {SECTION_LABEL[sec.kind]}
                  <span class="count-badge num"><span class="sr-only">(</span>{sec.rows.length}<span class="sr-only"> 件)</span></span>
                </h3>
                {#if cost.length > 0}
                  <p class="sec__cost">
                    <span class="sec__cost-label">常時</span>
                    {#each cost as x, i (x.id)}
                      {#if i > 0}<span class="sep" aria-hidden="true">·</span>{/if}
                      <span>
                        {x.label}
                        {#if x.c.chars > 0}<span class="num">{n(x.c.chars)}</span> 字{/if}
                        {#if x.c.unmeasured > 0}<span class="muted">{x.c.chars > 0 ? "+ " : ""}未計測 <span class="num">{x.c.unmeasured}</span></span>{/if}
                      </span>
                    {/each}
                  </p>
                {/if}
              </header>
              <ul class="rows" role="listbox" aria-labelledby="sec-{sec.kind}">
                {#each sec.rows as row (row.id)}
                  {@const idx = ids.indexOf(row.id)}
                  <li
                    class="row"
                    class:is-selected={s.selectedId === row.id}
                    role="option"
                    aria-selected={s.selectedId === row.id}
                    data-id={row.id}
                    tabindex={rowTabIndex(idx, active, flat.length)}
                    onclick={() => onRowClick(row)}
                    onkeydown={(e) => onRowKey(e, row)}
                    onfocus={() => (focusedId = row.id)}
                    onblur={() => {
                      if (focusedId === row.id) focusedId = null;
                    }}
                  >
                    <div class="row__main">
                      <p class="row__name">
                        <span class="name" translate="no">{row.name}</span>
                        {#if row.unreadable !== undefined}<span class="flag flag--fault">読めない</span>{/if}
                        {#if (row.findings?.length ?? 0) > 0}<span class="flag">所見 <span class="num">{row.findings?.length}</span></span>{/if}
                        {#if isUnconfirmed(row)}<span class="flag flag--dashed">未確認</span>{/if}
                      </p>
                      <p class="row__origin" translate="no">{originLine(row, projectName)}</p>
                      {#if row.alsoIn !== undefined}
                        <p class="row__also">{row.alsoIn.map((u) => SCOPE_LABEL[u]).join("・")} にも同じ名前があります</p>
                      {/if}
                    </div>
                    <p class="row__states">
                      {#each stateWords(row) as w (w.harness)}
                        <span class="state state--{w.state}"><span class="state__h">{w.harness}</span> {w.word}</span>
                      {/each}
                    </p>
                  </li>
                {/each}
              </ul>
            </section>
          {/each}
        </div>
      {/if}
    </div>
  </section>

  <!-- Right: detail ------------------------------------------------------ -->
  <aside class="detail" aria-labelledby="detail-title" bind:this={detail}>
    {#if s.selected === null}
      <div class="detail__empty">
        <h2 id="detail-title">{s.project === null ? "個人の設定だけで開くと" : "このプロジェクトで開くと"}</h2>
        {#if s.data !== null}
          <dl class="session">
            {#each harnessTotals as h (h.id)}
              <dt>{h.label}</dt>
              <dd>
                <span class="num session__sum">{n(h.sum.chars)}</span> 字
                <span class="muted">約 <span class="num">{tokens(h.sum.tokens)}</span> トークン(推測)</span>
              </dd>
            {/each}
          </dl>
          <p class="note">
            毎セッション載る字数の見積もり({s.data.scopes.map((u) => SCOPE_LABEL[u]).join("・")}の合計)。含めないもの: 条件付き
            {#each harnessTotals as h, i (h.id)}{i > 0 ? "・" : ""}{h.label} <span class="num">{h.sum.conditional}</span>{/each}、未計測(MCP など)
            {#each harnessTotals as h, i (h.id)}{i > 0 ? "・" : ""}{h.label} <span class="num">{h.sum.unmeasured}</span>{/each}、ハーネス自身のシステムプロンプト。
          </p>
        {/if}
        <p class="note">行を選ぶと、どのハーネスがどのパスから読み、どの設定で有効・無効が決まり、毎セッションどれだけ載るかを出します。</p>
        {#if s.data !== null}
          <h3 class="label">この画面が読まないもの</h3>
          <ul class="plain">
            {#each s.data.unsupported as u (u.harness)}
              <li><code>{u.harness}</code> — {u.reason}</li>
            {/each}
          </ul>
          <h3 class="label">注記</h3>
          <ul class="plain">
            {#each s.data.notes as note, i (i)}<li>{note}</li>{/each}
          </ul>
          <details class="sources">
            <summary>
              読んだ場所 <span class="num">{s.data.sources.length}</span> か所
              {#if unreadableSources.length > 0}(読めない <span class="num">{unreadableSources.length}</span>){/if}
            </summary>
            <!-- A scroll-only region must be reachable by keyboard (DESIGN.md: スクロールだけの領域は tabindex="0" + role="region"). -->
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <ul class="plain plain--paths" tabindex="0" role="region" aria-label="読んだ場所の一覧">
              {#each s.data.sources as src (src.path + src.status)}
                <li class:fault-text={src.status === "unreadable"}>
                  <span class="src-status">{src.status === "ok" ? "読んだ" : src.status === "missing" ? "無い" : "読めない"}</span>
                  <span class="path" translate="no">{src.path}</span>{#if src.detail !== undefined} — {src.detail}{/if}
                </li>
              {/each}
            </ul>
          </details>
        {/if}
      </div>
    {:else}
      {@const row = s.selected}
      <header class="detail__head">
        <p class="annotation">{KIND_LABEL[row.kind]} · {SCOPE_LABEL[row.scope]}</p>
        <h2 id="detail-title" translate="no">{row.name}</h2>
        <p class="detail__origin" translate="no">{originLine(row, projectName)}</p>
        {#if row.description !== undefined}<p class="detail__desc">{row.description}</p>{/if}
      </header>

      {#if row.unreadable !== undefined}
        <p class="inline-fault"><Icon name="fault" size={13} />読めませんでした: {row.unreadable}</p>
      {/if}

      {#if row.alsoIn !== undefined}
        <p class="also-note">
          {row.alsoIn.map((u) => SCOPE_LABEL[u]).join("・")} にも同じ名前の {KIND_LABEL[row.kind]} があります。どちらが使われるかはハーネスと種別で異なり、確かめられていない組み合わせがあるため、この画面では判定していません。
        </p>
      {/if}

      <dl class="facts">
        <dt>パス</dt>
        <dd class="path" translate="no">{row.path}</dd>
        {#if row.realPath !== undefined}
          <dt>実体</dt>
          <dd class="path" translate="no">{row.realPath}</dd>
        {/if}
        <dt>出どころ</dt>
        <dd>{ORIGIN_LABEL[row.origin]}</dd>
        {#if row.plugin !== undefined}
          <dt>{isPluginPart(row) ? "プラグイン" : "ID"}</dt>
          <dd class="num" translate="no">{row.plugin.id}</dd>
        {/if}
        <dt>版</dt>
        <dd class="num">{row.version ?? "—"}</dd>
        {#if row.transport !== undefined}
          <dt>通信方式</dt>
          <dd class="num">{row.transport}</dd>
        {/if}
      </dl>

      {#if parent !== null}
        {@const p = parent}
        <p class="note">
          有効・無効はプラグインごとに決まり、この行の常時コストはプラグイン
          <button type="button" class="linklike" translate="no" onclick={() => void select(p)}>{p.name}</button>
          の行で数えています。
        </p>
      {/if}

      <section class="reaches" aria-labelledby="reach-title">
        <h3 id="reach-title" class="label">届き方</h3>
        <ul class="reach-list" role="list">
          {#each row.reach as r (r.harness + r.via)}
            <li class="reach">
              <p class="reach__top">
                <span class="reach__harness">{HARNESSES.find((h) => h.id === r.harness)?.label}</span>
                <span class="state state--{r.state}">{STATE_LABEL[r.state]}</span>
                <span class="certainty" class:certainty--weak={r.certainty === "unconfirmed"}>確度: {CERTAINTY_LABEL[r.certainty]}</span>
              </p>
              <dl class="reach__facts">
                <dt>読む場所</dt>
                <dd class="path" translate="no">{r.via}</dd>
                <dt>常時</dt>
                <dd>
                  {#if r.cost === undefined}
                    <span class="muted">{isPluginPart(row) ? "プラグインの行で数える" : "未計測"}</span>
                  {:else}
                    <span class="num">{n(r.cost.chars)}</span> 字(約 <span class="num">{n(r.cost.tokens)}</span> トークン・推測)
                    {#if r.state !== "enabled"}<span class="muted">— 合計に含めない</span>{/if}
                  {/if}
                  {#if r.costBasis !== undefined}<span class="basis">{r.costBasis}</span>{/if}
                </dd>
                {#if r.stateSource !== undefined}
                  <dt>決めた設定</dt>
                  <dd class="path" translate="no">{r.stateSource}</dd>
                {/if}
              </dl>
              {#if r.note !== undefined}<p class="note">{r.note}</p>{/if}
            </li>
          {/each}
        </ul>
      </section>

      {#if row.imports !== undefined && row.imports.length > 0}
        <section aria-labelledby="imports-title">
          <h3 id="imports-title" class="label">@import で取り込むファイル(常時コストに含む)</h3>
          <ul class="plain plain--paths">
            {#each row.imports as imp (imp.path)}
              <li><span class="path" translate="no">{imp.path}</span> <span class="num">{n(imp.chars)}</span> 字</li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if row.components !== undefined}
        <section aria-labelledby="comp-title">
          <h3 id="comp-title" class="label">部品</h3>
          <dl class="facts facts--plain">
            {#each [["skill", row.components.skills], ["command", row.components.commands], ["agent", row.components.agents], ["MCP", row.components.mcpServers]] as [label, list] (label)}
              <dt>{label}</dt>
              <dd translate="no">{(list as string[]).length === 0 ? "—" : (list as string[]).join("、")}</dd>
            {/each}
          </dl>
        </section>
      {/if}

      {#if (row.findings?.length ?? 0) > 0}
        <section aria-labelledby="find-title">
          <h3 id="find-title" class="label">所見</h3>
          <ul class="plain">
            {#each row.findings ?? [] as f (f.code)}
              <li class:fault-text={f.level === "error"}><code>{f.code}</code> {f.detail}</li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if needsAttention(row) && isUnconfirmed(row)}
        <p class="note">確度が「未確認」の届き方は、合計に含めず、今後の操作の対象にもしません。</p>
      {/if}
    {/if}
  </aside>
</main>

<style>
  .installed {
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(20rem, 1fr);
    gap: var(--gap-3);
    min-height: 0;
  }

  @media (max-width: 62rem) {
    .installed {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  /* List panel -------------------------------------------------------- */

  .list-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-panel);
    overflow: hidden;
  }

  .list-head {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    padding: var(--gap-3) var(--gap-4);
    border-bottom: 1px solid var(--line);
  }

  .list-head h2 {
    font-size: var(--t-lg);
    overflow-wrap: anywhere;
  }

  .list-head .path,
  .list-head__sub {
    font-size: var(--t-micro);
  }

  .list-head__sub {
    color: var(--fg-2);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-2) var(--gap-3);
  }

  .search {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    flex: 1 1 16rem;
    min-width: 10rem;
    padding: 0 var(--gap-2);
    border: 1px solid var(--control);
    border-radius: var(--radius-control);
    background: var(--surface-inset);
    color: var(--fg-2);
  }

  .search:focus-within {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }

  .search input {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 2rem;
    border: 0;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: var(--t-body);
  }

  .search input:focus {
    outline: none;
  }

  input::placeholder {
    color: var(--fg-2);
    opacity: 1;
  }

  .type select {
    min-height: 2.125rem;
    padding: 0 var(--gap-3);
    border: 1px solid var(--control);
    border-radius: var(--radius-control);
    background: var(--surface-2);
    color: var(--fg);
    font: inherit;
    font-size: var(--t-small);
    cursor: pointer;
  }

  .type select:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }

  .count {
    flex: none;
    margin-left: auto;
    font-size: var(--t-small);
    color: var(--fg-2);
  }

  .scroller {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 0 var(--gap-4) var(--gap-4);
  }

  /* Sections ---------------------------------------------------------- */

  .sec + .sec {
    margin-top: var(--gap-3);
  }

  /* The heading stays in view while its rows scroll under it. */
  .sec__head {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--gap-1) var(--gap-3);
    padding: var(--gap-3) 0 var(--gap-2);
    background: var(--surface);
  }

  .sec__head h3 {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    font-size: var(--t-md);
    letter-spacing: 0.02em;
  }

  .count-badge {
    min-width: 1.5rem;
    padding: 0 var(--gap-2);
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--fg-2);
    font-size: var(--t-micro);
    font-weight: 500;
    text-align: center;
    line-height: 1.6;
  }

  .sec__cost {
    font-size: var(--t-small);
    color: var(--fg-2);
  }

  .sep {
    margin: 0 var(--gap-2);
  }

  .sec__cost-label {
    margin-right: var(--gap-2);
    font-size: var(--t-micro);
    letter-spacing: 0.08em;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* The row: framed, slightly rounded — the Copilot app's row, without its switch. */
  .row {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    padding: var(--gap-2) var(--gap-3);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-panel);
    background: var(--surface-2);
    cursor: pointer;
  }

  .row:hover:not(.is-selected) {
    background: var(--surface-hover);
  }

  .row.is-selected {
    border-color: var(--accent);
    background: var(--select-wash);
    box-shadow: inset 3px 0 0 var(--accent-text);
  }

  .row:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }

  .row__main {
    flex: 1 1 auto;
    min-width: 0;
  }

  .row__name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-1) var(--gap-2);
  }

  .name {
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .row__origin {
    font-size: var(--t-small);
    color: var(--fg-2);
    overflow-wrap: anywhere;
  }

  .row__also {
    margin-top: 0.1rem;
    font-size: var(--t-small);
    color: var(--accent-text);
  }

  .row__states {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.2rem;
  }

  .flag {
    padding: 0 var(--gap-1);
    border: 1px solid currentColor;
    border-radius: var(--radius-control);
    font-size: var(--t-micro);
    line-height: 1.5;
    color: var(--fg-2);
  }

  .flag--fault {
    color: var(--fault-text);
  }

  .flag--dashed {
    border-style: dashed;
  }

  /*
   * The state word. Plain text in a frame, never a switch (read-only until P4).
   * Green only for "loaded every session" and red only for a read that failed
   * (DESIGN.md: 赤は障害専用ルール — 無効 is a choice, not a fault). Dashed means
   * "not established": unknown and unconfirmed.
   */
  .state {
    display: inline-block;
    padding: 0 var(--gap-2);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-control);
    font-size: var(--t-small);
    line-height: 1.5;
    white-space: nowrap;
    color: var(--fg);
  }

  .state__h {
    color: var(--fg-2);
  }

  .state--enabled {
    border-color: var(--pass);
    background: var(--pass-wash);
    color: var(--pass-text);
  }

  .state--disabled,
  .state--not-loaded {
    color: var(--fg-2);
  }

  .state--unknown,
  .state--unconfirmed {
    border-style: dashed;
    border-color: var(--fg-3);
    color: var(--fg-2);
  }

  .muted {
    color: var(--fg-2);
  }

  .list-empty,
  .list-fault {
    margin: var(--gap-4) 0;
    color: var(--fg-2);
  }

  .list-fault p {
    display: flex;
    gap: var(--gap-2);
    align-items: baseline;
    color: var(--fault-text);
    margin-bottom: var(--gap-2);
    overflow-wrap: anywhere;
  }

  /* Detail ------------------------------------------------------------ */

  .detail {
    min-height: 0;
    min-width: 0;
    overflow: auto;
    padding: var(--gap-3) var(--gap-4) var(--gap-4);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-panel);
  }

  .detail__empty h2 {
    font-size: var(--t-md);
    margin-bottom: var(--gap-2);
  }

  .session {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    align-items: baseline;
    gap: var(--gap-1) var(--gap-4);
    margin: 0 0 var(--gap-2);
    padding: var(--gap-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-control);
    background: var(--surface-inset);
  }

  .session dt {
    font-weight: 700;
  }

  .session dd {
    margin: 0;
  }

  .session__sum {
    font-size: var(--t-lg);
    font-weight: 700;
  }

  .detail__head h2 {
    font-size: var(--t-lg);
    overflow-wrap: anywhere;
  }

  .detail__origin {
    font-size: var(--t-small);
    color: var(--fg-2);
  }

  .detail__desc {
    margin-top: var(--gap-2);
    color: var(--fg-2);
  }

  .also-note {
    margin-top: var(--gap-3);
    padding: var(--gap-2) var(--gap-3);
    border: 1px solid var(--accent);
    border-radius: var(--radius-control);
    background: var(--select-wash);
    font-size: var(--t-small);
  }

  .inline-fault {
    display: flex;
    gap: var(--gap-2);
    align-items: baseline;
    margin-top: var(--gap-3);
    padding: var(--gap-2);
    border: 1px solid var(--fault);
    border-radius: var(--radius-control);
    background: var(--fault-wash);
    color: var(--fault-text);
    font-size: var(--t-small);
    overflow-wrap: anywhere;
  }

  .facts {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--gap-1) var(--gap-3);
    margin: var(--gap-3) 0;
    padding: var(--gap-2) var(--gap-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-control);
    background: var(--surface-inset);
    font-size: var(--t-small);
  }

  .facts--plain {
    border: 0;
    background: transparent;
    padding: 0;
    margin-top: 0;
  }

  .facts dt,
  .reach__facts dt {
    font-size: var(--t-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-2);
    padding-top: 0.1rem;
  }

  .facts dd,
  .reach__facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .label {
    margin: var(--gap-4) 0 var(--gap-2);
    font-size: var(--t-micro);
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-2);
  }

  .reach-list {
    margin: 0;
    padding: 0;
    list-style: none;
    border-top: 1px solid var(--line);
  }

  .reach {
    padding: var(--gap-2) 0 var(--gap-3);
    border-bottom: 1px solid var(--line);
  }

  .reach__top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-2);
  }

  .reach__harness {
    font-weight: 700;
    min-width: 4.5rem;
  }

  .certainty {
    margin-left: auto;
    font-size: var(--t-small);
    color: var(--fg-2);
  }

  .certainty--weak {
    padding: 0 var(--gap-1);
    border: 1px dashed var(--fg-3);
    border-radius: var(--radius-control);
  }

  .reach__facts {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--gap-1) var(--gap-3);
    margin-top: var(--gap-2);
    font-size: var(--t-small);
  }

  .basis {
    display: block;
    color: var(--fg-2);
  }

  .note {
    margin-top: var(--gap-2);
    font-size: var(--t-small);
    color: var(--fg-2);
    max-width: 64ch;
  }

  .note .linklike {
    color: var(--accent-text);
  }

  .plain {
    margin: 0 0 var(--gap-2);
    padding-left: 1.1rem;
    font-size: var(--t-small);
  }

  .plain li + li {
    margin-top: var(--gap-1);
  }

  .plain--paths {
    padding-left: 0;
    list-style: none;
    overflow-wrap: anywhere;
  }

  .sources {
    margin-top: var(--gap-3);
    font-size: var(--t-small);
  }

  .sources summary {
    cursor: pointer;
    color: var(--fg-2);
  }

  .sources summary:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .sources .plain--paths {
    max-height: 18rem;
    overflow: auto;
    margin-top: var(--gap-2);
    padding: var(--gap-2);
    border-radius: var(--radius-control);
    background: var(--surface-inset);
  }

  .sources .plain--paths:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }

  .src-status {
    display: inline-block;
    min-width: 4em;
    color: var(--fg-2);
  }

  .fault-text {
    color: var(--fault-text);
  }

  code {
    font-family: var(--mono);
    font-size: 0.95em;
    padding: 0 0.2em;
    border-radius: 3px;
    background: var(--surface-inset);
  }

  @media (forced-colors: active) {
    .row {
      border-color: CanvasText;
    }

    .row.is-selected {
      forced-color-adjust: none;
      border-color: Highlight;
      box-shadow: inset 4px 0 0 Highlight;
    }

    .state--enabled {
      border-width: 2px;
    }
  }
</style>
