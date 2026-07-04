// @vitest-environment jsdom

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { NavigationProvider } from "../navigation";
import type { NavigationAdapter } from "../navigation";
import enRaven from "../locales/en/raven.json";

const mockListTransitions = vi.hoisted(() => vi.fn());
const mockListEvidence = vi.hoisted(() => vi.fn());
const mockListGates = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    listRavenTransitions: mockListTransitions,
    listRavenEvidence: mockListEvidence,
    listRavenGates: mockListGates,
  },
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => (id === "user-1" ? "Alice" : "Raven Bot"),
    getMemberName: () => "Alice",
    getAgentName: () => "Raven Bot",
    getSquadName: () => "Squad",
  }),
}));

import { RequirementTimeline } from "./requirement-timeline";

const TRANSITIONS = {
  transitions: [
    {
      id: "tr-1",
      from_state: "idea",
      to_state: "spec",
      actor_type: "user",
      actor_id: "user-1",
      reason: "spec approved",
      created_at: "2026-07-01T10:00:00Z",
    },
    {
      id: "tr-2",
      from_state: "spec",
      to_state: "running",
      actor_type: "system",
      actor_id: "",
      reason: "",
      created_at: "2026-07-01T12:00:00Z",
    },
  ],
  total: 2,
};

const EVIDENCE = {
  evidence: [
    {
      id: "ev-1",
      requirement_id: "req-1",
      run_id: null,
      kind: "ci",
      source: "github",
      summary: "212 tests green",
      payload: undefined,
      created_at: "2026-07-01T11:00:00Z",
    },
  ],
  total: 1,
};

const GATES = {
  gates: [
    {
      id: "gate-1",
      workspace_id: "ws-1",
      requirement_id: "req-1",
      run_id: null,
      gate_name: "human-review",
      status: "rejected",
      review_package: undefined,
      decided_by: "user-1",
      decision_reason: "not enough evidence",
      created_at: "2026-07-01T13:00:00Z",
      decided_at: "2026-07-01T14:00:00Z",
    },
  ],
  total: 1,
};

const navigation: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/issues/issue-1",
  searchParams: new URLSearchParams(),
  getShareableUrl: (p) => p,
};

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={{ en: { raven: enRaven } }}>
        <WorkspaceSlugProvider slug="acme">
          <NavigationProvider value={navigation}>{children}</NavigationProvider>
        </WorkspaceSlugProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListTransitions.mockResolvedValue(TRANSITIONS);
  mockListEvidence.mockResolvedValue(EVIDENCE);
  mockListGates.mockResolvedValue(GATES);
});

describe("RequirementTimeline", () => {
  it("merges transitions, evidence, and gate events chronologically", async () => {
    render(<RequirementTimeline wsId="ws-1" requirementId="req-1" />, {
      wrapper: Wrapper,
    });

    const timeline = await screen.findByTestId("requirement-timeline");
    expect(timeline).toBeInTheDocument();
    await screen.findByText("212 tests green");

    // Expected chronological order across the three sources:
    // 10:00 transition → 11:00 evidence → 12:00 transition →
    // 13:00 gate opened → 14:00 gate decided.
    const items = timeline.querySelectorAll("li > [data-testid]");
    expect(Array.from(items).map((el) => el.getAttribute("data-testid"))).toEqual([
      "timeline-transition",
      "timeline-evidence",
      "timeline-transition",
      "timeline-gate-opened",
      "timeline-gate-decided",
    ]);

    // Transition content: state label, actor, reason.
    expect(screen.getByText("State changed to Spec")).toBeInTheDocument();
    expect(screen.getAllByText("by Alice").length).toBeGreaterThan(0);
    expect(screen.getByText("spec approved")).toBeInTheDocument();
    // System transition shows the system actor label.
    expect(screen.getByText("by System")).toBeInTheDocument();

    // Gate events: opened + decided with verdict and reason.
    expect(screen.getByText("Gate human-review opened")).toBeInTheDocument();
    expect(screen.getByText("Gate human-review rejected")).toBeInTheDocument();
    expect(screen.getByText("not enough evidence")).toBeInTheDocument();
  });

  it("shows an empty state when there are no events", async () => {
    mockListTransitions.mockResolvedValue({ transitions: [], total: 0 });
    mockListEvidence.mockResolvedValue({ evidence: [], total: 0 });
    mockListGates.mockResolvedValue({ gates: [], total: 0 });

    render(<RequirementTimeline wsId="ws-1" requirementId="req-1" />, {
      wrapper: Wrapper,
    });

    expect(await screen.findByText("No audit events yet")).toBeInTheDocument();
  });
});
