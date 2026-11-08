/**
 * Installed: what Claude Code and Copilot CLI load, unit by unit
 * (ARCHITECTURE.md「単位とプロジェクト」, design §4 and §6).
 *
 * A **row** is one thing on disk or in a config file — a skill directory, an
 * MCP server entry, an instruction file, a plugin. A row has a **reach** per
 * harness: whether that harness loads it, through which path, and what it
 * costs every session. A skill linked into both `~/.claude/skills` and
 * `~/.agents/skills` is therefore one row with two reaches, and a project's
 * `.mcp.json` server is one row that both harnesses read.
 *
 * Read-only by construction: this module only opens files for reading, never
 * starts a process, and never opens `~/.copilot/config.json` (SPEC §6.2).
 * From the large shared files it keeps only the keys it needs:
 * `~/.claude.json` → `mcpServers` names and `projects[<root>]`'s MCP keys;
 * settings files → plugin, skill and MCP switches. MCP definitions are reduced
 * to their name and transport — never their command, env or headers.
 *
 * Each location carries how sure we are that the harness reads it
 * (`certainty`): from the official documentation, measured (spike S11/S12), or
 * unconfirmed. Unconfirmed reaches are shown but never counted in the totals
 * and never offered for operations (design §15).
 */

import * as path from "node:path";

import {
  agentsSkillsDir,
  claudeAgentsDir,
  claudeCommandsDir,
  claudeInstalledPluginsPath,
  claudeJsonPath,
  claudeSettingsPath,
  claudeSkillsDir,
  claudeSyncedSkillsDir,
  claudeUserInstructionsPath,
  claudeUserRulesDir,
  copilotAgentsDir,
  copilotInstalledPluginsDir,
  copilotMcpConfigPath,
  copilotSettingsPath,
  copilotSkillsDir,
  copilotUserInstructionsDir,
  copilotUserInstructionsPath,
  homeDir,
  projectPaths,
  type ProjectPaths,
} from "../core/paths.js";
import {
  claudeListingText,
  claudeSkillText,
  copilotAgentText,
  copilotConditionalRowText,
  copilotInstructionText,
  copilotSkillText,
  costOf,
  type Cost,
} from "./cost.js";
import { normalizeRoot, projectId } from "./discover.js";
import {
  exists,
  isDirEntry,
  isFileEntry,
  isLink,
  isRecord,
  listDir,
  ReadFailure,
  readKeys,
  readMarkdown,
  readText,
  realPathIfDifferent,
  resolveImports,
  SourceRecorder,
  str,
  stringList,
  walkFiles,
  type ReadSource,
} from "./readers.js";

/* ------------------------------------------------------------------ */
/* Contract                                                            */
/* ------------------------------------------------------------------ */

export type HarnessId = "claude" | "copilot";
export const HARNESS_IDS: readonly HarnessId[] = ["claude", "copilot"];
export type ScopeKind = "user" | "project" | "local";
export type InstalledKind = "skill" | "agent" | "command" | "mcp" | "plugin" | "instructions";
export const INSTALLED_KINDS: readonly InstalledKind[] = ["instructions", "skill", "agent", "command", "mcp", "plugin"];

/**
 * - `enabled`: loaded every session; its cost is counted.
 * - `conditional`: loaded only when something matches (a path pattern, a
 *   subfolder); its cost is shown, not counted.
 * - `disabled`: switched off by a setting.
 * - `not-loaded`: present, but the harness does not read it here (with a reason).
 * - `via-import`: loaded because another instruction file imports it; counted there.
 * - `unknown`: depends on something not read (folder trust, an approval).
 * - `unconfirmed`: the location is not confirmed by the documentation and a measurement.
 */
export type ReachState = "enabled" | "conditional" | "disabled" | "not-loaded" | "via-import" | "unknown" | "unconfirmed";
export type Certainty = "official" | "measured" | "official+measured" | "unconfirmed";

export interface InstalledReach {
  harness: HarnessId;
  state: ReachState;
  /** The path (or `file#key`) the harness reads this through. */
  via: string;
  certainty: Certainty;
  /** What this harness carries for the row. Absent when it is not measured (MCP tools, for one). */
  cost?: Cost;
  /** How the cost is counted, in a few words. */
  costBasis?: string;
  /** Which setting decided the state, as `file#key`. */
  stateSource?: string;
  note?: string;
}

export interface InstalledFinding {
  code: string;
  level: "error" | "warn";
  detail: string;
}

export interface InstalledRow {
  id: string;
  kind: InstalledKind;
  name: string;
  scope: ScopeKind;
  origin: "file" | "link" | "synced" | "plugin" | "config";
  path: string;
  realPath?: string;
  description?: string;
  version?: string;
  /** For a plugin: its components. */
  components?: { skills: string[]; commands: string[]; agents: string[]; mcpServers: string[] };
  /** For an MCP server: its transport (the definition itself is not read out). */
  transport?: string;
  /** For instructions: the files it imports, which its cost includes. */
  imports?: { path: string; chars: number }[];
  reach: InstalledReach[];
  findings?: InstalledFinding[];
  unreadable?: string;
}

export interface ScopeTotal {
  scope: ScopeKind;
  harness: HarnessId;
  /** Sum over `enabled` reaches. */
  chars: number;
  tokens: number;
  rows: number;
  /** Reaches whose cost is shown but not in the sum. */
  conditional: number;
  /** `enabled` reaches whose cost could not be counted (MCP servers' tools, components of unread plugins). */
  unmeasured: number;
}

export interface InstalledJson {
  project?: { id: string; root: string; name: string };
  scopes: ScopeKind[];
  rows: InstalledRow[];
  totals: ScopeTotal[];
  /** Harnesses this phase does not read yet, with the reason. */
  unsupported: { harness: string; reason: string }[];
  notes: string[];
  /** Every location read, with how the read went. */
  sources: ReadSource[];
  elapsedMs: number;
}

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

class Rows {
  private readonly byId = new Map<string, InstalledRow>();

