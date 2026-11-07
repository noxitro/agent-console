/**
 * The P1 gate, in order (ARCHITECTURE.md「フェーズとゲート」「リスク」):
 *
 *  1. S15 — the server's guards against a real browser.
 *  2. Only if S15 is green: the server-under-load run, then the GUI end-to-end run, which exercises the write
 *     APIs (apply / enable / disable / remove) against a throwaway AC_HOME.
 *
 *   npm run e2e        (after `npm run build` and `npm --prefix ui run build`)
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { REPO } from "./harness.mjs";

function run(file) {
  const result = spawnSync(process.execPath, [path.join(REPO, "e2e", file)], { cwd: REPO, stdio: "inherit" });
  return result.status ?? 1;
}

console.log("== S15: server guards ==");
if (run("s15.e2e.mjs") !== 0) {
  console.log("\nS15 is not green: the write-path GUI run is not started (ARCHITECTURE.md「リスク」).");
  process.exit(1);
}
console.log("\n== Server under load ==");
const load = run("server.e2e.mjs");
console.log("\n== GUI: everything the am GUI could do ==");
const gui = run("gui.e2e.mjs");
process.exit(load === 0 && gui === 0 ? 0 : 1);
