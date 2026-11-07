/**
 * The GUI's only door to the engine.
 *
 * Every call is a `POST /api/run` to the local agent-console server, which runs
 * the same `main(argv)` the `ac` command runs — in its own process — with
 * `--json` appended, and hands back stdout, stderr and the exit code. The GUI
 * therefore cannot compute a different answer than the CLI
 * (PRODUCT: "CLI と GUI は同じ真実").
 *
 * The server checks two per-start secrets on every call: the HttpOnly cookie
 * travels by itself, and the `X-Console-Token` header is filled from this tab's
 * sessionStorage ("ac-token"), which `/launch.js` fills from the one-time launch
 * page. `index.html` carries no secret, only the `ac-served` mark.
 *
 * When the page was not served by the agent-console server — `npm run dev` from
 * Vite — the transport falls back to `fixtures.ts`, which answers on
 * the same wire with the same exit codes. The fallback is deliberately loud in
 * the console and visible in the interface; it must never be mistaken for a
 * reading of the real machine.
 *
 * The exit-code contract of SPEC §5 is preserved rather than flattened:
 *
 *  - `0` — success / no difference
 *  - `1` — a difference exists (`plan`) or diagnostics were found (`doctor`)
 *  - `2` — an error; stdout carries `{ error: { message, path? } }`
 *
 * `1` is **not** a failure, so it resolves normally and the caller reads the
 * payload. Only `2` (or an unreadable response) rejects, as an `EngineError`.
 */

import type {
  Apply,
  AssetType,
  Doctor,
  ExcludeResult,
  Import,
  Inventory,
  Plan,
  RemoveResult,
  TargetId,
  WireError,
} from "./contract.js";
import type { AmOutput, EngineTransport } from "./transport.js";

export type { AmOutput, EngineTransport } from "./transport.js";

/**
 * Phrase in the engine's own "a write was stopped part-way" messages (the
 * engine thread failing during a write: `src/server/engine-queue.ts`).
 *
 * Messages this module writes itself do not rely on the phrase: they set
 * `EngineError.partialWrite` explicitly.
 */
export const PARTIAL_WRITE_MARK = "the write may be incomplete";

/** A command that returned exit 2, or a response that could not be read. */
export class EngineError extends Error {
  readonly path: string | undefined;
  readonly code: number | null;
  readonly stderr: string;
  /** The engine was stopped mid-write; the machine may be half-written. */
  readonly partialWrite: boolean;
  /** This tab holds no usable key (none, or one from an earlier server). */
  readonly keyless: boolean;
  /**
   * The report a failed run still produced.
   *
   * `am apply --json` answers a failure with its audit trail — the actions that
   * did run, the one that threw, and the `backups/<ts>/` directory holding what
   * they overwrote — alongside the error. Throwing that away and showing only
   * the message would leave a half-applied machine with no record of what
   * changed, which is the one thing a write command must never do.
   */
  readonly partial: Apply | undefined;

