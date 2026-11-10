# cfordo example

`double`・`square`を並列実行し、両方の検証・評価が成功した後に`sum`で結果を合計するexample。
実装は[src/index.ts](src/index.ts)、ライブラリの使い方は[ルートREADME](../README.ja.md)を参照。

## 準備

以下のコマンドはリポジトリルートで実行する。

```sh
mise install
pnpm install --frozen-lockfile
cp example/wrangler.example.jsonc example/wrangler.jsonc
```

初回だけ設定例をコピーし、`wrangler.jsonc`に自分の`account_id`・`database_id`を設定する。対象アカウントでWranglerを認証し、次のリソースを用意する。

| リソース | 名前 |
| --- | --- |
| Worker | `example-ordo` |
| D1 | `example-ordo-db` |
| Queue | `example-ordo-queue` |

実IDはGit管理外の`wrangler.jsonc`だけに記載する。`remote: true`、毎分のCron、公開URL無効の設定を維持し、DLQは設定しない。
Binding設定を変更した場合は`pnpm --filter @cfordo/example types`で型を再生成する。

## 実行と本番検証

### 1. 確認・デプロイ

差分を確認し、型チェック・ビルド後に本番exampleへデプロイする。

```sh
git diff --check
pnpm check
pnpm --filter @cfordo/example run deploy
```

### 2. DBの初期化

検証開始時はexample専用DBをリセットし、空から始める。テーブルは自動作成される。このリセットを利用先プロジェクトのDBには行わない。
スキーマバージョン切り替えの検証では旧テーブルを残し、新テーブルが空で始まることと旧データ・旧配送の分離を確認してから旧テーブルを削除する。

### 3. 起動・一覧・詳細の取得

```sh
pnpm --filter @cfordo/example request POST /_ordo/goals '{"value":7}' &
pnpm --filter @cfordo/example request POST /_ordo/goals '{"value":11}' &
pnpm --filter @cfordo/example request POST /_ordo/goals '{"value":23}' &
wait

pnpm --filter @cfordo/example request GET /_ordo/goals
pnpm --filter @cfordo/example request GET /_ordo/goals/1
```

詳細取得のIDはPOSTが返した値に置き換える。工程の進行とGoalの成功・失敗確定に必要な毎分の定期起動を待つ。
`request`の引数は`<METHOD> <PATH> [JSON]`。HTTPステータスと本文を表示し、HTTPエラー時は終了コード1を返す。
接続先は[wrangler.caller.jsonc](wrangler.caller.jsonc)のサービスBindingが指す本番Worker。通信処理は[request.mjs](request.mjs)を使用し、各リクエストの終了時に接続を閉じる。

### 4. D1との照合

APIの入力・結果・判定・状態・履歴を、本番D1の保存記録と照合する。

```sh
pnpm --filter @cfordo/example exec wrangler d1 execute example-ordo-db --remote --command "<照合するSQL>"
```

### 通常検証の期待結果

| 入力 | double | square | sum |
| --- | --- | --- | --- |
| 7 | 14 | 49 | 63 |
| 11 | 22 | 121 | 143 |
| 23 | 46 | 529 | 575 |

- 各POSTがHTTP 202と異なる数値のGoal IDを返し、別Goalの入力・結果が混ざらない。3工程の検証・評価とGoal全体が成功する。
- 各工程の履歴はrun・validate・evaluateの3件、Goalごとに計9件。検証・評価の`sourceRunId`が対応するrunを指す。sumは先行2工程の検証・評価完了後に始まり、runとevaluateでD1の両結果を取得する。
- 一覧はGoal ID降順で、入力・状態・工程別結果が詳細と一致し、`executions`を含まない。後続工程も同じ確定結果を使い、採用しなかった実行も詳細の履歴に残る。
- 入力`{"value":1e308}`では非有限の結果を保存できず、例外の記録後にplannerがGoalを失敗終了する。例外後の再配送でも処理を再実行せず、sumの履歴は0件。例外は発生した実行行だけに保存され、複数工程の失敗理由を取得できる。
- exampleの工程を一時変更し、同じ実行内でのctx共有、validateのNGによるevaluate省略、検証・評価NGの上限終了、各段階の例外による失敗終了を確認する。改善回数は正常終了したNGの履歴から求められる。
- 改善上限の既定値は初回込み3回をコードで確認する。NGの検証時だけ`configure({ maxIterations: 1 })`を使い、初回NGで上限終了する。多数回のループは回さず、DBに固定の回数上限がないことはCREATE定義で確認する。
- 不正JSON・不正IDは400、不存在IDは404。公開URLからAPIへアクセスできず、サービスBinding経由で利用できる。DLQなしで正常終了・例外終了する。
- 同じスキーマバージョンで初期化を繰り返してもデータが消えない。変更箇所に固有の要件も、意図的な遅延・停止が不要な範囲で確認する。

### 明示的に依頼された場合だけ行う追加検証

- 配送待ち1分・実行15分の期限内は再送せず、期限切れ後に実際の定期起動で復帰する。実行期限はconsumer呼び出し開始を基準とし、段階の進行で延長しない。改善回数・feedback・成功済みの別工程を維持し、失効・再実行の履歴が残る。
- 重複配送やplannerの並行実行で、同じ仕事を重複して開始・再配送しない。古い実行の遅れた結果・NG・例外が現在の進行を変えない。
- Goalの期限が先なら再配送しない。復帰によってGoalの期限が延びず、一覧・詳細が期限切れを示す。plannerが終了状態・終了時刻を確定した後は、期限を延長しても再開しない。
- 期限設定の変更が既存の未完了Goalにも適用される。

### 終了・報告

一時変更した工程・設定・配送状態を戻し、通信セッションを閉じる。
デプロイ結果、Goal ID、期待結果と実際の結果、D1との照合結果を報告する。必要な検証ができなければ未確認項目と理由を示す。依頼されていない追加検証は完成判定に含めず、検証済みとも報告しない。
