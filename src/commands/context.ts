/**
 * Shared plumbing for the five commands (SPEC §5).
 *
 * Three things every command needs and none of them should re-invent:
 *  - an output sink (so tests can capture what a command prints),
 *  - the loaded source of truth + enabled targets,
 *  - the adapter instances for those targets.
 *
 * Nothing here writes. Commands that write (`import` into the source,
 * `apply` into the targets) do so explicitly in their own module.
 */

import { createClaudeAdapter } from "../adapters/claude.js";
import { createCopilotCliAdapter } from "../adapters/copilot-cli.js";
import { createOpencodeAdapter } from "../adapters/opencode.js";
import { createVs2026Adapter } from "../adapters/vs2026.js";
import { VscodeAdapter } from "../adapters/vscode.js";
import type { Adapter } from "../adapters/types.js";
import { enabledTargets, readManifest } from "../core/manifest.js";
import {
  agentsForDelivery,
  commandsForDelivery,
  serversForDelivery,
  type AgentDef,
  type CommandDef,
  type LinkMode,
  type Manifest,
  type McpServer,
  type SkillRef,
  type TargetId,
} from "../core/model.js";
import {
  readSourceAgents,
  readSourceCommands,
  readSourceServers,
  readSourceSkills,
} from "../core/source.js";

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

/** Where a command writes its human-readable output. */
export interface CommandIo {
  out(line?: string): void;
  err(line: string): void;
}

/** The real console. Commands default to this; tests inject a buffer. */
export const consoleIo: CommandIo = {
  out(line = ""): void {
    process.stdout.write(`${line}\n`);
  },
  err(line: string): void {
    process.stderr.write(`${line}\n`);
  },
};

/** An in-memory sink, for tests and for buffering. */
export function bufferIo(): CommandIo & { lines: string[]; errors: string[]; text(): string } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out(line = ""): void {
      lines.push(line);
    },
    err(line: string): void {
      errors.push(line);
    },
    text(): string {
      return lines.join("\n");
    },
  };
}

/* ------------------------------------------------------------------ */
/* Adapters                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build the adapter for a target.
 *
 * `linkMode` is threaded in from the manifest rather than read again inside
 * each adapter, so one command run cannot observe two different link modes.
 */
export function createAdapter(target: TargetId, linkMode: LinkMode): Adapter {
  switch (target) {
    case "claude":
      return createClaudeAdapter({ linkMode });
    case "copilot-cli":
      return createCopilotCliAdapter({ linkMode });
    case "vscode":
      return new VscodeAdapter();
    case "vs2026":
      return createVs2026Adapter();
    case "opencode":
      return createOpencodeAdapter();
  }
}

/** Adapters for `targets`, in canonical order. */
export function createAdapters(
  targets: readonly TargetId[],
  linkMode: LinkMode,
): Adapter[] {
  return targets.map((target) => createAdapter(target, linkMode));
}

/* ------------------------------------------------------------------ */
/* Source context                                                      */
/* ------------------------------------------------------------------ */

/** Everything the source of truth says, loaded once per command run. */
export interface SourceContext {
  manifest: Manifest;
  /** Enabled target ids, canonical order (SPEC §2). */
  enabled: TargetId[];
  /**
   * Servers the source of truth wants delivered — `manifest.mcp.exclude`
   * already applied (SPEC §9.1). A disabled server is absent from here, which
   * is precisely what makes it stop being written; the entry in
   * `mcp/servers.json` is untouched.
   */
  servers: Record<string, McpServer>;
  /** Agents to deliver, with `manifest.agents.exclude` applied (SPEC §9.1). */
  agents: AgentDef[];
  /** Commands to deliver, with `manifest.commands.exclude` applied (SPEC §10.5). */
  commands: CommandDef[];
  /** Every skill in the source; `manifest.skills.exclude` is applied per-target. */
  skills: SkillRef[];
  adapters: Adapter[];
}

/**
 * Read the manifest and every source artefact. Read-only, and it throws on
 * malformed input (SPEC §6.3) so no command proceeds on a half-understood
 * source.
 */
export function loadSourceContext(): SourceContext {
  const manifest = readManifest();
  const enabled = enabledTargets(manifest);
  return {
    manifest,
    enabled,
    servers: serversForDelivery(readSourceServers(), manifest.mcp.exclude),
    agents: agentsForDelivery(readSourceAgents(), manifest.agents.exclude),
    commands: commandsForDelivery(readSourceCommands(), manifest.commands.exclude),
    skills: readSourceSkills(),
    adapters: createAdapters(enabled, manifest.skills.linkMode),
  };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** Render a fixed-width table: header row, rule, then the body. */
export function formatTable(headers: readonly string[], rows: readonly string[][]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length), 0),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? cell.length))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
}

/** `label: value` lines with the labels aligned. */
export function formatPairs(pairs: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(0, ...pairs.map(([label]) => label.length));
  return pairs.map(([label, value]) => `${`${label}:`.padEnd(width + 1)} ${value}`);
}
