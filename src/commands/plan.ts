/**
 * `am plan` — show the difference between the source of truth and the real
 * environment (SPEC §5). **Never writes anything**, including backups
 * (SPEC §6.5): every path below is either read or handed to the pure diff
 * engine in `core/diff.ts`.
 *
 * The action list this module computes is also exactly what `apply` executes,
 * so `apply --dry-run` is `plan` by construction rather than by convention.
 *
 * Exit code (SPEC §5): 0 when there is nothing to do, 1 when a difference
 * exists. Errors throw and the CLI turns them into exit code 2.
 */

import * as path from "node:path";

import { isUnsupported, type Adapter } from "../adapters/types.js";
import {
  diffFiles,
  hasChanges,
  mergeActions,
  planExitCode,
  sortActions,
  summarizeActions,
  unsupportedAction,
  type Action,
  type AssetKind,
  type FileState,
} from "../core/diff.js";
import { listFiles, readTextFile } from "../core/fsops.js";
import {
  agentsForTarget,
  commandsForTarget,
  serversForTarget,
  skillsForDelivery,
  type FileEdit,
  type McpServer,
  type TargetId,
} from "../core/model.js";
import { consoleIo, loadSourceContext, type CommandIo, type SourceContext } from "./context.js";

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface PlanOptions {
  /**
   * Include deletions of managed target assets that the source no longer has.
   * They are planned either way; `--prune` is what makes `apply` execute them
   * (SPEC §5), and it also decides whether MCP entries the source does not
   * know about are preserved on the next write.
   */
  prune?: boolean;
  io?: CommandIo;
}

/* ------------------------------------------------------------------ */
/* Plan computation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Compute the full action list for every enabled target.
 *
 * Ordering is delegated to `sortActions`, so output and tests see a stable
 * sequence regardless of the order the adapters happen to be consulted in.
 */
export function computeActions(ctx: SourceContext, options: { prune?: boolean } = {}): Action[] {
  const prune = options.prune === true;
  const groups: Action[][] = [];
  for (const adapter of ctx.adapters) {
    groups.push(planSkills(adapter, ctx));
    groups.push(planMcp(adapter, ctx, prune));
    groups.push(planAgents(adapter, ctx));
    groups.push(planCommands(adapter, ctx));
  }
  const actions = mergeActions(...groups);
  return prune ? actions : actions.map(asPreserved);
}

/**
 * Without `--prune`, a removal is not planned work — it is a decision to leave
 * something alone (SPEC §5), so it is reported as `preserve`.
 *
 * This single rewrite is deliberately the *only* place the distinction is made,
 * because the bug it fixes came from the two ideas being spelled the same way in
 * three different planners. Consequences of getting it wrong were: `am plan`
 * exiting 1 forever (one MCP server registered by Claude Code was enough), so
 * SPEC §8's `apply → plan が差分ゼロ` fixed point was unreachable; and the GUI
 * listing "削除 1 — ~/.claude.json" in the dialog that promises "以下を適用します"
 * while `apply` skipped it.
 */
function asPreserved(action: Action): Action {
  if (action.kind !== "delete") return action;
  return {
    ...action,
    kind: "preserve",
    detail: `${action.detail}; preserved (use --prune to remove)`,
  };
}

/* ---------------------------- skills ---------------------------- */

/**
 * Skill materialization is entirely the adapter's business (it knows whether
 * it owns a discovery directory at all), so this just supplies the delivery
 * list with `manifest.skills.exclude` applied (SPEC §2).
 */
function planSkills(adapter: Adapter, ctx: SourceContext): Action[] {
  const skills = skillsForDelivery(ctx.skills, ctx.manifest.skills.exclude);
  return adapter.planSkills(skills);
}

/* ------------------------------ MCP ------------------------------ */

/**
 * MCP lives in a single whole-file config per target, which makes "delete"
 * subtle: a server the source does not know about disappears simply by not
 * being rendered. SPEC §5 forbids that outside `--prune`, so without `--prune`
 * such servers are folded back into the rendered document (preserved), and
 * with `--prune` they are dropped and reported as explicit `delete` actions.
 */
/**
 * The MCP file edits for one target, and the names of the servers that exist
 * only in the target.
 *
 * Exported for `apply`, which re-runs this immediately before writing: the
 * content rendered at plan time is a snapshot of a live file (SPEC §6.1) and
 * must not be what actually lands on disk minutes later.
 */
