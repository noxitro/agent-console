/**
 * `ac scopes` — the project and local scopes (ARCHITECTURE.md「単位とプロジェクト」).
 *
 * A separate command rather than more fields on `inventory`, for two reasons:
 *
 *  - `inventory` is the user level and nothing else, and its payload is pinned
 *    byte for byte by the JSON snapshots. Keeping the new layer out of it is
 *    what makes 「個人の単位は従来どおり」 a fact the snapshots check rather than
 *    a promise.
 *  - Discovery reads records other harnesses keep (S16) and writes one cache
 *    file. `inventory` touches no file except to read; this command says
 *    plainly that it is the one that keeps `~/.agent-console/projects-cache.json`.
 *
 * Read-only otherwise, and it always exits 0: a location it could not read is
 * reported in `faults`, not turned into a failed survey (the user level is
 * still worth seeing).
 */

import { TARGET_IDS } from "../core/model.js";
import { readManifest } from "../core/manifest.js";
import { sourceAgentsDir, sourceCommandsDir, sourceMcpPath, sourceSkillsDir } from "../core/paths.js";
import { discoverProjects, type DiscoveryFault, type ProjectSource } from "../core/projects.js";
import {
  PRECEDENCE_RULES,
  SCOPE_LOCATIONS,
  listScopes,
  type Confidence,
  type Scope,
  type ScopeFault,
  type ScopedAsset,
  type UserShadow,
} from "../core/scopes.js";
import type { AssetKind } from "../core/diff.js";
import type { TargetId } from "../core/model.js";
import { consoleIo, createAdapter, formatTable, type CommandIo } from "./context.js";

export interface JsonProject {
  root: string;
  sources: ProjectSource[];
}

export interface JsonScopeLocation {
  target: TargetId;
  assetType: AssetKind;
  scope: Exclude<Scope, "user">;
  label: string;
  confidence: Confidence;
  basis: string;
}

export interface JsonPrecedence {
  target: TargetId;
  assetType: AssetKind;
  order: Scope[];
  confidence: Confidence;
  /** Only rules marked 公式 decide what is shown as overridden. */
  applied: boolean;
  basis: string;
}

export interface ScopesJson {
  /**
   * Where the user level (個人) of each kind comes from: the source of truth
   * this tool distributes. The console shows it in the scope column of a 個人
   * row; inventory's payload is left exactly as it was.
   */
  userSources: Record<AssetKind, string>;
  projects: JsonProject[];
  discovery: {
    cached: boolean;
    missing: number;
    outsideGit: number;
    faults: DiscoveryFault[];
  };
  assets: ScopedAsset[];
  shadows: UserShadow[];
  faults: ScopeFault[];
  locations: JsonScopeLocation[];
  precedence: JsonPrecedence[];
}

export function buildScopes(): ScopesJson {
  const manifest = readManifest();
  const discovery = discoverProjects();
  const adapters = TARGET_IDS.map((id) => createAdapter(id, manifest.skills.linkMode));
  const listing = listScopes({ projects: discovery.projects, adapters });
  return {
    userSources: {
      skill: sourceSkillsDir(),
      mcp: sourceMcpPath(),
      agent: sourceAgentsDir(),
      command: sourceCommandsDir(),
    },
    projects: discovery.projects.map((p) => ({ root: p.root, sources: [...p.sources] })),
    discovery: {
      cached: discovery.cached,
      missing: discovery.missing,
      outsideGit: discovery.outsideGit,
      faults: discovery.faults,
    },
    assets: listing.assets,
    shadows: listing.shadows,
    faults: listing.faults,
    locations: SCOPE_LOCATIONS.map((l) => ({
      target: l.target,
      assetType: l.assetType,
      scope: l.scope,
      label: l.label,
      confidence: l.confidence,
      basis: l.basis,
    })),
    precedence: PRECEDENCE_RULES.map((r) => ({
      target: r.target,
      assetType: r.assetType,
      order: [...r.order],
      confidence: r.confidence,
      applied: r.confidence === "公式",
      basis: r.basis,
    })),
  };
}

/** `ac scopes --json`. */
export function scopesJson(): { exitCode: 0; payload: ScopesJson } {
  return { exitCode: 0, payload: buildScopes() };
}

const SCOPE_LABEL: Record<Scope, string> = { user: "個人", project: "プロジェクト", local: "ローカル" };

/** `ac scopes`. Always exits 0. */
export function runScopes(options: { io?: CommandIo } = {}): 0 {
  const io = options.io ?? consoleIo;
  const result = buildScopes();
  const d = result.discovery;
  io.out(
    `=== projects (${result.projects.length}) — 実在しない ${d.missing} 件・git 外 ${d.outsideGit} 件を除外${d.cached ? "(キャッシュ)" : ""} ===`,
  );
  for (const fault of d.faults) io.out(`  UNREADABLE ${fault.source}: ${fault.path} — ${fault.message}`);
  for (const project of result.projects) io.out(`  ${project.root}  [${project.sources.join(", ")}]`);

  io.out();
  io.out(`=== assets (${result.assets.length}) ===`);
  if (result.assets.length > 0) {
    for (const line of formatTable(
      ["kind", "name", "scope", "readers", "path"],
      result.assets.map((a) => [
        a.assetType,
        a.name,
        SCOPE_LABEL[a.scope],
        a.readers
          .map((r) => `${r.target}${r.unverified === true ? "?" : ""}${r.shadowedBy !== undefined ? "(上書きされている)" : ""}`)
          .join(" "),
        a.entry !== undefined ? `${a.path} ${a.entry}` : a.path,
      ]),
    )) {
      io.out(`  ${line}`);
    }
  }
  if (result.shadows.length > 0) {
    io.out();
    io.out("=== 個人の資産で、プロジェクトでは上書きされているもの ===");
    for (const s of result.shadows) {
      io.out(`  ${s.target} ${s.assetType} ${s.name} — ${s.project} では ${SCOPE_LABEL[s.by.scope]} が優先`);
    }
  }
  for (const fault of result.faults) {
    io.out(`  UNREADABLE ${fault.target} ${fault.assetType} ${fault.path} — ${fault.message}`);
  }
  return 0;
}
