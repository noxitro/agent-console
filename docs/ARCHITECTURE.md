# agent-console のアーキテクチャ

agent-console は、Claude Code や GitHub Copilot などのコーディングエージェントのカスタマイズ資産(skill・MCP サーバー・カスタムエージェント・コマンド)を、**ブラウザで**一覧・追跡・操作する Windows 向けのローカルツールである。

前身の agents-manager(`am`)v3.1 から、エンジン・アダプタ・テスト・安全機構を引き継いでいる。エンジンの振る舞い(ソースの置き場所、各ターゲットの方言、コマンドの仕様、安全要件)は [SPEC.md](SPEC.md) が正で、この文書は agent-console で変わったこと(画面の配り方、ローカルサーバーの守り、今後のフェーズ)を書く。

コードのコメントは、この文書の見出し名で参照している(例: `ARCHITECTURE.md「守り」`)。見出しの名前を変えるときは、参照も合わせて直すこと。

---

## 全体構成

```text
ブラウザ (Svelte の画面)  ──HTTP(Cookie + X-Console-Token)──▶  ローカルサーバー (Node, 127.0.0.1)
                                                               │
                                                               ├─ app.ts / security.ts   ルーティングと守り
                                                               ├─ vocabulary.ts          API が受け付ける argv の固定表
                                                               ├─ engine-queue.ts        エンジンの仕事の待ち行列
                                                               │    └─ engine-worker.ts  ワーカースレッド上のエンジン
                                                               │         (inventory / doctor / plan / apply …、JSON 契約)
                                                               └─ exec.ts                他のプログラムを起動するのはここだけ
```

- **サーバーとエンジンは同じプロセス。** CLI の `main(argv, { io })` を、出力を貯める `io` で直接呼ぶ(`src/server/engine-runner.ts`)。画面が受け取るのは、端末で `ac <args> --json` を実行したときと同じバイト列・同じ終了コードで、CLI と画面が別の答えを出すことは構造上ない。
- エンジンは同じプロセスの**ワーカースレッド**で動く(「エンジンのスレッド」)。サーバーのスレッドは仕事を並べて答えを返すだけにする。
- **画面は am の Svelte の UI を流用している。** エンジンへの送り口だけを `fetch("/api/run")` に差し替え、右上に「終了」ボタンを足した。サーバーが無いとき(`npm --prefix ui run dev`)は、架空のフィクスチャ(`ui/src/lib/fixtures.ts`)が同じ形で答える。
- **CLI(`ac`、別名 `am`)はそのまま残る。** 画面と同じエンジンを端末から呼べる。
- ネットワークには出ない。待ち受けは 127.0.0.1 だけで、外部のホストへ接続するコードは無い。

主なファイル:

| ファイル | 役目 |
|---|---|
| `src/server/main.ts` | 起動・ロックファイル・二重起動の検出・アイドル終了 |
| `src/server/app.ts` | HTTP のルーティング。守りの順序はここで決まる |
| `src/server/security.ts` | Host / Origin の検査、トークン、Cookie、起動コード、応答ヘッダ |
| `src/server/vocabulary.ts` | API の語彙(「API の語彙」) |
| `src/server/engine-runner.ts` | エンジンの呼び出しと plan の digest(「計画の digest」) |
| `src/server/engine-queue.ts` / `engine-worker.ts` | エンジンのスレッド |
| `src/server/exec.ts` | プログラムの起動(今はブラウザを開くことだけ) |

単位(個人 / プロジェクト / ローカル)とプロジェクトの発見、プラグインの読み取りは P2 で `src/scope/` に足した(「単位とプロジェクト」)。指示ファイルの層とカタログの層は今後のフェーズで足す(「フェーズとゲート」)。カタログの閲覧を足すときも、ネットワークに出るのはその層だけにし、取得先は固定の許可リストに限る。

## 単位とプロジェクト

P2 で足した層(`src/scope/`)。Claude Code と GitHub Copilot(CLI とアプリ)が読むものを、**単位**ごとに一覧し、毎セッションどれだけコンテキストに載るか(常時コスト)を見積もる。読むだけで、ハーネスのファイルには書き込まない。書くのは agent-console 自身の `~/.agent-console/projects.json`(固定・非表示・手動追加)と `~/.agent-console/cache/` だけ。

| 単位 | 意味 | 例 |
|---|---|---|
| 個人(`user`) | その PC のユーザー全体に効く | `~/.claude/…`、`~/.copilot/…`、`~/.agents/skills` |
| プロジェクト(`project`) | リポジトリに入り、共有される | `<root>/.claude/…`、`<root>/.github/…`、`<root>/AGENTS.md`、`<root>/.mcp.json` |
| ローカル(`local`) | そのリポジトリだけに効き、共有されない | `<root>/CLAUDE.local.md`、`<root>/.claude/settings.local.json`、`~/.claude.json` の `projects[<root>]`、`<root>/.github/copilot/settings.local.json` |

