<script lang="ts">
  /**
   * The failure plate.
   *
   * PRODUCT Principle 3: 失敗は大きく表示. An engine that exited 2 has told us
   * the picture below is not trustworthy, so this sits above the drawing at
   * full width, carries the exit code, the offending path and the raw stderr,
   * and offers the one action that can resolve it. It never collapses into a
   * toast and it never lets the stale sheet look current.
   */
  import Icon from "./Icon.svelte";
  import type { EngineError } from "./engine.js";

  const {
    error,
    busy,
    onRetry,
    onDismiss,
  }: {
    error: EngineError;
    /**
     * The last control in the window that could start a read without asking.
     *
     * Every other 再走査 / 差分を取る is `aria-busy` with a guard in its handler;
     * this one had neither, which made it the way into two races — a survey
     * begun while an asset write was in flight, and a `diffStatus` reset landing
     * on a `runPlan()` that had not returned. It is the panel that stays up when
     * things have already gone wrong, so it is the last one that should be able
     * to start something on top.
     */
    busy: boolean;
    onRetry: () => void;
    onDismiss: (() => void) | null;
  } = $props();
</script>

<section class="fault" role="alert" aria-labelledby="fault-title">
  <div class="fault__mark" aria-hidden="true"><Icon name="fault" size={30} /></div>

  <div class="fault__body">
    <h2 id="fault-title">
      エンジンが停止しました
      {#if error.code !== null}<span class="num">exit {error.code}</span>{/if}
    </h2>
    <p class="fault__message">{error.message}</p>
    {#if error.path}
      <p class="fault__path"><span class="annotation">対象</span> <span class="path">{error.path}</span></p>
    {/if}
    {#if error.partialWrite}
      <!--
        The engine was stopped mid-write. Nothing downstream can be trusted
        until the machine is read again, and the backup is the way back, so it
        is stated here rather than left for the owner to find on disk.
      -->
      <!--
        The backup directory is a fact the engine reports (`partial.backupDir`),
        so it is quoted when it is there. It was previously composed here as the
        literal 「backups\&lt;timestamp&gt;\」 — a path this interface invented,
        with a separator that does not match how the rest of the window spells
        the source root, on the panel whose whole job is to be trustworthy about
        a half-finished write.
      -->
      <!--
        Without the engine's own report (the connection dropped, the engine
        thread stopped) nobody knows how far the write got, so the plate does
        not claim a backup exists: it says when one would.
      -->
      {#if error.partial?.backupDir !== undefined}
        <p class="fault__partial">
          書き込みの途中で停止しました。実環境は中途半端な状態の可能性があります。
          変更前の内容は<span class="path">{error.partial.backupDir}</span
          >に元のパス構造のまま退避されています。図を信用する前に必ず再走査してください。
        </p>
      {:else}
        <p class="fault__partial">
          書き込みの途中で接続が切れたか、エンジンが止まりました。書き込みがどこまで進んだかは分かりません。図を信用する前に必ず再走査してください。
          書き込みが始まっていれば、変更前の内容は単一ソース配下の <span class="path">backups</span> ディレクトリに元のパス構造のまま退避されています。
        </p>
      {/if}
    {/if}
    {#if error.stderr.trim()}
      <details>
        <summary>エンジン出力(stderr)</summary>
        <!--
          The root cause is usually the last line of a traceback, below the
          fold of this 12rem box. A scroll container that cannot be focused
          puts that line out of reach of a keyboard — on the one panel whose
          entire job is diagnosis. `tabindex` + a labelled region is the fix.
        -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <!-- The rule guards against stray tab stops on inert content. This is
             the documented exception: a region that scrolls must be reachable
             by keyboard, and `role="region"` + a name is what makes the stop
             announce itself instead of being a mystery. -->
        <pre tabindex="0" role="region" aria-label="エンジン出力(stderr)">{error.stderr.trim()}</pre>
      </details>
    {/if}
    <p class="fault__hint">
      パース失敗は空データとして扱われません(SPEC §6.3)。原因を解消するまで、この図は前回の
      読み取りを表しません。
    </p>
    <div class="fault__actions">
      <button
        type="button"
        class="btn btn--primary"
        aria-busy={busy}
        onclick={() => {
          if (!busy) onRetry();
        }}
      >
        <Icon name="survey" />再走査
      </button>
      {#if onDismiss !== null}
        <button type="button" class="btn" onclick={onDismiss}><Icon name="close" />閉じる</button>
      {/if}
    </div>
  </div>
</section>

<style>
  .fault {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--gap-4);
    padding: var(--gap-4) var(--gap-5);
    /*
     * The wash needs a surface of its own, not the one behind it.
     *
     * `--fault-wash` is translucent, and everywhere else in the interface it
     * blends over `--paper`. This plate is a direct child of the app shell,
     * whose ground is the darker `--desk`, so the same token resolved to a
     * fourth surface nobody had checked: `--ink-2` measured 3.91:1 there
     * (the file path, the hint) and `--fault-text` 4.37:1 (the 12px exit code),
     * both under the 4.5:1 floor — on the one panel that exists to be read when
     * something has gone wrong. Painting `--paper` underneath restores the
     * surface every other use of this wash is measured against.
     */
    background-color: var(--paper);
    background-image: linear-gradient(var(--fault-wash), var(--fault-wash));
    border: 2px solid var(--fault);
    color: var(--fault-text);
  }

  .fault__mark {
    color: var(--fault);
    padding-top: 0.15rem;
  }

  .fault__body {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    min-width: 0;
  }

  h2 {
    display: flex;
    align-items: baseline;
    gap: var(--gap-3);
    font-size: var(--t-xl);
    color: var(--fault-text);
  }

  h2 .num {
    font-size: var(--t-small);
    letter-spacing: 0.08em;
  }

  .fault__message {
    font-size: var(--t-md);
    color: var(--ink);
    overflow-wrap: anywhere;
    max-width: 74ch;
  }

  .fault__path {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
    align-items: baseline;
  }

  .fault__hint {
    color: var(--ink-2);
    max-width: 70ch;
  }

  details {
    border: 1px solid var(--fault);
    background: var(--paper);
  }

  summary {
    padding: var(--gap-1) var(--gap-3);
    font-size: var(--t-small);
    color: var(--ink-2);
    cursor: pointer;
  }

  summary:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -2px;
  }

  .fault__partial {
    padding: var(--gap-2) var(--gap-3);
    border: 1px solid var(--fault);
    background: var(--paper);
    color: var(--fault-text);
    max-width: 70ch;
  }

  pre {
    margin: 0;
    padding: var(--gap-3);
    border-top: 1px solid var(--rule);
    font-family: var(--mono);
    font-size: var(--t-small);
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 12rem;
    overflow-y: auto;
  }

  pre:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -2px;
  }

  .fault__actions {
    display: flex;
    gap: var(--gap-3);
    margin-top: var(--gap-2);
  }
</style>
