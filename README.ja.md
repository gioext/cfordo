# cfordo

## 目的

Cloudflare Cron Triggers・Queues・D1で、事前に定義した工程を実行するTypeScriptフレームワーク。
1回のQueue処理でrun・validate・evaluateを順に実行する。入力・結果・判定・改善周回・進行状態はD1へ保存する。
専用Workerに1つのOrdoを配置し、専用のD1とQueueを使用する。HTTP APIはサービスBinding経由で利用し、公開URLは使用しない。

実行中の工程変更、AIによる工程の追加・変更、Cloudflare以外へのデプロイは対象外とする。

## 仕様

### 利用例

```ts
import { Ordo } from "cfordo";

type Params = { value: number };
const ordo = new Ordo<Env, Params>();
ordo.configure({ deadLetterQueue: "example-ordo-queue-dlq" });

ordo.step<{ value: number }>({
  name: "double",
  run: async (ctx) => ctx.complete({ value: ctx.input().params.value * 2 }),
  validate: async (ctx) =>
    Number.isFinite(ctx.input().result.value) ? ctx.ok() : ctx.ng("非有限"),
  evaluate: async (ctx) =>
    ctx.input().result.value === ctx.input().params.value * 2
      ? ctx.ok()
      : ctx.ng("2倍と不一致"),
});

export default ordo;
```

`Env`にはWranglerが生成したBinding型を使用する。継承、`setup()`、`.worker()`は不要。
`export default ordo`でHTTP・Queue・Cronの入口を提供する。利用側でHonoや起動用のHTTPハンドラーを定義する必要はない。

### 起動と進行

Goalの起動時には入力をD1に保存し、HTTP 202と数値のGoal IDを返す。
起動リクエストは処理完了を待たない。各POSTは新しいGoalを作る。
毎分のCronで未完了Goalの進行を確認する。処理対象がない回は何も実行しない。
同じ改善周回のrun・validate・evaluateの間にはCron待ちを挟まない。次の改善周回や後続工程への移行は次のCronを待つ。
Queue処理から次の処理を起動したり、完了通知を送ったりする必要はない。

### 工程と並列実行

`ordo.step<Result>()`へ以下の定義を渡す。

| キー       | 必須 | 用途                                                               |
| ---------- | ---- | ------------------------------------------------------------------ |
| `name`     | 必須 | 一意な工程名                                                       |
| `run`      | 必須 | 業務処理。`ctx.complete(data)`で結果を保存する                     |
| `validate` | 任意 | 業務ルールの検証。`ctx.ok()`または`ctx.ng(reason)`で判定を保存する |
| `evaluate` | 任意 | 妥当性の評価。`ctx.ok()`または`ctx.ng(reason)`で判定を保存する     |

すべて非同期関数とし、保存処理はawaitするかそのPromiseを返す。業務データをreturnしても保存されない。
1回のQueue処理を改善1周とし、run → validate → evaluateを同じctxオブジェクトで実行する。未指定の判定は省略し、validateがNGならevaluateも省略する。
工程は登録順に進み、次の工程へ進むには先行工程の検証・評価まで成功する必要がある。

`ordo.parallel()`内で登録した工程は並列に進む。登録自体をawaitすることと、業務処理の完了待ちは別である。

```ts
await ordo.parallel(async () => {
  ordo.step<{ value: number }>({
    name: "double",
    run: async (ctx) => ctx.complete({ value: ctx.input().params.value * 2 }),
  });
  ordo.step<{ value: number }>({
    name: "square",
    run: async (ctx) => ctx.complete({ value: ctx.input().params.value ** 2 }),
  });
});

ordo.step<{ value: number }>({
  name: "sum",
  run: async (ctx) => {
    const [double, square] = await Promise.all([
      ctx.result<{ value: number }>("double"),
      ctx.result<{ value: number }>("square"),
    ]);
    await ctx.complete({ value: double.value + square.value });
  },
});
```

並列グループの全工程が成功すると後続へ進む。失敗した工程を再試行しても、成功済みの別工程はやり直さない。
工程名の重複、空の並列グループ、並列グループの入れ子は許可しない。処理開始後に登録・設定を変更できない。
全工程の検証・評価を含む[example](example/src/index.ts)を参照する。

### 入力・結果・Bindings

