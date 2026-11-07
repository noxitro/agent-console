/**
 * `am doctor` — diagnostics (SPEC §5).
 *
 * The checklist is fixed by the spec: duplicate physical copies (compared by
 * hash), broken junctions, name-constraint violations, non-spec frontmatter,
 * `.skill-lock.json` inconsistencies, and copilot body-length overruns.
 *
 * Read-only (SPEC §6.5). Note the one deliberate deviation from SPEC §6.3's
 * "parse failure ⇒ exit 2": inside `doctor`, an unparseable file *is* the
 * finding. Reporting it as a diagnostic is strictly more useful than aborting
 * the report that was supposed to tell the user about it — and `doctor` cannot
 * lead to a write, so nothing unsafe follows from continuing.
 *
 * That deviation is only worth anything if it is **complete**. Every file whose
 * parse failure makes the other commands exit 2 is opened here: the source's
 * skills, `mcp/servers.json`, agents and commands, and each target's MCP config,
 * agent files and command files. A file class left out of this list is a file
 * class about which `doctor` says "No problems found" while nothing else runs.
 *
 * One check is configured by the owner rather than fixed by the spec: the
 * optional `~/.agent-console/legacy-commands.json` names source commands that
 * are known to be stale copies (`command.legacy`; see
 * {@link readLegacyCommandRules}). No file means no such rule.
 *
 * Exit code: 0 when clean, 1 when anything was found (SPEC §5).
 */

import { isUnsupported, type Adapter } from "../adapters/types.js";
import { enabledTargets, readManifest } from "../core/manifest.js";
import {
  AmError,
  COPILOT_BODY_MAX,
  isValidAssetName,
  type AgentDef,
  type CommandDef,
  type SkillLink,
  type TargetId,
} from "../core/model.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { compareDirectories, inspectPath, linkPointsTo, readTextFile } from "../core/fsops.js";
import {
  SKILL_LOCK_FILE,
  legacyCommandsPath,
  skillManifestPath,
  sourceCommandPath,
  sourceSkillDir,
  sourceSkillsDir,
} from "../core/paths.js";
import {
  readSkillLock,
  readSourceAgents,
  readSourceCommands,
  readSourceServers,
  readSourceSkills,
} from "../core/source.js";
import { consoleIo, createAdapters, formatTable, type CommandIo } from "./context.js";

export interface DoctorOptions {
  io?: CommandIo;
}

export type DiagnosticLevel = "error" | "warn";

export interface Diagnostic {
  level: DiagnosticLevel;
  /** Stable machine-readable code, e.g. `skill.name-mismatch`. */
  code: string;
  message: string;
  path?: string;
  /** Target the finding belongs to; absent for findings about the source. */
  target?: TargetId;
  /** Asset the finding is about (skill / agent / server name), when known. */
  asset?: string;
}

/** SPEC §3: the six agentskills.io frontmatter fields a SKILL.md may declare. */
export const SKILL_FRONTMATTER_FIELDS: readonly string[] = [
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
];

export { SKILL_LOCK_FILE } from "../core/paths.js";

/* ------------------------------------------------------------------ */
/* Command                                                             */
/* ------------------------------------------------------------------ */

/** `am doctor`. 0 when clean, 1 when any diagnostic was produced. */
export function runDoctor(options: DoctorOptions = {}): 0 | 1 {
  const io = options.io ?? consoleIo;
  const diagnostics = collectDiagnostics();

  if (diagnostics.length === 0) {
    io.out("No problems found.");
    return 0;
  }

  for (const line of formatTable(
    ["level", "code", "detail"],
    diagnostics.map((d) => [d.level, d.code, d.message]),
  )) {
    io.out(line);
  }

  const errors = diagnostics.filter((d) => d.level === "error").length;
  io.out();
  io.out(`${diagnostics.length} finding(s): ${errors} error(s), ${diagnostics.length - errors} warning(s).`);
  return 1;
}

/** Run every check. Exposed so tests can assert on codes rather than on text. */
export function collectDiagnostics(): Diagnostic[] {
  const manifest = readManifest();
  const targets: TargetId[] = enabledTargets(manifest);
  const adapters = createAdapters(targets, manifest.skills.linkMode);

  const legacy = readLegacyCommandRules();

  const diagnostics: Diagnostic[] = [];
  diagnostics.push(...checkSourceSkills());
  diagnostics.push(...checkSourceServers());
  diagnostics.push(...checkSourceAgents());
  diagnostics.push(...checkLegacyCommandRules(legacy));
  diagnostics.push(...checkSourceCommands(legacy.status === "ok" ? legacy.rules : []));
  for (const adapter of adapters) {
    diagnostics.push(...checkTargetSkills(adapter));
    diagnostics.push(...checkTargetMcp(adapter));
    diagnostics.push(...checkTargetAgents(adapter));
    diagnostics.push(...checkTargetCommands(adapter));
  }
  return diagnostics;
}

