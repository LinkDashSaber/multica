// Pure derivation of the live run graph (issue #17, ADR-0007: the canvas is
// a viewer, never an editor). The graph is a projection of the contract
// topology (design mode) with the selected run's real path overlaid (run
// mode). No React, no time source of its own — callers pass `now` so the
// output is fully deterministic and vitest-assertable.

import type {
  ContractGateView,
  ContractStageView,
  RavenEvidence,
  RavenGateReview,
  RavenRun,
  RavenRunStageEvent,
} from "@multica/core/raven";

export type RunGraphMode = "design" | "run";

/** ghost = design skeleton; the rest only appear in run mode. */
export type RunGraphStageState = "ghost" | "done" | "active" | "pending";
export type RunGraphGateState =
  | "ghost"
  | "idle"
  | "waiting"
  | "approved"
  | "rejected";

export interface RunGraphStageNode {
  kind: "stage";
  id: string;
  column: number;
  name: string;
  description?: string;
  state: RunGraphStageState;
  /** How many times the run entered this stage; > 1 means rework. */
  enteredCount: number;
  /** Total seconds spent inside this stage across all visits, or null. */
  durationSeconds: number | null;
  /** Evidence recorded while the run was inside this stage. */
  evidence: RavenEvidence[];
}

export interface RunGraphGateNode {
  kind: "gate";
  id: string;
  column: number;
  name: string;
  afterStage?: string;
  state: RunGraphGateState;
  /** The undecided review suspending the run here, if any (拍板点). */
  pendingReview: RavenGateReview | null;
  /** All reviews of this gate for the run, oldest first. */
  reviews: RavenGateReview[];
}

export interface RunGraphClarificationNode {
  kind: "clarification";
  id: string;
  /** Column of the stage the question hangs off. */
  column: number;
  question: string;
  answer?: string;
}

export type RunGraphNode =
  | RunGraphStageNode
  | RunGraphGateNode
  | RunGraphClarificationNode;

export type RunGraphEdgeState = "ghost" | "done" | "pending";

export interface RunGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "forward" | "rework";
  state: RunGraphEdgeState;
  /** Rework edges only: how many times the run looped back (×N badge). */
  reworkCount?: number;
  /** Rework edges only: latest rejection reason from the gate's reviews. */
  reworkReason?: string;
}

/**
 * Clarification Q&A source shape. The 澄清拍板点 table does not exist yet
 * (S5 in flight) — callers adapt whatever data they have (gate reviews,
 * comment threads) into this and the graph renders it as a temporary node.
 */
export interface RunGraphClarificationInput {
  id: string;
  question: string;
  answer?: string;
  /** Contract stage the question belongs to; defaults to the active stage. */
  stage?: string;
}

export interface RunGraph {
  mode: RunGraphMode;
  /** Trunk column count (stages + gates, in trunk order). */
  columns: number;
  nodes: RunGraphNode[];
  edges: RunGraphEdge[];
}

export interface DeriveRunGraphInput {
  stages: ContractStageView[];
  gates: ContractGateView[];
  /** null/undefined = design mode: render the ghost skeleton only. */
  run?: RavenRun | null;
  /** The run's stage event stream, oldest first. */
  events?: RavenRunStageEvent[];
  /** Gate reviews already filtered or not — filtered to run.id internally. */
  gateReviews?: RavenGateReview[];
  /** Requirement evidence — filtered to run.id internally. */
  evidence?: RavenEvidence[];
  clarifications?: RunGraphClarificationInput[];
  /** ISO timestamp used to close the active stage's duration interval. */
  now?: string;
}

interface StageInterval {
  start: number;
  end: number | null;
}

