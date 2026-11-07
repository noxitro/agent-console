---
name: agent-console
description: 単一ソースとエージェント各系統の資産を一覧・追跡・操作する管理コンソール(ローカルサーバーが配り、ブラウザで開く画面)
colors:
  paper: "#f4f1e8"
  paper-panel: "#efebde"
  paper-inset: "#e7e2d2"
  desk: "#ddd6c2"
  ink: "#1a2b3c"
  ink-2: "#4f6274"
  ink-3: "#74838f"
  rule: "rgba(26, 43, 60, 0.22)"
  rule-strong: "rgba(26, 43, 60, 0.5)"
  fault: "#c8452a"
  fault-text: "#9e3520"
  fault-wash: "rgba(200, 69, 42, 0.09)"
  pass: "#2e7d4f"
  pass-text: "#26683f"
  pass-wash: "rgba(46, 125, 79, 0.1)"
  caution-wash: "rgba(26, 43, 60, 0.06)"
typography:
  title:
    fontFamily: "Zen Kaku Gothic New, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "0.02em"
  headline:
    fontFamily: "Zen Kaku Gothic New, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "0.04em"
  body:
    fontFamily: "Zen Kaku Gothic New, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Zen Kaku Gothic New, Yu Gothic UI, Meiryo, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.65
  annotation:
    fontFamily: "M PLUS 1 Code, Cascadia Mono, Consolas, monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    letterSpacing: "0.06em"
rounded:
  control: "2px"
spacing:
  gap-1: "0.25rem"
  gap-2: "0.5rem"
  gap-3: "0.75rem"
  gap-4: "1rem"
  gap-5: "1.5rem"
  gap-6: "2rem"
components:
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 1rem"
    height: "2.25rem"
  button-secondary-hover:
    backgroundColor: "#fffdf6"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "0 1rem"
    height: "2.25rem"
  button-primary-hover:
    backgroundColor: "#24384c"
    textColor: "{colors.paper}"
  button-danger:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.fault-text}"
    rounded: "{rounded.control}"
    padding: "0 1rem"
    height: "2.25rem"
  button-danger-hover:
    backgroundColor: "{colors.fault}"
    textColor: "#ffffff"
---

# Design System: agent-console

## Overview

**Creative North Star: "カテゴリ標準の管理コンソール"**

このシステムは奇抜さを商品にしない。管理コンソールの定石(カテゴリ標準)を方針とし、タブ+テーブル+詳細ペイン+ステータスバーという形を、皮肉なく隅々まで作り切ることを北極星とする。練度の基準は VS Code の設定/拡張機能ビュー(左リスト+右詳細、検索・フィルタ・バッジの語彙)と GitHub Desktop / Docker Desktop 系(差分プレビューと危険な書き込みの確認の見せ方)であり、これを下回れば未完成である(PRODUCT.md Brand Commitments)。

素材は前ワールドから引き継いだ「机上の紙」のパレットを保つ: ライト固定(color-scheme: light、ダークテーマは意図的に無い)、製図紙の地に墨紺のインク、罫線で作る構造、角丸ほぼゼロ。ただし表現の重心は図版から**表とテキスト**へ移った。健康状態は線ではなく数値で示す — 常時表示のステータスバーが `不良 X件 / 注意 Y件` を持ち、答えの続き(「どの3件か」)はドロワーが持つ。読むだけなら無害、書くときは儀式(差分プレビュー→明示確認→退避)という製品原則は、確認ダイアログの重さと「表示 = 実行」の約束としてそのまま生きている。

旧「整備マニュアルの配線図」ワールドは既定画面から降格し、ヘッダーの「マップ」トグルで開く補助ビュー(Diagram.svelte)としてのみ存続する。検印スタンプ・リビジョン雲の演出言語は廃止された。派手な見せ場は置かない: 状態遷移は 160–200ms、適用完了は文言とステータスバーの数値で伝える。

