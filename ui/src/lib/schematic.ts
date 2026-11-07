/**
 * The wiring diagram, computed.
 *
 * Everything the drawing shows is derived here, as plain data, from the three
 * read-only engine payloads (`inventory`, `doctor`, `plan`). The Svelte
 * component that renders it holds no opinions of its own — no defaults, no
 * "probably fine", no smoothing of a state the engine reported (PRODUCT
 * Principle 2 and 3). If a conductor is drawn as connected, an adapter said so.
 *
 * Coordinates are in a fixed user-unit space (`SHEET`) that the SVG viewBox
 * scales; a drawing that scales as a whole is how a real sheet behaves, and it
 * keeps every rule weight and terminal in proportion.
 */

import type {
  Doctor,
  Finding,
  Inventory,
  InventoryTarget,
  Plan,
  PlanAction,
  TargetId,
} from "./contract.js";
import { isUnsupported } from "./contract.js";
import { actionNote } from "./notes.js";

/* ------------------------------------------------------------------ */
/* Sheet geometry                                                      */
/* ------------------------------------------------------------------ */

/*
 * The sheet is *drawn to fit its contents*, not to a fixed frame.
 *
 * A drafter adds a row and the sheet gets taller; nothing on a real drawing
 * slides underneath the row below it. So every y here is derived from the number
 * of skills the source actually holds — the block heights, the divider between
 * the skill rows and the mcp/agents outlets, the target pin strips, the junction
 * bundle and the overall sheet height all follow from one count. Adding a sixth
 * skill to `~/.agents/skills` is the routine operation this tool exists for; it
 * must not make the drawing collide with itself.
 *
 * The sheet is laid out for a reference count of five skills, near 2.6:1:
 * wide enough that conductors get long runs and the
 * break symbols get room, short enough that the inspection stamp still shares
 * the screen. Past that count the sheet grows downward and the panel scrolls,
 * because a legible drawing you scroll beats a complete one you cannot read.
 */
const SHEET_W = 1560;

/** Skill count the placeholder sheet (and its reference proportion) is drawn at. */
const REFERENCE_SKILLS = 5;

const SRC_X = 48;
const SRC_Y = 68;
const SRC_W = 340;
/** Source header (root paths) down to the rule above the skill list. */
const SRC_HEAD_H = 128;
const SRC_ROW_GAP = 22;
/** Rule below the last skill row, then the two single outlets under it. */
const SRC_DIVIDER_DROP = 12;
const SRC_MCP_DROP = 22;
const SRC_AGENT_DROP = 24;
const SRC_FOOT = 22;

const JUNCTION_X = 700;
const JUNCTION_W = 40;
const BUNDLE_GAP = 12;

const TGT_X = 1140;
const TGT_W = 372;
/** Target pin strips are pitched tighter than the source's row list. */
const TGT_ROW_GAP = 19;

/**
 * Top of a target block down to its first pin row — the block title, the note
 * beside it and the rule under both. Every row on every block clears this, or
 * the row is drawn *through* the title.
 */
const OWNED_SKILL_Y0 = 56;
const OWNED_MCP_DROP = 20;
const OWNED_AGENT_DROP = 18;
const OWNED_FOOT = 18;

/*
 * The two shared blocks (SPEC §4) carry three rows instead of a pin strip, and
 * they used to be given their own hand-set offsets — 24 / 42 / 58 in a 68-tall
 * box. Those were measured against nothing: 24 put the skills row on top of the
 * block title at 26 (and its right-hand note on top of the target's own note),
 * and the remaining two rows sat at a 16 pitch inside a header the drawing
 * finishes at 38. They are derived here from the same header, pitch and foot
 * the tall blocks use, so a three-row block is a two-row block's arithmetic
 * with one fewer row rather than a separate guess.
 */
const SHARED_SKILL_Y = OWNED_SKILL_Y0;
const SHARED_MCP_Y = SHARED_SKILL_Y + OWNED_MCP_DROP;
const SHARED_AGENT_Y = SHARED_MCP_Y + OWNED_AGENT_DROP;
const SHARED_BOX_H = SHARED_AGENT_Y + OWNED_FOOT;

