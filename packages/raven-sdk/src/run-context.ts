import { stageName, type Contract, type ContractBudget } from "./contract";
import type { ControlPlaneClient, IssueUsage } from "./control-client";

export interface RunPayload {
  workspace_id: string;
  issue_id: string;
  requirement_id: string;
  run_id: string;
  workflow_name: string;
  contract: Contract;
}

export class BudgetExceededError extends Error {
  readonly spentTokens: number;
  readonly spentUsd: number;
  readonly budget: ContractBudget;

  constructor(message: string, info: { spentTokens: number; spentUsd: number; budget: ContractBudget }) {
    super(message);
    this.name = "BudgetExceededError";
    this.spentTokens = info.spentTokens;
    this.spentUsd = info.spentUsd;
    this.budget = info.budget;
  }
}

export interface GateResult {
  gateId: string;
  approved: boolean;
  reason: string;
}

export class GateRejectedError extends Error {
  readonly gate: GateResult;
  constructor(gate: GateResult) {
    super(`gate "${gate.gateId}" rejected: ${gate.reason}`);
    this.name = "GateRejectedError";
    this.gate = gate;
  }
}

export interface ClarifyQuestion {
  question: string;
  options?: string[];
  recommended?: string;
}

export interface ClarifyInput {
  questions: ClarifyQuestion[];
  /** Contract stage the run is suspended at; defaults to the enclosing ctx.stage(). */
  stage?: string;
}

export interface ClarifyResult {
  clarificationId: string;
  answer: string;
}

/**
 * Parse an agent's question-list output into ClarifyQuestion[]. Accepts a
 * JSON array (optionally inside ```json fences); anything else becomes a
 * single free-form question so the flow never blocks on format drift.
 */
export function parseClarifyQuestions(text: string): ClarifyQuestion[] {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(stripped.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        const questions = parsed
          .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
          .filter((q) => typeof q["question"] === "string" && q["question"] !== "")
          .map((q) => {
            const item: ClarifyQuestion = { question: q["question"] as string };
            if (Array.isArray(q["options"])) {
              item.options = q["options"].filter((o): o is string => typeof o === "string");
            }
            if (typeof q["recommended"] === "string") item.recommended = q["recommended"];
            return item;
          });
        if (questions.length > 0) return questions;
      }
    } catch {
      // fall through to the single-question wrapper
    }
  }
  return [{ question: text.trim() }];
}

function formatClarifyComment(questions: ClarifyQuestion[]): string {
  const lines = questions.map((q, i) => {
    const parts = [`${i + 1}. ${q.question}`];
    if (q.options && q.options.length > 0) parts.push(`   - 选项：${q.options.join(" / ")}`);
    if (q.recommended) parts.push(`   - 推荐：${q.recommended}`);
    return parts.join("\n");
  });
  return `【澄清】以下问题等待拍板（在拍板点答复即可）：\n\n${lines.join("\n")}`;
}

export interface AgentCallInput {
  agentId: string;
  title: string;
  prompt: string;
}

export interface AgentCallResult {
  issueId: string;
  output: string;
  tokens: number;
  usd: number;
}

const TERMINAL_OK = "completed";
const TERMINAL_BAD = new Set(["failed", "cancelled"]);

export class RunContext {
  readonly payload: RunPayload;
  readonly contract: Contract;
  readonly client: ControlPlaneClient;
  spentTokens = 0;
  spentUsd = 0;
  /** Name of the ctx.stage() scope currently executing, "" outside any. */
  private currentStage = "";
  private readonly intervalMs: number;
  private readonly timeoutMs: number;

  constructor(opts: {
    payload: RunPayload;
    contract: Contract;
    client: ControlPlaneClient;
    poll?: { intervalMs?: number; timeoutMs?: number };
  }) {
    this.payload = opts.payload;
    this.contract = opts.contract;
    this.client = opts.client;
    this.intervalMs = opts.poll?.intervalMs ?? 3000;
    // Timeout comes ONLY from the contract declaration (default 1800s).
    this.timeoutMs =
      opts.poll?.timeoutMs ?? (this.contract.retry?.timeout_seconds ?? 1800) * 1000;
  }

  async transition(toState: string, reason = ""): Promise<unknown> {
    return this.client.transitionRequirement(this.payload.requirement_id, toState, reason);
  }

  async evidence(
    kind: string,
    summary: string,
    payload?: unknown,
    source = "evidence()",
  ): Promise<unknown> {
    return this.client.createEvidence({
      requirementId: this.payload.requirement_id,
      runId: this.payload.run_id,
      kind,
      source,
      summary,
      payload,
    });
  }