工程間で変数・クロージャ・戻り値を共有せず、必要な値をD1の保存結果から取得する。
各周回の開始時にGoal入力と前周の改善理由をD1から読み込む。runが保存した今回の結果をvalidate・evaluateが参照する。

| API・値                         | 用途                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `ctx.input().params`            | 同じGoalの起動入力。型は`Params`                                                      |
| `ctx.input().result`            | 検証・評価の対象runの保存結果。型は`Result`。run自身では`undefined`                   |
| `await ctx.result<T>(stepName)` | 同じGoalの、指定工程の検証・評価まで成功した結果全体をD1から取得する                  |
| `ctx.env`                       | 今回の呼び出しのBindings。D1は`ctx.env.DB`、追加Bindingも同様に参照する               |
| `await ctx.complete(data)`      | runの業務結果を保存する                                                               |
| `await ctx.ok()`                | 検証・評価の成功判定を保存する。引数なし                                              |
| `await ctx.ng(reason)`          | 検証・評価の否定判定と空でない理由を保存する                                          |
| `ctx.goalId`                    | Goal ID                                                                               |
| `ctx.stepName`                  | 現在の工程名                                                                          |
| `ctx.attemptId`                 | 現在の段階の実行記録ID。同じctxでも段階が変わると値が変わる                           |
| `ctx.feedback`                  | `{ iteration, source, reason }`。初回は`{ iteration: 1, source: null, reason: null }` |

`ctx.result()`は未登録・未開始・未完了・失敗した工程にはエラーを返す。runだけの成功では、必要な検証・評価が残っている工程の結果を取得できない。
Goal IDの指定は不要で、別Goalの結果は混ざらない。工程のテーブル構造を利用側で知る必要もない。
取得した値の変更はD1へ反映されない。同じ周回内ではfeedbackを変更しない。次の改善周回やQueueのリトライでは、D1から新しいctxを生成する。

Binding名は`DB`（D1）と`QUEUE`（専用Queue）に固定する。`Env`は`OrdoEnv`を満たす必要があり、追加の業務用Bindingsも利用できる。
`configure()`には、同じWorkerが受信するDLQ名を`deadLetterQueue`として指定する。例外リトライの回数・遅延はWranglerのQueue consumer設定だけで管理する。
型引数は静的な型指定であり、業務スキーマの実行時検証ではない。未指定の入力・結果型は`any`となる。

### 保存・改善ループ・例外リトライ

入力と業務結果はJSON互換の値に限る。`undefined`、非有限数値、循環参照などは保存できない。結果が不要なrunでは`ctx.complete(null)`を使う。
各段階は結果・判定を保存して正常終了すると完了する。保存後に例外を投げれば、その段階は失敗として履歴に残る。再実行時も保存操作が必要。

- validateまたはevaluateがNGなら、その周の結果を保存してQueue処理を正常終了する。NGは例外ではない。
- 次のCronが、NG理由を`ctx.feedback.source`・`reason`へ渡し、`iteration`を1増やして次の周を起動する。
- 改善上限は初回を含む10周。validate・evaluateのNGに別々の上限は設けない。10周目でOKなら成功し、NGなら品質未達でGoalを失敗にする。
- 途中の例外はQueueのリトライで同じ周のrunからやり直す。成功済みの段階も実行され得るため、外部への副作用は冪等に扱うこと。
- Queueのリトライではiterationと前周のfeedbackを変えない。例外回数を改善回数に加算しない。
- 配送待ち・実行中・Queueのリトライ待ちはCronから再送しない。送信失敗は次のCronで再送し、送信途中の停止は1分の送信確認期限後に再送可能となる。
- 確定済みの周回の重複配送では処理を実行せず、保存済み結果も変更しない。
- Queueの再試行上限を超えたメッセージは標準DLQで受け取り、D1へ`QueueRetriesExhausted`として失敗を確定する。Cronで新しいメッセージに置き換えてQueueの上限をリセットしない。

Queueの各再実行で行った段階も履歴に残す。`executions`の`iteration`は改善周回、`delivery`はQueueの配送試行番号で、両者を区別できる。旧形式の履歴ではこれらのフィールドを省略する。
正常時の履歴は各工程run・validate・evaluateの3件で、example全体では9件。validateがNGの周にはevaluateの履歴を作らない。

