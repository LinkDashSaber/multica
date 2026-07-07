import { defineWorkflow, parseClarifyQuestions, type RunContext } from "@multica/raven-sdk";
import { toTriggerTask } from "@multica/raven-sdk/trigger";

// prototype-research — 原型研究「发散竞标」策略（父需求 RAV-16）。
//
// 澄清（研究范围/约束/预算/成功标准）→ 3 个 agent 并行发散竞标，各自独立产出
// 一个完整候选方案（轻量调研 + 关键风险验证）→ 评委按四维加权评分 + 一票否决
// 择优 → winner-confirm 人工门禁拍板胜出方案 → 对胜出方案深挖 → 沉淀。
//
// 与 feature-delivery 的区别：这里是「竞标式」而非「协作式」——多个 agent 各产
// 一个完整候选，最后择优 1 个；而不是围绕同一方案分工深挖。

/**
 * 运行本策略的 agent（issue #26 模式）：来自 create-strategy 组合，随派发
 * payload 线程传入。没有全局 env 兜底——一条交付策略必须指名它的执行 agent。
 */
const researchAgentId = (ctx: RunContext): string => {
  const id = ctx.payload.agent_id ?? "";
  if (!id) {
    throw new Error(
      "prototype-research dispatched without an agent_id — a 交付策略 must name its runner agent",
    );
  }
  return id;
};

// 3 路候选（澄清答复：3 个候选）。给每路一个不同的切入视角，逼出真正的发散，
// 而不是三份雷同方案。ponytail: 视角与路数是调参点，路数改动需同步 candidate 标签。
const CANDIDATES: ReadonlyArray<{ label: string; angle: string }> = [
  { label: "A", angle: "以「最快可交付」为先：优先能立刻落地、依赖最少的路线" },
  { label: "B", angle: "以「技术最稳妥」为先：优先成熟方案、把技术风险压到最低" },
  { label: "C", angle: "以「能力上限/最佳体验」为先：优先方案的天花板，容忍更高成本" },
];

// 四维加权评分（澄清答复：可行性/实现成本/技术风险/交付周期加权 + 一票否决）。
// ponytail: 权重是业务调参点，随项目侧重调整；四项之和应为 1。
const SCORE_WEIGHTS = {
  可行性: 0.35,
  实现成本: 0.25,
  技术风险: 0.2,
  交付周期: 0.2,
} as const;

// 竞标至少要有几个存活候选才继续。ponytail: 单个候选 agent 挂掉不该拖垮整场
// 竞标——存活 ≥ 阈值就照常评审；低于阈值说明是系统性问题，直接失败。
const MIN_SURVIVING_CANDIDATES = 2;

interface Candidate {
  label: string;
  angle: string;
  output: string;
}

