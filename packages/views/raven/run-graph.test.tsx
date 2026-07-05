// @vitest-environment jsdom

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enRaven from "../locales/en/raven.json";
import enCommon from "../locales/en/common.json";

const mockListStageEvents = vi.hoisted(() => vi.fn());
const mockListGates = vi.hoisted(() => vi.fn());
const mockListEvidence = vi.hoisted(() => vi.fn());
const mockGetIssue = vi.hoisted(() => vi.fn());
const mockDecideGate = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    listRavenRunStageEvents: mockListStageEvents,
    listRavenGates: mockListGates,
    listRavenEvidence: mockListEvidence,
    getIssue: mockGetIssue,
    decideRavenGate: mockDecideGate,
  },
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `actor-${id}`,
    getActorInitials: () => "A",
    getActorAvatarUrl: () => null,
  }),
}));

import { RunGraph } from "./run-graph";

const CONTRACT = {
  stages: [
    { name: "clarify", description: "澄清拍板问题" },
    { name: "execute" },
    { name: "learn" },
  ],
  gates: [{ name: "spec-confirm", after_stage: "clarify" }],
  budget: { max_tokens: 100 },
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
    tokens_spent: 4321,
    usd_spent: 0,
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-01T10:00:00Z",
    ...overrides,
  };
}

function event(stage: string, kind: "entered" | "exited", at: string) {
  return {
    id: `${stage}-${kind}-${at}`,
    run_id: "run-1",
    stage,
    event: kind,
    created_at: at,
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider
        locale="en"
        resources={{ en: { raven: enRaven, common: enCommon } }}
      >
        {children}
      </I18nProvider>
    </QueryClientProvider>
  );
}

function nodeById(id: string): HTMLElement {
  const node = screen
    .getAllByTestId("graph-node")
    .find((el) => el.getAttribute("data-node-id") === id);
  expect(node).toBeDefined();
  return node!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListStageEvents.mockResolvedValue({ events: [], total: 0 });
  mockListGates.mockResolvedValue({ gates: [], total: 0 });
  mockListEvidence.mockResolvedValue({ evidence: [], total: 0 });
  mockGetIssue.mockResolvedValue(null);
  mockDecideGate.mockResolvedValue({});
});

describe("RunGraph — design mode", () => {
  it("renders the contract as a ghost skeleton with hover descriptions", () => {
    render(<RunGraph wsId="ws-1" contract={CONTRACT} run={null} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByTestId("run-graph").getAttribute("data-mode")).toBe(
      "design",
    );
    const nodes = screen.getAllByTestId("graph-node");
    expect(nodes.map((el) => el.getAttribute("data-node-id"))).toEqual([
      "stage:clarify",
      "gate:spec-confirm",
      "stage:execute",
      "stage:learn",
    ]);
    expect(nodes.every((el) => el.getAttribute("data-state") === "ghost")).toBe(
      true,
    );
    // Stage description surfaces as the hover tooltip.
    expect(nodeById("stage:clarify").getAttribute("title")).toBe("澄清拍板问题");
    // No network fetches in design mode.
    expect(mockListStageEvents).not.toHaveBeenCalled();
  });
});