export function renderMcpEdits(
  adapter: Adapter,
  ctx: SourceContext,
  prune: boolean,
): { edits: FileEdit[]; extras: string[] } | undefined {
  const actual = adapter.readMcp();
  if (isUnsupported(actual)) return undefined;

  const desired = serversForTarget(ctx.servers, adapter.id, ctx.enabled);
  const extras = Object.keys(actual)
    .filter((name) => !(name in desired))
    .sort();

  // Extras are handed to the adapter as their **raw on-disk entries**, not as
  // values round-tripped through the normalized schema: "preserved" has to mean
  // structurally preserved, or an unmanaged server would silently lose its
  // `env`, its `tools` allowlist, or any key SPEC §3 does not model (SPEC §5).
  const preserve: Record<string, unknown> = {};
  if (!prune) {
    const raw = adapter.readRawMcp();
    if (!isUnsupported(raw)) {
      for (const name of extras) {
        const entry = raw[name];
        if (entry !== undefined) preserve[name] = entry;
      }
    }
  }

  // Nothing to deliver and no file to correct: do not conjure a config file
  // just to hold an empty server map. `~/.claude.json` in particular belongs to
  // Claude Code (SPEC §6.1) and must not be created by this tool as a side
  // effect of an empty source.
  const rendered = adapter.renderMcp(desired, { preserve });
  const edits =
    Object.keys(desired).length === 0 && Object.keys(preserve).length === 0
      ? rendered.filter((edit) => readTextFile(edit.path) !== null)
      : rendered;

  return { edits, extras };
}

function planMcp(adapter: Adapter, ctx: SourceContext, prune: boolean): Action[] {
  const planned = renderMcpEdits(adapter, ctx, prune);
  if (planned === undefined) {
    return [
      unsupportedAction(
        adapter.id,
        "mcp",
        unsupportedDetail(
          adapter,
          "mcp",
          `${adapter.id} does not support MCP configuration in v1`,
        ),
      ),
    ];
  }
  const { edits, extras } = planned;

  const states: FileState[] = edits.map((edit) => ({
    path: edit.path,
    content: readTextFile(edit.path),
  }));

  const actions = diffFiles({ target: adapter.id, asset: "mcp", desired: edits, actual: states });

  const configPath = firstPath(adapter, edits.map((e) => e.path));
  const desired = serversForTarget(ctx.servers, adapter.id, ctx.enabled);
  // Emitted as `delete` unconditionally; `computeActions` rewrites it to
  // `preserve` when this run is not pruning, so the "kept vs removed" decision
  // lives in exactly one place.
  for (const name of extras) {
    actions.push({
      kind: "delete",
      target: adapter.id,
      asset: "mcp",
      path: configPath,
      name,
      detail: `server "${name}" is present in the target but absent from the source`,
    });
  }

  actions.push(...mcpWarningsOf(adapter, desired));
  return sortActions(actions);
}

/**
 * Transports a target cannot express are reported as `unsupported` actions by
 * the adapter that knows about them (VS Code and `sse` — SPEC §4). The
 * `Adapter` interface has no warning channel, so the capability is discovered
 * structurally rather than by naming the target here.
 */
function mcpWarningsOf(
  adapter: Adapter,
  servers: Readonly<Record<string, McpServer>>,
): Action[] {
  const candidate = adapter as Adapter & {
    mcpWarnings?: (servers: Readonly<Record<string, McpServer>>) => Action[];
  };
  if (typeof candidate.mcpWarnings !== "function") return [];
  return candidate.mcpWarnings(servers);
}

function firstPath(adapter: Adapter, paths: readonly string[]): string {
  const first = paths[0];
  if (first !== undefined) return first;
  const configured = adapter.paths().mcp;
  return isUnsupported(configured) ? "" : configured;
}

/* ----------------------------- agents ---------------------------- */

/**
 * Agent files are one file per agent, so `delete` is a real file removal — but
 * only for a target that *owns* its agent directory. VS Code reads copilot-cli's
 * directory (SPEC §4); planning deletions there would propose removing files
 * another target legitimately owns.
 */
function planAgents(adapter: Adapter, ctx: SourceContext): Action[] {
  const agents = agentsForTarget(ctx.agents, adapter.id, ctx.enabled);
  const edits = adapter.renderAgents(agents);
  // SPEC §10.4: a target that cannot express agents says so, with its reason.
  // Treating the refusal as an empty plan would let `plan` report "in sync"
  // about files it never looked at.
  if (isUnsupported(edits)) {
    return [
      unsupportedAction(
        adapter.id,
        "agent",
        unsupportedDetail(adapter, "agent", `${adapter.id} does not support custom agents`),
      ),
    ];
  }
  const owns = adapter.capabilities.sharesDiscoveryWith === undefined;
  const agentsDir = adapter.paths().agentsDir;
  const ext = adapter.capabilities.agentExtension;

  const states = new Map<string, FileState>();
  for (const edit of edits) {
    states.set(pathKey(edit.path), { path: edit.path, content: readTextFile(edit.path) });
  }

  if (owns && !isUnsupported(agentsDir)) {
    for (const fileName of listFiles(agentsDir, ext)) {
      const filePath = path.join(agentsDir, fileName);
      const key = pathKey(filePath);
      if (states.has(key)) continue;
      states.set(key, { path: filePath, content: readTextFile(filePath) });
    }
  }

  return diffFiles({
    target: adapter.id,
    asset: "agent",
    desired: edits,
    actual: [...states.values()],
    reportDeletes: owns,
    nameOf: (filePath) => agentNameOf(filePath, ext),
  });
}