function parseTime(s: string): number | null {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Pair entered/exited events per stage, oldest first, into time intervals. */
function stageIntervals(
  events: RavenRunStageEvent[],
): Map<string, StageInterval[]> {
  const byStage = new Map<string, StageInterval[]>();
  for (const e of events) {
    if (!e.stage) continue;
    const list = byStage.get(e.stage) ?? [];
    if (e.event === "entered") {
      const start = parseTime(e.created_at);
      if (start !== null) list.push({ start, end: null });
    } else if (e.event === "exited") {
      const end = parseTime(e.created_at);
      const open = list.findLast((i) => i.end === null);
      if (open && end !== null) open.end = end;
    }
    byStage.set(e.stage, list);
  }
  return byStage;
}

export function deriveRunGraph(input: DeriveRunGraphInput): RunGraph {
  const { stages, gates } = input;
  const run = input.run ?? null;
  const mode: RunGraphMode = run ? "run" : "design";
  const events = run
    ? (input.events ?? []).filter((e) => e.run_id === run.id || e.run_id === "")
    : [];
  const reviews = run
    ? (input.gateReviews ?? []).filter((g) => g.run_id === run.id)
    : [];
  const evidence = run
    ? (input.evidence ?? []).filter((e) => e.run_id === run.id)
    : [];

  const intervals = stageIntervals(events);
  const now = input.now ? parseTime(input.now) : null;

  // --- trunk: stage, then the gates declared after it, in contract order ---
  const nodes: RunGraphNode[] = [];
  const edges: RunGraphEdge[] = [];
  const stageColumn = new Map<string, number>();
  let column = 0;

  const enteredCount = (name: string): number =>
    events.filter((e) => e.stage === name && e.event === "entered").length;
  const exitedCount = (name: string): number =>
    events.filter((e) => e.stage === name && e.event === "exited").length;

  for (const stage of stages) {
    const entered = enteredCount(stage.name);
    const exited = exitedCount(stage.name);

    let state: RunGraphStageState = "ghost";
    if (mode === "run" && run) {
      if (run.status === "completed" || (exited > 0 && exited >= entered)) {
        state = "done";
      } else if (entered > 0 || run.current_stage === stage.name) {
        state = "active";
      } else {
        state = "pending";
      }
    }

    // Total seconds inside the stage; the open interval of the active stage
    // is closed with `now` when provided so the drawer can show a live count.
    let durationSeconds: number | null = null;
    for (const iv of intervals.get(stage.name) ?? []) {
      const end = iv.end ?? (state === "active" ? now : null);
      if (end !== null && end >= iv.start) {
        durationSeconds = (durationSeconds ?? 0) + (end - iv.start) / 1000;
      }
    }

    const stageEvidence = evidence.filter((item) => {
      const t = parseTime(item.created_at);
      if (t === null) return false;
      return (intervals.get(stage.name) ?? []).some(
        (iv) => t >= iv.start && (iv.end === null || t <= iv.end),
      );
    });

    stageColumn.set(stage.name, column);
    nodes.push({
      kind: "stage",
      id: `stage:${stage.name}`,
      column,
      name: stage.name,
      description: stage.description,
      state,
      enteredCount: entered,
      durationSeconds,
      evidence: stageEvidence,
    });
    column++;

    for (const gate of gates) {
      if (gate.after_stage !== stage.name) continue;
      const gateReviews = reviews
        .filter((r) => r.gate_name === gate.name)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const pending = gateReviews.find((r) => r.status === "pending") ?? null;
      const latest = gateReviews[gateReviews.length - 1];

      let state: RunGraphGateState = "ghost";
      if (mode === "run") {
        if (pending) state = "waiting";
        else if (latest?.status === "approved") state = "approved";
        else if (latest?.status === "rejected") state = "rejected";
        else state = "idle";
      }

      nodes.push({
        kind: "gate",
        id: `gate:${gate.name}`,
        column,
        name: gate.name,
        afterStage: gate.after_stage,
        state,
        pendingReview: pending,
        reviews: gateReviews,
      });
      column++;
    }
  }

  // --- forward edges between consecutive trunk nodes ---
  const trunk = nodes.filter(
    (n): n is RunGraphStageNode | RunGraphGateNode => n.kind !== "clarification",
  );
  for (let i = 0; i < trunk.length - 1; i++) {
    const target = trunk[i + 1]!;
    const reached =
      mode === "run" &&
      (target.kind === "stage"
        ? target.state === "done" || target.state === "active"
        : target.state !== "idle" && target.state !== "ghost");
    edges.push({
      id: `edge:${trunk[i]!.id}->${target.id}`,
      from: trunk[i]!.id,
      to: target.id,
      kind: "forward",
      state: mode === "design" ? "ghost" : reached ? "done" : "pending",
    });
  }

  // --- rework back-edges: a stage entered more than once looped back ---
  if (mode === "run") {
    for (const node of trunk) {
      if (node.kind !== "stage" || node.enteredCount <= 1) continue;
      // The gate right after this stage is the usual bounce point; its
      // rejection reason labels the back-edge.
      const gateAfter = trunk.find(
        (n): n is RunGraphGateNode =>
          n.kind === "gate" && n.afterStage === node.name,
      );
      const rejected = (gateAfter?.reviews ?? []).filter(
        (r) => r.status === "rejected" && r.decision_reason !== "",
      );
      edges.push({
        id: `rework:${node.id}`,
        from: gateAfter?.id ?? node.id,
        to: node.id,
        kind: "rework",
        state: "done",
        reworkCount: node.enteredCount - 1,
        reworkReason: rejected[rejected.length - 1]?.decision_reason,
      });
    }
  }

  // --- clarification Q&A: temporary nodes hanging off their stage ---
  if (mode === "run") {
    const activeColumn =
      trunk.find((n) => n.kind === "stage" && n.state === "active")?.column ?? 0;
    for (const c of input.clarifications ?? []) {
      if (!c.question) continue;
      nodes.push({
        kind: "clarification",
        id: `clarification:${c.id}`,
        column: (c.stage ? stageColumn.get(c.stage) : undefined) ?? activeColumn,
        question: c.question,
        answer: c.answer,
      });
    }
  }

  return { mode, columns: column, nodes, edges };
}
