#!/usr/bin/env node
/**
 * `ac` (alias `am`) — the commander entry point (SPEC §7).
 *
 * The CLI itself contains no logic beyond argument parsing and the exit-code
 * contract of SPEC §5:
 *
 *   0 — success / no difference
 *   1 — a difference exists (`plan`) or diagnostics were found (`doctor`)
 *   2 — an error
 *
 * Commands signal 0/1 by returning it; they signal 2 by throwing. Mapping
 * every thrown error to 2 in one place is what guarantees a malformed config
 * can never be mistaken for "nothing to do" (SPEC §6.3).
 */

import { Command, CommanderError } from "commander";

import { AmError, ASSET_KIND_IDS, isAssetKindId, type AssetKindId } from "./core/model.js";
import { consoleIo, type CommandIo } from "./commands/context.js";
import { runDisable, runEnable, runRemove } from "./commands/assets.js";
import { runApply } from "./commands/apply.js";
import { runDoctor } from "./commands/doctor.js";
import { runImport } from "./commands/import.js";
import { runInventory } from "./commands/inventory.js";
import { runPlan } from "./commands/plan.js";
import { installedJson, projectsJson, runInstalled, runProjects } from "./commands/scope.js";
import {
  applyJson,
  doctorJson,
  emitJson,
  importJson,
  inventoryJson,
  planJson,
} from "./commands/json.js";

const VERSION = "0.1.0";

/** Exit codes, named (SPEC §5). */
export const EXIT_OK = 0;
export const EXIT_DIFF = 1;
export const EXIT_ERROR = 2;

export interface MainOptions {
  io?: CommandIo;
}

const JSON_HELP = "emit a single JSON object on stdout and suppress the human-readable output";

/**
 * Print a JSON payload and hand back its exit code.
 *
 * The exit-code contract is unchanged by `--json` (SPEC §5): a `plan` with a
 * difference still exits 1 whether a human or the GUI is reading it. Exit 2 is
 * reachable here too — `apply` reports a failed run as a payload rather than a
 * bare error, so the audit trail of a partial write survives (SPEC §5).
 */
function emit<T>(result: { exitCode: 0 | 1 | 2; payload: T }, io: CommandIo): 0 | 1 | 2 {
  emitJson(result.payload, io);
  return result.exitCode;
}

/**
 * Validate the asset-kind argument. commander cannot type an enum argument, so
 * an unknown kind would otherwise reach the command as a string and be reported
 * as "no such asset" — a confusing way to say "there is no such *category*".
 */
function assetKind(value: string): AssetKindId {
  if (isAssetKindId(value)) return value;
  throw new AmError(
    `Unknown asset kind "${value}"; expected one of ${ASSET_KIND_IDS.join(", ")}`,
  );
}

/**
 * In `--json` mode stdout belongs to the payload, so the command's narration is
 * dropped and only stderr survives — the same rule `commands/json.ts` applies to
 * `apply` and `import`.
 */
function quietIo(io: CommandIo, json: boolean): { io: CommandIo } {
  if (!json) return { io };
  return {
    io: {
      out(): void {
        /* discarded: stdout carries the JSON payload */
      },
      err: (line: string) => {
        io.err(line);
      },
    },
  };
}

/**
 * Build the command tree.
 *
 * `exitOverride` keeps commander from calling `process.exit` itself, so the
 * exit code always comes from {@link main} — otherwise a usage error would
 * exit 1 and be indistinguishable from "plan found a difference".
 */
