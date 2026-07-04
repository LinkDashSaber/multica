import { defineWorkflow } from "@multica/raven-sdk";
import { toTriggerTask } from "@multica/raven-sdk/trigger";

export const helloWorkflow = defineWorkflow({
  name: "hello-workflow",
  description: "Smoke-test workflow for the Raven control plane.",
  contract: {
    stages: [{ name: "clarify" }, { name: "execute" }],
    gates: [{ name: "done-check", after_stage: "execute" }],
    budget: { max_tokens: 2_000_000 },
  },
  run: async (ctx) => {
    await ctx.transition("spec");
    await ctx.transition("ready");
    await ctx.transition("running");

    const agentId = process.env.RAVEN_HELLO_AGENT_ID;
    if (agentId) {
      await ctx.agent({
        agentId,
        title: "hello-workflow 子任务",
        prompt: "请回复一句话确认你收到了 hello-workflow 的任务。",
      });
    } else {
      await ctx.evidence(
        "note",
        "hello-workflow ran without a real agent (RAVEN_HELLO_AGENT_ID unset)",
      );
    }

    await ctx.evidence("note", "hello-workflow finished");
    return { ok: true };
  },
});

export const helloWorkflowTask = toTriggerTask(helloWorkflow);
