<script lang="ts">
  /* ==================================================================
   * DIRECTION CONTRACT — 管理コンソール(定石)
   *
   * THESIS
   *   道具として使う画面。種別タブで資産を切り替え、テーブルで一覧し、
   *   右ペインで「どのエージェントに、どの状態で届いているか」を追い、
   *   下のステータスバーで健康状態と適用を握る。読むだけなら無害、
   *   書くときは儀式。
   *
   * WORLD — standing exit(カテゴリ標準)
   *   VS Code の設定/拡張機能ビュー(左リスト+右詳細、検索・フィルタ・
   *   バッジの語彙)と GitHub Desktop 系(差分プレビューと危険な書き込みの
   *   確認)が越えるべきバー。皮肉も、こっそり混ぜた奇抜さも入れない。
   *   旧「整備マニュアルの配線図」の画面は既定画面から降格し、
   *   マップビューのトグルとしてのみ存続する。検印
   *   スタンプは廃止し、doctor 所見は 不良X件/注意Y件 の数値表示に置換した。
   *
   * STORY
   *   開く → 走査が自動で走り、テーブルが埋まり、下のバーに 不良/注意 が出る
   *   → タブと検索で目的の資産に到達 → 右ペインで適用先の状態を確認
   *   → 「差分を取る」で状態が確定 → 明示確認(対象と内容の差分を列挙)
   *   → 適用 → 再走査され、退避先が記録に残る。
   *
   * FIRST VIEWPORT
   *   タブ / テーブル / 右ペイン / ステータスバーが同時に見えること。
   *   スクロールするのはテーブルと右ペインの中身だけ。
   *
   * FINISH
   *   派手な見せ場は置かない。状態遷移は 160–200ms。適用完了は文言と
   *   ステータスバーの数値で伝える。
   * ================================================================== */

  import "./app.css";

  import { onMount, tick } from "svelte";

  import AssetTable from "./lib/AssetTable.svelte";
  import ConfirmApply from "./lib/ConfirmApply.svelte";
  import ConfirmRemove from "./lib/ConfirmRemove.svelte";
  import DetailPane from "./lib/DetailPane.svelte";
  import Diagram from "./lib/Diagram.svelte";
  import FaultPlate from "./lib/FaultPlate.svelte";
  import InstalledView from "./lib/InstalledView.svelte";
  import Icon from "./lib/Icon.svelte";
  import StatusBar from "./lib/StatusBar.svelte";
  import StatusDrawer from "./lib/StatusDrawer.svelte";
  import { ASSET_TABS, type AssetRow } from "./lib/assets.js";
  import { stepRemovalFocus } from "./lib/modalfocus.js";
  import { omittedTargetsNote } from "./lib/schematic.js";
  import { Session } from "./lib/session.svelte.js";
  import { InstalledState, installedAnnouncement } from "./lib/installed.svelte.js";
  import { hasServer, KEYLESS_MESSAGE, servedByServer, shutdownServer } from "./lib/engine.js";

  const session = new Session();

  /*
   * Two views (ARCHITECTURE.md「単位とプロジェクト」): Installed — what each
   * harness loads, by unit — is the default; 配布 is the inherited
   * source-of-truth console. The survey still runs at mount for both, since
   * the status bar and the 配布 tables need it.
   */
  type View = "installed" | "distribute";
  const VIEWS: { id: View; label: string }[] = [
    { id: "installed", label: "Installed" },
    { id: "distribute", label: "配布" },
  ];
  let view = $state<View>("installed");
  const inst = new InstalledState();

  /*
   * A page the server served, in a tab that holds no key (the address was typed,
   * or the tab outlived the server it was opened from). Nothing it does can
   * succeed, so it says so once and does not try: no survey, no fault plate
   * about an engine that never ran, no 終了 button whose refusal would only
   * repeat the same thing.
   */
  const keylessAtLoad = !hasServer() && servedByServer();
  // A key from an earlier server is found out only when the server answers 401.
  const keyless = $derived(keylessAtLoad || session.fault?.keyless === true);

  /*
   * 終了 (ARCHITECTURE.md「起動と終了」). The server outlives the tab, so the tab
   * is where it is stopped. No confirmation: it writes nothing, the server
   * refuses while a write is running, and agent-console.bat brings it back.
   * Once stopped, every control would fail against a dead server, so the
   * console goes inert rather than offering buttons that cannot work.
   */
  let serverState = $state<"running" | "stopping" | "stopped">("running");
  let stopError = $state("");
  let stoppedStrip = $state<HTMLElement | null>(null);
  const frozen = $derived(serverState === "stopped" || keyless);

  onMount(() => {
    if (!keylessAtLoad) {
      void session.survey();
      void inst.start();
    }
  });

  const sessionBusy = $derived(
    session.surveyStatus === "running" ||
      session.diffStatus === "running" ||
      session.writeStatus === "running" ||
      session.assetBusy,
  );
  const busy = $derived(sessionBusy || serverState === "stopping");

  // A failed 終了 is news only until the next thing happens.
  $effect(() => {
    if (sessionBusy) stopError = "";
  });

  const STOPPED_TEXT =
    "サーバーを終了しました。再び使うときは agent-console.bat を実行してください。このタブは閉じて構いません。";
  const KEYLESS_TEXT = KEYLESS_MESSAGE;

  async function stopServer(): Promise<void> {
    if (serverState !== "running" || sessionBusy) return;
    serverState = "stopping";
    stopError = "";
    try {
      await shutdownServer();
      serverState = "stopped";
      document.title = `(終了) ${document.title}`;
      // The pressed button is now inside the inert region; put focus on the
      // notice that says what happened and how to come back.
      await tick();
      stoppedStrip?.focus();
    } catch (err) {
      stopError = err instanceof Error ? err.message : String(err);
      serverState = "running";
    }
  }

  const sourceRoot = $derived(session.inventory?.source.root ?? "~/.agents-manager");
  const hasPlan = $derived(session.plan !== null);
  const changeCount = $derived(session.executable.length);

  /**
   * One live region, present from mount, whose *text changes* are what get
   * announced.
   *
   * Every outcome speaks, not only the alarming ones. The previous version
   * announced drift and a completed write and nothing else, so a screen-reader
   * user pressing 差分を取る on a healthy plan got silence — the table
   * repopulated and there was no way to know the plan was ready, or that there
   * was no difference. Progress and completion for all four operations are
   * derived here rather than being conditionally-inserted `role="status"`
   * elements next to the buttons: an element inserted with its text already
   * inside is not reliably announced, and one rendered behind an open modal's
   * inert background is not announced at all.
   */
  const announcement = $derived.by(() => {
    // Focus moves to the notice, which reads it; saying it here too would read it twice.
    if (serverState === "stopped") return "";
    if (keyless) return KEYLESS_TEXT;
    if (serverState === "stopping") return "サーバーを終了しています。";
    if (view === "installed") {
      const said = installedAnnouncement(inst);
      if (said !== null) return said;
    }
    // 「再走査」 on the very first read was a claim about a previous one that
    // never happened. `surveyedAt` is null until a survey succeeds, which is
    // exactly the distinction.
    if (session.surveyStatus === "running") {
      return session.surveyedAt === null ? "走査中です。" : "再走査中です。";
    }
    if (session.writeStatus === "running") return "適用中です。";
    if (session.diffStatus === "running") return "差分を取得中です。";
    if (session.assetBusy) return "資産の設定を変更中です。";
    if (stopError !== "") return `終了できませんでした: ${stopError}`;
    if (session.writeStatus === "done") {
      if (session.notApplied.length > 0) {
        return `適用は完了しましたが、確認画面に出した操作のうち ${session.notApplied.length} 件は実行されませんでした。PLAN の記録を確認してください。`;
      }
      return session.unconfirmed.length > 0
        ? `適用が完了しました。ただし確認画面に無かった変更が ${session.unconfirmed.length} 件含まれています。PLAN の記録を確認してください。`
        : "適用が完了しました。退避先は PLAN の記録に記載しています。";
    }
    if (session.hasDrift) {
      return "drift が未解決のため apply は実行できません。PLAN の該当行を確認してください。";
    }
    if (session.lastAssetResult !== "") return session.lastAssetResult;
    if (session.diffStatus === "ready") {
      return changeCount === 0
        ? "差分はありません。実環境はソースと一致しています。"
        : `差分を取得しました。適用対象は ${changeCount} 件です。`;
    }
    if (session.surveyStatus === "ready") {
      return `走査が完了しました。不良 ${session.errorCount} 件、注意 ${session.warnCount} 件です。`;
    }
    return "";
  });

  /**
   * Put focus somewhere real when a modal closes.
   *
   * The browser restores focus to the element that opened the dialog, and after
   * a successful write that element is gone or disabled — 適用… is disabled
   * because there is no longer a difference, and the row's delete button belongs
   * to a row that has just been removed. Restoration then fails silently and
   * focus lands on `<body>`, so a keyboard user who has just been told to check
   * the record has to Tab through the whole window to reach it. Sending focus to
   * the PLAN cell instead puts them one keystroke from exactly that record.
   */
  /*
   * `apply` is detectable straight from `writeStatus`, which moves
   * running → done and never back through an intermediate value. A removal is
   * not: `confirmRemove` clears `pendingRemoval` before it awaits the re-survey,
   * so a test of `assetBusy && pendingRemoval !== null` went false mid-operation
   * and the flush that saw the write finish no longer knew a removal had been
   * running — the refocus below never fired on the path it was written for. The
   * transition lives in `modalfocus.ts`, where the flush sequence can be
   * replayed in a test.
   */
  let lastWriteStatus = $state<string>("idle");
  let lastRemovalPending = $state(false);

  $effect(() => {
    const finishedWrite = session.writeStatus === "done" && lastWriteStatus === "running";
    const removal = stepRemovalFocus(
      lastRemovalPending,
      session.assetBusy,
      session.pendingRemoval !== null,
    );
    lastWriteStatus = session.writeStatus;
    lastRemovalPending = removal.inFlight;
    if (finishedWrite || removal.finished) {
      document.getElementById("statusbar-plan")?.focus();
    }
  });

  /**
   * Close the drawer, and give the keyboard somewhere to land.
   *
   * The drawer takes focus when it opens (StatusDrawer), so closing it would
   * otherwise drop focus on `<body>` — the same fall this window spent a round
   * of fixes eliminating. It goes back to the cell that opened it.
   *
   * `inside` is the condition, not an optimisation: Escape closes the drawer
   * from anywhere on the page (StatusDrawer's window listener, which is right —
   * Escape dismisses the frontmost thing), including from the search box when it
   * is empty and has nothing of its own to clear. Focus is only ours to move
   * when it was ours to begin with.
   */
  async function closeDrawer(): Promise<void> {
    const which = session.drawer;
    if (which === null) return;
    const panel = document.getElementById("statusbar-drawer");
    const inside = panel !== null && panel.contains(document.activeElement);
    session.drawer = null;
    if (!inside) return;
    await tick();
    document.getElementById(`statusbar-${which}`)?.focus();
  }

  function onToggle(row: AssetRow): void {
    void session.setEnabled(row.type, row.name, !row.enabled);
  }

  function onRemove(row: AssetRow): void {
    session.requestRemove(row.type, row.name);
  }

  function clock(at: Date | null): string {
    if (at === null) return "--:--:--";
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  }
</script>

