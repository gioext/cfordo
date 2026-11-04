# cfordo

## 目的

Cloudflare Workflows・Queues・D1で、事前に定義した工程を実行するTypeScriptフレームワーク。
業務処理・検証・評価は独立したQueue処理として実行し、結果・判定・進行状態をD1で管理する。
1 Workerにつき1つのOrdoクラスを定義し、専用のD1・Queue・Workflowを使用する。Honoを組み込んだ内部HTTP APIをサービスBinding経由で呼び出し、起動・一覧・結果取得を行う。公開URLは使用しない。

実行中の工程変更、AIによる工程の追加・変更、Cloudflare以外へのデプロイは対象外とする。

## 仕様

### 利用例

```ts
import { Ordo } from "cfordo";

type Params = { value: number };

export class MyWorkflow extends Ordo<Env, Params> {
  async setup() {
    this.configure({ expiresIn: 24 * 60 * 60 * 1000 });
    this.step<{ value: number }>({
      name: "calculate",
      run: async function (ctx) {
        const { params } = ctx.input();
        await ctx.complete({ value: params.value * 2 });
      },
      validate: async function (ctx) {
        const { result } = ctx.input();
        if (Number.isFinite(result.value)) await ctx.ok();
        else await ctx.ng("結果が有限の数値ではありません");
      },
      evaluate: async function (ctx) {
        const { params, result } = ctx.input();
        if (result.value === params.value * 2) await ctx.ok();
        else await ctx.ng("入力を2倍した結果と一致しません");
      },
    });
  }
}

export default MyWorkflow.worker();
```

`Env`にはWranglerが生成するBinding型を使う。Workflowの名前付きexportをWranglerの`class_name`に指定する。上例では`MyWorkflow`。
`MyWorkflow.worker()`がサービスBinding用のHTTPとQueueの入口を提供する。利用側でHonoや独自の起動ハンドラーを用意する必要はない。

### サービスBinding

Ordo側のWrangler設定は`workers_dev: false`、`preview_urls: false`、`routes: []`とし、公開ルート・カスタムドメインを設定しない。
呼び出し元Workerは次のサービスBindingを持つ。`service`にはデプロイしたOrdo Workerの名前を指定する。

```json
{ "services": [{ "binding": "ORDO", "service": "example-ordo" }] }
```

呼び出し元の`Env`には`ORDO: Fetcher`を定義する。

```ts
const response = await env.ORDO.fetch("https://ordo/_ordo/goals", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ value: 7 }),
});
const { goalId } = await response.json<{ goalId: number }>();
const detail = await env.ORDO.fetch(`https://ordo/_ordo/goals/${goalId}`);
const list = await env.ORDO.fetch("https://ordo/_ordo/goals");
```

`https://ordo`はRequestを組み立てるためのURLで、公開ドメインやDNSの設定は不要。通信先はサービスBindingが決める。

### Goal API

| メソッド・パス             | 入力                   | 応答                                          |
| -------------------------- | ---------------------- | --------------------------------------------- |
| `POST /_ordo/goals`        | 業務入力のJSONそのもの | `202 { "goalId": 1 }`と取得先の`Location`     |
| `GET /_ordo/goals`         | なし                   | 全件をGoal ID降順の配列で返す。ページングなし |
| `GET /_ordo/goals/:goalId` | 正の整数のGoal ID      | 1件の状態・結果・実行履歴                     |

起動時に数値のGoal IDを採番する。Workflowの実行IDとは別のIDで、以後の照会にはGoal IDを使う。
POSTはWorkflowの完了を待たない。再POSTは新しいGoalを作る。複数起動したGoalを定期照会して結果を集約できる。

一覧・詳細の共通フィールドは`goalId`、`input`、`status`、`createdAt`、`expiresAt`、`finishedAt`、`error`、`results`。
`status`は`ready`・`running`・`completed`・`failed`・`expired`。日時はUnix時刻のミリ秒で、完了日時が確定していなければ`finishedAt`は`null`。
`results`は工程ごとの配列で、`stepName`・`status`・`action`・`output`・`validation`・`evaluation`・`error`・`createdAt`・`finishedAt`を返す。
未開始の工程も含む。`action`は実行中または次に実行する処理で、完了時は`null`。工程の状態にも`expired`を使用する。
`output`と検証・評価の判定は同じrunに対応する。再試行前の判定を新しい出力に混ぜない。未保存の結果・未実施の判定は`null`。
途中や失敗した処理の出力も確認できるため、集約への採用は工程の`status`が`completed`になってから行う。

詳細だけは各工程に`executions`を含む。1件がQueue経由の処理1回分で、実行ID昇順。
フィールドは`attemptId`・`action`・`sourceRunId`・`status`・`output`・`verdict`・`error`・`createdAt`・`finishedAt`。
`action`は`run`・`validate`・`evaluate`。`sourceRunId`は検証・評価の対象runのIDで、run自身では`null`。
`verdict`は`{ "ok": true }`または`{ "ok": false, "reason": "..." }`。判定がなければ`null`。
同じQueueメッセージの再配信では履歴を増やさず、業務上の再試行で新しい履歴が増える。

