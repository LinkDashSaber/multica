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

const mockListWorkflows = vi.hoisted(() => vi.fn());
const mockListStats = vi.hoisted(() => vi.fn());
const mockMutate = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    listRavenWorkflows: mockListWorkflows,
    listRavenWorkflowStats: mockListStats,
  },
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/issues/mutations", () => ({
  useCreateIssue: () => ({ mutate: mockMutate, isPending: false }),
}));

import { WorkflowListPage } from "./workflow-list-page";
import { CreateStrategyModal } from "./create-strategy-modal";

const AUTHORING_WF = {
  id: "wf-authoring",
  workspace_id: "ws-1",
  name: "workflow-authoring",
  description: "内置建策略策略",
  contract: undefined,
  version: 1,
  enabled: true,
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
};

const pushMock = vi.fn();
const navigation: NavigationAdapter = {
  push: pushMock,
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/raven/workflows",
  searchParams: new URLSearchParams(),
  getShareableUrl: (p) => p,
};

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  mockListStats.mockResolvedValue({ stats: [], total: 0 });
});

describe("workflow list create-strategy entry", () => {
  it("enables the button when the authoring strategy is registered", async () => {
    mockListWorkflows.mockResolvedValue({ workflows: [AUTHORING_WF], total: 1 });
    render(<WorkflowListPage />, { wrapper: Wrapper });

    // The row list confirms the query resolved; the button flips to enabled.
    await screen.findByText("workflow-authoring");
    await waitFor(() =>
      expect(screen.getByTestId("create-strategy-button")).toBeEnabled(),
    );
  });

  it("disables the button when workflow-authoring is missing or disabled", async () => {
    mockListWorkflows.mockResolvedValue({
      workflows: [{ ...AUTHORING_WF, enabled: false }],
      total: 1,
    });
    render(<WorkflowListPage />, { wrapper: Wrapper });

    const button = await screen.findByTestId("create-strategy-button");
    expect(button).toBeDisabled();
  });
});

describe("CreateStrategyModal", () => {
  it("creates an issue assigned to the authoring workflow and navigates to it", async () => {
    mockMutate.mockImplementation((_data, opts) => {
      opts?.onSuccess?.({ id: "issue-9" });
    });
    render(
      <CreateStrategyModal
        open
        onOpenChange={vi.fn()}
        authoringWorkflowId="wf-authoring"
      />,
      { wrapper: Wrapper },
    );

    await userEvent.type(
      screen.getByTestId("create-strategy-title"),
      "紧急修复交付策略",
    );
    await userEvent.type(
      screen.getByTestId("create-strategy-intent"),
      "处理线上紧急缺陷的小步快跑交付",
    );
    await userEvent.click(screen.getByTestId("create-strategy-submit"));

    expect(mockMutate).toHaveBeenCalledWith(
      {
        title: "紧急修复交付策略",
        description: "处理线上紧急缺陷的小步快跑交付",
        assignee_type: "workflow",
        assignee_id: "wf-authoring",
      },
      expect.anything(),
    );
    expect(pushMock).toHaveBeenCalledWith("/acme/issues/issue-9");
  });

  it("keeps submit disabled without a title", () => {
    render(
      <CreateStrategyModal
        open
        onOpenChange={vi.fn()}
        authoringWorkflowId="wf-authoring"
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByTestId("create-strategy-submit")).toBeDisabled();
  });
});
