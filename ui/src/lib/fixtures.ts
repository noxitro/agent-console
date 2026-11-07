/**
 * A fake machine, for developing the GUI without the agent-console server.
 *
 * The served UI talks to the real engine through `POST /api/run`. That needs a
 * running server with a built engine, which is not always available (and is slow to iterate
 * against), so `engine.ts` falls back to this module whenever the page was not
 * served by the agent-console server — `npm run dev` from Vite gets a complete, moving
 * environment instead of a wall of errors.
 *
 * **This is a transport, not a second engine.** It answers on the same wire as
 * `am ... --json`: one JSON object on stdout, the SPEC §5 exit codes (0 / 1 /
 * 2), and the same refusals — `drift` still aborts `apply` with exit 2 and a
 * message on stderr. Nothing downstream of the transport knows the difference,
 * which is the point: the layout, the states and the failure paths are exercised
 * for real (PRODUCT: "CLI と GUI は同じ真実" — the fixture may not be the one
 * place where the GUI learns to disagree).
 *
 * The default scenario is a made-up, partly wired machine: seven skills, one of
 * them (`api-docs`) duplicated as a physical copy under `~/.copilot/skills`,
 * one linked by a symlink instead of a junction, and claude not wired up at
 * all. Every name, path, version, date and count in this file is invented and
 * corresponds to no real machine. `?fixture=<id>` selects the other scenarios.
 *
 * It covers all five targets and all four asset kinds, because every tab and
 * every narrowing has to be reachable with `npm run dev` alone — including the states that only exist as refusals: opencode
 * answering `unsupported` for skills and agents with the engine's own reason
 * (SPEC §10.4), the other four answering `unsupported` for commands, and a
 * command whose frontmatter names no agent so the second column has to draw
 * 「—」.
 */

import { isExecutableAction } from "./contract.js";
import type {
  Apply,
  AppliedAction,
  AssetType,
  ExcludeResult,
  RemoveResult,
  Doctor,
  Finding,
  Import,
  Inventory,
  InventoryTarget,
  Plan,
  PlanAction,
  SkillLinkKind,
  SourceAgent,
  SourceCommand,
  SourceMcp,
  TargetCommand,
  TargetId,
  TargetMcp,
  TargetSkill,
  UnsupportedReason,
} from "./contract.js";
import type { AmOutput, EngineTransport } from "./transport.js";

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

const HOME = "C:\\home\\user";
const SOURCE_ROOT = `${HOME}\\.agents-manager`;
const SKILLS_ROOT = `${HOME}\\.agents\\skills`;

const PATHS = {
  claudeSkills: `${HOME}\\.claude\\skills`,
  claudeMcp: `${HOME}\\.claude.json`,
  claudeAgents: `${HOME}\\.claude\\agents`,
  copilotSkills: `${HOME}\\.copilot\\skills`,
  copilotMcp: `${HOME}\\.copilot\\mcp-config.json`,
  copilotAgents: `${HOME}\\.copilot\\agents`,
  vscodeMcp: `${HOME}\\AppData\\Roaming\\Code\\User\\mcp.json`,
  vs2026Agents: `${HOME}\\.github\\agents`,
  // SPEC §10.1: `~/.config/opencode` on Windows too, not %APPDATA%.
  opencodeConfig: `${HOME}\\.config\\opencode\\opencode.jsonc`,
  opencodeCommands: `${HOME}\\.config\\opencode\\command`,
  opencodeAgents: `${HOME}\\.config\\opencode\\agent`,
} as const;

/** The seven skills the fake `~/.agents/skills` holds. */
const SKILLS = [
  "commit-message",
  "test-runner",
  "api-docs",
  "sql-format",
  "release-notes",
  "changelog",
  "translate",
] as const;

/** Targets that materialize skills into a directory of their own (SPEC §4). */
const SKILL_TARGETS: readonly TargetId[] = ["claude", "copilot-cli"];

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

export const SCENARIOS = {
  /** A typical, partly wired machine. The default. */
  machine: "標準(skill 7 件・copilot-cli に重複コピー 1 件・claude 未結線)",
  /** Everything wired, doctor clean — the state `apply` is aiming at. */
  clean: "整備済み(差分ゼロ・所見なし)",
  /** A physical copy whose content diverged: `apply` refuses (SPEC §6.6). */
  blocked: "drift あり(apply が exit 2 で拒否)",
  /** Nothing has been imported yet. */
  empty: "ソース空(am import 前)",
  /** The engine dies on a parse failure (SPEC §6.3). */
  fault: "エンジン異常(JSON パース失敗 / exit 2)",
  /** The default scenario, but every command takes its time. */
  slow: "標準(応答が遅い — 読込中表示の確認用)",
} as const;

export type ScenarioId = keyof typeof SCENARIOS;