  /** Add a row, or merge the reaches into an existing row with the same id. */
  put(row: Omit<InstalledRow, "id"> & { key: string }): InstalledRow {
    const id = `${row.kind}:${row.scope}:${row.key}`;
    const existing = this.byId.get(id);
    const { key: _key, ...rest } = row;
    void _key;
    if (existing === undefined) {
      const created: InstalledRow = { id, ...rest };
      this.byId.set(id, created);
      return created;
    }
    for (const r of row.reach) {
      if (!existing.reach.some((x) => x.harness === r.harness && x.via === r.via)) existing.reach.push(r);
    }
    if (existing.description === undefined && row.description !== undefined) existing.description = row.description;
    if (row.findings !== undefined) existing.findings = [...(existing.findings ?? []), ...row.findings];
    return existing;
  }

  get all(): InstalledRow[] {
    return [...this.byId.values()];
  }
}

const keyOfPath = (p: string): string => path.resolve(p).toLowerCase();

/** The identity of a file or directory: where its links lead. */
function entityKey(p: string): string {
  return keyOfPath(realPathIfDifferent(p) ?? p);
}

/* ---- settings ----------------------------------------------------- */

interface SettingsLayer {
  file: string;
  status: "ok" | "missing" | "unreadable";
  detail?: string;
  values: Record<string, unknown>;
}

function settingsLayer(file: string, keys: readonly string[], rec: SourceRecorder): SettingsLayer {
  const r = readKeys(file, keys, rec);
  if (r.status === "ok") return { file, status: "ok", values: r.values };
  if (r.status === "missing") return { file, status: "missing", values: {} };
  return { file, status: "unreadable", detail: r.detail, values: {} };
}

/** The value of `key[name]` from the highest-precedence layer that has it (layers: highest first). */
function lookupFlag(layers: SettingsLayer[], key: string, name: string): { value: unknown; source: string } | null {
  for (const l of layers) {
    const map = l.values[key];
    if (isRecord(map) && name in map) return { value: map[name], source: `${l.file}#${key}` };
  }
  return null;
}

const CLAUDE_KEYS = ["enabledPlugins", "skillOverrides", "syncClaudeAiSkills", "enableAllProjectMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers"] as const;
const COPILOT_KEYS = ["enabledPlugins", "disabledSkills", "disabledMcpServers"] as const;

/* ---- ~/.claude.json ------------------------------------------------ */

interface ClaudeJsonSlice {
  status: "ok" | "missing" | "unreadable";
  detail?: string;
  /** User-scope MCP server name → transport. */
  userMcp: Record<string, string>;
  /** `projects[<root>]` for the selected project, reduced to MCP keys. */
  local?: { mcp: Record<string, string>; enabledMcpjson: string[]; disabledMcpjson: string[] };
}

function transportOf(def: unknown): string {
  if (!isRecord(def)) return "?";
  const t = def["type"];
  if (typeof t === "string") return t;
  if (typeof def["command"] === "string") return "stdio";
  if (typeof def["url"] === "string") return "http";
  return "?";
}

function mcpNames(map: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(map)) for (const [name, def] of Object.entries(map)) out[name] = transportOf(def);
  return out;
}

function readClaudeJson(root: string | undefined, rec: SourceRecorder): ClaudeJsonSlice {
  const r = readKeys(claudeJsonPath(), ["mcpServers", "projects"], rec);
  if (r.status === "missing") return { status: "missing", userMcp: {} };
  if (r.status === "unreadable") return { status: "unreadable", detail: r.detail, userMcp: {} };
  const slice: ClaudeJsonSlice = { status: "ok", userMcp: mcpNames(r.values["mcpServers"]) };
  const projects = r.values["projects"];
  if (root !== undefined && isRecord(projects)) {
    const want = normalizeRoot(root).toLowerCase();
    for (const [k, v] of Object.entries(projects)) {
      if (normalizeRoot(k).toLowerCase() !== want || !isRecord(v)) continue;
      slice.local = {
        mcp: mcpNames(v["mcpServers"]),
        enabledMcpjson: stringList(v["enabledMcpjsonServers"]),
        disabledMcpjson: stringList(v["disabledMcpjsonServers"]),
      };
      break;
    }
  }
  return slice;
}

/* ---- shared row readers --------------------------------------------- */

interface SkillFound {
  name: string;
  dir: string;
  description?: string;
  whenToUse?: string;
  disableModelInvocation: boolean;
  unreadable?: string;
}

/** `<dir>/<name>/SKILL.md` for every subdirectory; directories without SKILL.md are skipped. */
function readSkillsIn(dir: string, rec: SourceRecorder, skip: readonly string[] = []): SkillFound[] {
  const out: SkillFound[] = [];
  for (const e of listDir(dir, rec)) {
    if (skip.includes(e.name) || !isDirEntry(dir, e)) continue;
    const skillDir = path.join(dir, e.name);
    const file = path.join(skillDir, "SKILL.md");
    if (!exists(file)) continue;
    try {
      const md = readMarkdown(file, rec);
      if (md === null) continue;
      const found: SkillFound = {
        name: str(md.data["name"]) ?? e.name,
        dir: skillDir,
        disableModelInvocation: md.data["disable-model-invocation"] === true,
      };
      const d = str(md.data["description"]);
      const w = str(md.data["when_to_use"]);
      if (d !== undefined) found.description = d;
      if (w !== undefined) found.whenToUse = w;
      out.push(found);
    } catch (err) {
      out.push({ name: e.name, dir: skillDir, disableModelInvocation: false, unreadable: (err as Error).message });
    }
  }
  return out;
}

interface MdFound {
  name: string;
  file: string;
  description?: string;
  data: Record<string, unknown>;
  body: string;
  text: string;
  unreadable?: string;
}

/** Markdown files in `dir` matching one of `suffixes`, name taken from frontmatter or the file name. */
function readMdIn(dir: string, suffixes: readonly string[], rec: SourceRecorder, recurse = 0): MdFound[] {
  const out: MdFound[] = [];
  const visit = (d: string, prefix: string, left: number): void => {
    for (const e of listDir(d, rec)) {
      const full = path.join(d, e.name);
      if (left > 0 && isDirEntry(d, e)) {
        visit(full, `${prefix}${e.name}:`, left - 1);
        continue;
      }
      const suffix = suffixes.find((s) => e.name.endsWith(s));
      if (suffix === undefined || !isFileEntry(d, e)) continue;
      const base = e.name.slice(0, -suffix.length);
      try {
        const md = readMarkdown(full, rec);
        if (md === null) continue;
        const found: MdFound = {
          name: prefix + (str(md.data["name"]) ?? base),
          file: full,
          data: md.data,
          body: md.body,
          text: md.text,
        };
        const desc = str(md.data["description"]);
        if (desc !== undefined) found.description = desc;
        out.push(found);
      } catch (err) {
        out.push({ name: prefix + base, file: full, data: {}, body: "", text: "", unreadable: (err as Error).message });
      }
    }
  };
  visit(dir, "", recurse);
  return out;
}