エラーは`{ "code": "...", "message": "..." }`、なければ`null`。
不正なJSON・IDは`400`、不存在は`404`、予期しない障害は`500`、Workflowの起動確認・状態照会の障害は`503`。
HTTPエラーは`{ "error": { "code": "...", "message": "..." } }`。Goal保存後の起動確認に失敗した場合は`goalId`も返す。
この場合、起動済みの可能性があるためGoalを照会する。未開始のままでも受付時の期限で期限切れになる。
業務上の失敗・期限切れでも、照会に成功すればHTTP `200`。基盤の異常終了も照会に反映し、照会障害を業務失敗とは扱わない。

### 初期化・接続・設定

`setup()`は必須の非同期メソッド。未実装は型チェックで検出され、`override`は不要。
クラスのフィールド初期化後、各インスタンスで処理開始前に一度だけ実行する。初期化の同時要求でも重複実行しない。
`setup()`では設定・工程を登録し、業務上の副作用は各actionへ記述する。

Binding名は`DB`（D1）、`QUEUE`（専用Queue）、`WORKFLOW`（同じOrdoクラスのWorkflow）に固定する。
`Env`は公開型`OrdoEnv`を満たす必要がある。業務処理用の追加Bindingは利用できる。

`this.configure()`は任意。

| キー        | 内容                                             |
| ----------- | ------------------------------------------------ |
| `expiresIn` | Goalの有効期間。正の整数のミリ秒。省略時は24時間 |

登録時にはDB操作やQueue送信を行わない。正常に初期化が完了してから開始する。実行開始後の設定・工程変更は禁止する。

### 工程と型

`this.step<Result>()`に、1工程の定義を渡す。

| キー       | 必須 | 内容                                                                       |
| ---------- | ---- | -------------------------------------------------------------------------- |
| `name`     | 必須 | 工程名                                                                     |
| `run`      | 必須 | 業務処理。結果を`await ctx.complete(data)`で保存する                       |
| `validate` | 任意 | 業務ルールの検証。判定を`await ctx.ok()`／`await ctx.ng(reason)`で保存する |
| `evaluate` | 任意 | 妥当性の評価。判定を`await ctx.ok()`／`await ctx.ng(reason)`で保存する     |

全actionは非同期関数で、データをreturnしない。関数が返した値は保存・受け渡し・進行判断に使用しない。
指定されたactionを`run`、`validate`、`evaluate`の順に、別々のQueue処理で実行する。未指定の判定は省略する。
各actionの完了後、D1の記録から次のactionを決める。業務結果・判定をWorkflow stepの戻り値や完了通知のpayloadで受け渡さない。

`Params`はHTTPで受け取る業務入力と各actionの入力の型。WorkflowはOrdoのAPIから起動する。
`Result`は工程ごとの業務結果型で、`ctx.complete()`と検証・評価の入力に反映する。型指定は任意で、省略時は`any`。
これらは静的な型指定であり、実行時の業務スキーマ検証は行わない。ZodやStandard Schemaは要求しない。

登録したメソッドと`parallel()`のコールバックは、Ordoインスタンスに結び付けて実行する。利用者の`.bind(this)`は不要。
同じメソッドを複数工程で再利用できる。Workerの別途登録や、実行する関数の文字列指定は不要。

### 並列実行

通常の工程は登録順に実行する。`this.parallel()`内に登録した工程は並列に進める。

```ts
await this.parallel(async () => {
  this.step<{ value: number }>({
    name: "double",
    run: async function (ctx) {
      await ctx.complete({ value: ctx.input().params.value * 2 });
    },
  });
  this.step<{ value: number }>({
    name: "square",
    run: async function (ctx) {
      await ctx.complete({ value: ctx.input().params.value ** 2 });
    },
  });
});
```

各工程の必要なactionが全て成功してから次の工程群へ進む。成功済みの並列工程は、他の工程の再実行で繰り返さない。
工程名の重複、空の並列グループ、並列グループのネストは禁止する。非同期登録は`setup()`で完了を待つ。

### 入力と保存

全actionの入力は`ctx.input()`で取得する。

| フィールド | 内容                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| `params`   | 起動時にD1へ保存したパラメータ。`Params`型                                        |
| `result`   | 対象の`run`がD1へ保存した結果。検証・評価では`Result`型、`run`実行中は`undefined` |

検証・評価の再試行では、同じ成功済み`run`の結果を参照する。別の実行の「最新結果」へ切り替わることはない。
取得した値を変更しても、保存済みの入力・結果は変更されない。

