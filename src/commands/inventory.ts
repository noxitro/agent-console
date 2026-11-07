/**
 * `am inventory` — scan every target's discovery paths and show who sees what
 * (SPEC §5). **Read-only**: it touches no file except to read, and it is the
 * one command that is safe to point at a real HOME without thinking twice
 * (SPEC §8's manual verification gate).
 *
 * Junctions are shown with their destination, because "who sees what" is
 * unanswerable otherwise: two targets listing the same skill name may be
 * looking at one shared directory or at two divergent physical copies.
 */

import { isUnsupported, listCommandsForDisplay, type Adapter } from "../adapters/types.js";
import { enabledTargets, readManifest } from "../core/manifest.js";
import { TARGET_IDS, type SkillLink, type TargetId } from "../core/model.js";
import type { AssetKind } from "../core/diff.js";
import { inspectPath, readLinkTarget } from "../core/fsops.js";
import {
  manifestPath,
  sourceAgentsDir,
  sourceCommandsDir,
  sourceMcpPath,
  sourceRoot,
  sourceSkillsDir,
} from "../core/paths.js";
import {
  readSourceAgents,
  readSourceCommands,
  readSourceServers,
  readSourceSkills,
  skillHasManifest,
} from "../core/source.js";
import {
  consoleIo,
  createAdapter,
  formatPairs,
  formatTable,
  type CommandIo,
} from "./context.js";

export interface InventoryOptions {
  io?: CommandIo;
}

/** `am inventory`. Always exits 0 — it reports, it never judges (SPEC §5). */
export function runInventory(options: InventoryOptions = {}): 0 {
  const io = options.io ?? consoleIo;
  const manifest = readManifest();
  const enabled = new Set<TargetId>(enabledTargets(manifest));

  printSource(io);

  for (const target of TARGET_IDS) {
    io.out();
    const adapter = createAdapter(target, manifest.skills.linkMode);
    printTarget(adapter, enabled.has(target), io);
  }

  return 0;
}

/* ------------------------------------------------------------------ */
/* Source of truth                                                     */
/* ------------------------------------------------------------------ */

