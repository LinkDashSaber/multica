import { describe, it, expect } from "vitest";
import type { RunPayload } from "@multica/raven-sdk";
import { buildClarifyPrompt } from "./workflow-authoring";

function payload(over: Partial<RunPayload>): RunPayload {
  return {
    workspace_id: "ws",
    issue_id: "issue-1",
    requirement_id: "req-1",
    run_id: "run-1",
    workflow_name: "workflow-authoring",
    contract: {
      stages: [{ name: "clarify" }],
      gates: [{ name: "spec-confirm", after_stage: "clarify" }],
      budget: { max_tokens: 1 },
    },
    ...over,
  };
}

describe("buildClarifyPrompt (issue #30)", () => {
  it("grounds the clarify questions in the real requirement — different requirements yield different prompts", () => {
    const hotfix = buildClarifyPrompt(
      payload({ requirement_title: "紧急修复交付", requirement_text: "处理线上崩溃的小步快跑交付" }),
    );
    const docs = buildClarifyPrompt(
      payload({ requirement_title: "文档翻译流水线", requirement_text: "把英文文档批量翻成中文" }),
    );

    // Each prompt carries its own requirement's title + body verbatim.
    expect(hotfix).toContain("紧急修复交付");
    expect(hotfix).toContain("处理线上崩溃的小步快跑交付");
    expect(docs).toContain("文档翻译流水线");
    expect(docs).toContain("把英文文档批量翻成中文");

    // So the two requirements produce genuinely different clarification prompts.
    expect(hotfix).not.toEqual(docs);

    // And the old fixed-template question no longer leaks in.
    expect(hotfix).not.toContain("单次运行的预算上限？");
  });

  it("falls back to asking the agent to read the issue when the text was not threaded through", () => {
    const p = buildClarifyPrompt(payload({}));
    expect(p).toContain("先读取该 issue 的标题与描述");
  });
});