export function buildProgram(io: CommandIo, setExit: (code: number) => void): Command {
  const program = new Command();

  program
    .name("ac")
    .description(
      "Manage skills, MCP servers, custom agents and commands for Claude Code, Copilot CLI, VS Code, Visual Studio 2026 and opencode from a single source of truth.",
    )
    .version(VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (str) => io.out(str.replace(/\n$/, "")),
      writeErr: (str) => io.err(str.replace(/\n$/, "")),
    });

  program
    .command("inventory")
    .description("Scan every target's discovery paths and show who sees what (read-only).")
    .option("--json", JSON_HELP, false)
    .action((options: { json?: boolean }) => {
      if (options.json === true) {
        setExit(emit(inventoryJson(), io));
        return;
      }
      setExit(runInventory({ io }));
    });

  program
    .command("import")
    .description("Lift the existing environment into the source of truth (initial migration).")
    .option("--prefer <target>", "resolve cross-target conflicts in favour of this target")
    .option("--move", "move physical skill directories into ~/.agents/skills", false)
    .option("--json", JSON_HELP, false)
    .action((options: { prefer?: string; move?: boolean; json?: boolean }) => {
      const shared = {
        ...(options.prefer !== undefined ? { prefer: options.prefer } : {}),
        move: options.move === true,
      };
      if (options.json === true) {
        setExit(emit(importJson(shared, io), io));
        return;
      }
      setExit(runImport({ io, ...shared }));
    });

  program
    .command("plan")
    .description("Show the difference between the source of truth and the environment.")
    .option("--prune", "also plan removal of managed assets the source no longer has", false)
    .option("--json", JSON_HELP, false)
    .action((options: { prune?: boolean; json?: boolean }) => {
      if (options.json === true) {
        setExit(emit(planJson({ prune: options.prune === true }), io));
        return;
      }
      setExit(runPlan({ io, prune: options.prune === true }));
    });

  program
    .command("apply")
    .description("Apply the plan. Backs up every file it touches before writing.")
    .option("--dry-run", "identical to `am plan`; writes nothing", false)
    .option("--prune", "remove managed assets that are absent from the source", false)
    .option("--yes", "confirm the deletions listed by --prune", false)
    .option("--json", JSON_HELP, false)
    .action((options: { dryRun?: boolean; prune?: boolean; yes?: boolean; json?: boolean }) => {
      const shared = {
        dryRun: options.dryRun === true,
        prune: options.prune === true,
        yes: options.yes === true,
      };
      if (options.json === true) {
        setExit(emit(applyJson(shared, io), io));
        return;
      }
      setExit(runApply({ io, ...shared }));
    });

  /*
   * SPEC §9.2. `enable`/`disable` edit `manifest.json`'s exclude lists;
   * `remove` deletes the asset from the source of truth. All three back up
   * before writing, and all three refuse an unknown name with exit 2 rather
   * than succeeding at nothing.
   */
  const assetArg = `<${ASSET_KIND_IDS.join("|")}>`;

  program
    .command("enable")
    .description("Deliver an asset again: drop its name from the manifest's exclude list.")
    .argument(assetArg, "asset kind")
    .argument("<name>", "asset name")
    .option("--json", JSON_HELP, false)
    .action((kind: string, name: string, options: { json?: boolean }) => {
      const result = runEnable(assetKind(kind), name, quietIo(io, options.json === true));
      if (options.json === true) emitJson(result.report, io);
      setExit(result.exitCode);
    });

  program
    .command("disable")
    .description("Stop delivering an asset: add its name to the manifest's exclude list.")
    .argument(assetArg, "asset kind")
    .argument("<name>", "asset name")
    .option("--json", JSON_HELP, false)
    .action((kind: string, name: string, options: { json?: boolean }) => {
      const result = runDisable(assetKind(kind), name, quietIo(io, options.json === true));
      if (options.json === true) emitJson(result.report, io);
      setExit(result.exitCode);
    });

  program
    .command("remove")
    .description("Delete an asset from the source of truth. Backs it up first; needs --yes.")
    .argument(assetArg, "asset kind")
    .argument("<name>", "asset name")
    .option("--yes", "confirm the removal listed above", false)
    .option("--json", JSON_HELP, false)
    .action((kind: string, name: string, options: { yes?: boolean; json?: boolean }) => {
      const result = runRemove(assetKind(kind), name, {
        ...quietIo(io, options.json === true),
        yes: options.yes === true,
      });
      if (options.json === true) emitJson(result.report, io);
      setExit(result.exitCode);
    });

  program
    .command("doctor")
    .description("Diagnose duplicate copies, broken links, and schema violations (read-only).")
    .option("--json", JSON_HELP, false)
    .action((options: { json?: boolean }) => {
      if (options.json === true) {
        setExit(emit(doctorJson(), io));
        return;
      }
      setExit(runDoctor({ io }));
    });

  /*
   * ARCHITECTURE.md「単位とプロジェクト」. Both read the harnesses' files only.
   * `projects` keeps a cache under ~/.agent-console/cache/, and
   * `projects <action>` edits ~/.agent-console/projects.json — nothing else.
   */
  program
    .command("projects")
    .description("List the projects Claude Code and Copilot have recorded (read-only), or pin / hide / add one.")
    .argument("[action]", "pin | unpin | hide | unhide | add | forget")
    .argument("[target]", "a project id (add: a folder path)")
    .option("--refresh", "read every Copilot session again instead of using the cache", false)
    .option("--json", JSON_HELP, false)
    .action((action: string | undefined, target: string | undefined, options: { refresh?: boolean; json?: boolean }) => {
      const shared = {
        refresh: options.refresh === true,
        ...(action !== undefined ? { action } : {}),
        ...(target !== undefined ? { target } : {}),
      };
      if (options.json === true) {
        setExit(emit(projectsJson(shared), io));
        return;
      }
      setExit(runProjects({ io, ...shared }));
    });

  program
    .command("installed")
    .description("Show what Claude Code and Copilot load, by unit (user / project / local), with the always-on cost (read-only).")
    .option("--project <id>", "a project id from `ac projects`; adds its project and local units")
    .option("--json", JSON_HELP, false)
    .action((options: { project?: string; json?: boolean }) => {
      const shared = options.project !== undefined ? { project: options.project } : {};
      if (options.json === true) {
        setExit(emit(installedJson(shared), io));
        return;
      }
      setExit(runInstalled({ io, ...shared }));
    });

  return program;
}