/* ------------------------------------------------------------------ */
/* Source skills                                                       */
/* ------------------------------------------------------------------ */

function checkSourceSkills(): Diagnostic[] {
  const out: Diagnostic[] = [];
  const skills = readSourceSkills();
  for (const skill of skills) {
    const dir = sourceSkillDir(skill.name);
    const found: Diagnostic[] = [];

    if (!isValidAssetName(skill.name)) {
      found.push({
        level: "error",
        code: "skill.invalid-name",
        message: `skill directory "${skill.name}" is not lowercase-hyphen (≤64 chars)`,
        path: dir,
      });
    }

    found.push(...checkSkillManifest(skill.name, dir));
    out.push(...found.map((d) => ({ ...d, asset: skill.name })));
  }
  out.push(...checkSkillLock(skills.map((s) => s.name)));
  return out;
}

function checkSkillManifest(name: string, dir: string): Diagnostic[] {
  const manifestFile = skillManifestPath(dir);
  const text = readTextFile(manifestFile);
  if (text === null) {
    return [
      {
        level: "error",
        code: "skill.missing-manifest",
        message: `skill "${name}" has no SKILL.md`,
        path: manifestFile,
      },
    ];
  }

  let data: Record<string, unknown>;
  try {
    data = parseFrontmatter(text, manifestFile).data;
  } catch (err) {
    return [
      {
        level: "error",
        code: "skill.unparseable-frontmatter",
        message: `skill "${name}": ${(err as Error).message}`,
        path: manifestFile,
      },
    ];
  }

  const out: Diagnostic[] = [];
  const declared = data["name"];
  if (typeof declared !== "string" || declared.trim() === "") {
    out.push({
      level: "error",
      code: "skill.missing-name",
      message: `skill "${name}": SKILL.md frontmatter has no "name"`,
      path: manifestFile,
    });
  } else if (declared.trim() !== name) {
    out.push({
      level: "error",
      code: "skill.name-mismatch",
      message: `skill "${name}": frontmatter name is "${declared.trim()}" but the directory is "${name}"`,
      path: manifestFile,
    });
  }

  const description = data["description"];
  if (typeof description !== "string" || description.trim() === "") {
    out.push({
      level: "error",
      code: "skill.missing-description",
      message: `skill "${name}": SKILL.md frontmatter has no "description"`,
      path: manifestFile,
    });
  }

  // SPEC §3: Claude extension fields are a warning, never an error.
  for (const key of Object.keys(data)) {
    if (SKILL_FRONTMATTER_FIELDS.includes(key)) continue;
    out.push({
      level: "warn",
      code: "skill.non-spec-frontmatter",
      message: `skill "${name}": frontmatter field "${key}" is outside the agentskills.io schema`,
      path: manifestFile,
    });
  }

  return out;
}

/**
 * `~/.agents/.skill-lock.json` records what each installed skill came from —
 * **one** file for all of them, beside `skills/` rather than inside each skill
 * directory.
 *
 * It is written by foreign tooling, so the check is deliberately narrow: the
 * file must parse and carry the `skills` map every consumer here reads, and an
 * entry must correspond to a skill that actually exists. Everything else the
 * lock records (`skillFolderHash`, `skillPath`, timestamps) is checked by
 * nothing: `am` cannot reproduce that hash, and a diagnostic we cannot decide
 * correctly is worse than no diagnostic at all.
 *
 * @param names every skill directory found in the source, for the orphan check.
 */
