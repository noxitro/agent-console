# agents-manager (`am`) — 仕様書 v3.1

> これは前身 agents-manager v3.1 の仕様。§1〜§8 は v1 の時点の記述で、その後の改訂は §9 以降にある(ターゲットは opencode を加えた 5 系統、モジュール構成も増えている)。agent-console での変更と現在の構成は [ARCHITECTURE.md](ARCHITECTURE.md) を参照。

単一ソースから AI コーディングエージェント4系統(Claude Code / Copilot CLI / VS Code Copilot / VS 2026 Copilot)のユーザーレベル資産(skills / MCP servers / custom agents)を一元管理する Windows 向け CLI。

## 1. スコープ

- v1 は**グローバル(ユーザーレベル)のみ**。プロジェクト単位配布は対象外。
- 対象OS: Windows(パスは `os.homedir()` 起点。テスト容易性のため HOME は `AM_HOME` 環境変数で上書き可能にする)。

## 2. ソースレイアウト(source of truth)

```
~/.agents-manager/
├── manifest.json         # ターゲット有効化・資産マッピング・リンク方式
├── mcp/servers.json      # 正本MCP定義(正規化スキーマ)
├── agents/<name>.md      # 正本カスタムエージェント(正規化frontmatter)
└── backups/<ISO8601ts>/  # apply前の自動退避
~/.agents/skills/<name>/  # skills の正本(生態系の既存慣習に乗る。独自ストアを作らない)
```

### manifest.json

```json
{
  "version": 1,
  "targets": {
    "claude": { "enabled": true },
    "copilot-cli": { "enabled": true },
    "vscode": { "enabled": true },
    "vs2026": { "enabled": true }
  },
  "skills": {
    "linkMode": "junction",
    "exclude": []
  }
}
```

`linkMode`: `"junction"`(既定)| `"copy"`。junction 作成失敗時は自動で copy にフォールバックし、その旨を出力。

## 3. 正規化スキーマ

### MCP (`mcp/servers.json`)

```json
{
  "servers": {
    "<name>": {
      "transport": "stdio" | "http" | "sse",
      "command": "npx", "args": ["..."], "env": {},
      "url": "https://...", "headers": {},
      "targets": ["claude", "copilot-cli", "vscode"]
    }
  }
}
```

- `transport` は正規化語彙。各方言へは render 時に変換(下記マトリクス)。
- `targets` 省略時は有効な全ターゲット。

### カスタムエージェント (`agents/<name>.md`)

YAML frontmatter + 本文(システムプロンプト)。正規化形式は**両方言の必須条件を常に満たす**:

```markdown
---
name: code-reviewer        # 必須。lowercase-hyphen
description: ...           # 必須
tools: [Read, Grep]        # 任意。正本は常にYAML配列
model: sonnet              # 任意
targets: [claude, copilot-cli, vs2026]   # 任意。省略=全有効ターゲット
---
本文...
```

`targets` は render 前に frontmatter から除去する(各エージェントへは出力しない)。

### skills

`~/.agents/skills/<name>/SKILL.md`。frontmatter は agentskills.io 仕様の6フィールド(`name`, `description` 必須 / `license`, `compatibility`, `metadata`, `allowed-tools` 任意)。`name` は小文字英数字とハイフンのみ・64字以内・親ディレクトリ名と一致。Claude拡張フィールド(`argument-hint` 等)は doctor で警告(エラーにはしない)。

## 4. ターゲット別アダプタ(確定仕様、2026-08 公式docs裏付け)

| 資産 | claude | copilot-cli | vscode | vs2026 |
|---|---|---|---|---|
| skills | `~/.claude/skills/<name>` ← junction | `~/.copilot/skills/<name>` ← junction | 発見パス共有(`~/.claude/skills` `~/.agents/skills` を直接発見。**作業不要**) | 同左(**作業不要**。根拠は VS 2026 18.5+ の公式docs であり**実機未測** — §10.7 参照) |
| MCP | `~/.claude.json` の top-level `mcpServers` キー | `~/.copilot/mcp-config.json` の `mcpServers` | `%APPDATA%/Code/User/mcp.json` の `servers` | **v1未対応**(公式仕様が裏取りできるまで。inventory/plan では "unsupported" と明示) |
| agents | `~/.claude/agents/<name>.md` | `~/.copilot/agents/<name>.agent.md` | copilot-cli と同一ディレクトリ共用(**作業不要**) | `~/.github/agents/<name>.agent.md` |