<div class="app" class:app--frozen={frozen}>
  <header class="topbar">
    <div class="topbar__name">
      <h1>agent-console</h1>
      <p class="path">{sourceRoot}</p>
    </div>

    <nav class="tabs" aria-label="画面" inert={frozen}>
      {#each VIEWS as v (v.id)}
        <button
          type="button"
          class="tab"
          aria-current={view === v.id ? "page" : undefined}
          onclick={() => {
            view = v.id;
          }}
        >
          {v.label}
        </button>
      {/each}
    </nav>

    {#if view === "distribute"}
    <nav class="tabs" aria-label="資産の種別" inert={frozen}>
      {#each ASSET_TABS as tab (tab.type)}
        <button
          type="button"
          class="tab"
          aria-current={session.tab === tab.type ? "page" : undefined}
          onclick={() => session.setTab(tab.type)}
        >
          {tab.label}
        </button>
      {/each}
    </nav>
    {/if}

    <div class="topbar__ops" inert={frozen}>
      {#if view === "distribute"}
      <p class="scanned">
        <span class="annotation">走査</span>
        <span class="num">{clock(session.surveyedAt)}</span>
      </p>
      <!--
        Busy, not disabled (app.css: 「A control that is working rather than
        unavailable」). Pressing 再走査 was what made `busy` true, so `disabled`
        removed the pressed element from the tab order and put focus on `<body>`
        — a keyboard user got one scan and then a walk back through the window.
      -->
      <button
        type="button"
        class="btn btn--sm"
        onclick={() => {
          if (!busy) void session.survey();
        }}
        aria-busy={busy}
      >
        <Icon name="survey" size={14} />再走査
      </button>
      <button
        type="button"
        class="btn btn--sm"
        aria-pressed={session.mapView}
        onclick={() => {
          session.mapView = !session.mapView;
        }}
      >
        <Icon name="map" size={14} />マップ
      </button>
      {/if}
      {#if session.mode === "server" && !keyless}
        <button
          type="button"
          class="btn btn--sm"
          aria-busy={serverState === "stopping"}
          onclick={() => {
            if (!busy) void stopServer();
          }}
        >
          <Icon name="power" size={14} />{serverState === "stopping" ? "終了中…" : "終了"}
        </button>
      {/if}
    </div>
  </header>

  <!--
    The one live region, present from mount. The strips below carry the same
    words visually and are hidden from assistive technology, so nothing is read
    twice.
  -->
  <p class="sr-only" role="status">{announcement}</p>

  {#if serverState === "stopped"}
    <!-- Focus lands here after 終了 (the button that was pressed is now inert). -->
    <p class="strip strip--fixture" tabindex="-1" bind:this={stoppedStrip}>
      <span class="tag">終了</span>
      {STOPPED_TEXT}
    </p>
  {:else if keyless}
    <p class="strip strip--fault" aria-hidden="true">
      <Icon name="fault" size={13} />{KEYLESS_TEXT}
    </p>
  {:else if stopError !== ""}
    <p class="strip strip--fault" aria-hidden="true">
      <Icon name="fault" size={13} />終了できませんでした: {stopError}
    </p>
  {/if}

  {#if session.mode === "fixture"}
    <p class="strip strip--fixture">
      <span class="tag">参考データ</span>
      agent-console のサーバーから開かれていないため、実環境ではなくフィクスチャを表示しています — {session.modeLabel}
    </p>
  {/if}

  {#if session.hasDrift}
    <p class="strip strip--fault" aria-hidden="true">
      drift が未解決のため <code>apply</code> は実行できません。PLAN の該当行を確認してください。
    </p>
  {:else if session.writeStatus === "done"}
    {#if session.notApplied.length > 0}
      <!--
        The dialog's other promise: everything it listed gets done. If the
        report says otherwise, the interface over-promised, and saying so is the
        only honest option — the alternative is a green strip over a write that
        did less than it said.
      -->
      <p class="strip strip--fault" aria-hidden="true">
        <Icon name="fault" size={13} />確認画面に出した操作のうち
        {session.notApplied.length} 件は実行されませんでした。PLAN の記録で内容を確認してください。
      </p>
    {:else if session.unconfirmed.length > 0}
      <!--
        The dialog promises "exactly this list". `am apply` recomputes its work
        from the live filesystem, so a change made between 差分を取る and 適用
        can legally end up in the write. The engine is right to act on the
        machine as it is; what would be wrong is calling that a clean success.
      -->
      <p class="strip strip--fault" aria-hidden="true">
        <Icon name="fault" size={13} />適用は完了しましたが、確認画面に無かった変更が
        {session.unconfirmed.length} 件含まれています。PLAN の記録で内容を確認してください。
      </p>
    {:else}
      <p class="strip strip--done" aria-hidden="true">
        <Icon name="check" size={13} />適用が完了しました。退避先は PLAN の記録に記載しています。
      </p>
    {/if}
  {/if}

  <!--
    After 終了 a plate stays visible — a failed write and its backup directory
    must not vanish with the server — but it can no longer be operated.
  -->
  <div class="contents" inert={serverState === "stopped"}>
  {#if session.fault !== null && !keyless}
    <FaultPlate
      error={session.fault}
      busy={busy}
      onRetry={() => void session.survey()}
      onDismiss={session.surveyStatus === "ready" ? () => session.clearPlan() : null}
    />
  {/if}

  <!--
    The second plate, when the first one is about something else.
    `fault` picks by *kind* — `writeError ?? diffError ?? surveyError` — not by
    recency, because a partial write is the most serious thing this window can
    be showing and has to stay up until it is dealt with. That is right, and it
    means a failed read can be standing behind it with nothing on screen: the
    table says 「読み取れませんでした … 上の障害の内容を確認して」 while the plate
    above describes the write, and 閉じる is not offered while the survey is
    failed. `survey()` can drop a `diffError` (it has just discarded the plan
    that error was about); it cannot drop this one. So both are drawn.
  -->
  {#if !keyless && session.surveyStatus === "failed" && session.surveyError !== null && session.surveyError !== session.fault}
    <FaultPlate
      error={session.surveyError}
      busy={busy}
      onRetry={() => void session.survey()}
      onDismiss={null}
    />
  {/if}
  </div>

  {#if view === "installed"}
    <InstalledView state={inst} {frozen} />
  {:else}
  <main class="workspace" inert={frozen}>
    {#if session.mapView}
      <!--
        The demoted wiring view, kept as an overview toggle. It is never the
        default: its aggregate outlets made individual MCP servers and agents
        unreachable (DESIGN.md「マップビュー」), which is what the table fixes.
      -->
      <div class="mapview sheet">
        {#if session.schematic !== null && session.schematic.omittedTargets.length > 0}
          <!--
            The map's scope, stated on the map. Its proportion was approved at
            four blocks (schematic.ts `geometry`) and SPEC §10 added a fifth
            target, so the drawing is genuinely partial — and a partial overview
            that does not say so is the same failure as a 「一致」 badge with no
            plan behind it. Dashed, because it is a 但し書き, not a fault.
          -->
          <p class="strip strip--fixture" aria-hidden="true">
            <span class="tag">図の範囲</span>
            {omittedTargetsNote(session.schematic.omittedTargets)}
          </p>
        {/if}
        <Diagram
          schematic={session.schematic}
          status={session.surveyStatus}
          justReconnected={session.justReconnected}
        />
      </div>
    {:else}
      <AssetTable
        rows={session.rows}
        total={session.allRows.length}
        totalIgnoringTarget={session.rowsIgnoringTarget.length}
        type={session.tab}
        query={session.query}
        filter={session.filter}
        targetFilter={session.targetFilter}
        selected={session.selection[session.tab]}
        {busy}
        surveyStatus={session.surveyStatus}
        diffStatus={session.diffStatus}
        {hasPlan}
        onDiff={() => void session.diff()}
        onQuery={(value) => {
          session.query = value;
        }}
        onFilter={(value) => {
          session.filter = value;
        }}
        onTargetFilter={(value) => {
          session.targetFilter = value;
        }}
        onSelect={(name) => session.select(name)}
        {onToggle}
        {onRemove}
      />
      <DetailPane
        row={session.selected}
        {hasPlan}
        diffStatus={session.diffStatus}
        {busy}
        {sourceRoot}
        onDiff={() => void session.diff()}
        onApply={() => session.requestApply()}
        canApply={session.hasChanges && !session.hasDrift}
        {onToggle}
        {onRemove}
      />
    {/if}
  </main>
  {/if}

  {#if view === "distribute" && session.drawer !== null && !frozen}
    <StatusDrawer
      which={session.drawer}
      doctor={session.findings}
      plan={session.plan}
      applied={session.applied}
      unconfirmed={session.unconfirmed}
      onClose={() => void closeDrawer()}
    />
  {/if}

  {#if view === "distribute"}
  <div class="contents" inert={frozen}>
  <StatusBar
    errorCount={session.errorCount}
    warnCount={session.warnCount}
    {hasPlan}
    {changeCount}
    noteCount={session.notes.length}
    hasDrift={session.hasDrift}
    surveyStatus={session.surveyStatus}
    diffStatus={session.diffStatus}
    drawer={session.drawer}
    {busy}
    canApply={session.hasChanges && !session.hasDrift}
    onDrawer={(which) => {
      // The same cell pressed twice closes; route that through `closeDrawer`
      // too, so there is one place that decides where focus goes.
      if (which === null) void closeDrawer();
      else session.drawer = which;
    }}
    onDiff={() => void session.diff()}
    onApply={() => session.requestApply()}
  />
  </div>
  {/if}
</div>

<ConfirmApply
  open={session.writeStatus === "confirming" || session.writeStatus === "running"}
  actions={session.executable}
  {sourceRoot}
  busy={session.writeStatus === "running"}
  narrowings={session.listNarrowings}
  targetFilter={session.targetFilter}
  hiddenFromFilter={session.hiddenFromFilter}
  onCancel={() => session.cancelApply()}
  onConfirm={() => void session.commit()}
/>

<ConfirmRemove
  pending={session.pendingRemoval}
  {sourceRoot}
  busy={session.assetBusy}
  onCancel={() => session.cancelRemove()}
  onConfirm={() => void session.confirmRemove()}
/>

<style>
  /*
   * A window, not a page: header and status bar are pinned, the workspace takes
   * what is left, and only the table body and the detail pane scroll. Below the
   * reflow width the two panes stack and the window scrolls instead.
   */
  .app {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
    height: 100dvh;
    overflow: hidden;
    padding: var(--gap-3) var(--gap-4) var(--gap-4);
  }

  @media (max-width: 62rem), (max-height: 40rem) {
    .app {
      height: auto;
      min-height: 100dvh;
      overflow: visible;
    }
  }

  /* Top bar ----------------------------------------------------------- */

  .topbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    flex-wrap: wrap;
    padding: var(--gap-2) var(--gap-3);
    background: var(--paper);
    border: 1px solid var(--rule-strong);
  }

  h1 {
    font-size: var(--t-md);
    letter-spacing: 0.02em;
  }

  .topbar__name .path {
    font-size: var(--t-micro);
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    border: 1px solid var(--rule-strong);
  }

  .tab {
    min-height: 2rem;
    padding: 0 var(--gap-4);
    border: 0;
    border-right: 1px solid var(--rule);
    background: var(--paper);
    font-size: var(--t-small);
    letter-spacing: 0.08em;
    cursor: pointer;
  }

  .tab:last-child {
    border-right: 0;
  }

  .tab:hover:not([aria-current="page"]) {
    background: var(--paper-panel);
  }

  .tab[aria-current="page"] {
    background: var(--ink);
    color: var(--paper);
  }

  .tab:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -2px;
  }

  /* A wrapper that only carries `inert`; it must not become a layout box. */
  .contents {
    display: contents;
  }

  .topbar__ops {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-2);
    margin-left: auto;
  }

  .scanned {
    display: flex;
    align-items: baseline;
    gap: var(--gap-2);
    font-size: var(--t-small);
    color: var(--ink-2);
    white-space: nowrap;
  }

  /* Strips ------------------------------------------------------------ */

  .strip {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    padding: var(--gap-2) var(--gap-3);
    font-size: var(--t-small);
  }

  .strip--fault {
    border: 1px solid var(--fault);
    background-color: var(--paper);
    background-image: linear-gradient(var(--fault-wash), var(--fault-wash));
    color: var(--fault-text);
  }

  .strip--done {
    border: 1px solid var(--pass);
    background-color: var(--paper);
    background-image: linear-gradient(var(--pass-wash), var(--pass-wash));
    color: var(--pass-text);
  }

  .strip--fixture {
    border: 1px dashed var(--rule-strong);
    background: var(--paper-inset);
    color: var(--ink-2);
  }

  .tag {
    flex: none;
    padding: 0 var(--gap-2);
    border: 1px solid currentColor;
    font-size: var(--t-micro);
    letter-spacing: 0.1em;
  }

  code {
    font-family: var(--mono);
    padding: 0 0.15em;
    background: var(--paper-inset);
  }

  /* Workspace --------------------------------------------------------- */

  .workspace {
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(20rem, 1fr);
    gap: var(--gap-3);
    min-height: 0;
  }

  .mapview {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    padding: var(--gap-2);
    overflow: auto;
  }

  @media (max-width: 62rem) {
    .workspace {
      grid-template-columns: minmax(0, 1fr);
    }

    .mapview :global(.diagram) {
      min-width: 78rem;
    }
  }
</style>
