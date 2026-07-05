import { describe, expect, it } from "vitest";
import { deriveRunGraph } from "./run-graph-model";
import type {
  RavenEvidence,
  RavenGateReview,
  RavenRun,
  RavenRunStageEvent,
} from "@multica/core/raven";

const STAGES = [
  { name: "clarify", description: "澄清拍板问题" },
  { name: "execute" },
  { name: "learn" },
];
const GATES = [{ name: "spec-confirm", after_stage: "clarify" }];

function makeRun(overrides: Partial<RavenRun> = {}): RavenRun {
  return {
    id: "run-1",
    workspace_id: "ws-1",
    requirement_id: "req-1",
    workflow_id: "wf-1",
    trigger_run_id: "",
    status: "running",
    current_stage: "",
    termination_reason: "",
    tokens_spent: 1234,
    usd_spent: 0,
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-01T10:00:00Z",
    ...overrides,
  };
}

function event(
  stage: string,
  kind: "entered" | "exited",
  at: string,
  id = `${stage}-${kind}-${at}`,
): RavenRunStageEvent {
  return { id, run_id: "run-1", stage, event: kind, created_at: at };
}

function review(overrides: Partial<RavenGateReview> = {}): RavenGateReview {
  return {
    id: "gate-1",
    workspace_id: "ws-1",
    requirement_id: "req-1",
    run_id: "run-1",
    gate_name: "spec-confirm",
    status: "pending",
    review_package: undefined,
    decided_by: null,
    decision_reason: "",
    sample_result: "",
    created_at: "2026-07-01T10:31:00Z",
    decided_at: null,
    ...overrides,
  };
}

function evidenceItem(overrides: Partial<RavenEvidence> = {}): RavenEvidence {
  return {
    id: "ev-1",
    requirement_id: "req-1",
    run_id: "run-1",
    kind: "diff",
    source: "agent",
    summary: "changed 3 files",
    payload: undefined,
    created_at: "2026-07-01T10:10:00Z",
    ...overrides,
  };
}

describe("deriveRunGraph — design mode", () => {
  it("renders the contract as a ghost skeleton with gates after their stage", () => {
    const graph = deriveRunGraph({ stages: STAGES, gates: GATES });

    expect(graph.mode).toBe("design");
    // Trunk order: clarify, spec-confirm (after clarify), execute, learn.
    expect(graph.nodes.map((n) => n.id)).toEqual([
      "stage:clarify",
      "gate:spec-confirm",
      "stage:execute",
      "stage:learn",
    ]);
    expect(graph.nodes.map((n) => n.column)).toEqual([0, 1, 2, 3]);
    expect(graph.columns).toBe(4);
    expect(
      graph.nodes.every((n) => n.kind !== "clarification" && n.state === "ghost"),
    ).toBe(true);
    expect(graph.edges.map((e) => e.state)).toEqual(["ghost", "ghost", "ghost"]);
    // Description survives for hover tooltips.
    const clarify = graph.nodes[0]!;
    expect(clarify.kind === "stage" && clarify.description).toBe("澄清拍板问题");
  });
});

