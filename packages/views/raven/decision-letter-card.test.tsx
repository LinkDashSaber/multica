// @vitest-environment jsdom

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { NavigationProvider } from "../navigation";
import type { NavigationAdapter } from "../navigation";
import enRaven from "../locales/en/raven.json";
import enCommon from "../locales/en/common.json";

const mockGetGate = vi.hoisted(() => vi.fn());
const mockGetClarification = vi.hoisted(() => vi.fn());
const mockGetRequirement = vi.hoisted(() => vi.fn());
const mockGetWorkflow = vi.hoisted(() => vi.fn());
const mockListStats = vi.hoisted(() => vi.fn());
const mockListRuns = vi.hoisted(() => vi.fn());
const mockGetIssue = vi.hoisted(() => vi.fn());
const mockListEvidence = vi.hoisted(() => vi.fn());
const mockGetPromotion = vi.hoisted(() => vi.fn());
const mockDecidePromotion = vi.hoisted(() => vi.fn());
const mockDecide = vi.hoisted(() => vi.fn());
const mockAnswer = vi.hoisted(() => vi.fn());
const mockListSkills = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    getRavenGate: mockGetGate,
    getRavenClarification: mockGetClarification,
    getRavenRequirement: mockGetRequirement,
    getRavenWorkflow: mockGetWorkflow,
    listRavenWorkflowStats: mockListStats,
    listRavenRuns: mockListRuns,
    getIssue: mockGetIssue,
    listRavenEvidence: mockListEvidence,
    getRavenPromotion: mockGetPromotion,
    decideRavenPromotion: mockDecidePromotion,
    listSkills: mockListSkills,
    decideRavenGate: mockDecide,
    answerRavenClarification: mockAnswer,
  },
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: () => "Alice",
    getMemberName: () => "Alice",
    getAgentName: () => "Agent",
    getSquadName: () => "Squad",
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import {
  DecisionLetterCard,
  composeClarifyAnswer,
  formatPendingDuration,
  parseClarifyQuestions,
  parsePromotionReviews,
} from "./decision-letter-card";

const GATE = {
  id: "gate-1",
  workspace_id: "ws-1",
  requirement_id: "req-1",
  run_id: "run-1",
  gate_name: "self-check",
  status: "pending",
  review_package: { summary: "All checks passed." },
  decided_by: null,
  decision_reason: "",
  created_at: "2026-07-01T00:00:00Z",
  decided_at: null,
};

const CLARIFICATION = {
  id: "clar-1",
  workspace_id: "ws-1",
  requirement_id: "req-1",
  run_id: "run-1",
  stage: "code",
  questions: [
    { question: "Use REST or GraphQL?", options: ["REST", "GraphQL"], recommended: "REST" },
    { question: "Target branch?", options: [], recommended: "main" },
  ],
  status: "pending",
  answer: "",
  answered_by: null,
  created_at: "2026-07-01T00:00:00Z",
  answered_at: null,
};

const REQUIREMENT = {
  id: "req-1",
  workspace_id: "ws-1",
  issue_id: "issue-1",
  workflow_id: "wf-1",
  state: "running",
  next_states: [],
  created_at: "",
  updated_at: "",
};

const WORKFLOW = {
  id: "wf-1",
  name: "bugfix",
  version: 1,
  enabled: true,
  description: "",
  contract: {
    stages: ["plan", "code", "pr"],
    gates: [{ name: "self-check", after_stage: "code" }],
  },
  created_at: "",
  updated_at: "",
};

const ISSUE = {
  id: "issue-1",
  title: "Add dark mode toggle",
  description: "Users want a dark theme in settings.",
};

const EVIDENCE = {
  evidence: [
    {
      id: "ev-1",
      requirement_id: "req-1",
      run_id: "run-1",
      kind: "test_run",
      source: "ci",
      summary: "212 tests green",
      payload: undefined,
      created_at: "2026-07-01T00:00:00Z",
    },
  ],
  total: 1,
};

