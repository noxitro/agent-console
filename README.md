# agent-console (`ac`)

Claude Code / GitHub Copilot を中心に、エージェントのカスタマイズ資産(skills・MCP サーバー・カスタムエージェント・コマンド)を、
**ブラウザで**一覧・追跡・操作する Windows 向けのローカルツール。
前身は agents-manager(`am`、v3.1 で凍結)で、そのエンジン・テスト・安全機構を引き継いでいる。

- 構成と設計: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- いまできること: am の GUI と同じ機能を、ブラウザで使える。単位(個人 / プロジェクト)の切り替えやカタログの閲覧は今後の予定(ARCHITECTURE.md「フェーズとゲート」)
- **am と同時に使わないこと。** 配布のソース `~/.agents-manager/` は am と共有している(名前は互換のため変えていない)
- その PC 固有の状態(サーバーのロックファイル、doctor の任意の設定など)は `~/.agent-console/` に置く

詳しい仕様は [docs/SPEC.md](docs/SPEC.md)(am の SPEC v3.1)を参照。agent-console で変えた点は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) にまとめてある。

## 起動(画面で使う)

**`agent-console.bat` をダブルクリックする。** それだけで次が順に起こる。

1. 初回だけ、依存のインストールとビルドを自動で行う(`npm install` / `npm run build` / UI のビルド)。数十秒かかる
2. ローカルサーバーが `http://127.0.0.1:47821/` で起動する(使用中なら次の空き番号)
3. 既定のブラウザで管理コンソールが開く

- 開いた黒いウィンドウがサーバー本体。**閉じるとサーバーが止まる。** ブラウザのタブを閉じてもサーバーは残る
- すでに起動していれば、もう一度ダブルクリックしても新しいサーバーは立たず、ブラウザのタブが 1 つ開くだけ
- 止め方: 画面右上の **「終了」**、黒いウィンドウを閉じる、または 30 分操作が無いと自動で止まる。アイドルでの停止は、書き込みの最中ならその書き込みが終わるまで待つ(ウィンドウを閉じるとすぐ止まるので、書き込みの最中は閉じないこと)
- ブラウザのアドレスを手で打っても使えない(下の「守り」)。開き直すときは `agent-console.bat` を実行する
- ソースを更新(`git pull` など)したら、`npm install` と `npm --prefix ui install` で依存を合わせてから、`npm run build` と `npm run build:ui` をやり直す(bat は `node_modules` があれば依存を入れ直さず、ビルド済みなら再ビルドもしない)

必要なもの: Node.js 22.12 以上。

### 画面でできること

am の GUI と同じ。

| 操作 | 場所 | 書き込み |
|---|---|---|
| 資産の一覧(SKILLS / MCP / AGENTS / COMMANDS) | 上部のタブ。開くだけで inventory と doctor が走る | なし |
| 絞り込み | 検索欄・状態(不良のみ等)・ターゲット | なし |
| 単位の切り替え(すべて / 個人 / プロジェクト / ローカル) | 表の上の「単位」。既定は「個人」で、従来と同じ一覧。プロジェクト・ローカルを選ぶと、横のプロジェクト欄で 1 つに絞れる。表の「単位」列にバッジと置き場所のパスが出る。公式文書で確かめられない置き場所は破線の「未確認」、同名の定義に負けて効いていない行は「上書きされて効いていない」と表示する。プロジェクト・ローカルの行は読み取りだけで、切り替えも削除も出さない | なし(プロジェクトの発見結果を `~/.agent-console/projects-cache.json` にキャッシュする) |
| 詳細と適用先の状態 | 行をクリックすると右ペインに出る | なし |
| 差分を取る(plan) | 下部バー・詳細ペインの「差分を取る」 | なし |
| 一括適用(apply) | 「一括適用…」→ 確認ダイアログ →「適用する」。書き込み前に必ず退避 | あり |
| 有効 / 無効の切り替え | 表と詳細ペインの「有効」スイッチ(manifest.json の exclude を書き換える) | あり(ソースのみ) |
| ソースから削除 | 行のごみ箱 → 確認 →「削除する」。退避先が表示される | あり(ソースのみ) |
| マップビュー・doctor 所見 | 右上「マップ」、下部バーの DOCTOR | なし |
| サーバーの終了 | 右上「終了」 | なし |

`import` は画面からは使えない(am の GUI にも無かった。端末で `ac import`)。

### 守り(ローカルサーバーなので)