期限はGoal受付時に固定し、改善やリトライで延長しない。既定は24時間。`ordo.configure({ deadLetterQueue: "...", expiresIn: ミリ秒 })`で変更できる。
期限後に新しい処理を開始しない。実行中の業務処理を期限ちょうどに中断する保証はなく、遅れて保存された結果が履歴に残る場合はある。

### Goal API

| メソッド・パス             | 入力           | 応答                                      |
| -------------------------- | -------------- | ----------------------------------------- |
| `POST /_ordo/goals`        | 業務入力のJSON | `202 { "goalId": 1 }`と取得先の`Location` |
| `GET /_ordo/goals`         | なし           | 全件をGoal ID降順で返す。ページングなし   |
| `GET /_ordo/goals/:goalId` | 正の整数ID     | 1件の状態・結果・実行履歴                 |

共通フィールドは`goalId`・`input`・`status`・`createdAt`・`expiresAt`・`finishedAt`・`error`・`results`。
状態は`ready`・`running`・`completed`・`failed`・`expired`。日時はUnix時刻のミリ秒。未確定の終了日時は`null`。
結果は`stepName`・`status`・`action`・`output`・`validation`・`evaluation`・`error`・`createdAt`・`finishedAt`を持ち、未開始の工程も含む。
`action`は現在または次の処理。完了した工程では`null`。出力と判定は同じrunに対応し、未保存・未実施は`null`。
途中・失敗時の出力も表示されるため、結果の採用時には工程の`status`が`completed`であることを確認する。

詳細だけは工程ごとに`executions`を含み、実行記録ID昇順で返す。一覧には含めない。
各記録は`attemptId`・`action`・`sourceRunId`・`status`・`output`・`verdict`・`error`・`createdAt`・`finishedAt`を持つ。
`sourceRunId`は検証・評価の対象runのIDで、run自身では`null`。
判定は`{ "ok": true }`または`{ "ok": false, "reason": "..." }`。
エラーは`{ "code": "...", "message": "..." }`で、なければ`null`。

不正なJSON・IDはHTTP 400、存在しないGoalは404、予期しない基盤エラーは500。
業務上の失敗・期限切れでも取得できればHTTP 200で返し、結果の`status`と`error`で区別する。
起動リクエストの応答を受信できなくても、Goalが保存されている可能性はある。再POSTは別Goalになる。

## 開発環境

`mise.toml`のNode.js・pnpmを使用する。型チェックは`tsrs`、デプロイはWranglerを使用する。
利用側のBindingsとランタイム型は`wrangler types`で生成する。

## 開発方法

```sh
mise install
pnpm install --frozen-lockfile
pnpm format
pnpm check
```

`pnpm check`はライブラリの型チェック・ビルドとexampleの型チェックを行う。
ローカルの確認は型チェック・ビルドに限定し、動作は[本番exampleの手順](example/README.md)に従って検証する。
`pnpm build`はESM・型宣言・ソースマップを`dist`へ出力する。

## デプロイ方法

ライブラリは、本番exampleの検証完了後、npmへの公開権限を持つアカウントで`pnpm run deploy`を実行して公開する。
利用側WorkerにはD1・Queue producer/consumer・例外リトライ上限到達時のDLQと毎分のCronを設定する。DLQも同じWorkerが受信し、名前を`configure({ deadLetterQueue })`へ指定する。

```json
{
  "queues": {
    "consumers": [
      {
        "queue": "example-ordo-queue",
        "max_retries": 3,
        "dead_letter_queue": "example-ordo-queue-dlq"
      },
      { "queue": "example-ordo-queue-dlq" }
    ]
  },
  "triggers": { "crons": ["* * * * *"] }
}
```

Cronは常設する。設定の追加・変更・削除がCloudflare全体に反映されるまで時間がかかる場合がある。
公開URLは`workers_dev: false`・`preview_urls: false`・`routes: []`で無効にする。
呼び出し元にはサービスBindingを設定する。

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

URLのホスト名はRequestを組み立てるためのもので、通信先はBindingが決める。公開ドメインやDNS設定は不要。
DBは自動で初期化・マイグレーションする。明示的に初期化する場合は`initOrdo(env.DB)`を使用できる。
旧構成から切り替える前に、旧WorkflowとQueue処理が終了していることを確認する。
既存のaction別DBと実行履歴は保持したまま移行でき、DBのリセットは不要。
