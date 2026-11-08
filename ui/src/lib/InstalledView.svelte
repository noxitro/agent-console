<script lang="ts">
  /*
   * Installed (ARCHITECTURE.md「単位とプロジェクト」): what Claude Code and
   * Copilot load, by unit, with what each row costs every session.
   *
   * Same grammar as the distribution view (DESIGN.md): a list on the left, a
   * table in the middle, a detail pane on the right — VS Code's extensions view
   * is the bar. The rail chooses the unit (個人, or a project, which brings its
   * プロジェクト and ローカル units with it); the totals above the table answer
   * "how much does a session here carry"; the detail pane answers "who reads
   * this, through which path, decided by which setting, and how sure are we".
   *
   * Read-only. The only writes reachable here are the rail's pin / hide / add,
   * which change agent-console's own ~/.agent-console/projects.json.
   */

  import { tick } from "svelte";

  import Icon from "./Icon.svelte";
  import {
    InstalledState,
    needsAttention,
    USER_SCOPE,
    type HarnessFilter,
    type KindFilter,
    type StateFilter,
    type UnitFilter,
  } from "./installed.svelte.js";
  import {
    CERTAINTY_LABEL,
    HARNESSES,
    KIND_LABEL,
    KIND_ORDER,
    ORIGIN_LABEL,
    SCOPE_LABEL,
    STATE_LABEL,
    type HarnessId,
    type InstalledReach,
    type InstalledRow,
    type ProjectEntry,
    type ReachState,
    type ScopeKind,
  } from "./scope-contract.js";

  const USER_ONLY: ScopeKind[] = ["user"];

  interface Props {
    state: InstalledState;
    frozen: boolean;
  }

  let { state: s, frozen }: Props = $props();

  const nf = new Intl.NumberFormat("ja-JP");
  const n = (v: number): string => nf.format(v);

  function tokens(v: number): string {
    return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
  }

  const df = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
  function day(iso: string | undefined): string {
    return iso === undefined ? "—" : df.format(new Date(iso));
  }

  const SOURCE_LABEL: Record<string, string> = { claude: "Claude", copilot: "Copilot", manual: "手動" };

  /* ---- rail ---------------------------------------------------------- */

  let addPath = $state("");

  async function addFolder(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const value = addPath.trim();
    if (value === "" || s.busy) return;
    if (await s.act("add", value, `フォルダを追加しました: ${value}`)) addPath = "";
  }

  function pinLabel(p: ProjectEntry): string {
    return p.pinned === true ? "固定を外す" : "上に固定";
  }

  function hideLabel(p: ProjectEntry): string {
    return p.hidden === true ? "一覧に戻す" : "一覧から隠す";
  }

  /* ---- table --------------------------------------------------------- */

  const KIND_CHIPS: { value: KindFilter; label: string }[] = [
    { value: "all", label: "すべて" },
    ...KIND_ORDER.map((k) => ({ value: k, label: KIND_LABEL[k] })),
  ];
  const HARNESS_CHIPS: { value: HarnessFilter; label: string }[] = [
    { value: "all", label: "両方" },
    ...HARNESSES.map((h) => ({ value: h.id as HarnessFilter, label: h.label })),
  ];
  const STATE_CHIPS: { value: StateFilter; label: string }[] = [
    { value: "all", label: "すべて" },
    { value: "loaded", label: "常時読まれる" },
    { value: "attention", label: "要確認" },
  ];
  const unitChips = $derived<{ value: UnitFilter; label: string }[]>([
    { value: "all", label: "すべて" },
    ...(s.data?.scopes ?? ["user"]).map((u) => ({ value: u as UnitFilter, label: SCOPE_LABEL[u] })),
  ]);

  function reachOf(row: InstalledRow, h: HarnessId): InstalledReach[] {
    return row.reach.filter((r) => r.harness === h);
  }

  /** One cell per harness: the strongest state, and what it costs when that is counted. */
  const RANK: ReachState[] = ["enabled", "conditional", "via-import", "unknown", "unconfirmed", "disabled", "not-loaded"];
  function headline(rs: InstalledReach[]): InstalledReach | null {
    if (rs.length === 0) return null;
    return [...rs].sort((a, b) => RANK.indexOf(a.state) - RANK.indexOf(b.state))[0] ?? null;
  }

  let tbody = $state<HTMLElement | null>(null);

  function onRowKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...(tbody?.querySelectorAll<HTMLButtonElement>("button.row-btn") ?? [])];
    const i = buttons.indexOf(event.target as HTMLButtonElement);
    if (i === -1) return;
    const next = buttons[event.key === "ArrowDown" ? i + 1 : i - 1];
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
    next.click();
  }

  let detail = $state<HTMLElement | null>(null);

  async function select(row: InstalledRow): Promise<void> {
    s.selectedId = row.id;
    await tick();
    detail?.scrollTo({ top: 0 });
  }

  const harnessTotals = $derived(HARNESSES.map((h) => ({ ...h, sum: s.sessionTotal(h.id) })));
  const unreadableSources = $derived((s.data?.sources ?? []).filter((x) => x.status === "unreadable"));