一覧の 1 行は「ディスクや設定ファイルにある 1 つのもの」で、ハーネスごとの**届き方**(読むか・どのパスから・どの設定で有効 / 無効が決まったか・常時コスト・確度)を持つ。リンクで共有された skill や、両方のハーネスが読む `.mcp.json` のサーバーは、1 行に 2 つの届き方として出る。

コマンドは `ac projects [--refresh]`(発見)、`ac projects pin|unpin|hide|unhide|forget <id>` / `ac projects add <folder>`(設定)、`ac installed [--project <id>]`(一覧)。画面の既定のタブ「Installed」がこれを使い、従来の画面は「配布」タブに移った。

### 置き場所と確度

確度: 公式(公式文書)/ 実測(「スパイクの判定」の方法で確かめた)/ 未確認。**未確認の届き方は、表示はするが合計に含めず、操作の対象にもしない。**

| 資産 | Claude Code | Copilot CLI | 確度 |
|---|---|---|---|
| 指示(個人) | `~/.claude/CLAUDE.md`(@import をたどる) | `$COPILOT_HOME/copilot-instructions.md`、`$COPILOT_HOME/instructions/**/*.instructions.md` | 公式 / 公式・実測 |
| 指示(プロジェクト) | `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/**/*.md`(`paths` 付きは条件付き)、`AGENTS.md`(CLAUDE.md 類が無いとき。import されていれば import 経由) | `.github/copilot-instructions.md`、ルートと cwd の `AGENTS.md`・`CLAUDE.md`・`GEMINI.md`、`.github/instructions/**/*.instructions.md` | 公式 / 公式・実測 |
| 指示(Copilot の `.claude/CLAUDE.md`) | — | 公式文書は読むとするが、1.0.107 の実測では読まれなかった | 未確認 |
| 指示(ローカル) | `CLAUDE.local.md` | 読まない | 公式 / 実測 |
| 指示(Claude の `~/.claude/rules/`) | 公式文書で確かめていない | — | 未確認 |
| skill | `~/.claude/skills/`(`synced/` は claude.ai から同期)、`<root>/.claude/skills/` | `~/.copilot/skills/`、`~/.agents/skills/`、`<root>/.github/skills/`・`.agents/skills/`・`.claude/skills/` | 公式 / 公式・実測 |
| agent | `~/.claude/agents/`、`<root>/.claude/agents/` | `~/.copilot/agents/`、`<root>/.github/agents/`、`<root>/.claude/agents/` | 公式 / 公式・実測(`.claude/agents` は実測) |
| command | `~/.claude/commands/`、`<root>/.claude/commands/` | prompt files は CLI 非対応 | 公式 |
| MCP | 個人 `~/.claude.json#mcpServers`、プロジェクト `.mcp.json`(承認の記録で有効 / 無効 / 不明)、ローカル `~/.claude.json#projects[<root>].mcpServers` | 個人 `~/.copilot/mcp-config.json`、プロジェクト `.mcp.json`(無ければ `.github/mcp.json`)。信頼済みのフォルダだけで読む | 公式 / 公式・実測 |
| プラグイン | `~/.claude/plugins/installed_plugins.json`(v2)と、各単位の settings の `enabledPlugins`(local > project > user) | `~/.copilot/installed-plugins/` と、各単位の settings(`~/.copilot/settings.json` < `.github/copilot/settings.json` < `settings.local.json`)の `enabledPlugins` | 公式 |
| skill の切り替え | `skillOverrides`、`disable-model-invocation`、`syncClaudeAiSkills` | `disabledSkills` | 公式 |

`~/.copilot/config.json`(認証情報と信頼済みフォルダ)は読まない。そのため Copilot がプロジェクトの MCP を読むかは「不明」と出す。MCP の定義から読むのは名前と通信方式だけで、コマンド・環境変数・ヘッダは読まない。

### プロジェクトの発見

1. **集める。** Claude: `~/.claude.json` の `projects` の**キー**と `githubRepoPaths`(このファイルはアカウント情報も含むので、この 2 つを写したらすぐ捨てる)。Copilot: `session-state/<id>/events.jsonl` の先頭行(無ければ `workspace.yaml`)の `cwd` / `gitRoot`。手動で足したフォルダ。
2. **絞る。** 実在しないものを外す → ホーム・一時フォルダ・`~/.claude`・`~/.copilot`・`C:\Windows` の下を外す → リポジトリのルートに寄せる → ワークツリーを元のリポジトリにまとめる。git 外のフォルダは残し、画面では既定で隠す。
3. **並べる。** 固定したもの、最終利用の新しい順(Claude は transcript、Copilot は `events.jsonl` の更新時刻)。

