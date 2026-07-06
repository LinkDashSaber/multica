import {
  defineWorkflow,
  parseClarifyQuestions,
  type Contract,
  type RunContext,
  type RunPayload,
} from "@multica/raven-sdk";
import { toTriggerTask } from "@multica/raven-sdk/trigger";

// workflow-authoring — 内置的「新建交付策略」策略（issue #24 / ADR-0010）。
//
// 澄清（要解决什么类型的需求 / 阶段划分 / 拍板点位置 / 预算上限）→ agent 起草
// defineWorkflow 文件 → spec-confirm 拍板点确认合同摘要 → agent 提 PR →
// 合并即注册：draft 阶段把合同草稿以 workflow_contract_draft 证据留在控制面，
// 需求进入 Merged 时服务端注册钩子（server/internal/raven/register.go）从
// 证据里读合同并新增/更新注册表——不依赖仓库 webhook 读 PR 文件内容。

/** Evidence kind the merge-registration hook consumes; mirrors Go const. */
export const CONTRACT_DRAFT_EVIDENCE_KIND = "workflow_contract_draft";

/**
 * The agent that runs this authoring pass (issue #26). It comes from the
 * create-strategy composition threaded through the dispatch payload — the
 * strategy's selected (manual) or designated (智能) agent — so each workspace
 * uses its own agent. There is no global RAVEN_DELIVERY_AGENT_ID fallback:
 * a strategy is always created with an agent, and silently falling back to a
 * shared smoke agent is exactly the bug this fixes.
 */
const authoringAgentId = (ctx: RunContext): string => {
  const id = ctx.payload.agent_id ?? "";
  if (!id) {
    throw new Error("workflow-authoring dispatched without an agent_id — a 交付策略 must name its creator agent");
  }
  return id;
};

/**
 * Build the prompt that asks the agent to produce clarification questions for
 * THIS requirement (issue #30). The real title + body are inlined so the
 * questions are grounded in the actual requirement instead of a fixed template
 * — different requirements yield different questions. Falls back to telling the
 * agent to read the issue itself when the text wasn't threaded through.
 */
export function buildClarifyPrompt(payload: RunPayload): string {
  const title = payload.requirement_title?.trim() ?? "";
  const text = payload.requirement_text?.trim() ?? "";
  return [
    `你在为一条「新建交付策略（workflow）」的需求做澄清。父需求 issue ID：${payload.issue_id}。`,
    title ? `## 需求标题\n${title}` : "",
    text ? `## 需求描述\n${text}` : "",
    !title && !text ? "先读取该 issue 的标题与描述，弄清这条策略要处理什么。" : "",
    "基于这条真实需求，提出 2-4 个只有人能拍板、且直接决定这条生产线该如何设计的澄清问题" +
      "（例如：该策略覆盖的交付范围与阶段划分、必须的人工门禁位置、预算/风控红线等），每个问题附一个你推荐的答案。",
    "问题必须针对上面这条具体需求，不要问与它无关的通用模板问题。",
    '只输出一个 JSON 数组，元素形如 {"question": "...", "options": ["..."], "recommended": "..."}（options 可省略），不要寒暄。',
  ]
    .filter(Boolean)
    .join("\n\n");
}

interface WorkflowDraft {
  name: string;
  description: string;
  contract: Contract;
  /** Full TypeScript source of the drafted defineWorkflow file. */
  file: string;
}

/**
 * Extract the draft envelope from the agent's output: the last ```json fenced
 * block (or the whole text) must be {"name", "description", "contract", "file"}.
 * Returns null when the shape is unusable so the caller can re-ask.
 */
export function parseWorkflowDraft(text: string): WorkflowDraft | null {
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const candidate = fences.length > 0 ? fences[fences.length - 1]?.[1] ?? "" : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o["name"] !== "string" || o["name"] === "") return null;
    if (!o["contract"] || typeof o["contract"] !== "object") return null;
    const contract = o["contract"] as Contract;
    if (!Array.isArray(contract.stages) || contract.stages.length === 0) return null;
    if (!Array.isArray(contract.gates) || contract.gates.length === 0) return null;
    return {
      name: o["name"],
      description: typeof o["description"] === "string" ? o["description"] : "",
      contract,
      file: typeof o["file"] === "string" ? o["file"] : "",
    };
  } catch {
    return null;
  }
}

