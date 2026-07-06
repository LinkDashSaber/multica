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

const mockListLearnings = vi.hoisted(() => vi.fn());
const mockUpdateStatus = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    listRavenLearnings: mockListLearnings,
    updateRavenLearningStatus: mockUpdateStatus,
  },
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

import { LearningStreamPage } from "./learning-stream-page";

const LEARNINGS = {
  learnings: [
    {
      id: "l-1",
      workspace_id: "ws-1",
      run_id: "12345678-aaaa-bbbb-cccc-000000000001",
      stage: "execute",
      content: "先读现有测试再动手",
      status: "fresh",
      promoted_to: "",
      issue_id: "issue-1",
      created_at: "2026-07-01T10:00:00Z",
      updated_at: "2026-07-01T10:00:00Z",
    },
    {
      id: "l-2",
      workspace_id: "ws-1",
      run_id: "12345678-aaaa-bbbb-cccc-000000000002",
      stage: "self-check",
      content: "typecheck 必须在提交前重跑",
      status: "promoted",
      promoted_to: "fact",
      issue_id: "issue-2",
      created_at: "2026-07-02T10:00:00Z",
      updated_at: "2026-07-02T11:00:00Z",
    },
    {
      id: "l-3",
      workspace_id: "ws-1",
      run_id: "12345678-aaaa-bbbb-cccc-000000000003",
      stage: "plan",
      content: "抽象出可复用的 lint 修复步骤",
      status: "promoted",
      promoted_to: "skill_proposal",
      issue_id: "issue-3",
      asset: {
        id: "a-3",
        kind: "skill_proposal",
        title: "抽象出可复用的 lint 修复步骤",
        skill_id: "skl-3",
        workflow_id: "",
      },
      created_at: "2026-07-03T10:00:00Z",
      updated_at: "2026-07-03T11:00:00Z",
    },
  ],
  total: 3,
};

const navigation: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/raven/learnings",
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
  mockListLearnings.mockResolvedValue(LEARNINGS);
  mockUpdateStatus.mockResolvedValue({ ...LEARNINGS.learnings[0], status: "expired" });
});

describe("LearningStreamPage", () => {
  it("lists learnings with content, provenance and status", async () => {
    render(<LearningStreamPage />, { wrapper: Wrapper });

    expect(await screen.findByText("先读现有测试再动手")).toBeTruthy();
    expect(screen.getAllByTestId("learning-item")).toHaveLength(3);
    // Structured evidence (#29): labeled real fields, not a raw string.
    expect(screen.getAllByText("Source run").length).toBe(3);
    expect(screen.getAllByText("Self-report").length).toBe(3);
    expect(screen.getByText("execute")).toBeTruthy(); // stage value
    const runLinks = screen.getAllByText("run 12345678") as HTMLAnchorElement[];
    expect(runLinks[0]?.getAttribute("href")).toBe(
      "/acme/raven/runs/12345678-aaaa-bbbb-cccc-000000000001",
    );
    const links = screen.getAllByText("View issue") as HTMLAnchorElement[];
    expect(links[0]?.getAttribute("href")).toBe("/acme/issues/issue-1");
    // Promoted entry shows its destination, and no triage actions.
    expect(screen.getAllByTestId("learning-promoted-to")[0]?.textContent).toContain(
      "Facts & definitions",
    );
    expect(screen.getAllByTestId("learning-promote")).toHaveLength(1);
    expect(screen.getAllByTestId("learning-expire")).toHaveLength(1);
    // A skill promotion links back to the minted skill draft (#28).
    const assetLink = screen.getByTestId("learning-asset-link") as HTMLAnchorElement;
    expect(assetLink.textContent).toContain("View skill draft");
    expect(assetLink.getAttribute("href")).toBe("/acme/skills/skl-3");
  });

  it("promotes a fresh learning towards a chosen destination", async () => {
    const user = userEvent.setup();
    render(<LearningStreamPage />, { wrapper: Wrapper });

    await user.click(await screen.findByTestId("learning-promote"));
    await user.click(await screen.findByTestId("learning-promote-uptrack_evidence"));

    await waitFor(() =>
      expect(mockUpdateStatus).toHaveBeenCalledWith("l-1", {
        status: "promoted",
        promoted_to: "uptrack_evidence",
      }),
    );
  });

  it("expires a fresh learning and refetches the stream", async () => {
    const user = userEvent.setup();
    render(<LearningStreamPage />, { wrapper: Wrapper });

    await user.click(await screen.findByTestId("learning-expire"));

    await waitFor(() =>
      expect(mockUpdateStatus).toHaveBeenCalledWith("l-1", {
        status: "expired",
        promoted_to: undefined,
      }),
    );
    // onSettled invalidation refetches the list.
    await waitFor(() => expect(mockListLearnings.mock.calls.length).toBeGreaterThan(1));
  });

  it("shows the empty state when there are no learnings", async () => {
    mockListLearnings.mockResolvedValue({ learnings: [], total: 0 });
    render(<LearningStreamPage />, { wrapper: Wrapper });

    expect(await screen.findByText("No self-reported learnings yet")).toBeTruthy();
  });

  it("explains the mechanism and each destination inline, even on first run (#29)", async () => {
    mockListLearnings.mockResolvedValue({ learnings: [], total: 0 });
    render(<LearningStreamPage />, { wrapper: Wrapper });

    // Mechanism guidance is present on the empty first-run.
    const about = await screen.findByTestId("learnings-about");
    expect(about.textContent).toContain("self-evolution loop");
    // Each of the three destinations names its one-line purpose.
    const legend = screen.getByTestId("learnings-destinations");
    expect(legend.textContent).toContain("Abstract into a reusable skill draft");
    expect(legend.textContent).toContain("Pin as a workspace fact & definition");
    expect(legend.textContent).toContain("uptrack evidence backing this workflow gate");
  });

  it("shows each promote destination's purpose in the menu (#29)", async () => {
    const user = userEvent.setup();
    render(<LearningStreamPage />, { wrapper: Wrapper });

    await user.click(await screen.findByTestId("learning-promote"));
    const skillItem = await screen.findByTestId("learning-promote-skill_proposal");
    expect(skillItem.textContent).toContain("Skill proposal");
    expect(skillItem.textContent).toContain("Abstract into a reusable skill draft");
  });
});