発見パス共有の3ターゲット(vscode / vs2026 / opencode)は、正本 `~/.agents/skills` の内容を
**単一の読み取り実装**(`src/adapters/skill-discovery.ts`)で報告する(§10.7)。3者の
`readSkillLinks()` は同一入力に対して同一の一覧を返さなければならず(§5)、いずれも
`planSkills()` は常に `[]` で、正本に対する `delete` を導出しない。モデル化するのは正本のみで、
`~/.claude/skills` / `~/.copilot/skills` にある資産はそれぞれ claude / copilot-cli の行として追跡する。

### MCP 方言変換

| 正規化 `transport` | claude (`type`) | copilot-cli (`type`) | vscode (`type`) |
|---|---|---|---|
| stdio | `stdio` | `local` | `stdio` |
| http | `http` | `http` | `http` |
| sse | `sse` | `sse` | 非対応 → plan で警告しスキップ |

- claude: `{ type, command, args, env }` / `{ type, url, headers }`
- copilot-cli: stdio系は `{ type: "local", command, args, env, tools: ["*"] }`
- vscode: トップレベルキーは `servers`(`mcpServers` ではない)。`inputs` キーは既存値を保全。

### エージェント方言変換

| | claude 形式 | copilot 形式 (copilot-cli / vs2026) |
|---|---|---|
| 拡張子 | `.md` | `.agent.md` |
| 必須 | `name` | `description` |
| `tools` | カンマ区切り**文字列** (`tools: Read, Grep`) | YAML **配列** (`tools: ["Read", "Grep"]`) |

本文はそのまま(copilot は本文 ≤30,000 文字。超過は doctor 警告)。

## 5. コマンド仕様

すべてのコマンドは終了コード 0=成功/差分なし、1=差分あり(plan)または診断あり(doctor)、2=エラー。

- `am inventory` — 全ターゲットの発見パスを走査し、資産ごとに「誰が何を見ているか」を表形式で表示。**読み取り専用**。junction はリンク先も表示。
- `am import` — 実環境からソースへ吸い上げ(初期移行)。同名資産がターゲット間で内容不一致の場合は両候補を提示してエラー(v1では自動解決しない。`--prefer <target>` で指定可)。skills は実体ディレクトリを `~/.agents/skills` へ移動候補として提示(`--move` で実行)。
- `am plan` — ソース vs 実環境の差分を表示。種別: `create` / `update` / `delete`(ソースに無く実環境にだけある**管理下**資産を**削除する**計画。`--prune` 指定時のみ生じる) / `preserve`(同じ資産を**削除せず残す**という記録。`--prune` なしの既定) / `link`(junction化) / `drift`(同名skillの実体二重コピー等)。**書き込みなし**。
  - `preserve` と `unsupported` は**差分ではなく注記**であり、終了コードに算入しない(`plan` は 0)。`apply` も実行しない。`--prune` なしの plan が `delete` を出すと、実行されない操作が差分として恒久的に残り §8 の不動点に到達できない(GUI の確認ダイアログも実行しない削除を提示してしまう)。**表示 = 実行**を保つため、削除する意思がある場合のみ `delete` を用いる。
- `am apply` — plan の内容を適用。適用前に変更対象ファイルを `backups/<ts>/` に元のパス構造で退避。`--dry-run` は plan と同義。**ソース側に存在しない実環境資産は削除しない**(削除は `am apply --prune` のみ、対象を列挙して確認)。
- `am doctor` — 診断: 実体二重コピー(ハッシュ比較)、壊れた junction、name制約違反、非spec frontmatter、`~/.agents/.skill-lock.json`(全 skill 共通の1ファイル)との不整合(解析不能・`skills` マップの形式違反・ロックにあるのに実体の無い skill)、copilot本文長超過。
  - **解析不能なファイルは所見にする**(§6.3 の唯一の例外)。他コマンドが exit 2 で止まる原因になるファイルは、doctor が**すべて開く**: ソースの skills / `mcp/servers.json` / agents / commands と、各ターゲットの MCP 設定 / agent ファイル / command ファイル。1種別でも開かずに残すと、その種別が壊れているとき doctor だけが「No problems found」と答える。所見コードは `mcp.unreadable` / `agent.unreadable` / `command.unreadable`(ターゲット側は `target` 付き)。

## 6. 安全要件(必須実装)