  constructor(
    message: string,
    options: {
      path?: string;
      code?: number | null;
      stderr?: string;
      partial?: Apply | undefined;
      /** Set by the transport; defaults to the engine's own phrase. */
      partialWrite?: boolean;
      keyless?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "EngineError";
    this.path = options.path;
    this.code = options.code ?? null;
    this.stderr = options.stderr ?? "";
    this.partialWrite = options.partialWrite ?? message.includes(PARTIAL_WRITE_MARK);
    this.keyless = options.keyless ?? false;
    this.partial = options.partial;
  }
}

/** A payload plus the exit code it came with (SPEC §5). */
export interface EngineResult<T> {
  payload: T;
  exitCode: number | null;
  /** Human-readable narration the engine wrote to stderr, if any. */
  stderr: string;
}

/* ------------------------------------------------------------------ */
/* Transport selection                                                 */
/* ------------------------------------------------------------------ */

/** How the engine is currently being reached. Surfaced in the interface. */
export type EngineMode = "server" | "fixture";

/** Subcommands that write; a transport failure during one may leave a half-write. */
const WRITE_COMMANDS = new Set(["apply", "import", "remove", "enable", "disable"]);

/**
 * The header token this tab was given on the launch page, or `null`.
 *
 * It lives in `sessionStorage`, which is scoped to this origin *and port*,
 * rather than in the page: the cookie is sent to every port on 127.0.0.1, so a
 * token the server wrote into `index.html` could be fetched by anything that
 * had caught the cookie.
 */
export function serverToken(): string | null {
  try {
    const token = globalThis.sessionStorage?.getItem("ac-token") ?? "";
    return token === "" ? null : token;
  } catch {
    return null;
  }
}

/** Was this page served by the agent-console server (with or without a key)? */
export function servedByServer(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('meta[name="ac-served"]') !== null;
}

/**
 * Phrase in the server's refusal of an apply whose plan changed after the
 * dialog showed it (`STALE_PLAN_MARK` in `src/server/app.ts`). The session
 * drops the plan it is holding when it sees this, so the screen stops
 * offering a confirmation that the server will refuse again.
 */
export const STALE_PLAN_MARK = "確認画面を出した後に plan が変わった";

/** What a tab without a usable key is told (no key, or one from an earlier server). */
export const KEYLESS_MESSAGE =
  "このタブでは操作できません。アドレスを直接開いたタブや、前に起動したときのタブには、このサーバーの鍵がありません。agent-console.bat を実行して、開いたタブを使ってください。";

const UNREACHABLE_MESSAGE =
  "agent-console のサーバーに届きませんでした。サーバーの黒いウィンドウが閉じていれば、agent-console.bat で起動し直してください。";

/** A served page whose tab has no key: every call fails with the way back. */
const keylessTransport: EngineTransport = {
  run: () => Promise.reject(new EngineError(KEYLESS_MESSAGE, { keyless: true })),
};

/** Turn a non-engine answer of the server into the message the owner reads. */
function refusal(status: number, payload: unknown): EngineError {
  if (status === 401) return new EngineError(KEYLESS_MESSAGE, { keyless: true });
  const message = (payload as { error?: unknown } | null)?.error;
  return new EngineError(
    typeof message === "string"
      ? `agent-console のサーバーが要求を断りました(${status}): ${message}`
      : `agent-console のサーバーが ${status} を返しましたが、内容を読めませんでした。`,
  );
}

/**
 * The digest of the last plan the server returned, per `--prune`. An `apply`
 * presents it so the server executes only the plan the dialog showed
 * (ARCHITECTURE.md「守り」); if the machine moved in between, the server refuses with 409.
 */
const planDigests = new Map<"plain" | "prune", string>();

function pruneKey(args: readonly string[]): "plain" | "prune" {
  return args.includes("--prune") ? "prune" : "plain";
}

/**
 * Only `plan` carries a digest. `apply --dry-run` describes the same work in the
 * shape of an apply report, so its digest would never match a fresh plan.
 */
function isPlanReading(args: readonly string[]): boolean {
  return args[0] === "plan";
}

/** The transport to the agent-console server (`POST /api/run`). */
export function serverTransport(
  token: string,
  fetcher: typeof fetch = (...a) => fetch(...a),
): EngineTransport {
  return {
    async run(args: string[]): Promise<AmOutput> {
      const command = args[0] ?? "";
      const writes = WRITE_COMMANDS.has(command) && !args.includes("--dry-run");
      const boundToPlan = command === "apply" && writes;
      const body: { args: string[]; digest?: string } = { args };
      if (boundToPlan) {
        const digest = planDigests.get(pruneKey(args));
        if (digest !== undefined) body.digest = digest;
      }
      const post = (url: string, text: string): Promise<Response> =>
        fetcher(url, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Console-Token": token },
          body: text,
        });

      if (writes) {
        // Before a write, make sure the server is there at all. A server that
        // has already stopped (終了 in another tab, the idle timeout) is then
        // reported as "nothing was written" — not as a write that may be
        // half-done, which is what a lost connection during the write means.
        let ping: Response;
        try {
          ping = await post("/api/ping", "{}");
        } catch (err) {
          throw new EngineError(`${UNREACHABLE_MESSAGE} 何も書き込んでいません。(${String(err)})`);
        }
        if (!ping.ok) throw refusal(ping.status, await ping.json().catch(() => null));
      }

      let response: Response;
      try {
        response = await post("/api/run", JSON.stringify(body));
      } catch (err) {
        if (!writes) throw new EngineError(`${UNREACHABLE_MESSAGE}(${String(err)})`);
        throw new EngineError(
          `書き込みの要求を送った後で、サーバーとの接続が切れました。書き込みが途中で止まった可能性があります。(${String(err)})`,
          { partialWrite: true },
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw refusal(response.status, null);
      }
      if (!isAmOutput(payload)) throw refusal(response.status, payload);
      const digest = (payload as { digest?: unknown }).digest;
      if (isPlanReading(args) && typeof digest === "string") planDigests.set(pruneKey(args), digest);
      // A plan that was carried out is spent. A failed apply keeps it: pressing
      // 適用 again then gets the server's answer about the plan (stale, most
      // likely, since a partial write changed the machine) instead of a 428.
      if (boundToPlan && payload.code !== 2) planDigests.delete(pruneKey(args));
      return { stdout: payload.stdout, stderr: payload.stderr, code: payload.code };
    },
  };
}

function isAmOutput(value: unknown): value is AmOutput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["stdout"] === "string" &&
    typeof v["stderr"] === "string" &&
    (typeof v["code"] === "number" || v["code"] === null)
  );
}

