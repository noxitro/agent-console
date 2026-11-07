<script lang="ts">
  /**
   * The drawing.
   *
   * One sheet: the single source on the left, the agent terminal blocks on the
   * right, and the real conductors between them. Every line is a fact the
   * engine reported — a solid line means a link on disk resolves to the source,
   * a break symbol means it does not, an open terminal means the circuit is
   * empty. Nothing here invents a connection to make the picture tidy.
   *
   * Loading and empty are drawn as two different sheets, not as one blank one:
   * a survey in progress shows the frame with its conductors un-measured and a
   * sweep running across them; an empty source shows a complete drawing of a
   * machine that genuinely has nothing in it, and says what to run.
   *
   * Its *scope* is drawn too. The sheet's proportion was approved at four
   * blocks and SPEC §10 added a fifth target, so `schematic.omittedTargets`
   * names whatever this drawing leaves out — in the text equivalent and, in
   * `App.svelte`, beside the sheet. A demoted overview may be partial; it may
   * not be partial in silence.
   */
  import Icon from "./Icon.svelte";
  import type { Schematic, WireState } from "./schematic.js";
  import { LAYOUT, WIRE_STATE_LABEL, omittedTargetsNote } from "./schematic.js";
  import type { Status } from "./session.svelte.js";

  const {
    schematic,
    status,
    justReconnected = [],
  }: {
    schematic: Schematic | null;
    status: Status;
    justReconnected?: string[];
  } = $props();

  let hovered = $state<string | null>(null);

  const reconnected = $derived(new Set(justReconnected));

  /**
   * The sheet's coordinates. Derived from the number of skills the source holds
   * (`schematic.geometry`), so a sixth skill makes the sheet taller instead of
   * making row six land on the mcp terminal. Before a reading exists the
   * placeholder sheet is drawn at the reference count.
   */
  const g = $derived(schematic?.geometry ?? LAYOUT);

  /** Scalloped outline — the revision cloud a drafter draws around a change. */
  function cloud(x: number, y: number, w: number, h: number, r = 9): string {
    const points: [number, number][] = [];
    const along = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
    ): void => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(2, Math.round(len / (r * 1.6)));
      for (let i = 0; i < n; i += 1) {
        points.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
      }
    };
    along(x, y, x + w, y);
    along(x + w, y, x + w, y + h);
    along(x + w, y + h, x, y + h);
    along(x, y + h, x, y);
    const first = points[0];
    if (first === undefined) return "";
    let d = `M ${first[0]} ${first[1]}`;
    for (let i = 1; i <= points.length; i += 1) {
      const p = points[i % points.length];
      if (p === undefined) continue;
      d += ` A ${r} ${r} 0 0 1 ${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
    }
    return `${d} Z`;
  }

  function wireClass(state: WireState): string {
    return `wire wire--${state}`;
  }

  const dimmed = (id: string): boolean => hovered !== null && hovered !== id;

  /** The two asset classes that leave the source as a single outlet each. */
  const outlets = $derived(
    schematic === null
      ? []
      : [
          { key: "mcp", y: schematic.source.mcpPin.y, label: "mcp", count: schematic.source.mcpCount },
          {
            key: "agents",
            y: schematic.source.agentPin.y,
            label: "agents",
            count: schematic.source.agentCount,
          },
        ],
  );

  const LEGEND_TEXT = [
    "結線(junction/symlink)",
    "断線 — 実体の二重保持",
    "未結線 — 対象に無し",
    "開放端子 — 資産 0 件",
  ] as const;
  const LEGEND_KIND = ["linked", "severed", "unwired", "open"] as const;

  const LEGEND = $derived(
    LEGEND_KIND.map((kind, i) => ({
      kind,
      text: LEGEND_TEXT[i] ?? "",
      y: g.legend.rowY[i] ?? g.legend.y,
    })),
  );

  /**
   * The drawing, in words.
   *
   * A schematic is a picture, and a picture of link health is unreadable to
   * anyone using a screen reader — while link health is the whole job this
   * window does. So every state the lines carry (per conductor: number, name,
   * target, condition, and the engine's own explanation) is also written out
   * here, visually hidden, and the SVG itself is hidden from assistive
   * technology rather than flattened into one useless label. This is the text
   * equivalent, not a summary: nothing the drawing shows is missing from it.
   */
  const detailOf = $derived(
    new Map((schematic?.wires ?? []).map((wire) => [wire.id, wire.detail])),
  );
</script>

<figure
  class="diagram"
  class:diagram--busy={status === "running"}
  style={`--sheet-w:${g.sheet.w}; --sheet-h:${g.sheet.h}`}
>
  <figcaption class="sr-only">
    <h3>結線図 — 単一ソースと配布先エージェント</h3>
    {#if schematic === null}
      <p>
        {status === "failed"
          ? "読み取り不能。図は引かれていません。上の警告を解消してから再走査してください。"
          : "走査中。実環境を読み取っています。"}
      </p>
    {:else}
      <p>
        結線 {schematic.counts.linked} 件、断線 {schematic.counts.severed +
          schematic.counts.blocked} 件、未結線 {schematic.counts.unwired} 件。
        ソースは {schematic.source.root}(skills {schematic.strands.length} 件、
        mcp {schematic.source.mcpCount} 件、agents {schematic.source.agentCount} 件)。
      </p>
      {#each schematic.targets as target (target.id)}
        <h4>{target.name} — {target.note}{target.enabled ? "" : "(無効)"}</h4>
        <ul>
          {#each target.pins as pin (pin.name)}
            <li>
              {pin.no}. {pin.name} — {WIRE_STATE_LABEL[pin.state]}{detailOf.get(
                `${target.id}:${pin.name}`,
              )
                ? `。${detailOf.get(`${target.id}:${pin.name}`)}`
                : ""}
            </li>
          {/each}
          {#each target.terminals as terminal (terminal.key)}
            <li>{terminal.label} — {terminal.note}</li>
          {/each}
        </ul>
      {/each}
      {#if schematic.omittedTargets.length > 0}
        <p>{omittedTargetsNote(schematic.omittedTargets)}</p>
      {/if}
      {#if schematic.sourceEmpty}
        <p>ソースに資産がありません。am import --move で実環境から吸い上げます。</p>
      {/if}
    {/if}
  </figcaption>

  <svg
    viewBox="0 0 {g.sheet.w} {g.sheet.h}"
    aria-hidden="true"
    preserveAspectRatio="xMidYMid meet"
  >
    <defs>
      <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M20 0H0V20" fill="none" stroke="var(--rule)" stroke-width="0.4" opacity="0.35" />
      </pattern>
      <pattern
        id="hatch"
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <path d="M0 0V6" stroke="var(--ink-3)" stroke-width="1.4" />
      </pattern>
    </defs>

    <rect x="0" y="0" width={g.sheet.w} height={g.sheet.h} fill="url(#grid)" />

    <!-- Sheet border and zone ruler, as on a printed drawing. -->
    <g class="frame">
      <rect x="14" y="14" width={g.sheet.w - 28} height={g.sheet.h - 28} />
      <rect x="22" y="22" width={g.sheet.w - 44} height={g.sheet.h - 44} class="frame__inner" />
      {#each ["A", "B", "C", "D", "E"] as zone, i (zone)}
        <text class="zone" x={22 + (g.sheet.w - 44) * ((i + 0.5) / 5)} y="19.5">{zone}</text>
        <path d={`M ${22 + ((g.sheet.w - 44) * i) / 5} 14 v 8`} />
      {/each}
      {#each ["1", "2", "3", "4"] as zone, i (zone)}
        <text
          class="zone"
          x="18"
          y={22 + (g.sheet.h - 44) * ((i + 0.5) / 4)}
          transform={`rotate(-90 18 ${22 + (g.sheet.h - 44) * ((i + 0.5) / 4)})`}>{zone}</text
        >
        <path d={`M 14 ${22 + ((g.sheet.h - 44) * i) / 4} h 8`} />
      {/each}
    </g>

    {#if schematic === null}
      <!--
        Two different sheets share this outline. While a survey runs, the frame
        is real and the measurements are merely not taken yet, so a sweep moves
        across it. After a failed read nothing is being measured at all — the
        sweep stops and the sheet says why, instead of implying work in progress.
      -->
      <g class="skeleton" class:skeleton--void={status === "failed"} aria-hidden="true">
        <rect x={LAYOUT.source.x} y={LAYOUT.source.y} width={LAYOUT.source.w} height={LAYOUT.source.h} />
        {#each LAYOUT.boxes as box (box.id)}
          <rect x={LAYOUT.targetX} y={box.top} width={LAYOUT.targetW} height={box.height} />
        {/each}
        {#each [0, 1, 2, 3, 4] as i (i)}
          {@const sy = LAYOUT.skillY0 + i * LAYOUT.skillRowGap}
          {@const ty = 80 + i * LAYOUT.targetRowGap}
          <path
            class="skeleton__wire"
            d={`M ${LAYOUT.source.x + LAYOUT.source.w} ${sy} C 700 ${sy}, 900 ${ty}, ${LAYOUT.targetX} ${ty}`}
          />
          <path
            class="skeleton__wire"
            d={`M ${LAYOUT.source.x + LAYOUT.source.w} ${sy} C 700 ${sy}, 940 ${ty + 200}, ${LAYOUT.targetX} ${ty + 200}`}
          />
        {/each}
        {#if status !== "failed"}
          <g class="sweep">
            <path d={`M 0 22 V ${g.sheet.h - 22}`} />
          </g>
        {/if}
        <text class="skeleton__label" x={g.sheet.w / 2} y={g.sheet.h / 2 + 6} text-anchor="middle">
          {status === "failed"
            ? "読み取り不能 — 上の警告を解消してから再走査してください"
            : "走査中 — 実環境を読み取っています"}
        </text>
      </g>
    {:else}
      <!-- ---------------------------------------------------------- -->
      <!-- Source block                                               -->
      <!-- ---------------------------------------------------------- -->
      {@const s = schematic.source}
      <g class="block block--source">
        <rect x={s.x} y={s.y} width={s.w} height={s.h} />
        <path d={`M ${s.x} ${s.y + 84} h ${s.w}`} class="hairline" />
        <text class="block__title" x={s.x + 14} y={s.y + 28}>単一ソース</text>
        <text class="mono-9 muted" x={s.x + 14} y={s.y + 52}>{s.root}</text>
        <text class="mono-9 muted" x={s.x + 14} y={s.y + 70}>{s.skillsRoot}</text>

        <text class="row-head" x={s.x + 14} y={s.y + 106}>skills</text>
        <text class="mono-9 muted" x={s.x + s.w - 14} y={s.y + 106} text-anchor="end"
          >{schematic.strands.length} 件 / linkMode {s.linkMode}</text
        >

        {#each schematic.strands as strand (strand.name)}
          <g
            class="strand"
            class:is-dim={hovered !== null && !hovered.endsWith(`:${strand.name}`)}
            role="presentation"
            onmouseenter={() => (hovered = `src:${strand.name}`)}
            onmouseleave={() => (hovered = null)}
          >
            <text class="mono-9 no" x={s.x + 16} y={strand.pin.y + 3.5}
              >{String(strand.no).padStart(2, "0")}</text
            >
            <text class="asset" x={s.x + 40} y={strand.pin.y + 3.5}>{strand.name}</text>
            {#if !strand.hasSkillMd}
              <text class="mono-9 fault" x={s.x + s.w - 14} y={strand.pin.y + 3.5} text-anchor="end"
                >SKILL.md 欠落</text
              >
            {/if}
            <path class="strand__line" d={strand.d} />
            <circle class="pin" cx={strand.pin.x} cy={strand.pin.y} r="3.2" />
            <circle class="pin__core" cx={strand.pin.x} cy={strand.pin.y} r="1.5" />
          </g>
        {/each}

        <!-- The rule that closes the skill list. Derived, not a constant: at a
             fixed offset it was drawn *through* the sixth skill row. -->
        <path d={`M ${s.x} ${g.srcDividerY} h ${s.w}`} class="hairline" />
        {#each outlets as outlet (outlet.key)}
          <text class="row-head" x={s.x + 14} y={outlet.y + 3.5}>{outlet.label}</text>
          <text class="mono-9 muted" x={s.x + s.w - 22} y={outlet.y + 3.5} text-anchor="end"
            >{outlet.count} 件{outlet.count === 0 ? " — 開放" : ""}</text
          >
          <circle
            class="pin"
            class:pin--open={outlet.count === 0}
            cx={s.x + s.w}
            cy={outlet.y}
            r="3.2"
          />
          {#if outlet.count > 0}
            <circle class="pin__core" cx={s.x + s.w} cy={outlet.y} r="1.5" />
          {/if}
        {/each}
      </g>

      <!-- ---------------------------------------------------------- -->
      <!-- Junction box                                                -->
      <!-- ---------------------------------------------------------- -->
      {#if schematic.strands.length > 0}
        {@const j = schematic.junction}
        <g class="junction">
          <rect x={j.x} y={j.y} width={j.w} height={j.h} />
          <text class="mono-9" x={j.x + j.w / 2} y={j.y - 8} text-anchor="middle">J1</text>
          <text class="mono-9 muted" x={j.x + j.w / 2} y={j.y + j.h + 16} text-anchor="middle"
            >分岐</text
          >
        </g>
      {/if}

      <!-- ---------------------------------------------------------- -->
      <!-- Conductors                                                  -->
      <!-- ---------------------------------------------------------- -->
      {#each schematic.wires as wire, i (wire.id)}
        <g
          class={wireClass(wire.state)}
          class:is-pending={wire.pending}
          class:is-dim={dimmed(wire.id) && hovered !== `src:${wire.name}`}
          class:is-reconnected={reconnected.has(wire.id)}
          style={`--len:${wire.length}; --delay:${i * 45}ms`}
          role="presentation"
          onmouseenter={() => (hovered = wire.id)}
          onmouseleave={() => (hovered = null)}
        >
          <title
            >{wire.no}. {wire.name} → {wire.target}: {WIRE_STATE_LABEL[wire.state]}{wire.detail
              ? ` — ${wire.detail}`
              : ""}</title
          >
          <path class="wire__line" d={wire.d} />
          {#if wire.state === "severed" || wire.state === "blocked"}
            <!-- Knock the conductor out and mark the break, drafting-fashion. -->
            <circle class="wire__gap" cx={wire.mid.x} cy={wire.mid.y} r="9" />
            <path
              class="wire__break"
              d={`M ${wire.mid.x - 6} ${wire.mid.y + 7} l 7 -14 M ${wire.mid.x + 1} ${wire.mid.y + 7} l 7 -14`}
            />
            <text class="mono-8 fault" x={wire.mid.x + 1} y={wire.mid.y + 20} text-anchor="middle"
              >{wire.state === "blocked" ? "要手当て" : "断線"}</text
            >
          {/if}
          {#if wire.pending && wire.revision !== null}
            <g class="revision" transform={`translate(${wire.end.x - 30} ${wire.end.y})`}>
              <path d="M0 -8 L9 7 L-9 7 Z" />
              <text class="mono-8" x="0" y="4.5" text-anchor="middle">{wire.revision}</text>
            </g>
          {/if}
        </g>
      {/each}

      <!-- Targets that read the source directories themselves (SPEC §4). -->
      {#each schematic.sharedTaps as tap (tap.id)}
        <path class="tap" d={tap.d} />
      {/each}

      <!-- ---------------------------------------------------------- -->
      <!-- Target blocks                                               -->
      <!-- ---------------------------------------------------------- -->
      {#each schematic.targets as target (target.id)}
        <g class="block block--target" class:is-disabled={!target.enabled}>
          {#if target.revisions > 0}
            <path class="revision-cloud" d={cloud(target.x - 8, target.y - 8, target.w + 16, target.h + 16)} />
          {/if}
          <rect x={target.x} y={target.y} width={target.w} height={target.h} />
          <text class="block__title" x={target.x + 16} y={target.y + 26}>{target.name}</text>
          <text class="mono-9 muted" x={target.x + target.w - 14} y={target.y + 26} text-anchor="end"
            >{target.enabled ? target.note : "無効"}</text
          >
          <path d={`M ${target.x} ${target.y + 38} h ${target.w}`} class="hairline" />

          {#each target.pins as pin (pin.name)}
            <g class="terminal" class:is-dim={dimmed(`${target.id}:${pin.name}`) && hovered !== `src:${pin.name}`}>
              <circle
                class={`pin pin--${pin.state}`}
                cx={pin.at.x}
                cy={pin.at.y}
                r="3.6"
              />
              {#if pin.state === "linked"}
                <circle
                  class="pin__core"
                  class:pin__core--fresh={reconnected.has(`${target.id}:${pin.name}`)}
                  cx={pin.at.x}
                  cy={pin.at.y}
                  r="1.6"
                />
              {/if}
              <text class="mono-9 no" x={target.x + 16} y={pin.at.y + 3.5}
                >{String(pin.no).padStart(2, "0")}</text
              >
              <text class="asset" x={target.x + 40} y={pin.at.y + 3.5}>{pin.name}</text>
              <text
                class={`mono-8 state state--${pin.state}`}
                x={target.x + target.w - 14}
                y={pin.at.y + 3.5}
                text-anchor="end">{WIRE_STATE_LABEL[pin.state]}</text
              >
            </g>
          {/each}

          {#each target.terminals as terminal (terminal.key)}
            <g class="terminal">
              {#if terminal.state === "unsupported"}
                <rect
                  class="terminal__hatch"
                  x={terminal.at.x - 4}
                  y={terminal.at.y - 4}
                  width="8"
                  height="8"
                />
              {:else}
                <circle
                  class={`pin pin--${terminal.state === "shared" ? "shared" : "open"}`}
                  cx={terminal.at.x}
                  cy={terminal.at.y}
                  r="3.6"
                />
              {/if}
              <text class="row-head" x={target.x + 16} y={terminal.at.y + 3.5}>{terminal.label}</text
              >
              <text
                class="mono-8 muted"
                x={target.x + target.w - 14}
                y={terminal.at.y + 3.5}
                text-anchor="end">{terminal.note}</text
              >
            </g>
          {/each}
        </g>
      {/each}

      <!-- ---------------------------------------------------------- -->
      <!-- Legend                                                      -->
      <!-- ---------------------------------------------------------- -->
      <!--
        Frame, heading and rule come from `g.legend` — the *computed* geometry —
        for the same reason the rows do. `LAYOUT.legend` is the four-skill
        default, so a source with more than four skills pushed `g.legend.rowY`
        down (`schematic.ts` derives it from the source block's height) while the
        box stayed put, and the legend text was drawn outside its own frame.
      -->
      <g class="legend">
        <rect x={g.legend.x} y={g.legend.y} width={g.legend.w} height={g.legend.h} />
        <text class="row-head" x={g.legend.x + 14} y={g.legend.y + 22}>凡例</text>
        <path d={`M ${g.legend.x} ${g.legend.y + 32} h ${g.legend.w}`} class="hairline" />
        {#each LEGEND as item (item.kind)}
          {#if item.kind === "severed"}
            <path class="legend__wire wire--severed" d={`M 62 ${item.y} h 34`} />
            <path class="wire__break" d={`M 76 ${item.y + 5} l 5 -10 M 82 ${item.y + 5} l 5 -10`} />
          {:else if item.kind === "unwired"}
            <path class="legend__wire wire--unwired" d={`M 62 ${item.y} h 34`} />
          {:else if item.kind === "open"}
            <path class="legend__wire" d={`M 62 ${item.y} h 24`} />
            <circle class="pin pin--open" cx="92" cy={item.y} r="3.6" />
          {:else}
            <path class="legend__wire" d={`M 62 ${item.y} h 24`} />
            <circle class="pin" cx="92" cy={item.y} r="3.6" />
            <circle class="pin__core" cx="92" cy={item.y} r="1.6" />
          {/if}
          <text class="mono-9 muted" x="108" y={item.y + 3.5}>{item.text}</text>
        {/each}
      </g>

      {#if schematic.sourceEmpty}
        <!--
          Not "no data". A source with nothing in it is a specific, recoverable
          situation, and the drawing says which command recovers it.
        -->
        {@const e = LAYOUT.empty}
        <g class="empty">
          <rect x={e.x} y={e.y} width={e.w} height={e.h} />
          <text class="empty__title" x={e.x + e.w / 2} y={e.y + 42} text-anchor="middle"
            >ソースに資産がありません</text
          >
          <text class="empty__body" x={e.x + e.w / 2} y={e.y + 72} text-anchor="middle"
            >実環境から吸い上げると、この図に結線が現れます。</text
          >
          <rect class="empty__cmd" x={e.x + 62} y={e.y + 88} width={e.w - 124} height="30" />
          <text class="mono-11" x={e.x + e.w / 2} y={e.y + 108} text-anchor="middle"
            >am import --move</text
          >
        </g>
      {/if}
    {/if}
  </svg>

  {#if status === "running" && schematic !== null}
    <!--
      Visual only. DESIGN asks for **one** `role="status"` region, and App.svelte
      already holds it and already announces 「走査中です。」 — a second live
      region here said the same thing a second time, which is how a polite region
      turns into an interruption.
    -->
    <p class="diagram__badge" aria-hidden="true"><Icon name="survey" size={13} />再走査中</p>
  {/if}
</figure>

<style>
  /*
   * The sheet takes the panel's width and the height that width implies.
   *
   * `--sheet-w` / `--sheet-h` are the viewBox, so giving the figure the same
   * ratio means the drawing lands edge to edge with no letterbox band above and
   * below it — the box *is* the sheet rather than a window the sheet is centred
   * in. `max-height` is the one concession: when the panel is shorter than the
   * implied height the drawing scales down inside it (auto margins keep it
   * centred) instead of overflowing, because the inspection stamp below has to
   * stay on screen. `meet` keeps the drawing whole; it is a drawing, and a
   * cropped drawing is a different drawing.
   */
  .diagram {
    margin: auto;
    position: relative;
    width: 100%;
    aspect-ratio: var(--sheet-w) / var(--sheet-h);
    max-height: 100%;
    min-height: 0;
    min-width: 0;
    display: flex;
  }

  svg {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
  }

  text {
    font-family: var(--sans);
    fill: var(--ink);
  }

  .mono-8,
  .mono-9,
  .mono-11,
  .zone,
  .no {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
  }

  /*
   * Sizes are in sheet units, and the sheet is normally drawn a little under
   * 1:1 to fit the window, so each step is set about a quarter larger than the
   * pixel size it needs to end up at. The scale steps stay proportional to the
   * drawing, which is what keeps rule weights and lettering in the relationship
   * a printed sheet has.
   */
  .mono-8 {
    font-size: 11px;
    letter-spacing: 0.02em;
  }
  .mono-9 {
    font-size: 11px;
  }
  .mono-11 {
    font-size: 15px;
    letter-spacing: 0.04em;
  }

  .muted {
    fill: var(--ink-2);
  }
  .fault {
    fill: var(--fault-text);
  }

  .zone {
    font-size: 10px;
    fill: var(--ink-2);
    dominant-baseline: middle;
    text-anchor: middle;
  }

  /* Frame ------------------------------------------------------------ */
  .frame rect {
    fill: none;
    stroke: var(--ink);
    stroke-width: 1.4;
  }
  .frame__inner {
    stroke: var(--rule);
    stroke-width: 0.8;
  }
  .frame path {
    stroke: var(--rule);
    stroke-width: 0.8;
  }

  /* Blocks ------------------------------------------------------------ */
  .block rect {
    fill: var(--paper-panel);
    stroke: var(--ink);
    stroke-width: 1.3;
  }
  .block--target.is-disabled rect {
    stroke: var(--ink-3);
    stroke-dasharray: 5 3;
  }
  .block__title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  .row-head {
    font-family: var(--mono);
    font-size: 11.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    fill: var(--ink-2);
  }
  .asset {
    font-family: var(--mono);
    font-size: 12.5px;
    fill: var(--ink);
  }
  .hairline {
    stroke: var(--rule);
    stroke-width: 0.8;
    fill: none;
  }
  /* Conductor numbers are read against the revision flags, so they are text. */
  .no {
    fill: var(--ink-2);
    font-size: 10.5px;
  }

  /* Terminals --------------------------------------------------------- */
  .pin {
    fill: var(--paper);
    stroke: var(--ink);
    stroke-width: 1.3;
  }
  .pin--open,
  .pin--shared {
    stroke: var(--ink-3);
  }
  .pin--shared {
    stroke-dasharray: 2 1.6;
  }
  .pin--severed,
  .pin--blocked {
    stroke: var(--fault);
  }
  .pin--unwired {
    stroke: var(--ink-3);
    stroke-dasharray: 2 1.6;
  }
  .pin__core {
    fill: var(--ink);
    stroke: none;
  }
  .terminal__hatch {
    fill: url(#hatch);
    stroke: var(--ink-3);
    stroke-width: 1;
  }
  .state--severed,
  .state--blocked {
    fill: var(--fault-text);
  }
  .state--unwired {
    fill: var(--ink-2);
  }
  .state--linked {
    fill: var(--ink-2);
  }

  .strand__line,
  .legend__wire {
    fill: none;
    stroke: var(--ink);
    stroke-width: 1.2;
  }

  .junction rect {
    fill: var(--paper-inset);
    stroke: var(--ink);
    stroke-width: 1.4;
  }
  .junction text {
    font-size: 11.5px;
    letter-spacing: 0.1em;
  }

  /* Conductors -------------------------------------------------------- */
  .wire {
    transition: opacity 160ms var(--ease-out);
  }
  .wire.is-dim,
  .strand.is-dim,
  .terminal.is-dim {
    opacity: 0.28;
  }
  .wire__line {
    fill: none;
    stroke: var(--ink);
    stroke-width: 1.2;
  }
  .wire--severed .wire__line,
  .wire--blocked .wire__line {
    stroke: var(--fault);
  }
  .wire--blocked .wire__line {
    stroke-width: 1.8;
  }
  .wire--unwired .wire__line,
  .legend__wire.wire--unwired {
    stroke: var(--ink-3);
    stroke-dasharray: 3 3.5;
  }
  .legend__wire.wire--severed {
    stroke: var(--fault);
  }
  .wire__gap {
    fill: var(--paper);
    stroke: none;
  }
  .wire__break {
    fill: none;
    stroke: var(--fault);
    stroke-width: 1.7;
    stroke-linecap: butt;
  }
  .wire:hover .wire__line {
    stroke-width: 2.2;
  }

  .revision path {
    fill: var(--paper);
    stroke: var(--ink);
    stroke-width: 1.2;
  }
  .revision text {
    font-size: 10px;
    fill: var(--ink);
  }
  .revision-cloud {
    fill: none;
    stroke: var(--ink);
    stroke-width: 1;
    stroke-dasharray: none;
    opacity: 0.55;
  }
  .wire.is-pending .wire__line {
    stroke-dasharray: 6 4;
    animation: march 900ms linear infinite;
  }
  @keyframes march {
    to {
      stroke-dashoffset: -10;
    }
  }

  .tap {
    fill: none;
    stroke: var(--ink-3);
    stroke-width: 1;
    stroke-dasharray: 4 4;
  }

  /*
   * The authored moment: on a successful apply the repaired conductors draw
   * themselves in from the junction outward, staggered, and the terminal seats
   * with a green flash. It runs once, only over links the engine re-measured as
   * whole.
   */
  .wire.is-reconnected .wire__line {
    stroke-dasharray: var(--len);
    stroke-dashoffset: var(--len);
    animation: seat 620ms var(--ease-out) var(--delay) forwards;
  }
  @keyframes seat {
    to {
      stroke-dashoffset: 0;
    }
  }
  .pin__core--fresh {
    animation: contact 520ms var(--ease-out) both;
  }
  @keyframes contact {
    0%,
    55% {
      r: 0;
      fill: var(--pass);
    }
    75% {
      r: 4.2;
      fill: var(--pass);
    }
    100% {
      r: 1.6;
      fill: var(--ink);
    }
  }

  /* Skeleton ---------------------------------------------------------- */
  .skeleton rect {
    fill: var(--paper-panel);
    stroke: var(--ink-3);
    stroke-width: 1;
    stroke-dasharray: 6 4;
  }
  .skeleton__wire {
    fill: none;
    stroke: var(--ink-3);
    stroke-width: 1;
    stroke-dasharray: 3 5;
    opacity: 0.55;
  }
  .skeleton__label {
    font-size: 16px;
    fill: var(--ink-2);
    letter-spacing: 0.08em;
  }
  .skeleton--void .skeleton__label {
    fill: var(--fault-text);
  }
  .skeleton--void rect,
  .skeleton--void .skeleton__wire {
    opacity: 0.4;
  }
  .sweep path {
    stroke: var(--ink);
    stroke-width: 1.2;
    opacity: 0.35;
  }
  .sweep {
    animation: sweep 1800ms var(--ease-out) infinite;
  }
  @keyframes sweep {
    0% {
      transform: translateX(40px);
      opacity: 0;
    }
    12% {
      opacity: 1;
    }
    88% {
      opacity: 1;
    }
    100% {
      transform: translateX(1020px);
      opacity: 0;
    }
  }

  /* Legend / empty ----------------------------------------------------- */
  .legend rect {
    fill: none;
    stroke: var(--rule-strong);
    stroke-width: 1;
  }

  .empty rect {
    fill: var(--paper);
    stroke: var(--ink);
    stroke-width: 1.4;
  }
  .empty__cmd {
    fill: var(--paper-inset);
    stroke: var(--rule-strong);
    stroke-width: 1;
  }
  .empty__title {
    font-size: 21px;
    font-weight: 700;
  }
  .empty__body {
    font-size: 14px;
    fill: var(--ink-2);
  }

  /* Re-survey badge ---------------------------------------------------- */
  .diagram__badge {
    position: absolute;
    top: 1.75rem;
    right: 1.75rem;
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    padding: 0.2rem 0.6rem;
    background: var(--paper-inset);
    border: 1px solid var(--rule-strong);
    font-size: var(--t-micro);
    letter-spacing: 0.08em;
    color: var(--ink-2);
  }
  .diagram--busy svg {
    opacity: 0.55;
    transition: opacity 200ms var(--ease-out);
  }

  /*
   * Reduced motion, not reduced meaning.
   *
   * The apply moment is the one acknowledgement this window owes its owner, so
   * it is *substituted*, never deleted: the repaired conductor and its terminal
   * still land in 検印緑 and settle to ink, they simply do it by changing colour
   * on a step instead of travelling. The marching ants stop but the dash pattern
   * that carries "pending" stays. The survey sweep is pure decoration — the
   * skeleton's own label says 走査中 — so that one really does go.
   */
  @media (prefers-reduced-motion: reduce) {
    .wire.is-pending .wire__line {
      animation: none;
    }

    .wire.is-reconnected .wire__line {
      stroke-dasharray: none;
      stroke-dashoffset: 0;
      animation: seat-still 620ms steps(1, end) var(--delay) both;
    }

    @keyframes seat-still {
      from {
        stroke: var(--pass);
        stroke-width: 2.4;
      }
      to {
        stroke: var(--ink);
        stroke-width: 1.2;
      }
    }

    .pin__core--fresh {
      animation: contact-still 520ms steps(1, end) both;
    }

    @keyframes contact-still {
      from {
        r: 3.2;
        fill: var(--pass);
      }
      to {
        r: 1.6;
        fill: var(--ink);
      }
    }

    .sweep {
      animation: none;
      visibility: hidden;
    }
  }
</style>
