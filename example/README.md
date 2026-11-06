# cfordo example

## 目的

`double`・`square`を並列実行し、その検証・評価が成功した後に`sum`でD1の両結果を取得して合計するexample。
`new Ordo()`へ工程を登録し、`export default ordo`で専用Workerとして公開する。

## 仕様

- 入力は`{ "value": 7 }`のような数値を持つJSON。
- `double`は入力を2倍、`square`は入力を2乗する。
- 両工程の検証・評価が成功してから、`sum`が`ctx.result<Result>()`で同じGoalの結果をD1から取得して足す。
- `sum`の検証・評価まで成功するとGoalが完了する。先行工程が失敗した場合、sumは開始しない。
- validateは保存結果が有限の数値かを確認する。evaluateはGoal入力やD1の保存結果から期待値を求めて比較する。
- 正常時は各工程にrun・validate・evaluateの3件ずつ、Goalごとに計9件の実行履歴が残る。
- 起動入力は`ctx.input().params`、検証・評価の対象runの結果は`ctx.input().result`で取得する。
- `ctx.result()`は検証・評価まで成功した工程の結果全体を返し、未登録・未完了の工程にはエラーを返す。
- Binding名は`DB`・`QUEUE`に固定する。業務用の直接アクセスには`ctx.env.DB`などを使用できる。
- 毎分のCronが進行を確認する。Queueは指定処理と結果保存だけを行う。
- 1回のQueue処理でrun・validate・evaluateを実行し、同じctxを共有する。次の改善周回と後続工程への移行は次のCronを待つ。
- Cronは配送済み・実行中・Queueのリトライ待ちを再送しない。送信失敗や送信確認の期限切れに限り、送信をやり直す。
- validate・evaluateのNGは改善ループとして合算し、初回込みで最大10周。NGの次の周へは`ctx.feedback`でiteration・source・reasonを渡す。validateがNGならevaluateを実行しない。
- 例外はQueueのリトライで同じ周のrunから再実行し、改善回数を増やさない。各配送で実行した段階の履歴は残る。
- `ctx.feedback`の初回は`{ iteration: 1, source: null, reason: null }`。同じ周では変更しない。
- Queueのリトライ上限後はDLQで失敗結果を保存し、次のCronで、その周回の最初の確定結果に従ってGoalの終了が決まる。DLQ名は`ordo.configure({ deadLetterQueue: "example-ordo-queue-dlq" })`へ指定する。
- runは`ctx.complete(data)`、検証・評価は`ctx.ok()`・`ctx.ng(reason)`で保存する。それぞれawaitするかPromiseを返す。
- 公開URLは無効。内部HTTP APIはサービスBinding経由で利用する。外部AI APIは使用しない。

全体の利用例は[src/index.ts](src/index.ts)にある。
工程間で戻り値やメモリ上の結果を共有せず、sumのrunとevaluateはそれぞれD1から先行工程の結果を取得する。

| リソース | 名前                 |
| -------- | -------------------- |
| Worker   | `example-ordo`       |
| D1       | `example-ordo-db`    |
| Queue    | `example-ordo-queue` |
| Cron     | `* * * * *`（毎分）  |

### Goal API

| メソッド・パス             | 応答                                                                          |
| -------------------------- | ----------------------------------------------------------------------------- |
| `POST /_ordo/goals`        | 入力JSONを保存し、HTTP 202と数値の`{ "goalId": 1 }`を返す                     |
| `GET /_ordo/goals`         | 全件をGoal ID降順に返す。入力・状態・工程別結果を含み、`executions`は含まない |
| `GET /_ordo/goals/:goalId` | 指定Goalの状態・工程別結果と、各工程の`executions`を返す                      |

Goal・工程の状態は`ready`・`running`・`completed`・`failed`・`expired`。日時はUnix時刻のミリ秒。
検証・評価の`sourceRunId`は対応するrunの実行記録IDである。
不正なJSON・IDはHTTP 400、不存在は404、予期しない基盤エラーは500。
業務上の失敗や期限切れでも取得できればHTTP 200で返し、`status`と`error`で結果を判断する。
再POSTは新しいGoalを作る。HTTPの応答を受信できなくてもGoalが保存されている場合はある。

## 開発環境

リポジトリルートのmise・pnpm設定を使用する。Wranglerは対象アカウントへの認証が必要。
Bindingsの型は公開用設定例から生成した`worker-configuration.d.ts`を使う。設定を変更したら`pnpm --filter @cfordo/example types`で再生成する。

`wrangler.example.jsonc`は公開用の設定例で、実環境のAccount ID・DB IDを含めない。
初回に`wrangler.jsonc`へコピーし、自分の`account_id`と`database_id`を指定する。
`wrangler.jsonc`はGit管理外で、Wranglerが開発・デプロイ時に標準で読む。実IDを公開用設定へ書き戻さない。
D1には`remote: true`を指定する。

## 開発方法

以下はリポジトリルートで実行する。

```sh
mise install
pnpm install --frozen-lockfile
cp example/wrangler.example.jsonc example/wrangler.jsonc
# example/wrangler.jsonc に自分のIDを記入
pnpm check
```

