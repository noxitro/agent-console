/**
 * `manifest.json` read / write / validation (SPEC §2).
 *
 * A missing manifest is legal and yields the documented defaults. A malformed
 * manifest is a hard error (SPEC §6.3) — we never fall back to defaults for a
 * file that exists but cannot be understood, because that would silently
 * discard the user's target configuration on the next `apply`.
 */

import {
  AmError,
  TARGET_IDS,
  isTargetId,
  type LinkMode,
  type Manifest,
  type ManifestVersion,
  type TargetId,
} from "./model.js";
import { readJsonFile, serializeJson, writeFileAtomic } from "./fsops.js";
import { manifestPath } from "./paths.js";

/** The version this build **writes** (SPEC §10.5). */
export const MANIFEST_VERSION = 3;

/**
 * Versions this build **reads**.
 *
 * SPEC §9.1 / §10.5: "v1 / v2 は拒否せず受理し、欠けたキーを空で補完する". A v1
 * file predates `mcp.exclude` / `agents.exclude` and a v2 file predates
 * `commands.exclude`; both are completed with empty lists, so upgrading the tool
 * never turns an existing source of truth into an exit-2 machine. Nothing
 * rewrites the file on its own: it stays at the version it was written with
 * until a command that writes the manifest (`enable` / `disable`) has a reason
 * to touch it.
 */
export const SUPPORTED_MANIFEST_VERSIONS: readonly ManifestVersion[] = [1, 2, 3] as const;

/** The defaults from SPEC §2 + §9.1 + §10.5: every target on, junction links. */
export function defaultManifest(): Manifest {
  return {
    version: MANIFEST_VERSION,
    targets: {
      claude: { enabled: true },
      "copilot-cli": { enabled: true },
      vscode: { enabled: true },
      vs2026: { enabled: true },
      opencode: { enabled: true },
    },
    skills: { linkMode: "junction", exclude: [] },
    mcp: { exclude: [] },
    agents: { exclude: [] },
    commands: { exclude: [] },
  };
}

/**
 * Validate an arbitrary parsed value as a `Manifest`, filling in defaults for
 * omitted optional pieces. Throws `AmError` on anything it cannot accept.
 */
export function validateManifest(value: unknown, sourcePath?: string): Manifest {
  const where = sourcePath !== undefined ? ` (${sourcePath})` : "";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AmError(`manifest.json must be a JSON object${where}`, pathOpt(sourcePath));
  }
  const raw = value as Record<string, unknown>;

  const version = raw["version"];
  if (
    version !== undefined &&
    !(SUPPORTED_MANIFEST_VERSIONS as readonly unknown[]).includes(version)
  ) {
    throw new AmError(
      `Unsupported manifest version ${String(version)}; expected one of ${SUPPORTED_MANIFEST_VERSIONS.join(", ")}${where}`,
      pathOpt(sourcePath),
    );
  }

  const manifest = defaultManifest();
  // The version travels with the parsed value so a v1 file stays v1 until
  // something deliberately writes it out again (SPEC §9.1).
  if (version !== undefined) manifest.version = version as ManifestVersion;

  const targets = raw["targets"];
  if (targets !== undefined) {
    if (typeof targets !== "object" || targets === null || Array.isArray(targets)) {
      throw new AmError(`manifest "targets" must be an object${where}`, pathOpt(sourcePath));
    }
    for (const [key, entry] of Object.entries(targets as Record<string, unknown>)) {
      if (!isTargetId(key)) {
        throw new AmError(
          `Unknown target "${key}" in manifest "targets"${where}`,
          pathOpt(sourcePath),
        );
      }
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new AmError(
          `manifest target "${key}" must be an object${where}`,
          pathOpt(sourcePath),
        );
      }
      const enabled = (entry as Record<string, unknown>)["enabled"];
      if (enabled !== undefined && typeof enabled !== "boolean") {
        throw new AmError(
          `manifest target "${key}".enabled must be a boolean${where}`,
          pathOpt(sourcePath),
        );
      }
      manifest.targets[key] = { enabled: enabled ?? true };
    }
  }

  const skills = raw["skills"];
  if (skills !== undefined) {
    if (typeof skills !== "object" || skills === null || Array.isArray(skills)) {
      throw new AmError(`manifest "skills" must be an object${where}`, pathOpt(sourcePath));
    }
    const skillsRaw = skills as Record<string, unknown>;
    const linkMode = skillsRaw["linkMode"];
    if (linkMode !== undefined) {
      if (linkMode !== "junction" && linkMode !== "copy") {
        throw new AmError(
          `manifest "skills.linkMode" must be "junction" or "copy"${where}`,
          pathOpt(sourcePath),
        );
      }
      manifest.skills.linkMode = linkMode as LinkMode;
    }
    const exclude = skillsRaw["exclude"];
    if (exclude !== undefined) {
      if (!Array.isArray(exclude) || exclude.some((e) => typeof e !== "string")) {
        throw new AmError(
          `manifest "skills.exclude" must be an array of strings${where}`,
          pathOpt(sourcePath),
        );
      }
      manifest.skills.exclude = [...(exclude as string[])];
    }
  }

  // SPEC §9.1. Read on every version: a v1 file that already carries the keys
  // is honoured rather than silently discarded — dropping them would deliver
  // assets the owner had switched off, which is the failure mode this section
  // exists to prevent.
  manifest.mcp.exclude = readExcludeList(raw["mcp"], "mcp", where, sourcePath);
  manifest.agents.exclude = readExcludeList(raw["agents"], "agents", where, sourcePath);
  // SPEC §10.5, same rule one version later: a v1/v2 file simply has no
  // `commands` block, and an empty list is what "nothing excluded" means.
  manifest.commands.exclude = readExcludeList(raw["commands"], "commands", where, sourcePath);

  return manifest;
}

