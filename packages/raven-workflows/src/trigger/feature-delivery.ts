import { defineWorkflow, type RunContext } from "@multica/raven-sdk";
import { toTriggerTask } from "@multica/raven-sdk/trigger";

// feature-delivery — the first production workflow (issue #7).
//
// 澄清 (clarify in issue comments) → Spec → spec-confirm gate (Ready 门禁)
// → plan → execute → self-check → PR → human-review gate.
//
// The Merged transition is NOT performed here: the GitHub webhook loop
// (issue #6) advances the lifecycle when the PR actually merges.

const deliveryAgentId = (): string => {
  const id = process.env.RAVEN_DELIVERY_AGENT_ID ?? "";
  if (!id) throw new Error("RAVEN_DELIVERY_AGENT_ID is not set");
  return id;
};

async function clarifyAndSpec(ctx: RunContext): Promise<string> {
  const agentId = deliveryAgentId();

  const clarify = await ctx.agent({
    agentId,
    title: "澄清：提出拍板问题",
    prompt: [
      `你在为一条需求做交付前澄清。父需求 issue ID：${ctx.payload.issue_id}。`,
      "先读取该 issue 的标题、描述和已有评论，再检查代码库里相关的模块，做足功课。",
      "然后输出 2-3 个真正需要人拍板的问题（不是能自己查代码回答的问题），",
      "每个问题附上你推荐的答案。只输出问题清单本身，不要寒暄。",
    ].join("\n"),
  });

  const question = await ctx.comment(
    `【澄清】请回答以下拍板问题（直接回复本评论即可）：\n\n${clarify.output}`,
  );
  const answer = await ctx.waitForHumanComment(question.id);
  await ctx.evidence("clarify", "澄清问答完成", {
    questions: clarify.output,
    answer: answer.content,
  });

  const spec = await ctx.agent({
    agentId,
    title: "产出结构化 Spec",
    prompt: [
      `根据父需求 issue ${ctx.payload.issue_id} 的内容、以下澄清问答，产出结构化 Spec：`,
      `## 澄清问题\n${clarify.output}`,
      `## 人类回答\n${answer.content}`,
      "Spec 格式：目标 / 范围（含明确不做的）/ 验收标准（可勾选清单）/ 技术要点。",
      "只输出 Spec 本身。",
    ].join("\n\n"),
  });
  await ctx.comment(`【Spec】\n\n${spec.output}`);
  await ctx.evidence("spec", "结构化 Spec 已产出", { spec: spec.output });
  return spec.output;
}

