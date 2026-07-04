export type FetchImpl = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface ControlPlaneClientOptions {
  baseUrl: string;
  token: string;
  workspaceId: string;
  fetchImpl?: FetchImpl;
}

export interface CreateEvidenceInput {
  requirementId: string;
  runId?: string;
  kind: string;
  source: string;
  summary: string;
  payload?: unknown;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  assigneeType: string;
  assigneeId: string;
  status?: string;
  priority?: string;
}

export interface RunPatch {
  trigger_run_id?: string;
  status?: "pending" | "running" | "completed" | "failed" | "terminated";
  termination_reason?: string;
  tokens_spent?: number;
  usd_spent?: number;
}

export interface IssueUsage {
  tokens: number;
  usd: number;
}

export interface CommentRecord {
  id: string;
  author_type: string;
  author_id: string;
  content: string;
  type: string;
  created_at: string;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Tolerant usage parser: the endpoint may return {total_tokens, total_cost_usd},
// nested totals, or a list of per-run rows. Extract totals, defaulting to 0.
export function parseUsage(data: unknown): IssueUsage {
  if (Array.isArray(data)) {
    return sumRows(data);
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    const rows = ["items", "runs", "usage", "entries"].find((k) => Array.isArray(o[k]));
    const direct: IssueUsage = {
      tokens: num(o["total_tokens"] ?? o["tokens"] ?? o["totalTokens"]),
      usd: num(o["total_cost_usd"] ?? o["total_usd"] ?? o["usd"] ?? o["cost_usd"] ?? o["totalCostUsd"]),
    };
    // multica /api/issues/{id}/usage splits by direction; budget counts both.
    if (direct.tokens === 0) {
      direct.tokens = num(o["total_input_tokens"]) + num(o["total_output_tokens"]);
    }
    if (direct.tokens === 0 && direct.usd === 0 && o["total"] && typeof o["total"] === "object") {
      return parseUsage(o["total"]);
    }
    if (direct.tokens === 0 && direct.usd === 0 && rows) {
      return sumRows(o[rows] as unknown[]);
    }
    return direct;
  }
  return { tokens: 0, usd: 0 };
}

function sumRows(rows: unknown[]): IssueUsage {
  let tokens = 0;
  let usd = 0;
  for (const r of rows) {
    if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      tokens += num(o["total_tokens"] ?? o["tokens"]);
      usd += num(o["total_cost_usd"] ?? o["cost_usd"] ?? o["usd"]);
    }
  }
  return { tokens, usd };
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly workspaceId: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: ControlPlaneClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.workspaceId = opts.workspaceId;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  }

  static fromEnv(workspaceId: string): ControlPlaneClient {
    return new ControlPlaneClient({
      baseUrl: process.env.RAVEN_API_URL ?? "http://localhost:8080",
      token: process.env.RAVEN_CONTROL_TOKEN ?? "",
      workspaceId,
    });
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "X-Workspace-ID": this.workspaceId,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} failed: ${res.status} ${text}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  transitionRequirement(requirementId: string, toState: string, reason = ""): Promise<unknown> {
    return this.request("POST", `/api/raven/requirements/${requirementId}/transition`, {
      to_state: toState,
      reason,
    });
  }

  updateRun(runId: string, patch: RunPatch): Promise<unknown> {
    return this.request("PATCH", `/api/raven/runs/${runId}`, patch);
  }

  createEvidence(input: CreateEvidenceInput): Promise<unknown> {
    return this.request("POST", "/api/raven/evidence", {
      requirement_id: input.requirementId,
      run_id: input.runId,
      kind: input.kind,
      source: input.source,
      summary: input.summary,
      payload: input.payload,
    });
  }

  createIssue(input: CreateIssueInput): Promise<{ id: string }> {
    return this.request("POST", "/api/issues", {
      title: input.title,
      description: input.description,
      status: input.status ?? "todo",
      priority: input.priority ?? "medium",
      assignee_type: input.assigneeType,
      assignee_id: input.assigneeId,
      // Retries and gate-rejection rework legitimately re-create sub-issues
      // with the same stage title; the duplicate guard must not block them.
      allow_duplicate: true,
    }) as Promise<{ id: string }>;
  }

  getIssue(id: string): Promise<{ id: string; status: string }> {
    return this.request("GET", `/api/issues/${id}`) as Promise<{ id: string; status: string }>;
  }

  async listTaskRuns(issueId: string): Promise<{ id: string; status: string }[]> {
    const data = await this.request("GET", `/api/issues/${issueId}/task-runs`);
    // The endpoint returns a bare array; tolerate wrapped shapes too.
    if (Array.isArray(data)) return data as { id: string; status: string }[];
    if (data && typeof data === "object") {
      const o = data as Record<string, unknown>;
      for (const k of ["tasks", "items", "runs"]) {
        if (Array.isArray(o[k])) return o[k] as { id: string; status: string }[];
      }
    }
    return [];
  }

  async getIssueUsage(issueId: string): Promise<IssueUsage> {
    return parseUsage(await this.request("GET", `/api/issues/${issueId}/usage`));
  }

  createGate(input: {
    requirementId: string;
    runId?: string;
    gateName: string;
    reviewPackage?: unknown;
  }): Promise<{ id: string; status: string }> {
    return this.request("POST", "/api/raven/gates", {
      requirement_id: input.requirementId,
      run_id: input.runId,
      gate_name: input.gateName,
      review_package: input.reviewPackage,
    }) as Promise<{ id: string; status: string }>;
  }

  getGate(id: string): Promise<{ id: string; status: string; decision_reason: string }> {
    return this.request("GET", `/api/raven/gates/${id}`) as Promise<{
      id: string;
      status: string;
      decision_reason: string;
    }>;
  }

  createComment(issueId: string, content: string): Promise<{ id: string }> {
    return this.request("POST", `/api/issues/${issueId}/comments`, {
      content,
    }) as Promise<{ id: string }>;
  }

  async listComments(issueId: string): Promise<CommentRecord[]> {
    const data = await this.request("GET", `/api/issues/${issueId}/comments`);
    if (Array.isArray(data)) return data as CommentRecord[];
    if (data && typeof data === "object") {
      const o = data as Record<string, unknown>;
      for (const k of ["comments", "items", "entries"]) {
        if (Array.isArray(o[k])) return o[k] as CommentRecord[];
      }
    }
    return [];
  }

  async listTimeline(issueId: string): Promise<Record<string, unknown>[]> {
    const data = await this.request("GET", `/api/issues/${issueId}/timeline`);
    if (Array.isArray(data)) return data as Record<string, unknown>[];
    // Some endpoints wrap lists; tolerate {entries: [...]} / {timeline: [...]}.
    if (data && typeof data === "object") {
      const o = data as Record<string, unknown>;
      for (const k of ["entries", "timeline", "items"]) {
        if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
      }
    }
    return [];
  }
}
