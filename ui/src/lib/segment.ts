/**
 * Keyboard geometry for a segmented control.
 *
 * The toolbar's two narrowings are `role="radiogroup"`, and a radio group is a
 * **composite widget**: one tab stop for the whole group, arrow keys to move
 * between its options. Ten buttons that each take a Tab press announce
 * themselves as radios and then behave like a toolbar of links — the role and
 * the behaviour have to agree, and the agreement is what keeps the distance
 * from the search box to the asset list at three presses however many targets
 * SPEC §10 adds later.
 *
 * Same discipline as `rownav.ts`, and for the same reason: "did the tab stop
 * count grow with the option count?" should be a failing test rather than
 * something the owner discovers by counting Tab presses.
 *
 * Nothing here touches the DOM. The component maps the returned index onto an
 * element and onto the selection — for a radio group those move together, which
 * is why the caller selects on arrow rather than waiting for Enter.
 */

/**
 * The option index a key press moves to, or `null` when the key is not ours.
 *
 * Both axes are accepted because the group is a single visual row that a
 * screen-reader user may be navigating as a vertical list. Edges **wrap**,
 * which is what a radio group does (a list wraps nowhere — `rownav.ts` clamps —
 * because a list has a first and last item the reader is tracking; a segmented
 * control is a ring of alternatives).
 */
export function nextSegmentIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const from = Math.min(Math.max(index, 0), count - 1);
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (from + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (from + count - 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Roving tabindex: exactly one option in the group is reachable by Tab.
 *
 * The checked option carries it, so tabbing into the group lands on the current
 * answer rather than on a position the owner would have to read to understand.
 * A group with nothing checked cannot happen here (`all` is always a real
 * member), but the first option takes the stop if it ever did.
 */
export function segmentTabIndex(index: number, checked: number, count: number): 0 | -1 {
  if (count <= 0) return -1;
  const stop = checked >= 0 && checked < count ? checked : 0;
  return index === stop ? 0 : -1;
}