export function isScenarioId(value: string): value is ScenarioId {
  return Object.prototype.hasOwnProperty.call(SCENARIOS, value);
}

/* ------------------------------------------------------------------ */
/* Machine state                                                       */
/* ------------------------------------------------------------------ */

/** What occupies each skill slot, per target. Mutated by `apply`. */
type Slots = Record<string, SkillLinkKind>;

/** The two MCP servers the fake source of truth holds. */
const SOURCE_MCP: readonly { name: string; transport: string; endpoint: string }[] = [
  { name: "filesystem", transport: "stdio", endpoint: "npx" },
  { name: "docs", transport: "http", endpoint: "https://example.invalid/mcp" },
] as const;

/** The one custom agent it holds. */
const SOURCE_AGENTS: readonly { name: string; description: string; model: string }[] = [
  { name: "code-reviewer", description: "Reviews changes for correctness.", model: "sonnet" },
] as const;

/**
 * SPEC §10.2 — the source's commands.
 *
 * One names an owning agent and one does not, on purpose: the second column and
 * the detail pane both have to draw 「—」 for a command whose frontmatter omits
 * `agent`, and a fixture where every row has every field never exercises that.
 */
const SOURCE_COMMANDS: readonly { name: string; description: string; agent?: string }[] = [
  { name: "deploy-preview", description: "Build and publish a preview.", agent: "builder" },
  { name: "spec-check", description: "Re-read SPEC.md and check the diff against it." },
] as const;

/**
 * SPEC §10.4 — why opencode refuses agents.
 *
 * Abridged from `src/adapters/opencode.ts`, in the engine's own voice: this is
 * shown verbatim in the detail pane, so a fixture that paraphrased it would be
 * teaching the interface to say something the engine never said. Skills are no
 * longer on this list (SPEC §10.1, revised): opencode discovers the source
 * root directly, like vscode and vs2026 do.
 */
const OPENCODE_REASONS: readonly UnsupportedReason[] = [
  {
    assetType: "agent",
    reason:
      "agents are not managed for opencode (SPEC §10.4): its frontmatter is semantically " +
      'different — "tools" is a name→boolean map rather than an allowlist, and the "permission" ' +
      "block has no equivalent in the claude/copilot dialects — so no safe conversion exists; " +
      `the agent directory is left untouched (${PATHS.opencodeAgents})`,
  },
] as const;

/**
 * A server Claude Code registered on its own, in `~/.claude.json`.
 *
 * This is the fixture's most load-bearing detail: it is unmanaged, so every
 * plan reports it — and the *kind* it is reported as decides whether the tool
 * ever reaches a fixed point. `preserve` (kept) exits 0; `delete` (removed)
 * would exit 1 forever and put a deletion into the confirmation dialog that
 * `apply` never performs.
 */
const UNMANAGED_MCP = "their-server";

interface Machine {
  scenario: ScenarioId;
  sourceSkills: string[];
  /** Names excluded by the manifest, per kind (SPEC §9.1 / §10.5). */
  excluded: Record<AssetType, Set<string>>;
  /** Source assets that `remove` has deleted. */
  removed: Record<AssetType, Set<string>>;
  /** Which targets currently carry each source MCP server / agent / command. */
  mcpDelivered: Set<TargetId>;
  agentsDelivered: Set<TargetId>;
  commandsDelivered: Set<TargetId>;
  slots: Record<TargetId, Slots>;
  /**
   * Skills whose physical copy in a target *differs* from the source. These are
   * `drift`: the engine will not overwrite them, because the copy may hold the
   * only version of an edit (SPEC §6.6).
   */
  diverged: Set<string>;
  latencyMs: number;
  /** Set once `apply` has run, so `inventory` can report the backup. */
  lastBackup?: string;
}

function emptySlots(): Slots {
  return {};
}

function allLinked(skills: readonly string[]): Slots {
  const slots: Slots = {};
  for (const name of skills) slots[name] = "junction";
  return slots;
}

/** The physical directories a shared-discovery target sees in the source root. */
function allPhysical(skills: readonly string[]): Slots {
  const slots: Slots = {};
  for (const name of skills) slots[name] = "directory";
  return slots;
}

