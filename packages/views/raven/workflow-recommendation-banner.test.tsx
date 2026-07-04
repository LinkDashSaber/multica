// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../test/i18n";
import { WorkflowRecommendationBanner } from "./workflow-recommendation-banner";

const mockState = vi.hoisted(() => ({
  recommendation: null as unknown,
  recorded: [] as { id: string; outcome: string }[],
}));

vi.mock("@multica/core/raven", () => ({
  useRequestRavenRecommendation: () => ({
    mutate: (_data: unknown, opts?: { onSuccess?: (res: unknown) => void }) => {
      opts?.onSuccess?.({ recommendation: mockState.recommendation });
    },
  }),
  useRecordRavenRecommendationOutcome: () => ({
    mutate: (vars: { id: string; outcome: string }) => {
      mockState.recorded.push(vars);
    },
  }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  mockState.recommendation = null;
  mockState.recorded = [];
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function renderBanner(overrides?: Partial<Parameters<typeof WorkflowRecommendationBanner>[0]>) {
  const onUseWorkflow = vi.fn();
  const onFallbackSquad = vi.fn();
  renderWithI18n(
    <WorkflowRecommendationBanner
      title="修复登录页在移动端的样式问题"
      hasAssignee={false}
      onUseWorkflow={onUseWorkflow}
      onFallbackSquad={onFallbackSquad}
      {...overrides}
    />,
    {},
  );
  // Flush the debounce inside act so the resulting setState lands.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700);
  });
  return { onUseWorkflow, onFallbackSquad };
}

describe("WorkflowRecommendationBanner", () => {
  it("applies the workflow and records accepted on 使用", async () => {
    mockState.recommendation = {
      id: "rec-1",
      workflow_id: "wf-1",
      workflow_name: "feature-delivery",
      score: 0.8,
      reason: "标题关键词匹配",
      outcome: "pending",
    };
    const { onUseWorkflow } = await renderBanner();

    fireEvent.click(screen.getByText("Use"));
    expect(onUseWorkflow).toHaveBeenCalledWith("wf-1");
    expect(mockState.recorded).toEqual([{ id: "rec-1", outcome: "accepted" }]);
    expect(screen.queryByTestId("workflow-recommendation-banner")).toBeNull();
  });

  it("offers the squad fallback when no workflow matches", async () => {
    mockState.recommendation = {
      id: "rec-2",
      workflow_id: null,
      workflow_name: "",
      score: 0,
      reason: "no confident match",
      outcome: "pending",
    };
    const { onFallbackSquad, onUseWorkflow } = await renderBanner();

    fireEvent.click(screen.getByText("Pick a squad"));
    expect(onFallbackSquad).toHaveBeenCalled();
    expect(onUseWorkflow).not.toHaveBeenCalled();
    expect(mockState.recorded).toEqual([{ id: "rec-2", outcome: "fallback_squad" }]);
  });

  it("ignore dismisses the banner and records the outcome", async () => {
    mockState.recommendation = {
      id: "rec-3",
      workflow_id: "wf-1",
      workflow_name: "feature-delivery",
      score: 0.5,
      reason: "",
      outcome: "pending",
    };
    await renderBanner();

    fireEvent.click(screen.getByLabelText("Ignore"));
    expect(mockState.recorded).toEqual([{ id: "rec-3", outcome: "ignored" }]);
    expect(screen.queryByTestId("workflow-recommendation-banner")).toBeNull();
  });

  it("stays silent when an assignee is already chosen", async () => {
    mockState.recommendation = {
      id: "rec-4",
      workflow_id: "wf-1",
      workflow_name: "feature-delivery",
      score: 0.9,
      reason: "",
      outcome: "pending",
    };
    await renderBanner({ hasAssignee: true });
    expect(screen.queryByTestId("workflow-recommendation-banner")).toBeNull();
  });
});
