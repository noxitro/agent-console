/**
 * The single reader for the shared skill discovery root (SPEC §4, §10.7).
 *
 * Three targets discover skills straight from `~/.agents/skills` — the source
 * of truth itself — rather than owning a directory of their own: VS Code and
 * VS 2026 (SPEC §4) and, since the §10.7 revision, opencode. None of them can
 * plan skill work, because the target that materializes the source root has
 * already done it; what they *can* do is answer inventory's question, "who sees
 * what" (SPEC §5).
 *
 * That question has one correct answer, and SPEC §5 requires the views to agree:
 * two targets reading one directory must never report different contents. The
 * reader therefore lives here once, and the adapters delegate. Before this
 * module existed the classifier was copied into two adapters, and the copies
 * drifted — one listed plain files in the directory while the other listed only
 * directories, so `inventory` showed a stray `notes.txt` as something opencode
 * saw and VS Code did not. Sharing the code is what makes the invariant hold;
 * `skill-discovery.test.ts` measures that it still does.
 *
 * Reading is deliberately non-destructive in the strongest sense: the listing
 * describes the source of truth, so no caller may derive a `delete` from it.
 * The adapters enforce that by planning nothing (`planSkills()` returns `[]`).
 */

import * as path from "node:path";

import type { SkillLink, SkillLinkKind } from "../core/model.js";
import { inspectPath, listDirNames, readLinkTarget } from "../core/fsops.js";
import { sourceSkillsDir } from "../core/paths.js";

/**
 * What currently sits in the directory the shared-discovery targets read.
 *
 * Only directory-shaped entries are listed, matching what an agent actually
 * loads: a skill is a directory holding `SKILL.md`, so a loose file in the root
 * is not a skill anyone sees, and reporting it would put a row in `inventory`
 * for something no target discovers.
 */
export function readSharedSkillLinks(): SkillLink[] {
  const dir = sourceSkillsDir();
  return listDirNames(dir)
    .map((name) => classifySkillPath(name, path.join(dir, name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Classify what occupies a skill slot.
 *
 * Windows junctions and symlinks are indistinguishable through `lstat`; the
 * `\\?\` prefix that a junction records is the practical discriminator, so a
 * directory link without it is reported as a symlink.
 */
export function classifySkillPath(name: string, target: string): SkillLink {
  const info = inspectPath(target);
  let kind: SkillLinkKind;
  // Absence is the one thing this cannot guess. `inspectPath` reports a failed
  // `lstat` that was not ENOENT/ENOTDIR as `unreadable`, and it comes first:
  // everything below reads `exists: false` as 「無い」, which is exactly the
  // claim we are not entitled to make about a slot we were refused (SPEC §9.7).
  if (info.unreadable !== undefined) {
    kind = "unreadable";
  } else if (!info.exists) {
    kind = "missing";
  } else if (info.isLink) {
    if (info.isBroken) kind = "broken";
    else if (info.isDirectory) kind = isJunctionTarget(info.linkTarget) ? "junction" : "symlink";
    else kind = "file";
  } else if (info.isDirectory) {
    kind = "directory";
  } else {
    kind = "file";
  }

  const link: SkillLink = { name, path: target, kind };
  if (info.unreadable !== undefined) link.unreadable = info.unreadable;
  if (info.isLink) {
    const resolved = readLinkTarget(target) ?? info.linkTarget;
    if (resolved !== undefined && resolved !== null) link.linkTarget = resolved;
  }
  return link;
}

function isJunctionTarget(linkTarget: string | undefined): boolean {
  return linkTarget !== undefined && linkTarget.startsWith("\\\\?\\");
}
