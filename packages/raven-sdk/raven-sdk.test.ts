import { describe, expect, it } from "vitest";
import type { Contract } from "./src/contract";
import { ControlPlaneClient, type FetchImpl } from "./src/control-client";
import { defineWorkflow } from "./src/define-workflow";
import { BudgetExceededError, parseClarifyQuestions, RunContext, type RunPayload } from "./src/run-context";

// --- fetch mock -------------------------------------------------------------

type Call = { method: string; url: string; body: unknown };

type Responder = (call: Call) => { status?: number; body?: unknown } | undefined;

function makeMock(responder: Responder) {
  const calls: Call[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const call: Call = {
      method: init.method,
      url,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const res = responder(call) ?? {};
    const status = res.status ?? (init.method === "POST" ? 201 : 200);
    return {
      ok: status < 300,
      status,
      text: async () => JSON.stringify(res.body ?? {}),
    };
  };
  return { calls, fetchImpl };
}

function path(url: string): string {
  return url.replace("http://test", "");
}

const baseContract: Contract = {
  stages: [{ name: "clarify" }, { name: "execute" }],
  gates: [{ name: "done-check", after_stage: "execute" }],
  budget: { max_tokens: 1_000_000 },
};

const payload: RunPayload = {
  workspace_id: "ws-1",
  issue_id: "issue-1",
  requirement_id: "req-1",
  run_id: "run-1",
  workflow_name: "test-wf",
  contract: baseContract,
};

function makeClient(fetchImpl: FetchImpl) {
  return new ControlPlaneClient({
    baseUrl: "http://test",
    token: "tok",
    workspaceId: "ws-1",
    fetchImpl,
  });
}

function makeCtx(contract: Contract, client: ControlPlaneClient) {
  return new RunContext({
    payload: { ...payload, contract },
    contract,
    client,
    poll: { intervalMs: 1 },
  });
}

// --- 1. deploy-time contract validation --------------------------------------

describe("defineWorkflow contract validation", () => {
  const run = async () => undefined;

  it("throws when contract has no gates", () => {
    expect(() =>
      defineWorkflow({ name: "x", contract: { ...baseContract, gates: [] }, run }),
    ).toThrow(/gates/);
  });

  it("throws when budget has no positive limit", () => {
    expect(() =>
      defineWorkflow({ name: "x", contract: { ...baseContract, budget: {} }, run }),
    ).toThrow(/budget/);
  });

  it("throws when a gate references an unknown stage", () => {
    expect(() =>
      defineWorkflow({
        name: "x",
        contract: { ...baseContract, gates: [{ name: "g", after_stage: "nope" }] },
        run,
      }),
    ).toThrow(/does not reference a declared stage/);
  });
});

// --- stage() primitive (issue #15) --------------------------------------------

describe("stage() primitive", () => {
  it("reports entered before the body and exited after it", async () => {
    const { calls, fetchImpl } = makeMock(() => ({ body: {} }));
    const ctx = makeCtx(baseContract, makeClient(fetchImpl));

    const result = await ctx.stage("clarify", async () => "spec");

    expect(result).toBe("spec");
    const stageCalls = calls.filter((c) => path(c.url) === "/api/raven/runs/run-1/stage-events");
    expect(stageCalls.map((c) => c.body)).toEqual([
      { stage: "clarify", event: "entered" },
      { stage: "clarify", event: "exited" },
    ]);
  });

  it("does not report exited when the body throws", async () => {
    const { calls, fetchImpl } = makeMock(() => ({ body: {} }));
    const ctx = makeCtx(baseContract, makeClient(fetchImpl));

    await expect(
      ctx.stage("execute", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const stageCalls = calls.filter((c) => path(c.url) === "/api/raven/runs/run-1/stage-events");
    expect(stageCalls.map((c) => c.body)).toEqual([{ stage: "execute", event: "entered" }]);
  });

  it("refuses stages not declared in the contract, without any HTTP call", async () => {
    const { calls, fetchImpl } = makeMock(() => ({ body: {} }));
    const ctx = makeCtx(baseContract, makeClient(fetchImpl));

    await expect(ctx.stage("nope", async () => undefined)).rejects.toThrow(
      /not declared in the workflow contract/,
    );
    expect(calls).toEqual([]);
  });

  it("accepts bare-string stage declarations", async () => {
    const { calls, fetchImpl } = makeMock(() => ({ body: {} }));
    const contract: Contract = { ...baseContract, stages: ["clarify", { name: "execute" }] };
    const ctx = makeCtx(contract, makeClient(fetchImpl));

    await ctx.stage("clarify", async () => undefined);
    expect(calls).toHaveLength(2);
  });
});

// --- 2. happy path ------------------------------------------------------------

describe("workflow handler happy path", () => {
  it("issues the exact ordered API call sequence", async () => {
    const { calls, fetchImpl } = makeMock((call) => {
      const p = path(call.url);
      if (p === "/api/issues" && call.method === "POST") return { body: { id: "sub-1" } };
      if (p === "/api/issues/sub-1/task-runs")
        return { body: { tasks: [{ id: "t1", status: "completed" }] } };
      if (p === "/api/issues/sub-1/usage")
        return { body: { total_tokens: 123, total_cost_usd: 0.5 } };
      if (p === "/api/issues/sub-1/timeline")
        return {
          body: [
            { type: "status_change", content: "x" },
            { type: "comment", content: "agent says hi", actor_type: "agent" },
          ],
        };
      return undefined;
    });
    const client = makeClient(fetchImpl);

    const wf = defineWorkflow({
      name: "happy",
      contract: baseContract,
      run: async (ctx) => {
        await ctx.transition("spec");
        await ctx.transition("ready");
        await ctx.transition("running");
        const res = await ctx.agent({ agentId: "agent-1", title: "t", prompt: "p" });
        expect(res).toEqual({ issueId: "sub-1", output: "agent says hi", tokens: 123, usd: 0.5 });
        await ctx.evidence("note", "done");
        return { ok: true };
      },
    });

    // patch RunContext poll interval via handler: handler builds its own ctx,
    // but the task completes on the first poll, so no waiting happens.
    await wf.handler(payload, client);

    const seq = calls.map((c) => `${c.method} ${path(c.url)}`);
    expect(seq).toEqual([
      "PATCH /api/raven/runs/run-1",
      "POST /api/raven/requirements/req-1/transition",
      "POST /api/raven/requirements/req-1/transition",
      "POST /api/raven/requirements/req-1/transition",
      "POST /api/issues",
      "GET /api/issues/sub-1/task-runs",
      "GET /api/issues/sub-1/usage",
      "GET /api/issues/sub-1/timeline",
      "POST /api/raven/evidence",
      "POST /api/raven/evidence",
      "PATCH /api/raven/runs/run-1",
    ]);

    expect(calls[0]!.body).toMatchObject({ status: "running" });
    expect((calls[1]!.body as { to_state: string }).to_state).toBe("spec");
    expect((calls[2]!.body as { to_state: string }).to_state).toBe("ready");
    expect((calls[3]!.body as { to_state: string }).to_state).toBe("running");
    expect(calls[8]!.body).toMatchObject({ kind: "agent_output", source: "agent()" });
    expect(calls[9]!.body).toMatchObject({ kind: "note" });
    expect(calls[10]!.body).toMatchObject({
      status: "completed",
      tokens_spent: 123,
      usd_spent: 0.5,
    });
  });
});

// --- 3. budget enforcement -----------------------------------------------------

describe("budget enforcement", () => {
  it("terminates the run and blocks further agent dispatch", async () => {
    const contract: Contract = { ...baseContract, budget: { max_tokens: 100 } };
    const { calls, fetchImpl } = makeMock((call) => {
      const p = path(call.url);
      if (p === "/api/issues" && call.method === "POST") return { body: { id: "sub-1" } };
      if (p.endsWith("/task-runs"))
        return { body: { tasks: [{ id: "t1", status: "completed" }] } };
      if (p.endsWith("/usage")) return { body: { total_tokens: 5000, total_cost_usd: 1 } };
      if (p.endsWith("/timeline")) return { body: [] };
      return undefined;
    });
    const client = makeClient(fetchImpl);
    const ctx = makeCtx(contract, client);

    await expect(ctx.agent({ agentId: "a", title: "t", prompt: "p" })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );

    const term = calls.find(
      (c) => c.method === "PATCH" && (c.body as { status?: string })?.status === "terminated",
    );
    expect(term).toBeDefined();
    expect((term!.body as { termination_reason: string }).termination_reason).toContain("budget");

    // A second agent() call must fail pre-flight without dispatching an issue.
    const issuesBefore = calls.filter((c) => path(c.url) === "/api/issues").length;
    await expect(ctx.agent({ agentId: "a", title: "t2", prompt: "p2" })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    const issuesAfter = calls.filter((c) => path(c.url) === "/api/issues").length;
    expect(issuesAfter).toBe(issuesBefore);
  });
});

// --- 4. retry follows declaration only -------------------------------------------

describe("agent retry semantics", () => {
  function retryResponder(results: string[]): { calls: Call[]; fetchImpl: FetchImpl } {
    let issueN = 0;
    return makeMock((call) => {
      const p = path(call.url);
      if (p === "/api/issues" && call.method === "POST") {
        issueN++;
        return { body: { id: `sub-${issueN}` } };
      }
      const m = p.match(/^\/api\/issues\/sub-(\d+)\/task-runs$/);
      if (m) {
        const status = results[Number(m[1]) - 1] ?? "completed";
        return { body: { tasks: [{ id: "t", status }] } };
      }
      if (p.endsWith("/usage")) return { body: { total_tokens: 10, total_cost_usd: 0 } };
      if (p.endsWith("/timeline")) return { body: [{ type: "comment", content: "ok" }] };
      return undefined;
    });
  }

  it("retries once when contract declares max_attempts: 2", async () => {
    const contract: Contract = { ...baseContract, retry: { max_attempts: 2 } };
    const { calls, fetchImpl } = retryResponder(["failed", "completed"]);
    const ctx = makeCtx(contract, makeClient(fetchImpl));

    const res = await ctx.agent({ agentId: "a", title: "t", prompt: "p" });
    expect(res.issueId).toBe("sub-2");
    expect(calls.filter((c) => path(c.url) === "/api/issues").length).toBe(2);
  });

  it("does not retry when no retry is declared", async () => {
    const { calls, fetchImpl } = retryResponder(["failed"]);
    const ctx = makeCtx(baseContract, makeClient(fetchImpl));

    await expect(ctx.agent({ agentId: "a", title: "t", prompt: "p" })).rejects.toThrow(/failed/);
    expect(calls.filter((c) => path(c.url) === "/api/issues").length).toBe(1);
  });
});

// --- 5. gate() primitive ------------------------------------------------------

describe("gate() primitive", () => {
  it("opens a gate, polls until approved, returns the verdict", async () => {
    let polls = 0;
    const { calls, fetchImpl } = makeMock((call) => {
      if (call.method === "POST" && path(call.url) === "/api/raven/gates") {
        return { body: { id: "gate-1", status: "pending" } };
      }
      if (call.method === "GET" && path(call.url) === "/api/raven/gates/gate-1") {
        polls++;
        return polls < 3
          ? { body: { id: "gate-1", status: "pending", decision_reason: "" } }
          : { body: { id: "gate-1", status: "approved", decision_reason: "" } };
      }
      return undefined;
    });
    const ctx = makeCtx(baseContract, makeClient(fetchImpl));
    const result = await ctx.gate("done-check", { summary: "review me" });
    expect(result).toEqual({ gateId: "gate-1", approved: true, reason: "" });
    const create = calls.find((c) => c.method === "POST" && path(c.url) === "/api/raven/gates");
    expect(create?.body).toMatchObject({
      requirement_id: "req-1",
      run_id: "run-1",
      gate_name: "done-check",
      review_package: { summary: "review me" },
    });
    expect(polls).toBe(3);
  });

  it("returns the rejection reason so the script can rework in-run", async () => {
    const { fetchImpl } = makeMock((call) => {
      if (call.method === "POST" && path(call.url) === "/api/raven/gates") {
        return { body: { id: "gate-2", status: "pending" } };
      }
      if (call.method === "GET" && path(call.url) === "/api/raven/gates/gate-2") {
        return { body: { id: "gate-2", status: "rejected", decision_reason: "missing tests" } };
      }
      return undefined;
    });
    const ctx = makeCtx(baseContract, makeClient(fetchImpl));
    const result = await ctx.gate("done-check");
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("missing tests");
  });

  it("refuses gates not declared in the contract, without any HTTP call", async () => {
    const { calls, fetchImpl } = makeMock(() => undefined);
    const ctx = makeCtx(baseContract, makeClient(fetchImpl));
    await expect(ctx.gate("rogue-gate")).rejects.toThrow(/not declared/);
    expect(calls.length).toBe(0);
  });
});

// --- 6. clarify() primitive (issue #19) ---------------------------------------

describe("clarify() primitive", () => {
  const questions = [
    { question: "用哪个鉴权方案？", options: ["JWT", "session"], recommended: "JWT" },
    { question: "要不要兼容旧客户端？", recommended: "不要" },
  ];

  it("posts a question comment, creates the decision point, polls until answered, and posts the answer copy", async () => {
    let polls = 0;
    const { calls, fetchImpl } = makeMock((call) => {
      const p = path(call.url);
      if (p === "/api/issues/issue-1/comments" && call.method === "POST") {
        return { body: { id: `comment-${calls.length}` } };
      }
      if (p === "/api/raven/clarifications" && call.method === "POST") {
        return { body: { id: "clar-1", status: "pending" } };
      }
      if (p === "/api/raven/clarifications/clar-1") {
        polls++;
        return polls < 3
          ? { body: { id: "clar-1", status: "pending", answer: "" } }
          : { body: { id: "clar-1", status: "answered", answer: "JWT；不兼容旧客户端" } };
      }
      return undefined;
    });
    const ctx = makeCtx(baseContract, makeClient(fetchImpl));

    const result = await ctx.clarify({ questions, stage: "clarify" });

    expect(result).toEqual({ clarificationId: "clar-1", answer: "JWT；不兼容旧客户端" });
    const create = calls.find(
      (c) => c.method === "POST" && path(c.url) === "/api/raven/clarifications",
    );
    expect(create?.body).toEqual({
      requirement_id: "req-1",
      run_id: "run-1",
      stage: "clarify",
      questions,
    });
    // Q&A trace: question comment before the decision point, answer copy after.
    const comments = calls.filter(
      (c) => c.method === "POST" && path(c.url) === "/api/issues/issue-1/comments",
    );
    expect(comments).toHaveLength(2);
    expect((comments[0]?.body as { content: string }).content).toContain("用哪个鉴权方案？");
    expect((comments[0]?.body as { content: string }).content).toContain("推荐：JWT");
    expect((comments[1]?.body as { content: string }).content).toContain("JWT；不兼容旧客户端");
    expect(polls).toBe(3);
  });

  it("defaults the stage to the enclosing ctx.stage() scope", async () => {
    const { calls, fetchImpl } = makeMock((call) => {
      const p = path(call.url);
      if (p === "/api/raven/clarifications" && call.method === "POST") {
        return { body: { id: "clar-2", status: "pending" } };
      }
      if (p === "/api/raven/clarifications/clar-2") {
        return { body: { id: "clar-2", status: "answered", answer: "ok" } };
      }
      return { body: { id: "x" } };
    });
    const ctx = makeCtx(baseContract, makeClient(fetchImpl));

    await ctx.stage("clarify", () => ctx.clarify({ questions }));

    const create = calls.find(
      (c) => c.method === "POST" && path(c.url) === "/api/raven/clarifications",
    );
    expect((create?.body as { stage: string }).stage).toBe("clarify");
  });

  it("rejects an empty question list without any HTTP call", async () => {
    const { calls, fetchImpl } = makeMock(() => undefined);
    const ctx = makeCtx(baseContract, makeClient(fetchImpl));
    await expect(ctx.clarify({ questions: [] })).rejects.toThrow(/at least one question/);
    expect(calls).toEqual([]);
  });
});

// --- 7. parseClarifyQuestions --------------------------------------------------

describe("parseClarifyQuestions", () => {
  it("parses a fenced JSON array with options and recommended answers", () => {
    const text = '```json\n[{"question":"Q1","options":["a","b"],"recommended":"a"},{"question":"Q2"}]\n```';
    expect(parseClarifyQuestions(text)).toEqual([
      { question: "Q1", options: ["a", "b"], recommended: "a" },
      { question: "Q2" },
    ]);
  });

  it("wraps non-JSON output as a single free-form question", () => {
    expect(parseClarifyQuestions("1. 先问这个？\n2. 再问那个？")).toEqual([
      { question: "1. 先问这个？\n2. 再问那个？" },
    ]);
  });

  it("wraps malformed entries (no question field) as a single question", () => {
    const text = '[{"recommended":"a"}]';
    expect(parseClarifyQuestions(text)).toEqual([{ question: text }]);
  });
});