設定ファイルを書き換えるサーバーなので、開いている他のサイトや、同じ PC の別のプログラムから操作されないようにしてある(ARCHITECTURE.md「守り」)。

- 待ち受けは `127.0.0.1` だけ。`Host` が `127.0.0.1:<port>` / `localhost:<port>` 以外なら拒否(DNS リバインディング対策)
- 起動ごとに 32 バイトの秘密を 2 つ作る。1 つは Cookie(HttpOnly・SameSite=Strict)、もう 1 つは `X-Console-Token` ヘッダ用。API は両方が無いと 401
- ヘッダ用の秘密は、bat が開く 1 回限りの起動ページにだけ載せ、`/launch.js` がそれをそのタブの sessionStorage に移して、すぐ画面へ移る(画面の index.html には秘密を入れない)。Cookie は 127.0.0.1 の別ポートのサービスにも送られてしまうため、Cookie だけではヘッダ用の秘密を知れないようにしてある
- そのため、アドレスを手で打って開いたタブや、前に起動したときのタブは「このタブでは操作できません」と出て操作できない(Cookie も無いブラウザでは「agent-console.bat から開いてください」という 401 のページになる)。`agent-console.bat` を実行して、開いたタブを使う
- 2 回目の起動が使う `/control/*` のうち、タブを開く依頼(`/control/open`)は、ロックファイルにだけ書く control 用の秘密を要求し、3 秒に 1 回に制限する。起動中かの確認(`/control/ping`)は秘密を要求しないが、呼び出し側が送った nonce への HMAC(control 用の秘密で作る)を返すので、ロックファイルを読める起動側だけが、本物のサーバーかポートを横取りした別のプログラムかを見分けられる
- ロックファイル `~/.agent-console/server.json` は起動の最初に排他的に作り、本人だけが読める権限で書く。同時に起動しても、立つサーバーは 1 台だけ。画面と API の秘密そのものは書かない(control 用の秘密と、ヘッダ用の秘密のハッシュだけ)
- エンジンはサーバーとは別のスレッドで動く。重い plan の最中でも、サーバーは終了の要求(別のタブの「終了」など)や二重起動の確認に応答する(そのタブ自身の「終了」は、そのタブの操作が終わるまで押せない)。読み取りが 30 秒を超えたら打ち切る(書き込みは打ち切らない)
- サーバーの終了(アイドル・Ctrl+C・黒いウィンドウを閉じる)は、実行中の書き込みが終わるのを待つ。書き込みの最中に「終了」を押すと断られる。終了処理の間に起動し直すと、終わるのを待ってから立ち上がる。アイドルの時計を延ばすのは、認証を通った API の呼び出しだけ
- 別オリジンからの要求(`Origin` が自分以外、`Sec-Fetch-Site` が cross-site 等)は 403。CORS ヘッダは出さない。CSP は `default-src 'self'`
- API が受け付けるコマンドは固定の語彙表(`src/server/vocabulary.ts`)にあるものだけ
- 「適用する」は、確認ダイアログに出した plan の digest と、実行直前に取り直した plan の digest が一致したときだけ実行する。digest は plan の各操作(種類・ターゲット・資産・パス・説明と、書く内容のハッシュ)から作る。他のツールも書く MCP の設定ファイルは、管理しているサーバーの表だけを照らす。ずれていれば何も書かずに拒否する
- 書き込みの前にサーバーとの疎通を確かめる。届かなかったときは「何も書いていない」と、途中で切れたとき(書き込みが不完全かもしれない)とを言い分ける
- 他のプログラムを起動するのは `src/server/exec.ts` だけで、`.cmd` / `.bat` / `.ps1` は起動しない(シェルを通さない)

## CLI で使う

画面と同じエンジンを端末から呼べる。CLI 名は `ac`。互換のため `am` も同じ CLI の別名として残してある。

```bash
# 1. ac.bat 経由(このリポジトリ直下から。npm link 不要。am.bat も同じものを起動する)
ac.bat inventory

# 2. node 直接
node dist/cli.js inventory

# 3. npm link してから `ac`(または `am`)として(グローバルに登録される)
npm link
ac inventory
```