</script>

<main class="installed" inert={frozen} aria-label="Installed">
  <!-- Rail: the unit -------------------------------------------------- -->
  <nav class="rail" aria-labelledby="rail-title">
    <div class="rail__head">
      <h2 id="rail-title">単位</h2>
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

    <ul class="units" role="list">
      <li>
        <button
          type="button"
          class="unit"
          aria-current={s.scope === USER_SCOPE ? "true" : undefined}
          onclick={() => void s.choose(USER_SCOPE)}
        >
          <span class="unit__name">個人</span>
          <span class="unit__meta">すべてのプロジェクトに効く設定</span>
        </button>
      </li>
    </ul>

    <div class="rail__projects">
      <h3 class="rail__label" id="projects-label">
        プロジェクト
        {#if s.projects !== null}
          <span class="num">{s.visibleProjects.length}</span>
        {/if}
      </h3>
      <label class="search search--rail">
        <Icon name="search" size={14} />
        <span class="sr-only">プロジェクトを絞り込む</span>
        <input type="search" name="project-filter" autocomplete="off" placeholder="名前・パスで絞り込む…" bind:value={s.projectQuery} />
      </label>

      {#if s.projectsStatus === "failed"}
        <p class="rail__fault" role="alert"><Icon name="fault" size={13} />プロジェクトの一覧を読めませんでした: {s.projectsError}</p>
      {:else if s.projects === null}
        <p class="rail__empty">記録を集めています…</p>
      {:else if s.visibleProjects.length === 0}
        <p class="rail__empty">
          {s.projectQuery.trim() === "" ? "Claude と Copilot の記録に、プロジェクトがありません。" : "当てはまるプロジェクトがありません。"}
        </p>
      {:else}
        <ul class="units units--projects" role="list" aria-labelledby="projects-label">
          {#each s.visibleProjects as p (p.id)}
            <li>
              <button
                type="button"
                class="unit"
                class:unit--muted={p.hidden === true || !p.git}
                aria-current={s.scope === p.id ? "true" : undefined}
                onclick={() => void s.choose(p.id)}
              >
                <span class="unit__name">
                  {#if p.pinned === true}<span class="pin" aria-label="固定">固定</span>{/if}{p.name}
                </span>
                <span class="unit__meta">
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
    </div>

    {#if s.projects !== null}
      <div class="rail__foot">
        <label class="check">
          <input type="checkbox" bind:checked={s.showNonGit} />
          git 外のフォルダも出す(<span class="num">{s.projects.counts.nonGit}</span>)
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={s.showHidden} />
          隠したものも出す(<span class="num">{s.projects.counts.hidden}</span>)
        </label>
        <form class="add" onsubmit={addFolder}>
          <label for="add-folder" class="rail__label">フォルダを手で足す</label>
          <div class="add__row">
            <input id="add-folder" name="folder" class="field" type="text" autocomplete="off" translate="no" aria-describedby={s.actionError !== "" && s.failedAction === "add" ? "add-error" : undefined} placeholder="例: D:\work\project" spellcheck="false" bind:value={addPath} />
            <button type="submit" class="btn btn--sm" aria-busy={s.acting === "add"}>追加</button>
          </div>
          {#if s.actionError !== "" && s.failedAction === "add"}
            <p class="rail__fault" id="add-error"><Icon name="fault" size={13} />追加できませんでした: {s.actionError}</p>
          {/if}
        </form>
        <p class="rail__stat">
          記録 <span class="num">{n(s.projects.counts.candidates)}</span> か所 → 一覧 <span class="num">{n(s.projects.counts.listed)}</span> 件。実在しない <span class="num">{s.projects.counts.missing}</span>・除外 <span class="num">{s.projects.counts.excluded}</span>・まとめたワークツリー <span class="num">{s.projects.counts.worktreesMerged}</span>
          <span class="num">({s.projects.elapsedMs} ms)</span>
        </p>
        {#if s.projects.settingsError !== undefined}
          <p class="rail__fault"><Icon name="fault" size={13} />固定・非表示の設定を読めないため反映していません: {s.projects.settingsError}</p>
        {/if}
      </div>
    {/if}
  </nav>

  <!-- Middle: totals + table ------------------------------------------- -->
  <section class="table-panel" aria-labelledby="inst-title">
    <header class="inst-head">
      <div class="inst-head__name">
        <h2 id="inst-title">{s.project?.name ?? "個人"}</h2>
        <p class="path" translate="no">{s.project?.root ?? "~ (ユーザー全体)"}</p>
      </div>
      {#if s.project !== null}
        {@const p = s.project}
        <div class="inst-head__ops">
          <button
            type="button"
            class="btn btn--sm"
            aria-busy={s.acting === "pin" || s.acting === "unpin"}
            onclick={() => {
              if (!s.busy) void s.act(p.pinned === true ? "unpin" : "pin", p.id, p.pinned === true ? `${p.name} の固定を外しました。` : `${p.name} を上に固定しました。`);
            }}>{pinLabel(p)}</button
          >
          <button
            type="button"
            class="btn btn--sm"
            aria-busy={s.acting === "hide" || s.acting === "unhide"}
            onclick={() => {
              if (!s.busy) void s.act(p.hidden === true ? "unhide" : "hide", p.id, p.hidden === true ? `${p.name} を一覧に戻しました。` : `${p.name} を一覧から隠しました。`);
            }}>{hideLabel(p)}</button
          >
        </div>
      {/if}
    </header>

    {#if s.actionError !== "" && s.failedAction !== "add"}
      <p class="inline-fault"><Icon name="fault" size={13} />操作できませんでした: {s.actionError}</p>
    {/if}

    <!-- The answer to "how much does a session here carry": harness × unit, and the sum -->
    <div class="totals">
      <table aria-label="常時コストの見積もり(字数)">
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">ハーネス</span></th>
            {#each s.data?.scopes ?? USER_ONLY as unit (unit)}<th scope="col" class="t-num">{SCOPE_LABEL[unit]}</th>{/each}
            <th scope="col" class="t-num t-sumcol">{s.project === null ? "合計" : "このプロジェクトで開くと"}</th>
          </tr>
        </thead>
        <tbody>
          {#each harnessTotals as h (h.id)}
            <tr>
              <th scope="row">{h.label}</th>
              {#each s.data?.scopes ?? USER_ONLY as unit (unit)}
                {@const t = s.data?.totals.find((x) => x.scope === unit && x.harness === h.id)}
                <td class="t-num">
                  {#if t === undefined}<span class="muted">—</span>{:else}<span class="num">{n(t.chars)}</span>{/if}
                </td>
              {/each}
              <td class="t-num t-sumcol">
                {#if s.data === null}
                  <span class="muted">—</span>
                {:else}
                  <span class="num t-sum">{n(h.sum.chars)}</span> 字
                  <span class="t-tok">約 <span class="num">{tokens(h.sum.tokens)}</span> トークン(推測)</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if s.data !== null}
        <p class="totals__note">
          毎セッション載る字数の見積もり。含めないもの: 条件付き
          {#each harnessTotals as h, i (h.id)}{i > 0 ? "・" : ""}{h.label} <span class="num">{h.sum.conditional}</span>{/each}、未計測(MCP など)
          {#each harnessTotals as h, i (h.id)}{i > 0 ? "・" : ""}{h.label} <span class="num">{h.sum.unmeasured}</span>{/each}、ハーネス自身のシステムプロンプト。
        </p>
      {/if}
    </div>

    <div class="toolbar">
      <label class="search">
        <Icon name="search" size={14} />
        <span class="sr-only">資産を検索</span>
        <input type="search" name="asset-filter" autocomplete="off" placeholder="名前・説明・パスで検索…" bind:value={s.query} />
      </label>
      <div class="filters" role="radiogroup" aria-label="種類">
        {#each KIND_CHIPS as c (c.value)}
          <button type="button" class="chip" role="radio" aria-checked={s.kind === c.value} onclick={() => (s.kind = c.value)}>{c.label}</button>
        {/each}
      </div>
      <div class="filters" role="radiogroup" aria-label="単位">
        {#each unitChips as c (c.value)}
          <button type="button" class="chip" role="radio" aria-checked={s.unit === c.value} onclick={() => (s.unit = c.value)}>{c.label}</button>
        {/each}
      </div>
      <div class="filters" role="radiogroup" aria-label="ハーネス">
        {#each HARNESS_CHIPS as c (c.value)}
          <button type="button" class="chip" role="radio" aria-checked={s.harness === c.value} onclick={() => (s.harness = c.value)}>{c.label}</button>
        {/each}
      </div>
      <div class="filters" role="radiogroup" aria-label="状態">
        {#each STATE_CHIPS as c (c.value)}
          <button type="button" class="chip" role="radio" aria-checked={s.stateFilter === c.value} onclick={() => (s.stateFilter = c.value)}>{c.label}</button>
        {/each}
      </div>
      <p class="count"><span class="num">{s.rows.length}</span> / <span class="num">{s.allRows.length}</span> 件</p>
    </div>

    <div class="scroller">
      {#if s.status === "failed"}
        <div class="table-fault" role="alert">
          <p><Icon name="fault" size={14} />読み取れませんでした: {s.error}</p>
          <button type="button" class="btn btn--sm" onclick={() => void s.load()}>もう一度読む</button>
        </div>
      {:else if s.data === null}
        <p class="table-empty">{s.status === "running" ? "読み取り中です…" : "—"}</p>
      {:else if s.rows.length === 0}
        <p class="table-empty">
          {s.allRows.length === 0 ? "この単位には、Claude と Copilot が読むものがありません。" : "絞り込みに当てはまる行がありません。"}
        </p>
      {:else}
        <table aria-label="読み込まれる資産" aria-busy={s.status === "running"}>
          <thead>
            <tr>
              <th scope="col">名前</th>
              <th scope="col">種類</th>
              <th scope="col">単位</th>
              {#each HARNESSES as h (h.id)}<th scope="col">{h.label}</th>{/each}
            </tr>
          </thead>
          <tbody bind:this={tbody}>
            {#each s.rows as row (row.id)}
              <tr class:is-selected={s.selectedId === row.id}>
                <th scope="row" class="col-name">
                  <button type="button" class="row-btn" aria-current={s.selectedId === row.id ? "true" : undefined} onclick={() => void select(row)} onkeydown={onRowKey}>
                    <span class="row-name" translate="no">{row.name}</span>
                    {#if row.unreadable !== undefined}<span class="flag flag--fault">読めない</span>{/if}
                    {#if (row.findings?.length ?? 0) > 0}<span class="flag">所見 {row.findings?.length}</span>{/if}
                  </button>
                </th>
                <td class="col-meta">{KIND_LABEL[row.kind]}</td>
                <td class="col-meta">{SCOPE_LABEL[row.scope]}</td>
                {#each HARNESSES as h (h.id)}
                  {@const top = headline(reachOf(row, h.id))}
                  <td class="col-reach">
                    {#if top === null}
                      <span class="muted" aria-label="読まない">—</span>
                    {:else}
                      <span class="state state--{top.state}">{STATE_LABEL[top.state]}</span>
                      {#if top.cost !== undefined && (top.state === "enabled" || top.state === "conditional")}
                        <span class="num reach-chars">{n(top.cost.chars)}</span>
                      {/if}
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </section>

  <!-- Right: detail ------------------------------------------------------ -->
  <aside class="detail" aria-labelledby="detail-title" bind:this={detail}>
    {#if s.selected === null}
      <div class="detail__empty">
        <h2 id="detail-title" class="sr-only">詳細</h2>
        <p>行を選ぶと、どのハーネスがどのパスから読み、どの設定で有効・無効が決まり、毎セッションどれだけ載るかを出します。</p>
        {#if s.data !== null}
          <h3 class="rail__label">この画面が読まないもの</h3>
          <ul class="plain">
            {#each s.data.unsupported as u (u.harness)}
              <li><code>{u.harness}</code> — {u.reason}</li>
            {/each}
          </ul>
          <h3 class="rail__label">注記</h3>
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
        {#if row.description !== undefined}<p class="detail__desc">{row.description}</p>{/if}
      </header>

      {#if row.unreadable !== undefined}
        <p class="inline-fault"><Icon name="fault" size={13} />読めませんでした: {row.unreadable}</p>
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
        <dt>版</dt>
        <dd class="num">{row.version ?? "—"}</dd>
        {#if row.transport !== undefined}
          <dt>通信方式</dt>
          <dd class="num">{row.transport}</dd>
        {/if}
      </dl>

      <section class="reaches" aria-labelledby="reach-title">
        <h3 id="reach-title" class="rail__label">届き方</h3>
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
                    <span class="muted">未計測</span>
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
              {#if r.note !== undefined}<p class="reach__note">{r.note}</p>{/if}
            </li>
          {/each}
        </ul>
      </section>

      {#if row.imports !== undefined && row.imports.length > 0}
        <section aria-labelledby="imports-title">
          <h3 id="imports-title" class="rail__label">@import で取り込むファイル(常時コストに含む)</h3>
          <ul class="plain plain--paths">
            {#each row.imports as imp (imp.path)}
              <li><span class="path" translate="no">{imp.path}</span> <span class="num">{n(imp.chars)}</span> 字</li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if row.components !== undefined}
        <section aria-labelledby="comp-title">
          <h3 id="comp-title" class="rail__label">部品</h3>
          <dl class="facts facts--plain">
            {#each [["skill", row.components.skills], ["command", row.components.commands], ["agent", row.components.agents], ["MCP", row.components.mcpServers]] as [label, list] (label)}
              <dt>{label}</dt>
              <dd>{(list as string[]).length === 0 ? "—" : (list as string[]).join("、")}</dd>
            {/each}
          </dl>
        </section>
      {/if}

      {#if (row.findings?.length ?? 0) > 0}
        <section aria-labelledby="find-title">
          <h3 id="find-title" class="rail__label">所見</h3>
          <ul class="plain">
            {#each row.findings ?? [] as f (f.code)}
              <li class:fault-text={f.level === "error"}><code>{f.code}</code> {f.detail}</li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if needsAttention(row) && row.reach.some((r) => r.certainty === "unconfirmed")}
        <p class="reach__note">確度が「未確認」の届き方は、合計に含めず、今後の操作の対象にもしません。</p>
      {/if}
    {/if}
  </aside>
</main>

<style>
  .installed {
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: minmax(14rem, 17rem) minmax(0, 1.6fr) minmax(19rem, 1fr);
    gap: var(--gap-3);
    min-height: 0;
  }

  /* Narrower desktop windows keep the three panes and give up width, not panes. */
  @media (max-width: 75rem) {
    .installed {
      grid-template-columns: minmax(12rem, 13rem) minmax(0, 1fr) minmax(16rem, 17rem);
    }
  }

  @media (max-width: 62rem) {
    .installed {
      grid-template-columns: minmax(0, 1fr);
    }
    .rail {
      max-height: 24rem;
    }
  }

  /* Rail ------------------------------------------------------------- */

  /*
   * The project list takes what is left; when the window is too short even for
   * that, the rail as a whole scrolls rather than letting its foot slide over
   * the list.
   */
  .rail {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: auto;
    background: var(--paper);
    border: 1px solid var(--rule-strong);
  }

  .rail__head {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-2);
    padding: var(--gap-2) var(--gap-3);
    border-bottom: 1px solid var(--rule);
    background: var(--paper-panel);
  }

  .rail__head h2 {
    font-size: var(--t-md);
    letter-spacing: 0.04em;
  }

  .rail__projects {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 12rem;
    border-top: 1px solid var(--rule-strong);
  }

  .rail__label {
    display: flex;
    gap: var(--gap-2);
    align-items: baseline;
    margin: var(--gap-3) var(--gap-3) var(--gap-2);
    font-size: var(--t-micro);
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-2);
  }

  .units {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .units--projects {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    border-top: 1px solid var(--rule);
  }

  .unit {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    width: 100%;
    padding: var(--gap-2) var(--gap-3);
    border: 0;
    border-bottom: 1px solid var(--rule);
    background: transparent;
    color: var(--ink);
    text-align: left;
    font: inherit;
    cursor: pointer;
  }

  .unit:hover:not([aria-current="true"]) {
    background: var(--paper-panel);
  }

  .unit[aria-current="true"] {
    background: var(--caution-wash);
    box-shadow: inset 2px 0 0 var(--ink);
  }

  .unit:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -2px;
  }

  .unit__name {
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .unit--muted .unit__name {
    color: var(--ink-2);
  }

  .unit__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--gap-2);
    font-size: var(--t-small);
    color: var(--ink-2);
  }

  .pin {
    margin-right: var(--gap-2);
    padding: 0 var(--gap-1);
    border: 1px solid var(--rule-strong);
    font-size: var(--t-micro);
    font-weight: 400;
    color: var(--ink-2);
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

  .search--rail {
    flex: none;
    margin: 0 var(--gap-3) var(--gap-2);
  }

  .search:focus-within {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }

  .search input,
  .field {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 2rem;
    border: 0;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: var(--t-body);
  }

  .search input:focus {
    outline: none;
  }

  .field {
    padding: 0 var(--gap-2);
    border: 1px solid var(--rule-strong);
    background: var(--paper);
    font-family: var(--mono);
    font-size: var(--t-small);
  }

  .field:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }

  input::placeholder {
    color: var(--ink-2);
    opacity: 1;
  }

  .rail__empty,
  .rail__stat {
    margin: var(--gap-2) var(--gap-3);
    font-size: var(--t-small);
    color: var(--ink-2);
  }

  .rail__fault,
  .inline-fault {
    display: flex;
    gap: var(--gap-2);
    align-items: baseline;
    margin: var(--gap-2) var(--gap-3);
    padding: var(--gap-2);
    border: 1px solid var(--fault);
    background-color: var(--paper);
    background-image: linear-gradient(var(--fault-wash), var(--fault-wash));
    color: var(--fault-text);
    font-size: var(--t-small);
    overflow-wrap: anywhere;
  }

  .rail__foot {
    flex: none;
    border-top: 1px solid var(--rule-strong);
    padding-bottom: var(--gap-2);
    background: var(--paper-panel);
  }

  .check {
    display: flex;
    gap: var(--gap-2);
    align-items: center;
    margin: var(--gap-2) var(--gap-3) 0;
    font-size: var(--t-small);
  }

  .check input {
    accent-color: var(--ink);
  }

  .add .rail__label {
    margin-top: var(--gap-3);
  }

  .add__row {
    display: flex;
    gap: var(--gap-2);
    margin: 0 var(--gap-3);
  }

  /* Middle ------------------------------------------------------------ */

  .table-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--paper);
    border: 1px solid var(--rule-strong);
  }

  .inst-head {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-2) var(--gap-4);
    padding: var(--gap-2) var(--gap-3);
    border-bottom: 1px solid var(--rule);
  }

  .inst-head h2 {
    font-size: var(--t-lg);
  }

  .inst-head .path {
    font-size: var(--t-micro);
    overflow-wrap: anywhere;
  }

  .inst-head__ops {
    display: flex;
    gap: var(--gap-2);
  }

  .totals {
    flex: none;
    overflow-x: auto;
    padding: var(--gap-2) var(--gap-3);
    border-bottom: 1px solid var(--rule-strong);
  }

  .totals table {
    border-collapse: collapse;
    font-size: var(--t-body);
  }

  .totals th,
  .totals td {
    padding: 0.15rem var(--gap-4) 0.15rem 0;
    text-align: left;
    font-weight: 400;
    vertical-align: baseline;
  }

  .totals thead th {
    font-size: var(--t-micro);
    letter-spacing: 0.08em;
    color: var(--ink-2);
    border-bottom: 1px solid var(--rule-strong);
  }

  .totals tbody th {
    font-weight: 500;
    min-width: 4.5rem;
  }

  .totals tbody tr + tr > * {
    border-top: 1px solid var(--rule);
  }

  .t-num {
    white-space: nowrap;
  }

  /* The sum is the answer; the per-unit cells are its working. */
  .t-sumcol {
    padding-left: var(--gap-4) !important;
    border-left: 1px solid var(--rule-strong);
  }

  .t-sum {
    font-size: var(--t-md);
    font-weight: 700;
  }

  .t-tok {
    margin-left: var(--gap-2);
    font-size: var(--t-small);
    color: var(--ink-2);
  }

  .totals__note {
    max-width: 80ch;
    margin-top: var(--gap-1);
    font-size: var(--t-small);
    color: var(--ink-2);
  }

  .toolbar {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-2) var(--gap-3);
    padding: var(--gap-2) var(--gap-3);
    border-bottom: 1px solid var(--rule);
    background: var(--paper-panel);
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    border: 1px solid var(--rule-strong);
  }

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

  .chip:hover:not([aria-checked="true"]) {
    background: var(--paper-panel);
  }

  .chip[aria-checked="true"] {
    background: var(--ink);
    color: var(--paper);
  }

  .chip:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -2px;
  }

  .count {
    flex: none;
    margin-left: auto;
    font-size: var(--t-small);
    color: var(--ink-2);
  }

  .scroller {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  /*
   * A floor under the table: below it the scroller pans sideways instead of
   * breaking every name into one or two characters per line.
   */
  .scroller table {
    width: 100%;
    min-width: 40rem;
    border-collapse: collapse;
    font-size: var(--t-body);
  }

  .scroller thead th {
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

  .scroller tbody th,
  .scroller tbody td {
    padding: var(--gap-1) var(--gap-3);
    border-bottom: 1px solid var(--rule);
    text-align: left;
    font-weight: 400;
    vertical-align: middle;
  }

  .scroller tbody tr:hover {
    background: var(--paper-panel);
  }

  .scroller tbody tr.is-selected {
    background: var(--caution-wash);
    box-shadow: inset 2px 0 0 var(--ink);
  }

  .col-name {
    padding: 0 !important;
  }

  .row-btn {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-2);
    width: 100%;
    min-height: 2.25rem;
    padding: var(--gap-1) var(--gap-3);
    border: 0;
    background: transparent;
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row-btn:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -2px;
  }

  .row-name {
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .col-name {
    min-width: 11rem;
  }

  .col-meta {
    color: var(--ink-2);
    font-size: var(--t-small);
    white-space: nowrap;
  }

  .col-reach {
    white-space: nowrap;
  }

  .reach-chars {
    margin-left: var(--gap-2);
    color: var(--ink-2);
    font-size: var(--t-small);
  }

  .flag {
    padding: 0 var(--gap-1);
    border: 1px solid currentColor;
    font-size: var(--t-micro);
    color: var(--ink-2);
  }

  .flag--fault {
    color: var(--fault-text);
  }

  /*
   * The state word. Green only for "loaded every session" and red only for a
   * read that failed (DESIGN.md: 赤は障害専用ルール — 無効 is a choice, not a
   * fault). Dashed means "not established": unknown and unconfirmed.
   */
  .state {
    display: inline-block;
    padding: 0 var(--gap-1);
    border: 1px solid var(--rule-strong);
    font-size: var(--t-small);
    line-height: 1.5;
  }

  .state--enabled {
    border-color: var(--pass);
    background-color: var(--paper);
    background-image: linear-gradient(var(--pass-wash), var(--pass-wash));
    color: var(--pass-text);
  }

  .state--conditional,
  .state--via-import {
    color: var(--ink);
  }

  .state--disabled,
  .state--not-loaded {
    border-color: var(--rule);
    color: var(--ink-2);
  }

  .state--unknown,
  .state--unconfirmed {
    border-style: dashed;
    color: var(--ink-2);
  }

  .muted {
    color: var(--ink-2);
  }

  .table-empty,
  .table-fault {
    margin: var(--gap-4);
    font-size: var(--t-body);
    color: var(--ink-2);
  }

  .table-fault p {
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
    background: var(--paper);
    border: 1px solid var(--rule-strong);
  }

  .detail__empty > p {
    max-width: 60ch;
    color: var(--ink-2);
  }

  .detail__head h2 {
    font-size: var(--t-lg);
    overflow-wrap: anywhere;
  }

  .detail__desc {
    margin-top: var(--gap-1);
    color: var(--ink-2);
  }

  .facts {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--gap-1) var(--gap-3);
    margin: var(--gap-3) 0;
    padding: var(--gap-2) var(--gap-3);
    background: var(--paper-inset);
    font-size: var(--t-small);
  }

  .facts--plain {
    background: transparent;
    padding: 0;
    margin-top: 0;
  }

  .facts dt,
  .reach__facts dt {
    font-size: var(--t-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-2);
    padding-top: 0.1rem;
  }

  .facts dd,
  .reach__facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .reach-list {
    margin: 0;
    padding: 0;
    list-style: none;
    border-top: 1px solid var(--rule);
  }

  .reach {
    padding: var(--gap-2) 0 var(--gap-3);
    border-bottom: 1px solid var(--rule);
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
    color: var(--ink-2);
  }

  .certainty--weak {
    padding: 0 var(--gap-1);
    border: 1px dashed var(--rule-strong);
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
    color: var(--ink-2);
  }

  .reach__note {
    margin-top: var(--gap-2);
    font-size: var(--t-small);
    color: var(--ink-2);
    max-width: 64ch;
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
    color: var(--ink-2);
  }

  .sources summary:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 2px;
  }

  .sources .plain--paths {
    max-height: 18rem;
    overflow: auto;
    margin-top: var(--gap-2);
    padding: var(--gap-2);
    background: var(--paper-inset);
  }

  .sources .plain--paths:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }

  .src-status {
    display: inline-block;
    min-width: 4em;
    color: var(--ink-2);
  }

  .fault-text {
    color: var(--fault-text);
  }

  code {
    font-family: var(--mono);
    font-size: 0.95em;
    padding: 0 0.2em;
    background: var(--paper-inset);
  }

  @media (forced-colors: active) {
    .unit[aria-current="true"],
    .scroller tbody tr.is-selected {
      forced-color-adjust: none;
      box-shadow: inset 4px 0 0 Highlight;
    }

    .chip[aria-checked="true"] {
      forced-color-adjust: none;
      background: Highlight;
      color: HighlightText;
    }
  }
</style>