1. **`~/.claude.json` は生きた巨大状態ファイル**(oauthAccount 等)。読み書きは top-level `mcpServers` キーのみ。書き込みは 読み込み→キー差し替え→全体シリアライズ を1トランザクションで行い、他キーをバイト単位でなく**構造単位で保全**。書き込み前後で `mcpServers` 以外のキー集合が不変であることを assert。
2. **`~/.copilot/config.json` は読まない・書かない**(自己管理ファイル、`//` コメント付き非strict JSON)。
3. JSONパース失敗を空データ扱いにしない。**即エラー停止**(exit 2)。壊れた入力で apply に進ませない。
4. すべての書き込みは temp ファイル → `fs.rename` のアトミック置換。UTF-8 BOMなし、改行 LF。
5. apply 以外のコマンドは一切書き込まない(backups 含む)。
6. junction 作成は `fs.symlinkSync(target, path, "junction")`。失敗時は copy フォールバック+出力に明記。既存の実体ディレクトリがある場所への junction 化は、内容がソースと同一(ハッシュ一致)の場合のみ実体を backups へ退避して置換。不一致なら drift としてエラー。

## 7. モジュール構成

```
src/
├── cli.ts                 # commander エントリ(bin: am)
├── core/
│   ├── paths.ts           # 全パス解決(AM_HOME対応)。パスの決め打ちはここ以外禁止
│   ├── model.ts           # 正規化型定義(McpServer, AgentDef, SkillRef, Manifest)
│   ├── manifest.ts        # manifest.json 読み書き・検証
│   ├── frontmatter.ts     # YAML frontmatter parse/serialize(yamlパッケージ使用)
│   ├── fsops.ts           # アトミック書き込み・バックアップ・junction・ディレクトリハッシュ
│   └── diff.ts            # 差分エンジン(Action[] を返す。Action = {kind, target, asset, path, detail})
├── adapters/
│   ├── types.ts           # Adapter インターフェース(read / render / paths)
│   ├── claude.ts
│   ├── copilot-cli.ts
│   ├── vscode.ts
│   └── vs2026.ts
└── commands/
    ├── inventory.ts
    ├── import.ts
    ├── plan.ts
    ├── apply.ts
    └── doctor.ts
```

### Adapter インターフェース(全アダプタ共通)

```ts
interface Adapter {
  id: TargetId;
  // 実環境 → 正規化(存在しないファイルは空、パース失敗は throw)
  readMcp(): Record<string, McpServer> | "unsupported";
  readAgents(): AgentDef[];
  readSkillLinks(): SkillLink[];   // 発見パスの実態(junction/実体/欠落)
  // 正規化 → 実環境形式(文字列 or ファイル操作計画。書き込みはしない)
  renderMcp(servers: Record<string, McpServer>): FileEdit[];
  renderAgents(agents: AgentDef[]): FileEdit[];
  planSkills(skills: SkillRef[]): SkillAction[];
}
```

`FileEdit = { path, content }` / 書き込み実行は `commands/apply.ts` に集約(アダプタは計画のみ)。

## 8. テスト要件

- 単体(vitest): アダプタ毎ラウンドトリップ(正規化→render→再parse→一致)/ `~/.claude.json` merge の他キー保全 assert / パース失敗時 throw / frontmatter 方言変換(文字列⇔配列)。
- E2E: 一時ディレクトリに偽HOME(`AM_HOME`)を構築し、`import → apply → plan が差分ゼロ` の不動点を全コマンド通しで検証。junction は Windows 実 FS 上で検証。
- 実環境検証(手動ゲート): `am inventory` / `am doctor` を実HOMEに read-only 実行し、手元で把握している実態(skill の件数、実体の二重コピー、シンボリックリンク、`~/.claude.json` の `mcpServers` の中身など)を正しく報告することを目視で確かめる。

## 9. v2 拡張 — 管理コンソール対応(2026-08-18)

GUI を「タブ+テーブル+詳細ペイン」の管理コンソールへ再構成するのに伴い、エンジンに以下を追加する。**§6 の安全要件はすべてそのまま適用される**(新しい書き込み経路も例外なくバックアップ→アトミック置換を通る)。

### 9.1 manifest v2

```json
{
  "version": 2,
  "targets": { "claude": { "enabled": true }, ... },
  "skills": { "linkMode": "junction", "exclude": [] },
  "mcp":    { "exclude": [] },
  "agents": { "exclude": [] }
}
```

- v1 は**拒否せず受理**し、読み込み時に `mcp.exclude` / `agents.exclude` を空配列で補完する(既存環境を壊さない)。書き込み時のみ `version: 2` で出力。
- `exclude` に載った資産は配布対象から外れる = 「無効」。これが唯一の有効/無効の定義であり、資産ファイル自体は消さない。

### 9.2 新コマンド

| コマンド | 動作 | 終了コード |
|---|---|---|
| `am enable <skill\|mcp\|agent> <name>` | manifest の該当 `exclude` から name を除く | 0=変更あり/変更不要、2=エラー |
| `am disable <skill\|mcp\|agent> <name>` | manifest の該当 `exclude` に name を加える | 同上 |
| `am remove <skill\|mcp\|agent> <name> --yes` | **ソースから資産を削除**(skill=ディレクトリ、mcp=`servers.json` のエントリ、agent=`agents/<name>.md`)。`--yes` 必須 | 同上 |

