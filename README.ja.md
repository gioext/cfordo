# cfordo

## 目的

Cloudflare Workflows・Queues・D1を使い、あらかじめ定義した工程を実行するTypeScriptフレームワーク。
利用者はOrdoを継承したクラスに、接続設定・工程・業務処理を定義する。cfordoがQueueへの配信、完了通知、結果保存、検証・評価、再試行を担当する。

AIによる工程の追加・変更、実行中の工程変更、Cloudflare以外へのデプロイは対象外とする。

## 仕様

### 利用例

```ts
import { Ordo, type OrdoContext } from "cfordo";

export class MyWorkflow extends Ordo<Env> {
  async setup() {
    this.binding({
      db: this.env.DB,
      queue: this.env.JOBS,
      workflow: this.env.FLOW,
    });
    this.configure({
      expiresIn: 24 * 60 * 60 * 1000,
    });
    this.step({
      name: "calculate",
      run: this.double,
      validate: this.validateDouble,
      evaluate: this.evaluateDouble,
    });
  }

  async double(ctx: OrdoContext) {
    const params = ctx.params<{ value: number }>();
    return { value: params.value * 2 };
  }

  async validateDouble(ctx: OrdoContext) {
    if (ctx.result().value < 0) return ctx.ng("結果が負の値になっている");
    return ctx.ok();
  }

  async evaluateDouble(ctx: OrdoContext) {
    // この例の評価は数値比較。AI評価を使う場合はここで実行する。
    if (ctx.result().value !== ctx.params().value * 2) {
      return ctx.ng("入力を2倍した結果と一致しない");
    }
    return ctx.ok();
  }
}

export default MyWorkflow;
```

`Env`にはWranglerが生成するBinding型を使う。業務データの型引数はOrdoに指定しない。
Workflowの公開名をWranglerの`class_name`へ指定する。上例なら`MyWorkflow`を指定する。
名前付きのクラスexportがWorkflowを公開し、default exportがQueue Consumerを公開する。

Workflowの起動は、利用者のHTTP APIやScheduled HandlerなどからWorkflow Bindingの`create()`で行う。
cfordoがCloudflareから受け取る`run(event, step)`を担当するため、利用者は`setup()`と業務メソッドを定義する。

### Honoとの併用

HTTPハンドラーと組み合わせる場合は、最後のdefault exportを置き換える。

```ts
import { Hono } from "hono";
const app = new Hono();

export default {
  fetch: app.fetch,
  queue: MyWorkflow.queue(),
};
```

`MyWorkflow.queue()`はQueue受信用ハンドラーを返す。この呼び出し時点ではインスタンス生成・`setup()`・I/Oを行わない。
Queueイベントを受け取るたびに、その`env`・実行コンテキストで新しいインスタンスを生成する。
Workflow側とQueue側は同じクラスの定義を使用するが、インスタンスや実行中の状態は共有しない。

### 初期化と接続

`setup()`は必須の非同期メソッド。未実装はTypeScriptで検出する。`override`キーワードは不要。
各インスタンスで、最初のWorkflow・Queue処理の前に一度だけ呼ぶ。
クラスのフィールド初期化が済んでから実行するため、`this.env`や利用者のフィールドを参照できる。
同じインスタンスの初期化を同時に要求されても`setup()`を重複実行しない。
初期化に失敗したインスタンスでは処理を開始しない。

`setup()`では、接続・設定・工程の登録を行う。再開や別のQueueイベントでは別インスタンスで再び呼ばれるため、業務上の副作用は`run`などに記述する。

`this.binding()`は必須で、3つの接続をまとめて一度だけ指定する。

| キー       | 必須 | 内容                                       |
| ---------- | ---- | ------------------------------------------ |
| `db`       | 必須 | 状態と結果を保存するD1 Binding             |
| `queue`    | 必須 | 工程の実行要求を送信するQueue Binding      |
| `workflow` | 必須 | 結果保存後に完了通知を送るWorkflow Binding |