describe("RunGraph — run mode", () => {
  it("shows the active node with live tokens and lets the waiting gate be approved in place", async () => {
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
          review_package: { summary: "spec looks solid" },
          decided_by: null,
          decision_reason: "",
          created_at: "2026-07-01T10:31:00Z",
          decided_at: null,
        },
      ],
      total: 1,
    });

    render(
      <RunGraph
        wsId="ws-1"
        contract={CONTRACT}
        run={makeRun({ current_stage: "execute" }) as never}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(nodeById("gate:spec-confirm").getAttribute("data-state")).toBe(
        "waiting",
      );
    });
    expect(nodeById("stage:execute").getAttribute("data-state")).toBe("active");
    expect(screen.getByTestId("active-tokens").textContent).toContain("4321");

    // Approve straight from the node — no page hop.
    const actions = screen.getByTestId("gate-actions");
    await userEvent.click(
      Array.from(actions.querySelectorAll("button")).find(
        (b) => b.textContent === "Approve",
      )!,
    );
    await waitFor(() => {
      expect(mockDecideGate).toHaveBeenCalledWith("gate-1", {
        approve: true,
        reason: "",
      });
    });
  });

  it("draws a rework back-edge with the ×N badge and rejection reason", async () => {
    mockListStageEvents.mockResolvedValue({
      events: [
        event("clarify", "entered", "2026-07-01T10:00:00Z"),
        event("clarify", "exited", "2026-07-01T10:10:00Z"),
        event("clarify", "entered", "2026-07-01T10:20:00Z"),
      ],
      total: 3,
    });
    mockListGates.mockResolvedValue({
      gates: [
        {
          id: "gate-1",
          workspace_id: "ws-1",
          requirement_id: "req-1",
          run_id: "run-1",
          gate_name: "spec-confirm",
          status: "rejected",
          review_package: undefined,
          decided_by: "user-1",
          decision_reason: "范围不清晰",
          created_at: "2026-07-01T10:11:00Z",
          decided_at: "2026-07-01T10:12:00Z",
        },
      ],
      total: 1,
    });

    render(
      <RunGraph wsId="ws-1" contract={CONTRACT} run={makeRun() as never} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      const badge = screen.getByTestId("rework-badge");
      expect(badge.textContent).toContain("×1");
      expect(badge.textContent).toContain("范围不清晰");
    });
  });

  it("renders clarification Q&A as temporary nodes", async () => {
    render(
      <RunGraph
        wsId="ws-1"
        contract={CONTRACT}
        run={makeRun({ current_stage: "clarify" }) as never}
        clarifications={[
          { id: "q1", question: "目标用户是谁？", stage: "clarify" },
        ]}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(nodeById("clarification:q1").textContent).toContain(
        "目标用户是谁？",
      );
    });
    expect(nodeById("clarification:q1").getAttribute("data-state")).toBe("open");
  });
});

describe("RunGraph — node drawer", () => {
  it("opens the stage drawer with rendered output, evidence and cost — no raw JSON", async () => {
    mockListStageEvents.mockResolvedValue({
      events: [
        event("clarify", "entered", "2026-07-01T10:00:00Z"),
        event("clarify", "exited", "2026-07-01T10:30:00Z"),
      ],
      total: 2,
    });
    mockListEvidence.mockResolvedValue({
      evidence: [
        {
          id: "ev-1",
          requirement_id: "req-1",
          run_id: "run-1",
          kind: "diff",
          source: "agent",
          summary: "changed **3** files",
          payload: { secret: "raw-json-should-not-render" },
          created_at: "2026-07-01T10:10:00Z",
        },
      ],
      total: 1,
    });

    render(
      <RunGraph wsId="ws-1" contract={CONTRACT} run={makeRun() as never} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(nodeById("stage:clarify").getAttribute("data-state")).toBe("done");
    });
    await userEvent.click(nodeById("stage:clarify"));

    const drawer = await screen.findByTestId("stage-drawer");
    // Markdown-rendered output summary.
    expect(drawer.textContent).toContain("changed 3 files");
    // Evidence row metadata.
    expect(drawer.textContent).toContain("diff");
    // Duration derived from stage events (30 min).
    expect(drawer.textContent).toContain("30m");
    // The untyped payload never leaks into the drawer.
    expect(drawer.textContent).not.toContain("raw-json-should-not-render");
  });

  it("opens the gate drawer with the reject reason flow", async () => {
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
          review_package: { summary: "spec looks solid" },
          decided_by: null,
          decision_reason: "",
          created_at: "2026-07-01T10:31:00Z",
          decided_at: null,
        },
      ],
      total: 1,
    });

    render(
      <RunGraph wsId="ws-1" contract={CONTRACT} run={makeRun() as never} />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(nodeById("gate:spec-confirm").getAttribute("data-state")).toBe(
        "waiting",
      );
    });
    await userEvent.click(nodeById("gate:spec-confirm"));

    const drawer = await screen.findByTestId("gate-drawer");
    expect(drawer.textContent).toContain("spec looks solid");

    // Rejecting without a reason is blocked; with a reason it submits.
    await userEvent.click(screen.getByRole("button", { name: "Confirm rejection" }));
    expect(mockDecideGate).not.toHaveBeenCalled();
    await userEvent.type(
      screen.getByLabelText("Reason"),
      "scope is still fuzzy",
    );
    await userEvent.click(screen.getByRole("button", { name: "Confirm rejection" }));
    await waitFor(() => {
      expect(mockDecideGate).toHaveBeenCalledWith("gate-1", {
        approve: false,
        reason: "scope is still fuzzy",
      });
    });
  });
});
