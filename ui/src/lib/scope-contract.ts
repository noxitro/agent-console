/**
 * The `ac projects --json` and `ac installed --json` wire contract.
 *
 * **Mirrors the engine**: `src/scope/discover.ts` (`ProjectsJson`) and
 * `src/scope/installed.ts` (`InstalledJson`). The GUI is a separate TypeScript
 * project, so the shapes are restated here. Change one, change the other.
 */

export type ProjectSource = "claude" | "copilot" | "manual";

export interface ProjectEntry {
  id: string;
  root: string;
  name: string;
  sources: ProjectSource[];
  lastUsed?: string;
  worktrees: number;
  git: boolean;
  pinned?: true;
  hidden?: true;
}

export interface DiscoveryCounts {
  candidates: number;
  missing: number;
  excluded: number;
  nonGit: number;
  hidden: number;
  worktreesMerged: number;
  listed: number;
}

export interface SourceStatus {
  label: string;
  path: string;
  status: "ok" | "missing" | "unreadable";
  detail?: string;
  records?: number;
}

export interface ProjectsJson {
  projects: ProjectEntry[];
  counts: DiscoveryCounts;
  sources: SourceStatus[];
  cache: "hit" | "partial" | "miss";
  elapsedMs: number;
  settingsError?: string;
}

export type ProjectAction = "pin" | "unpin" | "hide" | "unhide" | "add" | "forget";

export interface ProjectsActionJson {
  action: ProjectAction;
  root: string;
  projects: ProjectsJson;
}

export type HarnessId = "claude" | "copilot";
export const HARNESSES: readonly { id: HarnessId; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "copilot", label: "Copilot" },
];

export type ScopeKind = "user" | "project" | "local";
export type InstalledKind = "skill" | "agent" | "command" | "mcp" | "plugin" | "instructions";
export type ReachState = "enabled" | "conditional" | "disabled" | "not-loaded" | "via-import" | "unknown" | "unconfirmed";
export type Certainty = "official" | "measured" | "official+measured" | "unconfirmed";

export interface Cost {
  chars: number;
  tokens: number;
}

export interface InstalledReach {
  harness: HarnessId;
  state: ReachState;
  via: string;
  certainty: Certainty;
  cost?: Cost;
  costBasis?: string;
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
  components?: { skills: string[]; commands: string[]; agents: string[]; mcpServers: string[] };
  transport?: string;
  imports?: { path: string; chars: number }[];
  reach: InstalledReach[];
  findings?: InstalledFinding[];
  unreadable?: string;
}

export interface ScopeTotal {
  scope: ScopeKind;
  harness: HarnessId;
  chars: number;
  tokens: number;
  rows: number;
  conditional: number;
  unmeasured: number;
}

export interface ReadSource {
  path: string;
  status: "ok" | "missing" | "unreadable";
  detail?: string;
}

export interface InstalledJson {
  project?: { id: string; root: string; name: string };
  scopes: ScopeKind[];
  rows: InstalledRow[];
  totals: ScopeTotal[];
  unsupported: { harness: string; reason: string }[];
  notes: string[];
  sources: ReadSource[];
  elapsedMs: number;
}

/* ---- the words the screen uses ---------------------------------------- */

export const SCOPE_LABEL: Record<ScopeKind, string> = { user: "個人", project: "プロジェクト", local: "ローカル" };

export const KIND_LABEL: Record<InstalledKind, string> = {
  instructions: "指示",
  skill: "skill",
  agent: "agent",
  command: "command",
  mcp: "MCP",
  plugin: "プラグイン",
};

export const KIND_ORDER: readonly InstalledKind[] = ["instructions", "skill", "agent", "command", "mcp", "plugin"];

export const STATE_LABEL: Record<ReachState, string> = {
  enabled: "有効",
  conditional: "条件付き",
  disabled: "無効",
  "not-loaded": "読まれない",
  "via-import": "import 経由",
  unknown: "不明",
  unconfirmed: "未確認",
};

export const CERTAINTY_LABEL: Record<Certainty, string> = {
  official: "公式",
  measured: "実測",
  "official+measured": "公式・実測",
  unconfirmed: "未確認",
};

export const ORIGIN_LABEL: Record<InstalledRow["origin"], string> = {
  file: "ファイル",
  link: "リンク",
  synced: "claude.ai から同期",
  plugin: "プラグイン",
  config: "設定ファイル",
};
