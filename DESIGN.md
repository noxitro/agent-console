---
name: agent-console
description: 単一ソースとエージェント各系統の資産を一覧・追跡・操作する管理コンソール(ローカルサーバーが配り、ブラウザで開く画面)
colors:
  canvas: "#0e1014"
  surface-inset: "#111317"
  surface: "#16191e"
  surface-2: "#1d2127"
  surface-hover: "#232830"
  fg: "#e4e7eb"
  fg-2: "#a2aab5"
  fg-3: "#717a87"
  line: "#2a2f37"
  line-strong: "#353b45"
  control: "#6a7381"
  accent: "#2f6bd8"
  accent-hover: "#285fc6"
  on-accent: "#ffffff"
  accent-text: "#7cacf8"
  select-wash: "rgba(47, 107, 216, 0.18)"
  fault: "#e0524a"
  fault-text: "#f47f78"
  fault-fill: "#b8352f"
  fault-wash: "rgba(224, 82, 74, 0.14)"
  on-fault: "#ffffff"
  pass: "#3aa66f"
  pass-text: "#62c78f"
  pass-wash: "rgba(58, 166, 111, 0.14)"
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
  control: "4px"
  panel: "6px"
spacing:
  gap-1: "0.25rem"
  gap-2: "0.5rem"
  gap-3: "0.75rem"
  gap-4: "1rem"
  gap-5: "1.5rem"
  gap-6: "2rem"
components:
  button-secondary:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg}"
    rounded: "{rounded.control}"
    padding: "0 1rem"
    height: "2.25rem"
  button-secondary-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.fg}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "0 1rem"
    height: "2.25rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.on-accent}"
  button-danger:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fault-text}"
    rounded: "{rounded.control}"
    padding: "0 1rem"
    height: "2.25rem"
  button-danger-hover:
    backgroundColor: "{colors.fault-fill}"
    textColor: "{colors.on-fault}"
  installed-row:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg}"
    rounded: "{rounded.panel}"
    padding: "0.5rem 0.75rem"
---

# Design System: agent-console

## Overview

**Creative North Star: "カテゴリ標準の管理コンソール"**

このシステムは奇抜さを商品にしない。管理コンソールの定石(カテゴリ標準)を方針とし、タブ+一覧+詳細ペイン+ステータスバーという形を、皮肉なく隅々まで作り切ることを北極星とする。練度の基準は VS Code の設定/拡張機能ビュー(検索・フィルタ・バッジの語彙)と GitHub Desktop / Docker Desktop 系(差分プレビューと危険な書き込みの確認の見せ方)であり、これを下回れば未完成である(PRODUCT.md Brand Commitments)。

**Installed 画面(既定のタブ)は GitHub Copilot アプリの Installed の構造と色味を採る**(2026-11 判断): 1 ページに種別ごとのセクション(Plugins / MCP Servers / Skills / Agents / Commands / 指示ファイル)を縦に並べ、見出しに件数バッジ。各行は 1 行目に名前、2 行目に出どころ(「Plugin: <名前>」「Marketplace: <名前>」「個人」「プロジェクト: <名前>」「ローカル」)。上部に検索と「すべての種類」の絞り込み、単位(個人 / プロジェクト▾)の選択はヘッダー。左サイドバーと左の単位レールは採らない(右ペインと合わせて 3 面になり、62rem の床のすぐ上で一覧が潰れる)。Installed は P4 まで読み取りのみで、スイッチも追加・更新ボタンも置かない。置き場所を確かめられない行は「未確認」の破線バッジで、整合と偽らない。単位をまたいだ同名は行の中で可視にする(どちらが効くかは、確かめた組み合わせだけを今後出す)。

色は**ダーク固定**の管理コンソール: 濃いグレーの地に一段明るいパネル、低コントラストの罫、明るいグレーの本文、青のアクセント 1 色、緑 = 有効 / 整合、赤 = 障害だけ。Copilot アプリと同じくライトテーマは持たない。GitHub Primer の資産やブランド色そのものは持ち込まず、値だけを寄せる。健康状態は線ではなく数値で示す — 配布タブの常時表示のステータスバーが `不良 X件 / 注意 Y件` を持ち、答えの続き(「どの3件か」)はドロワーが持つ。読むだけなら無害、書くときは儀式(差分プレビュー→明示確認→退避)という製品原則は、確認ダイアログの重さと「表示 = 実行」の約束としてそのまま生きている。

