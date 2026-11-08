<script lang="ts">
  /**
   * The asset table — the console's centre of gravity.
   *
   * Idiom, executed plainly: a search box and a filter above a table, one row
   * per asset, a selected row that drives the detail pane. The reference is the
   * VS Code extensions view; nothing here tries to be more interesting than
   * that, because the job is 「目的の資産に1クリックで到達」 and interest costs
   * reading time.
   *
   * Two things it refuses to fake:
   *  - a missing `version` is 「—」, never an invented number (PRODUCT);
   *  - a per-target state with no plan behind it is 「PLAN 未取得」, not 整合
   *    (SPEC §9.4). The badge strip in the last column is derived, and it says
   *    so per target — not by blanking the column, which also hid the states
   *    inventory settles on its own.
   */
  import Icon from "./Icon.svelte";
  import {
    DELIVERY_LABEL,
    DELIVERY_MARK,
    FILTER_LABEL,
    SCOPE_FILTERS,
    SCOPE_FILTER_LABEL,
    SCOPE_LABEL,
    SECOND_COLUMN_LABEL,
    TARGET_FILTERS,
    TARGET_FILTER_LABEL,
    emptyMessage,
    emptyReason,
    formatDate,
    isUnmeasured,
    projectLabel,
    secondColumnValue,
    type AssetRow,
    type RowFilter,
    type ScopeFilter,
    type TargetFilter,
  } from "./assets.js";
  import type { AssetType, ScopeProject } from "./contract.js";
  import {
    ROW_ITSELF,
    activeRowIndex,
    isTextSelectionClick,
    nextControlIndex,
    nextRowIndex,
    rowTabIndex,
  } from "./rownav.js";
  import { nextSegmentIndex, segmentTabIndex } from "./segment.js";
  import type { Status } from "./session.svelte.js";

  const {
    rows,
    total,
    totalIgnoringTarget,
    type,
    query,
    filter,
    targetFilter,
    scopeFilter,
    projectFilter,
    projects,
    scopesStatus,
    selected,
    busy,
    surveyStatus,
    hasPlan,
    diffStatus,
    onQuery,
    onFilter,
    onTargetFilter,
    onScopeFilter,
    onProjectFilter,
    onSelect,
    onToggle,
    onRemove,
    onDiff,
  }: {
    rows: AssetRow[];
    /** Row count before search/filter, so the header can say "3 / 12". */
    total: number;
    /**
     * How many rows the search and state filter alone would leave — the same
     * list without the target narrowing. It is what lets the empty state name
     * the narrowing as the cause and say what dropping it would bring back,
     * instead of guessing which of three controls emptied the list.
     */
    totalIgnoringTarget: number;
    type: AssetType;
    query: string;
    filter: RowFilter;
    targetFilter: TargetFilter;
    /** 個人 / プロジェクト / ローカル / すべて — the scope segment. */
    scopeFilter: ScopeFilter;
    /** The project chosen in the picker beside it, or null for every project. */
    projectFilter: string | null;
    /** Discovered projects; empty until `ac scopes` has answered. */
    projects: ScopeProject[];
    /** How the scope layer's own reading stands. */
    scopesStatus: Status;
    /** The selected row's key (a 個人 row's key is its name). */
    selected: string | null;
    busy: boolean;
    /**
     * Whether a reading of the machine has actually finished.
     *
     * The list is empty for four different reasons and only one of them is
     * 「無い」. Without this the scroller said 「この種別の資産はまだありません。」
     * during the very first survey and again after one had failed — a confident
     * assertion about a machine nobody had managed to read, printed directly
     * below a fault plate saying the opposite (DESIGN: 存在しない値を描かない).
     */
    surveyStatus: Status;
    /** SPEC §9.4 — without a plan 「差分ありのみ」 cannot select anything. */
    hasPlan: boolean;
    /**
     * Whether the plan this filter needs is being taken right now.
     *
     * `hasPlan` alone cannot tell 「まだ取っていない」 from 「いま取っている」:
     * `plan` stays null for the whole of `runPlan()`, so the empty state went on
     * offering 差分を取る, in the present tense, while the status bar beside it
     * read 「PLAN 取得中…」 and the live region said 差分を取得中です。
     */
    diffStatus: Status;
    onQuery: (value: string) => void;
    onFilter: (value: RowFilter) => void;
    onTargetFilter: (value: TargetFilter) => void;
    onScopeFilter: (value: ScopeFilter) => void;
    onProjectFilter: (value: string | null) => void;
    onSelect: (key: string) => void;
    onToggle: (row: AssetRow) => void;
    onRemove: (row: AssetRow) => void;
    onDiff: () => void;
  } = $props();

  const FILTERS: RowFilter[] = ["all", "fault", "pending", "disabled"];

  const secondColumn = $derived(SECOND_COLUMN_LABEL[type]);

  /* --- The two narrowings are composite widgets ----------------------- *
   *
   * `role="radiogroup"` promises one tab stop and arrow keys, so that is what
   * they get. Ten individually-tabbable buttons would announce themselves as
   * radios and behave like a row of links, and would put ten presses between
   * the search box and the list — the same growth `rownav.ts` exists to stop.
   * The arithmetic is in `segment.ts`.
   */

  const filterEls: (HTMLButtonElement | undefined)[] = [];
  const targetEls: (HTMLButtonElement | undefined)[] = [];
  const scopeEls: (HTMLButtonElement | undefined)[] = [];

  /** Arrow keys move focus and the selection together, as a radio group does. */
  function moveSegment<T>(
    event: KeyboardEvent,
    index: number,
    els: (HTMLButtonElement | undefined)[],
    values: readonly T[],
    pick: (value: T) => void,
  ): void {
    const next = nextSegmentIndex(event.key, index, values.length);
    if (next === null) return;
    event.preventDefault();
    els[next]?.focus();
    const value = values[next];
    if (value !== undefined) pick(value);
  }

  /**
   * Why the list is empty, told apart — and the sentence for it.
   *
   * The decision lives in `assets.ts` (`emptyReason`), beside `filterRows` and
   * `describeNarrowings`, for the reason `rownav.ts` and `segment.ts` exist:
   * it turns on behaviour this component cannot see — `survey()` keeps the old
   * inventory through a re-survey and discards it on failure, `plan` stays null
   * for the whole of `runPlan()` — and a rule that spans two files needs a test,
   * which a nest of ternaries in a template cannot have.
   */
  const reason = $derived(
    emptyReason({
      surveyStatus,
      diffStatus,
      total,
      totalIgnoringTarget,
      filter,
      targetFilter,
      hasPlan,
      scope: scopeFilter,
      scopesStatus,
      projectCount: projects.length,
    }),
  );

  const unmeasured = $derived(isUnmeasured(reason));
  /** The empty state is 「差分の有無が未判定」 and 差分を取る is the way out. */
  const emptyNeedsPlan = $derived(reason.kind === "needs-plan");

  /**
   * The count, or the dash.
   *
   * 「0 件」 while nothing has been read is the same false measurement the empty
   * message refuses to print, in three characters.
   */
  const countLabel = $derived(
    unmeasured
      ? "—"
      : rows.length === total
        ? `${total} 件`
        : `${rows.length} / ${total} 件`,
  );

  /**
   * The target order the badge strip uses, taken from a row rather than from a
   * constant — it is the engine's `inventory.targets` order, identical for every
   * row on screen, which is what lets one legend stand for the whole column.
   */
  const badgeLegend = $derived(rows[0]?.deliveries.map((d) => d.target) ?? []);

  /* --- Keyboard: one tab stop for the whole list ---------------------- *
   *
   * The list is a grid, so the *row* is the focusable thing and the controls
   * inside it are reached with →/←, not with Tab. Before this, five assets
   * meant fifteen tab stops between the toolbar and the detail pane; now it is
   * one, whatever the asset count. The arithmetic is in `rownav.ts`.
   */

  const keys = $derived(rows.map((row) => row.key));

  /** The row the keyboard last touched — by key, so filtering cannot move it. */
  let focusedKey = $state<string | null>(null);

  const activeIndex = $derived(activeRowIndex(keys, focusedKey, selected));

  const rowEls: (HTMLTableRowElement | undefined)[] = [];

  /**
   * The row's own interactive cells, in reading order.
   *
   * No `disabled` filter any more: the two controls in a row are never disabled
   * (they mark themselves `aria-busy` and guard in the handler, so pressing one
   * cannot drop the focus that pressed it), and a filter for a state that cannot
   * occur reads as a case someone still has to think about. A busy control stays
   * reachable with →/← on purpose — it is working, not unavailable.
   */
  function controlsOf(rowEl: HTMLElement): HTMLElement[] {
    return Array.from(rowEl.querySelectorAll<HTMLElement>("[data-row-control]"));
  }

  function focusRow(index: number): void {
    const row = rows[index];
    if (row === undefined) return;
    focusedKey = row.key;
    rowEls[index]?.focus();
  }

  /** ↑↓ move the selection with the focus, which is what VS Code's lists do. */
  function moveTo(index: number): void {
    const row = rows[index];
    if (row === undefined) return;
    focusRow(index);
    if (row.key !== selected) onSelect(row.key);
  }

  function handleRowClick(index: number, row: AssetRow): void {
    // A click that only finished a drag was a text selection, not a choice.
    if (isTextSelectionClick(window.getSelection()?.toString())) return;
    focusedKey = row.key;
    rowEls[index]?.focus();
    if (row.key !== selected) onSelect(row.key);
  }

  function handleRowKeydown(event: KeyboardEvent, index: number, row: AssetRow): void {
    const rowEl = event.currentTarget as HTMLTableRowElement;
    const target = event.target as HTMLElement | null;
    const controls = controlsOf(rowEl);
    const focusedControl = target?.closest<HTMLElement>("[data-row-control]") ?? null;
    const current = focusedControl === null ? ROW_ITSELF : controls.indexOf(focusedControl);

    const control = nextControlIndex(event.key, current, controls.length);
    if (control !== null) {
      event.preventDefault();
      if (control === ROW_ITSELF) rowEl.focus();
      else controls[control]?.focus();
      return;
    }

    const next = nextRowIndex(event.key, index, rows.length);
    if (next !== null) {
      event.preventDefault();
      moveTo(next);
      return;
    }

    // Enter/Space belong to whatever control has focus; on the bare row they
    // mean "choose this asset".
    if (focusedControl === null && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      focusedKey = row.key;
      onSelect(row.key);
    }
  }
