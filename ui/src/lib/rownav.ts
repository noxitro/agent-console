/**
 * Keyboard geometry for the asset list.
 *
 * The list is a composite widget, not a pile of buttons: it holds **one** tab
 * stop however many assets are in it, and ↑↓ walk the rows inside it. That is
 * the VS Code list contract, and the reason the arithmetic lives here rather
 * than inside `AssetTable.svelte` is the same reason `schematic.ts` exists —
 * "does the tab stop count grow with the asset count?" should be a failing
 * test, not something the owner discovers after adding a twentieth skill.
 *
 * Nothing in this module touches the DOM. The component maps the returned
 * indices onto elements.
 */

/** The sentinel index for "focus is on the row itself, not on a control in it". */
export const ROW_ITSELF = -1;

/**
 * The row index a key press moves to, or `null` when the key is not ours.
 *
 * Edges clamp rather than wrap: at the last row ↓ returns the last row, which
 * still counts as "handled" so the scroller does not also scroll underneath.
 */
export function nextRowIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const from = Math.min(Math.max(index, 0), count - 1);
  switch (key) {
    case "ArrowDown":
      return Math.min(from + 1, count - 1);
    case "ArrowUp":
      return Math.max(from - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Movement *within* a row: → steps out to the row's controls, ← steps back,
 * Escape returns to the row from anywhere in it.
 *
 * `current` is `ROW_ITSELF` when the row element itself holds focus, otherwise
 * the index of the focused control. Returns `null` when the key means nothing
 * here, so the caller can fall through to row movement.
 */
export function nextControlIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowRight": {
      if (count <= 0) return null;
      const next = Math.min(current + 1, count - 1);
      return next === current ? null : next;
    }
    case "ArrowLeft": {
      if (current <= ROW_ITSELF) return null;
      return current - 1;
    }
    case "Escape":
      return current > ROW_ITSELF ? ROW_ITSELF : null;
    default:
      return null;
  }
}

/**
 * Roving tabindex: exactly one row in the list is reachable by Tab.
 *
 * When nothing is active yet (no selection, nothing focused) the first row
 * carries the tab stop, so Tab into the list always lands somewhere real.
 */
export function rowTabIndex(index: number, active: number, count: number): 0 | -1 {
  if (count <= 0) return -1;
  const focus = active >= 0 && active < count ? active : 0;
  return index === focus ? 0 : -1;
}

/**
 * The row that carries the tab stop: whatever is focused, else whatever is
 * selected, else the first. Keyed by name rather than by position so that
 * searching and filtering do not silently move the tab stop to a different
 * asset.
 */
export function activeRowIndex(
  names: readonly string[],
  focused: string | null,
  selected: string | null,
): number {
  if (names.length === 0) return -1;
  const byFocus = focused === null ? -1 : names.indexOf(focused);
  if (byFocus >= 0) return byFocus;
  const bySelection = selected === null ? -1 : names.indexOf(selected);
  return bySelection >= 0 ? bySelection : 0;
}

/**
 * A click that merely ended a text drag must not re-select the row — otherwise
 * making the whole row a click target would cost the ability to copy a name.
 */
export function isTextSelectionClick(selectionText: string | null | undefined): boolean {
  return typeof selectionText === "string" && selectionText.trim().length > 0;
}