旧「整備マニュアルの配線図」ワールドは配布タブの「マップ」トグルで開く補助ビュー(Diagram.svelte)としてのみ存続する。派手な見せ場は置かない: 状態遷移は 160–200ms、適用完了は文言とステータスバーの数値で伝える。

**Key Characteristics:**
- ダーク固定(`color-scheme: dark`)。ライトテーマは提供しない — 意図的
- 面の深さは明度の段(canvas → surface → surface-2 → surface-hover)と 1px の罫で作る。行と押せる部品は枠と控えめな角丸(4–6px)を持つ。浮遊影はダイアログとポップオーバーだけ
- 青は選択・フォーカス・主操作だけ。信号色は意味を独占する: 赤=障害/未整合/破壊的操作、緑=有効/整合。装飾には使わない
- 存在しない値を描かない: version 無しは「—」、plan 未取得は「PLAN 未取得」、置き場所が確かめられないものは「未確認」の破線
- 日本語 UI(Zen Kaku Gothic New)+ 等幅は識別子・数値のみ(M PLUS 1 Code)。フォント・アイコンは全て同梱/自前描画(オフライン・CSP 前提)

## Colors

暗い面の階段に、青のアクセント 1 色と、意味を持つ二つの信号色だけを重ねたパレット。値は `ui/src/app.css` の `:root` が正。

### コントラストの実測(WCAG 2.x の相対輝度で計算)

| 前景 | 背景 | 比 | 基準 |
|---|---|---|---|
| --fg #e4e7eb | --surface / --surface-2 / --surface-hover | 14.2 / 13.0 / 11.9 : 1 | 本文 4.5:1 |
| --fg-2 #a2aab5 | --surface / --surface-2 / --surface-hover | 7.5 / 6.9 / 6.3 : 1 | 本文 4.5:1 |
| --fg-3 #717a87(disabled・休止のみ) | --surface / --surface-2 | 4.1 / 3.7 : 1 | 非テキスト 3:1 |
| --control #6a7381(押せる部品の枠) | --surface / --surface-2 / --surface-hover | 3.7 / 3.4 / 3.1 : 1 | UI 部品 3:1 |
| --on-accent #fff | --accent #2f6bd8 / --accent-hover | 5.0 / 5.9 : 1 | 本文 4.5:1 |
| --accent-text #7cacf8(リンク・フォーカス・選択バー) | --surface / --surface-hover | 7.7 / 6.4 : 1 | 本文 4.5:1 |
| --pass-text #62c78f | --surface / pass-wash を surface に重ねた地 | 8.5 / 6.9 : 1 | 本文 4.5:1 |
| --fault-text #f47f78 | --surface / fault-wash を surface に重ねた地 | 6.8 / 5.9 : 1 | 本文 4.5:1 |
| --on-fault #fff | --fault-fill #b8352f | 5.9 : 1 | 本文 4.5:1 |
| --fg | select-wash を surface に重ねた地 | 11.9 : 1 | 本文 4.5:1 |
| --pass / --fault(枠) | --surface | 5.8 / 4.6 : 1 | 非テキスト 3:1 |
| フォーカスリング --focus(= accent-text) | --canvas / --surface | 8.3 / 7.7 : 1 | 3:1 |
| 選択済みセグメント上のリング --on-accent | --accent | 5.0 : 1 | 3:1 |

--line #2a2f37 / --line-strong #353b45 は 1.3 / 1.6 : 1 の装飾の罫で、部品の識別には使わない(行は文字で識別でき、押せる部品の枠は --control が担う)。

