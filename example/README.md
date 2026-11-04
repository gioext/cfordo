# cfordo example

## 目的

Ordoを継承したクラスから、2つの工程をQueue経由で並列実行するexample。

## 仕様

- 入力は`{ "value": 7 }`のような数値を持つJSON。
- `double`は入力を2倍、`square`は入力を2乗する。
- 2つのStepを`parallel()`で実行し、両方の完了後にGoalが完了する。
- 各工程の`run`・`validate`・`evaluate`は独立したQueue処理として実行され、正常時は計6件の実行記録がD1に保存される。
- 専用Workerの`POST /_ordo/goals`へJSONを送ると、HTTP 202と数値の`{ "goalId": 1 }`を返す。
- `GET /_ordo/goals`は入力・状態・工程別の結果を全件返す。`GET /_ordo/goals/:goalId`は各工程の`executions`も返す。
- `executions`はrun・validate・evaluateの処理履歴。再配信では増えず、業務上の再試行で増える。
- HTTP APIはOrdoに組み込まれたHonoを使用する。外部AI APIは使用しない。
- `setup()`に設定・工程を定義し、名前付きのWorkflowクラスと`ExampleWorkflow.worker()`を公開する。
- Binding名は`DB`・`QUEUE`・`WORKFLOW`に固定する。
- 入力は`ctx.input()`の`params`と`result`から取得する。
- `run`は`await ctx.complete(data)`、検証・評価は`await ctx.ok()`・`await ctx.ng(reason)`で保存する。関数は値を返さない。
- 起動入力の`Params`と各工程の結果型を定義し、保存・読み取りの型を共有する。

| リソース | 名前                    |
| -------- | ----------------------- |
| Worker   | `example-ordo`          |
| D1       | `example-ordo-db`       |
| Workflow | `example-ordo-workflow` |
| Queue    | `example-ordo-queue`    |

## 開発環境

リポジトリルートのmise・pnpm設定を使用する。Wranglerは`wrangler.jsonc`で指定したアカウントにアクセスできる認証が必要。

Binding型はWranglerが生成する`worker-configuration.d.ts`を使用する。設定を変更した場合は`pnpm --filter @cfordo/example types`で再生成する。Workflowは`Ordo<Env>`を継承したクラスで公開する。

D1は`remote: true`としており、開発時も`example-ordo-db`へ接続する。

## 開発方法

以下はリポジトリルートで実行する。

```sh
mise install
pnpm install --frozen-lockfile
pnpm --filter cfordo build
pnpm --filter @cfordo/example typecheck
```

DBの初期化とマイグレーションは、Ordoが実行開始時に自動で行う。初期化コマンドの実行は不要。

起動口を含む自動テストは、リポジトリルートの`pnpm test`で実行する。
Cloudflare上の実動作は、次のデプロイ先URLへのリクエストで確認する。

## デプロイ方法

```sh
pnpm --filter @cfordo/example run deploy
```

切り替え前に旧WorkflowとQueue処理の終了を確認する。現行のaction別スキーマからの更新ではDBのリセットは不要。

Workerのデプロイ時にWorkflowとQueue Consumerを設定し、`workers.dev`のURLを公開する。プレビューURLは公開しない。
デプロイ結果に表示されたURLへパラメータをPOSTする。

```sh
curl --request POST '<DEPLOYED_WORKER_URL>/_ordo/goals' \
  --header 'Content-Type: application/json' \
  --data '{"value":7}'
```

応答の`goalId`で状態と結果を取得する。複数起動した場合もGoal IDで対応付けて集約できる。

```sh
curl '<DEPLOYED_WORKER_URL>/_ordo/goals'
curl '<DEPLOYED_WORKER_URL>/_ordo/goals/1'
```

入力7なら`double`の`output`は`{ "value": 14 }`、`square`は`{ "value": 49 }`になる。
Goalと両工程の`status`が`completed`であり、検証・評価が成功していることを確認する。
一覧は全件をGoal ID降順で返す。詳細の各工程には正常時3件ずつ、計6件の`executions`を含む。

日時はUnix時刻のミリ秒。不正なJSON・IDは400、不存在は404、起動確認・状態照会の障害は503を返す。
起動確認が503でも`goalId`が返った場合は、そのGoalを照会する。再POSTは新しいGoalを作る。
業務上の失敗・期限切れでも取得に成功すれば200であり、JSONの`status`と`error`を確認する。