/** Vertical rule between two target blocks. */
const BOX_GAP = 12;
const FIRST_BOX_TOP = 24;
/** Clear space under the lowest block, so the frame never touches it. */
const SHEET_FOOT = 24;

const LEGEND_H = 140;
const LEGEND_GAP = 8;
const LEGEND_ROW0 = 44;
const LEGEND_ROW_GAP = 24;

interface TargetBox {
  id: TargetId;
  top: number;
  height: number;
  /** Targets that materialize their own skill directory get a pin strip. */
  ownsSkills: boolean;
  /** Offsets of the two single outlets, relative to `top`. */
  mcpY: number;
  agentY: number;
}

export interface SheetGeometry {
  sheet: { w: number; h: number };
  source: { x: number; y: number; w: number; h: number };
  skillY0: number;
  skillRowGap: number;
  /** Rule closing the skill list, above the two single outlets. */
  srcDividerY: number;
  srcMcpY: number;
  srcAgentY: number;
  junction: { x: number; w: number };
  targetX: number;
  targetW: number;
  targetRowGap: number;
  boxes: readonly TargetBox[];
  legend: { x: number; y: number; w: number; h: number; rowY: number[] };
  empty: { x: number; y: number; w: number; h: number };
}

/** Height of one target block, given how many pin rows it has to carry. */
function ownedBoxHeight(rows: number): number {
  return ownedAgentY(rows) + OWNED_FOOT;
}

function ownedMcpY(rows: number): number {
  const lastRow = rows > 0 ? OWNED_SKILL_Y0 + (rows - 1) * TGT_ROW_GAP : OWNED_SKILL_Y0 - TGT_ROW_GAP;
  return lastRow + OWNED_MCP_DROP;
}

function ownedAgentY(rows: number): number {
  return ownedMcpY(rows) + OWNED_AGENT_DROP;
}

/**
 * Every coordinate on the sheet, for a source holding `skillCount` skills.
 *
 * Pure arithmetic on one number — which is what makes the "does row 6 land on
 * the mcp terminal?" question a unit test rather than a screenshot.
 */
export function geometry(skillCount: number): SheetGeometry {
  const rows = Math.max(0, skillCount);

  const skillY0 = SRC_Y + SRC_HEAD_H;
  const lastSkillY = rows > 0 ? skillY0 + (rows - 1) * SRC_ROW_GAP : skillY0 - SRC_ROW_GAP;
  const srcDividerY = lastSkillY + SRC_DIVIDER_DROP;
  const srcMcpY = srcDividerY + SRC_MCP_DROP;
  const srcAgentY = srcMcpY + SRC_AGENT_DROP;
  const srcH = srcAgentY + SRC_FOOT - SRC_Y;

  const ownedH = ownedBoxHeight(rows);
  const claudeTop = FIRST_BOX_TOP;
  const copilotTop = claudeTop + ownedH + BOX_GAP;
  const vscodeTop = copilotTop + ownedH + BOX_GAP;
  const vs2026Top = vscodeTop + SHARED_BOX_H + BOX_GAP;

  const boxes: readonly TargetBox[] = [
    {
      id: "claude",
      top: claudeTop,
      height: ownedH,
      ownsSkills: true,
      mcpY: ownedMcpY(rows),
      agentY: ownedAgentY(rows),
    },
    {
      id: "copilot-cli",
      top: copilotTop,
      height: ownedH,
      ownsSkills: true,
      mcpY: ownedMcpY(rows),
      agentY: ownedAgentY(rows),
    },
    // SPEC §4: these two carry no skill directory of their own, so their blocks
    // need no pin strip and stay short.
    {
      id: "vscode",
      top: vscodeTop,
      height: SHARED_BOX_H,
      ownsSkills: false,
      mcpY: SHARED_MCP_Y,
      agentY: SHARED_AGENT_Y,
    },
    {
      id: "vs2026",
      top: vs2026Top,
      height: SHARED_BOX_H,
      ownsSkills: false,
      mcpY: SHARED_MCP_Y,
      agentY: SHARED_AGENT_Y,
    },
  ];

  const legendY = SRC_Y + srcH + LEGEND_GAP;
  const legend = {
    x: SRC_X,
    y: legendY,
    w: SRC_W,
    h: LEGEND_H,
    rowY: [0, 1, 2, 3].map((i) => legendY + LEGEND_ROW0 + i * LEGEND_ROW_GAP),
  };

  const sheetH = Math.max(
    vs2026Top + SHARED_BOX_H + SHEET_FOOT,
    legendY + LEGEND_H + SHEET_FOOT,
  );

  return {
    sheet: { w: SHEET_W, h: sheetH },
    source: { x: SRC_X, y: SRC_Y, w: SRC_W, h: srcH },
    skillY0,
    skillRowGap: SRC_ROW_GAP,
    srcDividerY,
    srcMcpY,
    srcAgentY,
    junction: { x: JUNCTION_X, w: JUNCTION_W },
    targetX: TGT_X,
    targetW: TGT_W,
    targetRowGap: TGT_ROW_GAP,
    boxes,
    legend,
    empty: { x: 510, y: Math.round(sheetH / 2) - 98, w: 520, h: 150 },
  };
}

