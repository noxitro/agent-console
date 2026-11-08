/**
 * The fixed vocabulary of the HTTP API (ARCHITECTURE.md「全体構成」: "API の語彙は固定する").
 *
 * Ported from the argument check of the former desktop shell. The browser
 * sends an argv; the server never runs one
 * that is not spelled out here. The lists are kept **by hand** on purpose: they
 * are the blast-radius limit, so a new engine command must be added here
 * deliberately. `src/server/vocabulary.test.ts` pins them against the engine's
 * own `ASSET_KIND_IDS` / `TARGET_IDS` so a kind or a target added to the engine
 * cannot silently fall out of the GUI's reach (the failure the Rust list had
 * twice: `command` with SPEC §10.5 and `opencode` with SPEC §10).
 *
 * `--json` is not in the vocabulary: the server appends it itself, because the
 * JSON contract is the GUI's transport and not the caller's to opt out of.
 */

/** Subcommands the GUI is allowed to run (SPEC §5, §9.2). */
export const COMMANDS = [
  "inventory",
  "doctor",
  "plan",
  "apply",
  "import",
  "enable",
  "disable",
  "remove",
  "projects",
  "installed",
] as const;
export type ApiCommand = (typeof COMMANDS)[number];

/** Subcommands that take `<kind> <name>` before any flag (SPEC §9.2, §10.5). */
export const ASSET_COMMANDS: readonly ApiCommand[] = ["enable", "disable", "remove"];

/** Asset kinds accepted as the first positional argument of those commands. */
export const ASSET_KINDS = ["skill", "mcp", "agent", "command"] as const;

/** Flags the GUI is allowed to pass. */
export const FLAGS = ["--prune", "--yes", "--dry-run", "--move", "--prefer", "--refresh", "--project"] as const;

/** `projects <action> <target>` (ARCHITECTURE.md「単位とプロジェクト」). */
export const PROJECT_ACTIONS = ["pin", "unpin", "hide", "unhide", "add", "forget"] as const;

/**
 * Flags that belong to one command only. The flags of the inherited commands
 * stay accepted wherever they were before (the engine rejects a flag its
 * command does not define); these two are new and are tied to their command.
 */
export const COMMAND_ONLY_FLAGS: Readonly<Record<string, ApiCommand>> = {
  "--refresh": "projects",
  "--project": "installed",
};

/** A project id: the first 12 hex digits of a sha256 (src/scope/discover.ts `projectId`). */
export function isProjectId(value: string): boolean {
  return /^[0-9a-f]{12}$/.test(value);
}

/** Longest folder path `projects add` accepts. */
export const MAX_FOLDER_PATH = 260;

/**
 * A folder for `projects add`: absolute (a drive path or a POSIX root), no
 * control characters, no `..` segment, not starting with `-`. That the
 * folder exists is checked by the engine.
 */
export function isFolderPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_FOLDER_PATH) return false;
  if (value.startsWith("-") || /[\u0000-\u001f"<>|?*]/.test(value)) return false;
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) return false;
  return !value.split(/[\\/]/).includes("..");
}

/** Target ids accepted as the value of `--prefer` (SPEC §2, §10.5). */
export const TARGETS = ["claude", "copilot-cli", "vscode", "vs2026", "opencode"] as const;

/** Subcommands that write (SPEC §9.5). */
export const WRITE_COMMANDS: readonly ApiCommand[] = [
  "apply",
  "import",
  "remove",
  "enable",
  "disable",
];

/**
 * Subcommands that write, but only to agent-console's own settings under
 * `~/.agent-console/`: `projects` with an action. They are writes for
 * `--read-only` and for the engine queue (no read ceiling).
 */
export function isConsoleSettingsWrite(args: readonly string[]): boolean {
  return args[0] === "projects" && args[1] !== undefined && !args[1].startsWith("-");
}

/** Longest asset name passed through (SPEC §3 caps names at 64). */
export const MAX_ASSET_NAME = 64;

/** An argv longer than this is not one the GUI ever builds. */
export const MAX_ARGS = 8;

/**
 * Is this a plausible asset name? Alphanumerics plus `-`, `_` and `.`, never
 * starting with `-` (which would let a name be read as a flag), at most 64.
 * MCP server names are looser than skill names, hence `_` and `.`.
 */
