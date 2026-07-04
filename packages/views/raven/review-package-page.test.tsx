// @vitest-environment jsdom

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { NavigationProvider } from "../navigation";
import type { NavigationAdapter } from "../navigation";
import enRaven from "../locales/en/raven.json";

const mockGetGate = vi.hoisted(() => vi.fn());
const mockGetRequirement = vi.hoisted(() => vi.fn());
const mockListEvidence = vi.hoisted(() => vi.fn());
const mockDecide = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    getRavenGate: mockGetGate,
    getRavenRequirement: mockGetRequirement,
    listRavenEvidence: mockListEvidence,
    decideRavenGate: mockDecide,
  },
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

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

import { ReviewPackagePage } from "./review-package-page";

const PENDING_GATE = {
  id: "gate-1",
  workspace_id: "ws-1",
  requirement_id: "req-1",
  run_id: null,
  gate_name: "Spec Gate",
  status: "pending",
  review_package: {
    summary: "All checks passed.",
    files_changed: 3,
    diff: { additions: 42, deletions: 7 },
  },
  decided_by: null,
  decision_reason: "",
  created_at: "2026-07-01T00:00:00Z",
  decided_at: null,
};

const REQUIREMENT = {
  id: "req-1",
  workspace_id: "ws-1",
  issue_id: "issue-1",
  workflow_id: null,
  state: "needs_review",
  next_states: [],
  created_at: "",
  updated_at: "",
};

const EVIDENCE = {
  evidence: [
    {
      id: "ev-1",
      requirement_id: "req-1",
      run_id: null,
      kind: "test_run",
      source: "ci",
      summary: "212 tests green",
      payload: undefined,
      created_at: "2026-07-01T00:00:00Z",
    },
  ],
  total: 1,
};

const navigation: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/raven/gates/gate-1",
  searchParams: new URLSearchParams(),
  getShareableUrl: (p) => p,
};

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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

function renderPage() {
  return render(<ReviewPackagePage gateId="gate-1" />, { wrapper: Wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetGate.mockResolvedValue(PENDING_GATE);
  mockGetRequirement.mockResolvedValue(REQUIREMENT);
  mockListEvidence.mockResolvedValue(EVIDENCE);
  mockDecide.mockResolvedValue({ ...PENDING_GATE, status: "approved" });
});

describe("ReviewPackagePage", () => {
  it("renders a pending gate with its review package, requirement, and evidence", async () => {
    renderPage();

    expect(await screen.findByText("Spec Gate")).toBeInTheDocument();
    expect(screen.getByTestId("gate-status-badge")).toHaveTextContent("Pending");
    // Known key rendered as a paragraph.
    expect(screen.getByText("All checks passed.")).toBeInTheDocument();
    // Scalar key rendered as a definition row.
    expect(screen.getByText("files_changed")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    // Non-scalar rest goes into the collapsible raw block.
    expect(screen.getByText("Raw package data")).toBeInTheDocument();

    // Requirement lifecycle state + issue link.
    expect(await screen.findByText("Needs Review")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View issue" })).toHaveAttribute(
      "href",
      "/acme/issues/issue-1",
    );

    // Evidence list.
    expect(await screen.findByText("212 tests green")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("requires a reason to reject", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Reject" }));
    await user.click(screen.getByRole("button", { name: "Confirm rejection" }));

    expect(
      screen.getByText("A reason is required to reject"),
    ).toBeInTheDocument();
    expect(mockDecide).not.toHaveBeenCalled();

    await user.type(
      screen.getByLabelText("Reason"),
      "Diff touches unrelated files",
    );
    await user.click(screen.getByRole("button", { name: "Confirm rejection" }));

    await waitFor(() =>
      expect(mockDecide).toHaveBeenCalledWith("gate-1", {
        approve: false,
        reason: "Diff touches unrelated files",
      }),
    );
  });

  it("approve fires the decision mutation", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(mockDecide).toHaveBeenCalledWith("gate-1", {
        approve: true,
        reason: "",
      }),
    );
  });

  it("shows the decided state instead of actions once the gate is decided", async () => {
    mockGetGate.mockResolvedValue({
      ...PENDING_GATE,
      status: "rejected",
      decided_by: "user-1",
      decided_at: "2026-07-02T10:00:00Z",
      decision_reason: "Not enough evidence",
    });
    renderPage();

    expect(await screen.findByTestId("gate-decided")).toBeInTheDocument();
    expect(screen.getByText(/Decided by Alice/)).toBeInTheDocument();
    expect(screen.getByText("Not enough evidence")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve" }),
    ).not.toBeInTheDocument();
  });
});