function originOf(p: string): InstalledRow["origin"] {
  return isLink(p) ? "link" : "file";
}

function withReal(p: string): { path: string; realPath?: string } {
  const real = realPathIfDifferent(p);
  return real === undefined ? { path: p } : { path: p, realPath: real };
}

/** The first line of a command body that has text: what Claude shows when there is no description. */
function firstLine(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t !== "") return t;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Collection                                                          */
/* ------------------------------------------------------------------ */

interface Context {
  rows: Rows;
  rec: SourceRecorder;
  notes: string[];
  root?: string;
  pp?: ProjectPaths;
  claude: { layers: SettingsLayer[]; json: ClaudeJsonSlice };
  copilot: { layers: SettingsLayer[] };
}

export interface InstalledOptions {
  /** The project root to read the project and local units of. Absent: the user unit only. */
  root?: string;
}

export function readInstalled(options: InstalledOptions = {}): InstalledJson {
  const started = Date.now();
  const rec = new SourceRecorder();
  const rows = new Rows();
  const notes: string[] = [];
  const root = options.root === undefined ? undefined : normalizeRoot(options.root);
  const pp = root === undefined ? undefined : projectPaths(root);

  // Settings, highest precedence first (Claude: local > project > user; Copilot: local > repo > user).
  const claudeLayers: SettingsLayer[] = [];
  const copilotLayers: SettingsLayer[] = [];
  if (pp !== undefined) {
    claudeLayers.push(settingsLayer(pp.claudeSettingsLocal, CLAUDE_KEYS, rec), settingsLayer(pp.claudeSettings, CLAUDE_KEYS, rec));
    copilotLayers.push(settingsLayer(pp.copilotLocalSettings, COPILOT_KEYS, rec), settingsLayer(pp.copilotRepoSettings, COPILOT_KEYS, rec));
  }
  claudeLayers.push(settingsLayer(claudeSettingsPath(), CLAUDE_KEYS, rec));
  copilotLayers.push(settingsLayer(copilotSettingsPath(), COPILOT_KEYS, rec));

  const ctx: Context = {
    rows,
    rec,
    notes,
    ...(root !== undefined ? { root } : {}),
    ...(pp !== undefined ? { pp } : {}),
    claude: { layers: claudeLayers, json: readClaudeJson(root, rec) },
    copilot: { layers: copilotLayers },
  };

  for (const l of [...claudeLayers, ...copilotLayers]) {
    if (l.status === "unreadable") {
      notes.push(`設定ファイルを読めなかったため、そこに書かれた有効・無効は反映していない: ${l.file}(${l.detail ?? ""})`);
    }
  }
  if (ctx.claude.json.status === "unreadable") {
    notes.push(`~/.claude.json を読めなかったため、Claude の MCP(user・local)は表示していない(${ctx.claude.json.detail ?? ""})`);
  }

  collectInstructions(ctx);
  collectSkills(ctx);
  collectAgents(ctx);
  collectCommands(ctx);
  collectMcp(ctx);
  collectPlugins(ctx);

  notes.push(
    "常時コストは静的な見積もり(字数)。トークンは推測の換算。MCP サーバーのツール定義と、ハーネス自身のシステムプロンプトは数えていない。",
    "Copilot の組み込みプラグイン(computer-use など)は状態ファイルに無いので表示していない。",
    "Copilot がプロジェクトの MCP を読むのは信頼済みのフォルダだけ。信頼の記録は ~/.copilot/config.json にあり、読まないので「不明」と表示する。",
  );

  const scopes: ScopeKind[] = root === undefined ? ["user"] : ["user", "project", "local"];
  const all = rows.all.sort(
    (a, b) =>
      scopes.indexOf(a.scope) - scopes.indexOf(b.scope) ||
      INSTALLED_KINDS.indexOf(a.kind) - INSTALLED_KINDS.indexOf(b.kind) ||
      a.name.localeCompare(b.name),
  );

  const result: InstalledJson = {
    scopes,
    rows: all,
    totals: totals(all, scopes),
    unsupported: [
      { harness: "codex", reason: "P6 で読み取りを足す予定(まだ読んでいない)" },
      { harness: "opencode", reason: "P6 で読み取りを足す予定(配布のターゲットとしては対応済み)" },
    ],
    notes,
    sources: rec.list,
    elapsedMs: 0,
  };
  if (root !== undefined) result.project = { id: projectId(root), root, name: path.basename(root) || root };
  result.elapsedMs = Date.now() - started;
  return result;
}

function totals(rows: InstalledRow[], scopes: ScopeKind[]): ScopeTotal[] {
  const out: ScopeTotal[] = [];
  for (const scope of scopes) {
    for (const harness of HARNESS_IDS) {
      const t: ScopeTotal = { scope, harness, chars: 0, tokens: 0, rows: 0, conditional: 0, unmeasured: 0 };
      for (const row of rows) {
        if (row.scope !== scope) continue;
        const reaches = row.reach.filter((r) => r.harness === harness);
        if (reaches.length === 0) continue;
        t.rows++;
        for (const r of reaches) {
          if (r.state === "enabled") {
            if (r.cost === undefined) t.unmeasured++;
            else {
              t.chars += r.cost.chars;
              t.tokens += r.cost.tokens;
            }
          } else if (r.state === "conditional") t.conditional++;
        }
      }
      out.push(t);
    }
  }
  return out;
}

/* ---- instructions --------------------------------------------------- */

