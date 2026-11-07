/**
 * YAML frontmatter parse / serialize, and the agent frontmatter dialect
 * conversion described in SPEC §4.
 *
 * The normalized source of truth always stores `tools` as a YAML array. The
 * claude dialect wants a comma-separated string; the copilot dialect wants an
 * array. `targets` is a source-only key and is stripped before render
 * (SPEC §3).
 */

import * as YAML from "yaml";

import {
  AmError,
  isTargetId,
  type AgentDef,
  type AgentDialect,
  type CommandDef,
  type TargetId,
} from "./model.js";
import { normalizeText } from "./fsops.js";

/** Result of splitting a document into frontmatter data and body. */
export interface ParsedFrontmatter {
  /** Parsed YAML mapping. Empty object when the document has no frontmatter. */
  data: Record<string, unknown>;
  /** Everything after the closing delimiter. */
  body: string;
  /** False when the document had no frontmatter block at all. */
  hasFrontmatter: boolean;
}

/**
 * Opening `---`, the YAML block, then a closing `---` **anchored to the start of
 * a line**.
 *
 * The anchoring matters: with an optional newline before the delimiter, a `---`
 * that merely *appears* mid-line — an indented horizontal rule inside a
 * `description: |` block scalar, say — would terminate the frontmatter. The
 * truncated YAML usually still parses, so the document would be silently
 * corrupted instead of rejected, defeating SPEC §6.3's "broken input never
 * degrades quietly" guarantee. The `([\s\S]*?\n)?` group keeps the empty block
 * (`---\n---\n`) matchable while forcing every non-empty block to end in a
 * newline.
 */
const FRONTMATTER_RE = /^---[ \t]*\n([\s\S]*?\n)?---[ \t]*(?:\n([\s\S]*))?$/;

/**
 * Split a document into its YAML frontmatter mapping and body.
 *
 * A malformed YAML block throws (SPEC §6.3's "never treat broken input as
 * empty" principle applies to YAML as much as to JSON); a document with no
 * frontmatter at all is legal and yields an empty mapping.
 */
export function parseFrontmatter(text: string, sourcePath?: string): ParsedFrontmatter {
  const normalized = normalizeText(text);
  const match = FRONTMATTER_RE.exec(normalized);
  if (match === null) {
    return { data: {}, body: normalized, hasFrontmatter: false };
  }
  const yamlText = match[1] ?? "";
  const body = match[2] ?? "";
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (err) {
    throw new AmError(
      `Failed to parse YAML frontmatter${sourcePath !== undefined ? `: ${sourcePath}` : ""} (${(err as Error).message})`,
      sourcePath !== undefined ? { path: sourcePath, cause: err } : { cause: err },
    );
  }
  if (parsed === null || parsed === undefined) {
    return { data: {}, body, hasFrontmatter: true };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AmError(
      `Frontmatter must be a YAML mapping${sourcePath !== undefined ? `: ${sourcePath}` : ""}`,
      sourcePath !== undefined ? { path: sourcePath } : undefined,
    );
  }
  return { data: parsed as Record<string, unknown>, body, hasFrontmatter: true };
}

/**
 * Render a frontmatter mapping plus body back into a document.
 *
 * Output is LF-only, has exactly one trailing newline, and omits the
 * frontmatter block entirely when `data` is empty.
 */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const cleanBody = normalizeText(body).replace(/^\n+/, "").replace(/\s*$/, "");
  const keys = Object.keys(data);
  if (keys.length === 0) {
    return cleanBody === "" ? "" : `${cleanBody}\n`;
  }
  const yamlText = YAML.stringify(data, {
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  }).replace(/\n$/, "");
  const head = `---\n${yamlText}\n---\n`;
  return cleanBody === "" ? head : `${head}\n${cleanBody}\n`;
}

/* ------------------------------------------------------------------ */
/* tools: string ⇔ array (SPEC §4)                                     */
/* ------------------------------------------------------------------ */

/**
 * Normalize a `tools` frontmatter value into an array.
 * Accepts a YAML array or a comma-separated string (the claude dialect).
 * Returns `undefined` when absent, so an omitted key stays omitted.
 */
export function normalizeTools(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v !== "");
  }
  if (typeof value === "string") {
    return splitToolsString(value);
  }
  throw new AmError(`Invalid "tools" value: expected array or comma-separated string`);
}

/**
 * Split the claude dialect's `tools` string into entries.
 *
 * Splitting on every comma would tear apart a Claude Code permission specifier
 * such as `Bash(git add:*, git commit:*)`, which is a *single* tool entry, into
 * two broken fragments — and since `import` writes what it parsed back into the
 * source of truth, the corruption would then be distributed to every target.
 * Commas inside `(…)` / `[…]` therefore do not separate entries.
 */
export function splitToolsString(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((v) => v.trim()).filter((v) => v !== "");
}

