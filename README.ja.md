# cfordo

Cloudflare Workers・Queues・D1で、処理・検証・評価を組み合わせたジョブを実行するTypeScriptライブラリ。

## インストール

```sh
pnpm add cfordo
```

## 工程を定義する

```ts
import { Ordo } from "cfordo";

type Params = { value: number };
const ordo = new Ordo<Env, Params>();

const double = ordo.step<{ value: number }>({
  name: "double",
  run: async (ctx) => ctx.complete({ value: ctx.input().params.value * 2 }),
  validate: async (ctx) =>
    Number.isFinite(ctx.input().result.value) ? ctx.ok() : ctx.ng("非有限"),
  evaluate: async (ctx) =>
    ctx.input().result.value === ctx.input().params.value * 2
      ? ctx.ok()
      : ctx.ng("2倍と不一致"),
});

ordo.plan(async ({ input, step }) => {
  await step(double, input);
});

export default ordo;
```

`Env`にはWranglerで生成したBinding型を使う。`run`は必須、`validate`・`evaluate`は任意。

| API                                             | 用途                                              |
| ----------------------------------------------- | ------------------------------------------------- |
| `ctx.input().params`                            | そのstepに渡した入力                                    |
| `ctx.input().result`                            | 検証・評価の対象runの結果                         |
| `await ctx.complete(data)`                      | runの結果を保存                                   |
| `await ctx.ok()` / `await ctx.ng(reason)`       | 検証・評価の判定を保存                            |
| `await ctx.result<T>(stepName)`                 | 同じGoalの成功済み工程の結果を取得                |
| `ctx.env`                                       | D1などのBindings                                  |
| `ctx.feedback`                                  | 改善周回の`iteration`と前回NGの`source`・`reason` |
| `ctx.goalId` / `ctx.stepName` / `ctx.attemptId` | 現在のGoal・工程・実行の識別子                    |

## 動的な直列・並列工程

上の `plan()` を次のように変更すると、最初の結果に応じて後続工程を組み立てられます。

```ts
ordo.plan(async ctx => {
  await ctx.step(double, ctx.input);
  const first = await ctx.result<{ value: number }>("double");
  if (first.value > 10) {
    await ctx.parallel([first.value, first.value + 1].map(value =>
      ctx.step(`double-${value}`, double, { value })
    ));
    const next = await ctx.result<{ value: number }>(`double-${first.value}`);
    // ...
  }
});
```

workflowごとにcallbackを1つ登録します。plannerは進行時に先頭から評価し、未完了の工程で今回の進行を区切ります。`await ctx.step()` と `await ctx.parallel()` の戻り値はvoidです。planとWorkerのどちらでも、同じGoalの確定結果を `await ctx.result(工程名)` で取得します。未確定・未知の工程名はエラーになります。

`step(工程名, 処理定義, 入力)` の工程名はGoal内で対象ごとに一意にします。省略時は処理定義の登録名を使います。同じ名前は同じ工程として扱われるので、再判定が必要な対象には別の名前を付けます。入力はJSON値です。planは `ctx.env` から現在のDBを読めます。副作用はWorkerの工程に置き、plan内のstep呼び出しの例外はそのまま伝播させてください。

0.6.0から移行する場合は、stepの戻り値を参照している箇所を `ctx.result()` に変更し、個別入力の工程に明示的な名前を付けます。進行中のGoalで工程名を変更すると別工程になるため、切り替え前に旧planのGoalを完了させます。

## 改善と期限の設定

`configure()`は任意。処理開始前に指定する。

```ts
ordo.configure({ maxIterations: 3, expiresIn: 24 * 60 * 60 * 1000 });
```

- `maxIterations`：工程ごとの改善回数の上限。
- `expiresIn`：Goalの有効期間（ミリ秒）。

## Workerを配置する

専用Workerに1つのOrdoと専用Queueを配置する。異なる`workflow`を設定すればD1を共有できる。
D1のBinding名は`DB`、Queue producerのBinding名は`QUEUE`。同じQueueのconsumerと毎分のCronも設定する。
[Wranglerの設定例](example/wrangler.example.jsonc)を基に、自分のリソース名・IDを指定する。
`workers_dev: false`・`preview_urls: false`・`routes: []`を維持し、サービスBinding経由で呼び出す。

```sh
npx wrangler types
npx wrangler deploy
```

## Goalを起動・取得する

呼び出し元WorkerにサービスBindingを設定する。`service`は配置したWorker名。

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

| メソッド・パス                   | 応答                                  |
| -------------------------------- | ------------------------------------- |
| `POST /_ordo/goals`              | `202 { "goalId": 1 }`                 |
| `GET /_ordo/goals`               | Goal ID降順の一覧。実行履歴は含まない |
| `GET /_ordo/goals/:goalId`       | 入力・状態・工程別結果・実行履歴      |
| `POST /_ordo/goals/:goalId/stop` | `200`と現在のGoal詳細。実行履歴も含む |

## Goalを停止する

```ts
await env.ORDO.fetch(`https://ordo/_ordo/goals/${goalId}/stop`, { method: "POST" });
```