/**
 * The sheet drawn before any reading exists — the skeleton and the frame it
 * shares with a measured drawing.
 */
export const LAYOUT: SheetGeometry = geometry(REFERENCE_SKILLS);

export const SHEET = LAYOUT.sheet;

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/**
 * The condition of one conductor.
 *
 *  - `linked`   — a link in the target resolves to the source. Healthy.
 *  - `severed`  — the target holds its own physical copy, or a dangling link.
 *                 The single source is not actually feeding it.
 *  - `blocked`  — a physical copy whose content diverged. `apply` refuses to
 *                 touch it (SPEC §6.6); a human has to decide.
 *  - `unwired`  — nothing occupies the slot at all.
 */
export type WireState = "linked" | "severed" | "blocked" | "unwired";

export const WIRE_STATE_LABEL: Record<WireState, string> = {
  linked: "結線",
  severed: "断線・実体二重",
  blocked: "断線・要手当て",
  unwired: "未結線",
};

export const ACTION_KIND_LABEL: Record<PlanAction["kind"], string> = {
  create: "新規",
  update: "更新",
  delete: "削除",
  link: "結線",
  drift: "要手当て",
  // SPEC §5: kept on purpose, not removed. The label has to say "kept", because
  // this row previously read 「削除」 for an asset nothing was going to delete.
  preserve: "保全",
  unsupported: "非対応",
};

export const TARGET_NOTE: Record<TargetId, string> = {
  claude: "Claude Code",
  "copilot-cli": "GitHub Copilot CLI",
  vscode: "VS Code Copilot",
  vs2026: "Visual Studio 2026",
  opencode: "opencode",
};

/**
 * What the sheet says about the targets it does not draw.
 *
 * One sentence, one place, used by both the visible note and the drawing's text
 * equivalent — the two must not be able to drift apart, because the whole point
 * of the note is that the picture is incomplete and says so.
 */
export function omittedTargetsNote(ids: readonly TargetId[]): string {
  return `この図は ${ids.join(" / ")} を描いていません。図の縮尺は4ブロックで確定しているため、追加ターゲットの状態は一覧タブと詳細ペインで確認してください。`;
}

/* ------------------------------------------------------------------ */
/* Shapes handed to the renderer                                       */
/* ------------------------------------------------------------------ */

export interface Point {
  x: number;
  y: number;
}

/** One skill, as a row in the source block and a strand in the cable. */
export interface Strand {
  /** 1-based conductor number, printed at both ends like a real drawing. */
  no: number;
  name: string;
  hasSkillMd: boolean;
  pin: Point;
  bundle: Point;
  /** Source pin → junction box. */
  d: string;
}

/** One skill on one target: the segment that can actually be broken. */
export interface Wire {
  id: string;
  no: number;
  name: string;
  target: TargetId;
  state: WireState;
  /** A plan action touches this conductor. */
  pending: boolean;
  /** Revision index printed in the triangle flag, 1-based. */
  revision: number | null;
  d: string;
  /** Length of `d`, so the reconnect motion can dash it exactly. */
  length: number;
  /** Where the break glyph sits, for `severed` / `blocked`. */
  mid: Point;
  end: Point;
  path: string;
  detail: string;
}