export const featureDelivery = defineWorkflow({
  name: "feature-delivery",
  description:
    "澄清 → Spec 门禁 → 计划 → 执行 → 自验 → PR → 人审门禁的标准功能交付策略。",
  contract: {
    stages: [
      { name: "clarify" },
      { name: "plan" },
      { name: "execute" },
      { name: "self-check" },
      { name: "pr" },
      { name: "learn" },
    ],
    gates: [
      { name: "spec-confirm", after_stage: "clarify" },
      { name: "human-review", after_stage: "pr" },
    ],
    budget: { max_tokens: 10_000_000 },
    retry: { max_attempts: 1, timeout_seconds: 3600 },
  },
  run: async (ctx) => {
    const agentId = deliveryAgentId();

    // —— clarify：评论区问答产出 Spec，过 spec-confirm 门禁才允许 Ready ——
    let spec = await clarifyAndSpec(ctx);
    await ctx.transition("spec", "澄清完成，Spec 已挂接");

    let confirm = await ctx.gate("spec-confirm", { spec });
    while (!confirm.approved) {
      const revised = await ctx.agent({
        agentId,
        title: "按驳回意见修订 Spec",
        prompt: `以下 Spec 被驳回，驳回理由：${confirm.reason}\n\n原 Spec：\n${spec}\n\n请修订并输出完整新 Spec。`,
      });
      spec = revised.output;
      await ctx.comment(`【Spec 修订】\n\n${spec}`);
      await ctx.evidence("spec", "Spec 修订（门禁驳回后）", {
        spec,
        rejection_reason: confirm.reason,
      });
      confirm = await ctx.gate("spec-confirm", { spec, revised: true });
    }
    await ctx.transition("ready", "Spec 已确认");
    await ctx.transition("running", "开始执行");

    // —— plan ——
    const plan = await ctx.agent({
      agentId,
      title: "制定实现计划",
      prompt: `按以下已确认 Spec 制定实现计划（文件级步骤 + 验证方式），只输出计划：\n\n${spec}`,
    });
    await ctx.evidence("plan", "实现计划", { plan: plan.output });

    // —— execute：实现并提 PR，分支/标题引用父 issue identifier 以便自动关联 ——
    const execution = await ctx.agent({
      agentId,
      title: "执行实现并提交 PR",
      prompt: [
        `按 Spec 与计划完成实现。父需求 issue ID：${ctx.payload.issue_id}（先读取它拿到 identifier）。`,
        `## Spec\n${spec}`,
        `## 计划\n${plan.output}`,
        "完成后：建分支（分支名含父 issue identifier）、提交、推送并创建 PR，PR 标题或正文引用父 issue identifier。",
        "最后回复 PR 链接与改动摘要。",
      ].join("\n\n"),
    });
    await ctx.evidence("execution", "实现完成", { output: execution.output });

    // —— self-check ——
    const check = await ctx.agent({
      agentId,
      title: "自验",
      prompt: `对刚完成的实现做自验：跑相关测试/typecheck/lint，核对 Spec 验收标准逐项是否满足。输出结构化自验报告（每项 通过/不通过 + 证据）。\n\nSpec：\n${spec}`,
    });
    await ctx.evidence("self_check", "自验报告", { report: check.output });

    // —— human review：驳回则回到 running 返工，同一 run 内循环 ——
    let review = await ctx.gate("human-review", {
      spec,
      plan: plan.output,
      execution: execution.output,
      self_check: check.output,
    });
    while (!review.approved) {
      await ctx.transition("running", `人审驳回，返工：${review.reason}`);
      const rework = await ctx.agent({
        agentId,
        title: "按人审意见返工",
        prompt: `人审驳回理由：${review.reason}\n\n请在原分支上修复并更新 PR，完成后回复修复摘要。`,
      });
      await ctx.evidence("execution", "返工完成", {
        output: rework.output,
        rejection_reason: review.reason,
      });
      review = await ctx.gate("human-review", { rework: rework.output });
    }
    // —— learn（沉淀钩子 ②，issue #10）：复盘本次 run，对 workflow 本身提改进。
    // 有实质改进 → 以 PR 形式产出（关联 workflow 版本）；没有 → 只留证据。
    const learn = await ctx.agent({
      agentId,
      title: "沉淀：workflow 自我改进",
      prompt: [
        `复盘刚完成的这次 feature-delivery 运行（父需求 issue ${ctx.payload.issue_id}，读它的时间线与评论）。`,
        "找出本 workflow 定义（仓库 packages/raven-workflows/src/trigger/feature-delivery.ts）中导致摩擦的问题：提示词歧义、阶段缺失/冗余、门禁位置不当等。",
        "若有实质改进：修改该文件，建分支提交并创建 PR，标题注明「workflow 改进：feature-delivery」，正文说明依据的运行事实并引用父 issue；回复 PR 链接。",
        "若无实质改进：不要为改而改，直接回复「无改进意见」加一句原因。",
      ].join("\n"),
    });
    await ctx.evidence("learn", "沉淀阶段完成", { output: learn.output });

    // 合并后的 Merged 推进由 GitHub webhook 闭环完成。
    return { ok: true };
  },
});

export const featureDeliveryTask = toTriggerTask(featureDelivery);