| コマンド | 何をするか | 書き込み |
|---|---|---|
| `ac inventory` | 全ターゲットの発見パスを走査し、誰が何を見ているか一覧表示 | なし |
| `ac scopes` | Claude Code・Copilot CLI・VS Code が記録しているフォルダからプロジェクト(実在し git の中にあるもの)を集め、プロジェクト・ローカルの単位の資産と、同名のときにどれが効くかを一覧表示 | `~/.agent-console/projects-cache.json`(キャッシュ)だけ |
| `ac doctor` | 重複コピー・壊れたリンク・仕様違反を診断 | なし |
| `ac plan [--prune]` | ソースと実環境の差分を表示 | なし |
| `ac import [--prefer <target>] [--move]` | 既存の実環境設定をソースへ吸い上げる(初期移行) | ソース側(`--move` を付けると、ターゲットにある skill の実体ディレクトリをソースへ移すので、ターゲットからは消える) |
| `ac apply [--dry-run] [--prune] [--yes]` | 差分を実環境へ適用。書き込み前に必ずバックアップ | あり |
| `ac enable` / `ac disable <kind> <name>` | 資産の配布を有効 / 無効にする | ソース側のみ |
| `ac remove <kind> <name> --yes` | 資産をソースから削除(退避つき) | ソース側のみ |

すべて `--json` で画面と同じ JSON を 1 行で出す。終了コード: `0`=成功/差分なし、`1`=差分あり(`plan`)または所見あり(`doctor`)、`2`=エラー。

### doctor: 古いコマンドの写しを知らせる(任意の設定)

ソースの `~/.agents-manager/commands/` には、正本を別の場所へ移したあとも古い写しが残ることがある。`apply` するとその写しが各ターゲットへ配られてしまう。
どの名前が古い写しかは使う人にしか分からないので、`~/.agent-console/legacy-commands.json` に書いておくと、`doctor` が当たったコマンドを `command.legacy`(注意)として知らせる。

```json
{
  "version": 1,
  "commands": [
    { "match": "old-*", "note": "正本は別のリポジトリで管理している" },
    { "match": "legacy-tool" }
  ]
}
```

- `match` はコマンド名そのもの、または末尾に `*` を 1 つ付けた接頭辞。`note` は任意で、所見の文に添えられる
- ファイルが無ければ、この検査は何もしない
- JSON として読めない、または形が違うときは、`console.legacy-commands-unreadable`(エラー)として知らせる(読めない設定を「規則なし」として黙って扱わない)
- 知らされたコマンドは、控えてからソースから外すか、`ac disable command <name>` で配布を止めてから `apply` する

## 開発

```bash
npm install
npm --prefix ui install
npm run build          # tsc(エンジン・CLI・サーバー)
npm run build:ui       # Svelte の UI を ui/dist にビルド
npm test               # vitest(単体・契約・サーバーの守り)
npx playwright install --only-shell chromium   # e2e が使う Chromium(初回だけ)
npm run e2e            # Playwright: S15(守り)→ 緑なら画面の e2e(書き込みを含む)
npm run e2e:cli        # am から継承した CLI の実測ゲート(22 チェック。生の出力は e2e-artifacts/v3.1/*.txt、追跡外)
npm --prefix ui run check   # svelte-check
npm run serve -- --no-open --port 0   # サーバーだけ起動(1 回限りの起動 URL を JSON で出す)
```

サーバーの起動フラグ: `--port <n>`、`--no-open`(ブラウザを開かず起動 URL を出す)、`--read-only`(書き込み系 API を全部拒否)、`--idle-minutes <n>`(0 で無期限)。

`npm --prefix ui run dev` で Vite だけを起動すると、サーバーのトークンが無いので画面はフィクスチャ(架空の環境)で動く。画面上部に「参考データ」と出る。

テストは HOME を一時ディレクトリに差し替えて行う。環境変数 `AC_HOME`(旧名 `AM_HOME` も読む。`AC_HOME` が優先)を設定すると、
すべてのパスがその下に解決される。vitest は開始時に `AC_HOME` / `AC_APPDATA` / `AC_CONFIG_HOME` を消す(`test/setup-env.ts`)ので、
自分のシェルに `AC_HOME` を設定したままでも各テストは自前の一時 HOME で動く。e2e もすべて一時 HOME で動く。実 HOME で apply などの書き込みを試さないこと。

## スコープ

- いまはユーザーレベルの設定のみ。プロジェクト単位は今後の予定(ARCHITECTURE.md「フェーズとゲート」の P2)
- VS 2026 の MCP 連携は公式仕様が未確定のため未対応(`unsupported` と表示される)

## ライセンス

MIT(`LICENSE`)。同梱のフォント(`ui/public/fonts/`)は SIL Open Font License 1.1(`ui/public/fonts/OFL.txt`)。