const PROMOTION = {
  id: "promo-1",
  workspace_id: "ws-1",
  workflow_id: "wf-1",
  gate_name: "self-check",
  status: "pending",
  evidence: [
    {
      id: "g-1",
      gate_name: "self-check",
      status: "approved",
      decided_by: "user-1",
      decided_at: "2026-06-01T09:00:00Z",
      created_at: "2026-06-01T08:00:00Z",
      decision_reason: "",
    },
    {
      id: "g-2",
      gate_name: "self-check",
      status: "approved",
      decided_by: "user-1",
      decided_at: "2026-06-02T09:00:00Z",
      created_at: "2026-06-02T08:00:00Z",
      decision_reason: "",
    },
  ],
  decided_by: null,
  decision_reason: "",
  created_at: "2026-07-01T00:00:00Z",
  decided_at: null,
};

const STATS = {
  stats: [
    {
      workflow_id: "wf-1",
      run_count: 5,
      active_runs: 1,
      avg_run_seconds: 200,
      approved_gates: 4,
      rejected_gates: 0,
    },
  ],
  total: 1,
};

const RUNS = {
  runs: [
    {
      id: "run-1",
      workspace_id: "ws-1",
      requirement_id: "req-1",
      workflow_id: "wf-1",
      trigger_run_id: "",
      status: "running",
      current_stage: "code",
      termination_reason: "",
      tokens_spent: 12345,
      usd_spent: 0.42,
      created_at: "",
      updated_at: "",
    },
  ],
  total: 1,
};

const navigation: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/inbox",
  searchParams: new URLSearchParams(),
  getShareableUrl: (p) => p,
};

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={{ en: { raven: enRaven, common: enCommon } }}>
        <WorkspaceSlugProvider slug="acme">
          <NavigationProvider value={navigation}>{children}</NavigationProvider>
        </WorkspaceSlugProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetGate.mockResolvedValue(GATE);
  mockGetClarification.mockResolvedValue(CLARIFICATION);
  mockGetRequirement.mockResolvedValue(REQUIREMENT);
  mockGetWorkflow.mockResolvedValue(WORKFLOW);
  mockListStats.mockResolvedValue(STATS);
  mockListRuns.mockResolvedValue(RUNS);
  mockGetIssue.mockResolvedValue(ISSUE);
  mockListEvidence.mockResolvedValue(EVIDENCE);
  mockGetPromotion.mockResolvedValue(PROMOTION);
  mockDecidePromotion.mockResolvedValue({ ...PROMOTION, status: "approved" });
  mockDecide.mockResolvedValue({ ...GATE, status: "approved" });
  mockAnswer.mockResolvedValue({ ...CLARIFICATION, status: "answered" });
  mockListSkills.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatPendingDuration", () => {
  const base = Date.parse("2026-07-01T00:00:00Z");
  it("formats minute / hour / day resolutions", () => {
    expect(formatPendingDuration("2026-07-01T00:00:00Z", base + 37 * 60_000)).toBe("37m");
    expect(formatPendingDuration("2026-07-01T00:00:00Z", base + (2 * 60 + 37) * 60_000)).toBe("2h37m");
    expect(formatPendingDuration("2026-07-01T00:00:00Z", base + (3 * 1440 + 2 * 60) * 60_000)).toBe("3d2h");
    expect(formatPendingDuration("2026-07-01T00:00:00Z", base + 30_000)).toBe("0m");
  });
  it("returns empty for unparsable timestamps", () => {
    expect(formatPendingDuration("", base)).toBe("");
    expect(formatPendingDuration("not-a-date", base)).toBe("");
  });
});

describe("parseClarifyQuestions / composeClarifyAnswer", () => {
  it("accepts bare arrays, wrappers, strings, and skips malformed items", () => {
    expect(parseClarifyQuestions({ questions: ["A?", { question: "B?", options: ["x"], recommended: "x" }, 42, {}] })).toEqual([
      { question: "A?", options: [], recommended: undefined },
      { question: "B?", options: ["x"], recommended: "x" },
    ]);
    expect(parseClarifyQuestions(null)).toEqual([]);
  });

  it("composes a numbered answer for multiple questions, bare answer for one", () => {
    const qs = parseClarifyQuestions(CLARIFICATION.questions);
    expect(composeClarifyAnswer(qs, ["REST", "main"], "A: ")).toBe(
      "1. Use REST or GraphQL?\nA: REST\n\n2. Target branch?\nA: main",
    );
    expect(composeClarifyAnswer(qs.slice(0, 1), [" REST "], "A: ")).toBe("REST");
  });
});

