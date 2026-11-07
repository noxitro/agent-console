/**
 * Where focus goes when a modal write finishes.
 *
 * The browser restores focus to the element that opened a dialog, and after a
 * successful `remove` that element is gone: the trash button belongs to a row
 * the re-survey has just dropped, and it was `disabled` before that. Restoration
 * fails silently and focus lands on `<body>`, so a keyboard user who has just
 * been told to check the record has to Tab through the whole window to reach it.
 * `App.svelte` therefore sends focus to the PLAN cell instead — but only if it
 * can tell that a removal has just finished, which is what this decides.
 *
 * It lives here, as a pure transition, because the version written inline in the
 * component was wrong in a way the component could not show. `Session.confirmRemove`
 * clears `pendingRemoval` *before* it awaits the re-survey, so a rule that
 * recomputed 「a removal is in flight」 as `assetBusy && pendingRemoval !== null`
 * dropped back to false on the flush in the middle of that await — and the flush
 * that finally saw `assetBusy === false` no longer knew a removal had been
 * running. The refocus never fired on the path it was written for.
 *
 * The fix is to make the bit *sticky for the duration of the operation*: the
 * removal is in flight from the moment it is seen until `assetBusy` clears,
 * whatever `pendingRemoval` does in between.
 */

export interface RemovalFocusStep {
  /** Carry into the next call as `previous`. */
  inFlight: boolean;
  /** True on exactly the one step where a removal that was running ended. */
  finished: boolean;
}

/**
 * @param previous `inFlight` from the last call (start with `false`).
 * @param busy `Session.assetBusy` — any asset command, not only a removal.
 * @param hasPending `Session.pendingRemoval !== null`, which is what tells a
 *   removal apart from an enable/disable toggle.
 */
export function stepRemovalFocus(
  previous: boolean,
  busy: boolean,
  hasPending: boolean,
): RemovalFocusStep {
  // Not busy: whatever was running has ended. `previous` is the whole answer —
  // true only if what ended was a removal.
  if (!busy) return { inFlight: false, finished: previous };
  // Busy: once seen, a removal stays seen until the operation ends. A toggle
  // never sets the bit, so it never claims the refocus.
  return { inFlight: previous || hasPending, finished: false };
}