/** Human-readable contract summary shown at the spec-confirm decision point. */
export function formatContractSummary(draft: WorkflowDraft): string {
  const stages = draft.contract.stages
    .map((s) => (typeof s === "string" ? `- ${s}` : `- **${s.name}**${s.description ? `：${s.description}` : ""}`))
    .join("\n");
  const gates = draft.contract.gates
    .map((g) => `- **${g.name}**：位于 ${g.after_stage} 之后`)
    .join("\n");
  const budget: string[] = [];
  if (draft.contract.budget?.max_tokens) budget.push(`Token 上限 ${draft.contract.budget.max_tokens.toLocaleString()}`);
  if (draft.contract.budget?.max_usd) budget.push(`费用上限 $${draft.contract.budget.max_usd}`);
  return [
    `## 交付策略「${draft.name}」合同摘要`,
    draft.description ? `\n${draft.description}\n` : "",
    `### 阶段\n${stages}`,
    `### 门禁\n${gates}`,
    `### 预算\n${budget.length > 0 ? budget.join("，") : "未设置"}`,
  ].join("\n\n");
}

export const workflowAuthoring = defineWorkflow({
  name: "workflow-authoring",
  description:
    "澄清 → 起草 defineWorkflow → spec-confirm 确认合同 → PR → 合并即注册的内置建策略策略。",
  contract: {
    stages: [
      { name: "clarify", description: "追问需求类型、阶段划分、拍板点位置与预算上限" },
      { name: "draft", description: "起草 defineWorkflow 文件并留存合同草稿证据" },
      { name: "pr", description: "提交 workflow 文件 PR，合并后自动注册" },
    ],
    gates: [
      // 唯一人拍板的门禁：合同摘要（阶段/门禁/预算）确认后才允许提 PR。
      { name: "spec-confirm", after_stage: "draft" },
    ],
    budget: { max_tokens: 6_000_000 },
    retry: { max_attempts: 1, timeout_seconds: 3600 },
  },
  run: async (ctx: RunContext) => {
    const agentId = authoringAgentId(ctx);

    // —— clarify：agent 读真实需求后拟澄清问题，人答完才起草 ——
    // issue #30：不再套用与输入无关的固定四问。agent 读需求标题+正文，产出
    // 与这条需求直接相关的澄清点；不同需求得到不同的问题。
    const answered = await ctx.stage("clarify", async () => {
      const asked = await ctx.agent({
        agentId,
        title: "澄清：基于需求拟拍板问题",
        prompt: buildClarifyPrompt(ctx.payload),
      });
      const questions = parseClarifyQuestions(asked.output);
      await ctx.evidence("clarify_questions", "澄清问题清单已产出（基于真实需求）", { questions });
      return ctx.clarify({ questions });
    });

    // —— draft：agent 起草 defineWorkflow 文件 + 合同，草稿以证据留在控制面 ——
    const draftPrompt = (extra: string): string =>
      [
        `你在为平台起草一个新的交付策略（workflow）。父需求 issue ID：${ctx.payload.issue_id}，先读取它的标题与描述了解意图。`,
        `## 人的澄清答复\n${answered.answer}`,
        "参考仓库 https://github.com/LinkDashSaber/multica 的 packages/raven-workflows/src/trigger/feature-delivery.ts，" +
          "用 defineWorkflow 起草一个完整的 TypeScript workflow 文件：contract 里 stages 逐个带中文 description、" +
          "gates 覆盖澄清答复中的拍板点、budget 按答复设上限；run 函数给出各阶段的可运行骨架（agent 调用 + 证据记录）。",
        "workflow 的 name 用小写连字符 slug（不得叫 workflow-authoring）。",
        "回复最后必须附一个 ```json 代码块，内容为：" +
          '{"name": "...", "description": "一句话中文描述", "contract": {…完整合同…}, "file": "完整 TS 文件内容"}。',
        extra,
      ]
        .filter(Boolean)
        .join("\n\n");

    let draft = await ctx.stage("draft", async () => {
      let result = await ctx.agent({ agentId, title: "起草交付策略文件", prompt: draftPrompt("") });
      let parsed = parseWorkflowDraft(result.output);
      // One format retry: never register garbage, never loop forever.
      if (!parsed) {
        result = await ctx.agent({
          agentId,
          title: "重发合同草稿 JSON",
          prompt: draftPrompt("你上一次的回复缺少合法的 JSON 代码块，请只重发那个 ```json 代码块。") +
            `\n\n上次回复：\n${result.output}`,
        });
        parsed = parseWorkflowDraft(result.output);
      }
      if (!parsed) throw new Error("draft stage produced no parsable workflow draft");
      await recordDraft(ctx, parsed);
      return parsed;
    });
    await ctx.transition("spec", "合同草稿已产出");

    // —— spec-confirm 拍板点：人读合同摘要（markdown）后放行；驳回则重拟 ——
    let confirm = await ctx.gate("spec-confirm", {
      summary: formatContractSummary(draft),
      contract: draft.contract,
      name: draft.name,
      description: draft.description,
    });
    while (!confirm.approved) {
      const revised = await ctx.agent({
        agentId,
        title: "按驳回意见修订合同草稿",
        prompt:
          draftPrompt(`上一版草稿被驳回，驳回理由：${confirm.reason}\n\n上一版草稿 JSON：\n${JSON.stringify(
            { name: draft.name, description: draft.description, contract: draft.contract },
            null,
            2,
          )}\n\n请修订并重发完整 JSON 代码块（含 file）。`),
      });
      const parsed = parseWorkflowDraft(revised.output);
      if (!parsed) throw new Error("revision produced no parsable workflow draft");
      draft = parsed;
      await recordDraft(ctx, draft); // latest draft wins at the merge hook
      confirm = await ctx.gate("spec-confirm", {
        summary: formatContractSummary(draft),
        contract: draft.contract,
        name: draft.name,
        description: draft.description,
        revised: true,
      });
    }
    await ctx.transition("ready", "合同已确认");
    await ctx.transition("running", "开始提交 PR");

    // —— pr：agent 落盘并提 PR；Merged 推进与注册由 webhook + 服务端钩子闭环 ——
    await ctx.stage("pr", async () => {
      const result = await ctx.agent({
        agentId,
        title: "提交交付策略 PR",
        prompt: [
          `把以下 workflow 文件写入仓库 https://github.com/LinkDashSaber/multica 的 packages/raven-workflows/src/trigger/${draft.name}.ts。`,
          `父需求 issue ID：${ctx.payload.issue_id}（先读取它拿到 identifier）。`,
          `## 文件内容\n\`\`\`ts\n${draft.file}\n\`\`\``,
          "建分支（分支名含父 issue identifier）、提交、推送并创建 PR，标题注明「新交付策略：" +
            draft.name +
            "」，正文引用父 issue identifier。",
          "最后回复 PR 链接。",
        ].join("\n\n"),
      });
      await ctx.evidence("pr_draft", `交付策略 PR 已提交：${draft.name}`, {
        output: result.output,
      });
      return result;
    });

    // 合并后的 Merged 推进（GitHub webhook）触发注册钩子完成收尾。
    return { ok: true, workflow: draft.name };
  },
});

/** Record the contract draft as the evidence the merge hook reads. */
async function recordDraft(ctx: RunContext, draft: WorkflowDraft): Promise<void> {
  // In manual mode the user's agent/skill picks are authoritative — bake them
  // into the contract so the registered workflow records who runs it (issue
  // #26). In 智能 mode the creator agent decides the team during the run, so we
  // leave whatever composition it drafted (usually none) untouched.
  const composition = ctx.payload.composition;
  if (composition?.mode === "manual") {
    draft.contract.composition = composition;
  }
  await ctx.evidence(
    CONTRACT_DRAFT_EVIDENCE_KIND,
    `交付策略合同草稿：${draft.name}`,
    { name: draft.name, description: draft.description, contract: draft.contract },
  );
}

export const workflowAuthoringTask = toTriggerTask(workflowAuthoring);