/**
 * `unknown` exists for SPEC §9.4's last line: with no plan, 「差分あり」 cannot
 * be ruled out, so 「一致」 cannot be asserted. The map view draws the terminal
 * as un-measured rather than as sound.
 */
export type TerminalState = "match" | "unsupported" | "shared" | "action" | "unknown";

export interface Terminal {
  key: string;
  target: TargetId;
  asset: "mcp" | "agent" | "skill";
  at: Point;
  state: TerminalState;
  label: string;
  note: string;
}

export interface TargetPanel {
  id: TargetId;
  name: string;
  note: string;
  enabled: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  ownsSkills: boolean;
  skillsDir: string;
  /** Set when the target reads another target's directories (SPEC §4). */
  sharesDiscoveryWith: TargetId | null;
  pins: { no: number; name: string; at: Point; state: WireState }[];
  terminals: Terminal[];
  /** Number of plan actions aimed at this target — drives the revision cloud. */
  revisions: number;
}

export interface SourcePanel {
  x: number;
  y: number;
  w: number;
  h: number;
  root: string;
  skillsRoot: string;
  manifestPresent: boolean;
  linkMode: string;
  mcpCount: number;
  agentCount: number;
  mcpPin: Point;
  agentPin: Point;
}

export interface Schematic {
  /** Every coordinate this sheet was drawn with, derived from the skill count. */
  geometry: SheetGeometry;
  source: SourcePanel;
  strands: Strand[];
  wires: Wire[];
  targets: TargetPanel[];
  junction: { x: number; y: number; w: number; h: number };
  /** Dashed taps for targets that read the source directories directly. */
  sharedTaps: { id: TargetId; d: string; end: Point }[];
  /**
   * Targets the inventory reports that this sheet does not draw.
   *
   * The sheet's proportion is set for four blocks (see `geometry`), and
   * `opencode` arrived after it (SPEC §10). Rather than quietly drawing four
   * targets under a caption that says 「全ターゲット」, the omission is data the
   * drawing carries and states — the map is a demoted overview, and an overview
   * that silently drops a target is worse than one that admits its scope.
   */
  omittedTargets: TargetId[];
  /** True when the source holds nothing at all — `am import` has not run. */
  sourceEmpty: boolean;
  counts: Record<WireState, number>;
}

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

const SKILLS_ROOT_FALLBACK = "~/.agents/skills";