リポジトリのルートとワークツリーは、git を起動せず `.git` を読んで決める(`src/scope/gitroot.ts`)。`.git` がディレクトリならそこがルート、ファイル(`gitdir:`)なら、その先の `commondir` の有無でワークツリーかサブモジュールかを見分ける。実環境で `git rev-parse --show-toplevel` / `--git-common-dir` を全候補に対して実行した結果と、ルートの集合が一致することを確かめた。git を候補ごとに 2 回起動する方式は、同じ環境で 2 秒余りかかった。

キャッシュ(`~/.agent-console/cache/projects.json`)は、Copilot のセッションごとの先頭行の読み取り結果と、最後の一覧のルート(API が受け取るプロジェクト id をルートに戻すため)を持つ。消しても失うのは速さだけ。API はプロジェクトを id(ルートの sha256 の先頭 12 桁)で受け取り、任意のパスは `projects add` 以外では受け付けない。

### 常時コスト

毎セッションの最初からコンテキストに載る文字数の静的な見積もり(`src/scope/cost.ts`)。形を実測できたものはその形で、できていないものは公式の記述どおりに数える。

- Claude: skill は名前 + description + when_to_use、agent と command は名前 + description、指示ファイルは本文 + @import 先(4 段まで)。`skillOverrides: off` と `disable-model-invocation` は 0、`name-only` は名前だけ(内訳は推測)
- Copilot: skill は `<available_skills>` の 1 件分、agent は task ツールの説明の 1 行、常に読まれる指示ファイルは `<custom_instruction>` の 1 件分、`applyTo` が当たらない `*.instructions.md` は一覧表の 1 行(どれも 1.0.107 の実測の形)
- 合計に入れるのは、状態が「有効」の届き方だけ。条件付きは表示だけにする。MCP のツール定義とハーネス自身のシステムプロンプトは数えない(「未計測」として件数を出す)
- 字数は Unicode のコードポイント数。トークンは推測の換算(英数 3.2 字 / トークン、それ以外 0.87 トークン / 字)で、画面にも「推測」と書く

### スパイクの判定

方法: 公式文書の確認と、隔離した `COPILOT_HOME` での実測。実測では、Copilot CLI の BYOK の設定(`COPILOT_OFFLINE=true` と `COPILOT_PROVIDER_BASE_URL`)を 127.0.0.1 の偽のモデルサーバーに向け、CLI がモデルへ送るリクエストの本文をそのまま受け取って、目印を書いた各ファイルの中身が載ったかを調べた。ネットワークにも課金にも触れない。MCP とプラグインは同じ隔離環境で `copilot mcp list --json` と `copilot plugin marketplace list` を使った。対象は Copilot CLI 1.0.107(2026-11-08)。

| ID | 判定 | 確度 | 出典 |
|---|---|---|---|
| S11 | **合格(1 行を除く)。** 届く: `$COPILOT_HOME/copilot-instructions.md`、`$COPILOT_HOME/instructions/*.instructions.md`、`.github/copilot-instructions.md`、ルートと cwd の `AGENTS.md`・`CLAUDE.md`・`GEMINI.md`、`applyTo` が無いか `**` の `*.instructions.md`(本文)。`applyTo` が他のパターンのものは一覧表の 1 行だけ。届かない: `CLAUDE.local.md`。優先順位は無く、すべて結合される(順は個人 → `.github` → AGENTS → CLAUDE → GEMINI → instructions)。**`.claude/CLAUDE.md` は公式文書と実測が食い違うので「未確認」**とした | 公式・実測 | docs.github.com/en/copilot/how-tos/copilot-cli/add-custom-instructions、docs.github.com/en/copilot/reference/custom-instructions-support |
| S12 | **合格。** MCP: `.mcp.json`、無ければ `.github/mcp.json`(同じリポジトリに両方あると `.github/mcp.json` は読まれない)。`.vscode/mcp.json` とリポジトリ内の `.copilot/mcp-config.json` は読まない。信頼済みのフォルダだけ。プラグイン: リポジトリの `.github/copilot/settings.json` と `settings.local.json` が `enabledPlugins` と `extraKnownMarketplaces` を持てる(宣言すると自動で導入される)。導入先は個人の `~/.copilot/installed-plugins/` だけ | 公式・実測 | docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers、docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference、同 cli-plugin-reference、`copilot help config`、`copilot mcp --help` |
| S16 | **合格。** 実環境で、キャッシュ無し 0.6〜1.5 秒、キャッシュあり 0.1〜0.2 秒(CLI の起動を含めて 0.55 秒 / 0.23 秒) | 実測 | `e2e/l3-scope.mjs` |

Claude 側(memory・settings・MCP の単位)は公式文書(code.claude.com/docs/en/memory・settings・mcp)で確かめた。


## 起動と終了

**起動。** `agent-console.bat` をダブルクリックすると、初回だけ依存のインストールとビルドを行い、`node dist/server/main.js` を起動する。