</script>

<section class="table-panel" aria-label="資産一覧">
  <div class="toolbar">
    <div class="search">
      <Icon name="search" size={14} />
      <!--
        `onkeydown` claims Escape rather than leaving it to the browser's own
        clear-on-Escape: the drawer below listens for Escape on `window`, and an
        unclaimed keystroke closed a plan the owner was reading while clearing a
        search box they were not looking at. Claiming it means marking it
        handled, which is what the drawer checks.

        The placeholder names the second column rather than a fixed 「version」:
        `matchesQuery` searches name, description, `version` **and** `kindNote`,
        and `kindNote` is exactly what that column holds — transport under MCP,
        model under AGENTS, agent under COMMANDS. A fixed word named a field
        three of the four tabs do not have, and left the one they do have
        unmentioned while it quietly matched.
      -->
      <input
        type="search"
        value={query}
        placeholder="名前・説明・{secondColumn} で絞り込む"
        aria-label="資産を絞り込む"
        oninput={(event) => onQuery(event.currentTarget.value)}
        onkeydown={(event) => {
          if (event.key !== "Escape" || query === "") return;
          event.preventDefault();
          onQuery("");
        }}
      />
    </div>

    <!--
      ARCHITECTURE「単位とプロジェクト」— the scope axis, orthogonal to the
      target narrowing and drawn in the same segmented vocabulary. 個人 is the
      default and is the console as it was. The picker beside it narrows the
      project and local scopes to one project; a native select, because the
      project list is long and open-ended where these four are fixed.
    -->
    <div class="target-filter">
      <span class="annotation" aria-hidden="true">単位</span>
      <div class="filters" role="radiogroup" aria-label="単位で絞り込む">
        {#each SCOPE_FILTERS as value, index (value)}
          <button
            bind:this={scopeEls[index]}
            type="button"
            class="chip"
            role="radio"
            aria-checked={scopeFilter === value}
            tabindex={segmentTabIndex(index, SCOPE_FILTERS.indexOf(scopeFilter), SCOPE_FILTERS.length)}
            onclick={() => onScopeFilter(value)}
            onkeydown={(event) => moveSegment(event, index, scopeEls, SCOPE_FILTERS, onScopeFilter)}
          >
            {SCOPE_FILTER_LABEL[value]}
          </button>
        {/each}
      </div>
      {#if scopeFilter !== "user"}
        <select
          class="project-picker"
          aria-label="プロジェクト"
          value={projectFilter ?? ""}
          onchange={(event) => {
            const value = event.currentTarget.value;
            onProjectFilter(value === "" ? null : value);
          }}
        >
          <option value="">すべてのプロジェクト({projects.length})</option>
          {#each projects as project (project.root)}
            <option value={project.root} title={project.root}>{projectLabel(project.root)} — {project.root}</option>
          {/each}
        </select>
      {/if}
    </div>

    <!--
      A radio group, not a select: four options that are all worth seeing at
      once, and the one the owner reaches for most (不良のみ) should be one
      click away rather than two.
    -->
    <div class="filters" role="radiogroup" aria-label="表示する資産">
      {#each FILTERS as value, index (value)}
        <button
          bind:this={filterEls[index]}
          type="button"
          class="chip"
          role="radio"
          aria-checked={filter === value}
          tabindex={segmentTabIndex(index, FILTERS.indexOf(filter), FILTERS.length)}
          onclick={() => onFilter(value)}
          onkeydown={(event) => moveSegment(event, index, filterEls, FILTERS, onFilter)}
        >
          {FILTER_LABEL[value]}
        </button>
      {/each}
    </div>

    <!--
      SPEC §10.6 — the same segmented vocabulary as the state filter beside it,
      because it is the same kind of control: one axis, every position visible,
      the selection filled in ink.

      It carries a visible group name where the state filter needs none. The
      state options say what they select (不良のみ); these are proper names in
      the engine's own spelling, and 「claude」 on its own does not say which
      question it answers. The label is a drawing's annotation — mono, uppercase
      — and is hidden from assistive technology, which reads the group's own
      label instead of the same word twice.
    -->
    <div class="target-filter">
      <span class="annotation" aria-hidden="true">TARGET</span>
      <div class="filters filters--target" role="radiogroup" aria-label="ターゲットで絞り込む">
        {#each TARGET_FILTERS as value, index (value)}
          <button
            bind:this={targetEls[index]}
            type="button"
            class="chip"
            class:chip--id={value !== "all"}
            role="radio"
            aria-checked={targetFilter === value}
            tabindex={segmentTabIndex(
              index,
              TARGET_FILTERS.indexOf(targetFilter),
              TARGET_FILTERS.length,
            )}
            onclick={() => onTargetFilter(value)}
            onkeydown={(event) =>
              moveSegment(event, index, targetEls, TARGET_FILTERS, onTargetFilter)}
          >
            {TARGET_FILTER_LABEL[value]}
          </button>
        {/each}
      </div>
    </div>

    <!-- Not a live region: App's single status region reads the count out
         when the owner changes the tab, the search or a filter. -->
    <p class="count num">{countLabel}</p>
  </div>

  <!-- The scroller is no longer a tab stop of its own: the grid inside it is
       keyboard-navigable, and a focused row is scrolled into view by the
       browser, so a second stop for "the scrolling box" would only be a stop
       that announces nothing and does nothing. -->
  <div class="scroller">
    {#if rows.length === 0}
      <!-- 破線 = 未確定 (DESIGN: Shapes). A list nobody has measured — or whose
           verdict is still being computed — is not an empty list, and it should
           not be dressed as one. -->
      <p
        class="empty"
        class:empty--unmeasured={unmeasured ||
          reason.kind === "needs-plan" ||
          reason.kind === "plan-running"}
      >
        {emptyMessage(reason)}
        {#if emptyNeedsPlan}
          <button
            type="button"
            class="linklike"
            aria-busy={busy}
            onclick={() => {
              if (!busy) onDiff();
            }}>差分を取る</button
          >と状態が確定します。
        {/if}
      </p>
    {:else}
      <table role="grid" aria-label="資産一覧" aria-rowcount={rows.length + 1}>
        <thead>
          <tr>
            <th scope="col" class="col-name">名前</th>
            <th scope="col" class="col-meta">{secondColumn}</th>
            <th scope="col" class="col-scope">単位</th>
            <th scope="col" class="col-state">状態</th>
            <!--
              The badge strip is five marks in a fixed order, and until this
              legend the only way to learn which mark was which target was to
              hover each one — a tooltip carrying primary information, on every
              row, for the job PRODUCT names second (「1資産がどこへ届いているか」).
              One legend serves the whole column because the order is the
              engine's and is the same in every row. Hidden from assistive
              technology: each badge already carries its target's name in full.
            -->
            <th scope="col" class="col-targets">
              適用先
              {#if badgeLegend.length > 0}
                <span class="legend" aria-hidden="true">
                  {#each badgeLegend as target (target)}
                    <span class="legend__item">{target}</span>
                  {/each}
                </span>
              {/if}
            </th>
            <th scope="col" class="col-date">最終更新</th>
            <th scope="col" class="col-actions"><span class="sr-only">アクション</span></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row, index (row.key)}
            <!--
              The row *is* the control. It was a 64px button in a 832px row
              before, which asked for pointer precision the job never needed;
              now the whole row selects, and the two controls inside it stop
              their own clicks from reading as a row choice.
            -->
            <tr
              bind:this={rowEls[index]}
              class:is-selected={row.key === selected}
              class:is-disabled={!row.enabled}
              aria-selected={row.key === selected}
              tabindex={rowTabIndex(index, activeIndex, rows.length)}
              onclick={() => handleRowClick(index, row)}
              onkeydown={(event) => handleRowKeydown(event, index, row)}
            >
              <th scope="row" class="col-name">
                <!-- `id` on the name alone, not the cell: the cell also holds
                     the 不良 flag, which is not part of the switch's name.
                     Keyed by index because an asset name may hold anything the
                     filesystem allows (`skill.invalid-name` exists for a
                     reason) and an id may not. -->
                <span class="row-name" id="asset-{index}-name">{row.name}</span>
                {#if row.missingManifest === true}
                  <span class="flag flag--fault">SKILL.md なし</span>
                {:else if row.hasFault}
                  <span class="flag flag--fault">不良</span>
                {/if}
                {#if row.shadowedEverywhere === true}
                  <span class="flag flag--shadow">上書きされて効いていない</span>
                {:else if row.shadowedSomewhere === true}
                  <span class="flag flag--shadow">一部で上書き</span>
                {/if}
                {#if row.overriddenIn !== undefined}
                  <span class="flag flag--shadow"
                    >{new Set(row.overriddenIn.map((o) => o.project)).size} プロジェクトで上書きあり</span
                  >
                {/if}
              </th>
              <td class="col-meta num">{secondColumnValue(row)}</td>
              <td class="col-scope">
                <!-- The scope as a badge, and where the thing is. The path is
                     the place a person would open; for a 個人 row it is the
                     source this tool distributes from. -->
                <span class="scope-badge scope-badge--{row.scope}">{SCOPE_LABEL[row.scope]}</span>
                {#if row.unverified === true}
                  <!-- 破線 = 未確定 (DESIGN: Shapes): a place no official document
                       confirms some reader of it reads. -->
                  <span class="scope-badge scope-badge--unverified">未確認</span>
                {/if}
                {#if row.scopePath !== undefined}
                  <span class="scope-path" title={row.scopePath}
                    >{row.scopePath}{row.scopeEntry !== undefined ? ` › ${row.scopeEntry}` : ""}</span
                  >
                {/if}
              </td>
              <td class="col-state">
                <!--
                  SPEC §9.1: enabled/disabled is exclusion in the manifest, so
                  the control is a switch and the engine is what flips it.
                -->
                <!--
                  `aria-busy` rather than `disabled`, and the guard is in the
                  handler — the rule `app.css` states for the confirm buttons,
                  applied where it is needed just as much. Pressing this switch
                  is what makes `busy` true, so `disabled={busy}` disabled the
                  element that had focus and dropped it on `<body>`: every toggle
                  cost a keyboard user a walk back from the top of the window.

                  The name is composed from the two things already on screen —
                  the asset's name and the switch's own visible word — rather
                  than written separately as 「… を配布」. A name that does not
                  contain the visible label is a name voice control cannot say
                  (WCAG 2.5.3 label-in-name): 「有効 をクリック」 matched nothing.
                  The state word appearing in both the name and `aria-checked` is
                  the accepted cost, and is how the same control reads in the
                  view this console takes as its standard.
                -->
                {#if row.readOnly}
                  <!-- No switch: on/off here is this tool's manifest, and a
                       project or local asset is not in it (P2 writes nothing). -->
                  <span class="readonly">読み取りのみ</span>
                {:else}
                <button
                  type="button"
                  class="toggle"
                  role="switch"
                  data-row-control
                  tabindex="-1"
                  aria-checked={row.enabled}
                  aria-labelledby="asset-{index}-name asset-{index}-state"
                  aria-busy={busy}
                  onclick={(event) => {
                    event.stopPropagation();
                    if (!busy) onToggle(row);
                  }}
                >
                  <span class="toggle__dot" aria-hidden="true"></span>
                  <span id="asset-{index}-state">{row.enabled ? "有効" : "無効"}</span>
                </button>
                {/if}
              </td>
              <td class="col-targets">
                <!--
                  One badge per target, always. `deliveryFor` has already
                  applied SPEC §9.4 in order, so a state that needs a plan
                  arrives here as 「PLAN 未取得」 and one that does not arrives
                  settled. Collapsing the whole column into a single
                  「PLAN 未取得」 chip threw the settled ones away with the rest:
                  「非対応」 is decided by inventory alone, so the COMMANDS tab
                  said nothing at all about the four targets that cannot carry a
                  command until a plan had been taken — while the map view, from
                  the same data, drew them correctly (SPEC §10.6).
                -->
                <span class="badges">
                  {#each row.deliveries as delivery (delivery.target)}
                    <span
                      class="badge badge--{delivery.state}"
                      title="{delivery.target}: {DELIVERY_LABEL[delivery.state]}"
                    >
                      <span aria-hidden="true">{DELIVERY_MARK[delivery.state]}</span>
                      <span class="sr-only"
                        >{delivery.target}: {DELIVERY_LABEL[delivery.state]}</span
                      >
                    </span>
                  {/each}
                </span>
              </td>
              <td class="col-date num">{formatDate(row.modified)}</td>
              <td class="col-actions">
                {#if !row.readOnly}
                <button
                  type="button"
                  class="icon-btn"
                  data-row-control
                  tabindex="-1"
                  aria-busy={busy}
                  aria-label="{row.name} をソースから削除"
                  onclick={(event) => {
                    event.stopPropagation();
                    if (!busy) onRemove(row);
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</section>

<style>
  .table-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--paper);
    border: 1px solid var(--rule-strong);
  }

  /* Toolbar ----------------------------------------------------------- */

  .toolbar {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-3);
    padding: var(--gap-2) var(--gap-3);
    border-bottom: 1px solid var(--rule);
    background: var(--paper-panel);
  }

  .search {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    flex: 1 1 14rem;
    min-width: 10rem;
    padding: 0 var(--gap-2);
    border: 1px solid var(--rule-strong);
    background: var(--paper);
    color: var(--ink-2);
  }

  .search:focus-within {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }

  input {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 2rem;
    border: 0;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: var(--t-body);
  }

  input:focus {
    outline: none;
  }

  /* The browser default placeholder grey is 4.1:1 on paper; --ink-2 is 5.5:1. */
  input::placeholder {
    color: var(--ink-2);
    opacity: 1;
  }

  /* A group wraps its own chips only when the window is too narrow for it. */
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    border: 1px solid var(--rule-strong);
  }

  /*
   * `nowrap` because these are single tokens: a target id broken at its hyphen
   * reads as two names ("copilot-" / "cli"), and 「不良のみ」 broken between
   * characters reads as neither word. On a narrow window the group wraps
   * *between* chips instead (`.filters`), so a token is never split.
   */
  .chip {
    min-height: 2rem;
    padding: 0 var(--gap-3);
    border: 0;
    border-right: 1px solid var(--rule);
    background: var(--paper);
    font-size: var(--t-small);
    white-space: nowrap;
    cursor: pointer;
  }

  .chip:last-child {
    border-right: 0;
  }

  .chip[aria-checked="true"] {
    background: var(--ink);
    color: var(--paper);
  }

  .chip:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -2px;
  }

  /* A contrast theme repaints the ink fill to Canvas (app.css: Forced colours). */
  @media (forced-colors: active) {
    .chip[aria-checked="true"] {
      forced-color-adjust: none;
      background: Highlight;
      color: HighlightText;
    }

    :global(.app--frozen) .chip[aria-checked="true"] {
      background: GrayText;
      color: Canvas;
    }
  }

  /* Target narrowing ---------------------------------------------------
   *
   * The group and its annotation travel together: at narrow widths the toolbar
   * wraps between groups, never between a label and the control it names.
   */
  .target-filter {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
  }

  .filters--target .chip {
    padding: 0 var(--gap-2);
  }

  /* DESIGN: 等幅は識別子ルール — target ids are issued by the tools, not
     written by us, so they are set in the mono face. 「すべて」 is our own
     word for "no narrowing" and stays in the interface's own face. The size
     stays --t-small, the documented size for a filter chip: two adjacent
     groups set at two sizes reads as an accident rather than as a distinction,
     and the change of face already carries the distinction. */
  .chip--id {
    font-family: var(--mono);
    letter-spacing: 0.01em;
  }

  /*
   * Pushed to the trailing edge. With three control groups in the toolbar the
   * bar wraps on a narrow window, and a count sitting immediately after the
   * TARGET group read as a count *of targets*; against the right edge it reads
   * as what it is — the size of the list below.
   */
  .count {
    flex: none;
    margin-left: auto;
    font-size: var(--t-small);
    color: var(--ink-2);
  }

  /* Table ------------------------------------------------------------- */

  /*
   * Rows below the fold are reached with ↑↓ inside the grid, which scrolls the
   * focused row into view — so the box itself needs no tab stop.
   */
  /*
   * `position: relative` makes the scroller the containing block of the
   * visually hidden (absolutely positioned) labels in the header; without it
   * they escape the clip and widen the whole page on a narrow window.
   */
  .scroller {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--t-body);
  }

  thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: var(--gap-2) var(--gap-3);
    text-align: left;
    font-size: var(--t-micro);
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-2);
    background: var(--paper-panel);
    border-bottom: 1px solid var(--rule-strong);
  }

  tbody th,
  tbody td {
    padding: var(--gap-1) var(--gap-3);
    border-bottom: 1px solid var(--rule);
    text-align: left;
    font-weight: 400;
    vertical-align: middle;
  }

  /* The affordance for "this whole row is the target": the row lights up as a
     whole, not the name alone. */
  tbody tr:hover {
    background: var(--paper-panel);
  }

  tbody tr:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -2px;
  }

  tbody tr.is-selected {
    background: var(--caution-wash);
    box-shadow: inset 2px 0 0 var(--ink);
  }

  /* A contrast theme drops box-shadow and repaints the wash, which left the
     selected row unmarked. The bar is redrawn as a cell edge in Highlight; only
     the edge opts out of the theme, so the row's text keeps the theme's colours. */
  @media (forced-colors: active) {
    tbody tr.is-selected > :first-child {
      position: relative;
    }

    tbody tr.is-selected > :first-child::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 4px;
      forced-color-adjust: none;
      background: Highlight;
    }
  }

  tbody tr.is-disabled .row-name {
    color: var(--ink-2);
    text-decoration: line-through;
    text-decoration-thickness: 1px;
  }

  .row-name {
    display: inline-block;
    padding: var(--gap-1) 0;
    font-weight: 500;
  }

  .col-meta {
    color: var(--ink-2);
    font-size: var(--t-small);
  }

  .col-date {
    color: var(--ink-2);
    font-size: var(--t-small);
    white-space: nowrap;
  }

  .col-actions {
    width: 1%;
    white-space: nowrap;
  }

  /* A flag wraps as a whole, never between its characters. */
  .flag {
    display: inline-block;
    margin-left: var(--gap-2);
    padding: 0 var(--gap-1);
    border: 1px solid currentColor;
    font-size: var(--t-micro);
    white-space: nowrap;
  }

  .flag--fault {
    color: var(--fault-text);
  }

  /* Overridden: a quiet fact, not a fault — no signal colour (DESIGN: 信号色の独占). */
  .flag--shadow {
    color: var(--ink-2);
    background: var(--paper-inset);
  }

  .col-scope {
    max-width: 13rem;
    font-size: var(--t-small);
  }

  .scope-badge {
    display: inline-block;
    margin-right: var(--gap-1);
    padding: 0 var(--gap-1);
    border: 1px solid var(--rule-strong);
    font-size: var(--t-micro);
    white-space: nowrap;
  }

  .scope-badge--project,
  .scope-badge--local {
    border-color: var(--ink-2);
  }

  .scope-badge--unverified {
    color: var(--ink-2);
    border-style: dashed;
  }

  .scope-path {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: var(--t-micro);
    color: var(--ink-2);
  }

  .readonly {
    font-size: var(--t-small);
    color: var(--ink-2);
    white-space: nowrap;
  }

  .project-picker {
    min-height: 2rem;
    max-width: 16rem;
    border: 1px solid var(--rule-strong);
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: var(--t-small);
  }

  .project-picker:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }

  /* Switch ------------------------------------------------------------ */

  /* The switch (`.toggle`) is shared with the detail pane and lives in app.css;
     the delete button keeps the same focus ring and busy look beside it. */
  .icon-btn:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }

  .icon-btn[aria-busy="true"] {
    color: var(--ink-3);
    border-color: var(--rule);
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border: 1px solid transparent;
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
  }

  .icon-btn:hover:not([aria-busy="true"]) {
    border-color: var(--fault);
    color: var(--fault-text);
  }

  /* Badges ------------------------------------------------------------ */

  /* The strip and its header legend are the same grid, so label *i* sits over
     badge *i*. Equal columns rather than content-sized ones: the badges are all
     one width, and a legend whose columns drifted from them would be worse than
     no legend at all. */
  .badges,
  .legend {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(1.35rem, 1fr);
    gap: var(--gap-1);
    justify-items: center;
  }

  /* --t-micro, the floor of the type scale. It was 9px, below that floor, to
     keep the column narrow; the ids are short enough that the column only
     widens a little, and a label too small to read labels nothing. --ink-2,
     not --ink-3: --ink-3 on the header ground measures 3.27:1, below the 4.5:1
     that text this size needs; --ink-2 is 5.29:1. The face is mono because
     these are target ids issued by the tools (DESIGN: 等幅は識別子ルール). */
  .legend {
    margin-top: 2px;
    font-family: var(--mono);
    font-size: var(--t-micro);
    /* A hair tighter, so the longest id (copilot-cli) still fits the column
       at the widths where it used to fit at 9px. */
    letter-spacing: -0.02em;
    text-transform: none;
    color: var(--ink-2);
  }

  .legend__item {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The badge itself (`.badge`, `.badge--*`) is shared with the detail pane and
     lives in app.css. */

  .empty {
    padding: var(--gap-5);
    color: var(--ink-2);
  }

  /* 破線 = 実在しない・未確定 (DESIGN: Shapes) — the same mark the 未取得 badges
     and the dialog's 但し書き carry, for the same reason: this is not a measured
     zero. */
  .empty--unmeasured {
    margin: var(--gap-3);
    padding: var(--gap-4);
    border: 1px dashed var(--rule-strong);
    background: var(--paper-inset);
  }
</style>