let transport: EngineTransport | null = null;
/** In-flight resolution, so concurrent first calls share one fallback. */
let resolving: Promise<EngineTransport> | null = null;
let mode: EngineMode = "server";
let fixtureLabel = "";

/** True when this tab holds the header token the launch page handed it. */
export function hasServer(): boolean {
  return serverToken() !== null;
}

/**
 * Replace the transport — used by the fixture fallback and by tests. Passing
 * `null` restores automatic selection.
 */
export function setTransport(
  next: EngineTransport | null,
  options: { mode?: EngineMode; label?: string } = {},
): void {
  transport = next;
  resolving = null;
  mode = options.mode ?? (next === null ? "server" : "fixture");
  fixtureLabel = options.label ?? "";
}

/** Which transport answered the last call, for the interface to disclose. */
export function engineMode(): EngineMode {
  return mode;
}

/** Human-readable name of the active fixture scenario; empty in server mode. */
export function engineModeLabel(): string {
  return fixtureLabel;
}

function resolveTransport(): Promise<EngineTransport> {
  if (transport !== null) return Promise.resolve(transport);
  const token = serverToken();
  if (token !== null) {
    transport = serverTransport(token);
    mode = "server";
    return Promise.resolve(transport);
  }
  if (servedByServer()) {
    // The real console without a key must say so, not quietly show the fake
    // machine: that would be a reading nobody took.
    transport = keylessTransport;
    mode = "server";
    return Promise.resolve(transport);
  }
  // Single-flight: `survey()` fires inventory and doctor together, and two
  // fixture machines would each keep their own copy of the environment.
  resolving ??= loadFixture();
  return resolving;
}

async function loadFixture(): Promise<EngineTransport> {
  // Loaded on demand so the fixture never ships inside the served bundle's
  // entry chunk.
  const { fixtureTransport, isScenarioId, SCENARIOS } = await import("./fixtures.js");
  const requested = new URLSearchParams(window.location.search).get("fixture") ?? "machine";
  const scenario = isScenarioId(requested) ? requested : "machine";
  console.warn(
    `[agent-console] No agent-console server found. Serving the "${scenario}" fixture instead of the real engine: ${SCENARIOS[scenario]}`,
  );
  transport = fixtureTransport(scenario);
  mode = "fixture";
  fixtureLabel = SCENARIOS[scenario];
  return transport;
}

/* ------------------------------------------------------------------ */
/* Wire                                                                */
/* ------------------------------------------------------------------ */

/**
 * Run one engine command. `--json` is appended by the server, so callers
 * pass only the command and its flags.
 */
async function run<T>(args: string[]): Promise<EngineResult<T>> {
  const active = await resolveTransport();
  let output: AmOutput;
  try {
    output = await active.run(args);
  } catch (err) {
    // No engine result at all: the server is gone, or it refused the request
    // (token, vocabulary). The server transport already says which; anything
    // else (a test transport, the fixture) is wrapped as it is.
    if (err instanceof EngineError) throw err;
    throw new EngineError(typeof err === "string" ? err : String(err));
  }

  const parsed = parseJson(output);
  if (isWireError(parsed)) {
    // A failure payload that carries more than the error is a *report* of a
    // partial run (`apply`); it travels with the error instead of being lost.
    const partial = partialReport(parsed);
    throw new EngineError(parsed.error.message, {
      ...(parsed.error.path !== undefined ? { path: parsed.error.path } : {}),
      code: output.code,
      stderr: output.stderr,
      ...(partial !== undefined ? { partial } : {}),
    });
  }
  if (output.code === 2) {
    // Exit 2 without a readable error object should not happen; treat the
    // stderr text as the message rather than pretending the run succeeded.
    throw new EngineError(output.stderr.trim() || "The engine failed without a message.", {
      code: output.code,
      stderr: output.stderr,
    });
  }
  return { payload: parsed as T, exitCode: output.code, stderr: output.stderr };
}

