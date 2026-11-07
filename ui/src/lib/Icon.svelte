<script lang="ts">
  /**
   * The icon set, drawn here rather than imported.
   *
   * Four marks, one stroke weight, square caps and joins — the vocabulary of a
   * drafting pen, which is the only reason these read as part of the sheet
   * instead of as decoration borrowed from somewhere else.
   */
  export type IconName =
    | "survey"
    | "diff"
    | "connect"
    | "fault"
    | "close"
    | "check"
    | "search"
    | "trash"
    | "map"
    | "chevron"
    | "power";

  const { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<svg
  class="btn__icon"
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="square"
  stroke-linejoin="miter"
  aria-hidden="true"
  focusable="false"
>
  {#if name === "survey"}
    <!--
      Dividers walking a measurement across the sheet.

      The legs are stepped wide and the arc scale sits well below the optical
      centre: a narrow pair with a centred crossbar reads as the letter A at
      16px, which is the one thing this mark must not be.
    -->
    <path d="M8 3.2 1.5 14M8 3.2 14.5 14" />
    <path d="M3.55 10.6q4.45 2.6 8.9 0" />
    <circle cx="8" cy="3" r="1.15" fill="currentColor" stroke="none" />
  {:else if name === "diff"}
    <!-- Two conductors, one of them re-routed. -->
    <path d="M1.5 4.5h6M1.5 11.5h6" />
    <path d="M8.5 4.5h6M8.5 11.5h6" stroke-dasharray="2.5 2" />
    <path d="M11.5 1.5v3M11.5 11.5v3" />
  {:else if name === "connect"}
    <!-- A terminal being closed onto a live line. -->
    <path d="M1.5 8h4M10.5 8h4" />
    <rect x="5.5" y="5" width="5" height="6" />
    <path d="M8 3V1.5" />
  {:else if name === "fault"}
    <path d="M8 2 15 14H1z" />
    <path d="M8 6.5v3.5" />
    <circle cx="8" cy="11.9" r="0.85" fill="currentColor" stroke="none" />
  {:else if name === "close"}
    <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />
  {:else if name === "check"}
    <path d="m2.5 8.5 3.5 3.5 7.5-8" />
  {:else if name === "search"}
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 4 4" />
  {:else if name === "trash"}
    <path d="M2.5 4h11M6 4V2h4v2M4 4l.8 10h6.4L12 4" />
  {:else if name === "map"}
    <!-- The demoted wiring view: a source, a bus, two terminals. -->
    <circle cx="3" cy="8" r="1.4" fill="currentColor" stroke="none" />
    <path d="M4.5 8h4M8.5 8V4h4M8.5 8v4h4" />
    <rect x="12" y="2.5" width="2.5" height="3" />
    <rect x="12" y="10.5" width="2.5" height="3" />
  {:else if name === "chevron"}
    <path d="m5 3.5 5 4.5-5 4.5" />
  {:else if name === "power"}
    <!-- The stop mark: a broken ring with the switch through its gap. -->
    <path d="M5 4.2a5 5 0 1 0 6 0" />
    <path d="M8 2v5.5" />
  {/if}
</svg>