3つの指定不足は型で検出する。`binding()`自体の呼び忘れや不正な接続設定も、業務処理開始前にエラーとする。
1つのOrdoで使うQueueと通知先Workflowを指定し、各Stepでbindingを再指定しない。
複数のOrdoを1つのConsumerへ接続する場合は、利用側でQueueごとの受信ハンドラーを選ぶ。

`this.configure()`は任意。次の実行設定を受け取る。

| キー        | 必須 | 内容                                             |
| ----------- | ---- | ------------------------------------------------ |
| `expiresIn` | 任意 | Goalの有効期間。正の整数のミリ秒。省略時は24時間 |

登録時にはDB操作やQueue送信を行わない。`setup()`が正常終了して設定と工程の確認が完了してから開始する。
設定・工程は実行開始後に変更できない。

### 工程

`this.step()`は1つのオブジェクトを受け取り、戻り値は使用しない。

| キー       | 必須 | 内容                                           |
| ---------- | ---- | ---------------------------------------------- |
| `name`     | 必須 | 工程名                                         |
| `run`      | 必須 | 業務処理を行い、結果を返す非同期メソッド・関数 |
| `validate` | 任意 | 業務ルールを検証する非同期メソッド・関数       |
| `evaluate` | 任意 | 結果の妥当性を評価する非同期メソッド・関数     |

渡したメソッドは、そのOrdoインスタンスに結び付けて実行する。利用側で`.bind(this)`を書く必要はない。
`this.env`やクラス内の共通メソッドを、業務処理・検証・評価から利用できる。
同じメソッドを複数Stepで再利用でき、検証・評価はStepごとに指定できる。
Workerの別途登録や、処理名の文字列指定は不要。

通常のStepは登録順に実行する。最後の工程が成功するとGoalが完了する。
`this.parallel()`の非同期コールバック内に登録したStepは並列に実行する。コールバックにも同じインスタンスを結び付ける。

```ts
async setup() {
  this.binding({ db: this.env.DB, queue: this.env.JOBS, workflow: this.env.FLOW });
  this.configure({ expiresIn: 24 * 60 * 60 * 1000 });
  await this.parallel(this.registerParallel);
}

async registerParallel() {
  this.step({ name: "first", run: this.double, validate: this.validateDouble, evaluate: this.evaluateDouble });
  this.step({ name: "second", run: this.double, validate: this.validateDouble, evaluate: this.evaluateDouble });
}
```

全ての並列Stepが成功してから次の工程へ進む。失敗したStepを再実行しても、成功済みの兄弟Stepは再実行しない。
Step名の重複、空の並列工程、並列工程のネストは禁止する。
非同期登録は`setup()`で完了を待つ。Stepがない場合や定義に不備がある場合は、業務処理を開始しない。

### 共通コンテキストと戻り値

業務処理・検証・評価は、全て`OrdoContext`を1つ受け取る。

| API・値           | 内容                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `ctx.params<T>()` | Goalの起動パラメータ。型指定を省略すると`any`                                              |
| `ctx.result<T>()` | 検証・評価対象の業務結果。型指定を省略すると`any`。業務処理中は`undefined`                 |
| `ctx.goalId`      | GoalのID                                                                                   |
| `ctx.stepName`    | 実行している工程名                                                                         |
| `ctx.attemptId`   | 工程起動1回を識別するID                                                                    |
| `ctx.feedback`    | 再実行時のNG理由。`{ source: "validate" または "evaluate", reason: string }`。初回は未設定 |
| `ctx.ok()`        | 検証・評価の成功。引数なし                                                                 |
| `ctx.ng(reason)`  | 検証・評価のNG。空白だけではない理由が必須                                                 |

`params()`・`result()`の型引数は静的な型指定であり、実行時の検証や変換は行わない。
取得したデータを変更しても保存済みの入力・結果は変更されない。
入出力のスキーマや`Input`・`Output`の型定義を要求しない。