1. ロックファイル `~/.agent-console/server.json` を、起動の最初に**排他的に**作る。すでにあれば、そこに書かれたサーバーが生きているかを `/control/ping` で確かめる。
   - 生きていれば、新しいサーバーは立てず、`/control/open` で既存のサーバーにブラウザのタブを 1 つ開かせて終わる。
   - 応答が無ければ古いロックファイルとして扱う。PID が生きていて応答しないだけのときは、何度か問い直してから判断する(重い処理の最中のサーバーを死んだと見なして 2 台目を立てないため)。
2. ポートは既定で 47821。使用中なら次の番号を順に試す。待ち受けは 127.0.0.1 だけ。
3. 1 回限りの起動コード(既定で 2 分有効)を載せた `http://127.0.0.1:<port>/launch?code=…` を既定のブラウザで開く。ページはコードと引き換えに Cookie とヘッダ用のトークンを受け取り、`/` へ移る(「守り」)。

起動フラグ: `--port <n>`、`--no-open`(ブラウザを開かず、起動 URL を JSON 1 行で出す。e2e が使う)、`--read-only`(書き込み系の API をすべて断る)、`--idle-minutes <n>`(0 で無期限。上限は 1 週間)。

**終了。** 次のどれかで止まる。止まるときは、自分が作ったロックファイルだけを消す。

- 画面の「終了」ボタン(`POST /api/shutdown`)。
- 30 分(`--idle-minutes`)操作が無いとき。アイドルの時計を延ばすのは、**認証を通った API の呼び出しだけ**である。認証の無い要求や静的ファイルの取得では延びない(外から叩き続けてサーバーを生かし続けることはできない)。
- 端末での Ctrl+C。

サーバーを止めるときは、**実行中の書き込みが終わるまで待つ**。書き込みの最中に届いた `/api/shutdown` は断る。画面を閉じてもサーバーは残る。サーバーのウィンドウを閉じるとプロセスはすぐ終わるので、書き込みの最中には閉じない。

## 守り

設定ファイルを書き換えるサーバーなので、守りは必須である。脅威は、利用者がたまたま開いている任意のウェブページ(`fetch("http://127.0.0.1:47821/…")` を投げられる。自分の DNS 名を 127.0.0.1 に向けることもできる)と、同じ PC で動く別のプログラムである。

要求は次の順に検査する(`src/server/app.ts`)。

1. `Host` が `127.0.0.1:<port>` か `localhost:<port>` であること。DNS リバインディングはここで止まる。
2. `Origin` があれば自分のオリジンであること。`Sec-Fetch-Site` があれば `same-origin`(トップレベルの移動なら `none`)であること。
3. トークン。ページには Cookie、API には Cookie と `X-Console-Token` ヘッダの**両方**が要る。

| 脅威 | 対策 |
|---|---|
| 他のサイトのページから API を叩かれる(CSRF・DNS リバインディング) | 上の 3 段の検査。Cookie は HttpOnly・SameSite=Strict で、名前にポート番号を含める。CORS ヘッダは出さない。CSP は `default-src 'self'`、`frame-ancestors 'none'` |
| 127.0.0.1 の別ポートのサービスに Cookie が渡る | Cookie はポートで区切られないので、Cookie とヘッダには**別の秘密**を使う。ヘッダ用の秘密は 1 回限りの起動ページでだけ渡し、タブの sessionStorage(ポートまで含めたオリジンに閉じる)に置く。Cookie だけを持っていても、ヘッダ用の秘密は手に入らない |
| 起動 URL がブラウザの履歴に残る | URL に載るのはトークンではなく 1 回限りの起動コードで、使った時点と期限切れで無効になる |
| 同じ PC の別のプログラムが `/control/*` を使う・なりすます | control 用の秘密はロックファイルにだけ書く(本人だけが読める権限)。`/control/open` はその秘密を要求し、3 秒に 1 回に制限する。`/control/ping` は秘密を要求しないが、呼び出し側が送った nonce への HMAC(control 用の秘密で作る)を返す。起動側はそれを確かめ、ポートを先に取った別のプログラムに起動を引き渡さない。ロックファイルの PID が死んでいれば、ポートで何が答えても古いロックとして扱う。ブラウザからの要求に見えるもの(`Origin` や `Sec-Fetch-*` が付く)は断る。ロックファイルには画面と API の秘密そのものを書かない |
| XSS(エンジンが返す文字列や、将来のカタログの説明文) | 外部の文字列は常にテキストとして描く(`{@html}` を使わない)。インラインのスクリプトは CSP で禁じる(起動ページも外部ファイル `/launch.js` を使う)。外部の画像やフォントは読まない |
| コマンドの注入 | 他のプログラムの起動は `exec.ts` だけ。シェルを通さず(`shell: false`)、Windows では `.exe` だけを起動する。`.cmd` / `.bat` / `.ps1` などは引数配列で渡しても cmd.exe などが引数を解釈し直すので拒否する(CVE-2024-27980)。PATHEXT は見ない。ブラウザを開く URL は自分のサーバーのものに限る |
| 想定外の書き込み | API の語彙を固定する(「API の語彙」)。`apply` は確認した plan と同じ digest のときだけ実行する(「計画の digest」)。`import` は API からは実行できない。`--read-only` で書き込み系をすべて断れる |
| 書き込みの途中で止まる | 書き込みには時間の上限を設けない。サーバーの終了は書き込みが終わるまで待つ(「起動と終了」)。書き込みの前には毎回、対象を `backups/<日時>/` に退避する(SPEC §6) |
| 失敗の取り違え | 画面は書き込みの前にサーバーとの疎通を確かめる。要求が届かなかったときは「何も書いていない」と伝え、途中で切れたとき(書き込みが不完全かもしれない)とは言い分ける。後者では退避先を示し、読み直しを促す |