function instructionRow(
  ctx: Context,
  scope: ScopeKind,
  file: string,
  reach: (text: string, total: string) => InstalledReach[],
  importsFor: "claude" | "none" = "claude",
): void {
  let text: string | null;
  try {
    text = readText(file, ctx.rec);
  } catch (err) {
    ctx.rows.put({
      key: entityKey(file),
      kind: "instructions",
      name: path.basename(file),
      scope,
      origin: originOf(file),
      ...withReal(file),
      reach: [],
      unreadable: (err as ReadFailure).message,
    });
    return;
  }
  if (text === null) return;
  const imports = importsFor === "claude" ? resolveImports(file, text, homeDir(), ctx.rec) : [];
  const total = [text, ...imports.map((i) => i.text)].join("\n");
  const row: Omit<InstalledRow, "id"> & { key: string } = {
    key: entityKey(file),
    kind: "instructions",
    name: path.basename(file),
    scope,
    origin: originOf(file),
    ...withReal(file),
    reach: reach(text, total),
  };
  if (imports.length > 0) row.imports = imports.map((i) => ({ path: i.path, chars: costOf(i.text).chars }));
  ctx.rows.put(row);
}

function collectInstructions(ctx: Context): void {
  const claudeBasis = "本文 + @import 先の字数(公式 memory)";
  // user
  instructionRow(ctx, "user", claudeUserInstructionsPath(), (_t, total) => [
    { harness: "claude", state: "enabled", via: claudeUserInstructionsPath(), certainty: "official", cost: costOf(total), costBasis: claudeBasis },
  ]);
  for (const f of walkFiles(claudeUserRulesDir(), ".md", ctx.rec)) {
    instructionRow(ctx, "user", f, (_t, total) => [
      { harness: "claude", state: "unconfirmed", via: f, certainty: "unconfirmed", cost: costOf(total), note: "user 単位の rules は公式文書で確かめていない" },
    ]);
  }
  instructionRow(ctx, "user", copilotUserInstructionsPath(), (_t, total) => [
    { harness: "copilot", state: "enabled", via: copilotUserInstructionsPath(), certainty: "official+measured", cost: costOf(copilotInstructionText(total)), costBasis: "<custom_instruction> 1 件分(実測)" },
  ]);
  for (const f of walkFiles(copilotUserInstructionsDir(), ".instructions.md", ctx.rec)) {
    copilotPathInstruction(ctx, "user", f, copilotUserInstructionsDir());
  }

  if (ctx.pp === undefined || ctx.root === undefined) return;
  const pp = ctx.pp;
  const anyClaudeMd = exists(pp.claudeMd) || exists(pp.dotClaudeMd) || exists(pp.claudeLocalMd);
  const claudeImports = new Set<string>();
  for (const f of [pp.claudeMd, pp.dotClaudeMd, pp.claudeLocalMd]) {
    try {
      const t = readText(f, ctx.rec);
      if (t !== null) for (const i of resolveImports(f, t, homeDir(), ctx.rec)) claudeImports.add(keyOfPath(i.path));
    } catch {
      /* reported by its own row */
    }
  }

  const copilotRoot = (f: string) => (_t: string, total: string): InstalledReach =>
    ({ harness: "copilot", state: "enabled", via: f, certainty: "official+measured", cost: costOf(copilotInstructionText(total)), costBasis: "<custom_instruction> 1 件分(実測)" });

  // project: CLAUDE.md (both harnesses read it)
  instructionRow(ctx, "project", pp.claudeMd, (t, total) => [
    { harness: "claude", state: "enabled", via: pp.claudeMd, certainty: "official", cost: costOf(total), costBasis: claudeBasis },
    copilotRoot(pp.claudeMd)(t, total),
  ]);
  instructionRow(ctx, "project", pp.dotClaudeMd, (_t, total) => [
    { harness: "claude", state: "enabled", via: pp.dotClaudeMd, certainty: "official", cost: costOf(total), costBasis: claudeBasis },
    {
      harness: "copilot",
      state: "unconfirmed",
      via: pp.dotClaudeMd,
      certainty: "unconfirmed",
      note: "公式文書は読むとするが、1.0.107 の実測では読まれなかった",
    },
  ]);
  instructionRow(ctx, "project", pp.agentsMd, (t, total) => {
    const imported = claudeImports.has(keyOfPath(pp.agentsMd));
    const claude: InstalledReach = imported
      ? { harness: "claude", state: "via-import", via: pp.agentsMd, certainty: "official", cost: costOf(total), note: "CLAUDE.md の @import として読まれる(字数はそちらに含めた)" }
      : anyClaudeMd
        ? { harness: "claude", state: "not-loaded", via: pp.agentsMd, certainty: "official", note: "既定の設定では、CLAUDE.md・.claude/CLAUDE.md・CLAUDE.local.md があると AGENTS.md を読まない" }
        : { harness: "claude", state: "enabled", via: pp.agentsMd, certainty: "official", cost: costOf(total), costBasis: claudeBasis, note: "Claude Code 2.1.277 以降、CLAUDE.md が無いときに読む" };
    return [claude, copilotRoot(pp.agentsMd)(t, total)];
  });
  instructionRow(ctx, "project", pp.geminiMd, (t) => [copilotRoot(pp.geminiMd)(t, t)], "none");
  instructionRow(ctx, "project", pp.copilotInstructions, (t, total) => [copilotRoot(pp.copilotInstructions)(t, total)]);
  for (const f of walkFiles(pp.githubInstructionsDir, ".instructions.md", ctx.rec)) {
    copilotPathInstruction(ctx, "project", f, ctx.root);
  }
  for (const f of walkFiles(pp.claudeRulesDir, ".md", ctx.rec)) {
    let conditional = false;
    try {
      const md = readMarkdown(f, ctx.rec);
      conditional = md !== null && md.data["paths"] !== undefined;
    } catch {
      /* the row shows it as unreadable */
    }
    instructionRow(ctx, "project", f, (_t, total) => [
      conditional
        ? { harness: "claude", state: "conditional", via: f, certainty: "official", cost: costOf(total), note: "paths に当たるファイルを扱うときだけ読む" }
        : { harness: "claude", state: "enabled", via: f, certainty: "official", cost: costOf(total), costBasis: claudeBasis },
    ]);
  }
  // local
  instructionRow(ctx, "local", pp.claudeLocalMd, (_t, total) => [
    { harness: "claude", state: "enabled", via: pp.claudeLocalMd, certainty: "official", cost: costOf(total), costBasis: claudeBasis },
    { harness: "copilot", state: "not-loaded", via: pp.claudeLocalMd, certainty: "measured", note: "Copilot CLI 1.0.107 は読まなかった(実測)" },
  ]);
}

