import { Ordo } from "cfordo";

type Params = { value: number };
type Result = { value: number };

export class ExampleWorkflow extends Ordo<Env, Params> {
  async setup() {
    this.configure({ expiresIn: 24 * 60 * 60 * 1000 });
    await this.parallel(async () => {
      this.step<Result>({
        name: "double",
        run: async function (ctx) {
          // この処理の開始時に、D1から読み込まれたGoalの入力。
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
      this.step<Result>({
        name: "square",
        run: async function (ctx) {
          // doubleの変数や戻り値を使わず、同じGoalの入力を取得する。
          const { params } = ctx.input();
          await ctx.complete({ value: params.value ** 2 });
        },
        validate: async function (ctx) {
          const { result } = ctx.input();
          if (Number.isFinite(result.value)) await ctx.ok();
          else await ctx.ng("結果が有限の数値ではありません");
        },
        evaluate: async function (ctx) {
          const { params, result } = ctx.input();
          if (result.value === params.value ** 2) await ctx.ok();
          else await ctx.ng("入力を2乗した結果と一致しません");
        },
      });
    });

    // 先行する2工程の完了を待つ。待ち合わせても結果は引数で渡されない。
    this.step<Result>({
      name: "sum",
      run: async (ctx) => {
        const [double, square] = await Promise.all([
          this.readCompletedValue(ctx.goalId, "double"),
          this.readCompletedValue(ctx.goalId, "square"),
        ]);
        await ctx.complete({ value: double + square });
      },
      validate: async function (ctx) {
        const { result } = ctx.input();
        if (Number.isFinite(result.value)) await ctx.ok();
        else await ctx.ng("結果が有限の数値ではありません");
      },
      evaluate: async (ctx) => {
        // 評価も独立した処理なので、必要な先行工程の結果をD1から読む。
        const [double, square] = await Promise.all([
          this.readCompletedValue(ctx.goalId, "double"),
          this.readCompletedValue(ctx.goalId, "square"),
        ]);
        const { result } = ctx.input();
        if (result.value === double + square) await ctx.ok();
        else await ctx.ng("D1に保存された2工程の結果の和と一致しません");
      },
    });
  }

  private async readCompletedValue(
    goalId: number,
    stepName: "double" | "square",
  ): Promise<number> {
    // sumは先行工程の検証・評価まで成功した後にだけ実行される。
    // 別Goalや再試行前の結果を使わないよう、Goal・工程・最新runを指定する。
    const row = await this.env.DB.prepare(
      `SELECT status, output_json FROM cfordo_attempts
       WHERE goal_id = ? AND step_name = ? AND action = 'run'
       ORDER BY id DESC LIMIT 1`,
    )
      .bind(goalId, stepName)
      .first<{ status: string; output_json: string | null }>();
    if (row?.status !== "completed" || row.output_json === null)
      throw new Error(`${stepName}の完了済み結果がD1にありません`);
    const result = JSON.parse(row.output_json) as Result;
    return result.value;
  }
}

export default ExampleWorkflow.worker();
