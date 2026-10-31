# cfordo example

## 目的

Ordoを継承したクラスから、2つの工程をQueue経由で並列実行するexample。

## 仕様

- 入力は`{ "value": 7 }`のような数値を持つJSON。
- `double`は入力を2倍、`square`は入力を2乗する。
- 2つのStepを`parallel()`で実行し、両方の完了後にGoalが完了する。
- Workerの出力はD1に保存され、Workflowの戻り値は`completed`・`failed`・`expired`。
- HTTP APIや外部AI APIは使用しない。評価は数値比較の利用例。
- `setup()`内で接続・設定・工程を登録し、同じクラスをWorkflowとQueue Consumerとして公開する。
- `ctx.params()`・`ctx.result()`でデータを取得し、検証・評価は`ctx.ok()`・`ctx.ng(reason)`を返す。

| リソース | 名前 |
|---|---|
| Worker | `example-ordo` |
| D1 | `example-ordo-db` |
| Workflow | `example-ordo-workflow` |
| Queue | `example-ordo-queue` |

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
pnpm --filter @cfordo/example dev
```

DBの初期化とマイグレーションは、Ordoが実行開始時に自動で行う。初期化コマンドの実行は不要。

別のターミナルから、ローカルのWorkflowを起動・確認する。

```sh
pnpm --filter @cfordo/example exec wrangler workflows trigger example-ordo-workflow '{"value":7}' --local
pnpm --filter @cfordo/example exec wrangler workflows instances describe example-ordo-workflow latest --local
```

## デプロイ方法

```sh
pnpm --filter @cfordo/example run deploy
pnpm --filter @cfordo/example exec wrangler workflows trigger example-ordo-workflow '{"value":7}'
pnpm --filter @cfordo/example exec wrangler workflows instances describe example-ordo-workflow latest
```

Workerのデプロイ時にWorkflowとQueue Consumerを設定する。`workers.dev`とプレビューURLは公開しない。

保存された出力はD1で確認できる。

```sh
pnpm --filter @cfordo/example exec wrangler d1 execute example-ordo-db --remote --command "SELECT goal_id,step_name,status,output_json FROM cfordo_attempts ORDER BY id"
```