- 3コマンドとも書き込み前に対象を `backups/<ts>/` へ退避する。`remove` は `--yes` が無ければ対象を列挙して exit 1(何も消さない)。
- 存在しない資産名は exit 2(黙って成功しない)。
- `--json` 出力: enable/disable = `{ "changed": bool, "manifestPath": string, "excluded": string[] }` / remove = `{ "removed": [{assetType, asset, path}], "backupDir": string }`

### 9.3 inventory の拡張

`InventorySource` の `mcpCount` / `agentCount`(件数のみ)を、skills と同形の**配列**へ置換する。

```ts
interface SourceSkill { name; hasSkillMd; enabled; description?; version?; modified?; origin?: { source; sourceUrl? } }
interface SourceMcp   { name; transport; enabled; targets?: TargetId[] }
interface SourceAgent { name; description; enabled; model?; targets?: TargetId[]; modified? }
```

- `enabled` = manifest の該当 `exclude` に**載っていない**こと。
- `version` は SKILL.md frontmatter の `version`(agentskills.io 仕様外の任意項目)。**無ければフィールドごと省略**する。UI はその場合「—」を描き、値を捏造しない。
- `modified` は **SKILL.md / 該当ファイル単体の mtime**(ISO8601)。ディレクトリ全走査はしない(§9.5)。
- `origin` は `~/.agents/.skill-lock.json`(skills/ の**隣**にある全 skill 共通の1ファイル。`npx skills` が書く `{ version, skills: { <name>: { source, sourceUrl, ... } }, dismissed }` 形式。doctor が検証しているのと同じファイル)の `skills[<name>]` に記録のある skill のみ。無い skill では省略。
- `mcp` の `modified` は `mcp/servers.json` 単体の mtime(サーバーは共有文書内のキーであり固有ファイルを持たない)。

### 9.4 「適用先エージェントの状態」の導出規則

GUI が資産ごとに出す3状態は、**エンジンの2つの出力を結合して**求める。GUI 独自の判定ロジックを持たせない(Product Principle 2)。

| 表示 | 導出 |
|---|---|
| `❌ 非対応` | inventory の当該ターゲット・当該種別が `"unsupported"` |
| `⚠️ 差分あり` | plan の actions に `(target, assetType, asset)` が一致する項目がある |
| `○ 適用済み(ターゲット側で無効)` | 上記いずれでもなく、inventory の当該エントリが**ターゲット自身のスイッチ**で無効(§10.3。現状 opencode の MCP のみ) |
| `✅ 適用済み(整合)` | 上記いずれでもなく、inventory の当該ターゲットに当該資産が存在する |
| `— 未配布` | 上記いずれでもない(ターゲットに存在しない) |

plan 未取得のときは「差分あり」を判定できないため、GUI は状態列を確定表示せず `PLAN 未取得` を明示する(欠測と 0 を混同しない)。これは資産テーブル・詳細ペイン・図の端子を問わず**全ての状態表示に等しく適用される**(一部の表示だけが plan 欠測時に「一致」と断定するのは違反)。

ただし `PLAN 未取得` は**plan を要する判定だけ**を覆う。`❌ 非対応` は inventory 単独で確定する事実であり、plan が無いことを理由に伏せてはならない(状態列をまとめて `PLAN 未取得` の1チップに潰すと、SPEC §10.6 が求める「opencode 以外は COMMANDS タブで `unsupported` を示す」が plan 取得まで満たされない)。導出は `deliveryFor` 側で順序どおりに済んでおり、描画側は結果をそのまま出す。

### 9.6 差分内容のプレビュー(`plan --json`)

危険な書き込みの確認は「どのファイルが変わるか」だけでなく「**何がどう変わるか**」を見せる(品質基準: GitHub Desktop / Docker Desktop 系)。そのため `plan --json` の各 action は、ファイル実体を持つ資産について内容を運ぶ。

```ts
interface JsonAction {
  /* … kind / target / assetType / asset / path / detail … */
  before?: string;          // 現在のファイル全文。create では省略(存在しない)
  after?: string;           // 書き込み後のファイル全文。delete では省略
  previewOmitted?: string;  // 上限超過などで before/after を載せなかった理由
}
```

