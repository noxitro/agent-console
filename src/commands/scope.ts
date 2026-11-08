/**
 * `ac projects` and `ac installed` (ARCHITECTURE.md「単位とプロジェクト」).
 *
 * Both read only. `projects` writes its cache under `~/.agent-console/cache/`,
 * and `projects <action>` changes `~/.agent-console/projects.json`; neither
 * touches a harness file. The JSON payloads are the console's transport, the
 * text forms are for the terminal.
 */

import { AmError } from "../core/model.js";
import {
  discoverProjects,
  PROJECT_ACTIONS,
  readProjectSettings,
  resolveProjectId,
  updateProjectSettings,
  type ProjectAction,
  type ProjectsJson,
} from "../scope/discover.js";
import { readInstalled, type InstalledJson } from "../scope/installed.js";
import { formatTable, type CommandIo } from "./context.js";

export function isProjectAction(v: string): v is ProjectAction {
  return (PROJECT_ACTIONS as readonly string[]).includes(v);
}

export interface ProjectsOptions {
  refresh?: boolean;
  action?: string;
  target?: string;
}

export interface ProjectsActionJson {
  action: ProjectAction;
  root: string;
  projects: ProjectsJson;
}

export function projectsJson(options: ProjectsOptions): { exitCode: 0; payload: ProjectsJson | ProjectsActionJson } {
  if (options.action === undefined) {
    return { exitCode: 0, payload: discoverProjects({ refresh: options.refresh === true }) };
  }
  if (!isProjectAction(options.action)) {
    throw new AmError(`Unknown projects action "${options.action}"; expected one of ${PROJECT_ACTIONS.join(", ")}`);
  }
  if (options.target === undefined) throw new AmError(`projects ${options.action} needs a ${options.action === "add" ? "folder" : "project id"}`);
  const root = updateProjectSettings(options.action, options.target);
  return { exitCode: 0, payload: { action: options.action, root, projects: discoverProjects() } };
}

export function runProjects(options: ProjectsOptions & { io: CommandIo }): 0 {
  const { payload } = projectsJson(options);
  const io = options.io;
  const result = "action" in payload ? payload.projects : payload;
  if ("action" in payload) io.out(`${payload.action}: ${payload.root}`);
  const rows = result.projects
    .filter((p) => p.git && p.hidden !== true)
    .map((p) => [
      p.pinned === true ? "*" : "",
      p.id,
      p.name,
      p.sources.join("+"),
      p.lastUsed?.slice(0, 10) ?? "—",
      p.worktrees > 0 ? String(p.worktrees) : "",
      p.root,
    ]);
  for (const line of formatTable(["", "ID", "NAME", "SOURCE", "LAST USED", "WT", "ROOT"], rows)) io.out(line);
  const c = result.counts;
  io.out("");
  io.out(
    `記録 ${c.candidates} か所 → 一覧 ${c.listed} 件(git 外 ${c.nonGit}・非表示 ${c.hidden} を含む)。実在しない ${c.missing}、除外 ${c.excluded}、まとめたワークツリー ${c.worktreesMerged}。${result.elapsedMs} ms(キャッシュ: ${result.cache})`,
  );
  if (result.settingsError !== undefined) io.err(`warning: ${result.settingsError}`);
  return 0;
}

export interface InstalledOptions {
  project?: string;
}

function rootFor(project: string | undefined): string | undefined {
  if (project === undefined) return undefined;
  const root = resolveProjectId(project, safeSettings());
  if (root === null) throw new AmError(`Unknown project id: ${project} (run \`ac projects\` first)`);
  return root;
}

function safeSettings(): ReturnType<typeof readProjectSettings> | undefined {
  try {
    return readProjectSettings();
  } catch {
    return undefined;
  }
}

export function installedJson(options: InstalledOptions): { exitCode: 0; payload: InstalledJson } {
  const root = rootFor(options.project);
  return { exitCode: 0, payload: readInstalled(root === undefined ? {} : { root }) };
}

const STATE_LABEL: Record<string, string> = {
  enabled: "有効",
  conditional: "条件付き",
  disabled: "無効",
  "not-loaded": "読まれない",
  "via-import": "import",
  unknown: "不明",
  unconfirmed: "未確認",
};

export function runInstalled(options: InstalledOptions & { io: CommandIo }): 0 {
  const { payload } = installedJson(options);
  const io = options.io;
  if (payload.project !== undefined) io.out(`project: ${payload.project.name} (${payload.project.root})`);
  const rows = payload.rows.map((r) => [
    r.scope,
    r.kind,
    r.name,
    r.reach.map((x) => `${x.harness}:${STATE_LABEL[x.state] ?? x.state}`).join(" "),
    r.reach
      .filter((x) => x.cost !== undefined)
      .map((x) => `${x.harness}:${x.cost!.chars}`)
      .join(" "),
  ]);
  for (const line of formatTable(["SCOPE", "KIND", "NAME", "REACH", "CHARS"], rows)) io.out(line);
  io.out("");
  for (const t of payload.totals) {
    io.out(`${t.scope}/${t.harness}: ${t.chars} 字(推測 ${t.tokens} トークン)、${t.rows} 行、条件付き ${t.conditional}、未計測 ${t.unmeasured}`);
  }
  return 0;
}