function printSource(io: CommandIo): void {
  const manifest = readManifest();
  const skills = readSourceSkills();
  const servers = readSourceServers();
  const agents = readSourceAgents();
  const commands = readSourceCommands();

  io.out("=== source of truth ===");
  for (const line of formatPairs([
    ["root", sourceRoot()],
    ["manifest", `${manifestPath()}${inspectPath(manifestPath()).exists ? "" : " (missing — using defaults)"}`],
    ["linkMode", manifest.skills.linkMode],
    ["exclude", manifest.skills.exclude.length === 0 ? "(none)" : manifest.skills.exclude.join(", ")],
    ["skills", `${sourceSkillsDir()} (${skills.length})`],
    ["mcp", `${sourceMcpPath()} (${Object.keys(servers).length})`],
    ["agents", `${sourceAgentsDir()} (${agents.length})`],
    ["commands", `${sourceCommandsDir()} (${commands.length})`],
  ])) {
    io.out(`  ${line}`);
  }

  if (skills.length > 0) {
    io.out();
    io.out("  skills:");
    for (const line of formatTable(
      ["name", "SKILL.md"],
      skills.map((skill) => [skill.name, skillHasManifest(skill.name) ? "yes" : "MISSING"]),
    )) {
      io.out(`    ${line}`);
    }
  }

  if (Object.keys(servers).length > 0) {
    io.out();
    io.out("  mcp servers:");
    for (const line of formatTable(
      ["name", "transport", "targets"],
      Object.entries(servers).map(([name, server]) => [
        name,
        server.transport,
        server.targets === undefined ? "(all enabled)" : server.targets.join(", "),
      ]),
    )) {
      io.out(`    ${line}`);
    }
  }

  if (agents.length > 0) {
    io.out();
    io.out("  agents:");
    for (const line of formatTable(
      ["name", "model", "targets"],
      agents.map((agent) => [
        agent.name,
        agent.model ?? "-",
        agent.targets === undefined ? "(all enabled)" : agent.targets.join(", "),
      ]),
    )) {
      io.out(`    ${line}`);
    }
  }

  if (commands.length > 0) {
    io.out();
    io.out("  commands:");
    for (const line of formatTable(
      ["name", "agent", "targets"],
      commands.map((command) => [
        command.name,
        command.agent ?? "-",
        command.targets === undefined ? "(all enabled)" : command.targets.join(", "),
      ]),
    )) {
      io.out(`    ${line}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

function printTarget(adapter: Adapter, enabled: boolean, io: CommandIo): void {
  const paths = adapter.paths();
  io.out(`=== ${adapter.id}${enabled ? "" : " (disabled)"} ===`);
  for (const line of formatPairs([
    ["skills", isUnsupported(paths.skillsDir) ? "unsupported" : paths.skillsDir],
    ["mcp", isUnsupported(paths.mcp) ? "unsupported" : paths.mcp],
    ["agents", isUnsupported(paths.agentsDir) ? "unsupported" : paths.agentsDir],
    ["commands", isUnsupported(paths.commandsDir) ? "unsupported" : paths.commandsDir],
    ["agent files", adapter.capabilities.agentExtension],
    [
      "shares discovery with",
      adapter.capabilities.sharesDiscoveryWith ?? "(owns its directories)",
    ],
  ])) {
    io.out(`  ${line}`);
  }

  printTargetSkills(adapter, io);
  printTargetMcp(adapter, io);
  printTargetAgents(adapter, io);
  printTargetCommands(adapter, io);
}

/**
 * "Unsupported" with the reason the adapter gives for it (SPEC §10.4).
 *
 * A bare "unsupported" reads as a gap in this tool; the reason is what makes it
 * a decision the reader can check.
 */
function unsupportedLine(adapter: Adapter, asset: AssetKind): string {
  const reason = adapter.unsupportedReason?.(asset);
  return reason === undefined ? "unsupported" : `unsupported — ${reason}`;
}

function printTargetSkills(adapter: Adapter, io: CommandIo): void {
  const links = adapter.readSkillLinks();
  io.out();
  if (isUnsupported(links)) {
    /*
     * No adapter reaches this today: all five report a listing, the three
     * discovery-path targets by way of `skill-discovery.ts` (SPEC §5). It is
     * kept because `Adapter.readSkillLinks` still admits `Unsupported` and a
     * future target may genuinely have nowhere to look — but the reasonless
     * half is gone. 「shared discovery — nothing to manage」 was what vs2026
     * printed while naming `~/.agents/skills` as its own `skillsDir`, and a
     * refusal with no reason reads as a gap in this tool rather than a
     * decision (SPEC §10.4).
     */
    const reason = adapter.unsupportedReason?.("skill") ?? "no discovery path for this target";
    io.out(`  skills: unsupported — ${reason}`);
    return;
  }
  if (links.length === 0) {
    io.out("  skills: (none)");
    return;
  }
  io.out(`  skills (${links.length}):`);
  for (const line of formatTable(
    ["name", "kind", "destination"],
    links.map((link) => [link.name, link.kind, destinationOf(link)]),
  )) {
    io.out(`    ${line}`);
  }
}

/** For a link, the fully resolved destination; for a real directory, nothing. */
function destinationOf(link: SkillLink): string {
  if (link.kind === "junction" || link.kind === "symlink" || link.kind === "broken") {
    return readLinkTarget(link.path) ?? link.linkTarget ?? "(unresolvable)";
  }
  return "-";
}

function printTargetMcp(adapter: Adapter, io: CommandIo): void {
  const servers = adapter.readMcp();
  io.out();
  if (isUnsupported(servers)) {
    io.out("  mcp: unsupported");
    return;
  }
  const names = Object.keys(servers).sort();
  if (names.length === 0) {
    io.out("  mcp: (none)");
    return;
  }
  io.out(`  mcp (${names.length}):`);
  for (const line of formatTable(
    ["name", "transport", "endpoint"],
    names.map((name) => {
      const server = servers[name];
      return [
        name,
        server?.transport ?? "?",
        server?.command ?? server?.url ?? "-",
      ];
    }),
  )) {
    io.out(`    ${line}`);
  }
}

function printTargetAgents(adapter: Adapter, io: CommandIo): void {
  const agents = adapter.readAgents();
  io.out();
  if (isUnsupported(agents)) {
    io.out(`  agents: ${unsupportedLine(adapter, "agent")}`);
    return;
  }
  if (agents.length === 0) {
    io.out("  agents: (none)");
    return;
  }
  io.out(`  agents (${agents.length}):`);
  for (const line of formatTable(
    ["name", "tools", "model"],
    agents.map((agent) => [
      agent.name,
      agent.tools === undefined ? "-" : agent.tools.join(", "),
      agent.model ?? "-",
    ]),
  )) {
    io.out(`    ${line}`);
  }
}

/**
 * SPEC §10.2 — the target's command files.
 *
 * Read through {@link listCommandsForDisplay}, not `readCommands`: this command
 * only reports, and a single unparseable `command/*.md` used to abort the whole
 * scan (exit 2, nothing printed, every other target included). The scan itself
 * completes; the one file that could not be parsed says so on its own row and
 * leaves its columns empty rather than being filled in with a guess. The
 * judgement stays with `doctor`, which reports the same file as an error.
 */
function printTargetCommands(adapter: Adapter, io: CommandIo): void {
  const commands = listCommandsForDisplay(adapter);
  io.out();
  if (isUnsupported(commands)) {
    io.out(`  commands: ${unsupportedLine(adapter, "command")}`);
    return;
  }
  if (commands.length === 0) {
    io.out("  commands: (none)");
    return;
  }
  io.out(`  commands (${commands.length}):`);
  for (const line of formatTable(
    ["name", "agent", "description"],
    commands.map((command) => [
      command.name,
      command.agent ?? "-",
      command.unreadable === undefined
        ? command.description ?? "-"
        : `UNREADABLE — ${oneLine(command.unreadable)}`,
    ]),
  )) {
    io.out(`    ${line}`);
  }
}

/**
 * Fold a message onto one line so the table stays a table.
 *
 * A YAML parse error arrives with the offending snippet and a caret across
 * several lines; dropped into a cell it makes `formatTable` pad every column to
 * the width of the longest of them. Nothing is cut — the whole message is still
 * here, and `--json` carries it with its line breaks intact.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
