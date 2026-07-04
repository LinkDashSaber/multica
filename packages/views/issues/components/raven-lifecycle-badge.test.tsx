// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";
import { RavenLifecycleBadge } from "./raven-lifecycle-badge";

// Drive the badge through a mocked requirement query: `useQuery` just returns
// whatever the test pins on `mockState`, so we exercise the render branches
// without a QueryClient or network.
const mockState = vi.hoisted(() => ({
  requirement: undefined as unknown,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mockState.requirement }),
}));

vi.mock("@multica/core/raven", () => ({
  issueRequirementOptions: () => ({ queryKey: ["raven-requirement"] }),
}));

function renderBadge(locale?: "en" | "zh-Hans" | "ja" | "ko") {
  return renderWithI18n(
    <RavenLifecycleBadge wsId="ws-1" issueId="issue-1" />,
    locale ? { locale } : {},
  );
}

beforeEach(() => {
  mockState.requirement = undefined;
});

afterEach(cleanup);

describe("RavenLifecycleBadge", () => {
  it("shows a tooltip listing next states in API order on focus", async () => {
    mockState.requirement = {
      state: "running",
      next_states: ["needs_review", "merged"],
    };
    renderBadge();

    const badge = screen.getByTestId("raven-lifecycle-badge");
    fireEvent.focus(badge.parentElement!);

    await waitFor(() =>
      expect(
        screen.getByText("Can advance to: Needs Review, Merged"),
      ).toBeTruthy(),
    );
  });

  it("localizes the prefix and separator", async () => {
    mockState.requirement = {
      state: "running",
      next_states: ["needs_review", "merged"],
    };
    renderBadge("zh-Hans");

    fireEvent.focus(screen.getByTestId("raven-lifecycle-badge").parentElement!);

    await waitFor(() =>
      expect(
        screen.getByText("可推进到：Needs Review、Merged"),
      ).toBeTruthy(),
    );
  });

  it("renders no tooltip wrapper when there are no next states", () => {
    mockState.requirement = { state: "learned", next_states: [] };
    renderBadge();

    const badge = screen.getByTestId("raven-lifecycle-badge");
    // The bare badge is not wrapped in the focusable tooltip trigger span.
    expect(badge.parentElement?.getAttribute("tabindex")).toBeNull();
  });

  it("renders nothing for a bare issue (no requirement)", () => {
    mockState.requirement = null;
    const { container } = renderBadge();
    expect(container.firstChild).toBeNull();
  });
});