### Primary
- **アクセント / Accent** (#2f6bd8): 選択中のタブ・セグメント・主操作ボタンの塗り(白文字)。hover は #285fc6 に沈む(白文字との比が上がる向き)。
- **アクセント文字 / Accent Text** (#7cacf8): リンク、フォーカスリング(`--focus`)、選択行の左端バー、「他の単位にも同じ名前」の注記。
- **選択の地 / Select Wash** (rgba(47,107,216,0.18)): 選択行・選択中のプロジェクトの地。枠を --accent にして重ねる。

### Secondary
- **信号赤 / Signal Red** (#e0524a): 障害の枠・pending バッジの枠・マップの断線。fault-text (#f47f78) は同じ信号を本文サイズで運ぶ変種。削除ボタンの hover 塗りは白文字が 4.5:1 を超える fault-fill (#b8352f)。fault-wash が警告面の地。
- **検印緑 / Inspection Green** (#3aa66f): 有効 / 整合のバッジ枠・トグルのドット・完了帯。pass-text (#62c78f) が本文サイズ、pass-wash が地。

### Neutral
- **Canvas** (#0e1014): body。パネルの外の窓の地。
- **Surface** (#16191e): 全パネル(ヘッダー・一覧・詳細ペイン・ダイアログ)の地。
- **Surface 2** (#1d2127): パネル内で一段持ち上がる面 — ツールバー・sticky ヘッダー・ステータスバー・Installed の行・ボタンの基本塗り。
- **Surface Hover** (#232830): ポインタの下の行・部品。
- **Surface Inset** (#111317): 沈む面 — 入力欄・基本情報グリッド・code・fixture 帯。
- **Fg / Fg 2 / Fg 3**: 本文 / 二次テキスト(説明・パス・列見出し・出どころ)/ disabled と休止の印。
- **Line / Line Strong / Control**: 行区切り / パネル外周と行の枠 / 押せる部品(ボタン・入力欄・セグメント群)の枠。

### Named Rules
**赤は障害専用ルール。** 信号赤が塗ってよいのは、障害・未整合・破壊的操作の三つだけ。書き込みという重い操作(適用ボタン)であっても赤にしない — commit ボタンは他の肯定的操作と同じアクセントの青であり、行為の重さは確認ダイアログの儀式が示す。削除ボタンすら常態は赤枠+赤文字のアウトラインで、塗りはポインタが確定したホバー/フォーカス時のみ。Installed の「無効」も選択であって障害ではないので赤にしない。

**青は選択と主操作だけルール。** アクセントの青を装飾・見出し・アイコンに使わない。青が付いている所 = 今選ばれている所、または押すと進む所。

**二段の信号色ルール。** 各信号色は枠・大型用(--fault / --pass)と本文用(--fault-text / --pass-text)の二段を持つ。12–13px のテキストは必ず後者。

**ウォッシュは surface の上ルール。** 半透明のウォッシュ(fault-wash / pass-wash / select-wash)は surface か surface-2 の上に重ねる前提で比を測っている。canvas の上に直接置かない。

## Elevation & Depth

ほぼ平坦。パネル(ヘッダー・一覧・詳細ペイン・ステータスバー・ドロワー)は 1px --line-strong の枠と 6px の角丸を持つ surface の面であり、影を持たない。深さは明度の段(canvas → surface → surface-2 → surface-hover、沈む面は surface-inset)で作る。

### Shadow Vocabulary
- **ダイアログとポップオーバーの浮き** (`--shadow-dialog: 0 0 0 1px rgba(0,0,0,0.4), 0 24px 48px -12px rgba(0,0,0,0.7)`): 確認ダイアログと、ヘッダーのプロジェクト選択パネルだけ。ダイアログの backdrop は rgba(4,5,7,0.66) + blur(1.5px)。
- ボタンの hover は影ではなく塗り(surface-hover)と枠の明度(--fg-2)で示す。押下(:active)で translateY(1px)。

### Named Rules
**明度の階段ルール。** 面の深さは影ではなく明度で示す: パネルの地は surface、ツールバー・sticky ヘッダー・ステータスバー・行は surface-2、ポインタの下は surface-hover、入力欄と基本情報グリッドは surface-inset。選択の強調は影ではなく select-wash の地 + --accent の枠 + 左端の accent-text のバー(inset box-shadow)で示す。

## Shapes

控えめな角丸の世界。押せる部品(ボタン・入力欄・セグメント群・バッジ・タグ)は 4px(`--radius-control`)、パネル・Installed の行・ポップオーバー・ダイアログは 6px(`--radius-panel`)。丸みはこの二段だけで、ピル型(999px)は使わない。トグルのドット(0.55rem の円)は円形のまま、有効=検印緑の塗り、無効=空円。

ボーダーの太さと線種が意味を運ぶ: 1px --line=区切り、1px --line-strong=パネル外周と行、1px --control=押せる部品、1px --accent=選択中の行、2px fault=障害プレート。破線は「実在しない/未確定/但し書き」の記号: unsupported バッジ・PLAN 未取得バッジ・Installed の「未確認」と「不明」・fixture 帯が dashed 枠。

隣接するコントロール(タブ・フィルタチップ・単位のセグメント・ステータスバーのセル)は個別の枠を持たず、群の外周 1px --control + 内部区切り 1px --line のセグメントとして組み、群の外周だけを角丸にする。選択状態は枠ではなく塗り(accent 地 + 白文字)。

アイコンは自前 SVG(Icon.svelte)のみ: viewBox 16、stroke 1.5、`stroke-linecap: square`、`stroke-linejoin: miter`。外部アイコンセットは持ち込まない。

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

ページではなく窓。`height: 100dvh; overflow: hidden` の縦 flex に、ヘッダー(画面タブ・単位の選択または資産の種別タブ・再走査・マップ切替・終了)を固定し、ワークスペースが残り全てを取る。スクロールするのは一覧の中身と詳細ペインの中身だけ — ヘッダー / 一覧 / 右ペイン(配布タブではステータスバーも)が常に同時に見えること(FIRST VIEWPORT)。

- **ワークスペース:** 2 カラム grid `minmax(0, 1.6fr) / minmax(20rem, 1fr)`(左=一覧、右=詳細ペイン)、gap は --gap-3。Installed も配布も同じ比率。
- **Installed の一覧:** パネルの頭に単位名・パス・検索・種類の絞り込み・件数、その下がスクロールするセクションの列。セクション見出しは sticky で、件数バッジと「常時」のコスト(そのセクションの有効な行の字数、ハーネス別)を持つ。単位全体の常時コスト(個人・プロジェクト・ローカルの合計)は、行を選んでいないときの詳細ペインが持つ。
- **リフローの床:** `max-width: 62rem` または `max-height: 40rem` で窓を諦め、単一カラム+ページスクロールに落ちる。潰れて読めないペインより、スクロールする読めるペインを選ぶ。
- **マップビュー:** トグル時は表+詳細ペインを置き換えて全幅(grid-column: 1 / -1)。62rem 未満では図が `min-width: 78rem` を保って横パン。
- **帯(strip):** fixture / drift / 適用結果の一行帯はヘッダーとワークスペースの間に flex アイテムとして挿入され、ワークスペースが譲る。
- **間隔スケール:** --gap-1〜--gap-6(0.25 / 0.5 / 0.75 / 1 / 1.5 / 2rem)。アプリ外周は gap-3〜gap-4、パネル内は gap-2〜gap-4 が基調。

## Components

### Buttons
- **Shape:** 4px radius、min-height 2.25rem(--sm は 1.9rem)、padding 0 1rem、border 1px solid --control、font-weight 500。
- **Secondary (`.btn`):** surface-2 地 + fg 文字。hover で surface-hover + 枠 --fg-2、active で 1px 沈む。
- **Primary (`.btn--primary`) / Commit (`.btn--commit`):** accent 塗り + 白文字(5.0:1)。hover は accent-hover。commit も赤にしない(赤は障害専用ルール)。
- **Danger (`.btn--danger`):** fault 枠 + fault-text 文字のアウトライン。hover / focus-visible で fault-fill 塗り + 白文字(5.9:1)に反転。
- **Focus:** `outline: 2px solid var(--focus); outline-offset: 2px`(danger は fault)。
- **Disabled:** 枠・文字とも fg-3、塗りは透明。ただし確認ダイアログの confirm は disabled にせず `aria-busy` + ハンドラ側ガード(フォーカスを body に落とさないため)。
- **Icon button (`.icon-btn`):** 2rem 四方・枠透明。行内削除は hover で fault 枠 + fault-text。

### Tabs / Filter Chips / 単位のセグメント
- 群の外周 1px --control(4px 角丸)、内部区切り 1px --line。
- タブは `aria-current="page"`、フィルタは `role="radiogroup"` + `role="radio"`、単位のセグメントは `role="group"` 内の `aria-pressed`。選択= accent 塗り + 白文字。focus-visible はインセットの 2px リング(outline-offset: -2px)。選択済みの塗りの上ではリングを白にする(--focus は accent 上で 2.2:1 しかないため。app.css 末尾)。

### Search Field / Select
- surface-inset 地 + 1px --control 枠(4px 角丸)+ 先頭に search アイコン。フォーカスは input ではなくコンテナの `:focus-within` に 2px --focus リング。min-height 2rem。
- 種類の絞り込みはネイティブの `<select>`(「すべての種類(N)」「Plugins(n)」…)。件数は検索後の数。

### Installed の一覧 — signature component
- **セクション:** Plugins / MCP Servers / Skills / Agents / Commands / 指示ファイル の順に縦に並ぶ。空のセクションは出さない。見出し(t-md, 700)+ 件数バッジ(4px 角丸、surface-hover 地、fg-2)+ 右に「常時 Claude N 字 · Copilot M 字」(未計測は「未計測 n」と別に数える)。
- **行:** 1px --line-strong の枠 + 6px 角丸 + surface-2 地のカード状の行。左に 1 行目 = 名前(500)とフラグ、2 行目 = 出どころ(fg-2, small)、必要なら 3 行目 = 「個人 にも同じ名前があります」(accent-text)。右にハーネスごとの状態語(「Claude 有効」「Copilot 無効」)を縦に積む。行の上端は sticky の見出しに隠れないよう `scroll-margin-top` を持つ(WCAG 2.4.11)。
- **状態語は操作に見せない:** 枠を持たない「印 + 文字」。行の右端は Copilot アプリがスイッチを置く場所なので、枠付きの語はボタンに見える(監査の指摘)。有効 = 緑の塗りの点 + pass-text、条件付き・import 経由 = 緑の破線の点、無効・読まれない = 空の点 + fg-2、不明・未確認 = 破線の点 + 破線の下線。点は塗りではなく枠で描く(コントラストテーマでも消えない)。
- **フラグ:** 読めない = fault-text の枠、所見 n = fg-2 の枠、未確認 = 破線枠。
- **プラグイン由来の行:** プラグインの部品(skill・command・agent・MCP)は自分の種別のセクションに並び、出どころが「Plugin: <名前>」。有効・無効はプラグインごとに決まり、常時コストはプラグインの行で数える(二重に数えない)。プラグイン自身の行は「Marketplace: <名前>」。
- **選択:** select-wash 地 + --accent の枠。枠と角丸を持つ行に左端の帯は足さない(side-stripe を避ける)。hover は surface-hover。
- **キーボード:** 一覧全体でタブストップは 1 つ(rownav.ts の roving tabindex)。↑↓ はセクションをまたいで行を移り、Home / End は端へ、PageDown / PageUp は次 / 前のセクションの先頭行へ(installed-view.ts `nextSectionStart`)。移動と選択は同時。Enter / Space でも選ぶ。テキスト選択で終わったクリックは選択と見なさない。
- **セマンティクス:** 一覧全体で 1 つの `role="listbox"`(「読み込まれる資産」)、セクションはその中の `role="group"`(見出しでラベル付け)、行は `role="option"` + `aria-selected`。1 列(62rem 未満)では行をクリックすると下の詳細ペインへスクロールする。件数バッジの数は sr-only の「(n 件)」と一緒に見出しの名前に入る。

### 単位の選択(ScopePicker)
- ヘッダーの「個人 | プロジェクト▾」の 2 セグメント。個人は押せばすぐ切り替わる(`aria-pressed`)。プロジェクト▾ は開くだけのボタンなので `aria-expanded` だけを持ち、選択中かどうかはラベル(「プロジェクト: 名前」)と塗りで示す。プロジェクト▾ は非モーダルのポップオーバー(`aria-expanded` + `aria-controls`、`role="region"`)を開き、検索・発見したプロジェクトの一覧・git 外/隠したものの表示・フォルダの手動追加・選択中プロジェクトの固定/非表示を持つ。これらは agent-console 自身の `~/.agent-console/projects.json` だけを書く。
- 開くと焦点は検索欄へ、↓ で一覧に入り ↑↓ Home End で移る。Escape で閉じて焦点はトリガーへ戻る。外のクリックと、焦点がパネルの外へ出たときにも閉じる。トラップしない。

### Table(配布タブの資産一覧)
- `role="grid"`、`border-collapse: collapse`。行区切り 1px --line、sticky ヘッダー(surface-2 地、micro uppercase fg-2、下罫 --line-strong)。
- **行が操作単位:** 行全体がクリック/フォーカス対象。リスト全体でタブストップは1つ、↑↓で選択が追従、→←で行内コントロール(トグル・削除)へ(rownav.ts)。
- **選択行:** select-wash 地 + 左端 2px の accent-text バー。
- **無効行:** 資産名に line-through + fg-2。
- **偽装しない列:** version 無しは「—」。plan 未取得の適用先列は「PLAN 未取得」の破線バッジ。

### Toggle(配布タブの有効/無効スイッチ)
- `role="switch"`、1px --control 枠 + 4px 角丸 + surface-2 地 + 0.55rem の円ドット。有効=ドットを pass で塗る。文字は「有効/無効」(詳細ペインでは「有効(配布する)」)。Installed には置かない。
- アクセシブルネームは `aria-labelledby` で**資産名 + 可視文字**を合成する(WCAG 2.5.3 label-in-name)。状態は `aria-checked` が運ぶ。

### Badges(適用先の状態)
- 1.35rem 角の mono micro セル。match= pass 枠 + pass-wash、pending= fault 枠 + fault-wash、unsupported= 破線枠 + fg-2、unknown= 破線枠 +「?」。視覚記号は aria-hidden、同内容を sr-only テキストが運ぶ。

### Status Strips(帯)
- 1px の意味色枠 + wash 地(surface を敷いてから重ねる)+ 意味色テキストの一行帯。fault 系=障害/不完全適用、done= pass 系、fixture= 破線枠 + surface-inset(データではなく但し書き)。視覚帯は aria-hidden、同文をマウント時から存在する単一の `role="status"` live region が運ぶ。

### Status Bar + Drawer(配布タブ)
- 常時表示のフッター(surface-2 地、1px --line-strong 枠、6px 角丸)。DOCTOR セル `不良 X件 / 注意 Y件` と PLAN セル(未取得/取得中/差分 N 件/drift)はボタンであり、押すとドロワーが開く(`aria-expanded`、開中= surface 地 + 下端 2px の accent-text バー)。右端に「差分を取る」「一括適用…」。
- ドロワーはダイアログではなくパネル(フォーカストラップなし、Escape と再クリックで閉じる)。doctor 所見の全文、plan の変更と注記(SPEC §5)、直近適用の記録を持つ。
- ドロワーを開くと焦点は本文領域(`role="region"`)へ移り、Escape / 閉じる / 再クリックで開いたセルへ戻る。
- 書き込み完了後のフォーカスは PLAN セル(`#statusbar-plan`)へ送る。

### Detail Pane(右ペイン)
- **Installed:** 行を選んでいないときは「この単位で開くと」の常時コスト(ハーネス別の字数とトークンの推測、含めないものの内訳)、読まないもの、注記、読んだ場所。行を選ぶと 見出し(種別 · 単位 + 名前 + 出どころ + 説明)→ 同名の注記(accent 枠)→ 基本情報の dl(surface-inset 地。パス・実体・出どころ・プラグイン・版・通信方式)→ プラグインの部品なら親プラグインへのリンク → **届き方**(ハーネスごとに状態・確度・読む場所・常時コスト・決めた設定・注記)→ @import / 部品 / 所見。
- **配布:** 見出し → 基本情報 → 適用先エージェント一覧(バッジ + ターゲット名 + 状態語 + 配置パス)→ doctor 所見 → 下端に操作列(差分を取る / 適用する / ソースから削除)。plan 未取得時は破線の注意書き + 「差分を取る」リンクボタンを一度だけ出し、✅ を偽装しない(SPEC §9.4)。

### Dialogs(確認)+ DiffPreview
- ネイティブ `<dialog showModal()>`。apply 用と remove 用の二つだけで、どちらも書き込みの明示確認。width min(48rem, 100vw−3rem)、1px --line-strong 枠、6px radius、--shadow-dialog、rise 200ms(reduced motion では移動なしのフェード)。
- **表示 = 実行:** リストは apply が使うのと同じ述語で絞った executable のみ。種別ごとの計数サマリ+対象パス全列挙+各行に GitHub Desktop 型の行差分(`<details>` 折り畳み、+N −N の統計、フォーカス可能なスクロール領域)。退避先ディレクトリを明記する。

### Fault Plate(障害プレート)
- 2px solid fault 枠 + surface に fault-wash を重ねた地、ワークスペースの上に全幅で座る。exit code・対象パス・stderr(`<details>` 内、focusable な scroll region)・部分書き込み警告・復旧アクション(再走査)を持つ。トーストに畳まない。失敗はこのシステム最大の型(--t-xl)を使う唯一の場所。

### Map View(Diagram.svelte)— 降格済みの補助表現
- 配布タブの「マップ」トグル(`aria-pressed`)で開く全幅の結線図。単一ソース→分岐→4 ターゲットの導体を SVG 一枚で描き、座標はデータ件数から導出(schematic.ts)。導体は fg(明るいグレー)、断線= fault、未結線= fg-3 破線、pending= 破線の行進(900ms、reduced motion で停止)。
- 既定画面には決してしない: 集約表示が個々の MCP/agent への到達を妨げたことが降格の理由。

### Forced colors(Windows のコントラストテーマ)
- 塗りで状態を示す所(選択中のタブ・チップ・単位のセグメント、選択行のバー、トグルのドット)は `forced-color-adjust: none` + Highlight / HighlightText / CanvasText で描き直す。Installed の行は CanvasText の枠、選択行は Highlight の 4px のバー(疑似要素だけを `forced-color-adjust: none` にし、行の文字はテーマの色のまま)、有効の状態語は枠で描いた点で、色が消えても区別が残る。

## Do's and Don'ts

### Do:
- **Do** 面の深さを明度の段(canvas → surface → surface-2 → surface-hover、沈む面は surface-inset)と 1px の罫で作る。影はダイアログとポップオーバーだけ。
- **Do** 押せる部品の枠は --control(3:1 以上)で描く。--line / --line-strong は装飾の罫であり、部品の識別をそれに頼らない。
- **Do** 行と押せる部品には控えめな角丸を付ける(部品 4px、パネルと行 6px)。
- **Do** 隣接するコントロールはセグメントとして組む(群の外周枠+内部区切り)。選択状態は accent 塗り + 白文字。
- **Do** Installed の行は「名前 / 出どころ」の 2 行で書き、プラグインの部品は「Plugin: <名前>」、プラグインは「Marketplace: <名前>」と書く。単位をまたぐ同名は行の中に文字で出す。
- **Do** 状態遷移は 160–200ms(--ease-out: cubic-bezier(0.16,1,0.3,1))。完了は文言とステータスバーの数値で伝える。
- **Do** reduced motion では意味あるアニメーションを静止等価物に置き換える。一括 kill で完了の合図ごと消さない。
- **Do** エンジンの報告をそのまま描く: version 無しは「—」、plan 未取得は「PLAN 未取得」、置き場所が確かめられないものは「未確認」の破線、実行されない操作は確認画面に出さない(表示 = 実行)。
- **Do** エンジンの文(`action.detail` / `finding.detail`)は常に可視で描く。`notes.ts` の日本語は原文の上に添える注記であり置き換えではない。原文を `title` 属性だけに置かない。
- **Do** 全ての状態変化を単一の `role="status"` live region で読み上げ、視覚帯・バッジは aria-hidden + sr-only 等価で重複読みを防ぐ。スクロールだけの領域は tabindex="0" + role="region" + ラベルで keyboard 到達可能にする。
- **Do** 新しい色の組み合わせを足したら、比を計算して本書の表に足す(本文 4.5:1、UI 部品とフォーカス 3:1)。

### Don't:
- **Don't** 信号赤を障害・未整合・破壊的操作以外に使わない。重要ボタンも装飾も「無効」も赤にしない。
- **Don't** アクセントの青を装飾・見出し・アイコンに使わない。青は選択・フォーカス・主操作だけ。
- **Don't** ライトテーマや OS 追従の切り替えを足さない。ダーク固定は方針の一部(`color-scheme: dark`)。
- **Don't** GitHub Primer の CSS・アイコン・ブランド色そのものを持ち込まない。寄せるのは値と構造だけ。
- **Don't** 大きい角丸(8px 超)・ピル型・ambient の浮遊影・枠のある行の左端の帯を持ち込まない。
- **Don't** Installed に操作に見える部品(スイッチ・チェックボックス・追加・更新・削除のボタン)を置かない。P4 で公式 CLI 経由の書き込みが入るまで読み取りのみ。
- **Don't** 左サイドバーや左の単位レールを戻さない。単位はヘッダーの選択と行の出どころで示す。
- **Don't** 外部アイコンセット・CDN フォント・ネットワーク資産を持ち込まない。全て同梱か自前描画(オフライン + CSP)。
- **Don't** モーダルを増やさない。モーダルは書き込みの明示確認(apply / remove)だけ。一覧・所見・記録はドロワーとペインとポップオーバーで開き、詳細情報をツールチップやホバーだけに隠さない。
- **Don't** マップビューを既定画面に戻さない。
