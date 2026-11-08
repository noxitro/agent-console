<script lang="ts">
  /*
   * Which unit the Installed view reads: 個人, or a project (which brings its
   * プロジェクト and ローカル units with it). It sits in the header, where the
   * Copilot app keeps its project choice — the left rail it replaces took a
   * third pane, and three panes crushed the list just above the 62rem floor.
   *
   * Two segments. 個人 chooses the user unit at once; プロジェクト▾ opens a
   * panel with the discovered projects. The panel is a non-modal popover, not a
   * dialog: no focus trap, Escape and a click elsewhere close it, and focus goes
   * back to the segment that opened it. Its own writes (pin, hide, add) change
   * agent-console's ~/.agent-console/projects.json only.
   */

  import { tick } from "svelte";

  import Icon from "./Icon.svelte";
  import { InstalledState, USER_SCOPE } from "./installed.svelte.js";
  import { nextRowIndex, rowTabIndex } from "./rownav.js";
  import type { ProjectEntry } from "./scope-contract.js";

  interface Props {
    state: InstalledState;
  }

  let { state: s }: Props = $props();

  let open = $state(false);
  let trigger = $state<HTMLButtonElement | null>(null);
  let panel = $state<HTMLElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLElement | null>(null);
  let addPath = $state("");

  const df = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
  const day = (iso: string | undefined): string => (iso === undefined ? "—" : df.format(new Date(iso)));
  const SOURCE_LABEL: Record<string, string> = { claude: "Claude", copilot: "Copilot", manual: "手動" };

  async function show(): Promise<void> {
    open = true;
    await tick();
    search?.focus();
  }

  function close(returnFocus: boolean): void {
    if (!open) return;
    open = false;
    if (returnFocus) trigger?.focus();
  }

  async function choose(p: ProjectEntry): Promise<void> {
    close(true);
    await s.choose(p.id);
  }

  /** Escape inside the panel (or on the segment that opened it) closes it. */
  function onDocKey(event: KeyboardEvent): void {
    if (!open) return;
    const at = document.activeElement;
    if (!(panel?.contains(at) || trigger === at)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    }
  }

  /** ↑↓ Home End inside the project list; ↓ from the search box enters it. */
  function onListKey(event: KeyboardEvent): void {
    const items = [...(list?.querySelectorAll<HTMLButtonElement>("button.proj") ?? [])];
    const i = items.indexOf(event.target as HTMLButtonElement);
    if (i === -1) return;
    const next = nextRowIndex(event.key, i, items.length);
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  }

  function onSearchKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown") return;
    const first = list?.querySelector<HTMLButtonElement>("button.proj");
    if (first === null || first === undefined) return;
    event.preventDefault();
    first.focus();
  }

  /** A click or focus that lands outside the picker closes the panel. */
  function onDocPointer(event: PointerEvent): void {
    if (!open) return;
    const t = event.target as Node;
    if (panel?.contains(t) || trigger?.contains(t)) return;
    close(false);
  }

  function onFocusOut(event: FocusEvent): void {
    const to = event.relatedTarget as Node | null;
    if (to === null || panel?.contains(to) || trigger?.contains(to)) return;
    close(false);
  }

  async function addFolder(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const value = addPath.trim();
    if (value === "" || s.busy) return;
    if (await s.act("add", value, `フォルダを追加しました: ${value}`)) addPath = "";
  }

  const activeIndex = $derived(Math.max(0, s.visibleProjects.findIndex((p) => p.id === s.scope)));
  const projectChosen = $derived(s.scope !== USER_SCOPE);
</script>

<svelte:document onpointerdown={onDocPointer} onkeydown={onDocKey} />