describe("DecisionLetterCard (gate)", () => {
  it("renders the four-part letter: strip, why line, context, consequences, verdict", async () => {
    render(<DecisionLetterCard wsId="ws-1" kind="gate" id="gate-1" />, { wrapper: Wrapper });

    // 2. Why line.
    expect(
      await screen.findByText("The workflow is waiting for your verdict at gate self-check"),
    ).toBeInTheDocument();

    // 1. Mini strip with the gate's stage pulsing as "waiting".
    await waitFor(() => expect(screen.getByTestId("letter-stage-strip")).toBeInTheDocument());
    const nodes = screen.getAllByTestId("letter-stage-node");
    expect(nodes.map((n) => n.getAttribute("data-state"))).toEqual(["done", "waiting", "pending"]);

    // 3. Context summary from the review package.
    expect(screen.getByText("All checks passed.")).toBeInTheDocument();

    // 4. Consequence preview: static next stage + historical estimate + cost.
    const consequence = await screen.findByTestId("letter-consequence");
    expect(consequence).toHaveTextContent("Approve → continue to stage pr");
    expect(consequence).toHaveTextContent("Reject → sent back for rework");
    await waitFor(() =>
      expect(consequence).toHaveTextContent("Historical average full run: 3m 20s"),
    );
    expect(consequence).toHaveTextContent("This run has used 12,345 tokens");
    expect(consequence).toHaveTextContent("Cost so far: ~$0.42");

    // 5. Verdict controls.
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("renders the requirement context, exit links, and evidence trail", async () => {
    render(<DecisionLetterCard wsId="ws-1" kind="gate" id="gate-1" />, { wrapper: Wrapper });

    // The original ask, pulled from the issue behind the requirement.
    expect(await screen.findByText("Add dark mode toggle")).toBeInTheDocument();
    expect(screen.getByText("Users want a dark theme in settings.")).toBeInTheDocument();

    // Exit links: the issue and the run room (运行室).
    expect(screen.getByRole("link", { name: "View issue" })).toHaveAttribute(
      "href",
      "/acme/issues/issue-1",
    );
    expect(screen.getByRole("link", { name: "Open run room" })).toHaveAttribute(
      "href",
      "/acme/raven/runs/run-1",
    );

    // Evidence produced so far.
    const evidence = await screen.findByTestId("letter-evidence");
    expect(evidence).toHaveTextContent("212 tests green");
  });

  it("degrades gracefully when the issue and evidence are missing", async () => {
    mockGetIssue.mockRejectedValue(new Error("not found"));
    mockListEvidence.mockResolvedValue({ evidence: [], total: 0 });
    render(<DecisionLetterCard wsId="ws-1" kind="gate" id="gate-1" />, { wrapper: Wrapper });

    // The requirement block still renders (state badge + view-issue link)
    // from the requirement alone, even without the issue body.
    expect(await screen.findByTestId("letter-requirement")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View issue" })).toBeInTheDocument();
    // Empty evidence shows the empty hint, not a crash.
    const evidence = await screen.findByTestId("letter-evidence");
    expect(evidence).toHaveTextContent("No evidence recorded");
  });

  it("omits estimates when there is no history — static parts only", async () => {
    mockListStats.mockResolvedValue({ stats: [], total: 0 });
    mockListRuns.mockResolvedValue({ runs: [], total: 0 });
    render(<DecisionLetterCard wsId="ws-1" kind="gate" id="gate-1" />, { wrapper: Wrapper });

    const consequence = await screen.findByTestId("letter-consequence");
    // The approve line waits on the workflow contract query.
    await waitFor(() =>
      expect(consequence).toHaveTextContent("Approve → continue to stage pr"),
    );
    expect(screen.queryByText(/Historical average/)).not.toBeInTheDocument();
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cost so far/)).not.toBeInTheDocument();
  });

  it("approves through the existing gate decision mutation", async () => {
    const user = userEvent.setup();
    render(<DecisionLetterCard wsId="ws-1" kind="gate" id="gate-1" />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(mockDecide).toHaveBeenCalledWith("gate-1", { approve: true, reason: "" }),
    );
  });

  it("requires a reason to reject", async () => {
    const user = userEvent.setup();
    render(<DecisionLetterCard wsId="ws-1" kind="gate" id="gate-1" />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: "Reject" }));
    await user.click(screen.getByRole("button", { name: "Confirm rejection" }));
    expect(screen.getByText("A reason is required to reject")).toBeInTheDocument();
    expect(mockDecide).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Reason"), "Touches unrelated files");
    await user.click(screen.getByRole("button", { name: "Confirm rejection" }));
    await waitFor(() =>
      expect(mockDecide).toHaveBeenCalledWith("gate-1", {
        approve: false,
        reason: "Touches unrelated files",
      }),
    );
  });

  it("shows the pending timer and ticks it once a minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-07-01T02:37:00Z"));
    render(<DecisionLetterCard wsId="ws-1" kind="gate" id="gate-1" />, { wrapper: Wrapper });

    // Flush query resolution without waitFor (hangs under fake timers).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("letter-pending")).toHaveTextContent("Pending for 2h37m");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId("letter-pending")).toHaveTextContent("Pending for 2h38m");
  });
});

