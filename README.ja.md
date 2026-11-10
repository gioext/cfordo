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

`Env`にはWranglerで生成したBinding型を使う。`run`は必須、`validate`・`evaluate`は任意。
保存操作はawaitするか、そのPromiseを返す。業務データをreturnするだけでは保存されない。
工程名は一意にし、登録・設定は処理開始前に済ませる。

| API | 用途 |
| --- | --- |
| `ctx.input().params` | Goalの起動入力 |
| `ctx.input().result` | 検証・評価の対象runの結果 |
| `await ctx.complete(data)` | runの結果を保存 |
| `await ctx.ok()` / `await ctx.ng(reason)` | 検証・評価の判定を保存 |
| `await ctx.result<T>(stepName)` | 同じGoalの成功済み工程の結果を取得 |
| `ctx.env` | D1などのBindings |
| `ctx.feedback` | 改善周回の`iteration`と前回NGの`source`・`reason` |
| `ctx.goalId` / `ctx.stepName` / `ctx.attemptId` | 現在のGoal・工程・実行の識別子 |

入力・結果はJSON互換の値に限る。非有限数値や`undefined`は保存できない。結果が不要なら`ctx.complete(null)`を使う。

## 並列実行と工程間の参照

工程は登録順に進む。並列に実行する工程は`ordo.parallel()`で囲む。
後続工程では、変数や戻り値を共有せず`ctx.result()`で先行工程の結果を取得する。

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

上記は最初の`double`定義を置き換える例。並列グループの全工程が検証・評価まで成功すると後続へ進む。
未完了・失敗した工程の`ctx.result()`はエラーになる。全工程に検証・評価を付けた[example](example/src/index.ts)も参照できる。

## 改善と期限の設定

`configure()`は任意。処理開始前に指定する。

```ts
ordo.configure({ maxIterations: 3, expiresIn: 24 * 60 * 60 * 1000 });
```

- `maxIterations`：初回を含む工程ごとの改善上限。既定は3回。
- `expiresIn`：Goalの受付からの有効期間（ミリ秒）。既定は24時間。設定変更は既存の未完了Goalにも適用する。
- 検証・評価がNGなら、その理由を`ctx.feedback`で受け取り、次の周でrunからやり直す。validateがNGならevaluateは省略する。
- 処理例外はGoalの失敗となり、自動再実行しない。結果の保存後に例外を投げた場合も失敗となる。
- 実行期限は受信から15分。未完了の処理は期限後に再実行されるため、外部への副作用は冪等に扱う。
- Goalの期限切れが確定した後は、設定を延長しても再開しない。

## Workerを配置する

専用Workerに1つのOrdoを配置し、専用のD1とQueueを用意する。
D1のBinding名は`DB`、Queue producerのBinding名は`QUEUE`。同じQueueのconsumerと毎分のCronも設定する。DLQは不要。
[Wranglerの設定例](example/wrangler.example.jsonc)を基に、自分のリソース名・IDを指定する。
`workers_dev: false`・`preview_urls: false`・`routes: []`を維持し、サービスBinding経由で呼び出す。

```sh
npx wrangler types
npx wrangler deploy
```

DBのテーブルは自動作成される。スキーマバージョンが変わる更新では新しい空のテーブルを使用し、旧データや未完了処理は引き継がない。

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

URLのホスト名は通信先を決めない。通信先はサービスBindingで決まる。
POSTは完了を待たずにHTTP 202とGoal IDを返す。各POSTは新しいGoalを作るため、再送で重複起動しないように扱う。
工程の開始・次の改善周回・後続工程への進行には定期起動を待つ。

| メソッド・パス | 応答 |
| --- | --- |
| `POST /_ordo/goals` | `202 { "goalId": 1 }` |
| `GET /_ordo/goals` | Goal ID降順の一覧。実行履歴は含まない |
| `GET /_ordo/goals/:goalId` | 入力・状態・工程別結果・実行履歴 |

`status`は`ready`・`running`・`completed`・`failed`・`expired`。結果は`results`、失敗理由は`error`に入る。
途中・失敗時の結果も表示されるため、採用する前に`completed`を確認する。詳細の`executions`で各段階の履歴を取得できる。
不正なJSON・IDは400、不存在のGoalは404。業務上の失敗でも、取得できればHTTP 200を返す。