`~/.copilot/config.json` は読みも書きもしない(SPEC §6.2)。

## API の語彙

| 経路 | 内容 | 要るもの |
|---|---|---|
| `GET /launch?code=…` | 起動コードを引き換え、Cookie を設定し、ヘッダ用のトークンを載せた小さなページを返す | 有効な起動コード |
| `GET /launch.js` | そのページが使うスクリプト(秘密を含まない) | なし |
| `GET /`、`GET /<静的ファイル>` | `ui/dist` の画面 | Cookie |
| `POST /api/run` | `{ args, digest? }` → `{ stdout, stderr, code, digest? }`。エンジンを 1 回実行する | Cookie + ヘッダ、`Content-Type: application/json` |
| `POST /api/ping` | `{ ok: true }`。画面が書き込みの直前に疎通を確かめる | Cookie + ヘッダ |
| `POST /api/shutdown` | サーバーを止める(書き込みの最中は 409 で断る) | Cookie + ヘッダ |
| `GET /control/ping?nonce=…` | 2 回目の起動が使う「起動中か」。`app`・`pid`・`writes`・`stopping` と、nonce への HMAC(`proof`)を返す | hex の nonce(16〜128 字)。秘密は要らない(起動側が proof を秘密で確かめる) |
| `POST /control/open` | 2 回目の起動が使う「タブを開いて」 | control 用の秘密(`X-Console-Control`)。3 秒に 1 回まで |

`/api/*` は共通して `Content-Type: application/json` を要る。終了処理の間は 503 を返す。

`/api/run` の `args` は、`src/server/vocabulary.ts` の固定表に照らしてから実行する。任意の argv は受け付けない。

- コマンド: `inventory` / `doctor` / `plan` / `apply` / `import` / `enable` / `disable` / `remove` / `projects` / `installed`
- `projects` は操作(`pin` / `unpin` / `hide` / `unhide` / `forget` とプロジェクト id、または `add` と絶対パスのフォルダ)を取れる。id は 16 進 12 桁、フォルダは 260 字まで・`..` を含まない・制御文字を含まない。操作付きの `projects` は書き込みとして扱う(`--read-only` で断る)
- `enable` / `disable` / `remove` は、資産の種別(`skill` / `mcp` / `agent` / `command`)と名前を取る。名前は英数字と `-` `_` `.`、64 字まで、`-` で始まらないもの
- フラグ: `--prune` / `--yes` / `--dry-run` / `--move` / `--prefer <target>`、`--refresh`(`projects` だけ)、`--project <id>`(`installed` だけ)
- argv は 8 個まで。本文は 64 KiB まで
- `--json` は語彙に無い。JSON 契約は画面の送り口そのものなので、サーバーが自分で付ける
- `import` は、確認に結び付ける plan が無いので API からは断る(端末で `ac import`)

表は**手で**保守する。これが API で出来ることの上限なので、エンジンに新しいコマンドを足しても、ここに足すまでは画面から呼べない。逆に、エンジンの資産種別やターゲットの一覧(`ASSET_KIND_IDS` / `TARGET_IDS`)に足したものが表から漏れないよう、`src/server/vocabulary.test.ts` が突き合わせる。

## 計画の digest

`apply` は、利用者が確認ダイアログで見た plan と、実行の瞬間の plan が同じときだけ書き込む。

1. `plan` の応答に `digest` を付ける(`apply --dry-run` には付けない。応答の形が apply の報告なので、新しい plan の digest とは一致しないため)。
2. digest は、plan の argv と終了コード、**各操作の種類・ターゲット・資産の種別・資産・パス・説明**から作る。MCP 以外の操作は、書く内容(`before` / `after`)のハッシュも入れる。MCP の操作は、`~/.claude.json` のように他のツールも書き続ける共有ファイルの全文ではなく、`after` のうちエンジンが管理するサーバーの表(`mcpServers` / `servers` / `mcp`)だけを入れる。全文を入れると、apply がすることは何も変わっていないのに digest だけが変わり、確認が通らなくなるためである。管理しているサーバーの定義が変われば、digest も変わる。
3. `apply` の要求は、確認した plan の digest を一緒に送る。無ければ何も書かずに断る。
4. エンジンのスレッドで、新しい plan を取り、digest を比べ、一致したら続けて apply を実行する。比較と書き込みの間に別の仕事は入らない(「エンジンのスレッド」)。
5. 一致しなければ何も書かずに断る。画面は「確認画面を出した後に plan が変わった」と伝え、差分を取り直させる。