function newMachine(scenario: ScenarioId): Machine {
  const skills = [...SKILLS];
  const base: Machine = {
    scenario,
    sourceSkills: skills,
    excluded: { skill: new Set(), mcp: new Set(), agent: new Set(), command: new Set() },
    removed: { skill: new Set(), mcp: new Set(), agent: new Set(), command: new Set() },
    mcpDelivered: new Set<TargetId>(),
    agentsDelivered: new Set<TargetId>(),
    commandsDelivered: new Set<TargetId>(),
    slots: {
      claude: emptySlots(),
      "copilot-cli": emptySlots(),
      // SPEC §4 / §10.1 (revised): vscode and opencode discover the source root
      // itself, so every skill physically present there is one they see —
      // recorded as the real directories they are, needing no wiring (and never
      // planned). They read one directory, so they must report one listing
      // (SPEC §5); `src/adapters/skill-discovery.ts` is what makes that true in
      // the engine, and a fixture that split them would demo a state the engine
      // cannot produce.
      vscode: allPhysical(skills),
      vs2026: allPhysical(skills),
      opencode: allPhysical(skills),
    },
    diverged: new Set<string>(),
    latencyMs: 140,
  };

  switch (scenario) {
    case "clean":
      base.slots.claude = allLinked(skills);
      base.slots["copilot-cli"] = allLinked(skills);
      base.mcpDelivered = new Set<TargetId>(["claude", "copilot-cli", "vscode", "opencode"]);
      base.agentsDelivered = new Set<TargetId>(["claude", "copilot-cli", "vs2026"]);
      base.commandsDelivered = new Set<TargetId>(["opencode"]);
      break;

    case "empty":
      base.sourceSkills = [];
      base.removed = {
        skill: new Set(),
        mcp: new Set(SOURCE_MCP.map((m) => m.name)),
        agent: new Set(SOURCE_AGENTS.map((a) => a.name)),
        command: new Set(SOURCE_COMMANDS.map((c) => c.name)),
      };
      break;

    case "blocked":
      base.slots["copilot-cli"] = allLinked(skills);
      // A physical copy that has been edited in place: doctor calls it
      // `skill.drift`, plan calls it `drift`, and apply stops before it writes.
      base.slots["copilot-cli"]["api-docs"] = "directory";
      base.diverged.add("api-docs");
      base.slots.claude = emptySlots();
      break;

    case "fault":
      break;

    case "slow":
      base.latencyMs = 1500;
      base.slots["copilot-cli"] = allLinked(skills);
      base.slots["copilot-cli"]["api-docs"] = "directory";
      base.slots["copilot-cli"]["sql-format"] = "symlink";
      break;

    case "machine":
      base.slots["copilot-cli"] = allLinked(skills);
      // A duplicate that is byte-identical to the source: a warning rather than
      // an error, and `apply` can replace it with a junction.
      base.slots["copilot-cli"]["api-docs"] = "directory";
      base.slots["copilot-cli"]["sql-format"] = "symlink";
      break;
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* inventory                                                           */
/* ------------------------------------------------------------------ */

function targetSkills(machine: Machine, target: TargetId): TargetSkill[] {
  const slots = machine.slots[target];
  return machine.sourceSkills
    .map((name): TargetSkill | null => {
      const kind = slots[name];
      if (kind === undefined || kind === "missing") return null;
      if (kind === "junction" || kind === "symlink") {
        return { name, kind, dest: `${SKILLS_ROOT}\\${name}` };
      }
      return { name, kind };
    })
    .filter((entry): entry is TargetSkill => entry !== null);
}

function buildInventory(machine: Machine): Inventory {
  const targets: InventoryTarget[] = [
    {
      id: "claude",
      enabled: true,
      skillsDir: PATHS.claudeSkills,
      mcpPath: PATHS.claudeMcp,
      agentsDir: PATHS.claudeAgents,
      // SPEC §10.2: only opencode carries user-added commands. The other four
      // say so rather than reporting an empty directory.
      commandsDir: "unsupported",
      skills: targetSkills(machine, "claude"),
      mcp: targetMcp(machine, "claude"),
      agents: targetAgents(machine, "claude"),
      commands: "unsupported",
    },
    {
      id: "copilot-cli",
      enabled: true,
      skillsDir: PATHS.copilotSkills,
      mcpPath: PATHS.copilotMcp,
      agentsDir: PATHS.copilotAgents,
      commandsDir: "unsupported",
      skills: targetSkills(machine, "copilot-cli"),
      mcp: targetMcp(machine, "copilot-cli"),
      agents: targetAgents(machine, "copilot-cli"),
      commands: "unsupported",
    },
    {
      // SPEC §4: VS Code discovers the same directories rather than owning any.
      id: "vscode",
      enabled: true,
      skillsDir: SKILLS_ROOT,
      mcpPath: PATHS.vscodeMcp,
      agentsDir: PATHS.copilotAgents,
      commandsDir: "unsupported",
      skills: targetSkills(machine, "vscode"),
      mcp: targetMcp(machine, "vscode"),
      agents: targetAgents(machine, "copilot-cli"),
      commands: "unsupported",
      sharesDiscoveryWith: "copilot-cli",
    },
    {
      id: "vs2026",
      enabled: true,
      skillsDir: SKILLS_ROOT,
      // SPEC §4: no verified MCP specification exists yet; the engine says so
      // rather than reporting an empty list.
      mcpPath: "unsupported",
      agentsDir: PATHS.vs2026Agents,
      commandsDir: "unsupported",
      // SPEC §4 / §10.7: the third target that discovers skills straight from
      // the source of truth, so it reports the same listing vscode and opencode
      // do. It said `"unsupported"` here until 2026-09-04, which made the
      // fixture demonstrate the very state SPEC §5 forbids.
      skills: targetSkills(machine, "vs2026"),
      mcp: "unsupported",
      agents: targetAgents(machine, "vs2026"),
      commands: "unsupported",
      // `sharesDiscoveryWith` is deliberately absent, matching the engine
      // (`vs2026.ts` VS2026_CAPABILITIES): the word means 「何も要らない」, and
      // vs2026 really does render agents into `~/.github/agents`. The fixture
      // used to set it to "copilot-cli" — a value `am inventory --json` never
      // emits for this target, so the console was being shown a machine the
      // engine cannot produce.
    },
    {
      // SPEC §10: the fifth target. Commands and MCP carried; agents refused
      // with the engine's reason attached, because 「非対応」 without one reads
      // as a gap in this tool rather than a refusal to fake a conversion.
      // Skills are shared discovery (SPEC §10.1, revised) — the source root,
      // listed like vscode's, needing no wiring and never planned.
      id: "opencode",
      enabled: true,
      skillsDir: SKILLS_ROOT,
      mcpPath: PATHS.opencodeConfig,
      agentsDir: "unsupported",
      commandsDir: PATHS.opencodeCommands,
      skills: targetSkills(machine, "opencode"),
      mcp: targetMcp(machine, "opencode"),
      agents: "unsupported",
      commands: targetCommands(machine, "opencode"),
      unsupportedReasons: [...OPENCODE_REASONS],
    },
  ];

  return {
    source: {
      root: SOURCE_ROOT,
      manifestPresent: machine.scenario !== "empty",
      linkMode: "junction",
      skills: machine.sourceSkills.map((name) => ({
        name,
        hasSkillMd: true,
        enabled: !machine.excluded.skill.has(name),
        description: `${name} — フィクスチャの skill です(架空のデータ)。`,
        // Only one skill carries a version, so the interface has to draw 「—」
        // for the rest rather than a number.
        ...(name === "test-runner" ? { version: "0.4.2" } : {}),
        modified: "2026-01-01T00:00:00.000Z",
        ...(name === "test-runner"
          ? {
              origin: {
                source: "example-registry",
                sourceUrl: "https://example.invalid/skills/test-runner",
              },
            }
          : {}),
      })),
      mcp: sourceMcp(machine),
      agents: sourceAgents(machine),
      commands: sourceCommands(machine),
    },
    targets,
  };
}

function sourceMcp(machine: Machine): SourceMcp[] {
  return SOURCE_MCP.filter((m) => !machine.removed.mcp.has(m.name)).map((m) => ({
    name: m.name,
    transport: m.transport,
    enabled: !machine.excluded.mcp.has(m.name),
    endpoint: m.endpoint,
    modified: "2026-01-01T00:00:00.000Z",
  }));
}

function sourceAgents(machine: Machine): SourceAgent[] {
  return SOURCE_AGENTS.filter((a) => !machine.removed.agent.has(a.name)).map((a) => ({
    name: a.name,
    description: a.description,
    enabled: !machine.excluded.agent.has(a.name),
    model: a.model,
    modified: "2026-01-01T00:00:00.000Z",
  }));
}

function sourceCommands(machine: Machine): SourceCommand[] {
  return SOURCE_COMMANDS.filter((c) => !machine.removed.command.has(c.name)).map((c) => ({
    name: c.name,
    description: c.description,
    enabled: !machine.excluded.command.has(c.name),
    ...(c.agent !== undefined ? { agent: c.agent } : {}),
    modified: "2026-01-01T00:00:00.000Z",
  }));
}

/**
 * What a target's MCP config currently holds.
 *
 * SPEC §10.3: opencode carries a per-server switch of its own, and this tool
 * preserves an owner-set `false` rather than flipping it back — so a server can
 * be delivered there and still never start. The fixture models one, because a
 * state the interface has to draw and never sees in `npm run dev` is a state
 * nobody checks. Every other target omits the field: absent means 「no such
 * switch」, which is not the same statement as `true`.
 */
function targetMcp(machine: Machine, target: TargetId): TargetMcp[] {
  const switchedOffInOpencode = target === "opencode" ? "docs" : null;
  const out: TargetMcp[] = machine.mcpDelivered.has(target)
    ? sourceMcp(machine)
        .filter((m) => m.enabled)
        .map((m) => ({
          name: m.name,
          transport: m.transport,
          ...(target === "opencode" ? { enabled: m.name !== switchedOffInOpencode } : {}),
        }))
    : [];
  // Claude Code always has its own server, whatever this tool has done.
  if (target === "claude") out.push({ name: UNMANAGED_MCP, transport: "stdio" });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function targetAgents(machine: Machine, target: TargetId): { name: string }[] {
  if (!machine.agentsDelivered.has(target)) return [];
  return sourceAgents(machine)
    .filter((a) => a.enabled)
    .map((a) => ({ name: a.name }));
}

/** SPEC §10.2: `~/.config/opencode/command/<name>.md`, one file per command. */
function targetCommands(machine: Machine, target: TargetId): TargetCommand[] {
  if (!machine.commandsDelivered.has(target)) return [];
  return sourceCommands(machine)
    .filter((c) => c.enabled)
    .map((c) => ({
      name: c.name,
      description: c.description,
      ...(c.agent !== undefined ? { agent: c.agent } : {}),
    }));
}

/* ------------------------------------------------------------------ */
/* doctor                                                              */
/* ------------------------------------------------------------------ */

function buildDoctor(machine: Machine): Doctor {
  const findings: Finding[] = [];

  for (const target of SKILL_TARGETS) {
    const slots = machine.slots[target];
    for (const name of machine.sourceSkills) {
      if (slots[name] !== "directory") continue;
      const diverged = machine.diverged.has(name);
      findings.push({
        level: diverged ? "error" : "warn",
        code: diverged ? "skill.drift" : "skill.duplicate-copy",
        target,
        asset: name,
        detail: diverged
          ? `[${target}] "${name}" is a physical copy that DIFFERS from the source`
          : `[${target}] "${name}" is a physical duplicate of the source (run \`am apply\` to replace it with a junction)`,
        path: `${target === "claude" ? PATHS.claudeSkills : PATHS.copilotSkills}\\${name}`,
      });
    }
  }

  // An example of a harmless warning: a skill that uses one of Claude's
  // frontmatter extensions, which sit outside the agentskills.io six (SPEC §3).
  if (machine.sourceSkills.includes("release-notes")) {
    findings.push({
      level: "warn",
      code: "skill.non-spec-frontmatter",
      asset: "release-notes",
      detail: 'skill "release-notes": frontmatter field "argument-hint" is outside the agentskills.io schema',
      path: `${SKILLS_ROOT}\\release-notes\\SKILL.md`,
    });
  }

  return { findings };
}

/* ------------------------------------------------------------------ */
/* plan                                                                */
/* ------------------------------------------------------------------ */

function buildPlan(machine: Machine): Plan {
  const actions: PlanAction[] = [];

  for (const target of SKILL_TARGETS) {
    const dir = target === "claude" ? PATHS.claudeSkills : PATHS.copilotSkills;
    const slots = machine.slots[target];
    for (const name of machine.sourceSkills) {
      const kind = slots[name] ?? "missing";
      const path = `${dir}\\${name}`;
      if (kind === "junction" || kind === "symlink") continue;
      if (kind === "missing") {
        actions.push({
          kind: "link",
          target,
          assetType: "skill",
          asset: name,
          path,
          detail: "create junction to source skill",
        });
      } else if (kind === "broken") {
        actions.push({
          kind: "update",
          target,
          assetType: "skill",
          asset: name,
          path,
          detail: "broken link; recreate",
        });
      } else if (machine.diverged.has(name)) {
        actions.push({
          kind: "drift",
          target,
          assetType: "skill",
          asset: name,
          path,
          detail:
            "physical copy differs from source; refusing to replace it (resolve manually or re-import)",
        });
      } else {
        actions.push({
          kind: "link",
          target,
          assetType: "skill",
          asset: name,
          path,
          detail: "physical copy matches source; back up and replace with junction",
        });
      }
    }
  }

  // MCP and agents: one action per target that does not yet hold the source's
  // set. The rendered documents travel with the action so the confirmation
  // dialog can show what changes inside them (SPEC §9.6).
  const servers = sourceMcp(machine).filter((m) => m.enabled);
  const MCP_PATH: Partial<Record<TargetId, string>> = {
    claude: PATHS.claudeMcp,
    "copilot-cli": PATHS.copilotMcp,
    vscode: PATHS.vscodeMcp,
    opencode: PATHS.opencodeConfig,
  };
  for (const target of ["claude", "copilot-cli", "vscode", "opencode"] as const) {
    if (machine.mcpDelivered.has(target)) continue;
    actions.push({
      kind: target === "claude" || target === "opencode" ? "update" : "create",
      target,
      assetType: "mcp",
      asset: "",
      path: MCP_PATH[target] ?? "",
      detail: "content differs from source",
      ...(target === "claude" ? { before: claudeJsonText(machine, false) } : {}),
      // SPEC §10.3: opencode's config is JSONC and is edited surgically, so the
      // preview has to show the comments and neighbouring keys surviving. A
      // whole-file re-serialisation would silently drop them.
      ...(target === "opencode" ? { before: opencodeJsoncText(machine, false) } : {}),
      after:
        target === "claude"
          ? claudeJsonText(machine, true)
          : target === "opencode"
            ? opencodeJsoncText(machine, true)
            : mcpConfigText(servers),
    });
  }

  // SPEC §10.2: commands go to opencode and nowhere else, one file each.
  if (!machine.commandsDelivered.has("opencode")) {
    for (const command of sourceCommands(machine).filter((c) => c.enabled)) {
      actions.push({
        kind: "create",
        target: "opencode",
        assetType: "command",
        asset: command.name,
        path: `${PATHS.opencodeCommands}\\${command.name}.md`,
        detail: "not present in target",
        after: commandFileText(command),
      });
    }
  }

  const agents = sourceAgents(machine).filter((a) => a.enabled);
  for (const target of ["claude", "copilot-cli", "vs2026"] as const) {
    if (machine.agentsDelivered.has(target)) continue;
    for (const agent of agents) {
      const dir =
        target === "claude"
          ? PATHS.claudeAgents
          : target === "copilot-cli"
            ? PATHS.copilotAgents
            : PATHS.vs2026Agents;
      const ext = target === "claude" ? ".md" : ".agent.md";
      actions.push({
        kind: "create",
        target,
        assetType: "agent",
        asset: agent.name,
        // `\\` — a single escaped backslash. Written as `\$` this read as an
        // escaped dollar and put the literal text `${agent.name}` in the path
        // the confirmation dialog promises to write to.
        path: `${dir}\\${agent.name}${ext}`,
        detail: "not present in target",
        after: agentFileText(agent.name, agent.description, agent.model ?? "sonnet"),
      });
    }
  }

  /*
   * SPEC §5: the server Claude Code registered itself is *kept*, so it is a
   * `preserve` note — not a `delete`. This one line is the difference between
   * a tool that reaches its fixed point and one that reports a difference
   * forever while promising a deletion it will not perform.
   */
  actions.push({
    kind: "preserve",
    target: "claude",
    assetType: "mcp",
    asset: UNMANAGED_MCP,
    path: PATHS.claudeMcp,
    detail: `server "${UNMANAGED_MCP}" is present in the target but absent from the source; preserved (use --prune to remove)`,
  });

  // SPEC §4 / §10.4 — reported every run, never silently omitted. These are
  // notes, not work: they raise the PLAN bar's 注記 count and never its 差分.
  actions.push({
    kind: "unsupported",
    target: "vs2026",
    assetType: "mcp",
    asset: "",
    path: "",
    detail: "no verified MCP configuration format for Visual Studio 2026",
  });
  for (const reason of OPENCODE_REASONS) {
    actions.push({
      kind: "unsupported",
      target: "opencode",
      assetType: reason.assetType,
      asset: "",
      path: "",
      detail: reason.reason,
    });
  }
  for (const target of ["claude", "copilot-cli", "vscode", "vs2026"] as const) {
    actions.push({
      kind: "unsupported",
      target,
      assetType: "command",
      asset: "",
      path: "",
      detail: "commands are managed for opencode only (SPEC §10.2)",
    });
  }

  return { actions };
}

/* ---------------------- rendered documents ---------------------- */

/**
 * `~/.claude.json` as it is (and as it would be). SPEC §6.1: everything except
 * `mcpServers` is preserved structurally, which is exactly what the diff in the
 * confirmation dialog has to make visible.
 */
function claudeJsonText(machine: Machine, withSource: boolean): string {
  const mcpServers: Record<string, unknown> = {};
  if (withSource) {
    for (const server of sourceMcp(machine).filter((m) => m.enabled)) {
      mcpServers[server.name] =
        server.transport === "stdio"
          ? { type: "stdio", command: server.endpoint, args: ["-y", server.name] }
          : { type: server.transport, url: server.endpoint };
    }
  }
  mcpServers[UNMANAGED_MCP] = { type: "stdio", command: "node", args: ["their-server.js"] };
  const ordered = Object.fromEntries(Object.entries(mcpServers).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(
    { numStartups: 1, oauthAccount: { emailAddress: "user@example.invalid" }, mcpServers: ordered, projects: {} },
    null,
    2,
  )}
`;
}

function mcpConfigText(servers: readonly SourceMcp[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    mcpServers[server.name] =
      server.transport === "stdio"
        ? { type: "local", command: server.endpoint, args: ["-y", server.name], tools: ["*"] }
        : { type: server.transport, url: server.endpoint };
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}
`;
}

/**
 * `~/.config/opencode/opencode.jsonc`, before and after.
 *
 * JSONC with a comment and an unrelated key, both present on **both** sides:
 * SPEC §10.3 requires the write to be a surgical `modify()` + `applyEdits()`,
 * and the confirmation dialog's line diff is where that promise is either kept
 * visibly or broken visibly.
 *
 * The dialect is opencode's own: `type: "local"` with the executable and its
 * arguments in one `command` array, `type: "remote"` for http, and
 * `environment` rather than `env`.
 */
function opencodeJsoncText(machine: Machine, withSource: boolean): string {
  const entries = withSource
    ? sourceMcp(machine)
        .filter((m) => m.enabled)
        .map((server) =>
          server.transport === "stdio"
            ? `    "${server.name}": { "type": "local", "command": ["${server.endpoint}", "-y", "${server.name}"], "enabled": true }`
            : `    "${server.name}": { "type": "remote", "url": "${server.endpoint}", "enabled": true }`,
        )
    : [];
  const body = entries.length === 0 ? "" : `\n${entries.join(",\n")}\n  `;
  return `{
  // theme と keybinds は本ツールの管理外。外科的編集で保全される (SPEC §10.3)
  "$schema": "https://opencode.ai/config.json",
  "theme": "system",
  "mcp": {${body}}
}
`;
}

/**
 * SPEC §10.2: `name` and `targets` are stripped on the way out — opencode reads
 * `description` and `agent`, and nothing else — and the body is passed through
 * untouched, `$ARGUMENTS` included (it is opencode's notation, not ours).
 */
function commandFileText(command: SourceCommand): string {
  const agentLine = command.agent === undefined ? "" : `agent: ${command.agent}\n`;
  return `---
description: ${command.description}
${agentLine}---

$ARGUMENTS
`;
}

function agentFileText(name: string, description: string, model: string): string {
  return `---
name: ${name}
description: ${description}
model: ${model}
---

You are a meticulous reviewer.
`;
}

/* ------------------------------------------------------------------ */
/* apply                                                               */
/* ------------------------------------------------------------------ */

class WireFailure extends Error {
  constructor(
    message: string,
    readonly stderrText: string,
  ) {
    super(message);
  }
}

function runApplyOn(machine: Machine, dryRun: boolean): { report: Apply; exitCode: 0 | 1 } {
  const { actions } = buildPlan(machine);

  if (dryRun) {
    return {
      report: { applied: actions.map((a) => ({ ...a, status: "skipped" as const })) },
      exitCode: actions.some((a) => a.kind !== "unsupported") ? 1 : 0,
    };
  }

  const drift = actions.filter((a) => a.kind === "drift");
  if (drift.length > 0) {
    // SPEC §6.6 / apply.ts `assertNoDrift`: stop before the first write.
    const lines = [
      "Refusing to apply: unresolved drift.",
      ...drift.flatMap((a) => [`  [${a.target}] ${a.asset} — ${a.path}`, `      ${a.detail}`]),
    ];
    throw new WireFailure(
      "Drift detected; resolve it (or re-run `am import`) before applying. Nothing was written.",
      lines.join("\n"),
    );
  }

  // The same predicate `core/diff.ts` uses, `--prune` rule included. `preserve`
  // and `unsupported` are notes, and `delete` without `--prune` is not work —
  // so none of them is executed, and none of them was in the dialog either.
  const executable = actions.filter((a) => isExecutableAction(a));
  const applied: AppliedAction[] = actions
    .filter((a) => !executable.includes(a))
    .map((a) => ({ ...a, status: "skipped" as const }));

  if (executable.length === 0) return { report: { applied }, exitCode: 0 };

  const backup = `${SOURCE_ROOT}\\backups\\${timestamp()}`;
  machine.lastBackup = backup;
  for (const action of executable) {
    const slots = machine.slots[action.target];
    if (action.assetType === "skill") slots[action.asset] = "junction";
    if (action.assetType === "mcp") machine.mcpDelivered.add(action.target);
    if (action.assetType === "agent") machine.agentsDelivered.add(action.target);
    if (action.assetType === "command") machine.commandsDelivered.add(action.target);
    applied.push({ ...action, status: "done" });
  }
  return { report: { applied, backupDir: backup }, exitCode: 0 };
}

/* ------------------------------------------------------------------ */
/* enable / disable / remove (SPEC §9.2)                               */
/* ------------------------------------------------------------------ */

function assetNames(machine: Machine, kind: AssetType): string[] {
  switch (kind) {
    case "skill":
      return machine.sourceSkills;
    case "mcp":
      return SOURCE_MCP.filter((m) => !machine.removed.mcp.has(m.name)).map((m) => m.name);
    case "agent":
      return SOURCE_AGENTS.filter((a) => !machine.removed.agent.has(a.name)).map((a) => a.name);
    case "command":
      return SOURCE_COMMANDS.filter((c) => !machine.removed.command.has(c.name)).map((c) => c.name);
  }
}

function runExclusionOn(
  machine: Machine,
  kind: AssetType,
  name: string,
  exclude: boolean,
): ExcludeResult {
  // SPEC §9.2: an unknown name is exit 2, never a silent success.
  if (!assetNames(machine, kind).includes(name)) {
    throw new WireFailure(`No such ${kind} in the source of truth: "${name}"`, "");
  }
  const set = machine.excluded[kind];
  const changed = exclude ? !set.has(name) : set.has(name);
  if (exclude) set.add(name);
  else set.delete(name);
  return {
    changed,
    manifestPath: `${SOURCE_ROOT}\\manifest.json`,
    excluded: [...set].sort(),
    ...(changed ? { backupDir: `${SOURCE_ROOT}\\backups\\${timestamp()}` } : {}),
  };
}

function runRemoveOn(machine: Machine, kind: AssetType, name: string): RemoveResult {
  if (!assetNames(machine, kind).includes(name)) {
    throw new WireFailure(`No such ${kind} in the source of truth: "${name}"`, "");
  }
  const path =
    kind === "skill"
      ? `${SKILLS_ROOT}\\${name}`
      : kind === "mcp"
        ? `${SOURCE_ROOT}\\mcp\\servers.json`
        : kind === "agent"
          ? `${SOURCE_ROOT}\\agents\\${name}.md`
          : `${SOURCE_ROOT}\\commands\\${name}.md`;

  if (kind === "skill") machine.sourceSkills = machine.sourceSkills.filter((s) => s !== name);
  else machine.removed[kind].add(name);
  machine.excluded[kind].delete(name);

  return {
    removed: [{ assetType: kind, asset: name, path }],
    backupDir: `${SOURCE_ROOT}\\backups\\${timestamp()}`,
  };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

/* ------------------------------------------------------------------ */
/* import                                                              */
/* ------------------------------------------------------------------ */

function runImportOn(machine: Machine): Import {
  if (machine.sourceSkills.length > 0) {
    return { imported: [], conflicts: [], rejected: [], notes: [] };
  }
  machine.sourceSkills = [...SKILLS];
  return {
    imported: machine.sourceSkills.map((name) => ({
      assetType: "skill" as const,
      asset: name,
      from: `${PATHS.claudeSkills}\\${name}`,
    })),
    conflicts: [],
    rejected: [],
    // SPEC §10.3: a remote server taken from opencode would arrive here with a
    // note saying its http/sse distinction could not be recovered.
    notes: [],
  };
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

function ok(payload: unknown, code: 0 | 1 = 0): AmOutput {
  return { stdout: JSON.stringify(payload), stderr: "", code };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Build a transport backed by an in-memory machine. State persists across
 * calls, so `apply` really does change what the next `plan` reports — the
 * before/after of the wiring is genuine, not a canned animation.
 */
export function fixtureTransport(
  scenario: ScenarioId = "machine",
): EngineTransport & { scenario: ScenarioId } {
  const machine = newMachine(scenario);

  return {
    scenario,
    async run(args: string[]): Promise<AmOutput> {
      await delay(machine.latencyMs);
      const command = args[0] ?? "";

      if (machine.scenario === "fault") {
        // SPEC §6.3: a parse failure is an error, never an empty result.
        return {
          stdout: JSON.stringify({
            error: {
              message: `Unexpected token } in JSON at position 1284 while reading ${PATHS.claudeMcp}`,
              path: PATHS.claudeMcp,
            },
          }),
          stderr: `am: ${PATHS.claudeMcp}: invalid JSON — refusing to continue.`,
          code: 2,
        };
      }

      try {
        switch (command) {
          case "inventory":
            return ok(buildInventory(machine));

          case "doctor": {
            const payload = buildDoctor(machine);
            return ok(payload, payload.findings.length === 0 ? 0 : 1);
          }

          case "plan": {
            const payload = buildPlan(machine);
            return ok(payload, payload.actions.some((a) => a.kind !== "unsupported") ? 1 : 0);
          }

          case "apply": {
            const { report, exitCode } = runApplyOn(machine, args.includes("--dry-run"));
            return ok(report, exitCode);
          }

          case "import":
            return ok(runImportOn(machine));

          case "enable":
          case "disable": {
            const kind = (args[1] ?? "") as AssetType;
            const name = args[2] ?? "";
            return ok(runExclusionOn(machine, kind, name, command === "disable"));
          }

          case "remove": {
            const kind = (args[1] ?? "") as AssetType;
            const name = args[2] ?? "";
            // The engine refuses without `--yes`; the GUI always passes it,
            // having just shown its own confirmation.
            if (!args.includes("--yes")) {
              return { stdout: JSON.stringify({ removed: [] }), stderr: "needs --yes", code: 1 };
            }
            return ok(runRemoveOn(machine, kind, name));
          }

          default:
            return { stdout: "", stderr: `am: unknown command "${command}"`, code: 2 };
        }
      } catch (err) {
        if (err instanceof WireFailure) {
          return {
            stdout: JSON.stringify({ error: { message: err.message } }),
            stderr: err.stderrText,
            code: 2,
          };
        }
        throw err;
      }
    },
  };
}