/**
 * Render a tools array as the claude dialect's comma-separated string.
 *
 * The result is checked against {@link splitToolsString}: SPEC §8 requires
 * `正規化 → render → 再parse → 一致` per adapter, and the comma-string dialect
 * simply cannot represent an entry whose commas fall outside brackets. Failing
 * loudly beats emitting a file that re-parses into different tools.
 */
export function toolsToString(tools: readonly string[]): string {
  const trimmed = tools.map((t) => t.trim()).filter((t) => t !== "");
  const joined = trimmed.join(", ");
  const reparsed = splitToolsString(joined);
  if (reparsed.length !== trimmed.length || reparsed.some((v, i) => v !== trimmed[i])) {
    throw new AmError(
      `Cannot render "tools" in the claude dialect: entry ${JSON.stringify(
        trimmed.find((t) => splitToolsString(t).length !== 1) ?? trimmed.join(", "),
      )} contains a comma that is not enclosed in brackets, so the comma-separated form would not re-parse identically`,
    );
  }
  return joined;
}

/* ------------------------------------------------------------------ */
/* Agent documents                                                     */
/* ------------------------------------------------------------------ */

/** Frontmatter keys that belong to the normalized agent schema (SPEC §3). */
const AGENT_KNOWN_KEYS = new Set(["name", "description", "tools", "model", "targets"]);

export interface ParseAgentOptions {
  /** Used as `name` when the frontmatter omits it, and for error messages. */
  fallbackName?: string;
  sourcePath?: string;
  /** When true, `name`/`description` may be missing (import from a target). */
  lenient?: boolean;
}

/**
 * Parse an agent markdown document into the normalized `AgentDef`.
 *
 * Handles both dialects transparently: `tools` may arrive as a string or an
 * array and is always normalized to an array. Unknown frontmatter keys are
 * preserved in `extra` so a round trip never silently drops user data.
 */
export function parseAgentFile(text: string, options: ParseAgentOptions = {}): AgentDef {
  const { fallbackName, sourcePath, lenient = false } = options;
  const { data, body } = parseFrontmatter(text, sourcePath);
  const where = sourcePath !== undefined ? ` in ${sourcePath}` : "";

  const rawName = data["name"];
  const name =
    typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim() : fallbackName;
  if (name === undefined || name === "") {
    if (!lenient) {
      throw new AmError(`Agent is missing required "name"${where}`, pathOpt(sourcePath));
    }
  }

  const rawDescription = data["description"];
  const description =
    typeof rawDescription === "string" ? rawDescription : rawDescription === undefined ? "" : String(rawDescription);
  if (description.trim() === "" && !lenient) {
    throw new AmError(`Agent is missing required "description"${where}`, pathOpt(sourcePath));
  }

  const tools = normalizeTools(data["tools"]);

  const rawModel = data["model"];
  const model = typeof rawModel === "string" && rawModel.trim() !== "" ? rawModel.trim() : undefined;

  const targets = parseTargets(data["targets"], sourcePath);

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!AGENT_KNOWN_KEYS.has(key)) extra[key] = value;
  }

  const agent: AgentDef = {
    name: name ?? "",
    description,
    body: normalizeText(body).replace(/^\n+/, "").replace(/\s*$/, ""),
  };
  if (tools !== undefined) agent.tools = tools;
  if (model !== undefined) agent.model = model;
  if (targets !== undefined) agent.targets = targets;
  if (Object.keys(extra).length > 0) agent.extra = extra;
  return agent;
}

