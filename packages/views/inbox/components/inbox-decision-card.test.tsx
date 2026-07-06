// @vitest-environment jsdom

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import type { InboxItem } from "@multica/core/types";
import { NavigationProvider } from "../../navigation";
import type { NavigationAdapter } from "../../navigation";
import enRaven from "../../locales/en/raven.json";
import enInbox from "../../locales/en/inbox.json";
import enCommon from "../../locales/en/common.json";

const mockGetGate = vi.hoisted(() => vi.fn());
const mockGetClarification = vi.hoisted(() => vi.fn());
const mockGetRequirement = vi.hoisted(() => vi.fn());
const mockGetWorkflow = vi.hoisted(() => vi.fn());
const mockListStats = vi.hoisted(() => vi.fn());
const mockListRuns = vi.hoisted(() => vi.fn());
const mockGetIssue = vi.hoisted(() => vi.fn());
const mockListEvidence = vi.hoisted(() => vi.fn());
const mockGetPromotion = vi.hoisted(() => vi.fn());

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
    decideRavenGate: vi.fn(),
    decideRavenPromotion: vi.fn(),
    answerRavenClarification: vi.fn(),
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

import { InboxDecisionCard, ravenDecisionForItem } from "./inbox-decision-card";

const GATE = {
  id: "gate-1",
  workspace_id: "ws-1",
  requirement_id: "req-1",
  run_id: null,
  gate_name: "self-check",
  status: "pending",
  review_package: { summary: "All checks passed." },
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

const ISSUE = { id: "issue-1", title: "Add dark mode toggle", description: "" };

const PROMOTION = {
  id: "promo-1",
  workspace_id: "ws-1",
  workflow_id: "wf-1",
  gate_name: "self-check",
  status: "pending",
  evidence: [
    { id: "g-1", gate_name: "self-check", status: "approved", decided_by: "user-1" },
  ],
  decided_by: null,
  decision_reason: "",
  created_at: "2026-07-01T00:00:00Z",
  decided_at: null,
};

function item(over: Partial<InboxItem>): InboxItem {
  return {
    id: "inbox-1",
    workspace_id: "ws-1",
    recipient_type: "member",
    recipient_id: "user-1",
    actor_type: "system",
    actor_id: null,
    type: "raven_gate_pending",
    severity: "action_required",
    issue_id: "issue-1",
    title: "Gate review pending",
    body: null,
    issue_status: null,
    read: false,
    archived: false,
    created_at: "2026-07-01T00:00:00Z",
    details: { gate_id: "gate-1" },
    ...over,
  };
}

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
      <I18nProvider
        locale="en"
        resources={{ en: { raven: enRaven, inbox: enInbox, common: enCommon } }}
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
  mockGetGate.mockResolvedValue(GATE);
  mockGetRequirement.mockResolvedValue(REQUIREMENT);
  mockGetIssue.mockResolvedValue(ISSUE);
  mockListEvidence.mockResolvedValue({ evidence: [], total: 0 });
  mockListStats.mockResolvedValue({ stats: [], total: 0 });
  mockListRuns.mockResolvedValue({ runs: [], total: 0 });
  mockGetPromotion.mockResolvedValue(PROMOTION);
});

describe("ravenDecisionForItem", () => {
  it("maps each Raven decision type to its kind and id", () => {
    expect(ravenDecisionForItem(item({ type: "raven_gate_pending", details: { gate_id: "g1" } })))
      .toEqual({ kind: "gate", id: "g1" });
    expect(
      ravenDecisionForItem(
        item({ type: "raven_clarify_pending", details: { clarification_id: "c1" } }),
      ),
    ).toEqual({ kind: "clarify", id: "c1" });
    expect(
      ravenDecisionForItem(
        item({ type: "raven_promotion_pending", details: { promotion_id: "p1" } }),
      ),
    ).toEqual({ kind: "promotion", id: "p1" });
  });

  it("returns null for non-decisions and for missing ids", () => {
    expect(ravenDecisionForItem(item({ type: "new_comment", details: null }))).toBeNull();
    expect(ravenDecisionForItem(item({ type: "raven_gate_pending", details: {} }))).toBeNull();
  });
});

describe("InboxDecisionCard", () => {
  it("mounts an actionable gate letter and a link back to the primary queue", async () => {
    render(<InboxDecisionCard item={item({})} wsId="ws-1" />, { wrapper: Wrapper });

    expect(
      await screen.findByText("The workflow is waiting for your verdict at gate self-check"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    // The inbox is a filtered view: a link opens the primary 待我处理 queue.
    expect(
      screen.getByRole("link", { name: "Open in decision queue" }),
    ).toHaveAttribute("href", "/acme/raven/decisions");
  });

  it("makes a promotion decidable in the inbox, consistent with the queue", async () => {
    render(
      <InboxDecisionCard
        item={item({ type: "raven_promotion_pending", details: { promotion_id: "promo-1" } })}
        wsId="ws-1"
      />,
      { wrapper: Wrapper },
    );

    // The self-contained promotion card renders with approve/reject — the
    // branch the inbox previously lacked.
    expect(await screen.findByTestId("promotion-approve")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open in decision queue" }),
    ).toBeInTheDocument();
  });

  it("renders nothing for a non-decision inbox item", () => {
    const { container } = render(
      <InboxDecisionCard item={item({ type: "new_comment", details: null })} wsId="ws-1" />,
      { wrapper: Wrapper },
    );
    expect(container).toBeEmptyDOMElement();
  });
});