apply は書き込みの直前に対象を読み直して描き直す(SPEC §6.1)ので、照合に入れなかったファイルの中身も、書き込みには最新の状態が使われる。digest が結び付けるのは「どの操作を確認したか」である。

## エンジンのスレッド

エンジンの `main()` は同期処理で、大きな plan には数十秒かかることがある。これをサーバーのイベントループで動かすと、その間 `/control/ping`・`/api/shutdown`・アイドルの時計がすべて止まり、2 回目の起動が「重いだけのサーバー」を「死んだサーバー」と見誤って 2 台目を立ててしまう。そこでエンジンはワーカースレッドで動かす。

- 仕事は先入れ先出しで、**1 つずつ**実行する。エンジンは 1 プロセス 1 実行を前提に書かれていて、2 つの書き込みが混ざってはならない。
- **読み取り**が 30 秒を超えたら、ワーカーを止めて作り直す。読み取りは何も変えないので、打ち切っても失うのはその読み取りだけである。
- **書き込み**には上限を設けない(SPEC §9.5: 書き込み系は書き込み途中で打ち切らない)。
- 書き込みの最中にワーカーが落ちたら、書き込みが不完全かもしれないこと、触ったものは先に退避してあることを伝え、読み直しを促す。
- `apply` は「新しい plan を取って digest を比べ、続けて apply する」を 1 つの仕事としてワーカーに渡す。
- 単体テストは、同じ意味のまま呼び出し側のスレッドで動く `InlineEngine` を使う。

## am から引き継いだもの

| 部品 | 扱い |
|---|---|
| アダプタ(claude / copilot-cli / vscode / vs2026 / opencode)と `src/core/*` | そのまま引き継いだ。今後の単位(個人 / プロジェクト)の層は、各アダプタに「ルート」を渡す形で足し、既存の振る舞いは個人の単位としてテストで固定する |
| 配布のソース(`~/.agents-manager/`)と plan / apply | 「配布」の機能として残す。ディレクトリ名は互換のため変えない(am と同時に使わないこと) |
| JSON 契約と終了コード | そのまま。新しい API も同じ規約(`--json` は 1 行、任意のフィールドは省略)で足す |
| テスト・CLI の実測ゲート・HOME の隔離 | そのまま引き継いだ。環境変数 `AC_HOME`(`AC_APPDATA` / `AC_CONFIG_HOME`)を新設し、旧名の `AM_*` も読む(`AC_*` が優先) |
| Tauri のシェル | P1 で削除した。Rust 側の引数の検査は `vocabulary.ts` に移し、Rust と vitest の突き合わせは、TypeScript の表とエンジンの一覧の突き合わせに置き換えた |
| Svelte の画面 | 流用した。送り口だけを差し替えた |
| 名前 | パッケージは `agent-console`、CLI は `ac`(`am` も別名として残す)、起動は `agent-console.bat` |
| 文書 | エンジンの仕様は am の SPEC v3.1(`docs/SPEC.md`)のまま。agent-console での変更はこの文書に書く |
| PC 固有の状態 | `~/.agent-console/` に置く(サーバーのロックファイル、doctor の任意の設定、プロジェクトの固定・非表示・手動追加と、発見のキャッシュ) |

**ソースに残った古いコマンドの写し(`command.legacy`)。** 正本を別の場所へ移したあとも、`~/.agents-manager/commands/` に古い写しが残ることがある。`apply` はそれを各ターゲットへ配ってしまう。どの名前が古いかは利用者にしか分からないので、規則はコードに書かず、任意の設定ファイル `~/.agent-console/legacy-commands.json` から読む。

```json
{ "version": 1, "commands": [ { "match": "old-*", "note": "任意の説明" }, { "match": "legacy-tool" } ] }
```

- `match` はコマンド名そのもの、または末尾に `*` を 1 つ付けた接頭辞。当たったソースのコマンドを、doctor が `command.legacy`(warn)として報告する。所見の文には、当たった規則と `note`、`apply` するとこの写しが配られることを含める。
- ファイルが無ければ規則は無い(所見も無い)。
- JSON として読めない、または形が違うときは `console.legacy-commands-unreadable`(error、パス付き)を出す。パースの失敗を「規則なし」として扱わない(SPEC §6.3 と同じ原則)。
- 判定は純関数 `matchLegacyCommand(name, rules)`(`src/commands/doctor.ts`)で、陽性・陰性の両方をテストで固定している。

## 守りの検証(S15)

