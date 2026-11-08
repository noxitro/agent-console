/**
 * State of the Installed view: which unit is chosen (個人, or a project — which
 * brings its プロジェクト and ローカル units with it), what was read for it, and
 * how the list is narrowed (search and type). Everything it shows comes from
 * `ac projects` and `ac installed`; nothing is computed here that the engine did
 * not report, except filtering and sums of what it reported.
 */

import { EngineError, installed, projectAction, projects } from "./engine.js";
import { matchesQuery } from "./installed-view.js";
import type {
  HarnessId,
  InstalledJson,
  InstalledKind,
  InstalledRow,
  ProjectAction,
  ProjectEntry,
  ProjectsJson,
  ReachState,
} from "./scope-contract.js";

export type Status = "idle" | "running" | "ready" | "failed";
export type KindFilter = "all" | InstalledKind;

/** The value of `scope` that means "the user unit only". */
export const USER_SCOPE = "user";

const ATTENTION: readonly ReachState[] = ["unknown", "unconfirmed"];

function message(err: unknown): string {
  return err instanceof EngineError || err instanceof Error ? err.message : String(err);
}

export function needsAttention(row: InstalledRow): boolean {
  return row.unreadable !== undefined || (row.findings?.length ?? 0) > 0 || row.reach.some((r) => ATTENTION.includes(r.state));
}

export class InstalledState {
  projects = $state<ProjectsJson | null>(null);
  projectsStatus = $state<Status>("idle");
  projectsError = $state("");

  /** `user`, or a project id. */
  scope = $state<string>(USER_SCOPE);
  data = $state<InstalledJson | null>(null);
  status = $state<Status>("idle");
  error = $state("");

  /** The project action in flight (pin / hide / add …), or null. */
  acting = $state<ProjectAction | null>(null);
  actionError = $state("");
  /** Which action the error is about, so it can be shown beside its own control. */
  failedAction = $state<ProjectAction | null>(null);
  /** The last completed action, said once in the live region. */
  lastAction = $state("");

  selectedId = $state<string | null>(null);
  query = $state("");
  kind = $state<KindFilter>("all");

  projectQuery = $state("");
  showNonGit = $state(false);
  showHidden = $state(false);

  readonly busy = $derived(this.projectsStatus === "running" || this.status === "running" || this.acting !== null);

  readonly project = $derived<ProjectEntry | null>(
    this.scope === USER_SCOPE ? null : (this.projects?.projects.find((p) => p.id === this.scope) ?? null),
  );

  readonly visibleProjects = $derived.by<ProjectEntry[]>(() => {
    const all = this.projects?.projects ?? [];
    const q = this.projectQuery.trim().toLowerCase();
    return all.filter(
      (p) =>
        (this.showNonGit || p.git) &&
        (this.showHidden || p.hidden !== true || p.id === this.scope) &&
        (q === "" || p.name.toLowerCase().includes(q) || p.root.toLowerCase().includes(q)),
    );
  });

  readonly allRows = $derived<InstalledRow[]>(this.data?.rows ?? []);

  /** Searched but not yet narrowed by type: what the type filter's counts are of. */
  readonly searched = $derived<InstalledRow[]>(this.allRows.filter((row) => matchesQuery(row, this.query)));

  readonly rows = $derived<InstalledRow[]>(this.searched.filter((row) => this.kind === "all" || row.kind === this.kind));

  readonly selected = $derived<InstalledRow | null>(this.allRows.find((r) => r.id === this.selectedId) ?? null);

  async start(): Promise<void> {
    await this.loadProjects();
    await this.load();
  }

  async loadProjects(refresh = false): Promise<void> {
    this.projectsStatus = "running";
    this.projectsError = "";
    try {
      this.projects = await projects({ refresh });
      this.projectsStatus = "ready";
    } catch (err) {
      this.projectsError = message(err);
      this.projectsStatus = "failed";
    }
  }

  async load(): Promise<void> {
    const scope = this.scope;
    this.status = "running";
    this.error = "";
    try {
      const data = await installed(scope === USER_SCOPE ? undefined : scope);
      if (this.scope !== scope) return; // a newer choice is on its way
      this.data = data;
      this.status = "ready";
      if (this.selectedId !== null && !data.rows.some((r) => r.id === this.selectedId)) this.selectedId = null;
    } catch (err) {
      if (this.scope !== scope) return;
      this.error = message(err);
      this.status = "failed";
    }
  }

  async choose(scope: string): Promise<void> {
    if (this.scope === scope && this.status !== "failed") return;
    this.scope = scope;
    this.selectedId = null;
    await this.load();
  }

  async reload(): Promise<void> {
    await this.loadProjects(true);
    await this.load();
  }

  async act(action: ProjectAction, target: string, label: string): Promise<boolean> {
    if (this.acting !== null) return false;
    this.acting = action;
    this.actionError = "";
    this.failedAction = null;
    this.lastAction = "";
    try {
      const result = await projectAction(action, target);
      this.projects = result.projects;
      this.projectsStatus = "ready";
      this.lastAction = label;
      return true;
    } catch (err) {
      this.actionError = message(err);
      this.failedAction = action;
      return false;
    } finally {
      this.acting = null;
    }
  }

  /** The three units' sum per harness: what a session opened in this project carries. */
  sessionTotal(harness: HarnessId): { chars: number; tokens: number; conditional: number; unmeasured: number } {
    const out = { chars: 0, tokens: 0, conditional: 0, unmeasured: 0 };
    for (const t of this.data?.totals ?? []) {
      if (t.harness !== harness) continue;
      out.chars += t.chars;
      out.tokens += t.tokens;
      out.conditional += t.conditional;
      out.unmeasured += t.unmeasured;
    }
    return out;
  }
}

/**
 * What the one live region says for this view (App.svelte owns the region).
 * `null` when there is nothing of this view's to say.
 */
export function installedAnnouncement(s: InstalledState): string | null {
  if (s.acting !== null) return "プロジェクトの設定を変更中です。";
  if (s.actionError !== "") return `操作できませんでした: ${s.actionError}`;
  if (s.projectsStatus === "failed") return `プロジェクトの一覧を読めませんでした: ${s.projectsError}`;
  if (s.status === "running") return "読み取り中です。";
  if (s.status === "failed") return `読み取れませんでした: ${s.error}`;
  if (s.lastAction !== "") return s.lastAction;
  if (s.status === "ready" && s.data !== null) {
    const unit = s.project?.name ?? "個人";
    return `${unit}: ${s.allRows.length} 件中 ${s.rows.length} 件を表示しています。`;
  }
  return null;
}
