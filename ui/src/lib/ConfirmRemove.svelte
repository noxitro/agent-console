<script lang="ts">
  /**
   * Confirmation for `am remove` — the console's one irreversible edit.
   *
   * The enable/disable toggle gets no dialog (one manifest line, undone by
   * clicking again); this does, because it deletes a file. What it says is the
   * three things the owner needs to decide: exactly what is removed, what is
   * *not* touched (the copies already delivered to the tools), and where the
   * backup goes.
   */
  import Icon from "./Icon.svelte";
  import { ASSET_TYPE_LABEL, backupsPath } from "./assets.js";
  import type { AssetType } from "./contract.js";

  const {
    pending,
    sourceRoot,
    busy,
    onCancel,
    onConfirm,
  }: {
    pending: { assetType: AssetType; name: string } | null;
    sourceRoot: string;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);

  $effect(() => {
    const el = dialog;
    if (el === null) return;
    if (pending !== null && !el.open) el.showModal();
    if (pending === null && el.open) el.close();
  });
</script>

<dialog
  bind:this={dialog}
  class="confirm"
  aria-labelledby="remove-title"
  aria-busy={busy}
  oncancel={(event) => {
    event.preventDefault();
    if (!busy) onCancel();
  }}
>
  {#if pending !== null}
    <form method="dialog" onsubmit={(event) => event.preventDefault()}>
      <header>
        <h2 id="remove-title">ソースから削除します</h2>
        <p>
          {ASSET_TYPE_LABEL[pending.assetType]}
          <strong>{pending.name}</strong> を単一ソースから削除します。この操作は元に戻せません(退避先からの復元のみ)。
        </p>
      </header>

      <ul class="facts">
        <li>削除されるのは <span class="path">{sourceRoot}</span> 配下のソースだけです。</li>
        <li>
          各ツールへ配布済みの実体は残ります。それらの削除は <code>apply --prune</code> の担当です。
        </li>
        <li>
          削除前の内容は <span class="path">{backupsPath(sourceRoot)}</span> に退避されます。
        </li>
      </ul>

      <footer>
        <button type="button" class="btn" onclick={onCancel} disabled={busy}>取消</button>
        <button
          type="button"
          class="btn btn--danger"
          aria-busy={busy}
          onclick={() => {
            if (!busy) onConfirm();
          }}
        >
          <Icon name="trash" />
          {busy ? "削除中…" : "削除する"}
        </button>
      </footer>
    </form>
  {/if}
</dialog>

<style>
  .confirm {
    width: min(34rem, calc(100vw - 3rem));
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
  }

  form {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
    padding: var(--gap-5);
  }

  h2 {
    font-size: var(--t-lg);
  }

  header p {
    margin-top: var(--gap-2);
    color: var(--ink-2);
  }

  .facts {
    margin: 0;
    padding: var(--gap-3) var(--gap-3) var(--gap-3) var(--gap-5);
    border: 1px solid var(--rule-strong);
    background: var(--paper-inset);
    font-size: var(--t-small);
  }

  .facts li + li {
    margin-top: var(--gap-1);
  }

  code {
    font-family: var(--mono);
    padding: 0 0.15em;
    background: var(--paper-panel);
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--gap-3);
  }
</style>