| 問い | 合格の条件 | 不合格のとき |
|---|---|---|
| ローカルサーバーの守り(「守り」)が、本物のブラウザに対して効くか | 別のオリジンのページからの `fetch`、Host を偽った要求、トークンの無い要求がすべて断られる(Playwright で自動テスト) | 守りを直すまで、書き込み系の API を使う e2e を走らせない |

`e2e/s15.e2e.mjs` が確かめること:

- 利用者がすでに画面を開いている(有効な Cookie がある)のと同じブラウザのプロファイルで、別のオリジンのページが API を読むことも、API を通じて書くこともできない。`fetch`・`no-cors`・フォームの送信・画面の埋め込みのどれでも。
- DNS リバインディング: 攻撃者の名前を 127.0.0.1 に向けても(`--host-resolver-rules`)、ポートには届くが `Host` で断られる。
- トークンが無い新しいプロファイルは、画面も API も得られない。
- 陽性コントロール: 画面そのもの(Cookie + ヘッダ)は通る。
- 書き込みを試みた後は毎回、ディスクの `manifest.json` が変わっていないことを確かめる。

`npm run e2e` は S15 を最初に走らせ、緑のときだけ、負荷をかけたサーバーの検査と、書き込みを含む画面の e2e に進む。HTTP の単位での陰性・陽性は `src/server/app.test.ts` が持つ。

## フェーズとゲート

各フェーズは同じ段を踏む。

1. **実装** — すべてのテストが緑。陽性・陰性のコントロールを付ける。
2. **レビュー** — 変更を書いた者とは別の目で見る。所見は再現して確かめる。
3. **実環境での確認** — 実 HOME では読み取りだけを行い、前後でファイルが変わっていないこと(カナリア)を比べる。
4. **反映** — 既定のブランチへは PR と CI を通して入れる。

| フェーズ | 中身 | 書き込み | ゲートの要点 |
|---|---|---|---|
| **P0 準備**(済) | am を元にリポジトリを作り、名前を変える(パッケージ・CLI・README)。基準値(テスト・CLI の実測ゲート・svelte-check)を測り直す | リポジトリの中だけ | 基準値が am と一致する |
| **P1 ブラウザ化**(済) | サーバー、トークン、Host / Origin の検査、API の語彙、画面の送り口の差し替え、Tauri の削除、`agent-console.bat`。機能は am と同じ | am と同じ | S15 が緑。am の GUI で出来たことがブラウザで全部できる(Playwright の e2e)。既存の JSON スナップショットの差分が 0 |
| **P2 単位とプロジェクト**(済) | 単位の層、プロジェクトの発見(Claude と Copilot が記録しているフォルダを集め、実在しないもの・git 外のものを絞る)、Claude と Copilot の資産を個人 / プロジェクト / ローカルの単位で表示、プラグインの読み取り、常時コスト(毎セッションのコンテキストに載る量)の見積もり | なし(`~/.agent-console/` の設定とキャッシュだけ) | S11・S12・S16 の判定済み。実 HOME の読み取りで前後のカナリアが変わらない。件数を手で数えた値と照合する |
| **P3 指示ファイル** | 表示(リンクと import をたどった届き先の木、字数)と編集(差分 → 確認 → 退避 → 原子的な置き換え) | 指示ファイル | 改行と BOM が元のまま残る(陽性コントロール付き)。開いた後にファイルが変わっていたら保存を断る |
| **P4 操作** | プラグインとマーケットプレイスの操作(公式 CLI 経由)、単位を指定した導入・削除、skill の表示の切り替え | 公式 CLI 経由 | 実データでのアンインストールを試し、事後の読み直しで確かめる |
| **P5 Browse** | カタログの取得とキャッシュ、検索、カテゴリ、カードからの導入 | キャッシュと、公式 CLI 経由の導入 | S13・S14 の判定済み。オフラインでもキャッシュから描ける。許可リストの外のホストへ出ないことをテストで固定する |
| **P6 Codex と OpenCode** | 両ハーネスのプラグイン・指示ファイルなどの読み取りを足す(OpenCode は配布のターゲットとしては対応済み) | なし → 後に操作 | 読み取りの結果を実環境の実測と照合する |
| **P7 候補** | 自分で公開するマーケットプレイスの検証と版上げ、skill のカタログ、PC 間の同期 | — | — |

フェーズの途中で確かめる問い(スパイク):

| ID | 問い | 時点 |
|---|---|---|
| S11 | Copilot CLI と Copilot アプリが読む指示ファイルの場所と優先順位 | P2 |
| S12 | Copilot の MCP とプラグインに、プロジェクト単位の置き場所があるか | P2 |
| S13 | Copilot のマーケットプレイスの一覧を、書き込みなしで取る方法 | P5 |
| S14 | MCP レジストリの API(エンドポイント、ページング、検索、利用規約、レート制限) | P5 |
| S15 | ローカルサーバーの守りが効くか(「守りの検証(S15)」) | P1(合格) |
| S16 | プロジェクトの発見が実用の速さで終わるか(初回 10 秒未満、キャッシュありで 1 秒未満) | P2 |