describe("DecisionLetterCard (clarify)", () => {
  it("renders question cards with recommended answers preselected", async () => {
    render(<DecisionLetterCard wsId="ws-1" kind="clarify" id="clar-1" />, { wrapper: Wrapper });

    expect(
      await screen.findByText("The running agent has 2 question(s) needing clarification"),
    ).toBeInTheDocument();

    const cards = screen.getAllByTestId("clarify-question-card");
    expect(cards).toHaveLength(2);
    // Recommended answers are preselected in the editable textareas.
    expect(screen.getByLabelText("Answer to question 1")).toHaveValue("REST");
    expect(screen.getByLabelText("Answer to question 2")).toHaveValue("main");
    // Option buttons render, recommended one flagged.
    expect(screen.getByRole("button", { name: /GraphQL/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^REST/ })).toHaveTextContent("Recommended");
  });

  it("apply-all-recommended submits every recommendation in one composed answer", async () => {
    const user = userEvent.setup();
    render(<DecisionLetterCard wsId="ws-1" kind="clarify" id="clar-1" />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: "Apply all recommended" }));
    await waitFor(() =>
      expect(mockAnswer).toHaveBeenCalledWith("clar-1", {
        answer: "1. Use REST or GraphQL?\nA: REST\n\n2. Target branch?\nA: main",
      }),
    );
  });

  it("submits edited free-text answers and blocks empty ones", async () => {
    const user = userEvent.setup();
    render(<DecisionLetterCard wsId="ws-1" kind="clarify" id="clar-1" />, { wrapper: Wrapper });

    const second = await screen.findByLabelText("Answer to question 2");
    await user.clear(second);
    await user.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(screen.getByText("Some questions are still unanswered")).toBeInTheDocument();
    expect(mockAnswer).not.toHaveBeenCalled();

    await user.type(second, "release/2.0");
    await user.click(screen.getByRole("button", { name: "Submit answers" }));
    await waitFor(() =>
      expect(mockAnswer).toHaveBeenCalledWith("clar-1", {
        answer: "1. Use REST or GraphQL?\nA: REST\n\n2. Target branch?\nA: release/2.0",
      }),
    );
  });

  it("switching an option fills the answer text", async () => {
    const user = userEvent.setup();
    render(<DecisionLetterCard wsId="ws-1" kind="clarify" id="clar-1" />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: /GraphQL/ }));
    expect(screen.getByLabelText("Answer to question 1")).toHaveValue("GraphQL");
  });

  it("shows the answered state instead of the form once resolved", async () => {
    mockGetClarification.mockResolvedValue({
      ...CLARIFICATION,
      status: "answered",
      answer: "1. Use REST or GraphQL?\nA: REST",
      answered_by: "user-1",
      answered_at: "2026-07-02T10:00:00Z",
    });
    render(<DecisionLetterCard wsId="ws-1" kind="clarify" id="clar-1" />, { wrapper: Wrapper });

    expect(await screen.findByTestId("clarify-answered")).toBeInTheDocument();
    expect(screen.getByText(/Answered by Alice/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Submit answers" }),
    ).not.toBeInTheDocument();
    // Consequence preview is pending-only.
    expect(screen.queryByTestId("letter-consequence")).not.toBeInTheDocument();
  });
});