<div class="picker">
  <div class="segs" role="group" aria-label="単位">
    <button
      type="button"
      class="seg"
      class:is-current={!projectChosen}
      aria-pressed={!projectChosen}
      onclick={() => {
        close(false);
        void s.choose(USER_SCOPE);
      }}>個人</button
    >
    <button
      type="button"
      class="seg seg--project"
      class:is-current={projectChosen}
      aria-expanded={open}
      aria-controls="project-panel"
      bind:this={trigger}
      onclick={() => (open ? close(false) : void show())}
    >
      <span class="seg__label">プロジェクト{#if s.project !== null}<span class="seg__sep" aria-hidden="true">:</span><span class="seg__name" translate="no">{s.project.name}</span>{/if}</span>
      <svg class="caret" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" /></svg>
    </button>
  </div>

  {#if open}
    <div
      id="project-panel"
      class="panel"
      role="region"
      aria-label="プロジェクトを選ぶ"
      bind:this={panel}
      onfocusout={onFocusOut}
    >
      <div class="panel__head">
        <label class="search">
          <Icon name="search" size={14} />
          <span class="sr-only">プロジェクトを絞り込む</span>
          <input
            type="search"
            name="project-filter"
            autocomplete="off"
            placeholder="名前・パスで絞り込む…"
            bind:this={search}
            bind:value={s.projectQuery}
            onkeydown={onSearchKey}
          />
        </label>
        <button
          type="button"
          class="btn btn--sm"
          aria-busy={s.projectsStatus === "running"}
          onclick={() => {
            if (!s.busy) void s.reload();
          }}
        >
          <Icon name="survey" size={14} />読み直す
        </button>
      </div>

      {#if s.projectsStatus === "failed"}
        <p class="fault" role="alert"><Icon name="fault" size={13} />プロジェクトの一覧を読めませんでした: {s.projectsError}</p>
      {:else if s.projects === null}
        <p class="empty">記録を集めています…</p>
      {:else if s.visibleProjects.length === 0}
        <p class="empty">
          {s.projectQuery.trim() === "" ? "Claude と Copilot の記録に、プロジェクトがありません。" : "当てはまるプロジェクトがありません。"}
        </p>
      {:else}
        <ul class="projects" role="list" aria-label="プロジェクト" bind:this={list}>
          {#each s.visibleProjects as p, i (p.id)}
            <li>
              <button
                type="button"
                class="proj"
                class:proj--muted={p.hidden === true || !p.git}
                aria-current={s.scope === p.id ? "true" : undefined}
                tabindex={rowTabIndex(i, activeIndex, s.visibleProjects.length)}
                onclick={() => void choose(p)}
                onkeydown={onListKey}
              >
                <span class="proj__name" translate="no">
                  {#if p.pinned === true}<span class="pin">固定</span>{/if}{p.name}
                </span>
                <span class="proj__meta">
                  <span class="num">{day(p.lastUsed)}</span>
                  <span>{p.sources.map((x) => SOURCE_LABEL[x]).join("・")}</span>
                  {#if p.worktrees > 0}<span>ワークツリー <span class="num">{p.worktrees}</span></span>{/if}
                  {#if !p.git}<span>git 外</span>{/if}
                  {#if p.hidden === true}<span>非表示</span>{/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if s.projects !== null}
        <div class="panel__foot">
          {#if s.project !== null}
            {@const p = s.project}
            <div class="current">
              <span class="current__label">選択中: <span translate="no">{p.name}</span></span>
              <button
                type="button"
                class="btn btn--sm"
                aria-busy={s.acting === "pin" || s.acting === "unpin"}
                onclick={() => {
                  if (!s.busy) void s.act(p.pinned === true ? "unpin" : "pin", p.id, p.pinned === true ? `${p.name} の固定を外しました。` : `${p.name} を上に固定しました。`);
                }}>{p.pinned === true ? "固定を外す" : "上に固定"}</button
              >
              <button
                type="button"
                class="btn btn--sm"
                aria-busy={s.acting === "hide" || s.acting === "unhide"}
                onclick={() => {
                  if (!s.busy) void s.act(p.hidden === true ? "unhide" : "hide", p.id, p.hidden === true ? `${p.name} を一覧に戻しました。` : `${p.name} を一覧から隠しました。`);
                }}>{p.hidden === true ? "一覧に戻す" : "一覧から隠す"}</button
              >
            </div>
            {#if s.actionError !== "" && s.failedAction !== "add"}
              <p class="fault"><Icon name="fault" size={13} />操作できませんでした: {s.actionError}</p>
            {/if}
          {/if}
          <label class="check">
            <input type="checkbox" bind:checked={s.showNonGit} />
            git 外のフォルダも出す(<span class="num">{s.projects.counts.nonGit}</span>)
          </label>
          <label class="check">
            <input type="checkbox" bind:checked={s.showHidden} />
            隠したものも出す(<span class="num">{s.projects.counts.hidden}</span>)
          </label>
          <form class="add" onsubmit={addFolder}>
            <label for="add-folder" class="label">フォルダを手で足す</label>
            <div class="add__row">
              <input
                id="add-folder"
                name="folder"
                class="field"
                type="text"
                autocomplete="off"
                translate="no"
                spellcheck="false"
                placeholder="例: D:\work\project"
                aria-describedby={s.actionError !== "" && s.failedAction === "add" ? "add-error" : undefined}
                bind:value={addPath}
              />
              <button type="submit" class="btn btn--sm" aria-busy={s.acting === "add"}>追加</button>
            </div>
            {#if s.actionError !== "" && s.failedAction === "add"}
              <p class="fault" id="add-error"><Icon name="fault" size={13} />追加できませんでした: {s.actionError}</p>
            {/if}
          </form>
          <p class="stat">
            記録 <span class="num">{s.projects.counts.candidates}</span> か所 → 一覧 <span class="num">{s.projects.counts.listed}</span> 件。実在しない <span class="num">{s.projects.counts.missing}</span>・除外 <span class="num">{s.projects.counts.excluded}</span>・まとめたワークツリー <span class="num">{s.projects.counts.worktreesMerged}</span>
            <span class="num">({s.projects.elapsedMs} ms)</span>
          </p>
          {#if s.projects.settingsError !== undefined}
            <p class="fault"><Icon name="fault" size={13} />固定・非表示の設定を読めないため反映していません: {s.projects.settingsError}</p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
  }

  .segs {
    display: flex;
    border: 1px solid var(--control);
    border-radius: var(--radius-control);
    overflow: hidden;
  }

  .seg {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-2);
    min-height: 2rem;
    max-width: 22rem;
    padding: 0 var(--gap-3);
    border: 0;
    border-right: 1px solid var(--line-strong);
    background: var(--surface-2);
    color: var(--fg);
    font-size: var(--t-small);
    white-space: nowrap;
    cursor: pointer;
  }

  .seg:last-child {
    border-right: 0;
  }

  .seg:hover:not(.is-current) {
    background: var(--surface-hover);
  }

  .seg.is-current {
    background: var(--accent);
    color: var(--on-accent);
  }

  .seg:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }

  .seg__label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .seg__sep {
    margin-right: 0.25em;
  }

  .seg__name {
    font-weight: 700;
  }

  .caret {
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }

  .seg[aria-expanded="true"] .caret {
    transform: rotate(180deg);
  }

  .panel {
    position: absolute;
    z-index: 20;
    top: calc(100% + var(--gap-1));
    left: 0;
    display: flex;
    flex-direction: column;
    width: min(26rem, calc(100vw - 2rem));
    max-height: min(34rem, calc(100dvh - 6rem));
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-panel);
    box-shadow: var(--shadow-dialog);
  }

  .panel__head {
    flex: none;
    display: flex;
    gap: var(--gap-2);
    padding: var(--gap-2);
    border-bottom: 1px solid var(--line);
  }

  .search {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    flex: 1 1 auto;
    min-width: 0;
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

  .search input,
  .field {
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

  .projects {
    flex: 1 1 auto;
    min-height: 6rem;
    margin: 0;
    padding: var(--gap-1);
    list-style: none;
    overflow: auto;
  }

  .proj {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    width: 100%;
    padding: var(--gap-2) var(--gap-3);
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--fg);
    text-align: left;
    font: inherit;
    cursor: pointer;
  }

  .proj:hover:not([aria-current="true"]) {
    background: var(--surface-hover);
  }

  .proj[aria-current="true"] {
    background: var(--select-wash);
    border-color: var(--accent);
  }

  .proj:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }

  .proj__name {
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .proj--muted .proj__name {
    color: var(--fg-2);
  }

  .proj__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--gap-2);
    font-size: var(--t-small);
    color: var(--fg-2);
  }

  .pin {
    margin-right: var(--gap-2);
    padding: 0 var(--gap-1);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-control);
    font-size: var(--t-micro);
    font-weight: 400;
    color: var(--fg-2);
  }

  .panel__foot {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    padding: var(--gap-2) var(--gap-3) var(--gap-3);
    border-top: 1px solid var(--line);
    background: var(--surface-2);
    border-radius: 0 0 var(--radius-panel) var(--radius-panel);
    font-size: var(--t-small);
  }

  .current {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-2);
  }

  .current__label {
    margin-right: auto;
    color: var(--fg-2);
    overflow-wrap: anywhere;
  }

  .check {
    display: flex;
    gap: var(--gap-2);
    align-items: center;
  }

  .check input {
    accent-color: var(--accent);
  }

  .label {
    display: block;
    margin-bottom: var(--gap-1);
    font-size: var(--t-micro);
    letter-spacing: 0.08em;
    color: var(--fg-2);
  }

  .add__row {
    display: flex;
    gap: var(--gap-2);
  }

  .field {
    padding: 0 var(--gap-2);
    border: 1px solid var(--control);
    border-radius: var(--radius-control);
    background: var(--surface-inset);
    font-family: var(--mono);
    font-size: var(--t-small);
  }

  .field:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }

  .empty,
  .stat {
    color: var(--fg-2);
    font-size: var(--t-small);
  }

  .empty {
    margin: var(--gap-3);
  }

  .fault {
    display: flex;
    gap: var(--gap-2);
    align-items: baseline;
    margin: var(--gap-2);
    padding: var(--gap-2);
    border: 1px solid var(--fault);
    border-radius: var(--radius-control);
    background-color: var(--surface);
    background-image: linear-gradient(var(--fault-wash), var(--fault-wash));
    color: var(--fault-text);
    font-size: var(--t-small);
    overflow-wrap: anywhere;
  }

  .panel__foot .fault {
    margin: 0;
  }

  @media (forced-colors: active) {
    .seg.is-current {
      forced-color-adjust: none;
      background: Highlight;
      color: HighlightText;
    }

    .proj[aria-current="true"] {
      position: relative;
    }

    /* Only the mark opts out of the theme; the text keeps its colours. */
    .proj[aria-current="true"]::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 4px;
      forced-color-adjust: none;
      background: Highlight;
    }

    .panel {
      border-color: CanvasText;
    }
  }
</style>
