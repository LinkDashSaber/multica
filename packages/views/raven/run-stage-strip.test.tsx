// @vitest-environment jsdom

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import enRaven from "../locales/en/raven.json";

const mockGetRequirementForIssue = vi.hoisted(() => vi.fn());
const mockListRuns = vi.hoisted(() => vi.fn());
const mockGetWorkflow = vi.hoisted(() => vi.fn());
const mockListStageEvents = vi.hoisted(() => vi.fn());
const mockListGates = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    getRavenRequirementForIssue: mockGetRequirementForIssue,
    listRavenRuns: mockListRuns,
    getRavenWorkflow: mockGetWorkflow,
    listRavenRunStageEvents: mockListStageEvents,
    listRavenGates: mockListGates,
  },
}));

import { IssueRunStageStrip } from "./run-stage-strip";

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
  workspace_id: "ws-1",
  name: "feature-delivery",
  description: "",
  contract: {
    // Mixed declaration forms on purpose (issue #15 compatibility).
    stages: [
      { name: "clarify", description: "澄清拍板问题" },
      { name: "execute" },
      "learn",
    ],
    gates: [{ name: "spec-confirm", after_stage: "clarify" }],
    budget: { max_tokens: 100 },
  },
  version: 1,
  enabled: true,
  created_at: "",
  updated_at: "",
};

function makeRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-1",
    workspace_id: "ws-1",
    requirement_id: "req-1",
    workflow_id: "wf-1",
    trigger_run_id: "",
    status: "running",
    current_stage: "",
    termination_reason: "",
    tokens_spent: 0,
    usd_spent: 0,
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-01T10:00:00Z",
    ...overrides,
  };
}

function event(stage: string, kind: "entered" | "exited", at: string) {
  return { id: `${stage}-${kind}`, run_id: "run-1", stage, event: kind, created_at: at };
}

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={{ en: { raven: enRaven } }}>
        <WorkspaceSlugProvider slug="acme">{children}</WorkspaceSlugProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

function stateByStage(): Record<string, string | null> {
  return Object.fromEntries(
    screen
      .getAllByTestId("stage-node")
      .map((el) => [el.getAttribute("data-stage"), el.getAttribute("data-state")]),
  );
}

async function expectStates(expected: Record<string, string>): Promise<void> {
  // The strip renders as soon as the run is known and refines while the
  // event/gate queries settle — wait for the final state.
  await waitFor(() => expect(stateByStage()).toEqual(expected));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRequirementForIssue.mockResolvedValue(REQUIREMENT);
  mockGetWorkflow.mockResolvedValue(WORKFLOW);
  mockListGates.mockResolvedValue({ gates: [], total: 0 });
});

describe("IssueRunStageStrip", () => {
  it("renders done / running / pending node states from the stage event stream", async () => {
    mockListRuns.mockResolvedValue({
      runs: [makeRun({ current_stage: "execute" })],
      total: 1,
    });
    mockListStageEvents.mockResolvedValue({
      events: [
        event("clarify", "entered", "2026-07-01T10:00:00Z"),
        event("clarify", "exited", "2026-07-01T10:30:00Z"),
        event("execute", "entered", "2026-07-01T10:31:00Z"),
      ],
      total: 3,
    });

    render(<IssueRunStageStrip wsId="ws-1" issueId="issue-1" />, { wrapper: Wrapper });

    await expectStates({ clarify: "done", execute: "active", learn: "pending" });
    // The stage description surfaces as a tooltip; contract order is kept.
    const nodes = screen.getAllByTestId("stage-node");
    expect(nodes.map((el) => el.getAttribute("data-stage"))).toEqual([
      "clarify",
      "execute",
      "learn",
    ]);
    expect(nodes[0]?.getAttribute("title")).toBe("澄清拍板问题");
  });

  it("marks the gated stage amber while a pending gate suspends the run", async () => {
    mockListRuns.mockResolvedValue({ runs: [makeRun()], total: 1 });
    mockListStageEvents.mockResolvedValue({
      events: [
        event("clarify", "entered", "2026-07-01T10:00:00Z"),
        event("clarify", "exited", "2026-07-01T10:30:00Z"),
      ],
      total: 2,
    });
    mockListGates.mockResolvedValue({
      gates: [
        {
          id: "gate-1",
          workspace_id: "ws-1",
          requirement_id: "req-1",
          run_id: "run-1",
          gate_name: "spec-confirm",
          status: "pending",
          review_package: undefined,
          decided_by: null,
          decision_reason: "",
          created_at: "2026-07-01T10:31:00Z",
          decided_at: null,
        },
      ],
      total: 1,
    });

    render(<IssueRunStageStrip wsId="ws-1" issueId="issue-1" />, { wrapper: Wrapper });

    await expectStates({ clarify: "waiting", execute: "pending", learn: "pending" });
    expect(screen.getByText(/Awaiting decision/)).toBeInTheDocument();
  });

  it("shows every stage done once the run completes", async () => {
    mockListRuns.mockResolvedValue({
      runs: [makeRun({ status: "completed" })],
      total: 1,
    });
    mockListStageEvents.mockResolvedValue({ events: [], total: 0 });

    render(<IssueRunStageStrip wsId="ws-1" issueId="issue-1" />, { wrapper: Wrapper });

    await expectStates({ clarify: "done", execute: "done", learn: "done" });
  });

  it("renders nothing for issues without a run", async () => {
    mockListRuns.mockResolvedValue({ runs: [], total: 0 });
    mockListStageEvents.mockResolvedValue({ events: [], total: 0 });

    const { container } = render(<IssueRunStageStrip wsId="ws-1" issueId="issue-1" />, {
      wrapper: Wrapper,
    });
    // Give the queries a tick to settle, then assert the strip stayed hidden.
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('[data-testid="run-stage-strip"]')).toBeNull();
  });
});
