import { describe, expect, it } from "vitest";
import {
  AppConfigSchema,
  DashboardAgentRunTimeListSchema,
  DashboardUsageByAgentListSchema,
  DashboardUsageDailyListSchema,
  CreateFeedbackResponseSchema,
  DuplicateIssueErrorBodySchema,
  EMPTY_CREATE_FEEDBACK_RESPONSE,
  EMPTY_INBOX_UNREAD_SUMMARY,
  EMPTY_RAVEN_EVIDENCE_LIST,
  EMPTY_RAVEN_COMPOSITION,
  RavenCompositionSchema,
  EMPTY_RAVEN_CLARIFY_QUESTIONS,
  RavenClarifyQuestionsSchema,
  parseClarifyQuestions,
  findComposition,
  EMPTY_RAVEN_GATE_REVIEW,
  EMPTY_RAVEN_GATE_REVIEW_LIST,
  EMPTY_RAVEN_WORKFLOW_STATS_LIST,
  RavenClarificationSchema,
  EMPTY_RAVEN_CLARIFICATION,
  RavenDecisionPointListSchema,
  EMPTY_RAVEN_DECISION_POINT_LIST,
  EMPTY_USER,
  InboxUnreadSummarySchema,
  EMPTY_RAVEN_RUN_LIST,
  RavenRunSchema,
  EMPTY_RAVEN_RUN,
  RavenClarificationListSchema,
  EMPTY_RAVEN_CLARIFICATION_LIST,
  EMPTY_RAVEN_STAGE_EVENT_LIST,
  RavenEvidenceListSchema,
  RavenGateReviewListSchema,
  RavenGateReviewSchema,
  RavenGatePolicyListSchema,
  EMPTY_RAVEN_GATE_POLICY_LIST,
  RavenPromotionSchema,
  EMPTY_RAVEN_PROMOTION,
  RavenRunListSchema,
  RavenStageEventListSchema,
  RavenWorkflowStatsListSchema,
  RavenLearningSchema,
  RavenLearningListSchema,
  EMPTY_RAVEN_LEARNING,
  EMPTY_RAVEN_LEARNING_LIST,
  IssueTriggerPreviewSchema,
  ListIssuesResponseSchema,
  RuntimeHourlyActivityListSchema,
  RuntimeUsageByAgentListSchema,
  RuntimeUsageByHourListSchema,
  RuntimeUsageListSchema,
  SquadListSchema,
  SquadSchema,
  TimelineEntriesSchema,
  UserSchema,
} from "./schemas";
import { parseWithFallback } from "./schema";