/** A Copilot `*.instructions.md`: without `applyTo` or with `**` its body is always in; otherwise only a table row. */
function copilotPathInstruction(ctx: Context, scope: ScopeKind, file: string, relTo: string): void {
  let pattern: string | undefined;
  let description: string | undefined;
  try {
    const md = readMarkdown(file, ctx.rec);
    if (md === null) return;
    const a = md.data["applyTo"];
    pattern = typeof a === "string" ? a : Array.isArray(a) ? a.join(",") : undefined;
    description = str(md.data["description"]);
  } catch {
    /* the row shows it as unreadable */
  }
  const always = pattern === undefined || pattern.trim() === "" || pattern.trim() === "**";
  instructionRow(
    ctx,
    scope,
    file,
    (t) => [
      always
        ? { harness: "copilot", state: "enabled", via: file, certainty: "measured", cost: costOf(t + "\n"), costBasis: "本文をそのまま(実測)", note: pattern === undefined ? "applyTo が無いものは常に読まれた(実測)" : "applyTo: ** は常に読まれる" }
        : {
            harness: "copilot",
            state: "conditional",
            via: file,
            certainty: "official+measured",
            cost: costOf(copilotConditionalRowText(pattern!, path.relative(relTo, file), description)),
            costBasis: "一覧表の 1 行(実測)",
            note: `applyTo「${pattern}」に当たるファイルを扱うときだけ本文が入る。常時は表の 1 行だけ`,
          },
    ],
    "none",
  );
}

/* ---- skills ----------------------------------------------------------- */

function claudeSkillReach(ctx: Context, s: SkillFound, via: string, applyOverrides: boolean): InstalledReach {
  const base = { harness: "claude" as const, via, certainty: "official" as const };
  if (s.unreadable !== undefined) return { ...base, state: "unknown", note: "SKILL.md が読めない" };
  if (applyOverrides) {
    const o = lookupFlag(ctx.claude.layers, "skillOverrides", s.name);
    if (o !== null) {
      if (o.value === "off") return { ...base, state: "disabled", stateSource: o.source, cost: costOf("") };
      if (o.value === "user-invocable-only") {
        return { ...base, state: "enabled", stateSource: o.source, cost: costOf(""), costBasis: "モデルの一覧に載らない(ユーザーの呼び出しのみ)" };
      }
      if (o.value === "name-only") {
        return { ...base, state: "enabled", stateSource: o.source, cost: costOf(s.name), costBasis: "名前だけ(skillOverrides: name-only。内訳は推測)" };
      }
    }
  }
  if (s.disableModelInvocation) {
    return { ...base, state: "enabled", cost: costOf(""), costBasis: "disable-model-invocation: モデルの一覧に載らない" };
  }
  return { ...base, state: "enabled", cost: costOf(claudeSkillText(s.name, s.description, s.whenToUse)), costBasis: "名前 + description + when_to_use(公式)" };
}

function copilotDisabledSkills(ctx: Context): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of [...ctx.copilot.layers].reverse()) {
    for (const n of stringList(l.values["disabledSkills"])) out.set(n, `${l.file}#disabledSkills`);
  }
  return out;
}

function copilotSkillReach(ctx: Context, s: SkillFound, via: string, location: "project" | "user", certainty: Certainty): InstalledReach {
  const base = { harness: "copilot" as const, via, certainty };
  if (s.unreadable !== undefined) return { ...base, state: "unknown", note: "SKILL.md が読めない" };
  const disabled = copilotDisabledSkills(ctx).get(s.name);
  if (disabled !== undefined) return { ...base, state: "disabled", stateSource: disabled, cost: costOf("") };
  return { ...base, state: "enabled", cost: costOf(copilotSkillText(s.name, s.description ?? "", location)), costBasis: "<available_skills> 1 件分(実測)" };
}

function putSkill(ctx: Context, scope: ScopeKind, s: SkillFound, reach: InstalledReach, origin?: InstalledRow["origin"]): void {
  const row: Omit<InstalledRow, "id"> & { key: string } = {
    key: entityKey(s.dir),
    kind: "skill",
    name: s.name,
    scope,
    origin: origin ?? originOf(s.dir),
    ...withReal(s.dir),
    reach: [reach],
  };
  if (s.description !== undefined) row.description = s.description;
  if (s.unreadable !== undefined) row.unreadable = s.unreadable;
  ctx.rows.put(row);
}

function collectSkills(ctx: Context): void {
  // user: Claude
  for (const s of readSkillsIn(claudeSkillsDir(), ctx.rec, ["synced"])) {
    putSkill(ctx, "user", s, claudeSkillReach(ctx, s, path.join(claudeSkillsDir(), path.basename(s.dir)), true));
  }
  const syncOff = ctx.claude.layers.find((l) => l.values["syncClaudeAiSkills"] === false);
  for (const bucket of listDir(claudeSyncedSkillsDir(), ctx.rec)) {
    if (!isDirEntry(claudeSyncedSkillsDir(), bucket)) continue;
    for (const s of readSkillsIn(path.join(claudeSyncedSkillsDir(), bucket.name), ctx.rec)) {
      const reach: InstalledReach =
        syncOff !== undefined
          ? { harness: "claude", state: "disabled", via: s.dir, certainty: "official", stateSource: `${syncOff.file}#syncClaudeAiSkills`, cost: costOf("") }
          : { ...claudeSkillReach(ctx, s, s.dir, false), note: "claude.ai から同期された skill" };
      putSkill(ctx, "user", s, reach, "synced");
    }
  }
  // user: Copilot
  for (const dir of [copilotSkillsDir(), agentsSkillsDir()]) {
    for (const s of readSkillsIn(dir, ctx.rec)) {
      putSkill(ctx, "user", s, copilotSkillReach(ctx, s, path.join(dir, path.basename(s.dir)), "user", "official+measured"));
    }
  }
  if (ctx.pp === undefined) return;
  const pp = ctx.pp;
  for (const s of readSkillsIn(pp.claudeSkillsDir, ctx.rec)) {
    const via = path.join(pp.claudeSkillsDir, path.basename(s.dir));
    putSkill(ctx, "project", s, claudeSkillReach(ctx, s, via, true));
    putSkill(ctx, "project", s, copilotSkillReach(ctx, s, via, "project", "official+measured"));
  }
  for (const dir of [pp.githubSkillsDir, pp.agentsSkillsDir]) {
    for (const s of readSkillsIn(dir, ctx.rec)) {
      putSkill(ctx, "project", s, copilotSkillReach(ctx, s, path.join(dir, path.basename(s.dir)), "project", "official+measured"));
    }
  }
}

