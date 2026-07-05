import { describe, it, expect } from "vitest";
import type { TimelineEntry } from "@multica/core/types";
import {
  clarificationQuestions,
  clarificationsToGraphInput,
  contractMaxTokens,
  mergeRunTimeline,
  runDurationSeconds,
} from "./run-room-model";

const RUN = {
  id: "run-1",
  workspace_id: "ws-1",
  requirement_id: "req-1",
  workflow_id: "wf-1",
  trigger_run_id: "",
  status: "running",
  current_stage: "execute",
  termination_reason: "",
  tokens_spent: 500,
  usd_spent: 0,
  created_at: "2026-07-01T10:00:00Z",
  updated_at: "2026-07-01T10:00:00Z",
};

function clarification(overrides: Record<string, unknown> = {}) {
  return {
    id: "c-1",
    workspace_id: "ws-1",
    requirement_id: "req-1",
    run_id: "run-1",
    stage: "execute",
    questions: [{ question: "用哪个方案？" }],
    status: "pending",
    answer: "",
    answered_by: null,
    created_at: "2026-07-01T10:05:00Z",
    answered_at: null,
    ...overrides,
  };
}

function comment(id: string, at: string, content = "看起来不错"): TimelineEntry {
  return {
    type: "comment",
    id,
    actor_type: "member",
    actor_id: "u-1",
    created_at: at,
    content,
  } as TimelineEntry;
}

describe("clarificationQuestions", () => {
  it("reads object and bare-string forms, skipping malformed entries", () => {
    expect(
      clarificationQuestions([{ question: "Q1" }, "Q2", { nope: true }, "", 42]),
    ).toEqual(["Q1", "Q2"]);
    expect(clarificationQuestions("not an array")).toEqual([]);
    expect(clarificationQuestions(undefined)).toEqual([]);
  });
});

describe("clarificationsToGraphInput", () => {
  it("keeps this run's and unbound records, joins multi-question text", () => {
    const input = clarificationsToGraphInput(
      [
        clarification({ questions: [{ question: "Q1" }, { question: "Q2" }] }),
        clarification({ id: "c-2", run_id: "run-other" }),
        clarification({ id: "c-3", run_id: null, stage: "" }),
        clarification({ id: "c-4", questions: [] }),
      ],
      "run-1",
    );
    expect(input.map((c) => c.id)).toEqual(["c-1", "c-3"]);
    expect(input[0]!.question).toBe("Q1 / Q2");
    expect(input[0]!.stage).toBe("execute");
    expect(input[0]!.answer).toBeUndefined();
    expect(input[1]!.stage).toBeUndefined();
  });

  it("carries the answer only for answered records", () => {
    const input = clarificationsToGraphInput(
      [clarification({ status: "answered", answer: "方案 A", answered_at: "2026-07-01T10:30:00Z" })],
      "run-1",
    );
    expect(input[0]!.answer).toBe("方案 A");
  });
});

describe("mergeRunTimeline", () => {
  it("merges all sources chronologically, oldest first", () => {
    const items = mergeRunTimeline({
      run: RUN,
      events: [
        { id: "e-1", run_id: "run-1", stage: "clarify", event: "entered", created_at: "2026-07-01T10:01:00Z" },
        { id: "e-2", run_id: "run-1", stage: "clarify", event: "exited", created_at: "2026-07-01T10:10:00Z" },
        { id: "e-x", run_id: "run-other", stage: "clarify", event: "entered", created_at: "2026-07-01T10:02:00Z" },
      ],
      evidence: [
        {
          id: "ev-1", requirement_id: "req-1", run_id: "run-1",
          kind: "test_result", source: "ci", summary: "**12 passed**", payload: undefined,
          created_at: "2026-07-01T10:08:00Z",
        },
        {
          id: "ev-2", requirement_id: "req-1", run_id: "run-other",
          kind: "diff", source: "", summary: "", payload: undefined,
          created_at: "2026-07-01T10:09:00Z",
        },
      ],
      gateReviews: [
        {
          id: "g-1", workspace_id: "ws-1", requirement_id: "req-1", run_id: "run-1",
          gate_name: "spec-confirm", status: "approved", review_package: undefined,
          decided_by: "u-1", decision_reason: "", sample_result: "", created_at: "2026-07-01T10:11:00Z",
          decided_at: "2026-07-01T10:20:00Z",
        },
      ],
      clarifications: [
        clarification({
          status: "answered", answer: "方案 A", answered_at: "2026-07-01T10:07:00Z",
        }),
      ],
      comments: [
        comment("cm-1", "2026-07-01T10:15:00Z"),
        comment("cm-early", "2026-07-01T09:00:00Z"), // before the run started
      ],
    });

    expect(items.map((i) => i.kind)).toEqual([
      "stage", // clarify entered 10:01
      "clarification_asked", // 10:05
      "clarification_answered", // 10:07
      "evidence", // 10:08
      "stage", // clarify exited 10:10
      "gate_opened", // 10:11
      "comment", // 10:15
      "gate_decided", // 10:20
    ]);
  });

  it("keeps only comments inside a terminal run's window", () => {
    const items = mergeRunTimeline({
      run: { ...RUN, status: "completed", updated_at: "2026-07-01T11:00:00Z" },
      comments: [
        comment("cm-in", "2026-07-01T10:30:00Z"),
        comment("cm-late", "2026-07-01T12:00:00Z"),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("comment:cm-in");
  });

  it("skips pending gates' decided entry and unanswered clarifications' answer entry", () => {
    const items = mergeRunTimeline({
      run: RUN,
      gateReviews: [
        {
          id: "g-2", workspace_id: "ws-1", requirement_id: "req-1", run_id: "run-1",
          gate_name: "human-review", status: "pending", review_package: undefined,
          decided_by: null, decision_reason: "", sample_result: "", created_at: "2026-07-01T10:30:00Z",
          decided_at: null,
        },
      ],
      clarifications: [clarification()],
    });
    expect(items.map((i) => i.kind)).toEqual(["clarification_asked", "gate_opened"]);
  });
});

describe("runDurationSeconds", () => {
  it("uses now while live and updated_at when terminal", () => {
    expect(runDurationSeconds(RUN, "2026-07-01T10:10:00Z")).toBe(600);
    expect(
      runDurationSeconds(
        { ...RUN, status: "terminated", updated_at: "2026-07-01T10:05:00Z" },
        "2026-07-01T12:00:00Z",
      ),
    ).toBe(300);
    expect(runDurationSeconds({ ...RUN, created_at: "" }, "2026-07-01T10:10:00Z")).toBeNull();
  });
});

describe("contractMaxTokens", () => {
  it("reads max_tokens, falls back to max_total_tokens, rejects junk", () => {
    expect(contractMaxTokens({ budget: { max_tokens: 1000 } })).toBe(1000);
    expect(contractMaxTokens({ budget: { max_total_tokens: 2000 } })).toBe(2000);
    expect(contractMaxTokens({ budget: { max_tokens: 0 } })).toBeNull();
    expect(contractMaxTokens({ budget: "nope" })).toBeNull();
    expect(contractMaxTokens(null)).toBeNull();
  });
});