/**
 * Parse `argv` and run. Returns the process exit code; never throws.
 *
 * `argv` follows the Node convention (`[node, script, ...args]`), which is what
 * commander's default parser expects.
 */
export function main(argv: readonly string[] = process.argv, options: MainOptions = {}): number {
  const io = options.io ?? consoleIo;
  // Read from argv rather than from the parsed options: a failure can happen
  // before (or instead of) the action handler running — an unknown option, a
  // malformed config — and a caller that asked for JSON must still get JSON
  // on stdout rather than an empty stream.
  const jsonMode = argv.includes("--json");
  let exitCode = EXIT_OK;
  const program = buildProgram(io, (code) => {
    exitCode = code;
  });

  try {
    program.parse([...argv]);
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      // `--help` and `--version` unwind through the same channel as a usage
      // error; only the latter is an error.
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
        return EXIT_OK;
      }
      if (err.code === "commander.help") return EXIT_OK;
      /*
       * Not printed here. Commander raises a usage error by writing it through
       * `configureOutput.writeErr` — which `buildProgram` routes into `io.err`
       * — and *then* throwing, so an `io.err(err.message)` in this branch put
       * the same line on stderr twice (`am frobnicate` → two 「error: unknown
       * command」). This branch's remaining jobs are the exit code and, for a
       * `--json` caller, the error envelope on stdout.
       */
      if (jsonMode) emitJson({ error: { message: err.message } }, io);
      return EXIT_ERROR;
    }
    if (err instanceof AmError) {
      io.err(`error: ${err.message}`);
      if (err.path !== undefined) io.err(`  path: ${err.path}`);
      if (jsonMode) {
        emitJson(
          { error: { message: err.message, ...(err.path !== undefined ? { path: err.path } : {}) } },
          io,
        );
      }
      return EXIT_ERROR;
    }
    const message = (err as Error).message ?? String(err);
    io.err(`error: ${message}`);
    if (jsonMode) emitJson({ error: { message } }, io);
    return EXIT_ERROR;
  }
}

/* Executed only when run as the `am` binary, not when imported by tests. */
const invokedDirectly =
  process.argv[1] !== undefined && /(^|[\\/])cli\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = main(process.argv);
}