/* ---- agents ----------------------------------------------------------- */

function putMd(ctx: Context, kind: "agent" | "command", scope: ScopeKind, f: MdFound, reach: InstalledReach): void {
  const row: Omit<InstalledRow, "id"> & { key: string } = {
    key: entityKey(f.file),
    kind,
    name: f.name,
    scope,
    origin: originOf(f.file),
    ...withReal(f.file),
    reach: [reach],
  };
  if (f.description !== undefined) row.description = f.description;
  if (f.unreadable !== undefined) row.unreadable = f.unreadable;
  ctx.rows.put(row);
}

function claudeAgentReach(f: MdFound): InstalledReach {
  if (f.unreadable !== undefined) return { harness: "claude", state: "unknown", via: f.file, certainty: "official", note: "frontmatter が読めない" };
  return { harness: "claude", state: "enabled", via: f.file, certainty: "official", cost: costOf(claudeListingText(f.name, f.description)), costBasis: "名前 + description" };
}

function copilotAgentReach(f: MdFound, certainty: Certainty): InstalledReach {
  if (f.unreadable !== undefined) return { harness: "copilot", state: "unknown", via: f.file, certainty, note: "frontmatter が読めない" };
  return { harness: "copilot", state: "enabled", via: f.file, certainty, cost: costOf(copilotAgentText(f.name, f.description ?? "")), costBasis: "task ツールの説明の 1 行(実測)" };
}

function collectAgents(ctx: Context): void {
  for (const f of readMdIn(claudeAgentsDir(), [".md"], ctx.rec)) putMd(ctx, "agent", "user", f, claudeAgentReach(f));
  for (const f of readMdIn(copilotAgentsDir(), [".agent.md", ".md"], ctx.rec)) {
    putMd(ctx, "agent", "user", f, copilotAgentReach(f, "official+measured"));
  }
  if (ctx.pp === undefined) return;
  for (const f of readMdIn(ctx.pp.claudeAgentsDir, [".md"], ctx.rec)) {
    putMd(ctx, "agent", "project", f, claudeAgentReach(f));
    putMd(ctx, "agent", "project", f, copilotAgentReach(f, "measured"));
  }
  for (const f of readMdIn(ctx.pp.githubAgentsDir, [".agent.md", ".md"], ctx.rec)) {
    putMd(ctx, "agent", "project", f, copilotAgentReach(f, "official+measured"));
  }
}

/* ---- commands --------------------------------------------------------- */

function collectCommands(ctx: Context): void {
  const reach = (f: MdFound): InstalledReach => {
    if (f.unreadable !== undefined) return { harness: "claude", state: "unknown", via: f.file, certainty: "official", note: "frontmatter が読めない" };
    const desc = f.description ?? firstLine(f.body);
    if (f.data["disable-model-invocation"] === true) {
      return { harness: "claude", state: "enabled", via: f.file, certainty: "official", cost: costOf(""), costBasis: "disable-model-invocation: モデルの一覧に載らない" };
    }
    return { harness: "claude", state: "enabled", via: f.file, certainty: "official", cost: costOf(claudeListingText(f.name, desc)), costBasis: "名前 + description(無ければ本文の 1 行目)" };
  };
  for (const f of readMdIn(claudeCommandsDir(), [".md"], ctx.rec, 2)) putMd(ctx, "command", "user", f, reach(f));
  if (ctx.pp !== undefined) {
    for (const f of readMdIn(ctx.pp.claudeCommandsDir, [".md"], ctx.rec, 2)) putMd(ctx, "command", "project", f, reach(f));
  }
}

/* ---- MCP -------------------------------------------------------------- */

function copilotMcpDisabled(ctx: Context, name: string): string | undefined {
  for (const l of ctx.copilot.layers) {
    if (stringList(l.values["disabledMcpServers"]).includes(name)) return `${l.file}#disabledMcpServers`;
  }
  return undefined;
}

const MCP_COST_NOTE = "ツールの定義は起動してみないと分からないので数えていない";