function agentNameOf(filePath: string, ext: string): string | undefined {
  const base = path.basename(filePath);
  return base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

/* ---------------------------- commands --------------------------- */

/** SPEC §10.2: command files are plain `.md`, in every target that has them. */
const COMMAND_EXT = ".md";

/**
 * Commands are one file per command, in a directory the target owns outright
 * (SPEC §10.2) — so, like agents, a file the source no longer knows about is a
 * real `delete`, downgraded to `preserve` unless this run is pruning.
 *
 * Only opencode carries them. Everywhere else `renderCommands` answers
 * `"unsupported"`, and that is what the plan says: SPEC §10.6 has the console
 * showing a COMMANDS tab for every target, and an empty list there would read
 * as "nothing to do" rather than "this target has no such thing".
 */
function planCommands(adapter: Adapter, ctx: SourceContext): Action[] {
  const commands = commandsForTarget(ctx.commands, adapter.id, ctx.enabled);
  const edits = adapter.renderCommands(commands);
  if (isUnsupported(edits)) {
    return [
      unsupportedAction(
        adapter.id,
        "command",
        unsupportedDetail(adapter, "command", `${adapter.id} does not support commands`),
      ),
    ];
  }

  const commandsDir = adapter.paths().commandsDir;
  const states = new Map<string, FileState>();
  for (const edit of edits) {
    states.set(pathKey(edit.path), { path: edit.path, content: readTextFile(edit.path) });
  }
  if (!isUnsupported(commandsDir)) {
    for (const fileName of listFiles(commandsDir, COMMAND_EXT)) {
      const filePath = path.join(commandsDir, fileName);
      const key = pathKey(filePath);
      if (states.has(key)) continue;
      states.set(key, { path: filePath, content: readTextFile(filePath) });
    }
  }

  return diffFiles({
    target: adapter.id,
    asset: "command",
    desired: edits,
    actual: [...states.values()],
    reportDeletes: true,
    nameOf: (filePath) => {
      const base = path.basename(filePath);
      return base.endsWith(COMMAND_EXT) ? base.slice(0, -COMMAND_EXT.length) : base;
    },
  });
}


/**
 * The reason an adapter gives for refusing an asset kind, or a generic
 * sentence. SPEC §10.4 asks for the reason to be visible in `plan`; adapters
 * that have nothing specific to add simply do not implement the hook.
 */
function unsupportedDetail(adapter: Adapter, asset: AssetKind, fallback: string): string {
  return adapter.unsupportedReason?.(asset) ?? fallback;
}

function pathKey(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** Print an action list the way both `plan` and `apply --dry-run` show it. */
export function printActions(actions: readonly Action[], io: CommandIo): void {
  if (actions.length === 0) {
    io.out("No changes. The environment matches the source of truth.");
    return;
  }

  let currentTarget: TargetId | undefined;
  for (const action of actions) {
    if (action.target !== currentTarget) {
      if (currentTarget !== undefined) io.out();
      io.out(`[${action.target}]`);
      currentTarget = action.target;
    }
    const name = action.name !== undefined ? ` ${action.name}` : "";
    io.out(`  ${action.kind.padEnd(11)} ${action.asset.padEnd(5)}${name}`);
    io.out(`              ${action.path === "" ? "(no file)" : action.path}`);
    io.out(`              ${action.detail}`);
  }

  const summary = summarizeActions(actions);
  const parts = Object.entries(summary)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}=${count}`);
  io.out();
  io.out(`Summary: ${parts.join(" ")}`);
  // `unsupported` entries are notes, not differences: a plan made only of them
  // still exits 0, so say so rather than leaving the reader to infer it.
  if (!hasChanges(actions)) {
    io.out("No changes. The environment matches the source of truth.");
  }
}

/* ------------------------------------------------------------------ */
/* Command                                                             */
/* ------------------------------------------------------------------ */

/** `am plan`. Returns the SPEC §5 exit code (0 = no diff, 1 = diff). */
export function runPlan(options: PlanOptions = {}): 0 | 1 {
  const io = options.io ?? consoleIo;
  const ctx = loadSourceContext();
  const actions = computeActions(ctx, { prune: options.prune === true });
  printActions(actions, io);
  return planExitCode(actions);
}