describe("parsePromotionReviews", () => {
  it("reads gate-review records and skips malformed / non-array input", () => {
    expect(
      parsePromotionReviews([
        { id: "g-1", gate_name: "self-check", status: "approved", decided_by: "u1" },
        42,
        null,
        { status: "approved" },
      ]),
    ).toEqual([
      {
        id: "g-1",
        gate_name: "self-check",
        status: "approved",
        decided_by: "u1",
        decided_at: "",
        created_at: "",
        decision_reason: "",
      },
      {
        id: "",
        gate_name: "",
        status: "approved",
        decided_by: null,
        decided_at: "",
        created_at: "",
        decision_reason: "",
      },
    ]);
    expect(parsePromotionReviews(undefined)).toEqual([]);
    expect(parsePromotionReviews({ not: "an array" })).toEqual([]);
  });
});

describe("DecisionLetterCard (promotion)", () => {
  it("renders the actual zero-reject review entries, not just a count", async () => {
    render(<DecisionLetterCard wsId="ws-1" kind="promotion" id="promo-1" />, {
      wrapper: Wrapper,
    });

    // Why-line + the streak count summary.
    expect(
      await screen.findByText(
        "Gate self-check is applying for promotion to spot checks",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("2 consecutive zero-reject reviews as evidence"),
    ).toBeInTheDocument();

    // The evidence is visible: one row per review, each approved.
    const rows = await screen.findAllByTestId("promotion-review");
    expect(rows).toHaveLength(2);
    expect(screen.getAllByText("Approved").length).toBe(2);
    expect(screen.getAllByText(/Decided by Alice/).length).toBe(2);

    // Verdict controls.
    expect(screen.getByTestId("promotion-approve")).toBeInTheDocument();
  });

  it("degrades to an empty streak list on malformed evidence", async () => {
    mockGetPromotion.mockResolvedValue({ ...PROMOTION, evidence: "corrupt" });
    render(<DecisionLetterCard wsId="ws-1" kind="promotion" id="promo-1" />, {
      wrapper: Wrapper,
    });

    // Count reflects zero and no rows render — no crash.
    expect(
      await screen.findByText("0 consecutive zero-reject reviews as evidence"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("promotion-review")).not.toBeInTheDocument();
  });
});

describe("DecisionLetterCard (clarify composition, issue #30)", () => {
  it("shows the strategy's chosen agent and skill composition", async () => {
    mockListEvidence.mockResolvedValue({
      evidence: [
        {
          id: "ev-1",
          requirement_id: "req-1",
          run_id: null,
          kind: "workflow_composition",
          source: "composition()",
          summary: "",
          payload: { mode: "manual", agent_ids: ["a1"], skill_ids: ["s1"] },
          created_at: "",
        },
      ],
      total: 1,
    });
    mockListSkills.mockResolvedValue([{ id: "s1", name: "Refactor" }]);

    render(<DecisionLetterCard wsId="ws-1" kind="clarify" id="clar-1" />, { wrapper: Wrapper });

    const section = await screen.findByTestId("letter-composition");
    // Skill name resolved from the workspace skills list.
    expect(section).toHaveTextContent("Refactor");
    // Agent name resolved via useActorName (mocked to "Alice").
    expect(section).toHaveTextContent("Alice");
  });

  it("renders no composition section for a non-authoring clarification", async () => {
    // beforeEach leaves the evidence list empty.
    render(<DecisionLetterCard wsId="ws-1" kind="clarify" id="clar-1" />, { wrapper: Wrapper });

    await screen.findByTestId("clarify-response");
    expect(screen.queryByTestId("letter-composition")).not.toBeInTheDocument();
  });
});