- `before` は plan 実行時点のスナップショット。`apply` は書き込み直前に再読込・再レンダリングする(§6.1)ため、これは**プレビュー専用**であり書き込み入力ではない。
- skill は**ディレクトリ**であり単一のテキストを持たないため `before` / `after` を持たない(差分は種別と結線状態で示す)。
- `before` + `after` の合計が上限(256 KiB)を超える場合は両方を省略し `previewOmitted` に理由を入れる。切り詰めた差分を「全体」に見せてはならない。

### 9.5 性能要件

- ディレクトリ内容の全走査(`hashDirectory`)は**除外リスト**(`node_modules`、`.git`、ビルド成果物)・**総バイト数の上限**・**ファイル数の上限**を持つ。上限超過は「比較不能」として診断に出し、無言で成功・無言で失敗のどちらにもしない。
- エンジンの実行(agent-console ではワーカースレッド。ARCHITECTURE.md「エンジンのスレッド」)の時間上限は、読み取り系と書き込み系で分ける。書き込み系(apply / import / remove)は書き込み途中で打ち切らない。

### 9.7 読み取れないパス(2026-09-04)

`lstat` の失敗を一律に「存在しない」と解釈しない。**ENOENT / ENOTDIR だけが不在**であり、
それ以外(EACCES / EPERM 等)は「そこに何かがあるかもしれないが、こちらに見る権限が無い」である。
両者を混ぜると、ACL で保護された実体が `未配布` と描かれ、`plan` がその上に junction の作成を提案する —
**誰も取れなかった読み取りから書き込みを導出する**ことになる。

- `SkillLinkKind` に `unreadable` を追加する。エンジンの理由文(errno + message)を `unreadable`
  フィールドで持ち回り、UI はそれを**そのまま**描く(捏造しない)。
- `plan` は `unreadable` を **`drift`** として報告する。`apply` は drift で拒否する(§6.6)ため、
  中身の分からないものの上に書き込みは起きない。
- `apply --prune` の `delete` 導出対象から除外する。見えなかったものを削除候補にしない(§5)。
- `doctor` は `skill.unreadable` を **error** で報告する。
- 逆向きの誤りも同じ規則で禁じる: 読めなかったものを「整合」と描いてもならない。

## 10. v3 拡張 — opencode 対応と資産種別 `command`(2026-08-18)

5つ目のターゲット `opencode` を追加し、その固有資産である**ユーザー追加コマンド**を管理対象に加える。**§6 の安全要件はすべてそのまま適用される。**

### 10.1 opencode の実構造(実測、2026-08-18)

グローバル設定は `~/.config/opencode/`(Windows も同じ。`$XDG_CONFIG_HOME` があればそちら)。

| opencode の資産 | 場所 | 本ツールでの扱い |
|---|---|---|
| command | `~/.config/opencode/command/<name>.md` | **新種別 `command` として管理** |
| MCP | `~/.config/opencode/opencode.jsonc` の `mcp` キー | 既存 `mcp` 種別として管理 |
| agent | `~/.config/opencode/agent/<name>.md` | **`unsupported`**(下記 10.4) |
| skills | `~/.agents/skills`(および `~/.claude/skills`)を直接発見 | **作業不要** — vscode/vs2026 と同じ発見パス共有(下記 10.7) |

### 10.2 新資産種別 `command`

ソース: `~/.agents-manager/commands/<name>.md`。正規化 frontmatter:

```markdown
---
name: run-task             # 必須。lowercase-hyphen。ファイル名と一致
description: ...           # 必須
agent: coordinator         # 任意。opencode の担当エージェント名
targets: [opencode]        # 任意。省略 = command を支持する全有効ターゲット
---
本文($ARGUMENTS を含みうる)
```

