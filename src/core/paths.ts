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

/* ------------------------------------------------------------------ */
/* Scopes and projects (ARCHITECTURE.md「単位とプロジェクト」, P2)      */
/* ------------------------------------------------------------------ */

/** `~/.agent-console/projects.json` — pinned / hidden / manually added projects (this PC only). */
export function projectsSettingsPath(): string {
  return path.join(consoleRoot(), "projects.json");
}

/** `~/.agent-console/cache/` — rebuildable caches. Deleting it loses nothing. */
export function consoleCacheDir(): string {
  return path.join(consoleRoot(), "cache");
}

/** `~/.agent-console/cache/projects.json` — what discovery read from the harnesses' records. */
export function projectsCachePath(): string {
  return path.join(consoleCacheDir(), "projects.json");
}

/**
 * Temporary directories, which project discovery never offers as a project.
 *
 * Under `AC_HOME` the real `%TEMP%` is ignored for the same reason as
 * {@link appDataDir}: a test's fake HOME lives *inside* the real temp
 * directory, and excluding it would exclude every fixture project.
 */
export function tempDirs(): string[] {
  const home = envOverride("HOME");
  if (home !== undefined) return [path.join(path.resolve(home), "AppData", "Local", "Temp")];
  const dirs = [os.tmpdir()];
  const local = process.env["LOCALAPPDATA"];
  if (local !== undefined && local.trim() !== "") dirs.push(path.join(local, "Temp"));
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

/** `C:\Windows` (or `%SystemRoot%`); `null` off Windows or under `AC_HOME`. */
export function systemRootDir(): string | null {
  if (envOverride("HOME") !== undefined) return null;
  if (process.platform !== "win32") return null;
  return path.resolve(process.env["SystemRoot"] ?? "C:\\Windows");
}

/** `~/.claude/settings.json` (user scope). Only plugin and skill keys are read. */
export function claudeSettingsPath(): string {
  return path.join(claudeHome(), "settings.json");
}

/** `~/.claude/CLAUDE.md` — Claude's user instructions. */
export function claudeUserInstructionsPath(): string {
  return path.join(claudeHome(), "CLAUDE.md");
}

/** `~/.claude/rules/` — user-level rule files. */
export function claudeUserRulesDir(): string {
  return path.join(claudeHome(), "rules");
}

/** `~/.claude/commands/` — Claude's own slash commands (read for display only). */
export function claudeCommandsDir(): string {
  return path.join(claudeHome(), "commands");
}

/** `~/.claude/skills/synced/` — skills synced from claude.ai, one bucket per account. */
export function claudeSyncedSkillsDir(): string {
  return path.join(claudeSkillsDir(), "synced");
}

/** `~/.claude/projects/` — one transcript directory per project (its name encodes the path). */
export function claudeTranscriptsDir(): string {
  return path.join(claudeHome(), "projects");
}

/** `~/.claude/plugins/installed_plugins.json` */
export function claudeInstalledPluginsPath(): string {
  return path.join(claudeHome(), "plugins", "installed_plugins.json");
}

/** `~/.copilot/settings.json` (user scope). Only plugin, skill and MCP keys are read. */
export function copilotSettingsPath(): string {
  return path.join(copilotHome(), "settings.json");
}

/** `~/.copilot/copilot-instructions.md` — Copilot's user instructions. */
export function copilotUserInstructionsPath(): string {
  return path.join(copilotHome(), "copilot-instructions.md");
}

/** `~/.copilot/instructions/` — user-level `*.instructions.md`. */
export function copilotUserInstructionsDir(): string {
  return path.join(copilotHome(), "instructions");
}

/** `~/.copilot/installed-plugins/` — `<marketplace>/<plugin>/` and `_direct/<id>/`. */
export function copilotInstalledPluginsDir(): string {
  return path.join(copilotHome(), "installed-plugins");
}

/** `~/.copilot/session-state/` — one directory per session (`events.jsonl`, `workspace.yaml`). */
export function copilotSessionStateDir(): string {
  return path.join(copilotHome(), "session-state");
}

/** `~/.agents/skills/` read as a discovery location (the same directory as {@link sourceSkillsDir}). */
export function agentsSkillsDir(): string {
  return sourceSkillsDir();
}

/**
 * Every place inside a project root that the scope layer reads.
 *
 * Kept here so the rule "paths are decided only in paths.ts" holds for
 * project-relative locations too.
 */
export function projectPaths(root: string) {
  const j = (...parts: string[]): string => path.join(root, ...parts);
  return {
    claudeMd: j("CLAUDE.md"),
    dotClaudeMd: j(".claude", "CLAUDE.md"),
    claudeLocalMd: j("CLAUDE.local.md"),
    agentsMd: j("AGENTS.md"),
    geminiMd: j("GEMINI.md"),
    claudeRulesDir: j(".claude", "rules"),
    claudeSkillsDir: j(".claude", "skills"),
    claudeAgentsDir: j(".claude", "agents"),
    claudeCommandsDir: j(".claude", "commands"),
    claudeSettings: j(".claude", "settings.json"),
    claudeSettingsLocal: j(".claude", "settings.local.json"),
    mcpJson: j(".mcp.json"),
    githubMcpJson: j(".github", "mcp.json"),
    copilotInstructions: j(".github", "copilot-instructions.md"),
    githubInstructionsDir: j(".github", "instructions"),
    githubSkillsDir: j(".github", "skills"),
    agentsSkillsDir: j(".agents", "skills"),
    githubAgentsDir: j(".github", "agents"),
    copilotRepoSettings: j(".github", "copilot", "settings.json"),
    copilotLocalSettings: j(".github", "copilot", "settings.local.json"),
  };
}
export type ProjectPaths = ReturnType<typeof projectPaths>;