export function buildSchematic(
  inventory: Inventory,
  doctor: Doctor | null,
  plan: Plan | null,
): Schematic {
  const skills = inventory.source.skills;
  const g = geometry(skills.length);
  const srcPinX = g.source.x + g.source.w;
  const bundleCenter = g.skillY0 + ((skills.length - 1) * g.skillRowGap) / 2;
  // One numbering for the whole sheet: the plan's own order (see
  // `revisionNumbers`), so a triangle flag and a 変更票 row with the same digit
  // are the same change.
  const revisions = revisionNumbers(plan?.actions ?? []);

  const strands: Strand[] = skills.map((skill, i) => {
    const pin = { x: srcPinX, y: g.skillY0 + i * g.skillRowGap };
    const bundle = {
      x: g.junction.x,
      y: bundleCenter + (i - (skills.length - 1) / 2) * BUNDLE_GAP,
    };
    return {
      no: i + 1,
      name: skill.name,
      hasSkillMd: skill.hasSkillMd,
      pin,
      bundle,
      d: cubic(pin, bundle, 0.55),
    };
  });

  const wires: Wire[] = [];
  const targets: TargetPanel[] = [];
  const sharedTaps: { id: TargetId; d: string; end: Point }[] = [];

  const skillsRoot = discoverSkillsRoot(inventory);

  for (const box of g.boxes) {
    const target = inventory.targets.find((t) => t.id === box.id);
    if (target === undefined) continue;

    const panel: TargetPanel = {
      id: box.id,
      name: box.id,
      note: TARGET_NOTE[box.id],
      enabled: target.enabled,
      x: g.targetX,
      y: box.top,
      w: g.targetW,
      h: box.height,
      ownsSkills: box.ownsSkills,
      skillsDir: isUnsupported(target.skillsDir) ? "unsupported" : target.skillsDir,
      sharesDiscoveryWith: target.sharesDiscoveryWith ?? null,
      pins: [],
      terminals: [],
      revisions: 0,
    };

    if (box.ownsSkills) {
      strands.forEach((strand, i) => {
        const at = { x: g.targetX, y: box.top + OWNED_SKILL_Y0 + i * g.targetRowGap };
        const state = wireState(strand.name, target, doctor, plan);
        const action = actionFor(plan, box.id, "skill", strand.name);
        const pending = action !== null;
        if (pending) panel.revisions += 1;
        const revision = revisions.get(revisionKey(box.id, "skill", strand.name)) ?? null;
        const start = { x: g.junction.x + g.junction.w, y: strand.bundle.y };
        const d = cubic(start, at, 0.5);
        wires.push({
          id: `${box.id}:${strand.name}`,
          no: strand.no,
          name: strand.name,
          target: box.id,
          state,
          pending,
          revision,
          d,
          length: cubicLength(start, at, 0.5),
          mid: cubicAt(start, at, 0.5, 0.5),
          end: at,
          path: action?.path ?? `${panel.skillsDir}\\${strand.name}`,
          detail: action === null ? "" : (actionNote(action) ?? action.detail),
        });
        panel.pins.push({ no: strand.no, name: strand.name, at, state });
      });
    } else {
      // SPEC §4: these targets discover the source directories themselves, so
      // there is nothing to wire and nothing that can break.
      const end = { x: g.targetX, y: box.top + SHARED_SKILL_Y };
      sharedTaps.push({
        id: box.id,
        d: cubic({ x: g.junction.x + g.junction.w, y: bundleCenter + 44 }, end, 0.45),
        end,
      });
      panel.terminals.push({
        key: `${box.id}:skill`,
        target: box.id,
        asset: "skill",
        at: end,
        state: "shared",
        label: "skills",
        note: "発見パス共有 — 作業不要",
      });
    }

    panel.terminals.push(
      assetTerminal(
        target,
        "mcp",
        { x: g.targetX, y: box.top + box.mcpY },
        inventory.source.mcp.length,
        plan,
      ),
      assetTerminal(
        target,
        "agent",
        { x: g.targetX, y: box.top + box.agentY },
        inventory.source.agents.length,
        plan,
      ),
    );

    targets.push(panel);
  }

  const counts: Record<WireState, number> = { linked: 0, severed: 0, blocked: 0, unwired: 0 };
  for (const wire of wires) counts[wire.state] += 1;

  return {
    geometry: g,
    source: {
      x: g.source.x,
      y: g.source.y,
      w: g.source.w,
      h: g.source.h,
      root: inventory.source.root,
      skillsRoot,
      manifestPresent: inventory.source.manifestPresent,
      linkMode: inventory.source.linkMode,
      mcpCount: inventory.source.mcp.length,
      agentCount: inventory.source.agents.length,
      mcpPin: { x: srcPinX, y: g.srcMcpY },
      agentPin: { x: srcPinX, y: g.srcAgentY },
    },
    strands,
    wires,
    targets,
    junction: {
      x: g.junction.x,
      y: bundleCenter - ((strands.length - 1) * BUNDLE_GAP) / 2 - 14,
      w: g.junction.w,
      h: (strands.length - 1) * BUNDLE_GAP + 28,
    },
    sharedTaps,
    omittedTargets: inventory.targets
      .map((t) => t.id)
      .filter((id) => !g.boxes.some((box) => box.id === id)),
    sourceEmpty:
      inventory.source.skills.length === 0 &&
      inventory.source.mcp.length === 0 &&
      inventory.source.agents.length === 0 &&
      inventory.source.commands.length === 0,
    counts,
  };
}

/* ------------------------------------------------------------------ */
/* Revision numbering                                                  */
/* ------------------------------------------------------------------ */

/** Identity of the change a revision number belongs to. */
export function revisionKey(
  target: TargetId,
  assetType: PlanAction["assetType"],
  asset: string,
): string {
  return `${target}:${assetType}:${asset}`;
}

