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
  ],
  total: 2,
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
    expect(screen.getAllByTestId("learning-item")).toHaveLength(2);
    // Provenance: stage + issue link.
    expect(screen.getByText("· execute")).toBeTruthy();
    const links = screen.getAllByText("View issue") as HTMLAnchorElement[];
    expect(links[0]?.getAttribute("href")).toBe("/acme/issues/issue-1");
    // Promoted entry shows its destination, and no triage actions.
    expect(screen.getByTestId("learning-promoted-to").textContent).toContain(
      "Facts & definitions",
    );
    expect(screen.getAllByTestId("learning-promote")).toHaveLength(1);
    expect(screen.getAllByTestId("learning-expire")).toHaveLength(1);
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
});