/** Parse a `{ "exclude": [...] }` block. An absent block means "nothing excluded". */
function readExcludeList(
  value: unknown,
  key: string,
  where: string,
  sourcePath?: string,
): string[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AmError(`manifest "${key}" must be an object${where}`, pathOpt(sourcePath));
  }
  const exclude = (value as Record<string, unknown>)["exclude"];
  if (exclude === undefined) return [];
  if (!Array.isArray(exclude) || exclude.some((e) => typeof e !== "string")) {
    throw new AmError(
      `manifest "${key}.exclude" must be an array of strings${where}`,
      pathOpt(sourcePath),
    );
  }
  return [...(exclude as string[])];
}

/**
 * Read the manifest from disk. Returns the defaults when the file does not
 * exist; throws on unparseable or invalid content.
 */
export function readManifest(filePath: string = manifestPath()): Manifest {
  const raw = readJsonFile(filePath);
  if (raw === null) return defaultManifest();
  return validateManifest(raw, filePath);
}

/**
 * Canonical JSON text for a manifest (2-space indent, trailing newline).
 *
 * SPEC §10.5: "書き込み時のみ `version: 3`". Whatever version was read, what is
 * written is the current one — a file this build writes always carries the keys
 * this build fills in, so the version number never claims less than the content.
 */
export function serializeManifest(manifest: Manifest): string {
  const ordered: Manifest = {
    version: MANIFEST_VERSION,
    targets: {
      claude: manifest.targets.claude,
      "copilot-cli": manifest.targets["copilot-cli"],
      vscode: manifest.targets.vscode,
      vs2026: manifest.targets.vs2026,
      opencode: manifest.targets.opencode,
    },
    skills: { linkMode: manifest.skills.linkMode, exclude: sortedUnique(manifest.skills.exclude) },
    mcp: { exclude: sortedUnique(manifest.mcp.exclude) },
    agents: { exclude: sortedUnique(manifest.agents.exclude) },
    commands: { exclude: sortedUnique(manifest.commands.exclude) },
  };
  return serializeJson(ordered);
}

/** Exclude lists are a set, and are stored in a stable order. */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Atomically write the manifest.
 * Only `commands/apply.ts` (and `import`) may call this — SPEC §6.5 forbids
 * writes from read-only commands.
 */
export function writeManifest(manifest: Manifest, filePath: string = manifestPath()): void {
  writeFileAtomic(filePath, serializeManifest(manifest));
}

/** Target ids enabled by the manifest, in canonical order. */
export function enabledTargets(manifest: Manifest): TargetId[] {
  return TARGET_IDS.filter((id) => manifest.targets[id].enabled === true);
}

/** Whether a specific target is enabled. */
export function isTargetEnabled(manifest: Manifest, target: TargetId): boolean {
  return manifest.targets[target].enabled === true;
}

function pathOpt(sourcePath?: string): { path: string } | undefined {
  return sourcePath !== undefined ? { path: sourcePath } : undefined;
}