- 現時点で `command` を支持するターゲットは **opencode のみ**。他4ターゲットは `unsupported` を返す。
- `name` の lowercase-hyphen 制約は**ソース側スキーマの制約**であり、opencode 側のファイル名には及ばない(opencode は制約を課さないので `my_thing.md` は正当なファイル)。したがって `import` は制約違反の名前を**収集段階で報告してスキップ**する — `description` 欠落と同じ扱い。書き込み段階(`writeSourceCommand` / `writeSourceAgent`)まで持ち越して throw すると、初期移行コマンドが `mcp/servers.json` 書き込み後・`--move` のディレクトリ移動後に exit 2 で中断し、ソースが半分だけ埋まった状態になる(§6.3)。doctor はターゲット側の当該ファイルを `command.invalid-name` の**警告**として報告する(ターゲットにとっては正当なので error ではない)。
- `import` は正本の `targets` セレクタを保持する。`targets` はソース専用メタデータでどのターゲットのファイルにも記録されないため、取り込んだ定義がそれと矛盾することはありえない。定義が実際に変わった場合でも、既存エントリの `targets` を引き継ぐ(落とすと配布範囲が黙って広がる)。
- render 先は `~/.config/opencode/command/<name>.md`。`name` と `targets` は frontmatter から除去し、`description` と `agent` のみを出力する(opencode が読むのはこの2つ)。
- 本文は無変換。`$ARGUMENTS` はハーネス固有の記法なので**解釈も置換もしない**。
- **ターゲット側 command ファイルの読み取りは経路で厳しさが違う**(skills の `readSkillMeta` と同じ分担: 表示は寛容、裁くのは doctor)。
  - `plan` / `apply` / `import` / `doctor` は**厳格**。frontmatter がパース不能なら throw = exit 2(§6.3)。doctor はそれを `command.unreadable`(error)として報告し、exit 1 を出す。
  - `inventory`(表示専用・書き込みなし)は**寛容**。パースできないファイルも**行として残す**: `name` はファイル名 stem、`description` 等は**欠落のまま**(空文字で埋めない)、`unreadable` にエンジンのパースエラー本文(パス込み)を載せる。**終了コードは 0 のまま** — スキャンは完遂しており、1ファイルの異常はスキャンの失敗ではない。
  - この分割は必須である。GUI の全体調査は `inventory --json` の payload **1つだけ**なので、コマンドファイル1件の破損で全ターゲット・全 skill・全 MCP が消えて管理コンソール全体が障害プレートになる。壊れたファイルを見せるために、他の全部を隠してはならない。

### 10.3 opencode の MCP 方言

`opencode.jsonc` は **JSONC**(コメント可)。書き込みは `jsonc-parser` の `modify()` + `applyEdits()` による**外科的編集**で行い、コメント・整形・他キーを保全する(§6.1 と同じ趣旨)。全体を再シリアライズしてコメントを落とすことは**サイレントなデータ損失**であり禁止。

| 正規化 `transport` | opencode |
|---|---|
| stdio | `{ "type": "local", "command": [<command>, ...<args>], "environment": <env>, "enabled": true }` |
| http | `{ "type": "remote", "url": <url>, "headers": <headers>, "enabled": true }` |
| sse | 同上(**remote に潰れる**) |

- `command` は実行ファイルと引数を**一体の配列**で持つ(他方言の `command` + `args` 分離とは異なる)。環境変数のキー名は `env` ではなく **`environment`**。
- **http と sse は opencode 上で区別できない**。したがって opencode から `import` した remote サーバーの `transport` は `http` として取り込む。これは復元不能な情報であり、`import` 時に注記として報告する(黙って推測しない)。
  - この `http` は**観測ではなく推測**である。`import` は推測を「ターゲット間の不一致」として扱ってはならない: 同じサーバーを claude が `sse`、opencode が `remote` で持つ状態は `apply` 自身が作るので、そこで conflict を出すと本ツールの出力が本ツールのコマンドを恒久的に壊す。推測が(a)ソースの既存エントリと、または(b)他ターゲットの観測と、当該区別を除いて一致するなら、推測側を採用しない。
- **`enabled: false` はターゲット側のスイッチ**。書き戻し時に owner が設定した `false` を保存する(本ツールが触っていないスイッチを黙って戻さない)。正規化スキーマに対応フィールドは無いので、(a) `inventory` の当該ターゲットの MCP エントリに `enabled` として載せ(GUI が §9.4 の 状態を出せるように)、(b) `import` 時に注記として報告する。無い場合はフィールドごと省略する(「スイッチが無い」と「オン」は別の事実)。
- 未知フィールド(`cwd` / `timeout` / `oauth` 等)は読み取り時に保持し、書き戻し時に復元する。落としてはならない。
- **書き込みが読み手の見る場所に着地したことを assert する**(§6.1 と同じ趣旨)。`jsonc-parser` の `parse()` は重複キーの**最後**を、`modify()` は**最初**を採る。したがって `mcp`(またはその中のサーバー名)が二重に書かれた文書は読み書きで指す実体が食い違い、編集が誰も読まない塊に着地したうえで以後の `plan` が恒久的に「差分なし」と報告する。そのような文書は読み取り時点で **exit 2** で拒否し(§6.3)、加えて render 後に再パースして `mcp` が意図どおりであることを検証する。
- **外科的編集が保全する範囲を過大に述べない**。`modify()` は値ノードを丸ごと置換するため、保全されるのは編集が触らない範囲(エントリ間のコメント・空行・キー順・インデント・変更しないサーバー)であり、**書き換えるエントリの内部**のコメントや整形は残らない。また §6.4 に従い書き込みは LF 正規化される(CRLF の設定ファイルは、管理エントリが実際に変わったときに LF になる)。いずれも確認ダイアログの差分プレビューで見える範囲に収める。

