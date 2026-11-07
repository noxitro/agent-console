/**
 * opencode adapter (SPEC §10).
 *
 * | asset    | opencode                                                       |
 * |----------|----------------------------------------------------------------|
 * | commands | `~/.config/opencode/command/<name>.md` — **the** target for the |
 * |          | new `command` asset kind (SPEC §10.2)                          |
 * | MCP      | `~/.config/opencode/opencode.jsonc`, key `mcp` (SPEC §10.3)    |
 * | agents   | **unsupported** — semantics do not convert (SPEC §10.4)        |
 * | skills   | discovers `~/.agents/skills` directly — **no work needed**     |
 *
 * Two things make this target different from the other four.
 *
 * **The config file is JSONC.** `opencode.jsonc` is hand-edited and carries
 * comments. Re-serializing the whole document — which is what every other
 * adapter here does — would delete them, and SPEC §10.3 names that outcome for
 * what it is: silent data loss. So writes go through `jsonc-parser`'s
 * `modify()` + `applyEdits()`, one server at a time.
 *
 * What that buys, stated exactly rather than generously: **everything the edit
 * does not cover is carried through untouched** — comments between entries,
 * blank lines, key order, the user's indentation, and every server this run
 * does not change. What it does *not* buy is preservation *inside* a rewritten
 * entry: `modify()` replaces a whole value node, so a comment written between
 * two fields of the one server whose arguments changed goes with it, and an
 * inline array may come back expanded. Nor does it preserve line endings — the
 * document is read through `normalizeText` and written LF-only, as SPEC §6.4
 * requires of every write, so a CRLF file becomes an LF file the first time a
 * managed entry actually changes. Both are visible in the console's diff
 * preview for the entry (`before`/`after`), except the line endings, which are
 * normalized on both sides of the comparison.
 *
 * **One of the four asset kinds is refused on purpose.** SPEC §10.4 spells out
 * why agents cannot be converted (see {@link OPENCODE_AGENTS_UNSUPPORTED_DETAIL});
 * the refusal travels with a reason through
 * {@link OpencodeAdapter.unsupportedReason} so `inventory` and `plan` can say
 * *why*, not merely *no*.
 *
 * **Skills are shared discovery, not refused** (SPEC §10.1, §10.7).
 * opencode reads the cross-agent standard root `~/.agents/skills` directly — the
 * source of truth itself, exactly the arrangement VS Code and VS 2026 already
 * have (SPEC §4). So
 * this adapter reports what the directory holds ({@link readSkillLinks}) so
 * `inventory` can answer "who sees what", plans no work ({@link planSkills} —
 * materializing skills there twice would duplicate the owner's actions), and
 * never derives a delete against the source of truth.
 *
 * Per SPEC §7 this module never writes and never hard-codes a path: every path
 * comes from `core/paths.ts`, and every write is a plan for `commands/apply.ts`.
 */

import * as path from "node:path";

import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";