function collectMcp(ctx: Context): void {
  const put = (scope: ScopeKind, file: string, name: string, transport: string, reach: InstalledReach[]): void => {
    ctx.rows.put({ key: `${keyOfPath(file)}#${name}`, kind: "mcp", name, scope, origin: "config", path: file, transport, reach });
  };
  for (const [name, t] of Object.entries(ctx.claude.json.userMcp)) {
    put("user", claudeJsonPath(), name, t, [
      { harness: "claude", state: "enabled", via: `${claudeJsonPath()}#mcpServers`, certainty: "official", note: MCP_COST_NOTE },
    ]);
  }
  const copilotUser = readKeys(copilotMcpConfigPath(), ["mcpServers"], ctx.rec);
  if (copilotUser.status === "unreadable") ctx.notes.push(`読めない MCP 設定: ${copilotMcpConfigPath()}`);
  if (copilotUser.status === "ok") {
    for (const [name, t] of Object.entries(mcpNames(copilotUser.values["mcpServers"]))) {
      const off = copilotMcpDisabled(ctx, name);
      put("user", copilotMcpConfigPath(), name, t, [
        off !== undefined
          ? { harness: "copilot", state: "disabled", via: copilotMcpConfigPath(), certainty: "official", stateSource: off }
          : { harness: "copilot", state: "enabled", via: copilotMcpConfigPath(), certainty: "official", note: MCP_COST_NOTE },
      ]);
    }
  }
  if (ctx.pp === undefined) return;
  const pp = ctx.pp;

  // project: .mcp.json — Claude (with its approval lists) and Copilot (trusted folders only)
  const dotMcp = readKeys(pp.mcpJson, ["mcpServers"], ctx.rec);
  if (dotMcp.status === "unreadable") ctx.notes.push(`読めない MCP 設定: ${pp.mcpJson}`);
  const local = ctx.claude.json.local;
  if (dotMcp.status === "ok") {
    const enableAll = ctx.claude.layers.find((l) => l.values["enableAllProjectMcpServers"] === true);
    for (const [name, t] of Object.entries(mcpNames(dotMcp.values["mcpServers"]))) {
      let claude: InstalledReach;
      const settingsOn = ctx.claude.layers.find((l) => stringList(l.values["enabledMcpjsonServers"]).includes(name));
      const settingsOff = ctx.claude.layers.find((l) => stringList(l.values["disabledMcpjsonServers"]).includes(name));
      const base = { harness: "claude" as const, via: pp.mcpJson, certainty: "official" as const };
      if (local?.disabledMcpjson.includes(name) === true) claude = { ...base, state: "disabled", stateSource: "~/.claude.json#projects[root].disabledMcpjsonServers" };
      else if (settingsOff !== undefined) claude = { ...base, state: "disabled", stateSource: `${settingsOff.file}#disabledMcpjsonServers` };
      else if (local?.enabledMcpjson.includes(name) === true) claude = { ...base, state: "enabled", stateSource: "~/.claude.json#projects[root].enabledMcpjsonServers", note: MCP_COST_NOTE };
      else if (settingsOn !== undefined) claude = { ...base, state: "enabled", stateSource: `${settingsOn.file}#enabledMcpjsonServers`, note: MCP_COST_NOTE };
      else if (enableAll !== undefined) claude = { ...base, state: "enabled", stateSource: `${enableAll.file}#enableAllProjectMcpServers`, note: MCP_COST_NOTE };
      else claude = { ...base, state: "unknown", note: "承認の記録が無い(初回に Claude が確認を求める)" };
      const off = copilotMcpDisabled(ctx, name);
      const copilot: InstalledReach =
        off !== undefined
          ? { harness: "copilot", state: "disabled", via: pp.mcpJson, certainty: "official+measured", stateSource: off }
          : { harness: "copilot", state: "unknown", via: pp.mcpJson, certainty: "official+measured", note: "信頼済みのフォルダなら読む(信頼の記録は読まない)" };
      put("project", pp.mcpJson, name, t, [claude, copilot]);
    }
  }
  // project: .github/mcp.json — Copilot only, and only when there is no .mcp.json beside the root
  const ghMcp = readKeys(pp.githubMcpJson, ["mcpServers"], ctx.rec);
  if (ghMcp.status === "unreadable") ctx.notes.push(`読めない MCP 設定: ${pp.githubMcpJson}`);
  if (ghMcp.status === "ok") {
    for (const [name, t] of Object.entries(mcpNames(ghMcp.values["mcpServers"]))) {
      const off = copilotMcpDisabled(ctx, name);
      const reach: InstalledReach =
        dotMcp.status !== "missing"
          ? { harness: "copilot", state: "not-loaded", via: pp.githubMcpJson, certainty: "official+measured", note: "同じリポジトリに .mcp.json があると、こちらは読まれない(実測)" }
          : off !== undefined
            ? { harness: "copilot", state: "disabled", via: pp.githubMcpJson, certainty: "official+measured", stateSource: off }
            : { harness: "copilot", state: "unknown", via: pp.githubMcpJson, certainty: "official+measured", note: "信頼済みのフォルダなら読む(信頼の記録は読まない)" };
      put("project", pp.githubMcpJson, name, t, [reach]);
    }
  }
  // local: ~/.claude.json projects[root].mcpServers
  for (const [name, t] of Object.entries(local?.mcp ?? {})) {
    put("local", `${claudeJsonPath()}#projects`, name, t, [
      { harness: "claude", state: "enabled", via: `${claudeJsonPath()}#projects[root].mcpServers`, certainty: "official", note: MCP_COST_NOTE },
    ]);
  }
}

/* ---- plugins ---------------------------------------------------------- */

interface PluginComponents {
  skills: SkillFound[];
  commands: MdFound[];
  agents: MdFound[];
  mcpServers: string[];
}

function readPluginComponents(dir: string, rec: SourceRecorder): PluginComponents {
  const mcp = readKeys(path.join(dir, ".mcp.json"), ["mcpServers"], rec);
  return {
    skills: readSkillsIn(path.join(dir, "skills"), rec),
    commands: readMdIn(path.join(dir, "commands"), [".md"], rec, 1),
    agents: readMdIn(path.join(dir, "agents"), [".agent.md", ".md"], rec),
    mcpServers: mcp.status === "ok" && isRecord(mcp.values["mcpServers"]) ? Object.keys(mcp.values["mcpServers"]) : [],
  };
}

function componentNames(c: PluginComponents, prefix: string): NonNullable<InstalledRow["components"]> {
  return {
    skills: c.skills.map((s) => `${prefix}:${s.name}`),
    commands: c.commands.map((s) => `${prefix}:${s.name}`),
    agents: c.agents.map((s) => `${prefix}:${s.name}`),
    mcpServers: c.mcpServers,
  };
}

function boolState(v: unknown): ReachState {
  return v === true ? "enabled" : v === false ? "disabled" : "unknown";
}

function collectPlugins(ctx: Context): void {
  collectClaudePlugins(ctx);
  collectCopilotPlugins(ctx);
}

