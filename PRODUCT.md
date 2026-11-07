# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

ローカルの Node サーバー(127.0.0.1 だけで待ち受ける)+ ブラウザで開く Svelte 5 + Vite + TypeScript の画面。サーバーは CLI と同じ TypeScript のエンジン(`src/`)を、同じプロセスのワーカースレッドで動かす。画面は `POST /api/run` でエンジンを呼び、`ac <args> --json` と同じ JSON を受け取る。CLI(`ac`、別名 `am`)と画面は同一エンジンを共有する。フロントは、パフォーマンス(メモリ・速度)優先と小規模ダッシュボードという性質から Svelte 5 を選んだ。

## Users

Windows で複数のコーディングエージェント(Claude Code / GitHub Copilot CLI / VS Code Copilot / Visual Studio 2026 Copilot / opencode)を併用する開発者が、自分の PC で使う個人用のローカルツール。状況: エージェント資産(skills / MCP サーバー / カスタムエージェント / コマンド)が複数系統のツールに分散し、重複コピーやドリフトが静かに発生する環境の維持管理。

## Product Purpose

分散した AI エージェント資産を単一ソース(`~/.agents-manager` + `~/.agents/skills`)から一元管理する。GUI は**日常的な管理コンソール**であり、仕事は3つ: (1) **一覧** — 種別(skills / MCP / agents / commands)ごとに全資産を表形式で把握する。(2) **追跡** — 選んだ資産がどのエージェントに、どの状態(整合 / 差分あり / 非対応)で届いているかを1画面で追う。(3) **操作** — plan で差分を確認し、apply で反映し、資産の有効化・無効化・削除をその場で行う。成功 = doctor がクリーンで plan の差分がゼロの状態を、思い出したときに数クリックで回復できること。

「使う」ための具体性を「見せる」ための抽象度より常に優先する。全体俯瞰の配線図は補助的なマップビューとして残すが、既定画面ではない。

## Operating Context

- ローカル完結。サーバーは 127.0.0.1 だけで待ち受け、外のネットワークへは出ない(カタログの閲覧は将来の機能)。テレメトリなし
- 起動経路は `agent-console.bat`(ダブルクリックでサーバーを起動し、既定のブラウザで画面を開く)。CLI(`ac.bat` / `am.bat`)と並存し、どの経路でも同じエンジン・同じ結果
- 書き込み操作(apply/import)は実 HOME(`~/.claude` 等、他ツールの生きた設定)に触れるため、必ず差分プレビュー→明示確認→バックアップの順
- 表示言語は日本語。資産名・コマンド名・ターゲット名(claude, copilot-cli 等)は英語のまま

## Capabilities and Constraints

- エンジンの能力 = CLI と同一: inventory / doctor / plan / import / apply / enable / disable / remove(SPEC は `docs/SPEC.md`、agent-console での変更は `docs/ARCHITECTURE.md` が正)
- VS 2026 の MCP は公式仕様未確定のため unsupported 表示(偽装しない)
- 実行環境に Node.js 22.12 以上が必要(サーバーもエンジンも Node で動く)
- 終了コード規約(0/1/2)とエラー時即停止(パース失敗を空扱いしない)はエンジン側で保証済み。GUI はこれを覆い隠さない
- **現時点ではネットワーク機能を持たない**。サーバーはローカルの 127.0.0.1 だけで待ち受け、外へは出ない。カタログの閲覧と、公式 CLI に任せる導入・更新は、ARCHITECTURE.md「フェーズとゲート」の P4・P5 で検討する(導入そのものをこのツールが HTTP で行うことはしない)
- バージョンは agentskills.io 仕様外の任意項目。持つ資産だけが持つ事実として扱い、無い資産には「—」を出す(捏造しない)
- 未決: 資産本文の編集機能(frontmatter 編集か全文編集か)

## Brand Commitments

- **UI はカテゴリ標準(定石)を採る** — タブ+テーブル+詳細ペインという管理コンソールの慣用を、皮肉なく、奇抜さを混ぜず、丁寧に実行する。UI 作業はこの方針を前提とし、視覚的独自性のために慣用を崩さない
- **練度の基準**: VS Code の設定/拡張機能ビュー(左リスト+右詳細、検索・フィルタ・バッジの語彙)と GitHub Desktop / Docker Desktop 系(差分プレビューと危険な書き込みの確認の見せ方)。この2つが越えるべきバー

## Evidence on Hand

- デモと画面の開発は架空のフィクスチャ(`ui/src/lib/fixtures.ts`。名前・パス・日時はすべて作り物)で行う。`npm --prefix ui run dev` で、重複コピー・未結線のターゲット・drift・エンジン異常などの状態を切り替えて見られる
- `docs/SPEC.md`(確定仕様)、`docs/ARCHITECTURE.md`(agent-console の構成)、vitest のテストスイート、CLI の実測ゲート(`npm run e2e:cli`)、ブラウザの e2e(`npm run e2e`)

## Product Principles

1. **読み取りは無害、書き込みは儀式** — 監視系は開くだけで動く。書き込みは差分→確認→バックアップを飛ばせない
2. **CLI と GUI は同じ真実** — エンジンを共有し、GUI 専用ロジックで結果が変わることを許さない
3. **失敗は大きく表示** — パース失敗・drift はエラーとして前面に出す。空表示や既定値で塗り潰さない
4. **軽さは機能** — サーバーは使う間だけ動き、30 分操作が無ければ止まる。常駐するプロセスを置かない