function parseJson(output: AmOutput): unknown {
  const text = output.stdout.trim();
  if (text === "") {
    throw new EngineError(output.stderr.trim() || "The engine produced no output.", {
      code: output.code,
      stderr: output.stderr,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EngineError(`The engine produced output that is not JSON: ${truncate(text)}`, {
      code: output.code,
      stderr: output.stderr,
    });
  }
}

function isWireError(value: unknown): value is WireError {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

/** The `apply` report riding along with an error payload, when there is one. */
function partialReport(value: WireError): Apply | undefined {
  const applied = (value as unknown as { applied?: unknown }).applied;
  if (!Array.isArray(applied)) return undefined;
  const backupDir = (value as unknown as { backupDir?: unknown }).backupDir;
  return {
    applied: applied as Apply["applied"],
    ...(typeof backupDir === "string" ? { backupDir } : {}),
    error: value.error,
  };
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/** `am inventory` — who sees what. Read-only. */
export async function inventory(): Promise<Inventory> {
  return (await run<Inventory>(["inventory"])).payload;
}

/** `am doctor` — diagnostics. Read-only; exit 1 simply means "findings exist". */
export async function doctor(): Promise<Doctor> {
  return (await run<Doctor>(["doctor"])).payload;
}

/** `am plan` — the difference between the source of truth and the machine. */
export async function plan(options: { prune?: boolean } = {}): Promise<Plan> {
  const args = ["plan", ...(options.prune === true ? ["--prune"] : [])];
  return (await run<Plan>(args)).payload;
}

/**
 * `am apply` — the only writing command.
 *
 * `dryRun` is `am plan` by construction. `prune` requires `yes`, exactly as on
 * the command line: the engine refuses to delete without it (SPEC §5), and the
 * GUI must not paper over that confirmation step.
 */
export async function apply(
  options: { dryRun?: boolean; prune?: boolean; yes?: boolean } = {},
): Promise<Apply> {
  const args = [
    "apply",
    ...(options.dryRun === true ? ["--dry-run"] : []),
    ...(options.prune === true ? ["--prune"] : []),
    ...(options.yes === true ? ["--yes"] : []),
  ];
  return (await run<Apply>(args)).payload;
}

/**
 * `am import` — lift the existing environment into the source of truth.
 *
 * Named `importCmd` because `import` is a reserved word.
 */
export async function importCmd(
  options: { prefer?: TargetId; move?: boolean } = {},
): Promise<Import> {
  const args = [
    "import",
    ...(options.prefer !== undefined ? ["--prefer", options.prefer] : []),
    ...(options.move === true ? ["--move"] : []),
  ];
  return (await run<Import>(args)).payload;
}

/* ------------------------------------------------------------------ */
/* Asset commands (SPEC §9.2)                                          */
/* ------------------------------------------------------------------ */

/**
 * `am enable` / `am disable` — the console's on/off toggle.
 *
 * These go through the engine for the same reason `apply` does: the manifest is
 * a file with a backup path and a validator, and a GUI that edited it directly
 * would be a second implementation of the rules (Product Principle 2), one with
 * no backup (Principle 1). The exit code is 0 whether or not anything changed;
 * the payload's `changed` says which.
 */
export async function setAssetEnabled(
  assetType: AssetType,
  name: string,
  enabled: boolean,
): Promise<ExcludeResult> {
  const command = enabled ? "enable" : "disable";
  return (await run<ExcludeResult>([command, assetType, name])).payload;
}

/**
 * `am remove --yes` — delete an asset from the source of truth.
 *
 * `--yes` is passed because the confirmation it stands for has just been given
 * in the dialog. It does not touch the targets: the copies already delivered
 * are removed by `apply --prune`, which has its own confirmation.
 */
export async function removeAsset(assetType: AssetType, name: string): Promise<RemoveResult> {
  return (await run<RemoveResult>(["remove", assetType, name, "--yes"])).payload;
}

/**
 * Stop the agent-console server (ARCHITECTURE.md「起動と終了」: 画面の「終了」ボタン).
 *
 * Not an engine command, so it does not go through `run`: there is no argv and
 * no JSON contract, only the server's own `{ ok: true }`. Outside the server
 * (the fixture) there is nothing to stop, and saying "stopped" would be a lie,
 * so it refuses.
 */
export async function shutdownServer(): Promise<void> {
  const token = serverToken();
  if (token === null) {
    throw servedByServer()
      ? new EngineError(KEYLESS_MESSAGE, { keyless: true })
      : new EngineError("このページは agent-console のサーバーから開かれていません。");
  }
  let response: Response;
  try {
    response = await fetch("/api/shutdown", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Console-Token": token },
      body: "{}",
    });
  } catch (err) {
    throw new EngineError(`${UNREACHABLE_MESSAGE}(${String(err)})`);
  }
  // 409: a write is running and the server will not cut it off; its message says so.
  if (!response.ok) throw refusal(response.status, await response.json().catch(() => null));
}

export type { Apply, Doctor, Import, Inventory, Plan } from "./contract.js";
