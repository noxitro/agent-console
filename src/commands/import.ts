/**
 * `am import` — lift the existing real environment into the source of truth
 * (SPEC §5). This is the initial-migration command, and the only one that
 * writes into `~/.agents-manager/` and `~/.agents/skills/`. It never writes
 * into a *target*: distributing back out is `apply`'s job (SPEC §7). The one
 * exception is `--move`, which relocates a target's physical skill directory
 * into the source — the directory is gone from the target afterwards.
 *
 * Conflict policy (SPEC §5): when the same asset name exists in more than one
 * target with different content, v1 does **not** guess. Both candidates are
 * printed and the command fails, unless `--prefer <target>` names the winner.
 *
 * Skills are the exception to "import copies things in": a skill is a whole
 * directory, so physical copies found in a target are *proposed* as moves and
 * only actually moved with `--move` (SPEC §5).
 */

import * as fs from "node:fs";

import { isUnsupported, type Adapter, type AdapterImportNote } from "../adapters/types.js";
import {
  defaultManifest,
  enabledTargets,
  readManifest,
  writeManifest,
} from "../core/manifest.js";
import {
  AmError,
  isTargetId,
  isValidAssetName,
  NAME_MAX_LENGTH,
  type AgentDef,
  type CommandDef,
  type McpServer,
  type TargetId,
} from "../core/model.js";
import { renderSourceAgentFile, renderSourceCommandFile } from "../core/frontmatter.js";
import {
  compareDirectories,
  copyDirectory,
  ensureDir,
  inspectPath,
  removePath,
} from "../core/fsops.js";
import type { AssetType, ImportReport } from "../core/report.js";
import { manifestPath, sourceMcpPath, sourceSkillDir, sourceSkillsDir } from "../core/paths.js";
import {
  canonicalServerText,
  validateSourceServer,
  readSourceAgents,
  readSourceCommands,
  readSourceServers,
  readSourceSkills,
  writeSourceAgent,
  writeSourceCommand,
  writeSourceServers,
} from "../core/source.js";
import { consoleIo, createAdapters, type CommandIo } from "./context.js";

export interface ImportOptions {
  /** Winner when two targets disagree about the same asset (SPEC §5). */
  prefer?: string;
  /** Actually move physical skill directories into the source (SPEC §5). */
  move?: boolean;
  io?: CommandIo;
  /**
   * Optional structured record of what was lifted in and what disagreed,
   * filled in as the run proceeds. Supplied by the CLI's `--json` mode and by
   * the GUI; the human-readable output is unaffected by its presence.
   */
  report?: ImportReport;
}

/** `am import`. Returns 0 on success; conflicts throw (CLI → exit 2). */
export function runImport(options: ImportOptions = {}): 0 {
  const io = options.io ?? consoleIo;
  const prefer = parsePrefer(options.prefer);

  const manifest = readManifest();
  const targets = enabledTargets(manifest);
  const adapters = createAdapters(targets, manifest.skills.linkMode);

  ensureManifest(io);

  const servers = importServers(adapters, prefer, io, options.report);
  const agents = importAgents(adapters, prefer, io, options.report);
  const commands = importCommands(adapters, prefer, io, options.report);
  importSkills(adapters, options.move === true, io, options.report);

  writeSourceServers(servers);
  io.out(`  wrote ${sourceMcpPath()} (${Object.keys(servers).length} server(s))`);
  for (const agent of agents) {
    io.out(`  wrote ${writeSourceAgent(agent)}`);
  }
  for (const command of commands) {
    io.out(`  wrote ${writeSourceCommand(command)}`);
  }

  io.out();
  io.out("Import complete. Review the source, then run `am plan`.");
  return 0;
}

function parsePrefer(value: string | undefined): TargetId | undefined {
  if (value === undefined) return undefined;
  if (!isTargetId(value)) {
    throw new AmError(`Unknown target for --prefer: "${value}"`);
  }
  return value;
}