  /**
   * stage() — explicit stage scope (issue #15). Reports "entered" to the
   * control plane, runs the body, and reports "exited" on success. A body
   * failure propagates without an exited event, so the stream shows exactly
   * where the run died. The name must be declared in the contract.
   */
  async stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!this.contract.stages.some((s) => stageName(s) === name)) {
      throw new Error(`stage "${name}" is not declared in the workflow contract`);
    }
    await this.client.reportRunStageEvent(this.payload.run_id, name, "entered");
    this.currentStage = name;
    const result = await fn();
    await this.client.reportRunStageEvent(this.payload.run_id, name, "exited");
    this.currentStage = "";
    return result;
  }

  /**
   * learning() — execution self-report (issue #22, ADR-0008 主进料口).
   * Records a compounding-candidate insight with run + stage provenance
   * (defaults to the enclosing stage() scope). Fire-and-forget by design:
   * a failed report must never break workflow execution, so errors are
   * swallowed.
   */
  async learning(text: string, stage?: string): Promise<void> {
    try {
      await this.client.createLearning({
        runId: this.payload.run_id,
        stage: stage ?? this.currentStage,
        content: text,
      });
    } catch {
      // Best-effort reporting; execution goes on.
    }
  }

  /**
   * gate() — suspend the run at a contract-declared gate until a human
   * decides. The gate name must be declared in the contract (checked here
   * AND server-side). Returns the verdict; the script decides how to react
   * (typically: rejected → transition back to running and rework in the
   * same run). Gates have no timeout — a run legitimately waits on humans
   * (self-hosted trigger.dev holds the worker; known ADR-0002 trade-off).
   */
  async gate(gateName: string, reviewPackage?: unknown): Promise<GateResult> {
    if (!this.contract.gates.some((g) => g.name === gateName)) {
      throw new Error(`gate "${gateName}" is not declared in the workflow contract`);
    }
    const created = await this.client.createGate({
      requirementId: this.payload.requirement_id,
      runId: this.payload.run_id,
      gateName,
      reviewPackage,
    });
    for (;;) {
      const gate = await this.client.getGate(created.id);
      if (gate.status === "approved") {
        return { gateId: created.id, approved: true, reason: gate.decision_reason ?? "" };
      }
      if (gate.status === "rejected") {
        return { gateId: created.id, approved: false, reason: gate.decision_reason ?? "" };
      }
      await new Promise((r) => setTimeout(r, this.intervalMs));
    }
  }

  /** Post a comment on the requirement's parent issue (clarify Q&A copies live there). */
  async comment(content: string): Promise<{ id: string }> {
    return this.client.createComment(this.payload.issue_id, content);
  }

  /**
   * clarify() — suspend the run on a clarification decision point (issue #19)
   * until a human answers via the decision-points API. Writes a Q&A trace to
   * the issue comments (questions on ask, answer on resolve) but the comment
   * thread no longer drives the flow. Like gate(), waiting on humans has no
   * timeout.
   */
  async clarify(input: ClarifyInput): Promise<ClarifyResult> {
    if (!input.questions || input.questions.length === 0) {
      throw new Error("clarify() needs at least one question");
    }
    const stage = input.stage ?? this.currentStage;
    await this.comment(formatClarifyComment(input.questions));
    const created = await this.client.createClarification({
      requirementId: this.payload.requirement_id,
      runId: this.payload.run_id,
      stage,
      questions: input.questions,
    });
    for (;;) {
      const c = await this.client.getClarification(created.id);
      if (c.status === "answered") {
        await this.comment(`【澄清答复】\n\n${c.answer ?? ""}`);
        return { clarificationId: created.id, answer: c.answer ?? "" };
      }
      await new Promise((r) => setTimeout(r, this.intervalMs));
    }
  }

  async agent(input: AgentCallInput): Promise<AgentCallResult> {
    // Pre-flight budget check: never dispatch a new agent while over budget.
    await this.enforceBudget();

    // Attempts come ONLY from the contract; default 1 = no retry. The
    // execution layer must never add retries beyond the declaration.
    const maxAttempts = Math.max(1, this.contract.retry?.max_attempts ?? 1);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.runAgentOnce(input);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async runAgentOnce(input: AgentCallInput): Promise<AgentCallResult> {
    const issue = await this.client.createIssue({
      title: input.title,
      description: input.prompt,
      assigneeType: "agent",
      assigneeId: input.agentId,
    });
    const subIssueId = issue.id;

    await this.waitForTask(subIssueId);

    const usage = await this.client.getIssueUsage(subIssueId);
    await this.charge(usage);

    const output = await this.lastComment(subIssueId);

    await this.client.createEvidence({
      requirementId: this.payload.requirement_id,
      runId: this.payload.run_id,
      kind: "agent_output",
      source: "agent()",
      summary: output.slice(0, 200),
      payload: {
        sub_issue_id: subIssueId,
        agent_id: input.agentId,
        output,
        tokens: usage.tokens,
        usd: usage.usd,
      },
    });

    return { issueId: subIssueId, output, tokens: usage.tokens, usd: usage.usd };
  }

  private async waitForTask(subIssueId: string): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const tasks = await this.client.listTaskRuns(subIssueId);
      if (tasks.some((t) => t.status === TERMINAL_OK)) return;
      const bad = tasks.find((t) => TERMINAL_BAD.has(t.status));
      if (bad) {
        throw new Error(`agent task for issue ${subIssueId} ended with status "${bad.status}"`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `agent task for issue ${subIssueId} timed out after ${this.timeoutMs}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, this.intervalMs));
    }
  }

  private async lastComment(issueId: string): Promise<string> {
    const entries = await this.client.listTimeline(issueId);
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e && e["type"] === "comment" && typeof e["content"] === "string") {
        return e["content"];
      }
    }
    return "";
  }

  private async charge(usage: IssueUsage): Promise<void> {
    this.spentTokens += usage.tokens;
    this.spentUsd += usage.usd;
    await this.enforceBudget();
  }

  private async enforceBudget(): Promise<void> {
    const { max_tokens = 0, max_usd = 0 } = this.contract.budget ?? {};
    const overTokens = max_tokens > 0 && this.spentTokens > max_tokens;
    const overUsd = max_usd > 0 && this.spentUsd > max_usd;
    if (!overTokens && !overUsd) return;

    const reason = overTokens
      ? `budget exceeded: ${this.spentTokens} tokens spent > max_tokens ${max_tokens}`
      : `budget exceeded: $${this.spentUsd} spent > max_usd ${max_usd}`;
    await this.client.updateRun(this.payload.run_id, {
      status: "terminated",
      termination_reason: reason,
      tokens_spent: this.spentTokens,
      usd_spent: this.spentUsd,
    });
    throw new BudgetExceededError(reason, {
      spentTokens: this.spentTokens,
      spentUsd: this.spentUsd,
      budget: this.contract.budget,
    });
  }
}