/**
 * Number the changes, once, from the engine's own ordering.
 *
 * The triangle flag on a conductor and the row number in 変更票 are the same
 * digit or they are worse than no digit at all — the owner reads the flag,
 * looks up the row, and confirms a write against it. So neither view is allowed
 * to invent its own sequence: both call this with the same action list, and the
 * list is the one the engine sorted (`src/core/diff.ts` `sortActions`:
 * target → asset → kind → path), which is *not* alphabetical by skill name.
 *
 * Only the conductors the drawing can flag are numbered — a skill row on a
 * target — which is why `unsupported` and the file-backed assets get no number
 * in either place.
 */
export function revisionNumbers(
  actions: readonly { kind: PlanAction["kind"]; target: TargetId; assetType: PlanAction["assetType"]; asset: string }[],
): Map<string, number> {
  const numbers = new Map<string, number>();
  let no = 0;
  for (const action of actions) {
    if (action.kind === "unsupported" || action.assetType !== "skill") continue;
    no += 1;
    const key = revisionKey(action.target, action.assetType, action.asset);
    // First occurrence wins: a duplicate key would be the same conductor twice.
    if (!numbers.has(key)) numbers.set(key, no);
  }
  return numbers;
}

/* ------------------------------------------------------------------ */
/* State derivation                                                    */
/* ------------------------------------------------------------------ */

/**
 * `inventory` says what physically occupies the slot; `doctor` and `plan` say
 * whether a physical copy is a harmless duplicate or a genuine divergence. Both
 * are consulted because the first is available the moment the window opens and
 * the second only after the user asks for a difference.
 */
function wireState(
  name: string,
  target: InventoryTarget,
  doctor: Doctor | null,
  plan: Plan | null,
): WireState {
  if (actionFor(plan, target.id, "skill", name)?.kind === "drift") return "blocked";
  if (findingFor(doctor, target.id, name, ["skill.drift", "skill.file-in-slot"]) !== null) {
    return "blocked";
  }

  const skills = target.skills;
  if (isUnsupported(skills)) return "unwired";
  const entry = skills.find((s) => s.name === name);
  if (entry === undefined) return "unwired";

  switch (entry.kind) {
    case "junction":
    case "symlink":
      // A link that resolves somewhere other than the source is a break wearing
      // a link's costume; doctor reports it as `skill.link-elsewhere`.
      return findingFor(doctor, target.id, name, ["skill.link-elsewhere"]) !== null
        ? "severed"
        : "linked";
    case "directory":
    case "broken":
      return "severed";
    case "file":
      return "blocked";
    /*
     * SPEC §9.7 — not `unwired`. 「未結線」 is a measured absence, and this is a
     * slot we were refused; the map would otherwise draw a clean open terminal
     * over something that may well be connected. `blocked` is what the drawing
     * already means by 「ここから先は進めない」, and `plan` agrees: an unreadable
     * slot is reported as drift, which `apply` refuses.
     */
    case "unreadable":
      return "blocked";
    case "missing":
      return "unwired";
  }
}

function findingFor(
  doctor: Doctor | null,
  target: TargetId,
  asset: string,
  codes: readonly string[],
): Finding | null {
  if (doctor === null) return null;
  return (
    doctor.findings.find(
      (f) => f.target === target && f.asset === asset && codes.includes(f.code),
    ) ?? null
  );
}

function actionFor(
  plan: Plan | null,
  target: TargetId,
  assetType: PlanAction["assetType"],
  asset: string,
): PlanAction | null {
  if (plan === null) return null;
  return (
    plan.actions.find(
      (a) => a.target === target && a.assetType === assetType && a.asset === asset,
    ) ?? null
  );
}