import {
  AmError,
  assertValidCommandName,
  type AgentDef,
  type CommandDef,
  type FileEdit,
  type McpServer,
  type SkillLink,
  type SkillRef,
  type TargetId,
  type Transport,
} from "../core/model.js";
import { unsupportedAction, type Action, type AssetKind } from "../core/diff.js";
import { parseCommandFile, renderCommandFile } from "../core/frontmatter.js";
import { listFiles, normalizeText, readTextFile } from "../core/fsops.js";
import { readSharedSkillLinks } from "./skill-discovery.js";
import {
  opencodeAgentsDir,
  opencodeCommandPath,
  opencodeCommandsDir,
  opencodeConfigPath,
  sourceSkillsDir,
} from "../core/paths.js";
import {
  UNSUPPORTED,
  type Adapter,
  type AdapterCapabilities,
  type AdapterImportNote,
  type AdapterPaths,
  type CommandListing,
  type McpRenderOptions,
  type SkillAction,
  type Unsupported,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const OPENCODE_TARGET: TargetId = "opencode";

/** The one top-level key of `opencode.jsonc` this tool may touch (SPEC §10.3). */
export const OPENCODE_MCP_KEY = "mcp";

/** SPEC §10.2: command files are plain `.md`. */
export const OPENCODE_COMMAND_EXTENSION = ".md";

/**
 * SPEC §10.4, quoted into the output so the refusal carries its reason.
 *
 * opencode's agent frontmatter is not a dialect of the normalized schema, it is
 * a different model: `tools` is a **map of tool name → boolean**, not an
 * allowlist; `permission` blocks (`bash: {"*": "deny"}`) have no equivalent in
 * either other dialect; `mode` and `temperature` have no counterpart at all.
 * Converting an allowlist into the boolean map would require a table of
 * opencode's own tool vocabulary, and every tool missing from that table would
 * have its permissions changed silently. So we do not convert.
 */
export const OPENCODE_AGENTS_UNSUPPORTED_DETAIL =
  "agents are not managed for opencode (SPEC §10.4): its frontmatter is semantically different — " +
  '"tools" is a name→boolean map rather than an allowlist, and the "permission" block has no ' +
  "equivalent in the claude/copilot dialects — so no safe conversion exists; " +
  "the agent directory is left untouched";

/**
 * SPEC §10.3: `http` and `sse` both render as `type: "remote"`, so the
 * distinction cannot be recovered when reading back. Reported as an `import`
 * note rather than guessed at in silence.
 */
export const OPENCODE_REMOTE_TRANSPORT_NOTE =
  'opencode stores both "http" and "sse" as type "remote", so the original transport cannot be ' +
  'recovered; imported as "http". Correct it in mcp/servers.json if the server is actually sse';

/** Stable code for {@link OPENCODE_REMOTE_TRANSPORT_NOTE}, for machine readers. */
export const OPENCODE_REMOTE_TRANSPORT_NOTE_CODE = "opencode.remote-transport-ambiguous";

/** Stable code for a command frontmatter key the normalized schema cannot carry. */
export const OPENCODE_COMMAND_KEY_DROPPED_CODE = "opencode.command-key-dropped";

/**
 * SPEC §10.3: opencode's per-server `"enabled": false` is a switch this tool
 * deliberately never flips ({@link toOpencodeServer}) — but the normalized
 * schema has no field for it either, so an `import` carries the server out to
 * every other target as an ordinary, running one. That is a fact the target's
 * format recorded and ours cannot, which is exactly what a note is for.
 */
export const OPENCODE_DISABLED_SERVER_NOTE =
  'opencode has this server switched off ("enabled": false). The normalized schema has no ' +
  "equivalent field, so the imported copy is an ordinary server and will be delivered to every " +
  "other enabled target as active; run `am disable mcp <name>` if it should stay out of delivery";

/** Stable code for {@link OPENCODE_DISABLED_SERVER_NOTE}, for machine readers. */
export const OPENCODE_DISABLED_SERVER_NOTE_CODE = "opencode.server-disabled-in-target";

/**
 * Fields of an `mcp` entry this adapter renders itself (SPEC §10.3).
 *
 * Everything **outside** this set (`cwd`, `timeout`, `oauth`, …) belongs to
 * opencode, not to us: it is read verbatim and written back untouched.
 */
const OPENCODE_KNOWN_SERVER_KEYS: ReadonlySet<string> = new Set([
  "type",
  "command",
  "environment",
  "url",
  "headers",
  "enabled",
]);

export const OPENCODE_CAPABILITIES: AdapterCapabilities = {
  /**
   * opencode's own agent files are `.md` — but this adapter never writes one
   * (SPEC §10.4), so `agentExtension` / `agentDialect` are inert here. They are
   * reported truthfully rather than left blank; the `unsupported` verdict from
   * `readAgents` / `renderAgents` is what callers act on.
   */
  agentExtension: ".md",
  agentDialect: "claude",
  /** All three: `sse` is expressible, it merely collapses into `remote`. */
  supportedTransports: ["stdio", "http", "sse"],
};

/* ------------------------------------------------------------------ */
/* JSONC document handling (SPEC §10.3)                                */
/* ------------------------------------------------------------------ */

/** Formatting `modify()` uses for the fragments it inserts (SPEC §6.4: LF). */
const FORMATTING = { tabSize: 2, insertSpaces: true, eol: "\n" } as const;

/**
 * Parse JSONC text into a plain object.
 *
 * A parse error throws (SPEC §6.3): a comment-bearing config that this tool
 * cannot understand must never be treated as an empty one, because the very
 * next step would be to write a document that dropped everything in it.
 */
export function parseOpencodeConfig(text: string, filePath: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0] as ParseError;
    throw new AmError(
      `${filePath} is not valid JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
      { path: filePath },
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AmError(`${filePath} is not a JSON object`, { path: filePath });
  }
  assertUnambiguousKeys(text, filePath);
  return value as Record<string, unknown>;
}

/**
 * Refuse a document whose reader and writer would disagree about which entry is
 * live (SPEC §6.3).
 *
 * JSON's grammar permits a repeated property name — RFC 8259 only says names
 * *should* be unique — and `jsonc-parser` raises no error for one. But the two
 * halves of this adapter resolve it differently: `parse()` keeps the **last**
 * occurrence (its visitor assigns straight onto the parent object), while
 * `modify()` → `findNodeAtLocation` stops at the **first**. A repeat on the
 * path this adapter walks therefore means the surgical write lands in a block
 * nothing reads back — and because re-rendering then produces the same no-op
 * edit, the very next `plan` reports 「差分なし」 about a change that never
 * happened, permanently. Refusing here turns that silent wrong write into the
 * hard stop SPEC §6.3 already promises for input this tool cannot understand.
 *
 * Scoped to the two levels the adapter navigates — the root's `mcp` key and the
 * server names inside it. A duplicate anywhere else is opencode's business: we
 * neither read nor rewrite those nodes, so no disagreement can arise from them.
 */
function assertUnambiguousKeys(text: string, filePath: string): void {
  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  if (root === undefined) return;

  if (duplicatesOf(objectKeysOf(root)).includes(OPENCODE_MCP_KEY)) {
    throw new AmError(
      `${filePath} declares "${OPENCODE_MCP_KEY}" more than once. Only the last block is read by ` +
        `a JSON parser while an edit would land in the first, so this tool refuses to touch the ` +
        `file: merge the blocks into one "${OPENCODE_MCP_KEY}" object and re-run.`,
      { path: filePath },
    );
  }

  const duplicateServers = duplicatesOf(objectKeysOf(findNodeAtLocation(root, [OPENCODE_MCP_KEY])));
  if (duplicateServers.length > 0) {
    throw new AmError(
      `${filePath} declares MCP server ${duplicateServers.map((n) => `"${n}"`).join(", ")} more ` +
        `than once inside "${OPENCODE_MCP_KEY}". Only the last definition is read while an edit ` +
        `would land in the first, so this tool refuses to touch the file: keep one definition ` +
        `per server and re-run.`,
      { path: filePath },
    );
  }
}

/** The property names of an object node, in document order (repeats included). */
function objectKeysOf(node: Node | undefined): string[] {
  if (node === undefined || node.type !== "object") return [];
  const out: string[] = [];
  for (const property of node.children ?? []) {
    const key = property.children?.[0];
    if (key !== undefined && typeof key.value === "string") out.push(key.value);
  }
  return out;
}

/** Names appearing more than once, sorted, each reported once. */
function duplicatesOf(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) repeated.add(key);
    else seen.add(key);
  }
  return [...repeated].sort();
}

/** The `mcp` map of a parsed document, entry by entry, still in opencode's dialect. */
function rawServersOf(
  root: Readonly<Record<string, unknown>>,
  filePath: string,
): Record<string, Record<string, unknown>> {
  const raw = root[OPENCODE_MCP_KEY];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AmError(`"${OPENCODE_MCP_KEY}" in ${filePath} is not an object`, { path: filePath });
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(raw as Record<string, unknown>).sort()) {
    const entry = (raw as Record<string, unknown>)[name];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AmError(`MCP server "${name}" in ${filePath} is not an object`, { path: filePath });
    }
    out[name] = entry as Record<string, unknown>;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* MCP dialect conversion (SPEC §10.3)                                 */
/* ------------------------------------------------------------------ */

/**
 * Normalized → opencode dialect.
 *
 * The two dialect quirks SPEC §10.3 calls out live here: the executable and its
 * arguments become **one** `command` array (not the `command` + `args` pair
 * every other target uses), and the environment map is keyed `environment`, not
 * `env`.
 *
 * `existing` is the entry as it currently sits on disk. Two things are taken
 * from it, and nothing else:
 *
 *  - **unknown fields** (`cwd`, `timeout`, `oauth`, …), restored verbatim —
 *    SPEC §10.3: "落としてはならない";
 *  - an **explicit `enabled`**. The rendered shape defaults to `enabled: true`,
 *    but flipping a `false` the owner set inside opencode back to `true` on
 *    every `apply` would be this tool silently changing a switch it did not
 *    come to touch (SPEC §6's minimal-touch discipline). Delivery is governed
 *    by `manifest.mcp.exclude`, not by opencode's own toggle.
 */
export function toOpencodeServer(
  server: McpServer,
  existing: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (server.transport === "stdio") {
    out["type"] = "local";
    out["command"] = [server.command ?? "", ...(server.args ?? [])];
    if (server.env !== undefined) out["environment"] = sortedStringMap(server.env);
  } else {
    // SPEC §10.3: http and sse are the same thing here.
    out["type"] = "remote";
    if (server.url !== undefined) out["url"] = server.url;
    if (server.headers !== undefined) out["headers"] = sortedStringMap(server.headers);
  }
  const enabled = existing["enabled"];
  out["enabled"] = typeof enabled === "boolean" ? enabled : true;

  for (const key of Object.keys(existing)) {
    if (OPENCODE_KNOWN_SERVER_KEYS.has(key)) continue;
    out[key] = existing[key];
  }
  return out;
}

/**
 * opencode dialect → normalized.
 *
 * `remote` comes back as `http`: the information needed to tell it from `sse`
 * does not exist in the file (SPEC §10.3). `import` reports that as a note —
 * see {@link OPENCODE_REMOTE_TRANSPORT_NOTE} — rather than presenting the guess
 * as a fact.
 */
export function fromOpencodeServer(
  name: string,
  raw: unknown,
  filePath: string,
): McpServer {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AmError(`MCP server "${name}" in ${filePath} is not an object`, { path: filePath });
  }
  const entry = raw as Record<string, unknown>;
  const transport = transportOf(name, entry, filePath);
  const server: McpServer = { transport };

  if (transport === "stdio") {
    const command = entry["command"];
    // The unified array is opencode's canonical form; a bare string is accepted
    // because hand-written configs use it, and refusing would strand a real
    // server behind a formatting nicety.
    const parts =
      typeof command === "string"
        ? [command]
        : Array.isArray(command)
          ? command.map((c, i) => scalarToString(c, name, `command[${i}]`, filePath))
          : null;
    if (parts === null) {
      throw new AmError(
        `MCP server "${name}" in ${filePath} is type "local" but has no "command" array`,
        { path: filePath },
      );
    }
    const head = parts[0];
    if (head === undefined || head.trim() === "") {
      throw new AmError(`MCP server "${name}" in ${filePath} has an empty "command"`, {
        path: filePath,
      });
    }
    server.command = head;
    if (parts.length > 1) server.args = parts.slice(1);
    const environment = entry["environment"];
    if (environment !== undefined && environment !== null) {
      server.env = parseStringMap(name, "environment", environment, filePath);
    }
  } else {
    const url = entry["url"];
    if (typeof url !== "string" || url.trim() === "") {
      throw new AmError(`MCP server "${name}" in ${filePath} is type "remote" but has no "url"`, {
        path: filePath,
      });
    }
    server.url = url;
    const headers = entry["headers"];
    if (headers !== undefined && headers !== null) {
      server.headers = parseStringMap(name, "headers", headers, filePath);
    }
  }
  return server;
}

/**
 * Recover the normalized transport from an entry's `type`.
 *
 * A missing `type` is inferred from the shape, which is what opencode itself
 * tolerates; an unrecognised one throws rather than defaulting, because a guess
 * here would rewrite a server into a transport nobody chose.
 */
function transportOf(
  name: string,
  entry: Readonly<Record<string, unknown>>,
  filePath: string,
): Transport {
  const type = entry["type"];
  if (type === undefined || type === null || type === "") {
    if (entry["command"] !== undefined) return "stdio";
    if (typeof entry["url"] === "string") return "http";
    throw new AmError(
      `MCP server "${name}" in ${filePath} has neither "type" nor a recognisable shape`,
      { path: filePath },
    );
  }
  if (type === "local") return "stdio";
  if (type === "remote") return "http";
  throw new AmError(
    `MCP server "${name}" in ${filePath} has unsupported type "${String(type)}"; opencode uses "local" or "remote"`,
    { path: filePath },
  );
}

/**
 * True when this normalized server, read from opencode, lost information that
 * cannot be recovered (SPEC §10.3).
 *
 * Only the remote case: every `remote` entry becomes `http`, and an `sse`
 * server is indistinguishable from an `http` one once written.
 */
export function isAmbiguousRemoteImport(server: McpServer): boolean {
  return server.transport === "http";
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export class OpencodeAdapter implements Adapter {
  readonly id: TargetId = OPENCODE_TARGET;
  readonly capabilities: AdapterCapabilities = OPENCODE_CAPABILITIES;

  paths(): AdapterPaths {
    return {
      mcp: opencodeConfigPath(),
      // SPEC §10.4: refused with a reason, not silently empty. Skills point at the source of
      // truth itself: shared discovery (SPEC §10.1, revised).
      agentsDir: UNSUPPORTED,
      skillsDir: sourceSkillsDir(),
      commandsDir: opencodeCommandsDir(),
    };
  }

  /* ---------------- real environment → normalized ---------------- */

  /** Read the `mcp` key of `opencode.jsonc`. Missing file ⇒ `{}` (SPEC §10.3). */
  readMcp(): Record<string, McpServer> {
    const filePath = opencodeConfigPath();
    const text = readTextFile(filePath);
    if (text === null) return {};
    const raw = rawServersOf(parseOpencodeConfig(text, filePath), filePath);
    const out: Record<string, McpServer> = {};
    for (const name of Object.keys(raw).sort()) {
      out[name] = fromOpencodeServer(name, raw[name], filePath);
    }
    return out;
  }

  /**
   * The `mcp` entries exactly as they sit on disk.
   *
   * This is the "読み取り時に保持" half of SPEC §10.3: `readMcp` projects onto
   * the normalized schema and therefore cannot carry `cwd` / `timeout` /
   * `oauth`, so the verbatim entries are kept available — for `plan`'s
   * preservation path, and for {@link renderMcp}, which restores the unknown
   * fields onto every server it rewrites.
   */
  readRawMcp(): Record<string, unknown> {
    const filePath = opencodeConfigPath();
    const text = readTextFile(filePath);
    if (text === null) return {};
    return rawServersOf(parseOpencodeConfig(text, filePath), filePath);
  }

  /**
   * The servers opencode itself has switched off (`"enabled": false`).
   *
   * The write path preserves an owner-set `false` on purpose — flipping it back
   * would be this tool changing a switch it did not come to touch (see
   * {@link toOpencodeServer}) — but the normalized schema has no field for it,
   * so nothing downstream could see it. The console then drew 「適用済み(整合)」
   * for a server opencode will not start: PRODUCT's second job (追跡) reporting
   * something that is not true. This is the channel that carries the fact, and
   * it is deliberately a *target-side* fact, separate from `manifest.mcp.exclude`
   * (which is what this tool means by enabled/disabled, SPEC §9.1).
   */
  mcpDisabledNames(): string[] {
    const raw = this.readRawMcp();
    return Object.keys(raw)
      .filter((name) => (raw[name] as Record<string, unknown>)["enabled"] === false)
      .sort();
  }

  /** SPEC §10.4: no safe conversion exists, so nothing is read. */
  readAgents(): Unsupported {
    return UNSUPPORTED;
  }

  /**
   * What currently sits in the directory opencode discovers skills from —
   * the source of truth itself (SPEC §10.1, revised). Reporting the listing is
   * what lets `inventory` count opencode among the consumers of a skill; no
   * caller can derive a `delete` from it, because {@link planSkills} plans
   * nothing for this target.
   *
   * The reader is shared with vscode rather than reimplemented here: both read
   * the same directory, and SPEC §5 does not allow the two views to disagree.
   * See `skill-discovery.ts`.
   */
  readSkillLinks(): SkillLink[] {
    return readSharedSkillLinks();
  }

  /**
   * Read `~/.config/opencode/command/*.md` (SPEC §10.2).
   *
   * Lenient about *fields*, like every other target-side read: these files were
   * written by hand or by opencode and may omit `description`. Broken YAML
   * still throws (SPEC §6.3) — this is the read `plan`, `apply`, `import` and
   * `doctor` use, and none of them may act on a file it could not understand.
   * The display path has {@link readCommandsForDisplay} instead.
   *
   * Keys outside the normalized schema are dropped here and reported by
   * {@link commandImportNotes}, never discarded in silence.
   */
  readCommands(): CommandDef[] {
    return this.commandFiles()
      .map((file) =>
        parseCommandFile(file.text, {
          fallbackName: file.name,
          sourcePath: file.path,
          lenient: true,
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The same directory, listed for `inventory` (SPEC §10.2).
   *
   * One file with a broken frontmatter block used to take the entire survey
   * with it: `am inventory` exited 2 and printed nothing, so the console — whose
   * window is that one payload — showed a fault plate in place of every target,
   * every skill and every server, over one command file. The scan itself had
   * completed; only the parse of one row had not.
   *
   * So a file that will not parse stays in the listing as itself: the file-name
   * stem for a name, no description, and the parse error under `unreadable`.
   * Nothing is invented to fill the gap, and nothing about the verdict is
   * softened — `doctor` reports the same file as a `command.unreadable` **error**
   * (exit 1), and `import` still refuses to lift it into the source of truth.
   * This is the arrangement `readSkillMeta` already uses for a malformed
   * `SKILL.md` (`core/source.ts`): the display column is forgiving so the owner
   * can *see* the broken thing; `doctor` is what judges it.
   */
  readCommandsForDisplay(): CommandListing[] {
    return this.commandFiles()
      .map((file): CommandListing => {
        let command: CommandDef;
        try {
          command = parseCommandFile(file.text, {
            fallbackName: file.name,
            sourcePath: file.path,
            lenient: true,
          });
        } catch (err) {
          return { name: file.name, unreadable: (err as Error).message };
        }
        return {
          name: command.name,
          description: command.description,
          ...(command.agent !== undefined ? { agent: command.agent } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Every `command/*.md` that could be opened, with its text.
   *
   * Shared by the strict read and the display read so the two can never
   * disagree about *which files exist* — they differ only in what they do with
   * a file whose frontmatter will not parse. A missing directory yields `[]`
   * (SPEC §7: absent is empty, unreadable is not).
   */
  private commandFiles(): { name: string; path: string; text: string }[] {
    const dir = opencodeCommandsDir();
    const files: { name: string; path: string; text: string }[] = [];
    for (const fileName of listFiles(dir, OPENCODE_COMMAND_EXTENSION)) {
      const name = fileName.slice(0, -OPENCODE_COMMAND_EXTENSION.length);
      if (name === "") continue;
      const filePath = path.join(dir, fileName);
      const text = readTextFile(filePath);
      if (text === null) continue;
      files.push({ name, path: filePath, text });
    }
    return files;
  }

  /* ---------------- normalized → real environment ---------------- */

  /**
   * Rewrite `opencode.jsonc`'s `mcp` entries **surgically** (SPEC §10.3).
   *
   * One `modify()` per server, rather than one replacement of the whole `mcp`
   * value, so comments attached to servers this run does not change survive as
   * well. An entry whose on-disk form already says what we would write is left
   * strictly alone — that is what makes a no-op `apply` byte-identical and the
   * SPEC §8 fixed point reachable without touching the user's formatting.
   */
  renderMcp(servers: Record<string, McpServer>, options: McpRenderOptions = {}): FileEdit[] {
    const filePath = opencodeConfigPath();
    const original = readTextFile(filePath);
    const preserve = options.preserve ?? {};

    // Nothing to deliver and no `mcp` key on disk: do not edit someone else's
    // config purely to add an empty map (the discipline SPEC §6.1 sets for
    // `~/.claude.json`, applied to the file opencode owns).
    const existingRoot =
      original === null ? {} : parseOpencodeConfig(original, filePath);
    if (
      Object.keys(servers).length === 0 &&
      Object.keys(preserve).length === 0 &&
      original !== null &&
      !(OPENCODE_MCP_KEY in existingRoot)
    ) {
      return [];
    }

    const onDisk = rawServersOf(existingRoot, filePath);
    const desired: Record<string, unknown> = {};
    for (const name of new Set([...Object.keys(servers), ...Object.keys(preserve)].sort())) {
      const server = servers[name];
      if (server !== undefined) {
        desired[name] = toOpencodeServer(server, onDisk[name] ?? {});
        continue;
      }
      // Unmanaged extra: handed back exactly as it was read.
      const raw = preserve[name];
      if (raw !== undefined) desired[name] = raw;
    }

    let text = original === null || original.trim() === "" ? "{}\n" : original;
    for (const name of [...new Set([...Object.keys(onDisk), ...Object.keys(desired)])].sort()) {
      const want = desired[name];
      const have = onDisk[name];
      if (want === undefined) {
        if (have !== undefined) text = editJsonc(text, [OPENCODE_MCP_KEY, name], undefined);
        continue;
      }
      if (have !== undefined && stableStringify(have) === stableStringify(want)) continue;
      text = editJsonc(text, [OPENCODE_MCP_KEY, name], want);
    }

    // SPEC §6.1's assertion, carried onto the surgical path by §10.3: prove the
    // edits landed where the reader will look before offering the result as a
    // write. `parseOpencodeConfig` refuses the documents that are known to make
    // the two disagree (a repeated `mcp` key); this catches anything it did not
    // anticipate, and turns a wrong write into an exit-2 stop rather than a
    // `plan` that reports 「差分なし」 about a change that never happened.
    assertRenderedServers(text, desired, filePath);

    // A run that changed nothing must be byte-identical to what is on disk,
    // down to the final byte. `withTrailingNewline` is this tool's formatting
    // for a file it actually writes (SPEC §6.4); imposing it on a document that
    // was left alone turned a config with no trailing newline into a permanent
    // `update` that only a rewrite this adapter had no reason to make could
    // clear — the opposite of the fixed point SPEC §8 asks for.
    const content =
      original !== null && text === original ? original : withTrailingNewline(normalizeText(text));
    return [{ path: filePath, content }];
  }

  /** SPEC §10.4: agents are refused with a reason, never rendered. */
  renderAgents(_agents: readonly AgentDef[]): Unsupported {
    void _agents;
    return UNSUPPORTED;
  }

  /**
   * One `command/<name>.md` per command (SPEC §10.2).
   *
   * The frontmatter carries `description` and `agent` only — `name` is the file
   * name and `targets` is source-only metadata — and the body is copied
   * verbatim: `$ARGUMENTS` is opencode's notation, and substituting it here
   * would deliver a command that can no longer take an argument.
   */
  renderCommands(commands: readonly CommandDef[]): FileEdit[] {
    return [...commands]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((command) => {
        // `opencodeCommandPath` is a bare `path.join`; an unvalidated name would
        // write outside the command directory (SPEC §10.2's lowercase-hyphen
        // rule is a schema constraint, not a style hint).
        assertValidCommandName(command.name);
        return { path: opencodeCommandPath(command.name), content: renderCommandFile(command) };
      });
  }

  /**
   * Always `[]`: opencode reads the source root directly, so the target that
   * owns skill materialization has already done any needed work (SPEC §10.1,
   * revised — same arrangement as vscode, SPEC §4).
   */
  planSkills(_skills: readonly SkillRef[]): SkillAction[] {
    void _skills;
    return [];
  }

  /* ---------------- notes (SPEC §10.3)                ---------------- */

  /** SPEC §4/§10.4: why a `read*`/`render*` answered `"unsupported"`. */
  unsupportedReason(asset: AssetKind): string | undefined {
    if (asset === "agent") {
      return `${OPENCODE_AGENTS_UNSUPPORTED_DETAIL} (${opencodeAgentsDir()})`;
    }
    return undefined;
  }

  /**
   * What `import` could not learn from this target about one MCP server.
   *
   * SPEC §10.3 requires the http/sse ambiguity to be *reported*, not guessed
   * at: the file simply does not record which of the two a `remote` entry was.
   */
  mcpImportNotes(name: string, server: McpServer): AdapterImportNote[] {
    const notes: AdapterImportNote[] = [];
    if (isAmbiguousRemoteImport(server)) {
      notes.push({
        code: OPENCODE_REMOTE_TRANSPORT_NOTE_CODE,
        detail: OPENCODE_REMOTE_TRANSPORT_NOTE,
      });
    }
    // SPEC §10.3's discipline is 「黙って推測しない」, and the switch below is a
    // fact the file records that the normalized schema cannot: importing a
    // server opencode has turned off and delivering it to Claude Code as an
    // ordinary running server is a bigger loss than the transport guess above,
    // and it used to be the only one of the two that travelled in silence.
    if (this.mcpDisabledNames().includes(name)) {
      notes.push({
        code: OPENCODE_DISABLED_SERVER_NOTE_CODE,
        detail: OPENCODE_DISABLED_SERVER_NOTE,
      });
    }
    return notes;
  }

  /**
   * SPEC §10.3 — `remote` covers both `http` and `sse`, so the transport this
   * adapter hands back for a remote server is a **guess**, not an observation.
   *
   * `import` needs to know that to keep the guess from manufacturing a conflict
   * with a target that did record the distinction: once `apply` had written an
   * `sse` server into both claude (`"type": "sse"`) and opencode
   * (`"type": "remote"`), a plain `am import` failed with a cross-target
   * conflict forever — over the tool's own output.
   */
  mcpImportIsGuess(_name: string, server: McpServer): boolean {
    void _name;
    return isAmbiguousRemoteImport(server);
  }

  /**
   * Frontmatter keys of one command file that the normalized schema cannot
   * carry (SPEC §10.2 fixes it at `description` + `agent`).
   *
   * opencode's own commands may declare `model`, `subtask` or `template`; those
   * are not delivered by this tool, and `import` says so instead of letting them
   * vanish between the target and the source of truth.
   */
  commandImportNotes(name: string, _command: CommandDef): AdapterImportNote[] {
    void _command;
    const source = this.commandSource(name);
    if (source === null) return [];
    const dropped: string[] = [];
    parseCommandFile(source.text, {
      fallbackName: path.basename(source.path, OPENCODE_COMMAND_EXTENSION),
      sourcePath: source.path,
      lenient: true,
      onUnknownKey: (key) => dropped.push(key),
    });
    return dropped.map((key) => ({
      code: OPENCODE_COMMAND_KEY_DROPPED_CODE,
      detail: `frontmatter key "${key}" is outside the normalized command schema (SPEC §10.2 renders "description" and "agent" only) and was not imported`,
    }));
  }

  /**
   * The file {@link readCommands} produced the command called `name` from.
   *
   * Deliberately not `opencodeCommandPath(name)`. A command file may declare
   * its own frontmatter `name`, which overrides the file-name fallback — SPEC
   * §10.2 says the two *should* agree and `doctor` reports it when they do
   * not, but opencode enforces nothing. Reconstructing the path from the asset
   * name therefore pointed at a file that does not exist (so the "these keys
   * were dropped" notes vanished exactly when the frontmatter was unusual
   * enough to have them) or, with a `deployment.md` also present, at a
   * different command's file (so the notes described the wrong document).
   *
   * The direct path is tried first so the ordinary case costs one read.
   */
  private commandSource(name: string): { path: string; text: string } | null {
    const dir = opencodeCommandsDir();
    const direct = `${name}${OPENCODE_COMMAND_EXTENSION}`;
    const candidates = [direct, ...listFiles(dir, OPENCODE_COMMAND_EXTENSION).filter((f) => f !== direct)];
    for (const fileName of candidates) {
      const filePath = path.join(dir, fileName);
      const text = readTextFile(filePath);
      if (text === null) continue;
      const parsed = parseCommandFile(text, {
        fallbackName: fileName.slice(0, -OPENCODE_COMMAND_EXTENSION.length),
        sourcePath: filePath,
        lenient: true,
      });
      if (parsed.name === name) return { path: filePath, text };
    }
    return null;
  }
}

/** Factory (paths resolve per call, so `AM_HOME` may change between uses). */
export function createOpencodeAdapter(): OpencodeAdapter {
  return new OpencodeAdapter();
}

/** Shared instance; stateless, so a singleton is safe. */
export const opencodeAdapter: OpencodeAdapter = createOpencodeAdapter();

/**
 * The `unsupported` action `plan` should carry for opencode's agent row.
 * Exported for symmetry with `vs2026McpUnsupportedAction`.
 */
export function opencodeAgentsUnsupportedAction(): Action {
  return unsupportedAction("opencode", "agent", OPENCODE_AGENTS_UNSUPPORTED_DETAIL);
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

/**
 * Apply one surgical JSONC edit.
 *
 * `value === undefined` removes the property. `modify()` returns the minimal
 * edit; `applyEdits()` splices it in. Everything **outside** the value node
 * being replaced — comments between entries, blank lines, key order, the user's
 * indentation, every other server — is carried through untouched, which is the
 * entire reason this adapter does not re-serialize. Inside that node nothing
 * survives: `modify()` replaces the whole value, so a comment written between
 * two fields of the entry being rewritten is gone and an inline array comes
 * back in the formatting {@link FORMATTING} dictates. The confirmation dialog
 * shows that, line by line, before the write (SPEC §9.6).
 */
function editJsonc(text: string, jsonPath: readonly string[], value: unknown): string {
  const edits = modify(text, [...jsonPath], value, { formattingOptions: { ...FORMATTING } });
  return applyEdits(text, edits);
}

/**
 * Re-read the rendered text and require its `mcp` map to be exactly what this
 * render asked for (SPEC §6.1 / §10.3).
 *
 * The comparison deliberately goes through the *same* reader the rest of the
 * tool uses, so it measures what `plan` and `readMcp` will see rather than what
 * the edit list intended.
 */
function assertRenderedServers(
  text: string,
  desired: Readonly<Record<string, unknown>>,
  filePath: string,
): void {
  const written = rawServersOf(parseOpencodeConfig(text, filePath), filePath);
  const wanted = Object.keys(desired).sort();
  const got = Object.keys(written).sort();
  const agrees =
    wanted.length === got.length &&
    wanted.every((name, index) => name === got[index]) &&
    wanted.every((name) => stableStringify(written[name]) === stableStringify(desired[name]));
  if (agrees) return;
  throw new AmError(
    `Refusing to write ${filePath}: the surgical edit did not produce the "${OPENCODE_MCP_KEY}" ` +
      `map it was asked for (wanted ${wanted.length} server(s) [${wanted.join(", ")}], reading ` +
      `the result back gives ${got.length} [${got.join(", ")}]). The file is left untouched. ` +
      `This usually means a key on the "${OPENCODE_MCP_KEY}" path is declared more than once.`,
    { path: filePath },
  );
}

/** Key-order-independent serialization, for "is this already what we want?". */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function withTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Coerce a scalar, refuse anything else (SPEC §6.3 — no silent data loss). */
function scalarToString(value: unknown, name: string, where: string, filePath: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new AmError(`MCP server "${name}" in ${filePath} has a non-scalar "${where}"`, {
    path: filePath,
  });
}

/** Parse an `environment` / `headers` map, coercing scalars and refusing the rest. */
function parseStringMap(
  name: string,
  key: string,
  value: unknown,
  filePath: string,
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AmError(`MCP server "${name}" in ${filePath} has a non-object "${key}"`, {
      path: filePath,
    });
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of Object.keys(record).sort()) {
    out[k] = scalarToString(record[k], name, `${key}.${k}`, filePath);
  }
  return out;
}

/** Sort a string map's keys so rendered output is byte-stable (SPEC §8). */
function sortedStringMap(map: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) {
    const value = map[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