function collectClaudePlugins(ctx: Context): void {
  const file = claudeInstalledPluginsPath();
  const r = readKeys(file, ["version", "plugins"], ctx.rec);
  const seen = new Set<string>();
  if (r.status === "unreadable") ctx.notes.push(`Claude のプラグインの記録を読めない: ${file}(${r.detail})`);
  if (r.status === "ok" && r.values["version"] !== 2) {
    ctx.notes.push(`Claude のプラグインの記録の版が想定外(${String(r.values["version"])})なので読んでいない: ${file}`);
  }
  if (r.status === "ok" && r.values["version"] === 2 && isRecord(r.values["plugins"])) {
    for (const [id, records] of Object.entries(r.values["plugins"])) {
      if (!Array.isArray(records)) continue;
      for (const raw of records) {
        if (!isRecord(raw)) continue;
        const scope = raw["scope"];
        let unit: ScopeKind;
        if (scope === "user") unit = "user";
        else if ((scope === "project" || scope === "local") && ctx.root !== undefined && typeof raw["projectPath"] === "string" && normalizeRoot(raw["projectPath"]).toLowerCase() === ctx.root.toLowerCase()) unit = scope;
        else continue;
        seen.add(`${unit}:${id}`);
        const installPath = typeof raw["installPath"] === "string" ? raw["installPath"] : undefined;
        const flag = lookupFlag(ctx.claude.layers, "enabledPlugins", id);
        const state = boolState(flag?.value);
        const name = id.split("@")[0] ?? id;
        const comps = installPath !== undefined && exists(installPath) ? readPluginComponents(installPath, ctx.rec) : undefined;
        let cost: Cost | undefined;
        if (comps !== undefined) {
          const texts = [
            ...comps.skills.filter((s) => !s.disableModelInvocation).map((s) => claudeSkillText(`${name}:${s.name}`, s.description, s.whenToUse)),
            ...comps.commands.map((c) => claudeListingText(`${name}:${c.name}`, c.description ?? firstLine(c.body))),
            ...comps.agents.map((a) => claudeListingText(`${name}:${a.name}`, a.description)),
          ];
          cost = costOf(state === "enabled" ? texts.join("\n") : "");
        }
        const reach: InstalledReach = {
          harness: "claude",
          state,
          via: file,
          certainty: "official",
          ...(flag !== null ? { stateSource: flag.source } : { note: "enabledPlugins に記録が無い" }),
          ...(cost !== undefined ? { cost, costBasis: "部品(skill・command・agent)の名前 + description の合計" } : {}),
        };
        const row: Omit<InstalledRow, "id"> & { key: string } = {
          key: `claude:${id}`,
          kind: "plugin",
          name: id,
          scope: unit,
          origin: "plugin",
          path: installPath ?? file,
          reach: [reach],
        };
        if (typeof raw["version"] === "string") row.version = raw["version"];
        if (comps !== undefined) row.components = componentNames(comps, name);
        else row.findings = [{ code: "plugin.install-missing", level: "error", detail: `記録にある導入先が無い: ${installPath ?? "(記録に無い)"}` }];
        ctx.rows.put(row);
      }
    }
  }
  // Declared in a settings file but with no install record.
  const layerScope = (l: SettingsLayer): ScopeKind =>
    ctx.pp !== undefined && l.file === ctx.pp.claudeSettingsLocal ? "local" : ctx.pp !== undefined && l.file === ctx.pp.claudeSettings ? "project" : "user";
  for (const l of ctx.claude.layers) {
    const map = l.values["enabledPlugins"];
    if (!isRecord(map)) continue;
    const unit = layerScope(l);
    for (const [id, v] of Object.entries(map)) {
      if (seen.has(`${unit}:${id}`) || [...seen].some((s) => s.endsWith(`:${id}`))) continue;
      ctx.rows.put({
        key: `claude:${id}`,
        kind: "plugin",
        name: id,
        scope: unit,
        origin: "config",
        path: l.file,
        reach: [{ harness: "claude", state: boolState(v), via: `${l.file}#enabledPlugins`, certainty: "official", stateSource: `${l.file}#enabledPlugins`, note: "導入の記録が無い(この単位で宣言だけされている)" }],
        findings: [{ code: "plugin.enabled-not-installed", level: "warn", detail: "enabledPlugins にあるが、導入の記録が無い" }],
      });
    }
  }
}

const COPILOT_MANIFESTS = [[".plugin", "plugin.json"], ["plugin.json"], [".github", "plugin", "plugin.json"], [".claude-plugin", "plugin.json"]];

function collectCopilotPlugins(ctx: Context): void {
  const base = copilotInstalledPluginsDir();
  const found = new Set<string>();
  for (const mkt of listDir(base, ctx.rec)) {
    if (!isDirEntry(base, mkt)) continue;
    const mktDir = path.join(base, mkt.name);
    for (const p of listDir(mktDir, ctx.rec)) {
      if (!isDirEntry(mktDir, p)) continue;
      const dir = path.join(mktDir, p.name);
      let name = p.name;
      let version: string | undefined;
      for (const parts of COPILOT_MANIFESTS) {
        const m = readKeys(path.join(dir, ...parts), ["name", "version"], ctx.rec);
        if (m.status !== "ok") continue;
        name = str(m.values["name"]) ?? name;
        version = str(m.values["version"]);
        break;
      }
      const id = mkt.name === "_direct" ? name : `${name}@${mkt.name}`;
      found.add(id);
      const flag = lookupFlag(ctx.copilot.layers, "enabledPlugins", id);
      const state = flag === null ? "unknown" : boolState(flag.value);
      const comps = readPluginComponents(dir, ctx.rec);
      const cost = costOf(
        state === "enabled"
          ? [
              ...comps.skills.map((s) => copilotSkillText(s.name, s.description ?? "", "user")),
              ...comps.agents.map((a) => copilotAgentText(a.name, a.description ?? "")),
            ].join("")
          : "",
      );
      const row: Omit<InstalledRow, "id"> & { key: string } = {
        key: `copilot:${id}`,
        kind: "plugin",
        name: id,
        scope: "user",
        origin: "plugin",
        path: dir,
        components: componentNames(comps, name),
        reach: [
          {
            harness: "copilot",
            state,
            via: dir,
            certainty: "official",
            ...(flag !== null ? { stateSource: flag.source } : { note: "enabledPlugins に記録が無い" }),
            cost,
            costBasis: "部品(skill・agent)の 1 件分の合計(skill の location は推測)",
          },
        ],
      };
      if (version !== undefined) row.version = version;
      ctx.rows.put(row);
    }
  }
  // Declared in the repository's settings (Copilot installs these automatically).
  for (const l of ctx.copilot.layers) {
    const map = l.values["enabledPlugins"];
    if (!isRecord(map)) continue;
    const unit: ScopeKind =
      ctx.pp !== undefined && l.file === ctx.pp.copilotLocalSettings ? "local" : ctx.pp !== undefined && l.file === ctx.pp.copilotRepoSettings ? "project" : "user";
    for (const [id, v] of Object.entries(map)) {
      if (found.has(id) && unit === "user") continue;
      ctx.rows.put({
        key: `copilot:${id}`,
        kind: "plugin",
        name: id,
        scope: unit,
        origin: "config",
        path: l.file,
        reach: [
          {
            harness: "copilot",
            state: boolState(v),
            via: `${l.file}#enabledPlugins`,
            certainty: "official",
            stateSource: `${l.file}#enabledPlugins`,
            note: found.has(id) ? "導入済み。この単位の設定で有効・無効を決めている" : "導入されていない(宣言すると Copilot が自動で導入する)",
          },
        ],
      });
    }
  }
}
