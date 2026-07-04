import type { Contract, ContractBudget } from "./contract";
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
