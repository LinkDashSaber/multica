// @vitest-environment jsdom

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { NavigationProvider } from "../navigation";
import type { NavigationAdapter } from "../navigation";
import enRaven from "../locales/en/raven.json";
import { sortDecisionQueue } from "./decision-queue-page";
import type { RavenDecisionPoint } from "@multica/core/raven";

const mockListDecisionPoints = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: { listRavenDecisionPoints: mockListDecisionPoints },
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

// Stub the heavy S6 letter card (it has its own test + async deps). Keep the
// real pure helpers this page also imports from the same module.
vi.mock("./decision-letter-card", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./decision-letter-card")>()),
  DecisionLetterCard: ({ kind, id }: { kind: string; id: string }) => (
    <div data-testid="letter-stub" data-kind={kind} data-id={id} />
  ),
}));

import { DecisionQueuePage } from "./decision-queue-page";
import { ravenKeys } from "@multica/core/raven";

function dp(over: Partial<RavenDecisionPoint>): RavenDecisionPoint {
  return {
    kind: "gate",
    id: "id",
    workspace_id: "ws-1",
    requirement_id: "req-1",
    run_id: null,
    stage: "review",
    title: "Untitled",
    context: undefined,
    response_kind: "verdict",
    status: "pending",
    created_at: "2026-07-01T00:00:00Z",
    ...over,
  };
}

const navigation: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/raven/decisions",
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

const ids = () =>
  screen.getAllByTestId("queue-item").map((el) => el.getAttribute("data-id"));
const activeId = () =>
  screen
    .getByRole("listitem", { current: true })
    .getAttribute("data-id");

describe("sortDecisionQueue", () => {
  it("orders oldest-pending first", () => {
    const out = sortDecisionQueue([
      dp({ id: "new", created_at: "2026-07-03T00:00:00Z" }),
      dp({ id: "old", created_at: "2026-07-01T00:00:00Z" }),
      dp({ id: "mid", created_at: "2026-07-02T00:00:00Z" }),
    ]);
    expect(out.map((i) => i.id)).toEqual(["old", "mid", "new"]);
  });

  it("sorts unparsable timestamps last and breaks ties by id", () => {
    const out = sortDecisionQueue([
      dp({ id: "b", created_at: "" }),
      dp({ id: "a", created_at: "2026-07-01T00:00:00Z" }),
      dp({ id: "c", created_at: "2026-07-01T00:00:00Z" }),
    ]);
    expect(out.map((i) => i.id)).toEqual(["a", "c", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [dp({ id: "x", created_at: "2026-07-03T00:00:00Z" }), dp({ id: "y", created_at: "2026-07-01T00:00:00Z" })];
    sortDecisionQueue(input);
    expect(input.map((i) => i.id)).toEqual(["x", "y"]);
  });
});

describe("DecisionQueuePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigation.push = vi.fn();
  });

  it("lists decision points oldest-first with the three at-a-glance facts", async () => {
    mockListDecisionPoints.mockResolvedValue({
      items: [
        dp({ id: "new", title: "Ship it", stage: "release", created_at: "2026-07-03T00:00:00Z" }),
        dp({ id: "old", kind: "clarify", title: "Need scope", stage: "spec", created_at: "2026-07-01T00:00:00Z" }),
      ],
      total: 2,
    });

    render(<DecisionQueuePage />, { wrapper: Wrapper });

    await screen.findByTestId("queue-list");
    // Oldest (old / spec) sits above newest (new / release).
    expect(ids()).toEqual(["old", "new"]);
    // Three facts: requirement title, stuck stage, pending age.
    expect(screen.getByText("Need scope")).toBeTruthy();
    expect(screen.getAllByTestId("queue-item-stage").map((e) => e.textContent)).toEqual(["spec", "release"]);
    expect(screen.getAllByTestId("queue-item-age")).toHaveLength(2);
    // Each row renders the (stubbed) letter card, gate rows get a detail href.
    expect(screen.getAllByTestId("letter-stub")).toHaveLength(2);
    // Toolbar shows the remaining count.
    expect(screen.getByTestId("queue-toolbar").textContent).toContain("2 waiting on you");
  });

  it("walks the queue with Next / Back to top", async () => {
    mockListDecisionPoints.mockResolvedValue({
      items: [
        dp({ id: "a", created_at: "2026-07-01T00:00:00Z" }),
        dp({ id: "b", created_at: "2026-07-02T00:00:00Z" }),
        dp({ id: "c", created_at: "2026-07-03T00:00:00Z" }),
      ],
      total: 3,
    });
    const user = userEvent.setup();
    render(<DecisionQueuePage />, { wrapper: Wrapper });

    await screen.findByTestId("queue-list");
    expect(activeId()).toBe("a");

    await user.click(screen.getByText("Next"));
    expect(activeId()).toBe("b");

    await user.click(screen.getByText("Next"));
    expect(activeId()).toBe("c");

    await user.click(screen.getByText("Back to top"));
    expect(activeId()).toBe("a");
  });

  it("shows the empty state when nothing is waiting", async () => {
    mockListDecisionPoints.mockResolvedValue({ items: [], total: 0 });
    render(<DecisionQueuePage />, { wrapper: Wrapper });

    expect(await screen.findByTestId("queue-empty")).toBeTruthy();
    expect(screen.getByText("Nothing needs your call")).toBeTruthy();
  });

  it("drops resolved items as the query cache shrinks and reaches the empty state", async () => {
    // A resolved decision point leaves the cache (its card invalidates the
    // query). Drive that directly via setQueryData so the reactivity — not a
    // 15s poll — is what's under test.
    mockListDecisionPoints.mockResolvedValue({
      items: [
        dp({ id: "a", created_at: "2026-07-01T00:00:00Z" }),
        dp({ id: "b", created_at: "2026-07-02T00:00:00Z" }),
      ],
      total: 2,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = ravenKeys.pendingDecisionPoints("ws-1");
    function LocalWrapper({ children }: { children: ReactNode }) {
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

    render(<DecisionQueuePage />, { wrapper: LocalWrapper });
    await screen.findByTestId("queue-list");
    expect(ids()).toEqual(["a", "b"]);

    // "a" resolved → cache holds only "b"; the queue drops the resolved row.
    act(() => {
      qc.setQueryData(key, [dp({ id: "b", created_at: "2026-07-02T00:00:00Z" })]);
    });
    await waitFor(() => expect(ids()).toEqual(["b"]));

    // last one resolved → empty state.
    act(() => {
      qc.setQueryData(key, []);
    });
    await waitFor(() => expect(screen.queryByTestId("queue-empty")).toBeTruthy());
  });
});
