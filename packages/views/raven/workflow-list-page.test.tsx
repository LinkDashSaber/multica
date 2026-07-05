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

const mockListWorkflows = vi.hoisted(() => vi.fn());
const mockListStats = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    listRavenWorkflows: mockListWorkflows,
    listRavenWorkflowStats: mockListStats,
  },
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

import { WorkflowListPage, formatRunDuration, formatRate } from "./workflow-list-page";

const WORKFLOWS = {
  workflows: [
    {
      id: "wf-1",
      workspace_id: "ws-1",
      name: "standard-delivery",
      description: "The standard delivery strategy",
      contract: undefined,
      version: 3,
      enabled: true,
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-02T00:00:00Z",
    },
    {
      id: "wf-2",
      workspace_id: "ws-1",
      name: "hotfix",
      description: "",
      contract: undefined,
      version: 1,
      enabled: false,
      created_at: "2026-06-03T00:00:00Z",
      updated_at: "2026-06-03T00:00:00Z",
    },
  ],
  total: 2,
};

const STATS = {
  stats: [
    {
      workflow_id: "wf-1",
      run_count: 8,
      active_runs: 2,
      avg_run_seconds: 200,
      approved_gates: 3,
      rejected_gates: 1,
    },
  ],
  total: 1,
};

const navigation: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/raven/workflows",
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
  mockListWorkflows.mockResolvedValue(WORKFLOWS);
  mockListStats.mockResolvedValue(STATS);
});

describe("WorkflowListPage", () => {
  it("renders workflow rows with stats: run count, pass/rejection rates, avg duration", async () => {
    render(<WorkflowListPage />, { wrapper: Wrapper });

    expect(await screen.findByText("standard-delivery")).toBeInTheDocument();
    expect(screen.getByText("v3")).toBeInTheDocument();

    const rows = await screen.findAllByTestId("workflow-row");
    expect(rows).toHaveLength(2);

    // wf-1: 8 runs (2 active), 3 approved / 1 rejected → 75% pass, 25%
    // rejection, 3m 20s.
    expect(rows[0]).toHaveTextContent("8");
    const activeCells = screen.getAllByTestId("workflow-active-runs");
    expect(activeCells[0]).toHaveTextContent("2");
    // wf-2 has no stats row → active runs default to 0.
    expect(activeCells[1]).toHaveTextContent("0");
    expect(rows[0]).toHaveTextContent("75%");
    expect(rows[0]).toHaveTextContent("25%");
    expect(rows[0]).toHaveTextContent("3m 20s");
    expect(rows[0]).toHaveTextContent("Enabled");

    // wf-2 has no stats row → zeros and em dashes.
    expect(rows[1]).toHaveTextContent("hotfix");
    expect(rows[1]).toHaveTextContent("Disabled");
    expect(rows[1]).toHaveTextContent("—");

    // Row links to the detail page.
    expect(screen.getByRole("link", { name: "standard-delivery" })).toHaveAttribute(
      "href",
      "/acme/raven/workflows/wf-1",
    );
  });

  it("shows the empty state when no workflows exist", async () => {
    mockListWorkflows.mockResolvedValue({ workflows: [], total: 0 });
    mockListStats.mockResolvedValue({ stats: [], total: 0 });
    render(<WorkflowListPage />, { wrapper: Wrapper });

    expect(
      await screen.findByText("No workflows registered yet"),
    ).toBeInTheDocument();
  });
});

describe("format helpers", () => {
  it("formatRunDuration", () => {
    expect(formatRunDuration(0)).toBe("—");
    expect(formatRunDuration(45)).toBe("45s");
    expect(formatRunDuration(200)).toBe("3m 20s");
    expect(formatRunDuration(3720)).toBe("1h 2m");
  });

  it("formatRate", () => {
    expect(formatRate(3, 4)).toBe("75%");
    expect(formatRate(0, 0)).toBe("—");
  });
});