function checkSkillLock(names: readonly string[]): Diagnostic[] {
  const lock = readSkillLock();
  if (!lock.present) return [];

  if (lock.error !== undefined) {
    return [
      {
        level: "error",
        code: lock.error.kind === "unparseable" ? "skill.lock-unparseable" : "skill.lock-invalid",
        message:
          lock.error.kind === "unparseable"
            ? `${SKILL_LOCK_FILE} could not be parsed (${lock.error.message})`
            : lock.error.message,
        path: lock.path,
      },
    ];
  }

  const out: Diagnostic[] = [];
  for (const name of lock.malformed) {
    out.push({
      level: "error",
      code: "skill.lock-invalid",
      message: `${SKILL_LOCK_FILE}: the entry for "${name}" is not an object`,
      path: lock.path,
      asset: name,
    });
  }
  for (const name of Object.keys(lock.entries)) {
    if (names.includes(name)) continue;
    out.push({
      level: "warn",
      code: "skill.lock-orphan",
      message: `${SKILL_LOCK_FILE} records "${name}", but ${sourceSkillDir(name)} does not exist`,
      path: lock.path,
      asset: name,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Source MCP                                                          */
/* ------------------------------------------------------------------ */

/**
 * The MCP counterpart of {@link checkSourceCommands}.
 *
 * `readSourceServers` is strict (SPEC §6.3), so one malformed byte in
 * `mcp/servers.json` makes `inventory`, `plan` and `apply` exit 2 — the exact
 * state `doctor` exists to explain. Without this check it read no servers at
 * all and answered "No problems found" about a machine on which nothing else
 * would run.
 */
function checkSourceServers(): Diagnostic[] {
  try {
    readSourceServers();
    return [];
  } catch (err) {
    return [
      {
        level: "error",
        code: "mcp.unreadable",
        message: (err as Error).message,
        ...(err instanceof AmError && err.path !== undefined ? { path: err.path } : {}),
      },
    ];
  }
}

/* ------------------------------------------------------------------ */
/* Source agents                                                       */
/* ------------------------------------------------------------------ */

function checkSourceAgents(): Diagnostic[] {
  const out: Diagnostic[] = [];
  let agents: AgentDef[];
  try {
    agents = readSourceAgents();
  } catch (err) {
    return [
      {
        level: "error",
        code: "agent.unreadable",
        message: (err as Error).message,
      },
    ];
  }

  for (const agent of agents) {
    const found: Diagnostic[] = [];
    if (!isValidAssetName(agent.name)) {
      found.push({
        level: "error",
        code: "agent.invalid-name",
        message: `agent "${agent.name}" is not lowercase-hyphen (≤64 chars)`,
      });
    }
    if (agent.description.trim() === "") {
      found.push({
        level: "error",
        code: "agent.missing-description",
        message: `agent "${agent.name}" has no description (required by the copilot dialect)`,
      });
    }
    found.push(...checkBodyLength(agent.name, agent.body, "source"));
    out.push(...found.map((d) => ({ ...d, asset: agent.name })));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Source commands (SPEC §10.2)                                        */
/* ------------------------------------------------------------------ */

/**
 * The command counterpart of {@link checkSourceAgents}.
 *
 * `readSourceCommands` is strict (SPEC §10.2), so one malformed file under
 * `~/.agents-manager/commands/` makes `plan`, `apply` and `inventory` exit 2.
 * Without this check `doctor` — the command whose whole job is to explain that
 * state — would read no commands at all and cheerfully report "No problems
 * found", which is the failure mode PRODUCT's 「失敗は大きく表示」 forbids.
 *
 * @param legacyRules the owner's legacy-command rules (empty when there are none).
 */
function checkSourceCommands(legacyRules: readonly LegacyCommandRule[]): Diagnostic[] {
  let commands: CommandDef[];
  try {
    commands = readSourceCommands();
  } catch (err) {
    return [
      {
        level: "error",
        code: "command.unreadable",
        message: (err as Error).message,
        ...(err instanceof AmError && err.path !== undefined ? { path: err.path } : {}),
      },
    ];
  }

  const out: Diagnostic[] = [];
  for (const command of commands) {
    const found: Diagnostic[] = [];
    if (!isValidAssetName(command.name)) {
      found.push({
        level: "error",
        code: "command.invalid-name",
        message: `command "${command.name}" is not lowercase-hyphen (≤64 chars)`,
        path: sourceCommandPath(command.name),
      });
    }
    if (command.description.trim() === "") {
      found.push({
        level: "error",
        code: "command.missing-description",
        message: `command "${command.name}" has no description (required by SPEC §10.2)`,
        path: sourceCommandPath(command.name),
      });
    }
    const legacy = matchLegacyCommand(command.name, legacyRules);
    if (legacy !== undefined) {
      found.push({
        level: "warn",
        code: "command.legacy",
        message:
          `command "${command.name}" matches the legacy command rule "${legacy.match}"` +
          (legacy.note !== undefined && legacy.note.trim() !== "" ? ` (${legacy.note.trim()})` : "") +
          "; `apply` would distribute this copy from the source to every target that carries commands. " +
          "Back the file up and remove it from the source, or exclude it, before applying",
        path: sourceCommandPath(command.name),
      });
    }
    out.push(...found.map((d) => ({ ...d, asset: command.name })));
  }
  return out;
}

/** SPEC §4: copilot bodies over 30,000 characters are a warning. */
function checkBodyLength(name: string, body: string, where: string): Diagnostic[] {
  if (body.length <= COPILOT_BODY_MAX) return [];
  return [
    {
      level: "warn",
      code: "agent.body-too-long",
      message: `agent "${name}" (${where}) body is ${body.length} characters; copilot allows ${COPILOT_BODY_MAX}`,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

/**
 * The skill checks SPEC §5 calls out — duplicate physical copies and broken
 * junctions — plus links that resolve somewhere other than the source, which
 * is the same failure wearing a different hat.
 */
function checkTargetSkills(adapter: Adapter): Diagnostic[] {
  const skillsDir = adapter.paths().skillsDir;
  if (isUnsupported(skillsDir)) return [];
  // Shared discovery: the "target directory" *is* the source (SPEC §4).
  if (normalize(skillsDir) === normalize(sourceSkillsDir())) return [];

  const links = adapter.readSkillLinks();
  if (isUnsupported(links)) return [];

  const out: Diagnostic[] = [];
  for (const link of links) {
    out.push(
      ...checkSkillLink(adapter.id, link).map((d) => ({
        ...d,
        target: adapter.id,
        asset: link.name,
      })),
    );
  }
  return out;
}

function checkSkillLink(target: TargetId, link: SkillLink): Diagnostic[] {
  const source = sourceSkillDir(link.name);
  const sourceExists = inspectPath(source).isDirectory;

  switch (link.kind) {
    case "broken":
      return [
        {
          level: "error",
          code: "skill.broken-link",
          message: `[${target}] "${link.name}" is a link to a destination that no longer exists (${link.linkTarget ?? "unknown"})`,
          path: link.path,
        },
      ];

    case "file":
      return [
        {
          level: "error",
          code: "skill.file-in-slot",
          message: `[${target}] a file occupies the skill path for "${link.name}"`,
          path: link.path,
        },
      ];

    case "directory": {
      if (!sourceExists) {
        return [
          {
            level: "warn",
            code: "skill.unmanaged-copy",
            message: `[${target}] "${link.name}" is a physical directory with no counterpart in the source (run \`am import --move\`)`,
            path: link.path,
          },
        ];
      }
      // SPEC §9.5: a tree too large to hash is reported as "cannot compare".
      // Calling it a duplicate would invite `apply` to replace it; calling it
      // drift would blame the user for an edit nobody looked for.
      const comparison = compareDirectories(link.path, source);
      if (comparison.status === "incomparable") {
        return [
          {
            level: "error",
            code: "skill.incomparable",
            message: `[${target}] "${link.name}" could not be compared with the source: ${comparison.reason} under ${comparison.path}. Reduce the directory (or exclude the skill) and re-run.`,
            path: link.path,
          },
        ];
      }
      const identical = comparison.status === "identical";
      return [
        {
          level: identical ? "warn" : "error",
          code: identical ? "skill.duplicate-copy" : "skill.drift",
          message: identical
            ? `[${target}] "${link.name}" is a physical duplicate of the source (run \`am apply\` to replace it with a junction)`
            : `[${target}] "${link.name}" is a physical copy that DIFFERS from the source`,
          path: link.path,
        },
      ];
    }

    case "junction":
    case "symlink": {
      if (sourceExists && !linkPointsTo(link.path, source)) {
        return [
          {
            level: "error",
            code: "skill.link-elsewhere",
            message: `[${target}] "${link.name}" links to ${link.linkTarget ?? "an unknown path"}, not to the source`,
            path: link.path,
          },
        ];
      }
      return [];
    }

    /*
     * SPEC §9.7 — an item that exists as far as anyone can tell, behind a
     * permission we do not have. `doctor` is the command whose whole job is to
     * say what is wrong, and 「見えない」 is a finding: it is why `plan` refuses
     * and why the console draws the slot as 未確認 rather than 未配布.
     */
    case "unreadable":
      return [
        {
          level: "error",
          code: "skill.unreadable",
          message: `[${target}] "${link.name}" could not be read (${link.unreadable ?? "reason unavailable"})`,
          path: link.path,
        },
      ];

    case "missing":
      return [];
  }
}

/**
 * The MCP config of one target, opened.
 *
 * Nothing here judges the servers — `plan` does that. The check exists for the
 * one state in which every *other* command exits 2: a `~/.claude.json` or an
 * `opencode.jsonc` that cannot be parsed (SPEC §6.3). Before this,
 * `collectDiagnostics` never called `readMcp` at all, so the owner whose
 * console would not open and whose `plan` died on a parse error was told by the
 * diagnostic command that the machine was healthy — the failure mode this
 * module's own header, and PRODUCT's 「失敗は大きく表示」, both forbid.
 */
function checkTargetMcp(adapter: Adapter): Diagnostic[] {
  try {
    const servers = adapter.readMcp();
    // vs2026 has no verified format (SPEC §4); a refusal is not a fault.
    if (isUnsupported(servers)) return [];
  } catch (err) {
    return [
      {
        level: "error",
        code: "mcp.unreadable",
        message: `[${adapter.id}] ${(err as Error).message}`,
        target: adapter.id,
        ...(err instanceof AmError && err.path !== undefined ? { path: err.path } : {}),
      },
    ];
  }
  return [];
}

/**
 * The command counterpart of {@link checkTargetAgents} (SPEC §10.2).
 *
 * `readCommands` parses YAML frontmatter, and a hand-edited
 * `~/.config/opencode/command/*.md` with a broken block is exactly the kind of
 * file nothing else will mention: `plan` stays green because it only diffs
 * bytes, and `inventory` — which used to exit 2 over it, taking the console's
 * whole survey down — now keeps it as a row flagged `unreadable`
 * (`Adapter.readCommandsForDisplay`) rather than judging it. Judging it is this
 * function's job, and the verdict is deliberately unchanged: an **error**, so
 * `doctor` exits 1 and the console's DOCTOR cell counts it.
 *
 * The strict read stays strict here for a second reason: it is the same call
 * `import` makes, so if this passes, that file can be lifted into the source.
 *
 * The name check is a **warning**, not an error: opencode imposes no naming
 * rule of its own, so an oddly named file there is legal. What it cannot do is
 * travel into the source of truth, whose names are also file names (SPEC
 * §10.2) — `import` reports and skips it, and this says the same thing from the
 * other side.
 */
function checkTargetCommands(adapter: Adapter): Diagnostic[] {
  let commands: ReturnType<Adapter["readCommands"]>;
  try {
    commands = adapter.readCommands();
  } catch (err) {
    return [
      {
        level: "error",
        code: "command.unreadable",
        message: `[${adapter.id}] ${(err as Error).message}`,
        target: adapter.id,
        ...(err instanceof AmError && err.path !== undefined ? { path: err.path } : {}),
      },
    ];
  }
  if (isUnsupported(commands)) return [];

  const out: Diagnostic[] = [];
  for (const command of commands) {
    if (isValidAssetName(command.name)) continue;
    out.push({
      level: "warn",
      code: "command.invalid-name",
      message: `[${adapter.id}] command "${command.name}" is not lowercase-hyphen (≤64 chars), so \`am import\` cannot lift it into the source; rename it in ${adapter.id}`,
      target: adapter.id,
      asset: command.name,
    });
  }
  return out;
}

function checkTargetAgents(adapter: Adapter): Diagnostic[] {
  // A target agent file with broken YAML makes `readAgents` throw (SPEC §6.3).
  // Inside `doctor` that throw is the finding, not a reason to abandon the
  // report: letting it escape means one corrupt file in `~/.copilot/agents/`
  // turns every diagnostic the user came for — broken junctions, duplicate
  // copies, the corrupt file itself — into a bare exit 2. `checkSourceAgents`
  // and `checkSkillManifest` already convert; this is the same conversion.
  let agents: ReturnType<Adapter["readAgents"]>;
  try {
    agents = adapter.readAgents();
  } catch (err) {
    return [
      {
        level: "error",
        code: "agent.unreadable",
        message: `[${adapter.id}] ${(err as Error).message}`,
        target: adapter.id,
        ...(err instanceof AmError && err.path !== undefined ? { path: err.path } : {}),
      },
    ];
  }
  if (isUnsupported(agents)) return [];
  // VS Code reads copilot-cli's directory; checking it twice would duplicate
  // every finding (SPEC §4).
  if (adapter.capabilities.sharesDiscoveryWith !== undefined) return [];

  const out: Diagnostic[] = [];
  for (const agent of agents) {
    const found: Diagnostic[] = [];
    if (!isValidAssetName(agent.name)) {
      found.push({
        level: "error",
        code: "agent.invalid-name",
        message: `[${adapter.id}] agent file name "${agent.name}" is not lowercase-hyphen (≤64 chars)`,
      });
    }
    if (adapter.capabilities.agentDialect === "copilot") {
      if (agent.description.trim() === "") {
        found.push({
          level: "error",
          code: "agent.missing-description",
          message: `[${adapter.id}] agent "${agent.name}" has no description, which the copilot dialect requires`,
        });
      }
      found.push(...checkBodyLength(agent.name, agent.body, adapter.id));
    }
    out.push(...found.map((d) => ({ ...d, target: adapter.id, asset: agent.name })));
  }
  return out;
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Legacy commands (owner-configured)                                  */
/* ------------------------------------------------------------------ */

/**
 * One entry of `~/.agent-console/legacy-commands.json`.
 *
 * A source command can outlive the place it was meant to come from: the owner
 * moved its canonical copy elsewhere, but an old copy still sits in
 * `~/.agents-manager/commands/`, and `apply` would distribute that copy. Which
 * names are stale is something only the owner knows, so the list lives in a
 * file of theirs rather than in this code (ARCHITECTURE.md「am から引き継いだもの」).
 */
export interface LegacyCommandRule {
  /** A command name, or a non-empty prefix followed by one trailing `*`. */
  match: string;
  /** Free text shown in the finding (where the canonical copy lives, say). */
  note?: string;
}

/** What reading the rule file found. */
export type LegacyCommandRules =
  | { status: "absent" }
  | { status: "ok"; rules: LegacyCommandRule[] }
  | { status: "unreadable"; path: string; message: string };

/**
 * Read `~/.agent-console/legacy-commands.json`:
 *
 * ```json
 * { "version": 1, "commands": [ { "match": "old-*", "note": "…" } ] }
 * ```
 *
 * No file is no rules. A file that does not parse, or has another shape, is
 * `unreadable` — never "no rules" (SPEC §6.3: a parse failure is not empty
 * data), so the owner learns that the check they configured is not running.
 */
export function readLegacyCommandRules(file: string = legacyCommandsPath()): LegacyCommandRules {
  const unreadable = (message: string): LegacyCommandRules => ({ status: "unreadable", path: file, message });

  let text: string | null;
  try {
    text = readTextFile(file);
  } catch (err) {
    return unreadable((err as Error).message);
  }
  if (text === null) return { status: "absent" };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return unreadable(`not valid JSON (${(err as Error).message})`);
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return unreadable("the document must be a JSON object");
  }
  const doc = data as Record<string, unknown>;
  if (doc["version"] !== 1) return unreadable('"version" must be 1');
  const commands = doc["commands"];
  if (!Array.isArray(commands)) return unreadable('"commands" must be an array');

  const rules: LegacyCommandRule[] = [];
  for (const [index, entry] of commands.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return unreadable(`commands[${index}] must be an object`);
    }
    const { match, note } = entry as Record<string, unknown>;
    if (typeof match !== "string" || !/^[^*]+\*?$/.test(match)) {
      return unreadable(
        `commands[${index}].match must be a command name, or a non-empty prefix followed by one trailing "*"`,
      );
    }
    if (note !== undefined && typeof note !== "string") {
      return unreadable(`commands[${index}].note must be a string`);
    }
    rules.push(note === undefined ? { match } : { match, note });
  }
  return { status: "ok", rules };
}

/**
 * The first rule `name` matches, or `undefined`. A `match` ending in `*` is a
 * prefix; anything else must equal the name exactly.
 */
export function matchLegacyCommand(
  name: string,
  rules: readonly LegacyCommandRule[],
): LegacyCommandRule | undefined {
  return rules.find((rule) =>
    rule.match.endsWith("*") ? name.startsWith(rule.match.slice(0, -1)) : name === rule.match,
  );
}

/** The finding for a rule file that exists but could not be used. */
function checkLegacyCommandRules(legacy: LegacyCommandRules): Diagnostic[] {
  if (legacy.status !== "unreadable") return [];
  return [
    {
      level: "error",
      code: "console.legacy-commands-unreadable",
      message: `${legacy.path} could not be read as legacy command rules: ${legacy.message}. The legacy command check did not run`,
      path: legacy.path,
    },
  ];
}