公式文書で確かめられない置き場所は、画面に「未確認」と出し、操作の対象にしない。

## テスト

| 種類 | コマンド | 中身 |
|---|---|---|
| 単体・契約・サーバー | `npm test` | vitest。アダプタのラウンドトリップ、JSON 契約のスナップショット、doctor の所見、画面の導出ロジック、サーバーの守り |
| CLI の実測ゲート | `npm run e2e:cli` | ビルド済みの CLI を子プロセスで起動し、使い捨ての HOME で 22 項目を測る。生の出力は `e2e-artifacts/v3.1/*.txt`(一時 HOME の実パスを含むので追跡しない) |
| ブラウザの e2e | `npm run e2e` | Playwright。S15 → 負荷をかけたサーバー → 画面の e2e(書き込みを含む)→ Installed の e2e(使い捨ての HOME とリポジトリで、`~/.agent-console` 以外のファイルが変わらないことをハッシュと mtime で確かめる)。書き込みは毎回ディスクで確かめ、画面の表示を証拠にしない |
| 実 HOME の読み取り(P2 の L3) | `node e2e/l3-scope.mjs` | 実 HOME を単位の層で読み、`~/.agent-console/` の外への書き込みを fs の見張りで 0 件と確かめ、読んだファイルのハッシュと mtime を前後で比べる。S16 の時間も測る。生の記録は `e2e-artifacts/p2/`(この PC のパスを含むので追跡しない) |
| 画面の型 | `npm --prefix ui run check` | svelte-check |

- **HOME の隔離。** テストは一時ディレクトリを HOME にする(`AC_HOME` / `AM_HOME`)。vitest は開始時に `AC_HOME` / `AC_APPDATA` / `AC_CONFIG_HOME` を消す(`test/setup-env.ts`)ので、開発者のシェルの設定がテストの HOME を上書きしない。`npm run e2e:cli` も子プロセスに `AC_HOME` と `AM_HOME` の両方を渡す。
- **実 HOME では書き込まない。** 実環境での実測は読み取りだけで、前後のカナリアを比べる。
- **サーバーの陰性と陽性。** トークンなし・誤ったトークン・Host の偽装・別の Origin・語彙外のコマンド・digest なしの apply・確認と違う digest・API からの import を、それぞれ断る。正しい組み合わせだけが通る。
- **エンジンのスレッド。** 先入れ先出し、読み取りの上限、書き込みに上限が無いこと(`src/server/engine-queue.test.ts`)。
- **今後のフェーズ。** 単位は偽の HOME と偽のリポジトリで、プロジェクトの発見は偽の記録ファイルで、指示ファイルは CRLF・LF・BOM ありの 3 種で確かめる。記録ファイルの読む必要の無いキー(アカウント情報など)が、出力にもログにも出ないことをテストで確かめる。

## リスク

| リスク | 対策 |
|---|---|
| ローカルサーバーが攻撃面になる | 「守り」と S15。書き込み系の e2e は S15 が緑のときだけ走らせる。`--read-only` で書き込みを止められる |
| 同じ PC の別のプログラムが、起動中のサーバーになりすます・操作する | control 用の秘密(ロックファイルにだけ書く)、nonce への HMAC による ping、`/control/open` の回数制限 |
| サーバーが 2 台立つ | ロックファイルを起動の最初に排他的に作る。重い処理の最中も ping に答えられるよう、エンジンを別スレッドで動かす |
| 書き込みの途中で止まる | 書き込みに時間の上限を設けない。終了は書き込みが終わるまで待つ。書き込みの前に必ず退避する |
| 確認した内容と実行する内容が食い違う | 計画の digest。比較と書き込みをエンジンのスレッドで続けて行う |
| 他のツールが同じファイル(`~/.claude.json` など)を書き続ける | digest に共有ファイルの全文を入れない。apply は書き込みの直前に読み直し、自分のキー以外を構造ごと保つ(SPEC §6.1) |
| ハーネスの更新で、状態ファイルや CLI の出力の形が変わる | 状態は CLI か、検証つきのファイル読み取りで取る。パースに失敗したら「読めない」と表示し、空として扱わない(SPEC §9.7) |
| 単位を足すとアダプタの前提(ホーム基準)が崩れる | 単位の層がルートを渡す形にし、個人の単位は従来どおりの挙動をテストで固定する |
| ハーネスの置き場所が公式に明記されていない | S11・S12。確かめられない行は「未確認」と表示し、操作しない |
| 記録ファイルにアカウント情報などの個人情報がある | 読むキーを必要なものに限り、ファイル全体を保持しない。漏れをテストで検出する |
| am と同時に動かす | am は凍結した。README に、am と同時に使わないことと、`~/.agents-manager` を共有していることを書いている |