const baseIssue = {
  id: "11111111-1111-1111-1111-111111111111",
  workspace_id: "ws-1",
  number: 1,
  identifier: "MUL-1",
  title: "Test",
  description: null,
  status: "todo",
  priority: "medium",
  assignee_type: null,
  assignee_id: null,
  creator_type: "member",
  creator_id: "user-1",
  parent_issue_id: null,
  project_id: null,
  position: 0,
  stage: null,
  start_date: null,
  due_date: null,
  metadata: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("IssueSchema (via ListIssuesResponseSchema)", () => {
  it("accepts a primitive metadata KV map", () => {
    const payload = {
      issues: [
        {
          ...baseIssue,
          metadata: { pipeline_status: "waiting", pr_number: 3, is_blocked: true },
        },
      ],
      total: 1,
    };
    const parsed = ListIssuesResponseSchema.parse(payload);
    expect(parsed.issues[0]?.metadata).toEqual({
      pipeline_status: "waiting",
      pr_number: 3,
      is_blocked: true,
    });
  });

  it("defaults metadata to {} when the server omits it (older backend)", () => {
    const { metadata: _omit, ...issueWithoutMetadata } = baseIssue;
    const payload = { issues: [issueWithoutMetadata], total: 1 };
    const parsed = ListIssuesResponseSchema.parse(payload);
    expect(parsed.issues[0]?.metadata).toEqual({});
  });

  it("rejects metadata with non-primitive values (nested object)", () => {
    const payload = {
      issues: [{ ...baseIssue, metadata: { nested: { x: 1 } } }],
      total: 1,
    };
    expect(ListIssuesResponseSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts a numeric stage", () => {
    const payload = { issues: [{ ...baseIssue, stage: 2 }], total: 1 };
    const parsed = ListIssuesResponseSchema.parse(payload);
    expect(parsed.issues[0]?.stage).toBe(2);
  });

  it("defaults stage to null when the server omits it (older backend)", () => {
    const { stage: _omit, ...issueWithoutStage } = baseIssue;
    const payload = { issues: [issueWithoutStage], total: 1 };
    const parsed = ListIssuesResponseSchema.parse(payload);
    expect(parsed.issues[0]?.stage).toBeNull();
  });
});

// POST /api/issues/preview-trigger feeds this schema through parseWithFallback
// in client.previewIssueTrigger with fallback { triggers: [], total_count: 0 }
// (MUL-3375). The four entry points read it to decide "will this start a run",
// so malformed / missing / null drift must degrade to "nothing will start"
// rather than throw into the picker/modal.
const PREVIEW_FALLBACK = { triggers: [], total_count: 0 };
const PREVIEW_ENDPOINT = { endpoint: "POST /api/issues/preview-trigger" };

describe("IssueTriggerPreviewSchema", () => {
  it("parses a well-formed response", () => {
    const parsed = IssueTriggerPreviewSchema.parse({
      triggers: [
        { issue_id: "i1", agent_id: "a1", source: "assign", handoff_supported: true },
        { issue_id: "i2", agent_id: "a2", source: "status", handoff_supported: false },
      ],
      total_count: 2,
    });
    expect(parsed.total_count).toBe(2);
    expect(parsed.triggers).toHaveLength(2);
    expect(parsed.triggers[0]).toMatchObject({ issue_id: "i1", agent_id: "a1", source: "assign", handoff_supported: true });
  });

  it("defaults missing top-level fields (empty / older backend)", () => {
    const parsed = IssueTriggerPreviewSchema.parse({});
    expect(parsed.triggers).toEqual([]);
    expect(parsed.total_count).toBe(0);
  });

  it("defaults missing optional item fields, keeping required issue_id", () => {
    const parsed = IssueTriggerPreviewSchema.parse({ triggers: [{ issue_id: "i1" }], total_count: 1 });
    expect(parsed.triggers[0]).toEqual({
      issue_id: "i1",
      agent_id: "",
      source: "",
      handoff_supported: false,
    });
  });

  it("parseWithFallback returns the fallback for a malformed shape (triggers not an array)", () => {
    const parsed = parseWithFallback(
      { triggers: "nope", total_count: 1 },
      IssueTriggerPreviewSchema,
      PREVIEW_FALLBACK,
      PREVIEW_ENDPOINT,
    );
    expect(parsed).toEqual(PREVIEW_FALLBACK);
  });

  it("parseWithFallback returns the fallback when an item drops the required issue_id", () => {
    const parsed = parseWithFallback(
      { triggers: [{ agent_id: "a1", source: "assign" }], total_count: 1 },
      IssueTriggerPreviewSchema,
      PREVIEW_FALLBACK,
      PREVIEW_ENDPOINT,
    );
    expect(parsed).toEqual(PREVIEW_FALLBACK);
  });

  it("parseWithFallback returns the fallback for a wrong-typed total_count", () => {
    const parsed = parseWithFallback(
      { triggers: [], total_count: "5" },
      IssueTriggerPreviewSchema,
      PREVIEW_FALLBACK,
      PREVIEW_ENDPOINT,
    );
    expect(parsed).toEqual(PREVIEW_FALLBACK);
  });

  it("parseWithFallback returns the fallback for null / non-object bodies", () => {
    expect(parseWithFallback(null, IssueTriggerPreviewSchema, PREVIEW_FALLBACK, PREVIEW_ENDPOINT)).toEqual(PREVIEW_FALLBACK);
    expect(parseWithFallback("oops", IssueTriggerPreviewSchema, PREVIEW_FALLBACK, PREVIEW_ENDPOINT)).toEqual(PREVIEW_FALLBACK);
  });
});

describe("TimelineEntriesSchema", () => {
  it("preserves source_task_id for agent failure comments", () => {
    const parsed = TimelineEntriesSchema.parse([
      {
        type: "comment",
        id: "comment-1",
        actor_type: "agent",
        actor_id: "agent-1",
        created_at: "2026-01-01T00:00:00Z",
        content: "API Error: 500 Internal server error",
        comment_type: "system",
        source_task_id: "task-1",
      },
    ]);

    expect(parsed[0]?.source_task_id).toBe("task-1");
  });
});

describe("CreateFeedbackResponseSchema", () => {
  const ENDPOINT = { endpoint: "POST /api/feedback" };

  it("parses a well-formed response and preserves extra fields", () => {
    const parsed = parseWithFallback(
      { id: "feedback-1", created_at: "2026-06-26T00:00:00Z", future_field: true },
      CreateFeedbackResponseSchema,
      EMPTY_CREATE_FEEDBACK_RESPONSE,
      ENDPOINT,
    );
    expect(parsed).toMatchObject({
      id: "feedback-1",
      created_at: "2026-06-26T00:00:00Z",
      future_field: true,
    });
  });

  it("returns the empty fallback for malformed feedback responses", () => {
    expect(
      parseWithFallback(
        { id: 123, created_at: "2026-06-26T00:00:00Z" },
        CreateFeedbackResponseSchema,
        EMPTY_CREATE_FEEDBACK_RESPONSE,
        ENDPOINT,
      ),
    ).toBe(EMPTY_CREATE_FEEDBACK_RESPONSE);
    expect(
      parseWithFallback(null, CreateFeedbackResponseSchema, EMPTY_CREATE_FEEDBACK_RESPONSE, ENDPOINT),
    ).toBe(EMPTY_CREATE_FEEDBACK_RESPONSE);
  });
});

// The duplicate-issue branch in create-issue.tsx feeds ApiError.body
// (typed as `unknown`) through this schema. Any future server drift that
// loses the contract MUST fail the parse so the UI falls back to a normal
// error toast instead of rendering an empty / partial duplicate card.
describe("DuplicateIssueErrorBodySchema", () => {
  const valid = {
    code: "active_duplicate_issue",
    error: "An active issue with this title already exists: MUL-12 – Login bug",
    issue: {
      id: "11111111-1111-1111-1111-111111111111",
      identifier: "MUL-12",
      title: "Login bug",
    },
  };

  it("accepts a well-formed body", () => {
    expect(DuplicateIssueErrorBodySchema.safeParse(valid).success).toBe(true);
  });

  it("accepts unknown extra fields via .loose()", () => {
    const forwardCompat = {
      ...valid,
      hint: "Try a different title",
      issue: { ...valid.issue, workspace_id: "ws-1", status: "todo" },
    };
    expect(DuplicateIssueErrorBodySchema.safeParse(forwardCompat).success).toBe(true);
  });

  it("rejects a renamed code (so renames degrade to the generic toast)", () => {
    const renamed = { ...valid, code: "duplicate_issue" };
    expect(DuplicateIssueErrorBodySchema.safeParse(renamed).success).toBe(false);
  });

  it("rejects a missing issue object", () => {
    const { issue: _omit, ...without } = valid;
    expect(DuplicateIssueErrorBodySchema.safeParse(without).success).toBe(false);
  });

  it("rejects a non-string issue.id", () => {
    const broken = { ...valid, issue: { ...valid.issue, id: 42 } };
    expect(DuplicateIssueErrorBodySchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a missing error field (it is optional)", () => {
    const { error: _omit, ...without } = valid;
    expect(DuplicateIssueErrorBodySchema.safeParse(without).success).toBe(true);
  });
});

// `user.timezone` (Viewing tz) was added in the timezone-architecture RFC.
// A desktop build older than the server — or a server predating the
// `user.timezone` migration — will return a `/api/me` body with no
// `timezone` key. The schema must not fail closed on that: the field
// defaults to `null`, which the frontend resolves to the browser-detected
// tz at render time.
describe("UserSchema timezone drift", () => {
  const base = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Ada",
    email: "ada@example.com",
  };

  it("defaults timezone to null when the field is absent", () => {
    const parsed = UserSchema.parse(base);
    expect(parsed.timezone).toBe(null);
  });

  it("preserves an explicit IANA timezone", () => {
    const parsed = UserSchema.parse({ ...base, timezone: "Asia/Tokyo" });
    expect(parsed.timezone).toBe("Asia/Tokyo");
  });

  it("accepts an explicit null timezone", () => {
    const parsed = UserSchema.parse({ ...base, timezone: null });
    expect(parsed.timezone).toBe(null);
  });

  // Wrong-type drift: a future server bug sending `timezone` as a number
  // must not throw into the UI. parseWithFallback degrades the whole user
  // object to the explicit fallback (EMPTY_USER) so /api/me callers keep a
  // valid shape instead of white-screening.
  it("falls back to EMPTY_USER when timezone is the wrong type", () => {
    const parsed = parseWithFallback(
      { ...base, timezone: 42 },
      UserSchema,
      EMPTY_USER,
      { endpoint: "GET /api/me" },
    );
    expect(parsed).toBe(EMPTY_USER);
  });
});

describe("SquadListSchema member preview drift", () => {
  const baseSquad = {
    id: "squad-1",
    workspace_id: "ws-1",
    name: "Frontend Squad",
    description: "",
    instructions: "",
    avatar_url: null,
    leader_id: "agent-1",
    creator_id: "user-1",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    archived_at: null,
    archived_by: null,
  };

  it("defaults preview fields when an older backend omits them", () => {
    const parsed = SquadListSchema.parse([baseSquad]);
    expect(parsed[0]?.member_count).toBe(0);
    expect(parsed[0]?.member_preview).toEqual([]);
  });

  it("defaults preview fields on a single squad response", () => {
    const parsed = SquadSchema.parse(baseSquad);
    expect(parsed.member_count).toBe(0);
    expect(parsed.member_preview).toEqual([]);
  });

  it("preserves lightweight member preview rows", () => {
    const parsed = SquadListSchema.parse([
      {
        ...baseSquad,
        member_count: 2,
        member_preview: [
          { member_type: "agent", member_id: "agent-1", role: "leader" },
          { member_type: "member", member_id: "user-2", role: "member" },
        ],
      },
    ]);
    expect(parsed[0]?.member_count).toBe(2);
    expect(parsed[0]?.member_preview).toHaveLength(2);
    expect(parsed[0]?.member_preview?.[0]?.role).toBe("leader");
  });
});

// The workspace dashboard and runtime-detail pages were re-pointed at the
// unified `task_usage_hourly` rollup. Every numeric field drives chart /
// KPI math, and string keys (date / agent_id / model) bucket the series.
// The contract these schemas must hold: a row missing a field degrades
// that field to a sane default rather than dropping the WHOLE array to
// the `[]` fallback — one drifted row must not blank the entire chart.
describe("dashboard + runtime usage schema drift", () => {
  it("coerces a missing numeric field to 0 instead of dropping the array", () => {
    const parsed = DashboardUsageDailyListSchema.parse([
      { date: "2026-05-19", model: "claude-opus-4-7", input_tokens: 100 },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.output_tokens).toBe(0);
    expect(parsed[0]?.cache_read_tokens).toBe(0);
    expect(parsed[0]?.cache_write_tokens).toBe(0);
  });

  it("coerces a missing date key to \"\" so the rest of the series survives", () => {
    const parsed = DashboardUsageDailyListSchema.parse([
      { model: "claude-opus-4-7", input_tokens: 5 },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.date).toBe("");
  });

  it("coerces a missing agent_id key to \"\" for the agent-runtime panel", () => {
    const parsed = DashboardAgentRunTimeListSchema.parse([
      { total_seconds: 42, task_count: 3, failed_count: 0 },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.agent_id).toBe("");
  });

  it("coerces a missing agent_id key to \"\" for the usage-by-agent panel", () => {
    const parsed = DashboardUsageByAgentListSchema.parse([
      { model: "claude-opus-4-7", input_tokens: 7 },
    ]);
    expect(parsed[0]?.agent_id).toBe("");
  });

  it("coerces missing fields on every runtime usage schema", () => {
    expect(RuntimeUsageListSchema.parse([{ date: "2026-05-19" }])[0]?.input_tokens).toBe(0);
    expect(RuntimeHourlyActivityListSchema.parse([{ hour: 9 }])[0]?.count).toBe(0);
    expect(RuntimeUsageByAgentListSchema.parse([{ model: "x" }])[0]?.agent_id).toBe("");
    expect(RuntimeUsageByHourListSchema.parse([{ hour: 9 }])[0]?.model).toBe("");
  });

  it("defaults a missing provider to \"\" so an older server's rows still price by bare model", () => {
    // provider was added for cross-provider model disambiguation; a server
    // predating it omits the field. The schema must fill "" (→ bare-model
    // pricing lookup) rather than drop the row.
    expect(
      DashboardUsageDailyListSchema.parse([{ date: "2026-05-19", model: "claude-opus-4-7" }])[0]
        ?.provider,
    ).toBe("");
    expect(
      DashboardUsageByAgentListSchema.parse([{ model: "claude-opus-4-7" }])[0]?.provider,
    ).toBe("");
    expect(RuntimeUsageByAgentListSchema.parse([{ model: "x" }])[0]?.provider).toBe("");
  });

  it("rejects a non-array body so parseWithFallback can return its fallback", () => {
    expect(DashboardUsageDailyListSchema.safeParse(null).success).toBe(false);
    expect(RuntimeUsageListSchema.safeParse({ rows: [] }).success).toBe(false);
  });

  it("keeps unknown server-side fields via .loose()", () => {
    const parsed = RuntimeUsageListSchema.parse([
      { date: "2026-05-19", region: "us-east" },
    ]);
    expect((parsed[0] as Record<string, unknown>).region).toBe("us-east");
  });
});

describe("AppConfigSchema cdn_signed drift", () => {
  it("defaults cdn_signed to false when the server omits it (pre-MUL-3254 servers)", () => {
    const parsed = AppConfigSchema.parse({ cdn_domain: "cdn.example.com" });
    expect(parsed.cdn_signed).toBe(false);
  });

  it("coerces a malformed cdn_signed to false instead of failing the whole config", () => {
    const parsed = AppConfigSchema.parse({
      cdn_domain: "cdn.example.com",
      cdn_signed: "yes",
    });
    expect(parsed.cdn_signed).toBe(false);
    expect(parsed.cdn_domain).toBe("cdn.example.com");
  });

  it("keeps cdn_signed=true from a signing-enabled server", () => {
    const parsed = AppConfigSchema.parse({ cdn_signed: true });
    expect(parsed.cdn_signed).toBe(true);
  });

  it("parses frontend feature flag decisions", () => {
    const parsed = AppConfigSchema.parse({
      feature_flags: {
        composio_mcp_apps: true,
        malformed_future_flag: "yes",
      },
    });
    expect(parsed.feature_flags).toEqual({
      composio_mcp_apps: true,
      malformed_future_flag: false,
    });
  });

  it("defaults malformed feature_flags to an empty object", () => {
    const parsed = AppConfigSchema.parse({ feature_flags: ["not", "an", "object"] });
    expect(parsed.feature_flags).toEqual({});
  });
});

describe("InboxUnreadSummarySchema", () => {
  const ENDPOINT = { endpoint: "GET /api/inbox/unread-summary" };

  it("parses a well-formed summary and tolerates extra fields", () => {
    const parsed = parseWithFallback(
      [
        { workspace_id: "ws-1", count: 2 },
        { workspace_id: "ws-2", count: 0, future_field: "ignored" },
      ],
      InboxUnreadSummarySchema,
      EMPTY_INBOX_UNREAD_SUMMARY,
      ENDPOINT,
    );
    expect(parsed).toEqual([
      { workspace_id: "ws-1", count: 2 },
      { workspace_id: "ws-2", count: 0, future_field: "ignored" },
    ]);
  });

  it("returns the empty fallback (dot hidden) for a non-array body", () => {
    expect(
      parseWithFallback({ rows: [] }, InboxUnreadSummarySchema, EMPTY_INBOX_UNREAD_SUMMARY, ENDPOINT),
    ).toBe(EMPTY_INBOX_UNREAD_SUMMARY);
    expect(
      parseWithFallback(null, InboxUnreadSummarySchema, EMPTY_INBOX_UNREAD_SUMMARY, ENDPOINT),
    ).toBe(EMPTY_INBOX_UNREAD_SUMMARY);
  });

  it("returns the empty fallback when an entry has a wrong-typed count", () => {
    expect(
      parseWithFallback(
        [{ workspace_id: "ws-1", count: "lots" }],
        InboxUnreadSummarySchema,
        EMPTY_INBOX_UNREAD_SUMMARY,
        ENDPOINT,
      ),
    ).toBe(EMPTY_INBOX_UNREAD_SUMMARY);
  });
});

describe("RavenGateReviewSchema / RavenGateReviewListSchema", () => {
  const ENDPOINT = { endpoint: "GET /api/raven/gates/{id}" };

  const baseGate = {
    id: "22222222-2222-2222-2222-222222222222",
    workspace_id: "ws-1",
    requirement_id: "33333333-3333-3333-3333-333333333333",
    run_id: null,
    gate_name: "review",
    status: "pending",
    review_package: { summary: "looks good", diff_stats: { files: 3 } },
    decided_by: null,
    decision_reason: "",
    created_at: "2026-01-01T00:00:00Z",
    decided_at: null,
  };

  it("parses a pending gate and passes unknown fields through", () => {
    const parsed = parseWithFallback(
      { ...baseGate, future_field: "kept" },
      RavenGateReviewSchema,
      EMPTY_RAVEN_GATE_REVIEW,
      ENDPOINT,
    );
    expect(parsed.id).toBe(baseGate.id);
    expect(parsed.status).toBe("pending");
    expect(parsed.review_package).toEqual(baseGate.review_package);
    expect((parsed as unknown as Record<string, unknown>).future_field).toBe("kept");
  });

  it("defaults omitted optional fields instead of failing the parse", () => {
    const parsed = parseWithFallback(
      { id: "g-1" },
      RavenGateReviewSchema,
      EMPTY_RAVEN_GATE_REVIEW,
      ENDPOINT,
    );
    expect(parsed.status).toBe("pending");
    expect(parsed.decided_by).toBeNull();
    expect(parsed.decision_reason).toBe("");
  });

  it("returns the fallback for a malformed body", () => {
    expect(
      parseWithFallback(null, RavenGateReviewSchema, EMPTY_RAVEN_GATE_REVIEW, ENDPOINT),
    ).toBe(EMPTY_RAVEN_GATE_REVIEW);
  });

  it("parses the list wrapper and defaults gates to []", () => {
    const parsed = parseWithFallback(
      { gates: [baseGate], total: 1 },
      RavenGateReviewListSchema,
      EMPTY_RAVEN_GATE_REVIEW_LIST,
      { endpoint: "GET /api/raven/gates" },
    );
    expect(parsed.gates).toHaveLength(1);
    expect(parsed.total).toBe(1);

    const empty = parseWithFallback(
      {},
      RavenGateReviewListSchema,
      EMPTY_RAVEN_GATE_REVIEW_LIST,
      { endpoint: "GET /api/raven/gates" },
    );
    expect(empty.gates).toEqual([]);
  });
});

describe("RavenClarificationSchema / RavenDecisionPointListSchema", () => {
  const ENDPOINT = { endpoint: "GET /api/raven/clarifications/{id}" };

  const baseClarification = {
    id: "44444444-4444-4444-4444-444444444444",
    workspace_id: "ws-1",
    requirement_id: "33333333-3333-3333-3333-333333333333",
    run_id: "55555555-5555-5555-5555-555555555555",
    stage: "clarify",
    questions: [{ question: "Which auth scheme?", options: ["JWT"], recommended: "JWT" }],
    status: "pending",
    answer: "",
    answered_by: null,
    created_at: "2026-01-01T00:00:00Z",
    answered_at: null,
  };

  it("parses a pending clarification and passes unknown fields through", () => {
    const parsed = parseWithFallback(
      { ...baseClarification, future_field: "kept" },
      RavenClarificationSchema,
      EMPTY_RAVEN_CLARIFICATION,
      ENDPOINT,
    );
    expect(parsed.id).toBe(baseClarification.id);
    expect(parsed.stage).toBe("clarify");
    expect(parsed.questions).toEqual(baseClarification.questions);
    expect((parsed as unknown as Record<string, unknown>).future_field).toBe("kept");
  });

  it("defaults omitted optional fields instead of failing the parse", () => {
    const parsed = parseWithFallback(
      { id: "c-1" },
      RavenClarificationSchema,
      EMPTY_RAVEN_CLARIFICATION,
      ENDPOINT,
    );
    expect(parsed.status).toBe("pending");
    expect(parsed.answer).toBe("");
    expect(parsed.answered_by).toBeNull();
  });

  it("returns the fallback for a malformed body", () => {
    expect(
      parseWithFallback(null, RavenClarificationSchema, EMPTY_RAVEN_CLARIFICATION, ENDPOINT),
    ).toBe(EMPTY_RAVEN_CLARIFICATION);
  });

  it("parses the mixed decision-point queue with both kinds", () => {
    const parsed = parseWithFallback(
      {
        items: [
          {
            kind: "gate",
            id: "g-1",
            requirement_id: "r-1",
            run_id: null,
            stage: "self-check",
            title: "human-review",
            context: { summary: "all green" },
            response_kind: "approve_reject",
            status: "pending",
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            kind: "clarify",
            id: "c-1",
            requirement_id: "r-1",
            run_id: "run-1",
            stage: "clarify",
            title: "",
            context: { questions: baseClarification.questions },
            response_kind: "answer",
            status: "pending",
            created_at: "2026-01-02T00:00:00Z",
          },
        ],
        total: 2,
      },
      RavenDecisionPointListSchema,
      EMPTY_RAVEN_DECISION_POINT_LIST,
      { endpoint: "GET /api/raven/decision-points" },
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.response_kind).toBe("approve_reject");
    expect(parsed.items[1]?.kind).toBe("clarify");
  });

  it("returns the fallback for a malformed decision-point body and defaults items to []", () => {
    expect(
      parseWithFallback("nope", RavenDecisionPointListSchema, EMPTY_RAVEN_DECISION_POINT_LIST, {
        endpoint: "GET /api/raven/decision-points",
      }),
    ).toBe(EMPTY_RAVEN_DECISION_POINT_LIST);

    const empty = parseWithFallback(
      {},
      RavenDecisionPointListSchema,
      EMPTY_RAVEN_DECISION_POINT_LIST,
      { endpoint: "GET /api/raven/decision-points" },
    );
    expect(empty.items).toEqual([]);
  });
});

describe("RavenEvidenceListSchema", () => {
  const ENDPOINT = { endpoint: "GET /api/raven/requirements/{id}/evidence" };

  it("parses evidence entries and defaults the array", () => {
    const parsed = parseWithFallback(
      {
        evidence: [
          {
            id: "e-1",
            requirement_id: "r-1",
            run_id: null,
            kind: "test_report",
            source: "ci",
            summary: "12 passed",
            payload: { passed: 12 },
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        total: 1,
      },
      RavenEvidenceListSchema,
      EMPTY_RAVEN_EVIDENCE_LIST,
      ENDPOINT,
    );
    expect(parsed.evidence[0]?.kind).toBe("test_report");

    const empty = parseWithFallback({}, RavenEvidenceListSchema, EMPTY_RAVEN_EVIDENCE_LIST, ENDPOINT);
    expect(empty.evidence).toEqual([]);
  });

  it("returns the fallback for a non-object body", () => {
    expect(
      parseWithFallback([], RavenEvidenceListSchema, EMPTY_RAVEN_EVIDENCE_LIST, ENDPOINT),
    ).toBe(EMPTY_RAVEN_EVIDENCE_LIST);
  });
});

describe("RavenRunListSchema", () => {
  const ENDPOINT = { endpoint: "GET /api/raven/requirements/{id}/runs" };

  it("parses runs and defaults current_stage for older backends", () => {
    const parsed = parseWithFallback(
      {
        runs: [
          {
            id: "run-1",
            requirement_id: "req-1",
            status: "running",
            current_stage: "execute",
          },
          // A pre-#15 backend row without current_stage must still parse.
          { id: "run-0", requirement_id: "req-1", status: "completed" },
        ],
        total: 2,
      },
      RavenRunListSchema,
      EMPTY_RAVEN_RUN_LIST,
      ENDPOINT,
    );
    expect(parsed.runs[0]?.current_stage).toBe("execute");
    expect(parsed.runs[1]?.current_stage).toBe("");
    expect(parsed.runs[1]?.workflow_id).toBeNull();
  });

  it("returns the fallback for a malformed body", () => {
    expect(parseWithFallback(null, RavenRunListSchema, EMPTY_RAVEN_RUN_LIST, ENDPOINT)).toBe(
      EMPTY_RAVEN_RUN_LIST,
    );
    const empty = parseWithFallback({}, RavenRunListSchema, EMPTY_RAVEN_RUN_LIST, ENDPOINT);
    expect(empty.runs).toEqual([]);
  });
});

describe("RavenStageEventListSchema", () => {
  const ENDPOINT = { endpoint: "GET /api/raven/runs/{id}/stage-events" };

  it("parses the stage event stream with timestamps", () => {
    const parsed = parseWithFallback(
      {
        events: [
          { id: "e-1", run_id: "run-1", stage: "clarify", event: "entered", created_at: "2026-07-01T10:00:00Z" },
          { id: "e-2", run_id: "run-1", stage: "clarify", event: "exited", created_at: "2026-07-01T10:30:00Z" },
        ],
        total: 2,
      },
      RavenStageEventListSchema,
      EMPTY_RAVEN_STAGE_EVENT_LIST,
      ENDPOINT,
    );
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]?.stage).toBe("clarify");
    expect(parsed.events[1]?.event).toBe("exited");
  });

  it("returns the fallback for a malformed body", () => {
    expect(
      parseWithFallback([], RavenStageEventListSchema, EMPTY_RAVEN_STAGE_EVENT_LIST, ENDPOINT),
    ).toBe(EMPTY_RAVEN_STAGE_EVENT_LIST);
    const empty = parseWithFallback({}, RavenStageEventListSchema, EMPTY_RAVEN_STAGE_EVENT_LIST, ENDPOINT);
    expect(empty.events).toEqual([]);
  });
});

describe("RavenWorkflowStatsListSchema", () => {
  const ENDPOINT = { endpoint: "GET /api/raven/workflows/stats" };

  it("parses stats and defaults a missing active_runs (older backend) to 0", () => {
    const parsed = parseWithFallback(
      {
        stats: [
          {
            workflow_id: "wf-1",
            run_count: 3,
            active_runs: 2,
            avg_run_seconds: 10,
            approved_gates: 1,
            rejected_gates: 0,
          },
          // Older backend without the active_runs field.
          { workflow_id: "wf-2", run_count: 1 },
        ],
        total: 2,
      },
      RavenWorkflowStatsListSchema,
      EMPTY_RAVEN_WORKFLOW_STATS_LIST,
      ENDPOINT,
    );
    expect(parsed.stats[0]?.active_runs).toBe(2);
    expect(parsed.stats[1]?.active_runs).toBe(0);
    expect(parsed.stats[1]?.avg_run_seconds).toBe(0);
    // Older backends have no trust promotion fields (issue #25).
    expect(parsed.stats[1]?.promoted_gates).toBe(0);
    expect(parsed.stats[1]?.max_gate_streak).toBe(0);
  });

  it("returns the empty fallback for a malformed body", () => {
    expect(
      parseWithFallback(
        { stats: [{ workflow_id: 42 }] },
        RavenWorkflowStatsListSchema,
        EMPTY_RAVEN_WORKFLOW_STATS_LIST,
        ENDPOINT,
      ),
    ).toBe(EMPTY_RAVEN_WORKFLOW_STATS_LIST);
    expect(
      parseWithFallback(null, RavenWorkflowStatsListSchema, EMPTY_RAVEN_WORKFLOW_STATS_LIST, ENDPOINT),
    ).toBe(EMPTY_RAVEN_WORKFLOW_STATS_LIST);
  });
});

describe("RavenLearningSchema / RavenLearningListSchema", () => {
  const ENDPOINT = { endpoint: "GET /api/raven/learnings" };

  it("parses learnings with provenance and defaults omitted fields", () => {
    const parsed = parseWithFallback(
      {
        learnings: [
          {
            id: "l-1",
            run_id: "run-1",
            stage: "execute",
            content: "先读现有测试",
            status: "fresh",
            promoted_to: "",
            issue_id: "issue-1",
            created_at: "2026-07-01T10:00:00Z",
          },
          // Older/newer backend drift: minimal row still parses.
          { id: "l-2" },
        ],
        total: 2,
      },
      RavenLearningListSchema,
      EMPTY_RAVEN_LEARNING_LIST,
      ENDPOINT,
    );
    expect(parsed.learnings[0]?.stage).toBe("execute");
    expect(parsed.learnings[0]?.issue_id).toBe("issue-1");
    expect(parsed.learnings[1]?.status).toBe("fresh");
    expect(parsed.learnings[1]?.promoted_to).toBe("");
  });

  it("returns the fallback for malformed bodies", () => {
    expect(
      parseWithFallback([], RavenLearningListSchema, EMPTY_RAVEN_LEARNING_LIST, ENDPOINT),
    ).toBe(EMPTY_RAVEN_LEARNING_LIST);
    expect(
      parseWithFallback(null, RavenLearningSchema, EMPTY_RAVEN_LEARNING, {
        endpoint: "PATCH /api/raven/learnings/{id}",
      }),
    ).toBe(EMPTY_RAVEN_LEARNING);
    const empty = parseWithFallback({}, RavenLearningListSchema, EMPTY_RAVEN_LEARNING_LIST, ENDPOINT);
    expect(empty.learnings).toEqual([]);
  });

  it("parses the produced asset on promoted rows and defaults its fields (issue #28)", () => {
    const parsed = parseWithFallback(
      {
        learnings: [
          {
            id: "l-1",
            status: "promoted",
            promoted_to: "skill_proposal",
            content: "先读现有测试",
            asset: { id: "a-1", kind: "skill_proposal", skill_id: "skl-1" },
          },
          // Fresh row: no asset field at all.
          { id: "l-2", status: "fresh" },
        ],
      },
      RavenLearningListSchema,
      EMPTY_RAVEN_LEARNING_LIST,
      ENDPOINT,
    );
    expect(parsed.learnings[0]?.asset?.skill_id).toBe("skl-1");
    // Missing sub-fields default rather than throwing.
    expect(parsed.learnings[0]?.asset?.workflow_id).toBe("");
    expect(parsed.learnings[0]?.asset?.title).toBe("");
    expect(parsed.learnings[1]?.asset ?? null).toBeNull();
  });
});

describe("trust promotion schemas (issue #25)", () => {
  it("parses gate policies and defaults missing fields", () => {
    const parsed = parseWithFallback(
      { policies: [{ gate_name: "human-review", mode: "sampled", streak: 3 }, {}] },
      RavenGatePolicyListSchema,
      EMPTY_RAVEN_GATE_POLICY_LIST,
      { endpoint: "GET /api/raven/workflows/{id}/gate-policies" },
    );
    expect(parsed.policies[0]?.mode).toBe("sampled");
    expect(parsed.policies[1]?.mode).toBe("full");
    expect(parsed.policies[1]?.streak).toBe(0);
  });

  it("returns the empty fallback for malformed gate policies", () => {
    expect(
      parseWithFallback(
        { policies: [{ streak: "nope" }] },
        RavenGatePolicyListSchema,
        EMPTY_RAVEN_GATE_POLICY_LIST,
        { endpoint: "GET /api/raven/workflows/{id}/gate-policies" },
      ),
    ).toBe(EMPTY_RAVEN_GATE_POLICY_LIST);
  });

  it("parses a promotion letter and falls back on malformed bodies", () => {
    const parsed = parseWithFallback(
      { id: "p-1", gate_name: "human-review", status: "pending" },
      RavenPromotionSchema,
      EMPTY_RAVEN_PROMOTION,
      { endpoint: "GET /api/raven/promotions/{id}" },
    );
    expect(parsed.gate_name).toBe("human-review");
    expect(parsed.decided_by).toBeNull();
    expect(
      parseWithFallback({ id: 42 }, RavenPromotionSchema, EMPTY_RAVEN_PROMOTION, {
        endpoint: "GET /api/raven/promotions/{id}",
      }),
    ).toBe(EMPTY_RAVEN_PROMOTION);
  });
});

describe("RavenRunSchema / RavenClarificationListSchema (run room, issue #18)", () => {
  const runEndpoint = { endpoint: "GET /api/raven/runs/{id}" };
  const listEndpoint = { endpoint: "GET /api/raven/requirements/{id}/clarifications" };

  it("parses a single run and defaults omitted fields (older backend)", () => {
    const parsed = parseWithFallback(
      { id: "run-1", requirement_id: "req-1" },
      RavenRunSchema,
      EMPTY_RAVEN_RUN,
      runEndpoint,
    );
    expect(parsed.id).toBe("run-1");
    expect(parsed.status).toBe("pending");
    expect(parsed.tokens_spent).toBe(0);
  });

  it("returns the fallback for malformed run bodies", () => {
    expect(parseWithFallback(null, RavenRunSchema, EMPTY_RAVEN_RUN, runEndpoint)).toBe(EMPTY_RAVEN_RUN);
    expect(parseWithFallback({ id: 42 }, RavenRunSchema, EMPTY_RAVEN_RUN, runEndpoint)).toBe(EMPTY_RAVEN_RUN);
  });

  it("parses the clarification list and defaults an omitted array", () => {
    const parsed = parseWithFallback(
      { clarifications: [{ id: "c-1", questions: [{ question: "Q" }] }], total: 1 },
      RavenClarificationListSchema,
      EMPTY_RAVEN_CLARIFICATION_LIST,
      listEndpoint,
    );
    expect(parsed.clarifications[0]?.id).toBe("c-1");
    expect(parsed.clarifications[0]?.status).toBe("pending");
    const empty = parseWithFallback({}, RavenClarificationListSchema, EMPTY_RAVEN_CLARIFICATION_LIST, listEndpoint);
    expect(empty.clarifications).toEqual([]);
  });

  it("returns the fallback for malformed clarification list bodies", () => {
    expect(
      parseWithFallback([], RavenClarificationListSchema, EMPTY_RAVEN_CLARIFICATION_LIST, listEndpoint),
    ).toBe(EMPTY_RAVEN_CLARIFICATION_LIST);
    expect(
      parseWithFallback({ clarifications: "nope" }, RavenClarificationListSchema, EMPTY_RAVEN_CLARIFICATION_LIST, listEndpoint),
    ).toBe(EMPTY_RAVEN_CLARIFICATION_LIST);
  });
});

describe("RavenCompositionSchema (issue #26)", () => {
  const endpoint = "raven.composition";

  it("parses a well-formed composition", () => {
    const parsed = parseWithFallback(
      { mode: "manual", agent_ids: ["a-1", "a-2"], skill_ids: ["s-1"] },
      RavenCompositionSchema,
      EMPTY_RAVEN_COMPOSITION,
      { endpoint },
    );
    expect(parsed.mode).toBe("manual");
    expect(parsed.agent_ids).toEqual(["a-1", "a-2"]);
    expect(parsed.skill_ids).toEqual(["s-1"]);
  });

  it("defaults missing fields so a partial payload still parses", () => {
    const parsed = parseWithFallback(
      { mode: "auto" },
      RavenCompositionSchema,
      EMPTY_RAVEN_COMPOSITION,
      { endpoint },
    );
    expect(parsed.mode).toBe("auto");
    expect(parsed.agent_ids).toEqual([]);
    expect(parsed.skill_ids).toEqual([]);
  });

  it("returns the fallback for malformed composition bodies", () => {
    expect(
      parseWithFallback({ agent_ids: "nope" }, RavenCompositionSchema, EMPTY_RAVEN_COMPOSITION, { endpoint }),
    ).toBe(EMPTY_RAVEN_COMPOSITION);
    expect(
      parseWithFallback(null, RavenCompositionSchema, EMPTY_RAVEN_COMPOSITION, { endpoint }),
    ).toBe(EMPTY_RAVEN_COMPOSITION);
    expect(
      parseWithFallback("oops", RavenCompositionSchema, EMPTY_RAVEN_COMPOSITION, { endpoint }),
    ).toBe(EMPTY_RAVEN_COMPOSITION);
  });

  it("findComposition reads the workflow_composition evidence, or null when absent", () => {
    const evidence = [
      { id: "e1", requirement_id: "r", run_id: null, kind: "agent_output", source: "", summary: "", payload: {}, created_at: "" },
      {
        id: "e2", requirement_id: "r", run_id: null, kind: "workflow_composition", source: "", summary: "",
        payload: { mode: "manual", agent_ids: ["a-1"], skill_ids: ["s-1"] }, created_at: "",
      },
    ];
    expect(findComposition(evidence)?.agent_ids).toEqual(["a-1"]);
    expect(findComposition([])).toBeNull();
    expect(findComposition(undefined)).toBeNull();
  });
});

describe("RavenClarifyQuestionsSchema (issue #30)", () => {
  const endpoint = "raven.clarify.questions";

  it("normalizes bare strings, objects, and the {questions:[...]} wrapper", () => {
    expect(
      parseWithFallback(
        { questions: ["A?", { question: "B?", options: ["x"], recommended: "x" }, 42, {}] },
        RavenClarifyQuestionsSchema,
        EMPTY_RAVEN_CLARIFY_QUESTIONS,
        { endpoint },
      ),
    ).toEqual([
      { question: "A?", options: [] },
      { question: "B?", options: ["x"], recommended: "x" },
    ]);
    // Bare array form works too, and drops malformed items.
    expect(parseClarifyQuestions([{ question: "Only?" }, "Loose?"])).toEqual([
      { question: "Only?", options: [] },
      { question: "Loose?", options: [] },
    ]);
  });

  it("degrades a malformed top-level payload to []", () => {
    expect(parseClarifyQuestions(null)).toEqual([]);
    expect(parseClarifyQuestions("oops")).toEqual([]);
    expect(parseClarifyQuestions(42)).toEqual([]);
    expect(
      parseWithFallback("nope", RavenClarifyQuestionsSchema, EMPTY_RAVEN_CLARIFY_QUESTIONS, { endpoint }),
    ).toEqual([]);
  });
});
