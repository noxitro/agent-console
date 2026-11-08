/**
 * Find the git repository a folder belongs to, by reading `.git` — git itself
 * is never started (ARCHITECTURE.md「プロジェクトの発見」).
 *
 * Design §5.1 asked for `git rev-parse --show-toplevel` and `git worktree list`.
 * That is two processes per candidate folder, and spawning on Windows costs
 * tens of milliseconds each, which puts ~100 candidates near the S16 limit of
 * 10 seconds. Everything those two commands answer here is written in the
 * repository's own files:
 *
 *  - `<dir>/.git` is a **directory** in an ordinary checkout. That `<dir>` is
 *    the top level.
 *  - It is a **file** (`gitdir: <path>`) in a linked worktree and in a
 *    submodule. A worktree's gitdir is `<common>/worktrees/<name>` and holds a
 *    `commondir` file pointing back at `<common>`; the main checkout is the
 *    folder that contains `<common>` when `<common>` is called `.git`.
 *  - A submodule's gitdir has no `commondir`: it is its own repository.
 *
 * Anything that does not fit (a bare repository, an unreadable `.git`) is
 * reported with the folder as its own root rather than guessed at.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface RepoInfo {
  /** The top level of the checkout `dir` is in. */
  root: string;
  /** The main checkout, when `root` is a linked worktree; otherwise `root`. */
  mainRoot: string;
  isWorktree: boolean;
}

const MAX_DEPTH = 64;

/** The repository `dir` is in, or `null` when no `.git` is found above it. */
export function findRepo(dir: string): RepoInfo | null {
  let current = path.resolve(dir);
  for (let i = 0; i < MAX_DEPTH; i++) {
    const dotGit = path.join(current, ".git");
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = null;
    }
    if (st !== null) {
      if (st.isDirectory()) return { root: current, mainRoot: current, isWorktree: false };
      if (st.isFile()) return fromGitFile(current, dotGit);
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function fromGitFile(root: string, dotGit: string): RepoInfo {
  const self: RepoInfo = { root, mainRoot: root, isWorktree: false };
  let text: string;
  try {
    text = fs.readFileSync(dotGit, "utf8");
  } catch {
    return self;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (match === null || match[1] === undefined) return self;
  const gitDir = path.resolve(root, match[1]);
  let commonRel: string;
  try {
    commonRel = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
  } catch {
    return self; // a submodule, or a gitdir we cannot read: its own repository
  }
  if (commonRel === "") return self;
  const common = path.resolve(gitDir, commonRel);
  if (path.basename(common).toLowerCase() !== ".git") return self; // bare: no main checkout
  return { root, mainRoot: path.dirname(common), isWorktree: true };
}
