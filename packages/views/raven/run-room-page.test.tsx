// @vitest-environment jsdom

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { NavigationProvider } from "../navigation";
import type { NavigationAdapter } from "../navigation";
import enRaven from "../locales/en/raven.json";
import enCommon from "../locales/en/common.json";

const mockGetRun = vi.hoisted(() => vi.fn());
const mockGetRequirement = vi.hoisted(() => vi.fn());
const mockGetWorkflow = vi.hoisted(() => vi.fn());
const mockListStageEvents = vi.hoisted(() => vi.fn());
const mockListGates = vi.hoisted(() => vi.fn());
const mockListEvidence = vi.hoisted(() => vi.fn());
const mockListClarifications = vi.hoisted(() => vi.fn());
const mockListTimeline = vi.hoisted(() => vi.fn());
const mockGetIssue = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    getRavenRun: mockGetRun,
    getRavenRequirement: mockGetRequirement,
    getRavenWorkflow: mockGetWorkflow,
    listRavenRunStageEvents: mockListStageEvents,
    listRavenGates: mockListGates,
    listRavenEvidence: mockListEvidence,
    listRavenClarifications: mockListClarifications,
    listTimeline: mockListTimeline,
    getIssue: mockGetIssue,
  },
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `actor-${id}`,
    getActorInitials: () => "A",
    getActorAvatarUrl: () => null,
  }),
}));

import { RunRoomPage } from "./run-room-page";

const RUN = {
  id: "run-1",
  workspace_id: "ws-1",
  requirement_id: "req-1",
  workflow_id: "wf-1",
  trigger_run_id: "",
  status: "running",
  current_stage: "execute",
  termination_reason: "",
  tokens_spent: 250,
  usd_spent: 1.5,
  created_at: "2026-07-01T10:00:00Z",
  updated_at: "2026-07-01T10:00:00Z",
};

const WORKFLOW = {
  id: "wf-1",
  workspace_id: "ws-1",
  name: "feature-delivery",
  description: "",
  contract: {
    stages: [{ name: "clarify" }, { name: "execute" }],
    gates: [{ name: "spec-confirm", after_stage: "clarify" }],
    budget: { max_tokens: 1000 },
  },
  version: 1,
  enabled: true,
  created_at: "",
  updated_at: "",
};

const navigation: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/raven/runs/run-1",
  searchParams: new URLSearchParams(),
  getShareableUrl: (p) => p,
};

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider
        locale="en"
        resources={{ en: { raven: enRaven, common: enCommon } }}
      >
        <WorkspaceSlugProvider slug="acme">
          <NavigationProvider value={navigation}>{children}</NavigationProvider>
        </WorkspaceSlugProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRun.mockResolvedValue(RUN);
  mockGetRequirement.mockResolvedValue({
    id: "req-1",
    workspace_id: "ws-1",
    issue_id: "issue-1",
    workflow_id: "wf-1",
    state: "running",
    next_states: [],
    created_at: "",
    updated_at: "",
  });
  mockGetWorkflow.mockResolvedValue(WORKFLOW);
  mockListStageEvents.mockResolvedValue({
    events: [
      { id: "e-1", run_id: "run-1", stage: "clarify", event: "entered", created_at: "2026-07-01T10:01:00Z" },
      { id: "e-2", run_id: "run-1", stage: "clarify", event: "exited", created_at: "2026-07-01T10:10:00Z" },
      { id: "e-3", run_id: "run-1", stage: "execute", event: "entered", created_at: "2026-07-01T10:11:00Z" },
    ],
    total: 3,
  });
  mockListGates.mockResolvedValue({ gates: [], total: 0 });
  mockListEvidence.mockResolvedValue({ evidence: [], total: 0 });
  mockListClarifications.mockResolvedValue({
    clarifications: [
      {
        id: "c-1",
        workspace_id: "ws-1",
        requirement_id: "req-1",
        run_id: "run-1",
        stage: "execute",
        questions: [{ question: "用哪个鉴权方案？" }],
        status: "pending",
        answer: "",
        answered_by: null,
        created_at: "2026-07-01T10:12:00Z",
        answered_at: null,
      },
    ],
    total: 1,
  });
  mockListTimeline.mockResolvedValue([
    {
      type: "comment",
      id: "cm-1",
      actor_type: "member",
      actor_id: "u-1",
      created_at: "2026-07-01T10:20:00Z",
      content: "看起来不错",
    },
  ]);
  mockGetIssue.mockResolvedValue(null);
});

describe("RunRoomPage", () => {
  it("renders the three zones: run graph, execution timeline, budget", async () => {
    render(<RunRoomPage runId="run-1" />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("run-room")).toBeInTheDocument();
    });
    // Zone 1: the live graph in run mode.
    await waitFor(() => {
      expect(screen.getByTestId("run-graph").getAttribute("data-mode")).toBe("run");
    });
    // Zone 2: the merged timeline shows stage events and the comment.
    await waitFor(() => {
      const kinds = screen
        .getAllByTestId("run-room-timeline-item")
        .map((el) => el.getAttribute("data-kind"));
      expect(kinds).toEqual(["stage", "stage", "stage", "clarification_asked", "comment"]);
    });
    // Zone 3: token spend against the contract ceiling.
    expect(screen.getByTestId("budget-tokens").textContent).toBe("250 / 1,000");
    expect(screen.getByTestId("budget-progress")).toBeInTheDocument();
  });

  it("overlays clarifications on the run graph as temporary nodes", async () => {
    render(<RunRoomPage runId="run-1" />, { wrapper: Wrapper });

    await waitFor(() => {
      const clarifyNode = screen
        .getAllByTestId("graph-node")
        .find((el) => el.getAttribute("data-node-id") === "clarification:c-1");
      expect(clarifyNode).toBeDefined();
      expect(clarifyNode!.getAttribute("data-state")).toBe("open");
    });
  });

  it("shows the not-found state for an unknown run", async () => {
    mockGetRun.mockResolvedValue({ ...RUN, id: "" });
    render(<RunRoomPage runId="missing" />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText("Run not found")).toBeInTheDocument();
    });
  });
});