/** A missing manifest is legal but unhelpful; materialize the documented defaults. */
function ensureManifest(io: CommandIo): void {
  if (inspectPath(manifestPath()).exists) return;
  writeManifest(defaultManifest());
  io.out(`  wrote ${manifestPath()} (defaults)`);
}

/* ------------------------------------------------------------------ */
/* Conflict resolution                                                 */
/* ------------------------------------------------------------------ */

interface Candidate<T> {
  target: TargetId;
  value: T;
  /** Canonical text used for equality; identical text ⇒ no conflict. */
  fingerprint: string;
}

/**
 * Reduce the per-target candidates for one asset name to a single value.
 *
 * Identical content across targets is not a conflict — that is the normal case
 * for anything this tool has already distributed. Genuine disagreement is
 * reported with every candidate's target so the user can pick with `--prefer`.
 */
function resolve<T>(
  kind: string,
  assetType: AssetType,
  name: string,
  candidates: readonly Candidate<T>[],
  prefer: TargetId | undefined,
  io: CommandIo,
  report: ImportReport | undefined,
): Candidate<T> {
  const first = candidates[0];
  if (first === undefined) {
    throw new AmError(`Internal error: no candidates for ${kind} "${name}"`);
  }
  const distinct = new Set(candidates.map((c) => c.fingerprint));
  if (distinct.size === 1) return first;

  const targets = candidates.map((c) => c.target);
  if (prefer !== undefined) {
    const preferred = candidates.find((c) => c.target === prefer);
    if (preferred !== undefined) {
      io.out(`  ${kind} "${name}": conflict resolved in favour of ${prefer}`);
      report?.conflicts.push({ assetType, asset: name, targets, resolution: prefer });
      return preferred;
    }
  }

  report?.conflicts.push({ assetType, asset: name, targets });
  io.err(`Conflict: ${kind} "${name}" differs between targets:`);
  for (const candidate of candidates) {
    io.err(`  --- ${candidate.target} ---`);
    for (const line of candidate.fingerprint.split("\n")) io.err(`  ${line}`);
  }
  throw new AmError(
    `${kind} "${name}" has conflicting definitions in ${candidates
      .map((c) => c.target)
      .join(", ")}. Re-run with --prefer <target> to choose one.`,
  );
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Fingerprint ignoring `targets`, which is source-only metadata (SPEC §3).
 *
 * Deep canonical serialization, deliberately **not** a `JSON.stringify`
 * replacer array: a replacer array filters keys at *every* nesting level, so
 * the contents of `env` and `headers` would serialize as `{}` and two servers
 * differing only in an API token would look identical — silently resolving a
 * cross-target conflict SPEC §5 says must be reported.
 */
function serverFingerprint(server: McpServer): string {
  return canonicalServerText(server);
}

/**
 * The same fingerprint with the one distinction an ambiguous reader cannot make
 * erased (SPEC §10.3).
 *
 * opencode stores `http` and `sse` alike as `type: "remote"`, so what it hands
 * back for a remote server is a guess. Two servers that differ *only* in that
 * guess are the same server as far as this target could ever tell, and treating
 * them as disagreeing is how the tool's own `apply` output came to make the next
 * `am import` fail with a permanent cross-target "conflict".
 */
function guessTolerantFingerprint(server: McpServer): string {
  const copy: McpServer = { ...server };
  if (copy.transport === "sse") copy.transport = "http";
  return canonicalServerText(copy);
}

/**
 * Why this asset was refused before anything was written.
 *
 * SPEC §3/§10.2 make the name a schema constraint, and the source path is a
 * bare `path.join` on it, so `writeSourceAgent` / `writeSourceCommand` throw on
 * a name that is not lowercase-hyphen. Those functions run **after**
 * `mcp/servers.json` has been written and, with `--move`, after skill
 * directories have already been relocated — so an ordinary
 * `~/.config/opencode/command/my_thing.md` (opencode imposes no naming rule)
 * ended the initial-migration command at exit 2 with a half-populated source,
 * taking every validly named sibling sorted after it down as well. Checking it
 * here, during collection, is the treatment `importServers` and the
 * description gate below already use: report it, leave it out, keep going.
 */
function invalidNameReason(name: string): string | null {
  return isValidAssetName(name)
    ? null
    : `name is not lowercase alphanumerics and hyphens (≤${NAME_MAX_LENGTH} chars)`;
}

/**
 * Drop candidates that are a guess at something another candidate observed.
 *
 * `resolve` reports any disagreement between targets, which is right when the
 * targets genuinely disagree — the owner edited one of them — and wrong when
 * one target simply could not store the distinction. A guess adds no
 * information next to an observation of the same server, so it does not get to
 * cause a conflict, or to win one.
 *
 * `--prefer <that target>` keeps its candidate: the owner naming a target is a
 * statement about which copy they want, and this function's job is to remove
 * noise, not to overrule an instruction.
 */
function withoutRedundantGuesses(
  candidates: readonly Candidate<McpServer>[],
  isGuess: (candidate: Candidate<McpServer>) => boolean,
  prefer: TargetId | undefined,
): Candidate<McpServer>[] {
  const observed = candidates.filter((c) => !isGuess(c));
  if (observed.length === 0) return [...candidates];
  return candidates.filter((candidate) => {
    if (!isGuess(candidate) || candidate.target === prefer) return true;
    return !observed.some(
      (o) => guessTolerantFingerprint(o.value) === guessTolerantFingerprint(candidate.value),
    );
  });
}

function importServers(
  adapters: readonly Adapter[],
  prefer: TargetId | undefined,
  io: CommandIo,
  report: ImportReport | undefined,
): Record<string, McpServer> {
  const existing = readSourceServers();
  const byName = new Map<string, Candidate<McpServer>[]>();
  const byTarget = new Map<TargetId, Adapter>();

  for (const adapter of adapters) {
    const servers = adapter.readMcp();
    if (isUnsupported(servers)) continue;
    byTarget.set(adapter.id, adapter);
    for (const [name, server] of Object.entries(servers)) {
      const list = byName.get(name) ?? [];
      list.push({ target: adapter.id, value: server, fingerprint: serverFingerprint(server) });
      byName.set(name, list);
    }
  }

  const merged: Record<string, McpServer> = { ...existing };
  for (const name of [...byName.keys()].sort()) {
    const candidates = byName.get(name) ?? [];
    const previous = merged[name];
    const guessed = (candidate: Candidate<McpServer>): boolean =>
      byTarget.get(candidate.target)?.mcpImportIsGuess?.(name, candidate.value) === true;

    // SPEC §10.3: a `remote` entry read back from opencode is a *guess* at the
    // transport, not a reading of it. Two consequences, and neither of them is
    // a disagreement between the owner's targets:
    //
    //  1. A guess that matches the source entry — modulo the very distinction
    //     the target could not record — is not a change. The source keeps its
    //     own definition, `targets` selector included. Overwriting it turned a
    //     source-of-truth `sse` into `http` and silently widened the server's
    //     delivery scope, with no backup to go back to.
    //  2. A guess that matches another target's *observation* is not a
    //     conflict, so it is set aside rather than made to out-vote it. Without
    //     this, `apply` writing one sse server into claude ("type": "sse") and
    //     opencode ("type": "remote") made the next bare `am import` exit 2
    //     forever — aborting agents, commands and skills with it — over a
    //     difference this tool had manufactured itself.
    if (
      previous !== undefined &&
      candidates.every(
        (c) =>
          serverFingerprint(c.value) === serverFingerprint(previous) ||
          (guessed(c) &&
            guessTolerantFingerprint(c.value) === guessTolerantFingerprint(previous)),
      )
    ) {
      continue;
    }

    const winner = resolve(
      "mcp server",
      "mcp",
      name,
      withoutRedundantGuesses(candidates, guessed, prefer),
      prefer,
      io,
      report,
    );
    const chosen = winner.value;

    // The target dialects are lenient by design (a hand-written config may omit
    // `type`, and copilot-cli infers it), so a target can hold a definition the
    // normalized schema rejects — most commonly a stdio server with no
    // `command`. Writing it into `mcp/servers.json` would make every subsequent
    // command, `doctor` included, exit 2 while reading the source back, with no
    // CLI path to repair it. So it is reported and left out, and the rest of the
    // import proceeds (SPEC §6.3).
    const invalid = validateSourceServer(name, chosen);
    if (invalid !== null) {
      io.err(
        `Skipped mcp server "${name}" from ${winner.target}: ${invalid}. It was NOT written to the source; fix it in ${winner.target} and re-run \`am import\`.`,
      );
      report?.rejected.push({
        assetType: "mcp",
        asset: name,
        from: winner.target,
        reason: invalid,
      });
      continue;
    }

    // Keep the source entry (and its `targets` selector) when the imported
    // definition says the same thing — re-importing must not silently widen an
    // asset's delivery scope.
    if (previous !== undefined && serverFingerprint(previous) === serverFingerprint(chosen)) {
      continue;
    }
    // The definition genuinely changed, so it is taken — but `targets` is
    // source-only metadata (SPEC §3) that no target file records, so an
    // imported definition can never carry one and can never contradict one.
    // Dropping it here was the same silent widening the short-circuit above
    // exists to prevent, wearing the other case's clothes.
    merged[name] =
      previous?.targets !== undefined ? { ...chosen, targets: [...previous.targets] } : chosen;
    report?.imported.push({ assetType: "mcp", asset: name, from: winner.target });
    // SPEC §10.3: what the winning target's format could not record travels
    // with the import as a note, never as a silent assumption.
    recordNotes(
      byTarget.get(winner.target),
      (adapter) => adapter.mcpImportNotes?.(name, chosen) ?? [],
      { assetType: "mcp", asset: name, from: winner.target },
      io,
      report,
    );
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

/** Fingerprint ignoring `targets` (source-only metadata, SPEC §3). */
function agentFingerprint(agent: AgentDef): string {
  const copy: AgentDef = { ...agent };
  delete copy.targets;
  return renderSourceAgentFile(copy);
}

function importAgents(
  adapters: readonly Adapter[],
  prefer: TargetId | undefined,
  io: CommandIo,
  report: ImportReport | undefined,
): AgentDef[] {
  const existing = new Map(readSourceAgents().map((agent) => [agent.name, agent]));
  const byName = new Map<string, Candidate<AgentDef>[]>();

  for (const adapter of adapters) {
    const agents = adapter.readAgents();
    if (isUnsupported(agents)) continue;
    for (const agent of agents) {
      if (agent.name === "") continue;
      const list = byName.get(agent.name) ?? [];
      list.push({ target: adapter.id, value: agent, fingerprint: agentFingerprint(agent) });
      byName.set(agent.name, list);
    }
  }

  const out: AgentDef[] = [];
  for (const name of [...byName.keys()].sort()) {
    const candidates = byName.get(name) ?? [];
    const winner = resolve("agent", "agent", name, candidates, prefer, io, report);
    const chosen = winner.value;
    const previous = existing.get(name);

    // Refused here rather than at `writeSourceAgent`, which runs after the MCP
    // write and after `--move` has already relocated skill directories. See
    // {@link invalidNameReason}.
    const badName = invalidNameReason(name);
    if (badName !== null) {
      io.err(
        `Skipped agent "${name}" from ${winner.target}: ${badName} (SPEC §3), and the name is also the source file name. It was NOT written to the source; rename it in ${winner.target} and re-run \`am import\`.`,
      );
      report?.rejected.push({
        assetType: "agent",
        asset: name,
        from: winner.target,
        reason: badName,
      });
      continue;
    }

    if (previous !== undefined && agentFingerprint(previous) === agentFingerprint(chosen)) {
      // Unchanged: keep the source version so `targets` survives a re-import.
      continue;
    }
    if (chosen.description.trim() === "") {
      throw new AmError(
        `Agent "${name}" has no "description"; the normalized schema requires one (SPEC §3). Add it in the target file and re-run.`,
      );
    }
    // `targets` is source-only (SPEC §3) and no target file carries one, so the
    // selector the owner wrote survives a changed definition.
    out.push(
      previous?.targets !== undefined ? { ...chosen, targets: [...previous.targets] } : chosen,
    );
    report?.imported.push({ assetType: "agent", asset: name, from: winner.target });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Commands (SPEC §10.2)                                               */
/* ------------------------------------------------------------------ */

/** Fingerprint ignoring `targets` (source-only metadata, SPEC §10.2). */
function commandFingerprint(command: CommandDef): string {
  const copy: CommandDef = { ...command };
  delete copy.targets;
  return renderSourceCommandFile(copy);
}

/**
 * Lift `command/<name>.md` files out of every target that has them.
 *
 * Today that is opencode alone (SPEC §10.2); the loop is written against the
 * `"unsupported"` sentinel rather than against a target id, so a second
 * command-carrying target would need no change here.
 *
 * A command whose file has no `description`, or whose name is not
 * lowercase-hyphen, is **not** imported: the normalized schema requires both
 * (SPEC §10.2), and either one would make the write throw — the description by
 * bricking `readSourceCommands` for every later command, the name by aborting
 * `writeSourceCommand` outright. Both are checked here, during collection,
 * which is the trap `importServers` avoids the same way (SPEC §6.3): nothing is
 * written until every candidate is known to survive being read back.
 */
function importCommands(
  adapters: readonly Adapter[],
  prefer: TargetId | undefined,
  io: CommandIo,
  report: ImportReport | undefined,
): CommandDef[] {
  const existing = new Map(readSourceCommands().map((command) => [command.name, command]));
  const byName = new Map<string, Candidate<CommandDef>[]>();
  const byTarget = new Map<TargetId, Adapter>();

  for (const adapter of adapters) {
    const commands = adapter.readCommands();
    if (isUnsupported(commands)) continue;
    byTarget.set(adapter.id, adapter);
    for (const command of commands) {
      if (command.name === "") continue;
      const list = byName.get(command.name) ?? [];
      list.push({
        target: adapter.id,
        value: command,
        fingerprint: commandFingerprint(command),
      });
      byName.set(command.name, list);
    }
  }

  const out: CommandDef[] = [];
  for (const name of [...byName.keys()].sort()) {
    const candidates = byName.get(name) ?? [];
    const winner = resolve("command", "command", name, candidates, prefer, io, report);
    const chosen = winner.value;
    const previous = existing.get(name);

    // The trap this function's doc comment already names, for the *name* rather
    // than the description. opencode imposes no naming rule on
    // `command/<name>.md`, so `my_thing.md` and `Deploy.md` are ordinary files
    // there — and each one used to abort the whole import at
    // `writeSourceCommand`, after `mcp/servers.json` was on disk and after
    // `--move` had relocated skill directories. See {@link invalidNameReason}.
    const badName = invalidNameReason(name);
    if (badName !== null) {
      io.err(
        `Skipped command "${name}" from ${winner.target}: ${badName} (SPEC §10.2), and the name is also the source file name. It was NOT written to the source; rename it in ${winner.target} and re-run \`am import\`.`,
      );
      report?.rejected.push({
        assetType: "command",
        asset: name,
        from: winner.target,
        reason: badName,
      });
      continue;
    }

    if (previous !== undefined && commandFingerprint(previous) === commandFingerprint(chosen)) {
      // Unchanged: keep the source version so `targets` survives a re-import.
      continue;
    }
    if (chosen.description.trim() === "") {
      io.err(
        `Skipped command "${name}" from ${winner.target}: the normalized schema requires a "description" (SPEC §10.2). It was NOT written to the source; add one and re-run \`am import\`.`,
      );
      report?.rejected.push({
        assetType: "command",
        asset: name,
        from: winner.target,
        reason: 'missing required "description"',
      });
      continue;
    }
    // `targets` is source-only (SPEC §10.2), so it survives a changed body.
    out.push(
      previous?.targets !== undefined ? { ...chosen, targets: [...previous.targets] } : chosen,
    );
    report?.imported.push({ assetType: "command", asset: name, from: winner.target });
    recordNotes(
      byTarget.get(winner.target),
      (adapter) => adapter.commandImportNotes?.(name, chosen) ?? [],
      { assetType: "command", asset: name, from: winner.target },
      io,
      report,
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Notes (SPEC §10.3)                                                  */
/* ------------------------------------------------------------------ */

/**
 * Record what an import had to assume, rather than what it observed.
 *
 * SPEC §10.3 is explicit that a fact the target's format cannot record must be
 * *reported* — "黙って推測しない". The note goes to the report (for `--json` and
 * the console) and to stdout (for the human running the command); neither is a
 * failure, so nothing here changes the exit code.
 */
function recordNotes(
  adapter: Adapter | undefined,
  collect: (adapter: Adapter) => AdapterImportNote[],
  about: { assetType: AssetType; asset: string; from: TargetId },
  io: CommandIo,
  report: ImportReport | undefined,
): void {
  if (adapter === undefined) return;
  for (const note of collect(adapter)) {
    report?.notes.push({ code: note.code, ...about, detail: note.detail });
    io.out(`  note: ${about.assetType} "${about.asset}" from ${about.from}: ${note.detail}`);
  }
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

/**
 * Physical skill directories living inside a target are candidates to become
 * the source copy. SPEC §5 makes this a *proposal*: moving a directory is not
 * something to do implicitly on a command whose other effects are all
 * confined to `~/.agents-manager/`.
 */
function importSkills(
  adapters: readonly Adapter[],
  move: boolean,
  io: CommandIo,
  report: ImportReport | undefined,
): void {
  const known = new Set(readSourceSkills().map((skill) => skill.name.toLowerCase()));
  const proposals: { name: string; from: string; to: string; target: TargetId }[] = [];

  for (const adapter of adapters) {
    const skillsDir = adapter.paths().skillsDir;
    if (isUnsupported(skillsDir)) continue;
    // A target that discovers the source directory directly owns nothing.
    if (samePath(skillsDir, sourceSkillsDir())) continue;

    const links = adapter.readSkillLinks();
    if (isUnsupported(links)) continue;

    for (const link of links) {
      if (link.kind !== "directory") continue;
      const destination = sourceSkillDir(link.name);
      if (known.has(link.name.toLowerCase())) {
        // SPEC §9.5: "too big to compare" is its own answer, not "differs".
        const comparison = compareDirectories(link.path, destination);
        if (comparison.status === "identical") {
          io.out(`  skill "${link.name}": physical copy in ${adapter.id} matches the source`);
        } else if (comparison.status === "incomparable") {
          io.out(
            `  skill "${link.name}": physical copy in ${adapter.id} could NOT be compared with the source (${comparison.reason} under ${comparison.path})`,
          );
        } else {
          io.out(
            `  skill "${link.name}": physical copy in ${adapter.id} DIFFERS from the source (${link.path}); resolve manually`,
          );
        }
        continue;
      }
      proposals.push({ name: link.name, from: link.path, to: destination, target: adapter.id });
      known.add(link.name.toLowerCase());
    }
  }

  if (proposals.length === 0) return;

  io.out();
  io.out(move ? "Moving skills into the source:" : "Skills that can be moved into the source:");
  for (const proposal of proposals) {
    io.out(`  [${proposal.target}] ${proposal.name}`);
    io.out(`      ${proposal.from}`);
    io.out(`   -> ${proposal.to}`);
    if (move) {
      moveDirectory(proposal.from, proposal.to);
      report?.imported.push({ assetType: "skill", asset: proposal.name, from: proposal.from });
    }
  }
  if (!move) {
    io.out();
    io.out("Re-run with --move to perform the moves.");
  }
}

/** Rename when possible; fall back to copy + remove across volumes. */
function moveDirectory(from: string, to: string): void {
  ensureDir(sourceSkillsDir());
  if (inspectPath(to).exists) {
    throw new AmError(`Refusing to overwrite an existing skill directory: ${to}`, { path: to });
  }
  try {
    fs.renameSync(from, to);
  } catch {
    copyDirectory(from, to);
    removePath(from);
  }
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}
