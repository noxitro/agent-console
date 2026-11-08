/**
 * All path resolution for agent-console (formerly agents-manager).
 *
 * SPEC §7: "全パス解決(AM_HOME対応)。パスの決め打ちはここ以外禁止"
 * Hard-coding paths anywhere else in the codebase is forbidden — every path
 * used by the CLI must originate from this module.
 *
 * SPEC §1: paths are rooted at `os.homedir()`, but HOME may be overridden with
 * the `AC_HOME` environment variable for testability. The legacy `AM_HOME`
 * (and `AM_APPDATA` / `AM_CONFIG_HOME`) are still read when the `AC_*`
 * variable is unset, so existing scripts and tests keep isolating HOME.
 */

import * as os from "node:os";
import * as path from "node:path";

/**
 * Read an override variable: `AC_<name>` wins, `AM_<name>` is the legacy
 * fallback. Blank values count as unset.
 */
function envOverride(name: "HOME" | "APPDATA" | "CONFIG_HOME"): string | undefined {
  for (const key of [`AC_${name}`, `AM_${name}`]) {
    const value = process.env[key];
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * Resolve the effective home directory.
 *
 * `AM_HOME` wins over `os.homedir()` so tests can build a fake HOME in a temp
 * directory. Read lazily (not cached) so a test may change it between cases.
 */
export function homeDir(): string {
  const override = envOverride("HOME");
  if (override !== undefined) {
    return path.resolve(override);
  }
  return os.homedir();
}

/**
 * Resolve the effective %APPDATA% (Roaming) directory.
 *
 * When `AM_HOME` is set we deliberately ignore the real `APPDATA` so tests
 * cannot leak into (or be polluted by) the user's real VS Code configuration.
 * `AM_APPDATA` may be set explicitly to override both.
 */
export function appDataDir(): string {
  const explicit = envOverride("APPDATA");
  if (explicit !== undefined) {
    return path.resolve(explicit);
  }
  const amHome = envOverride("HOME");
  if (amHome !== undefined) {
    return path.join(path.resolve(amHome), "AppData", "Roaming");
  }
  const appData = process.env["APPDATA"];
  if (appData !== undefined && appData.trim() !== "") {
    return path.resolve(appData);
  }
  return path.join(homeDir(), "AppData", "Roaming");
}

/**
 * Resolve the effective XDG config root (`~/.config`).
 *
 * SPEC §10.1: opencode keeps its global configuration under `~/.config/opencode`
 * on every OS, Windows included, and honours `$XDG_CONFIG_HOME` when it is set.
 *
 * The precedence mirrors {@link appDataDir} for the same reason: when `AM_HOME`
 * is set we deliberately ignore the real `XDG_CONFIG_HOME`, so a test cannot
 * read — or write — the developer's own opencode configuration. `AM_CONFIG_HOME`
 * overrides both.
 */
export function configHomeDir(): string {
  const explicit = envOverride("CONFIG_HOME");
  if (explicit !== undefined) {
    return path.resolve(explicit);
  }
  const amHome = envOverride("HOME");
  if (amHome !== undefined) {
    return path.join(path.resolve(amHome), ".config");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg.trim() !== "") {
    return path.resolve(xdg);
  }
  return path.join(homeDir(), ".config");
}

/** `~/.agent-console/` — PC-local state of agent-console (server lock, settings, cache). */
export function consoleRoot(): string {
  return path.join(homeDir(), ".agent-console");
}

/** `~/.agent-console/server.json` — the running server's lock file (port, PID, token hash). */
export function serverLockPath(): string {
  return path.join(consoleRoot(), "server.json");
}

/**
 * `~/.agent-console/legacy-commands.json` — the owner's list of command names
 * that are stale copies in the source (doctor's `command.legacy`). Optional:
 * no file means no rules.
 */
export function legacyCommandsPath(): string {
  return path.join(consoleRoot(), "legacy-commands.json");
}

/* ------------------------------------------------------------------ */
/* Source of truth (SPEC §2)                                           */
/* ------------------------------------------------------------------ */

/** `~/.agents-manager/` */
export function sourceRoot(): string {
  return path.join(homeDir(), ".agents-manager");
}

/** `~/.agents-manager/manifest.json` */
export function manifestPath(): string {
  return path.join(sourceRoot(), "manifest.json");
}

/** `~/.agents-manager/mcp/servers.json` */
export function sourceMcpPath(): string {
  return path.join(sourceRoot(), "mcp", "servers.json");
}

/** `~/.agents-manager/agents/` */
export function sourceAgentsDir(): string {
  return path.join(sourceRoot(), "agents");
}

/** `~/.agents-manager/agents/<name>.md` */
export function sourceAgentPath(name: string): string {
  return path.join(sourceAgentsDir(), `${name}.md`);
}

/** `~/.agents-manager/commands/` — the source of truth for commands (SPEC §10.2). */
export function sourceCommandsDir(): string {
  return path.join(sourceRoot(), "commands");
}

/** `~/.agents-manager/commands/<name>.md` */
export function sourceCommandPath(name: string): string {
  return path.join(sourceCommandsDir(), `${name}.md`);
}

/** `~/.agents-manager/backups/` */
export function backupsRoot(): string {
  return path.join(sourceRoot(), "backups");
}

/**
 * `~/.agents-manager/backups/<ISO8601ts>/`
 *
 * The timestamp is sanitized for Windows (`:` is illegal in path segments).
 */
export function backupDir(timestamp: Date | string = new Date()): string {
  const iso = typeof timestamp === "string" ? timestamp : timestamp.toISOString();
  return path.join(backupsRoot(), sanitizeTimestamp(iso));
}

/** Turn an ISO8601 timestamp into a Windows-safe directory name. */
export function sanitizeTimestamp(iso: string): string {
  return iso.replace(/:/g, "-");
}

/** `~/.agents/` — the root the external skill installers own. */
export function agentsRoot(): string {
  return path.join(homeDir(), ".agents");
}

/** `~/.agents/skills/` — the source of truth for skills (SPEC §2). */
export function sourceSkillsDir(): string {
  return path.join(agentsRoot(), "skills");
}

/** `~/.agents/skills/<name>/` */
export function sourceSkillDir(name: string): string {
  return path.join(sourceSkillsDir(), name);
}

/** `<skillDir>/SKILL.md` */
export function skillManifestPath(skillDir: string): string {
  return path.join(skillDir, "SKILL.md");
}

/** The name of the lock file the external skill installers write. */
export const SKILL_LOCK_FILE = ".skill-lock.json";

/**
 * `~/.agents/.skill-lock.json` — **one** lock file for every installed skill.
 *
 * Written by `npx skills` (vercel-labs/agent-skills) as a `{ version, skills:
 * { <name>: {...} }, dismissed }` document that sits *beside* `skills/`, not
 * inside each skill directory. An earlier reading of this file looked for a
 * per-skill `<skillDir>/.skill-lock.json`, which never exists on a real
 * machine: every consumer of the lock (skill `origin` in the inventory, the
 * `doctor` lock checks) was therefore dead code in practice. Resolved here so
 * both consumers agree (SPEC §7).
 */
export function skillLockPath(): string {
  return path.join(agentsRoot(), SKILL_LOCK_FILE);
}

/* ------------------------------------------------------------------ */
/* Target: claude (SPEC §4)                                            */
/* ------------------------------------------------------------------ */

/** `~/.claude/` */
export function claudeHome(): string {
  return path.join(homeDir(), ".claude");
}

/** `~/.claude/skills/` */
export function claudeSkillsDir(): string {
  return path.join(claudeHome(), "skills");
}

/** `~/.claude/skills/<name>` */
export function claudeSkillPath(name: string): string {
  return path.join(claudeSkillsDir(), name);
}

/** `~/.claude/agents/` */
export function claudeAgentsDir(): string {
  return path.join(claudeHome(), "agents");
}

/** `~/.claude/agents/<name>.md` */
export function claudeAgentPath(name: string): string {
  return path.join(claudeAgentsDir(), `${name}.md`);
}

/**
 * `~/.claude.json` — a live, large state file.
 * SPEC §6.1: only the top-level `mcpServers` key may be read or written.
 */
export function claudeJsonPath(): string {
  return path.join(homeDir(), ".claude.json");
}

/* ------------------------------------------------------------------ */
/* Target: copilot-cli (SPEC §4)                                       */
/* ------------------------------------------------------------------ */

/** `~/.copilot/` */
export function copilotHome(): string {
  return path.join(homeDir(), ".copilot");
}

/** `~/.copilot/skills/` */
export function copilotSkillsDir(): string {
  return path.join(copilotHome(), "skills");
}

/** `~/.copilot/skills/<name>` */
export function copilotSkillPath(name: string): string {
  return path.join(copilotSkillsDir(), name);
}

/** `~/.copilot/agents/` — shared with the VS Code Copilot extension (SPEC §4). */
export function copilotAgentsDir(): string {
  return path.join(copilotHome(), "agents");
}

/** `~/.copilot/agents/<name>.agent.md` */
export function copilotAgentPath(name: string): string {
  return path.join(copilotAgentsDir(), `${name}.agent.md`);
}

/** `~/.copilot/mcp-config.json` */
export function copilotMcpConfigPath(): string {
  return path.join(copilotHome(), "mcp-config.json");
}

/**
 * `~/.copilot/config.json`
 *
 * SPEC §6.2: this file must never be read or written. Exposed only so callers
 * (e.g. doctor) can recognise and explicitly skip it.
 */
export function copilotSelfManagedConfigPath(): string {
  return path.join(copilotHome(), "config.json");
}

/* ------------------------------------------------------------------ */
/* Target: vscode (SPEC §4)                                            */
/* ------------------------------------------------------------------ */

/** `%APPDATA%/Code/User/` */
export function vscodeUserDir(): string {
  return path.join(appDataDir(), "Code", "User");
}

/** `%APPDATA%/Code/User/mcp.json` — top-level key is `servers`. */
export function vscodeMcpPath(): string {
  return path.join(vscodeUserDir(), "mcp.json");
}

/* ------------------------------------------------------------------ */
/* Target: vs2026 (SPEC §4)                                            */
/* ------------------------------------------------------------------ */

/** `~/.github/agents/` */
export function vs2026AgentsDir(): string {
  return path.join(homeDir(), ".github", "agents");
}

/** `~/.github/agents/<name>.agent.md` */
export function vs2026AgentPath(name: string): string {
  return path.join(vs2026AgentsDir(), `${name}.agent.md`);
}

/* ------------------------------------------------------------------ */
/* Target: opencode (SPEC §10.1)                                       */
/* ------------------------------------------------------------------ */

/** `~/.config/opencode/` (or `$XDG_CONFIG_HOME/opencode/`). */
export function opencodeHome(): string {
  return path.join(configHomeDir(), "opencode");
}

/** `~/.config/opencode/opencode.jsonc` — JSONC; the `mcp` key is ours. */
export function opencodeConfigPath(): string {
  return path.join(opencodeHome(), "opencode.jsonc");
}

/** `~/.config/opencode/command/` — note the **singular** directory name. */
export function opencodeCommandsDir(): string {
  return path.join(opencodeHome(), "command");
}

/** `~/.config/opencode/command/<name>.md` */
export function opencodeCommandPath(name: string): string {
  return path.join(opencodeCommandsDir(), `${name}.md`);
}

/**
 * `~/.config/opencode/agent/` — resolved but **never managed** (SPEC §10.4).
 *
 * Exposed for one purpose: so the `unsupported` explanation can name the
 * directory this tool is deliberately leaving alone, instead of implying no
 * such place exists.
 */
export function opencodeAgentsDir(): string {
  return path.join(opencodeHome(), "agent");
}

/* ------------------------------------------------------------------ */
/* Scopes: projects and their own locations (ARCHITECTURE「単位」)     */
/* ------------------------------------------------------------------ */

/**
 * `~/.agent-console/projects-cache.json` — the project discovery cache (S16).
 *
 * The only file the scope layer writes. It holds project roots and the stamps
 * of the record files they came from, nothing read out of those files besides.
 */
export function projectsCachePath(): string {
  return path.join(consoleRoot(), "projects-cache.json");
}

/**
 * `~/.copilot/session-state/` — Copilot CLI's per-session directories, each with
 * a `workspace.yaml` whose `cwd:` line names the folder it ran in. Only that
 * line is read (the rest holds prompts and summaries).
 */
export function copilotSessionStateDir(): string {
  return path.join(copilotHome(), "session-state");
}

/**
 * `%APPDATA%/Code/User/workspaceStorage/` — one directory per folder VS Code has
 * opened, each with a `workspace.json` whose `folder` is a `file://` URI.
 */
export function vscodeWorkspaceStorageDir(): string {
  return path.join(vscodeUserDir(), "workspaceStorage");
}

/** `<root>/.git` — a directory in a clone, a file in a worktree or submodule. */
export function gitMarkerPath(root: string): string {
  return path.join(root, ".git");
}

/** `<root>/.claude/skills/` — Claude Code's project skills. */
export function projectClaudeSkillsDir(root: string): string {
  return path.join(root, ".claude", "skills");
}

/** `<root>/.claude/agents/` — Claude Code's project subagents. */
export function projectClaudeAgentsDir(root: string): string {
  return path.join(root, ".claude", "agents");
}

/** `<root>/.mcp.json` — project MCP servers (`mcpServers`), read by Claude Code, Copilot CLI and VS Code. */
export function projectRootMcpPath(root: string): string {
  return path.join(root, ".mcp.json");
}

/** `<root>/.agents/skills/` — the cross-tool project skills directory (Copilot CLI, VS Code). */
export function projectAgentsSkillsDir(root: string): string {
  return path.join(root, ".agents", "skills");
}

/** `<root>/.github/skills/` — Copilot's project skills. */
export function projectGithubSkillsDir(root: string): string {
  return path.join(root, ".github", "skills");
}

/** `<root>/.github/agents/` — Copilot's project custom agents (`*.agent.md`). */
export function projectGithubAgentsDir(root: string): string {
  return path.join(root, ".github", "agents");
}

/** `<root>/.vscode/mcp.json` — VS Code's workspace MCP servers (`servers`, JSONC). */
export function projectVscodeMcpPath(root: string): string {
  return path.join(root, ".vscode", "mcp.json");
}

/** `<root>/.github/mcp.json` — Copilot CLI's second project MCP file (`mcpServers`). */
export function projectGithubMcpPath(root: string): string {
  return path.join(root, ".github", "mcp.json");
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

/**
 * Relative path of `target` under `root`, using POSIX separators, or `null`
 * when `target` is not inside `root`. Used to mirror the original path
 * structure inside `backups/<ts>/`.
 */
export function relativeToHome(target: string, root: string = homeDir()): string | null {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}