### 10.4 opencode の agents を対象外とする根拠

opencode の agent frontmatter は他3系統と**意味論が異なり、安全な相互変換ができない**:

| | claude | copilot | opencode |
|---|---|---|---|
| `tools` | カンマ区切り文字列(許可リスト) | YAML 配列(許可リスト) | **map(ツール名 → 真偽)** |
| 権限 | `permissionMode` | — | **`permission` ブロック**(`bash: {"*": deny}` 等) |
| その他 | — | — | `mode: subagent\|primary`、`temperature` |

`tools` の許可リストを opencode の真偽マップへ機械変換するには opencode 固有のツール語彙(`write` / `edit` / `bash` …)への対応表が要り、対応の無いツールは**黙って権限面を変える**。`permission` ブロックには他方言に等価物が無い。したがって opencode の agents は `readAgents()` / `renderAgents()` とも `"unsupported"` を返し、inventory・plan で理由付きで明示する。**変換できないものを変換したふりをしない。**

### 10.5 manifest v3

```json
{
  "version": 3,
  "targets": { "claude": {...}, "copilot-cli": {...}, "vscode": {...}, "vs2026": {...}, "opencode": { "enabled": true } },
  "skills":   { "linkMode": "junction", "exclude": [] },
  "mcp":      { "exclude": [] },
  "agents":   { "exclude": [] },
  "commands": { "exclude": [] }
}
```

v1 / v2 は拒否せず受理し、欠けたキーを空で補完する。書き込み時のみ `version: 3` で出力。既存の v1 / v2 の `~/.agents-manager/manifest.json` は次の書き込みで v3 へ上がる。

### 10.6 GUI

- タブに **COMMANDS** を追加(SKILLS / MCP / AGENTS / COMMANDS)。opencode 以外は当該タブで `unsupported` を示す。
- inventory が `unreadable` を立てたターゲット側ファイルは、当該資産の行に**不良マーク**を出す(既存の「不良のみ」フィルタに乗る)。詳細ペインは当該ターゲットの行にパースエラー本文を出す。`unreadable` は配布状態(§9.4 の5状態)とは別軸の事実であり、状態を潰して上書きしてはならない(「届いている」と「読める」は別の問い)。
- ツールバーの状態フィルタ(すべて / 不良のみ / 差分ありのみ / 無効のみ)の隣に**ターゲット絞り込み**を追加: `all` / `claude` / `opencode` / `copilot-cli` / `vscode` / `vs2026`。選択時は、その ターゲットに関係する資産だけを一覧に残す。
- **タブの軸は資産種別のままとする**。エージェント別にタブを切ると「1資産がどこへ届いているか」を追うのにタブ往復が必要になり、PRODUCT.md が定める第2の仕事(追跡)が壊れるため。エージェント別の俯瞰はターゲット絞り込みとマップビューが担う。
- ターゲット絞り込みは表示のみに作用し、plan / apply の対象は変えない(**表示 = 実行**の原則は「確認ダイアログが列挙する操作」に係るものであり、一覧の絞り込みは別事項。ただし絞り込み中に一括適用を押した場合、実行されるのは絞り込みで隠れた分も含む全件であることを確認ダイアログが明示する)。
  - この但し書きは**タブ(資産種別)・検索語・状態フィルタ・ターゲット絞り込みのすべて**を勘定する。一覧は常に1種別しか映さないので、ターゲット絞り込みだけを数えて「すべて一覧に出ているものです」と断定するのは、複数種別に触れる plan では必ず偽になる。断定してよいのは「実行される操作の全体は確認ダイアログの一覧である」ことだけで、背後の一覧との一致を約束してはならない。
- **GUI ブリッジ(Tauri)の引数語彙は CLI と同じでなければならない**(Product 原則2)。`enable` / `disable` / `remove` の資産種別は `ASSET_KIND_IDS` の4種、`--prefer` のターゲットは `TARGET_IDS` の5種。ブリッジ側は手書きの表なので、エンジン側の定義と突き合わせるテストを置く(agent-console では Tauri のブリッジに代わって `src/server/vocabulary.ts` の固定表が担い、`src/server/vocabulary.test.ts` が `ASSET_KIND_IDS` / `TARGET_IDS` と突き合わせる。ARCHITECTURE.md「API の語彙」)。

### 10.7 改訂 — opencode の skills は発見パス共有(2026-08-23)