function parseTargets(value: unknown, sourcePath?: string): TargetId[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (list === null) {
    throw new AmError(`Invalid "targets" value: expected an array`, pathOpt(sourcePath));
  }
  const out: TargetId[] = [];
  for (const item of list) {
    const id = String(item).trim();
    if (!isTargetId(id)) {
      throw new AmError(`Unknown target "${id}" in "targets"`, pathOpt(sourcePath));
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function pathOpt(sourcePath?: string): { path: string } | undefined {
  return sourcePath !== undefined ? { path: sourcePath } : undefined;
}

/**
 * Render a normalized agent into the canonical source-of-truth document
 * (`~/.agents-manager/agents/<name>.md`): `tools` as a YAML array, `targets`
 * retained.
 */
export function renderSourceAgentFile(agent: AgentDef): string {
  const data: Record<string, unknown> = { name: agent.name, description: agent.description };
  if (agent.tools !== undefined) data["tools"] = agent.tools;
  if (agent.model !== undefined) data["model"] = agent.model;
  if (agent.targets !== undefined) data["targets"] = agent.targets;
  if (agent.extra !== undefined) Object.assign(data, agent.extra);
  return serializeFrontmatter(data, agent.body);
}

/**
 * Render a normalized agent into a target dialect (SPEC §4).
 *
 * - `claude`  → `tools` as a comma-separated string.
 * - `copilot` → `tools` as a YAML array (used by copilot-cli and vs2026).
 *
 * `targets` is always stripped: it is source-only metadata and must never
 * reach a target file.
 */
export function renderAgentFile(agent: AgentDef, dialect: AgentDialect): string {
  const data: Record<string, unknown> = {};
  data["name"] = agent.name;
  data["description"] = agent.description;
  if (agent.tools !== undefined && agent.tools.length > 0) {
    data["tools"] = dialect === "claude" ? toolsToString(agent.tools) : [...agent.tools];
  }
  if (agent.model !== undefined) data["model"] = agent.model;
  if (agent.extra !== undefined) Object.assign(data, agent.extra);
  return serializeFrontmatter(data, agent.body);
}

/** Structural equality for normalized agents (used by the diff engine). */
export function agentsEqual(a: AgentDef, b: AgentDef): boolean {
  return renderSourceAgentFile(a) === renderSourceAgentFile(b);
}

/* ------------------------------------------------------------------ */
/* Command documents (SPEC §10.2)                                      */
/* ------------------------------------------------------------------ */

/** Frontmatter keys that belong to the normalized command schema (SPEC §10.2). */
const COMMAND_KNOWN_KEYS = new Set(["name", "description", "agent", "targets"]);

export interface ParseCommandOptions {
  /** Used as `name` when the frontmatter omits it, and for error messages. */
  fallbackName?: string;
  sourcePath?: string;
  /** When true, `name`/`description` may be missing (read from a target). */
  lenient?: boolean;
  /**
   * Called once per frontmatter key outside the normalized schema.
   *
   * SPEC §10.2 fixes the rendered frontmatter at `description` + `agent`, so a
   * key like opencode's `model` has nowhere to go in the normalized model. It
   * is dropped — but never *silently*: `import` turns each of these into a note
   * so the owner learns what did not survive the trip.
   */
  onUnknownKey?: (key: string) => void;
}

/**
 * Parse a command markdown document into the normalized {@link CommandDef}.
 *
 * The body is taken **verbatim** apart from newline normalization: SPEC §10.2
 * is explicit that `$ARGUMENTS` is harness notation this tool neither
 * interprets nor substitutes.
 */
export function parseCommandFile(text: string, options: ParseCommandOptions = {}): CommandDef {
  const { fallbackName, sourcePath, lenient = false, onUnknownKey } = options;
  const { data, body } = parseFrontmatter(text, sourcePath);
  const where = sourcePath !== undefined ? ` in ${sourcePath}` : "";

  const rawName = data["name"];
  const name =
    typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim() : fallbackName;
  if ((name === undefined || name === "") && !lenient) {
    throw new AmError(`Command is missing required "name"${where}`, pathOpt(sourcePath));
  }

  const rawDescription = data["description"];
  const description =
    typeof rawDescription === "string"
      ? rawDescription
      : rawDescription === undefined || rawDescription === null
        ? ""
        : String(rawDescription);
  if (description.trim() === "" && !lenient) {
    throw new AmError(`Command is missing required "description"${where}`, pathOpt(sourcePath));
  }

  const rawAgent = data["agent"];
  const agent = typeof rawAgent === "string" && rawAgent.trim() !== "" ? rawAgent.trim() : undefined;

  const targets = parseTargets(data["targets"], sourcePath);

  if (onUnknownKey !== undefined) {
    for (const key of Object.keys(data)) {
      if (!COMMAND_KNOWN_KEYS.has(key)) onUnknownKey(key);
    }
  }

  const command: CommandDef = {
    name: name ?? "",
    description,
    body: normalizeText(body).replace(/^\n+/, "").replace(/\s*$/, ""),
  };
  if (agent !== undefined) command.agent = agent;
  if (targets !== undefined) command.targets = targets;
  return command;
}

/**
 * Render a normalized command into the canonical source-of-truth document
 * (`~/.agents-manager/commands/<name>.md`): `name` and `targets` retained.
 */
export function renderSourceCommandFile(command: CommandDef): string {
  const data: Record<string, unknown> = { name: command.name, description: command.description };
  if (command.agent !== undefined) data["agent"] = command.agent;
  if (command.targets !== undefined) data["targets"] = command.targets;
  return serializeFrontmatter(data, command.body);
}

/**
 * Render a normalized command for a target (SPEC §10.2).
 *
 * Only `description` and `agent` are emitted: those are the two keys opencode
 * reads. `name` is carried by the file name and `targets` is source-only
 * metadata, exactly as it is for agents (SPEC §3).
 */
export function renderCommandFile(command: CommandDef): string {
  const data: Record<string, unknown> = { description: command.description };
  if (command.agent !== undefined) data["agent"] = command.agent;
  return serializeFrontmatter(data, command.body);
}

/** Structural equality for normalized commands. */
export function commandsEqual(a: CommandDef, b: CommandDef): boolean {
  return renderSourceCommandFile(a) === renderSourceCommandFile(b);
}