| API・値                    | 内容                                                     |
| -------------------------- | -------------------------------------------------------- |
| `await ctx.complete(data)` | 業務結果を保存。`run`専用                                |
| `await ctx.ok()`           | OK判定を保存。検証・評価専用。引数なし                   |
| `await ctx.ng(reason)`     | NG判定と理由を保存。検証・評価専用。空白だけの理由は不可 |
| `ctx.goalId`               | GoalのID                                                 |
| `ctx.stepName`             | 工程名                                                   |
| `ctx.attemptId`            | 今回のaction実行を識別するID                             |
| `ctx.feedback`             | 前回のNG判定の`{ source, reason }`。初回は未設定         |

保存APIの戻り値は全て`Promise<void>`で、必ず完了を待つ。同じ実行中のレコードへの上書きは許可する。
保存APIを呼んだだけでは次へ進まず、**必要な結果がD1に保存され、関数が正常終了した後に処理完了を確定・通知する**。
保存後に関数が例外終了した場合、その実行は失敗として扱う。完了確定後の記録は変更しない。

入力・業務結果にはJSONとして保存可能な値を使う。結果が不要な処理は`await ctx.complete(null)`で明示する。
`undefined`、循環参照、非有限数などは保存できない。保存を呼ばずに終了したactionも、共通の例外処理で失敗を記録する。
判定NGは例外ではない。判定を保存して関数が正常終了したactionは完了し、D1のNG判定から業務工程の再実行を決める。

### 再試行・再開・終了

- 例外時は、失敗したactionだけを新しい実行記録で再試行する。
- 検証・評価NG時は、理由を引き継いで新しい`run`から再実行する。
- 同じGoal・工程全体で例外3回、検証NG3回、評価NG10回を上限とする。初回を含む固定値で、再実行しても回数をリセットしない。
- 結果保存済みでも正常終了していないactionを、成功扱いしない。
- 完了・失敗の記録が確定した後のQueue再配信は、actionを繰り返さず再通知する。
- 実行中の所在が不明なactionを推測で再実行しない。途中クラッシュからの厳密な自動復旧は保証せず、基盤の失敗・期限切れとして扱う。

例外は共通処理でD1へ記録する。実行ID・工程・action・時刻と、エラーの種類・内容・取得できるスタックを確認できる。
D1への失敗記録も保存できない場合や通知に失敗した場合は、Queue基盤の再配信に任せる。独自の自動復旧機構は設けない。

1つのWorkflowインスタンスを1つのGoalへ対応付ける。再開時はD1から同じGoalと進行状態を取得する。
同じインスタンスの再起動でも既存の入力・完了状態を維持する。新たな業務実行には、起動APIで新しいGoalを作る。
Workflow stepの戻り値やメモリ上の変数を、再開用の状態として利用しない。

業務上の状態はGoal APIで確認する。Workflowの最終出力に`completed`・`failed`・`expired`は返さない。
Workflow基盤の正常終了と、業務上のGoalの成功は区別する。Goalが業務上失敗しても、制御を正常に終えたWorkflowは基盤上では正常終了になる。

期限はHTTP受付時のGoal作成で確定し、再実行で延長しない。期限切れは保存済みの期限と現在時刻から判定し、そのためだけのDB更新は行わない。
期限切れを確認した後は新たなactionを開始しない。すでに進行中の処理を時刻到達時に強制停止する保証はなく、遅れて保存された結果は履歴として保持する。

管理用D1は処理開始時に自動で初期化・更新する。明示的な初期化には`initOrdo(env.DB)`を使用できる。

## 開発環境

Node.js・pnpmは`mise.toml`のバージョンを使用する。型チェックは`tsrs`を使用する。動作検証はWranglerでデプロイした本番のexampleで行う。
利用側のBinding型・ランタイム型は`wrangler types`で生成する。

## 開発方法

```sh
mise install
pnpm install --frozen-lockfile
pnpm format
pnpm check
```

`pnpm format`は設定ファイルや依存を追加せず、`npx`経由でPrettierのデフォルト設定を使う。`.gitignore`に従い、生成型とロックファイルも除外する。
`pnpm check`はライブラリの型チェック・ビルドと、exampleの型チェックを行う。ローカルの確認だけで動作検証完了とはしない。
動作検証は[exampleの手順](example/README.md)に従い、本番のexampleへサービスBinding経由で接続して行う。
`pnpm build`はESMのJavaScript・型定義・ソースマップを`dist`へ生成する。

## デプロイ方法

npm公開権限を持つアカウントで`pnpm run deploy`を実行する。公開前に`pnpm check`と、本番のexampleでの動作検証を完了する。
専用WorkerをWranglerでデプロイし、固定名のD1・QueueのProducer／Consumer・Workflow Bindingを設定する。
公開URLを無効にし、呼び出し元WorkerのサービスBindingから利用する。exampleの実環境IDはGit管理外のローカル設定へ記入する。

切り替え前に旧WorkflowとQueue処理の終了を確認する。action別の記録を持つ現行DBはそのまま使用できる。
それ以前の一体型実行のDBはリセットが必要。スキーマは初期マイグレーション1つで作成する。
