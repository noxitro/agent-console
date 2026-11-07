/**
 * Visual Studio 2026 Copilot adapter (SPEC §4).
 *
 * The matrix row for `vs2026`:
 *
 * | asset  | vs2026                                                          |
 * |--------|-----------------------------------------------------------------|
 * | skills | shared discovery (`~/.claude/skills`, `~/.agents/skills`) — no work |
 * | MCP    | **not supported in v1** — inventory/plan must say `"unsupported"` |
 * | agents | `~/.github/agents/<name>.agent.md`, copilot frontmatter dialect  |
 *
 * So this adapter has exactly one real *write* job: agent files. Everything else
 * is a deliberate no-op, and the no-ops are the interesting part of the contract
 * — they must be *loud* (MCP: an explicit refusal with a reason) or *inert*
 * (skills: the directory is reported, and nothing is ever planned against it),
 * never silently plausible.
 *
 * Per SPEC §7 this module never writes and never hard-codes a path; every path
 * comes from `core/paths.ts` and every write is planned for `commands/apply.ts`.
 */

import {
  assertValidAgentName,
  type AgentDef,
  type CommandDef,
  type FileEdit,
  type McpServer,
  type SkillLink,
  type SkillRef,
} from "../core/model.js";
import { unsupportedAction, type Action } from "../core/diff.js";
import { parseAgentFile, renderAgentFile } from "../core/frontmatter.js";
import { listFiles, readTextFile } from "../core/fsops.js";
import { sourceSkillsDir, vs2026AgentPath, vs2026AgentsDir } from "../core/paths.js";
import { readSharedSkillLinks } from "./skill-discovery.js";
import {
  UNSUPPORTED,
  type Adapter,
  type AdapterCapabilities,
  type AdapterPaths,
  type SkillAction,
  type Unsupported,
} from "./types.js";

/** SPEC §4: vs2026 agent files carry the `.agent.md` extension. */
export const VS2026_AGENT_EXTENSION = ".agent.md";

/** Explanation surfaced by `inventory` / `plan` for the MCP row (SPEC §4). */
export const VS2026_MCP_UNSUPPORTED_DETAIL =
  "MCP is not supported for Visual Studio 2026 in v1 (no verifiable official spec); servers are neither read nor written";

export const VS2026_CAPABILITIES: AdapterCapabilities = {
  agentExtension: VS2026_AGENT_EXTENSION,
  agentDialect: "copilot",
  /**
   * Empty on purpose: no transport can be delivered because the target has no
   * MCP configuration file this tool is allowed to touch.
   */
  supportedTransports: [],
  /**
   * `sharesDiscoveryWith` is intentionally **not** set. It means "this target
   * reads another target's directory, so nothing is needed at all", which is
   * only half true here: skills are shared discovery, but agents are not — they
   * live in `~/.github/agents` and this adapter really does render them.
   */
};

/**
 * Derive the agent name from a `<name>.agent.md` file name.
 * Returns `undefined` when the file does not carry the expected extension.
 */
export function vs2026AgentNameFromFile(fileName: string): string | undefined {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? fileName;
  if (!base.endsWith(VS2026_AGENT_EXTENSION)) return undefined;
  const name = base.slice(0, -VS2026_AGENT_EXTENSION.length);
  return name === "" ? undefined : name;
}

/**
 * The `unsupported` action `plan` / `inventory` should emit for this target's
 * MCP row, since `renderMcp` cannot express "unsupported" in its return type.
 */
export function vs2026McpUnsupportedAction(): Action {
  return unsupportedAction("vs2026", "mcp", VS2026_MCP_UNSUPPORTED_DETAIL);
}

/**
 * `Adapter` with this target's outcomes narrowed: MCP and commands are
 * statically `"unsupported"`, agents and skill links are statically lists.
 * Callers that hold the concrete adapter therefore need no runtime
 * `isUnsupported` guard.
 */
export interface Vs2026Adapter extends Adapter {
  readMcp(): Unsupported;
  readRawMcp(): Unsupported;
  readAgents(): AgentDef[];
  readCommands(): Unsupported;
  readSkillLinks(): SkillLink[];
}

class Vs2026AdapterImpl implements Vs2026Adapter {
  readonly id = "vs2026" as const;
  readonly capabilities: AdapterCapabilities = VS2026_CAPABILITIES;