v3 が「skills = `unsupported`(発見場所なし)」と記録したのは**実測の誤り**だった。実機(Windows 11, 2026-08-23 時点)では opencode はクロスエージェント標準ルート `~/.agents/skills` を直接発見し、セッション内でスキルを列挙・使用できる。これは vscode / vs2026 と同じ構図(SPEC §4 の「発見パス共有、作業不要」)であり、正本ストア自体が発見パスなので配布作業はそもそも存在しない。

したがって opencode アダプタの skills の扱いは次のように改訂する。**§6 の安全要件はすべてそのまま適用される。**

- `paths().skillsDir` は `~/.agents/skills`(正本そのもの)を報告する(inventory 表示用)。
- `readSkillLinks()` は当該ディレクトリの内容を分類(junction / symlink / 実体 / 欠落 / broken)して報告する。**「誰が何を見ているか」(SPEC §5)に opencode が数えられる**ために必要。
  - **「vscode と同じ分類」では足りない。読み取り実装そのものを共有する**(`src/adapters/skill-discovery.ts`)。同じディレクトリを2つのターゲットが読む以上、SPEC §5 は2つの読みが食い違うことを許さない。初版は分類関数を両アダプタにコピーしたため実際に食い違った(片方は直下のファイルも列挙し、片方はディレクトリのみ)。`~/.agents/skills/notes.txt` を置くと inventory が「opencode には見えて vscode には見えないもの」を1行描く。コピーの規律ではなく単一実装で不変条件を保つ。
  - 列挙対象は**ディレクトリ形状の項目のみ**。skill は `SKILL.md` を含むディレクトリなので、直下のただのファイルはどのターゲットも発見しない。列挙すれば「誰も見ていないもの」の行を inventory に描くことになり、DESIGN.md の「存在しない値を描かない」に反する。並び順は `localeCompare` に固定する(読みごとに順序が変わってはならない)。
- `planSkills()` は常に `[]`。materialization は正本を所有するターゲットが既に行っており、ここで計画すると二重の action(最悪、正本に対する `delete` 導出)になる。vscode と同じ不変条件。
- `unsupportedReason("skill")` は廃止。inventory / plan の `unsupportedReasons` には agent のみが載る。
- `sharesDiscoveryWith` は**設定しない**(vs2026 と同じ理由: MCP と command は所有するため「何も要らない」は半分しか真でない)。
- import / doctor の skill リンク検査は、既存の「skillsDir が正本と同一ならスキップ」のガード(src/commands/import.ts, doctor.ts)によって自動的に正しくスキップされる。

なお opencode が `~/.claude/skills` も発見することは実機で確認されているが、モデル化するのは正本 `~/.agents/skills` のみとする(vscode が §4 で2つの発見パスを持ちながら正本のみをモデル化しているのと同じ判断)。claude 側ディレクトリにある資産は claude ターゲットの行として追跡される。

#### 解決 — vs2026 の skills(2026-09-04)

v3.1 まで `src/adapters/vs2026.ts` の `readSkillLinks()` は `UNSUPPORTED` を返し、理由を
「正本に対する `delete` を呼び出し側が導出できないようにするため」としていた。**この理由は
成り立たない。** `readSkillLinks()` の呼び出し側は inventory / json(表示のみ)と doctor /
import(`skillsDir` が正本と同一ならその手前でスキップ)だけであり、`delete` を導出するのは
各アダプタ自身の `planSkills()` が `diffSkills` の `orphans` に自分のディレクトリの一覧を
渡す経路(claude / copilot-cli)のみである。vs2026 の `planSkills()` は `[]` を返すので、
一覧を報告しても `delete` は生まれない。

したがって vs2026 も共有読み手に加える。`readSkillLinks()` は `readSharedSkillLinks()` に
委譲し、`skill-discovery.test.ts` の `SHARED_READERS` と e2e の C5 チェックは3者
(vscode / vs2026 / opencode)の一致を測る。`am inventory --json` の vs2026 は
`skills: "unsupported"` ではなく実一覧を返し、GUI の適用先バッジは vscode / opencode と
同じく実状態になる。

`sharesDiscoveryWith` は引き続き**設定しない**。この語は「他ターゲットのディレクトリを発見する
ため一切の作業が要らない」の意で、vs2026 は `~/.github/agents` を所有し agent を書くため
半分しか真でない。skills だけの共有は §4 の「単一の読み取り実装」で表現する。

**未測**: §4 の根拠は VS 2026 18.5+ の公式docs であって実機測定ではない(v3 が opencode で
犯した誤りと同種)。VS 2026 が `~/.agents/skills` の skill を実際に列挙・発動することの実測は
別途行い、結果をここに追記する。本決定が報告するのは「そのディレクトリに何があるか」であり、
VS 側の挙動が違っても正本の一覧が誤りになるわけではないが、§4 の vs2026 列は実測で改める。
