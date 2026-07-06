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
const mockListAgents = vi.hoisted(() => vi.fn());
const mockMutate = vi.hoisted(() => vi.fn());

const AGENTS = [
  { id: "agent-1", name: "Bohan", archived_at: null },
  { id: "agent-2", name: "Mira", archived_at: null },
];

vi.mock("@multica/core/api", () => ({
  api: {
    listRavenWorkflows: mockListWorkflows,
    listRavenWorkflowStats: mockListStats,
    listAgents: mockListAgents,
  },
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/issues/mutations", () => ({
  useCreateIssue: () => ({ mutate: mockMutate, isPending: false }),
}));

// Mock the searchable actor picker to a flat set of pick buttons — the popover
// UX is covered on its own surface; here we only need selection behaviour.
vi.mock("../issues/components/pickers/actor-picker", () => ({
  ActorPicker: ({
    visibleAgents,
    selectedAgent,
    onPick,
  }: {
    visibleAgents: Array<{ id: string; name: string }>;
    selectedAgent?: { name: string };
    onPick: (a: { type: "agent"; id: string }) => void;
  }) => (
    <div>
      {selectedAgent ? <span data-testid="creator-selected">{selectedAgent.name}</span> : null}
      {visibleAgents.map((a) => (
        <button
          key={a.id}
          type="button"
          data-testid={`pick-creator-${a.id}`}
          onClick={() => onPick({ type: "agent", id: a.id })}
        >
          {a.name}
        </button>
      ))}
    </div>
  ),
}));

// Render the multi-select popover contents inline so agent rows are clickable.
vi.mock("../issues/components/pickers/property-picker", () => ({
  PropertyPicker: ({ trigger, children }: { trigger: ReactNode; children: ReactNode }) => (
    <div>
      {trigger}
      {children}
    </div>
  ),
  PickerItem: ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  PickerEmpty: () => <div>empty</div>,
}));

vi.mock("../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="actor-avatar" />,
}));

vi.mock("../agents/components/skill-multi-select", () => ({
  SkillMultiSelect: ({
    selectedIds,
    onChange,
  }: {
    selectedIds: Set<string>;
    onChange: (next: Set<string>) => void;
  }) => (
    <button
      type="button"
      data-testid="toggle-skill"
      onClick={() => {
        const next = new Set(selectedIds);
        if (next.has("skill-1")) next.delete("skill-1");
        else next.add("skill-1");
        onChange(next);
      }}
    >
      toggle skill
    </button>
  ),
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
  mockListAgents.mockResolvedValue(AGENTS);
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

describe("CreateStrategyModal dual-mode (issue #26)", () => {
  function renderModal() {
    render(
      <CreateStrategyModal open onOpenChange={vi.fn()} authoringWorkflowId="wf-authoring" />,
      { wrapper: Wrapper },
    );
  }

  it("smart mode designates a single creator agent and dispatches to it (mode=auto)", async () => {
    mockMutate.mockImplementation((_data, opts) => opts?.onSuccess?.({ id: "issue-9" }));
    renderModal();

    await userEvent.type(screen.getByTestId("create-strategy-title"), "紧急修复交付策略");
    await userEvent.type(screen.getByTestId("create-strategy-intent"), "处理线上紧急缺陷");
    // Default mode is 智能/auto — designate one creator agent.
    await userEvent.click(await screen.findByTestId("pick-creator-agent-1"));
    await userEvent.click(screen.getByTestId("create-strategy-submit"));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    const [payload] = mockMutate.mock.calls[0]!;
    expect(payload.assignee_type).toBe("workflow");
    expect(payload.assignee_id).toBe("wf-authoring");
    expect(payload.raven_composition).toEqual({
      mode: "auto",
      agent_ids: ["agent-1"],
      skill_ids: [],
    });
    expect(pushMock).toHaveBeenCalledWith("/acme/issues/issue-9");
  });

  it("manual mode persists the selected agents and skills (mode=manual)", async () => {
    renderModal();

    await userEvent.click(screen.getByTestId("create-strategy-mode-manual"));
    await userEvent.type(screen.getByTestId("create-strategy-title"), "文档交付策略");
    // Pick two agents from the multi-select and one skill.
    await userEvent.click((await screen.findByText("Bohan")).closest("button")!);
    await userEvent.click(screen.getByText("Mira").closest("button")!);
    await userEvent.click(screen.getByTestId("toggle-skill"));
    await userEvent.click(screen.getByTestId("create-strategy-submit"));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    const [payload] = mockMutate.mock.calls[0]!;
    expect(payload.raven_composition.mode).toBe("manual");
    expect(payload.raven_composition.agent_ids).toEqual(["agent-1", "agent-2"]);
    expect(payload.raven_composition.skill_ids).toEqual(["skill-1"]);
  });

  it("keeps submit disabled without a title, and (with a title) until an agent is chosen", async () => {
    renderModal();
    // No title yet → disabled.
    expect(screen.getByTestId("create-strategy-submit")).toBeDisabled();

    await userEvent.type(screen.getByTestId("create-strategy-title"), "策略");
    // Title present but no agent → still disabled.
    expect(screen.getByTestId("create-strategy-submit")).toBeDisabled();

    await userEvent.click(await screen.findByTestId("pick-creator-agent-2"));
    expect(screen.getByTestId("create-strategy-submit")).not.toBeDisabled();
  });
});