  paths(): AdapterPaths {
    return {
      mcp: UNSUPPORTED,
      agentsDir: vs2026AgentsDir(),
      /**
       * Informational for `inventory`: this is the directory VS 2026 discovers
       * skills from — and it is the source of truth itself, which is precisely
       * why no delivery work exists (SPEC §4).
       */
      skillsDir: sourceSkillsDir(),
      // SPEC §10.2: `command` is an opencode-only asset kind.
      commandsDir: UNSUPPORTED,
    };
  }

  /* ---------------- real environment → normalized ---------------- */

  /** SPEC §4: MCP is out of scope for vs2026 in v1. */
  readMcp(): Unsupported {
    return UNSUPPORTED;
  }

  /** SPEC §4: there is no MCP config file to read raw entries from either. */
  readRawMcp(): Unsupported {
    return UNSUPPORTED;
  }

  /**
   * Read `~/.github/agents/*.agent.md` as normalized `AgentDef`s.
   *
   * A missing directory yields `[]`; a file that exists but cannot be parsed
   * throws (SPEC §6.3 — broken input is never treated as empty). Parsing is
   * lenient because files written by hand (or by VS itself) may omit `name`,
   * in which case the file name supplies it.
   */
  readAgents(): AgentDef[] {
    const dir = vs2026AgentsDir();
    const agents: AgentDef[] = [];
    for (const fileName of listFiles(dir, VS2026_AGENT_EXTENSION)) {
      const name = vs2026AgentNameFromFile(fileName);
      if (name === undefined) continue;
      const filePath = vs2026AgentPath(name);
      const text = readTextFile(filePath);
      if (text === null) continue;
      agents.push(
        parseAgentFile(text, { fallbackName: name, sourcePath: filePath, lenient: true }),
      );
    }
    return agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** SPEC §10.2: only opencode carries user-added commands. */
  readCommands(): Unsupported {
    return UNSUPPORTED;
  }

  /**
   * What currently sits in the directory VS 2026 discovers skills from.
   *
   * Shared with every other discovery-path target (SPEC §5: two views of one
   * directory must never disagree) — see `skill-discovery.ts`.
   *
   * This used to return `UNSUPPORTED`, on the stated grounds that a listing of
   * the source directory would let a caller derive a `delete` against the source
   * of truth. It does not. The only route to a skill `delete` is an adapter
   * handing its own listing to `diffSkills`'s `orphans` (`core/diff.ts`), which
   * claude and copilot-cli do for the directories they own; `planSkills` here
   * returns `[]` and never calls it. What the refusal actually produced was the
   * thing SPEC §5 forbids — one directory, three targets, and vs2026 alone
   * answering 「非対応」 while naming that very directory as its `skillsDir`.
   */
  readSkillLinks(): SkillLink[] {
    return readSharedSkillLinks();
  }

  /* ---------------- normalized → real environment ---------------- */

  /**
   * Always `[]`: there is no file to write. Callers must surface
   * {@link vs2026McpUnsupportedAction} instead of interpreting the empty array
   * as "already in sync".
   */
  renderMcp(_servers: Record<string, McpServer>): FileEdit[] {
    void _servers;
    return [];
  }

  /**
   * Render agents in the copilot dialect (`tools` as a YAML array), one file
   * per agent at `~/.github/agents/<name>.agent.md`.
   *
   * Output is sorted by name and canonically formatted so that
   * `render → parse → render` is a fixed point (SPEC §8).
   */
  renderAgents(agents: readonly AgentDef[]): FileEdit[] {
    return [...agents]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => {
        // `vs2026AgentPath` is a bare `path.join`; an unvalidated name such as
        // `../../evil` would write outside `~/.github/agents` (SPEC §3).
        assertValidAgentName(agent.name);
        return {
          path: vs2026AgentPath(agent.name),
          content: renderAgentFile(agent, this.capabilities.agentDialect),
        };
      });
  }

  /** SPEC §10.2: nothing to render — this target has no command directory. */
  renderCommands(_commands: readonly CommandDef[]): Unsupported {
    void _commands;
    return UNSUPPORTED;
  }

  /** SPEC §4: shared discovery — no skill work for this target. */
  planSkills(_skills: readonly SkillRef[]): SkillAction[] {
    void _skills;
    return [];
  }
}

/** Factory (paths are resolved per call, so `AM_HOME` may change between uses). */
export function createVs2026Adapter(): Vs2026Adapter {
  return new Vs2026AdapterImpl();
}

/** Shared instance; stateless, so a singleton is safe. */
export const vs2026Adapter: Vs2026Adapter = createVs2026Adapter();