export function isAssetName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_ASSET_NAME &&
    !value.startsWith("-") &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function includes<T extends string>(list: readonly T[], value: string): value is T {
  return (list as readonly string[]).includes(value);
}

export type Validation = { ok: true; args: string[] } | { ok: false; message: string };

/**
 * Check an argv received over HTTP against the fixed vocabulary.
 *
 * `args` is `unknown` because it comes straight out of a request body: the
 * shape is part of what is being validated.
 */
export function validateArgs(args: unknown): Validation {
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    return { ok: false, message: "args must be an array of strings." };
  }
  const argv = args as string[];
  if (argv.length > MAX_ARGS) {
    return { ok: false, message: "Too many engine arguments." };
  }
  const command = argv[0];
  if (command === undefined) return { ok: false, message: "No engine command was given." };
  if (!includes(COMMANDS, command)) {
    return { ok: false, message: `Unknown engine command: ${command}` };
  }

  let i = 1;
  if (command === "projects" && argv[i] !== undefined && !argv[i]!.startsWith("-")) {
    const action = argv[i++] as string;
    if (!includes(PROJECT_ACTIONS, action)) return { ok: false, message: `Unknown projects action: ${action}` };
    const target = argv[i++];
    if (target === undefined) return { ok: false, message: `projects ${action} needs a target` };
    const valid = action === "add" ? isFolderPath(target) : isProjectId(target);
    if (!valid) return { ok: false, message: `Unsupported projects target: ${target}` };
  }
  if (ASSET_COMMANDS.includes(command)) {
    const kind = argv[i++];
    if (kind === undefined) return { ok: false, message: `${command} needs an asset kind and a name` };
    if (!includes(ASSET_KINDS, kind)) return { ok: false, message: `Unknown asset kind: ${kind}` };
    const name = argv[i++];
    if (name === undefined) return { ok: false, message: `${command} needs an asset name` };
    if (!isAssetName(name)) return { ok: false, message: `Unsupported asset name: ${name}` };
  }

  while (i < argv.length) {
    const arg = argv[i++] as string;
    const owner = COMMAND_ONLY_FLAGS[arg];
    if (!includes(FLAGS, arg) || (owner !== undefined && owner !== command)) {
      return { ok: false, message: `Unsupported engine argument: ${arg}` };
    }
    if (arg === "--project") {
      const value = argv[i++];
      if (value === undefined || !isProjectId(value)) return { ok: false, message: "--project needs a project id" };
      continue;
    }
    if (arg === "--prefer") {
      const value = argv[i++];
      if (value === undefined) return { ok: false, message: "--prefer needs a target" };
      if (!includes(TARGETS, value)) {
        return { ok: false, message: `Unknown target for --prefer: ${value}` };
      }
    }
  }
  return { ok: true, args: [...argv] };
}

/** Does this (already validated) argv write? `apply --dry-run` is `plan`. */
export function isWrite(args: readonly string[]): boolean {
  const command = args[0] ?? "";
  if (command === "apply" && args.includes("--dry-run")) return false;
  if (isConsoleSettingsWrite(args)) return true;
  return (WRITE_COMMANDS as readonly string[]).includes(command);
}

/**
 * The plan an `apply` is bound to (ARCHITECTURE.md「守り」: 計画には digest を付け…).
 *
 * `apply` executes what `plan` (with the same `--prune`) describes, so the
 * digest the browser got from that plan is what an `apply` must present.
 * Returns `null` for commands that are not bound to a plan.
 */
export function boundPlanArgs(args: readonly string[]): string[] | null {
  if (args[0] !== "apply" || args.includes("--dry-run")) return null;
  return ["plan", ...(args.includes("--prune") ? ["--prune"] : [])];
}

/**
 * Is this argv a plan reading, whose response carries a digest?
 *
 * Only `plan` itself. `apply --dry-run` describes the same work but answers in
 * the shape of an apply report (`{ applied }`, not `{ actions }`), so a digest
 * taken of it would never match the fresh plan an `apply` is checked against.
 */
export function planArgsOf(args: readonly string[]): string[] | null {
  if (args[0] === "plan") return ["plan", ...(args.includes("--prune") ? ["--prune"] : [])];
  return null;
}