function assetTerminal(
  target: InventoryTarget,
  asset: "mcp" | "agent",
  at: Point,
  sourceCount: number,
  plan: Plan | null,
): Terminal {
  const held = asset === "mcp" ? target.mcp : target.agents;
  const label = asset === "mcp" ? "mcp" : "agents";

  if (isUnsupported(held)) {
    return {
      key: `${target.id}:${asset}`,
      target: target.id,
      asset,
      at,
      state: "unsupported",
      label,
      note: "非対応 — 公式仕様が未確定",
    };
  }

  // SPEC §9.4: no plan, no verdict. This branch is the one the skills side of
  // the diagram never needed (its state comes from inventory alone) and the one
  // this side used to skip — drawing 「0 件 — 一致」 over three undelivered
  // servers, which is a measurement nobody took.
  if (plan === null) {
    return {
      key: `${target.id}:${asset}`,
      target: target.id,
      asset,
      at,
      state: "unknown",
      label,
      note: `${held.length} 件 — PLAN 未取得`,
    };
  }

  const pending = plan.actions.some(
    (a) => a.target === target.id && a.assetType === asset && a.kind !== "preserve" && a.kind !== "unsupported",
  );
  if (pending) {
    return {
      key: `${target.id}:${asset}`,
      target: target.id,
      asset,
      at,
      state: "action",
      label,
      note: `${held.length} 件 — 差分あり`,
    };
  }

  if (target.sharesDiscoveryWith !== undefined && asset === "agent") {
    return {
      key: `${target.id}:${asset}`,
      target: target.id,
      asset,
      at,
      state: "shared",
      label,
      note: `発見パス共有(${target.sharesDiscoveryWith})`,
    };
  }

  // SPEC §10.3: opencode carries a per-server switch this tool preserves rather
  // than flips, so "delivered" and "will run" are not the same statement. The
  // table says so per row; the map has one terminal for the whole kind, so it
  // says so as a count. Drawing a plain 「一致」 over a server opencode will not
  // start is the same untruth in a smaller font.
  const switchedOff =
    asset === "mcp" ? held.filter((entry) => "enabled" in entry && entry.enabled === false).length : 0;

  return {
    key: `${target.id}:${asset}`,
    target: target.id,
    asset,
    at,
    state: "match",
    label,
    // "0 件" is drawn as an open terminal, not as blank space: an empty circuit
    // is a fact about the machine and has to look like one (PRODUCT Principle 3).
    note:
      sourceCount === 0 && held.length === 0
        ? "0 件 — 開放"
        : switchedOff > 0
          ? `${held.length} 件 — 一致(うち ${switchedOff} 件はターゲット側で無効)`
          : `${held.length} 件 — 一致`,
  };
}

function discoverSkillsRoot(inventory: Inventory): string {
  for (const target of inventory.targets) {
    if (target.sharesDiscoveryWith === undefined) continue;
    if (isUnsupported(target.skillsDir)) continue;
    return target.skillsDir;
  }
  return SKILLS_ROOT_FALLBACK;
}

/* ------------------------------------------------------------------ */
/* Path helpers                                                        */
/* ------------------------------------------------------------------ */

/** A horizontal-tangent cubic between two pins, the way a routed cable bends. */
function cubic(from: Point, to: Point, tension: number): string {
  const dx = (to.x - from.x) * tension;
  return `M ${r(from.x)} ${r(from.y)} C ${r(from.x + dx)} ${r(from.y)}, ${r(to.x - dx)} ${r(to.y)}, ${r(to.x)} ${r(to.y)}`;
}

/** Point on that cubic at parameter `t`. */
function cubicAt(from: Point, to: Point, tension: number, t: number): Point {
  const dx = (to.x - from.x) * tension;
  const p1 = { x: from.x + dx, y: from.y };
  const p2 = { x: to.x - dx, y: to.y };
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * from.x + b * p1.x + c * p2.x + d * to.x,
    y: a * from.y + b * p1.y + c * p2.y + d * to.y,
  };
}

/**
 * Polyline approximation of the cubic's arc length. The reconnect motion draws
 * each conductor with `stroke-dasharray`, which needs a number up front;
 * `getTotalLength()` would mean measuring in the DOM before the first paint.
 */
function cubicLength(from: Point, to: Point, tension: number, steps = 24): number {
  let total = 0;
  let prev = from;
  for (let i = 1; i <= steps; i += 1) {
    const point = cubicAt(from, to, tension, i / steps);
    total += Math.hypot(point.x - prev.x, point.y - prev.y);
    prev = point;
  }
  return Math.ceil(total);
}

function r(value: number): number {
  return Math.round(value * 10) / 10;
}
