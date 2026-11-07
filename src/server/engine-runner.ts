/**
 * Running the engine inside the server process (docs/ARCHITECTURE.md「全体構成」).
 *
 * The CLI's `main(argv, { io })` is called directly with a buffering sink, so
 * the browser reads exactly the bytes `ac <args> --json` would print — the same
 * binary, the same JSON contract, the same exit code (PRODUCT: "CLI と GUI は
 * 同じ真実"). No child process is started, so no `.bat` shim can re-parse the
 * arguments. The calls are made on the engine's own thread
 * (`engine-worker.ts`), one at a time.
 */

import { createHash } from "node:crypto";

import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import { main } from "../cli.js";
import { bufferIo } from "../commands/context.js";

/** What one engine run produced — the wire shape the UI's transport expects. */
export interface AmOutput {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run `ac <args> --json` in-process. `args` must already be validated. */
export function runEngine(args: readonly string[]): AmOutput {
  const io = bufferIo();
  let code: number;
  try {
    code = main(["node", "cli.js", ...args, "--json"], { io });
  } catch (err) {
    // `main` maps every error to exit 2 itself; this is the belt to its braces.
    const message = (err as Error).message ?? String(err);
    return { stdout: JSON.stringify({ error: { message } }), stderr: `error: ${message}`, code: 2 };
  }
  return { stdout: io.lines.join("\n"), stderr: io.errors.join("\n"), code };
}

/**
 * The digest of a plan reading: what was asked (`plan` / `plan --prune`), the
 * exit code, and the **operations** the engine listed. An `apply` is executed
 * only when a fresh plan taken at execution time has the same digest as the one
 * the browser showed in its confirmation dialog.
 *
 * An operation is its kind, target, asset type, asset, path and description,
 * plus a hash of the text it would read and write — except for MCP actions.
 * Those rewrite configuration files other programs also write (`~/.claude.json`,
 * Copilot's `mcp-config.json`, VS Code's `mcp.json`, `opencode.json`), and
 * their before/after carry the whole file: Claude Code bumping its own counters
 * while the dialog is open would otherwise make every MCP apply stale. For
 * those, only the server table the engine manages is taken from `after`
 * (`mcpServers`, `servers` or `mcp`), so a changed server definition is still
 * noticed while the rest of the file is not.
 *
 * Output that is not a plan (an error envelope) is hashed as it is.
 */
export function planDigest(planArgs: readonly string[], output: AmOutput): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(planArgs))
    .update("\n")
    .update(String(output.code))
    .update("\n");
  let actions: unknown;
  try {
    actions = (JSON.parse(output.stdout) as { actions?: unknown }).actions;
  } catch {
    actions = undefined;
  }
  if (!Array.isArray(actions)) return hash.update(output.stdout).digest("hex");
  const short = (text: unknown): string | null =>
    typeof text === "string" ? createHash("sha256").update(text).digest("hex") : null;
  /** The managed server table of a shared MCP file's new text; the whole text if it cannot be read. */
  const managed = (text: unknown): string | null => {
    if (typeof text !== "string") return null;
    const errors: ParseError[] = [];
    const doc = parseJsonc(text, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
    if (errors.length > 0 || typeof doc !== "object" || doc === null) return short(text);
    for (const key of ["mcpServers", "servers", "mcp"]) {
      if (key in doc) return short(`${key}:${JSON.stringify(doc[key])}`);
    }
    return short("none");
  };
  const operations = actions.map((raw) => {
    const a = raw as Record<string, unknown>;
    const shared = a["assetType"] === "mcp";
    return [
      a["kind"],
      a["target"],
      a["assetType"],
      a["asset"],
      a["path"],
      a["detail"],
      shared ? null : short(a["before"]),
      shared ? managed(a["after"]) : short(a["after"]),
      a["previewOmitted"] ?? null,
    ];
  });
  return hash.update(JSON.stringify(operations)).digest("hex");
}
