import { defineWorkflow, type RunContext } from "@multica/raven-sdk";
import { toTriggerTask } from "@multica/raven-sdk/trigger";

// clarification — 交付前澄清策略，沉淀自 RAV-4（issue bdfc4941-dd41-4a5d-a829-fb71c6586b9f
// 「澄清：提出拍板问题」，源需求 RAV-3 fb50055f）。
//
// 那次交付的实际经过只有一条主线：读父需求 + 翻相关代码做功课 → 产出 2-3 个
// 「只有人能拍板」的问题（每个附推荐答案）→ 评论区抛给人 → 人挑答案。
// 全流程唯一需要人拍板的点，就是最后那一下：人从推荐答案里确认/改写。
//
// 与 feature-delivery 的区别：这里不落地、不提 PR，产物是「已被人拍板的澄清结论」，
// 通常作为 feature-delivery 的前置。所以只有一个 gate：human-decision。

const clarifyAgentId = (): string => {
  const id = process.env.RAVEN_DELIVERY_AGENT_ID ?? "";
  if (!id) throw new Error("RAVEN_DELIVERY_AGENT_ID is not set");
  return id;
};

export const clarification = defineWorkflow({
  name: "clarification",
  description:
    "研究 → 拟拍板问题 → 抛给人 → human-decision 门禁的交付前澄清策略。",
  contract: {
    stages: [
      // 读父需求（标题/描述/评论）并检查相关代码模块，做足功课。
      { name: "research", description: "读父需求 + 相关代码做功课" },
      // 产出 2-3 个真正需要人拍板的问题，每个附推荐答案；评论区抛给人。
      { name: "draft-questions", description: "拟拍板问题 + 推荐答案并抛出" },
    ],
    gates: [
      // 唯一人拍板点：人从推荐答案里确认或改写，产出最终澄清结论。
      { name: "human-decision", after_stage: "draft-questions" },
    ],
    // 单趟澄清，无落地无 PR，预算远小于 feature-delivery。
    budget: { max_tokens: 3_000_000 },
    retry: { max_attempts: 1, timeout_seconds: 1800 },
  },
  run: async (ctx: RunContext) => {
    const agentId = clarifyAgentId();

    // —— research + draft-questions：一个 agent 调用同时做功课并产出问题清单 ——
    // （沉淀自 RAV-4：homework 与拟题在同一步完成，不额外拆分。）
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
    await ctx.evidence("draft_questions", "拍板问题清单已产出", {
      questions: clarify.output,
    });

    // —— 抛给人 + human-decision 门禁：人回复即拍板；驳回则按理由重拟 ——
    const question = await ctx.comment(
      `【澄清】请回答以下拍板问题（直接回复本评论即可）：\n\n${clarify.output}`,
    );
    const answer = await ctx.waitForHumanComment(question.id);

    let decision = await ctx.gate("human-decision", {
      questions: clarify.output,
      answer: answer.content,
    });
    let questions = clarify.output;
    while (!decision.approved) {
      const revised = await ctx.agent({
        agentId,
        title: "按驳回意见重拟拍板问题",
        prompt: `以下拍板问题清单被驳回，驳回理由：${decision.reason}\n\n原清单：\n${questions}\n\n请按理由重拟并输出完整新清单（仍每题附推荐答案）。`,
      });
      questions = revised.output;
      const reask = await ctx.comment(`【澄清 · 重拟】\n\n${questions}`);
      const reanswer = await ctx.waitForHumanComment(reask.id);
      await ctx.evidence("draft_questions", "拍板问题重拟（门禁驳回后）", {
        questions,
        rejection_reason: decision.reason,
      });
      decision = await ctx.gate("human-decision", {
        questions,
        answer: reanswer.content,
        revised: true,
      });
    }

    // 产物：已被人拍板的澄清结论，通常作为 feature-delivery 的输入。
    await ctx.evidence("clarify", "澄清问答完成", {
      questions,
      answer: answer.content,
    });
    return { ok: true };
  },
});

export const clarificationTask = toTriggerTask(clarification);