export const prototypeResearch = defineWorkflow({
  name: "prototype-research",
  description:
    "3 个 agent 并行发散竞标各产一个候选原型方案，评委四维加权评分（含一票否决）后人工拍板择优再深挖的原型研究策略。",
  contract: {
    stages: [
      { name: "clarify", description: "澄清研究范围/约束/预算与成功标准，产出结构化研究简报" },
      {
        name: "explore",
        description:
          "3 个 agent 并行发散竞标，各自独立产出一个完整候选方案（轻量调研 + 关键风险验证，不强制落地完整代码）",
      },
      {
        name: "score",
        description:
          "评委按可行性/实现成本/技术风险/交付周期四维加权评分，对『技术不可实现』或『明显超预算』一票否决，输出排序与推荐理由",
      },
      { name: "deepdive", description: "对人工确认的胜出方案深挖，产出可落地的详细方案与关键风险验证" },
      { name: "learn", description: "复盘本次竞标运行，沉淀可复用心得与 workflow 改进" },
    ],
    gates: [
      // 唯一人工门禁（澄清答复 Q4）：评委给出排序 + 推荐理由后，人工拍板胜出
      // 方案，通过才进入深挖交付——原型选型影响后续投入，值得一个人工确认位。
      { name: "winner-confirm", after_stage: "score" },
    ],
    // 澄清答复：先控成本、轻量调研。3 路并行候选 + 评委 + 深挖，token 上限收在
    // feature-delivery（10M，含落码）之下。ponytail: 预算是调参点。
    budget: { max_tokens: 8_000_000 },
    retry: { max_attempts: 1, timeout_seconds: 3600 },
  },
  run: async (ctx) => {
    const agentId = researchAgentId(ctx);

    // —— clarify：澄清研究范围/约束/预算/成功标准，综合成研究简报 ——
    const brief = await ctx.stage("clarify", async () => {
      const asked = await ctx.agent({
        agentId,
        title: "澄清：原型研究拍板问题",
        prompt: [
          `你在为一条原型研究需求做澄清。父需求 issue ID：${ctx.payload.issue_id}。`,
          "先读取该 issue 的标题、描述与已有评论，弄清要研究什么原型、有哪些硬约束。",
          "然后输出 2-3 个只有人能拍板的问题（研究范围与边界、必须满足的约束、预算/成本红线、成功标准），每个附一个你推荐的答案。",
          '只输出一个 JSON 数组，元素形如 {"question": "...", "options": ["..."], "recommended": "..."}（options 可省略），不要寒暄。',
        ].join("\n"),
      });
      const questions = parseClarifyQuestions(asked.output);
      const answered = await ctx.clarify({ questions });
      await ctx.evidence("clarify", "研究澄清问答完成", {
        questions,
        answer: answered.answer,
      });

      // 综合成结构化研究简报，作为 3 路候选的共同输入基线。
      const briefResult = await ctx.agent({
        agentId,
        title: "产出研究简报",
        prompt: [
          `根据父需求 issue ${ctx.payload.issue_id} 的内容与以下澄清问答，产出一份结构化研究简报，作为多路候选的共同输入。`,
          `## 澄清问题\n${JSON.stringify(questions, null, 2)}`,
          `## 人类回答\n${answered.answer}`,
          "简报格式：研究目标 / 硬约束（含预算与不做的）/ 成功标准（可勾选）/ 已知技术要点与未知风险。",
          "只输出简报本身。",
        ].join("\n\n"),
      });
      await ctx.comment(`【研究简报】\n\n${briefResult.output}`);
      await ctx.evidence("brief", "研究简报已产出", { brief: briefResult.output });
      return briefResult.output;
    });
    await ctx.transition("spec", "研究简报已挂接");
    await ctx.transition("ready", "简报就绪");
    await ctx.transition("running", "3 路候选并行竞标");

    // —— explore：3 个 agent 并行发散竞标，各产一个完整候选方案 ——
    // 竞标要独立并行，故用 Promise.allSettled 各自跑；单个候选挂掉不拖垮全场。
    const candidates = await ctx.stage("explore", async () => {
      const settled = await Promise.allSettled(
        CANDIDATES.map(async ({ label, angle }): Promise<Candidate> => {
          const result = await ctx.agent({
            agentId,
            title: `候选 ${label}：独立原型方案（${angle.split("：")[0]}）`,
            prompt: [
              `你是原型研究竞标中的一路候选（候选 ${label}），要独立产出一个完整的候选原型方案。`,
              `## 你的切入视角\n${angle}`,
              `## 研究简报（共同输入）\n${brief}`,
              "做法：轻量调研（不强制落地完整代码），围绕你的视角给出一个自洽的候选方案，并对最关键的 1-2 个技术风险点做验证（可运行的最小验证/查证据即可）。",
              "输出结构：方案概述 / 关键技术选型与理由 / 实现成本与交付周期评估 / 关键风险点及其验证结论 / 明确的可行性判断。",
              "只输出你这一路的候选方案，不要评判其它候选。",
            ].join("\n\n"),
          });
          await ctx.evidence("candidate", `候选 ${label} 方案已产出`, {
            label,
            angle,
            output: result.output,
          });
          return { label, angle, output: result.output };
        }),
      );

      const survivors = settled
        .filter((s): s is PromiseFulfilledResult<Candidate> => s.status === "fulfilled")
        .map((s) => s.value);
      const failed = settled.filter((s) => s.status === "rejected").length;
      if (failed > 0) {
        await ctx.evidence("candidate", `有 ${failed} 路候选未产出`, { failed, survived: survivors.length });
      }
      if (survivors.length < MIN_SURVIVING_CANDIDATES) {
        throw new Error(
          `explore stage: only ${survivors.length} candidate(s) survived, need ≥ ${MIN_SURVIVING_CANDIDATES}`,
        );
      }
      return survivors;
    });

    // —— score：评委四维加权评分 + 一票否决，输出排序与推荐 ——
    const scorePrompt = (extra: string): string =>
      [
        "你是原型研究竞标的评委，要对以下候选方案打分排序并给出推荐。",
        `## 评分维度与权重（加权求和）\n${JSON.stringify(SCORE_WEIGHTS, null, 2)}`,
        "## 一票否决红线\n出现『技术不可实现』或『明显超预算』的候选，直接淘汰（记 0 分并标注），不参与排序。",
        `## 候选方案\n${candidates
          .map((c) => `### 候选 ${c.label}（${c.angle}）\n${c.output}`)
          .join("\n\n")}`,
        "输出：每个候选的四维分（0-10）与加权总分、是否触发否决、从高到低的排序，以及你推荐胜出的那一个及其理由。",
        extra,
      ]
        .filter(Boolean)
        .join("\n\n");

    const scoreboard = await ctx.stage("score", async () => {
      const judge = await ctx.agent({
        agentId,
        title: "评委：四维加权评分与择优",
        prompt: scorePrompt(""),
      });
      await ctx.comment(`【评分排序与推荐】\n\n${judge.output}`);
      await ctx.evidence("scoreboard", "评委打分排序与推荐理由", { scoreboard: judge.output });
      return judge.output;
    });

    // —— winner-confirm 人工门禁：人读排序 + 理由后拍板；驳回则复评，同 run 循环 ——
    let confirm = await ctx.gate("winner-confirm", {
      scoreboard,
      candidates: candidates.map((c) => ({ label: c.label, angle: c.angle })),
    });
    let currentScoreboard = scoreboard;
    while (!confirm.approved) {
      await ctx.transition("running", `选型驳回，复评：${confirm.reason}`);
      const rejudge = await ctx.agent({
        agentId,
        title: "按驳回意见复评择优",
        prompt: scorePrompt(
          `上一轮排序被驳回，驳回理由：${confirm.reason}\n\n上一轮排序：\n${currentScoreboard}\n\n请据此重新评分排序并给出新的推荐。`,
        ),
      });
      currentScoreboard = rejudge.output;
      await ctx.comment(`【复评排序与推荐】\n\n${currentScoreboard}`);
      await ctx.evidence("scoreboard", "复评打分排序（门禁驳回后）", {
        scoreboard: currentScoreboard,
        rejection_reason: confirm.reason,
      });
      // 人工驳回是强复合信号（ADR-0008）——自报到学习流，fire-and-forget。
      await ctx.learning(`选型门禁驳回后复评。驳回理由：${confirm.reason}`, "score");
      confirm = await ctx.gate("winner-confirm", { scoreboard: currentScoreboard, revised: true });
    }
    // 人工拍板通过：confirm.reason 里通常带着人指定/侧重的胜出方案（可能为空 =
    // 采纳评委排名第一）。deepdive 两种情况都要能吃。
    await ctx.transition("running", "胜出方案已确认，开始深挖");

    // —— deepdive：对人确认的胜出方案深挖，产出可落地的详细方案 ——
    const deepdive = await ctx.stage("deepdive", async () => {
      const result = await ctx.agent({
        agentId,
        title: "深挖胜出方案",
        prompt: [
          "人工已拍板胜出方案，现在对它深挖，产出可落地的详细方案。",
          confirm.reason
            ? `## 人工拍板意见（含选定/侧重）\n${confirm.reason}`
            : "## 人工拍板意见\n未指定具体候选，采纳评委排名第一的方案。",
          `## 评委排序与推荐\n${currentScoreboard}`,
          `## 研究简报\n${brief}`,
          "深挖要点：详细技术方案 / 关键实现步骤（文件/模块级）/ 关键风险的验证与兜底 / 成本与周期的细化估算 / 明确的落地建议。",
          "只输出深挖后的详细方案。",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      await ctx.comment(`【胜出方案深挖】\n\n${result.output}`);
      await ctx.evidence("deepdive", "胜出方案深挖完成", { output: result.output });
      return result.output;
    });

    // —— learn：复盘本次竞标，沉淀心得与 workflow 改进（沉淀钩子②，issue #10）——
    await ctx.stage("learn", async () => {
      const learn = await ctx.agent({
        agentId,
        title: "沉淀：复盘竞标与 workflow 改进",
        prompt: [
          `复盘刚完成的这次 prototype-research 运行（父需求 issue ${ctx.payload.issue_id}，读它的时间线与评论）。`,
          "找出本 workflow 定义（仓库 packages/raven-workflows/src/trigger/prototype-research.ts）中导致摩擦的问题：候选视角是否真发散、评分维度/权重是否合理、门禁位置是否得当、预算是否偏紧或偏松等。",
          "若有实质改进：修改该文件，建分支提交并创建 PR，标题注明「workflow 改进：prototype-research」，正文说明依据的运行事实并引用父 issue；回复 PR 链接。",
          "若无实质改进：不要为改而改，直接回复「无改进意见」加一句原因。",
          "另外：本次运行中若有值得沉淀的心得（可复用的做法、业务事实、踩过的坑），在回复末尾每条单独一行，以「LEARNING: 」开头，一句话一条，没有就不写。",
        ].join("\n"),
      });
      await ctx.evidence("learn", "沉淀阶段完成", { output: learn.output });
      // 把 agent 的 LEARNING: 行转发进学习流（issue #22），各成一条带出处的复合候选。
      for (const line of learn.output.split("\n")) {
        const m = line.match(/^LEARNING:\s*(.+)$/);
        if (m?.[1]) await ctx.learning(m[1].trim());
      }
    });

    return { ok: true, winner: confirm.reason || "评委排名第一", deepdive };
  },
});

export const prototypeResearchTask = toTriggerTask(prototypeResearch);