DBの初期化・マイグレーションは自動で行う。初期化コマンドの実行は不要。
ローカル確認は`pnpm check`による型チェック・ビルドに限定し、動作は本番へデプロイしたexampleで確認する。

本番Workerを呼び出す設定は`wrangler.caller.jsonc`に置く。
`ORDO`はデプロイ済みの`example-ordo`へのサービスBindingで、`remote: true`を指定する。
`request`コマンドは`request.mjs`を実行し、Wranglerの認証済み接続から呼び出す。
Account IDはローカル専用の`wrangler.jsonc`から読み込む。対象のOrdoをローカル実行せず、別Workerや公開プロキシもデプロイしない。
通信セッションは各リクエストの終了時に閉じる。

```sh
pnpm --filter @cfordo/example request POST /_ordo/goals '{"value":7}'
pnpm --filter @cfordo/example request GET /_ordo/goals
pnpm --filter @cfordo/example request GET /_ordo/goals/1
```

引数はHTTPメソッド、パス、任意のJSON本文。HTTPステータスと本文を表示し、HTTPエラー時は終了コード1を返す。
返されたGoal IDで完了まで詳細を確認する。

### 本番での確認

- 入力7・11・23を並行して起動し、各POSTがHTTP 202と異なる数値のGoal IDを返すこと。
- 各Goalのdouble・square・sumと、3工程の検証・評価が成功すること。正常時の履歴は各工程3件ずつ、計9件。
- 検証・評価が対応するrunを参照し、sumは先行2工程の検証・評価が終わってから開始すること。
- sumのrunとevaluateが、そのGoalのD1保存結果を`ctx.result()`で取得すること。
- 全件一覧がGoal ID降順で、入力・状態・工程別結果が詳細と一致し、`executions`を含めないこと。
- 入力`{ "value": 1e308 }`では非有限の結果を保存できず、Queueの例外リトライ上限で失敗すること。理由と履歴を取得でき、sumの実行履歴は0件であること。
- 不正JSON・不正IDはHTTP 400、不存在のGoal IDは404を返すこと。
- 公開URLからはAPIを利用できず、サービスBinding経由では利用できること。
- 実際のCronで進行し、通常の配送待ち・実行中・Queueのリトライ待ちを再送しないこと。
- 本番exampleで共有ctx、validateのNGによるevaluate省略、両判定のNGからの改善、10周の共通上限、各段階の例外リトライが改善回数を消費しないことを確認する。
- Queueの例外リトライ上限後にDLQが失敗結果を保存し、その後のCronでGoalが失敗になること。
- 同じ周回の仕事を複数回送信し、各実行のrun・validate・evaluateが別々に保存され、実行開始順によらず最初に保存された確定結果を使うこと。
- 最初の確定結果がNGなら後続のOKで変更されず、次の周回へそのNG理由が渡ること。遅れて届いた前周の結果やDLQの報告でも変更されないこと。
- 一覧・詳細・後続工程の取得結果が同じ確定結果を参照し、採用しなかった実行も詳細の履歴に残ること。
- APIの入力・結果・判定・履歴を本番D1の保存記録と照合すること。

| 入力 | double | square | sum |
| ---- | ------ | ------ | --- |
| 7    | 14     | 49     | 63  |
| 11   | 22     | 121    | 143 |
| 23   | 46     | 529    | 575 |

検証で作成したGoalは本番DBに残る。既存の履歴は削除せず、DBをリセットしない。
一時停止したQueue配送や検証用の通信セッションは、検証終了時に元へ戻す。

## デプロイ方法

```sh
pnpm --filter @cfordo/example run deploy
```

デプロイでQueue producer/consumer・DLQ consumerと毎分のCronを設定する。DLQは`example-ordo-queue-dlq`で、同じWorkerが受信する。Queueの`max_retries: 3`は初回の後の再試行3回を意味し、改善上限10周とは別である。Cronは常設し、未完了Goalがなければ何も進めない。
Cron設定の反映には最大15分かかる場合がある。設定反映と実際の起動を確認してから検証する。
旧構成からの移行前には旧Workflow・Queue処理の終了を確認する。既存のaction別DBと履歴はそのまま移行できる。
`workers_dev: false`・`preview_urls: false`・`routes: []`を維持する。

本番D1などへのWrangler操作は、ローカル設定を使う以下の形で行う。

```sh
pnpm --filter @cfordo/example exec wrangler <command>
```

呼び出し元WorkerにサービスBindingを設定する。

```json
{ "services": [{ "binding": "ORDO", "service": "example-ordo" }] }
```

```ts
const response = await env.ORDO.fetch("https://ordo/_ordo/goals", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ value: 7 }),
});
const { goalId } = await response.json<{ goalId: number }>();
const detail = await env.ORDO.fetch(`https://ordo/_ordo/goals/${goalId}`);
```

`ORDO`の型は`Fetcher`。URLのホスト名は公開先ではなく、通信先はBindingで決まる。