describe("deriveRunGraph — run mode", () => {
  it("overlays done / active / pending states and flowing edges", () => {
    const graph = deriveRunGraph({
      stages: STAGES,
      gates: GATES,
      run: makeRun({ current_stage: "execute" }),
      events: [
        event("clarify", "entered", "2026-07-01T10:00:00Z"),
        event("clarify", "exited", "2026-07-01T10:30:00Z"),
        event("execute", "entered", "2026-07-01T10:31:00Z"),
      ],
      gateReviews: [
        review({ status: "approved", decided_at: "2026-07-01T10:32:00Z" }),
      ],
    });

    expect(graph.mode).toBe("run");
    const states = Object.fromEntries(
      graph.nodes.flatMap((n) =>
        n.kind === "clarification" ? [] : [[n.id, n.state] as const],
      ),
    );
    expect(states).toEqual({
      "stage:clarify": "done",
      "gate:spec-confirm": "approved",
      "stage:execute": "active",
      "stage:learn": "pending",
    });
    expect(graph.edges.map((e) => [e.kind, e.state])).toEqual([
      ["forward", "done"],
      ["forward", "done"],
      ["forward", "pending"],
    ]);
    // Completed stage duration from the entered→exited time delta.
    const clarify = graph.nodes.find((n) => n.id === "stage:clarify");
    expect(clarify?.kind === "stage" && clarify.durationSeconds).toBe(1800);
  });

  it("marks a gate with an undecided review as waiting (拍板点)", () => {
    const pending = review();
    const graph = deriveRunGraph({
      stages: STAGES,
      gates: GATES,
      run: makeRun(),
      events: [
        event("clarify", "entered", "2026-07-01T10:00:00Z"),
        event("clarify", "exited", "2026-07-01T10:30:00Z"),
      ],
      gateReviews: [pending],
    });

    const gate = graph.nodes.find((n) => n.id === "gate:spec-confirm");
    expect(gate?.kind === "gate" && gate.state).toBe("waiting");
    expect(gate?.kind === "gate" && gate.pendingReview?.id).toBe("gate-1");
  });

  it("derives a rework back-edge with ×N count and the rejection reason", () => {
    const graph = deriveRunGraph({
      stages: STAGES,
      gates: GATES,
      run: makeRun(),
      events: [
        event("clarify", "entered", "2026-07-01T10:00:00Z", "e1"),
        event("clarify", "exited", "2026-07-01T10:10:00Z", "e2"),
        event("clarify", "entered", "2026-07-01T10:20:00Z", "e3"),
        event("clarify", "exited", "2026-07-01T10:30:00Z", "e4"),
      ],
      gateReviews: [
        review({
          id: "gate-r1",
          status: "rejected",
          decision_reason: "范围不清晰",
          created_at: "2026-07-01T10:11:00Z",
        }),
        review({ id: "gate-r2", created_at: "2026-07-01T10:31:00Z" }),
      ],
    });

    const rework = graph.edges.find((e) => e.kind === "rework");
    expect(rework).toMatchObject({
      from: "gate:spec-confirm",
      to: "stage:clarify",
      reworkCount: 1,
      reworkReason: "范围不清晰",
    });
    // Both visits count toward the stage's total duration.
    const clarify = graph.nodes.find((n) => n.id === "stage:clarify");
    expect(clarify?.kind === "stage" && clarify.durationSeconds).toBe(1200);
    expect(clarify?.kind === "stage" && clarify.enteredCount).toBe(2);
  });

  it("buckets evidence into the stage whose time window contains it", () => {
    const inClarify = evidenceItem({ id: "ev-1", created_at: "2026-07-01T10:10:00Z" });
    const inExecute = evidenceItem({ id: "ev-2", created_at: "2026-07-01T10:40:00Z" });
    const otherRun = evidenceItem({ id: "ev-3", run_id: "run-9" });
    const graph = deriveRunGraph({
      stages: STAGES,
      gates: GATES,
      run: makeRun({ current_stage: "execute" }),
      events: [
        event("clarify", "entered", "2026-07-01T10:00:00Z"),
        event("clarify", "exited", "2026-07-01T10:30:00Z"),
        event("execute", "entered", "2026-07-01T10:31:00Z"),
      ],
      evidence: [inClarify, inExecute, otherRun],
      now: "2026-07-01T10:41:00Z",
    });

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const clarify = byId.get("stage:clarify");
    const execute = byId.get("stage:execute");
    expect(clarify?.kind === "stage" && clarify.evidence.map((e) => e.id)).toEqual(["ev-1"]);
    expect(execute?.kind === "stage" && execute.evidence.map((e) => e.id)).toEqual(["ev-2"]);
    // The active stage's open interval closes with `now` for a live duration.
    expect(execute?.kind === "stage" && execute.durationSeconds).toBe(600);
  });

  it("renders clarification Q&A as temporary nodes attached to their stage", () => {
    const graph = deriveRunGraph({
      stages: STAGES,
      gates: GATES,
      run: makeRun({ current_stage: "clarify" }),
      events: [event("clarify", "entered", "2026-07-01T10:00:00Z")],
      clarifications: [
        { id: "q1", question: "目标用户是谁？", answer: "内部研发团队", stage: "clarify" },
        { id: "q2", question: "要支持移动端吗？" },
      ],
    });

    const clarifications = graph.nodes.filter((n) => n.kind === "clarification");
    expect(clarifications).toHaveLength(2);
    expect(clarifications[0]).toMatchObject({
      id: "clarification:q1",
      column: 0,
      question: "目标用户是谁？",
      answer: "内部研发团队",
    });
    // Unpinned question falls back to the active stage's column.
    expect(clarifications[1]?.column).toBe(0);
  });

  it("marks every stage done when the run completed without exit events", () => {
    const graph = deriveRunGraph({
      stages: STAGES,
      gates: GATES,
      run: makeRun({ status: "completed" }),
      events: [],
    });
    const stageStates = graph.nodes
      .filter((n) => n.kind === "stage")
      .map((n) => n.state);
    expect(stageStates).toEqual(["done", "done", "done"]);
  });
});
