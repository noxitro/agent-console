/**
 * 注記 — the Japanese reading of what the engine said.
 *
 * The engine speaks English, and PRODUCT fixes the display language as
 * Japanese (with asset, target and command names left in English). So the
 * interface annotates rather than replaces: every note here is a rendering of
 * one specific engine string or diagnostic code, and any string this module
 * does not recognise is shown **verbatim**. Silence is not an option —
 * inventing a friendly Japanese sentence for an unknown failure would be
 * exactly the "空表示や既定値で塗り潰す" that PRODUCT Principle 3 forbids.
 *
 * Nothing here changes a decision. The kind, the target, the path and the exit
 * code all come from the engine untouched; this only chooses the words.
 */

import type { Finding, PlanAction } from "./contract.js";

/* ------------------------------------------------------------------ */
/* doctor                                                              */
/* ------------------------------------------------------------------ */

/** One line per SPEC §5 diagnostic code, keyed exactly as `doctor` emits it. */
const FINDING_NOTES: Record<string, string> = {
  "skill.invalid-name": "ディレクトリ名が命名規則(小文字とハイフン・64字以内)に反しています。",
  "skill.missing-manifest": "SKILL.md がありません。skill として認識されません。",
  "skill.unparseable-frontmatter": "SKILL.md の frontmatter を解析できません。",
  "skill.missing-name": "SKILL.md の frontmatter に name がありません。",
  "skill.name-mismatch": "frontmatter の name とディレクトリ名が一致しません。",
  "skill.missing-description": "frontmatter に description がありません。",
  "skill.non-spec-frontmatter":
    "agentskills.io の6フィールド外の項目があります(警告。動作は妨げません)。",
  "skill.lock-unparseable": "~/.agents/.skill-lock.json を解析できません。",
  "skill.lock-invalid": "~/.agents/.skill-lock.json の形式が想定と違います。",
  "skill.lock-orphan":
    ".skill-lock.json に記録がありますが、対応する skill ディレクトリがありません。",
  "skill.broken-link": "リンク先が存在しません。断線しています。",
  "skill.unreadable":
    "権限などの理由でこのパスを読み取れません。中身が不明のため apply は書き込みを拒否します。",
  "skill.file-in-slot": "skill ディレクトリの位置にファイルが置かれています。",
  "skill.unmanaged-copy": "ソースに対応の無い実体です。am import --move で取り込めます。",
  "skill.duplicate-copy":
    "ソースと同一内容の実体が二重に置かれています。apply で junction に置き換えられます。",
  "skill.drift": "実体の内容がソースと異なります。apply は書き込みを拒否します。",
  "skill.link-elsewhere": "リンク先がソースではない場所を指しています。",
  "agent.unreadable": "ソースの agent 定義を読み取れません。",
  "agent.invalid-name": "agent 名が命名規則に反しています。",
  "agent.missing-description": "description がありません(copilot 方言の必須項目)。",
  "agent.body-too-long": "本文が copilot の上限 30,000 文字を超えています。",
  "command.legacy":
    "legacy-commands.json で古い写しと指定されたコマンドです。apply するとこの写しが配られます。",
  "console.legacy-commands-unreadable":
    "~/.agent-console/legacy-commands.json を読めません。古いコマンドの検査は行われていません。",
};

/** The Japanese note for a finding, or `null` when the code is unknown. */
export function findingNote(finding: Finding): string | null {
  return FINDING_NOTES[finding.code] ?? null;
}

/* ------------------------------------------------------------------ */
/* plan / apply                                                        */
/* ------------------------------------------------------------------ */

/**
 * Matched against `Action.detail` as `core/diff.ts` writes it. Ordered: the
 * first pattern that matches wins, so the more specific ones come first.
 */
const ACTION_NOTES: readonly { match: RegExp; note: (m: RegExpMatchArray) => string }[] = [
  {
    match: /^physical copy matches source; back up and replace with junction$/,
    note: () => "実体はソースと同一。退避のうえ junction に置き換えます。",
  },
  {
    match: /^physical copy differs from source/,
    note: () => "実体の内容がソースと異なります。置き換えを拒否します(手当てか再 import が必要)。",
  },
  {
    match: /^create junction to source skill$/,
    note: () => "ソースの skill へ junction を作成します。",
  },
  {
    match: /^copy source skill into target$/,
    note: () => "linkMode が copy のため、ソースの skill を複製します。",
  },
  {
    match: /^broken link \((.+)\); recreate$/,
    note: (m) => `断線したリンク(${m[1] ?? "リンク先不明"})を張り直します。`,
  },
  {
    match: /^link points at (.+), expected the source skill$/,
    note: (m) => `リンク先が ${m[1] ?? "不明な場所"} を指しています。ソースへ張り直します。`,
  },
  {
    match: /^linkMode is "copy"; replace link with a physical copy$/,
    note: () => "linkMode が copy のため、リンクを実体の複製に置き換えます。",
  },
  {
    match: /^copy differs from source$/,
    note: () => "複製の内容がソースと異なります。ソースの内容で上書きします。",
  },
  {
    match: /^a file occupies the skill directory path$/,
    note: () => "skill ディレクトリの位置をファイルが占有しています。",
  },
  { match: /^not present in target$/, note: () => "ターゲットに存在しません。新規に作成します。" },
  { match: /^content differs from source$/, note: () => "内容がソースと異なります。更新します。" },
  {
    match: /^present in target but absent from source$/,
    note: () => "ターゲットにのみ存在します(削除は apply --prune のみ)。",
  },
  {
    match: /^target path could not be read \((.+)\); resolve manually$/,
    note: (m) =>
      `このパスを読み取れません(${m[1] ?? "理由不明"})。中身が不明なので書き込みを拒否します。`,
  },
  {
    match: /^no verified MCP configuration format/,
    note: () => "MCP の公式仕様が未確定のため、v1 では対象外です。",
  },
];

/**
 * The Japanese note for an action, or `null` when the engine said something
 * this table does not cover — in which case the caller must show the original.
 */
export function actionNote(action: PlanAction): string | null {
  for (const entry of ACTION_NOTES) {
    const matched = action.detail.match(entry.match);
    if (matched !== null) return entry.note(matched);
  }
  return null;
}