**Key Characteristics:**
- ライト固定・紙の世界(desk の上に paper のパネルが並ぶ。ダークテーマなし — 意図的)
- 構造は罫と枠(--rule / --rule-strong の 1px)。カード・角丸・浮遊影の UI 慣習を採らない
- 信号色は意味を独占する: 赤=障害/未整合/破壊的操作、緑=整合/有効。装飾には使わない
- 存在しない値を描かない: version 無しは「—」、plan 未取得の状態は「PLAN 未取得」(整合と偽らない)
- 日本語 UI(Zen Kaku Gothic New)+ 等幅は識別子・数値のみ(M PLUS 1 Code)。フォント・アイコンは全て同梱/自前描画(オフライン・CSP 前提)

## Colors

インクと紙の二層に、意味を持つ二つの信号色だけを重ねたパレット。

### Primary
- **墨紺 / Ink** (#1a2b3c): 文字・枠・選択タブとフィルタの塗り・primary ボタンの塗り。ホバー時の塗りは #24384c に持ち上がる。フォーカスリング(2px solid)もインク。
- **副次インク / Ink-2** (#4f6274): 二次テキスト(説明・パス・列見出し・メタ列)。使用面(paper / panel / inset)全てで 4.5:1 以上を維持する。
- **休止インク / Ink-3** (#74838f): disabled 状態の枠と文字、マップビューの休止導体。本文には使わない(非テキスト要素として 3:1 を維持)。

### Secondary
- **信号赤 / Signal Red** (#c8452a): 障害の枠・pending バッジの枠・danger ボタンのホバー塗り・マップビューの断線。fault-text (#9e3520) は同じ信号を本文サイズで運ぶ変種(paper 上 6.2:1)。fault-wash (rgba(200,69,42,0.09)) が警告面の地 — 必ず paper を下に敷いてから重ねる(desk の上に直接置くとコントラスト床を割る)。
- **検印緑 / Inspection Green** (#2e7d4f): 整合バッジの枠・有効トグルのドット・完了帯。pass-text (#26683f) が本文サイズ(5.9:1)、pass-wash が完了面の地。

### Neutral
- **製図紙 / Paper** (#f4f1e8): 全パネル(ヘッダー・テーブル・詳細ペイン・ダイアログ)の地。ボタンの基本塗り。
- **図版紙 / Paper Panel** (#efebde): パネル内の一段沈む帯 — テーブルのツールバー・sticky ヘッダー・ステータスバー・ダイアログ内リストの地。行ホバーの塗りでもある。
- **紙の窪み / Paper Inset** (#e7e2d2): さらに沈む面 — 詳細ペインの基本情報グリッド・code・fixture 帯。
- **机 / Desk** (#ddd6c2): body の背景。パネルの外にある机の面。
- **罫 / Rule** (rgba(26,43,60,0.22)) と **強罫 / Rule Strong** (rgba(26,43,60,0.5)): 行区切り・セル区切りが --rule、パネル外周・ヘッダー下・コントロール群の枠が --rule-strong。面ではなくこの罫が構造を作る。
- **注意の地 / Caution Wash** (rgba(26,43,60,0.06)): 選択行の地。注意(warn)も赤ではなくインクで示す。

### Named Rules
**赤は障害専用ルール。** 信号赤が塗ってよいのは、障害・未整合・破壊的操作の三つだけ。書き込みという重い操作(適用ボタン)であっても赤にしない — commit ボタンは他の肯定的操作と同じ墨紺であり、行為の重さは確認ダイアログの儀式が示す。削除ボタンすら常態は赤枠+赤文字のアウトラインで、塗りはポインタが確定したホバー/フォーカス時のみ(一覧の全行が警報として光らないため)。

**二段インクルール。** 各信号色は大型・枠用(--fault / --pass)と本文用(--fault-text / --pass-text)の二段を持つ。枠・バッジ枠・アイコンは前者、12–13px のテキストは必ず後者(4.5:1 を切らないのは後者だけ)。

**ウォッシュは紙の上ルール。** 半透明のウォッシュ(fault-wash / pass-wash)は必ず paper の上に重ねる。desk 上に直接置く面では `background-color: var(--paper)` を敷いてから `background-image` で重ねる(FaultPlate・帯が実施)。

## Typography

**Display/Body Font:** Zen Kaku Gothic New(fallback: Yu Gothic UI, Meiryo, system-ui)
**Mono Font:** M PLUS 1 Code(fallback: Cascadia Mono, Consolas)

**Character:** 管理コンソールの注記的な性格。日本語は Zen Kaku Gothic New が全て(見出しも本文も同一ファミリー、ウェイトとサイズだけで階層を作る)。M PLUS 1 Code はパス・バージョン・件数・時刻・ターゲット名 — 機械が発行した識別子と数値だけのための等幅。両家族とも `/fonts` に同梱(画面はローカルサーバーが配り、CSP が外部からの読み込みを禁じている。オフラインでも同じ見た目になる)。本文は `font-feature-settings: "palt" 1` で詰める。

### Hierarchy
- **XL** (700, 1.375rem / --t-xl): 障害プレートの見出しのみ。最大級は失敗のために取ってある。
- **Title** (700, 1.125rem / --t-lg): 詳細ペインの資産名 h2、確認ダイアログの h2、サマリの計数。
- **Headline** (700, 0.9375rem / --t-md): ヘッダーの h1(アプリ名)、パネル見出し(letter-spacing 0.02–0.04em)。
- **Body** (400, 0.8125rem / --t-body, line-height 1.65): 既定の本文・テーブル本体・入力欄。
- **Small** (400, 0.75rem / --t-small): タブ(0.08em)・フィルタチップ・トグル・帯・ステータスバー・メタ列・注釈文。
- **Micro/Annotation** (400, 0.6875rem / --t-micro): `.annotation` = mono・uppercase・0.06em。dt・列見出し(sans, 0.08em uppercase)・DOCTOR/PLAN のセルラベル(0.1em)・タグ・バッジ。

### Named Rules
**等幅は識別子ルール。** M PLUS 1 Code を使ってよいのはパス・バージョン・件数・時刻・ターゲット名・コード・差分本文 — 機械が発行した識別子と数値だけ。文章には決して使わない。数値は `.num`(`font-variant-numeric: tabular-nums`)。

**大文字は案内ルール。** uppercase + letter-spacing は「データではなく案内」の印: 列見出し・dt・セルラベル・annotation。データ本体(資産名・パス・説明)は変形しない。

## Layout

ページではなく窓。`height: 100dvh; overflow: hidden` の縦 flex に、ヘッダー(タブ・再走査・マップ切替・終了)とステータスバーを固定し、ワークスペースが残り全てを取る。スクロールするのはテーブルの中身と詳細ペインの中身だけ — タブ / テーブル / 右ペイン / ステータスバーが常に同時に見えること(FIRST VIEWPORT)。

- **ワークスペース:** 2 カラム grid `minmax(0, 1.6fr) / minmax(20rem, 1fr)`(左=資産テーブル、右=詳細ペイン)、gap は --gap-3。
- **リフローの床:** `max-width: 62rem` または `max-height: 40rem` で窓を諦め、単一カラム+ページスクロールに落ちる。潰れて読めないペインより、スクロールする読めるペインを選ぶ。
- **マップビュー:** トグル時はテーブル+詳細ペインを置き換えて全幅(grid-column: 1 / -1)。62rem 未満では図が `min-width: 78rem` を保って横パン。SVG はデータ件数から座標を導出(schematic.ts `geometry()`)し一体縮尺する。
- **帯(strip):** fixture / drift / 適用結果の一行帯はヘッダーとワークスペースの間に flex アイテムとして挿入され、ワークスペースが譲る。
- **間隔スケール:** --gap-1〜--gap-6(0.25 / 0.5 / 0.75 / 1 / 1.5 / 2rem)。アプリ外周は gap-3〜gap-4、パネル内は gap-2〜gap-4 が基調。

## Elevation & Depth

ほぼ完全に平坦。パネル(ヘッダー・テーブル・詳細ペイン・ステータスバー・ドロワー)は 1px --rule-strong の枠を持つ paper の面であり、影を持たない。深さは罫と紙の明度差(paper → paper-panel → paper-inset)で作る。影が許されるのは「別の紙・別の層」であることを示す三箇所だけ。

### Shadow Vocabulary
- **ダイアログの浮き** (`box-shadow: 0 2px 4px rgba(26,43,60,0.12), 0 28px 56px -28px rgba(26,43,60,0.55)`): 確認ダイアログのみ。backdrop は rgba(26,43,60,0.42) + blur(1.5px)。
- **ボタンのホバー** (`box-shadow: 0 1px 0 var(--rule-strong)`): 1px の持ち上がり。押下(:active)で translateY(1px) + 影消去。
- **シートの浮き** (`box-shadow: 0 1px 2px rgba(26,43,60,0.08), 0 14px 28px -18px rgba(26,43,60,0.4)`): `.sheet` — 現在はマップビューの図面パネルだけが使う残置トークン。

### Named Rules
**紙の階層ルール。** 面の深さは影ではなく紙の明度で示す: パネルの地は paper、ツールバー・sticky ヘッダー・ステータスバーは paper-panel、窪み(基本情報グリッド・code・fixture)は paper-inset。選択・展開の強調は影ではなく塗りと 2px のインクバー(inset box-shadow)で示す。

## Shapes

直角の世界。パネル・テーブル・タブ群・チップ群・バッジ・タグ・帯は全て角丸なし。唯一の例外は操作の押しボタンとダイアログ — 2px radius を持つ(印刷物ではなく道具である印)。トグルのドット(0.55rem の円)だけが円形で、有効=検印緑の塗り、無効=空円。

ボーダーの太さが意味を運ぶ: 1px --rule=区切り、1px --rule-strong=パネル外周・コントロール群、1.5px ink=押しボタンとダイアログの枠、2px fault=障害プレート。破線は「実在しない/未確定/但し書き」の記号: unsupported バッジ・PLAN 未取得バッジ・fixture 帯が dashed 枠。

隣接するコントロール(タブ・フィルタチップ・サマリのセル・ステータスバーのセル)は個別の枠を持たず、群の外周 1px --rule-strong + 内部区切り 1px --rule のセグメントとして組む。選択状態は枠ではなく塗り(ink 地 + paper 文字)。

アイコンは自前 SVG(Icon.svelte)11 種のみ: viewBox 16、stroke 1.5、`stroke-linecap: square`、`stroke-linejoin: miter` — 製図ペンの語彙を引き継いだ線画。外部アイコンセットは持ち込まない。

## Components

### Buttons
- **Shape:** ほぼ直角(2px radius)、min-height 2.25rem(--sm は 1.9rem)、padding 0 1rem、border 1.5px solid ink、font-weight 500。
- **Secondary (`.btn`):** paper 地 + ink 文字。hover で #fffdf6 + 1px 影、active で 1px 沈む。
- **Primary (`.btn--primary`) / Commit (`.btn--commit`):** ink 塗り + paper 文字。hover #24384c。commit も赤にしない(赤は障害専用ルール)。
- **Danger (`.btn--danger`):** fault 枠 + fault-text 文字のアウトライン。hover / focus-visible で fault 塗り + 白文字に反転。
- **Focus:** `outline: 2px solid var(--ink); outline-offset: 2px`(danger は fault)。
- **Disabled:** 枠・文字とも ink-3、塗りは透明。ただし確認ダイアログの confirm は disabled にせず `aria-busy` + ハンドラ側ガード(フォーカスを body に落とさないため)。
- **アイコン:** 文字の前に 14–16px の自前アイコン。
- **Icon button (`.icon-btn`):** 2rem 四方・枠透明。行内削除は hover で fault 枠 + fault-text。

### Tabs / Filter Chips(セグメントコントロール)
- 群の外周 1px --rule-strong、内部区切り 1px --rule、角丸なし。
- タブは `aria-current="page"`、フィルタは `role="radiogroup"` + `role="radio"`。選択= ink 塗り + paper 文字。focus-visible はインセットの 2px リング(outline-offset: -2px)。

### Search Field
- paper 地 + 1px --rule-strong 枠 + 先頭に search アイコン。フォーカスは input ではなくコンテナの `:focus-within` に 2px ink リング。min-height 2rem。

### Table(資産一覧)— signature component
- `role="grid"`、`border-collapse: collapse`。行区切り 1px --rule、sticky ヘッダー(paper-panel 地、micro uppercase ink-2、下罫 --rule-strong)。
- **行が操作単位:** 行全体がクリック/フォーカス対象。リスト全体でタブストップは1つ、↑↓で選択が追従、→←で行内コントロール(トグル・削除)へ(rownav.ts)。テキスト選択で終わったクリックは選択と見なさない。
- **選択行:** caution-wash 地 + 左端 `inset 2px 0 0 var(--ink)` のインクバー。hover は paper-panel。
- **無効行:** 資産名に line-through + ink-2。
- **偽装しない列:** version 無しは「—」。plan 未取得の適用先列は「PLAN 未取得」の破線バッジ。

### Toggle(有効/無効スイッチ)
- `role="switch"`、1px --rule-strong 枠 + paper 地 + 0.55rem の円ドット。有効=ドットを pass で塗る。文字は「有効/無効」(詳細ペインでは「有効(配布する)」)。
- アクセシブルネームは `aria-labelledby` で**資産名 + 可視文字**を合成する(「style-guide 有効」)。可視文字を `aria-hidden` にしない — 音声操作は見えている語で呼ぶ(WCAG 2.5.3 label-in-name)。状態は `aria-checked` が運ぶので、名前の状態語と重複してよい。

### Badges(適用先の状態)
- 1.35rem 角の mono micro セル。match= pass 枠 + pass-wash、pending= fault 枠 + fault-wash、unsupported= 破線枠 + ink-2、unknown= 破線枠 +「?」。視覚記号は aria-hidden、同内容を sr-only テキストが運ぶ。

### Status Strips(帯)
- 1px の意味色枠 + wash 地(paper を敷いてから重ねる)+ 意味色テキストの一行帯。fault 系=障害/不完全適用、done= pass 系、fixture= 破線枠 + paper-inset(データではなく但し書き)。視覚帯は aria-hidden、同文をマウント時から存在する単一の `role="status"` live region が運ぶ。

### Status Bar + Drawer — signature component
- 常時表示のフッター(paper-panel 地、1px --rule-strong 枠)。DOCTOR セル `不良 X件 / 注意 Y件` と PLAN セル(未取得/取得中/差分 N 件/drift)はボタンであり、押すとドロワーが開く(`aria-expanded`、開中= paper 地 + 下端 2px インクバー)。右端に「差分を取る」「一括適用…」。
- ドロワーはダイアログではなくパネル(フォーカストラップなし、Escape と再クリックで閉じる)。doctor 所見の全文、plan の変更と注記(SPEC §5: 注記は差分と別勘定)、直近適用の記録を持つ。
- ドロワーを開くと焦点は本文領域(`role="region"`)へ移り、Escape / 閉じる / 再クリックで開いたセルへ戻る。焦点がドロワーの外にあるときの Escape は焦点を動かさない。トラップしないこと(Tab で出られる)と、入れないことは別である。
- 書き込み完了後のフォーカスは PLAN セル(`#statusbar-plan`)へ送る — 完了アナウンスが指す記録の一歩手前。

### Detail Pane(右ペイン)
- 見出し(種別 annotation + 資産名 t-lg + 説明)→ 基本情報の 2 カラム dl(paper-inset 地)→ **適用先エージェント一覧**(1 行 1 ターゲット: バッジ + ターゲット名 mono + 状態語 + 配置パス)→ doctor 所見 → 下端に操作列(差分を取る / 適用する / ソースから削除)。
- plan 未取得時は破線の注意書き + 「差分を取る」リンクボタンを一覧の上に一度だけ出し、✅ を偽装しない(SPEC §9.4)。

### Dialogs(確認)+ DiffPreview
- ネイティブ `<dialog showModal()>`。apply 用と remove 用の二つだけで、どちらも書き込みの明示確認。width min(48rem, 100vw−3rem)、1.5px ink 枠、2px radius、rise 200ms(reduced motion では移動なしのフェード)。
- **表示 = 実行:** リストは apply が使うのと同じ述語で絞った executable のみ。種別ごとの計数サマリ+対象パス全列挙+各行に GitHub Desktop 型の行差分(`<details>` 折り畳み、+N −N の統計、フォーカス可能なスクロール領域)。退避先ディレクトリを明記する。

### Fault Plate(障害プレート)
- 2px solid fault 枠 + paper に fault-wash を重ねた地、ワークスペースの上に全幅で座る。exit code・対象パス・stderr(`<details>` 内、focusable な scroll region)・部分書き込み警告・復旧アクション(再走査)を持つ。トーストに畳まない。失敗はこのシステム最大の型(--t-xl)を使う唯一の場所。

### Map View(Diagram.svelte)— 降格済みの補助表現
- ヘッダーの「マップ」トグル(`aria-pressed`)で開く全幅の結線図。単一ソース→分岐→4 ターゲットの導体を SVG 一枚で描き、座標はデータ件数から導出(schematic.ts)。断線= fault、未結線= ink-3 破線、pending= 破線の行進(900ms、reduced motion で停止)、apply 直後の再結線は描線アニメーション(reduced motion では色のステップ着地)。`.sheet` の影を使う唯一の面。
- 既定画面には決してしない: 集約表示が個々の MCP/agent への到達を妨げたことが降格の理由。

## Do's and Don'ts

### Do:
- **Do** 構造を罫で作る(区切り 1px --rule、パネル外周とコントロール群 1px --rule-strong)。面の深さは paper → paper-panel → paper-inset の紙階層で示し、影はダイアログとボタンホバーだけに許す。
- **Do** 隣接するコントロールはセグメントとして組む(群の外周枠+内部区切り)。選択状態は ink 塗り + paper 文字。
- **Do** 状態遷移は 160–200ms(--ease-out: cubic-bezier(0.16,1,0.3,1))。見せ場は置かず、完了は文言とステータスバーの数値で伝える。
- **Do** reduced motion では意味あるアニメーションを静止等価物に置き換える(ダイアログは移動なしフェード、マップの行進は停止して破線を残す)。一括 kill で完了の合図ごと消さない。
- **Do** エンジンの報告をそのまま描く: version 無しは「—」、plan 未取得は「PLAN 未取得」、実行されない操作は確認画面に出さない(表示 = 実行)。約束と結果がずれたら fault 帯で言う。
- **Do** エンジンの文(`action.detail` / `finding.detail`)は常に可視で描く。`notes.ts` の日本語は原文の**上に添える注記**であり置き換えではない(訳は code 鍵の固定文で、doctor がメッセージに書き込んだ値 — どのフィールドか・何文字か — を落としうる)。原文を `title` 属性に置かない — ホバーだけの経路は「隠した」と同じ(Don't 参照)。`title` を使ってよいのは同内容が GUI 内の別の可視経路にあるときの補助だけ(例: 適用先バッジ → 詳細ペインの一覧)。
- **Do** 全ての状態変化を単一の `role="status"` live region で読み上げ、視覚帯・バッジは aria-hidden + sr-only 等価で重複読みを防ぐ。スクロールだけの領域は tabindex="0" + role="region" + ラベルで keyboard 到達可能にする。

### Don't:
- **Don't** 信号赤を障害・未整合・破壊的操作以外に使わない。重要ボタンも装飾も赤にしない。削除ボタンは常態アウトライン、塗るのはホバー/フォーカスのみ。
- **Don't** カード UI・大きい角丸・浮遊 ambient 影を持ち込まない。radius は押しボタンとダイアログの 2px だけ(トグルのドットを除く)。
- **Don't** ダークテーマを追加しない。この世界は机上の紙であり、ライト固定は世界の一部(color-scheme: light)。
- **Don't** 外部アイコンセット・CDN フォント・ネットワーク資産を持ち込まない。全て同梱か自前描画(オフライン + CSP)。
- **Don't** モーダルを増やさない。モーダルは書き込みの明示確認(apply / remove)だけ。一覧・所見・記録はドロワーとペインで開き、詳細情報をツールチップやホバーだけに隠さない。
- **Don't** マップビューを既定画面に戻さない。図は補助の俯瞰であり、一覧・到達・操作の仕事はタブ+テーブル+詳細ペインが担う(カテゴリ標準の方針)。