`run`は通常の`return`で結果を返す。`ctx.ok(result)`は使用しない。
入力・結果はJSONとして保存可能であることを要求する。結果の`null`は許容するが、戻り値なし・`undefined`・循環参照・非有限数などはエラーとする。
業務データの項目や型は検証しない。出力契約の`output`キーやZod・Standard Schemaとの連携は提供しない。

検証・評価は、渡されたコンテキストの`ctx.ok()`または`ctx.ng(reason)`を返す。
任意のオブジェクト、真偽値、戻り値なし、別の呼び出しで作った判定結果は受け付けない。
不正な戻り値は判定NGではなく、判定関数の例外として扱う。
NG理由は保存され、次の実行の`feedback`へ引き継がれる。
モデル・プロンプト・ツールなどのAI処理は利用側で定義する。

### 実行保証

- 業務処理、指定された検証、指定された評価の順に実行する。
- 結果と判定履歴はD1に保存する。保存に失敗した場合は完了通知しない。
- 保存後の通知に失敗した場合、保存済みの結果を使って再通知する。
- Queue再配信で、保存済みの業務処理・検証を重複実行しない。
- 重複した完了通知で評価や後続工程を二重に実行しない。
- 検証・評価が例外になった場合は、失敗した判定だけを再試行する。
- 判定NGの場合は、理由を渡して同じ工程の業務処理から再実行する。

同じGoal・Step全体で、例外は3回、検証NGは3回、評価NGは10回を上限とする。全て初回を含む固定値。
回数は別々に数え、工程が再起動されてもリセットしない。上限に達するとGoalを失敗終了し、後続工程へ進まない。

Workflowは正常終了時に`completed`、失敗終了時に`failed`、期限切れを確認した場合に`expired`を返す。
`setup()`や設定確認の失敗は、Goal作成前のエラーとする。実行基盤に処理を停止された場合は、戻り値を返せない。
期限はGoal起動時に確定し、再実行で延長しない。完了・失敗したGoalは、期限後もその状態を維持する。
期限切れの判定のためだけにDB更新は行わない。
期限切れを確認した後は新たな工程・再実行・評価を開始しないが、進行中の業務処理を時刻到達時に強制停止する保証はない。

管理用D1は、Workflow・Queue実行時に自動で初期化・更新する。初期化失敗時は業務処理を開始しない。
明示的な初期化には`initOrdo(env.DB)`を使用できる。業務データや外部コンテンツの保存方法は利用側で決める。

## 開発環境

Node.js・pnpmは`mise.toml`のバージョンを使用する。型チェックは`tsrs`、Cloudflare上の動作確認はWranglerとMiniflareを使用する。
利用側のBinding型・ランタイム型は`wrangler types`で生成する。

## 開発方法

```sh
mise install
pnpm install --frozen-lockfile
pnpm format
pnpm check
pnpm build
pnpm --filter @cfordo/example typecheck
```

`pnpm format`は、設定ファイルやプロジェクトの依存を追加せず、`npx`経由でPrettierをデフォルト設定で実行する。`.gitignore`に従い、`example/worker-configuration.d.ts`と`pnpm-lock.yaml`も除外する。
`pnpm test`は、公開APIの型、設定・登録・判定・実行制御・DBのテスト、Workers環境でのWorkflow・Queue・D1・Honoの結合テストを実行する。
Cloudflareへのデプロイや外部AI APIの呼び出しは行わない。
`pnpm build`はESMのJavaScript・型定義・ソースマップを`dist`へ出力する。

## デプロイ方法

npmパッケージの公開権限を持つアカウントで実行する。

```sh
pnpm run deploy
```

公開前に型チェック・テスト・ビルドを実行する。
利用側のWorkerはWranglerでデプロイし、D1・QueueのProducer／Consumer・WorkflowのBindingを設定する。
管理用DBの手動初期化は不要。
