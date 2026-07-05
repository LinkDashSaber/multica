import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type {
  RavenClarification,
  RavenDecisionPoint,
  RavenEvidence,
  RavenGatePolicy,
  RavenGateReview,
  RavenLearning,
  RavenPromotion,
  RavenRequirement,
  RavenRun,
  RavenRunStageEvent,
  RavenTransition,
  RavenWorkflow,
  RavenWorkflowRun,
  RavenWorkflowStats,
} from "../api/schemas";

export type {
  RavenClarification,
  RavenDecisionPoint,
  RavenEvidence,
  RavenGatePolicy,
  RavenGateReview,
  RavenLearning,
  RavenPromotion,
  RavenRequirement,
  RavenRun,
  RavenRunStageEvent,
  RavenTransition,
  RavenWorkflow,
  RavenWorkflowRun,
  RavenWorkflowStats,
};

export const ravenKeys = {
  all: (wsId: string) => ["raven", wsId] as const,
  issueRequirement: (wsId: string, issueId: string) =>
    [...ravenKeys.all(wsId), "issue-requirement", issueId] as const,
  workflows: (wsId: string) => [...ravenKeys.all(wsId), "workflows"] as const,
  workflow: (wsId: string, id: string) =>
    [...ravenKeys.all(wsId), "workflow", id] as const,
  workflowStats: (wsId: string) =>
    [...ravenKeys.all(wsId), "workflow-stats"] as const,
  workflowRuns: (wsId: string, id: string) =>
    [...ravenKeys.all(wsId), "workflow-runs", id] as const,
  requirementTransitions: (wsId: string, requirementId: string) =>
    [...ravenKeys.all(wsId), "requirement-transitions", requirementId] as const,
  requirementGates: (wsId: string, requirementId: string) =>
    [...ravenKeys.all(wsId), "requirement-gates", requirementId] as const,
  requirementRuns: (wsId: string, requirementId: string) =>
    [...ravenKeys.all(wsId), "requirement-runs", requirementId] as const,
  runStageEvents: (wsId: string, runId: string) =>
    [...ravenKeys.all(wsId), "run-stage-events", runId] as const,
  requirement: (wsId: string, id: string) =>
    [...ravenKeys.all(wsId), "requirement", id] as const,
  requirementEvidence: (wsId: string, requirementId: string) =>
    [...ravenKeys.all(wsId), "requirement-evidence", requirementId] as const,
  gate: (wsId: string, gateId: string) =>
    [...ravenKeys.all(wsId), "gate", gateId] as const,
  pendingGates: (wsId: string) =>
    [...ravenKeys.all(wsId), "pending-gates"] as const,
  clarification: (wsId: string, clarificationId: string) =>
    [...ravenKeys.all(wsId), "clarification", clarificationId] as const,
  pendingDecisionPoints: (wsId: string) =>
    [...ravenKeys.all(wsId), "pending-decision-points"] as const,
  learnings: (wsId: string) => [...ravenKeys.all(wsId), "learnings"] as const,
  runLearnings: (wsId: string, runId: string) =>
    [...ravenKeys.learnings(wsId), runId] as const,
  gatePolicies: (wsId: string, workflowId: string) =>
    [...ravenKeys.all(wsId), "gate-policies", workflowId] as const,
  promotion: (wsId: string, promotionId: string) =>
    [...ravenKeys.all(wsId), "promotion", promotionId] as const,
};

/** Workflows registered in this workspace (enabled and disabled). */
export function ravenWorkflowListOptions(wsId: string) {
  return queryOptions<RavenWorkflow[]>({
    queryKey: ravenKeys.workflows(wsId),
    queryFn: async () => (await api.listRavenWorkflows()).workflows,
    staleTime: 60_000,
  });
}

/** A single workflow, contract included — drives the review page's stage strip. */
export function ravenWorkflowOptions(wsId: string, id: string) {
  return queryOptions<RavenWorkflow>({
    queryKey: ravenKeys.workflow(wsId, id),
    queryFn: () => api.getRavenWorkflow(id),
    staleTime: 60_000,
  });
}

/** Per-workflow run/gate aggregates for the workflow list page. */
export function ravenWorkflowStatsOptions(wsId: string) {
  return queryOptions<RavenWorkflowStats[]>({
    queryKey: ravenKeys.workflowStats(wsId),
    queryFn: async () => (await api.listRavenWorkflowStats()).stats,
    staleTime: 60_000,
  });
}

/** A workflow's run history with each run's gate decisions. */
export function ravenWorkflowRunsOptions(wsId: string, id: string) {
  return queryOptions<RavenWorkflowRun[]>({
    queryKey: ravenKeys.workflowRuns(wsId, id),
    queryFn: async () => (await api.listRavenWorkflowRuns(id)).runs,
    staleTime: 15_000,
  });
}

/** Append-only state transition history of a requirement, oldest first. */
export function requirementTransitionsOptions(wsId: string, requirementId: string) {
  return queryOptions<RavenTransition[]>({
    queryKey: ravenKeys.requirementTransitions(wsId, requirementId),
    queryFn: async () => (await api.listRavenTransitions(requirementId)).transitions,
    staleTime: 15_000,
  });
}

/** Every gate review ever opened for a requirement. */
export function requirementGatesOptions(wsId: string, requirementId: string) {
  return queryOptions<RavenGateReview[]>({
    queryKey: ravenKeys.requirementGates(wsId, requirementId),
    queryFn: async () => (await api.listRavenGates(requirementId)).gates,
    staleTime: 15_000,
  });
}

/**
 * A requirement's runs, newest first. Polls while visible so the issue
 * detail stage strip follows run progress (issue #15).
 */
export function requirementRunsOptions(wsId: string, requirementId: string) {
  return queryOptions<RavenRun[]>({
    queryKey: ravenKeys.requirementRuns(wsId, requirementId),
    queryFn: async () => (await api.listRavenRuns(requirementId)).runs,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

/** A run's stage event stream, oldest first (issue #15). */
export function runStageEventsOptions(wsId: string, runId: string) {
  return queryOptions<RavenRunStageEvent[]>({
    queryKey: ravenKeys.runStageEvents(wsId, runId),
    queryFn: async () => (await api.listRavenRunStageEvents(runId)).events,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

/**
 * The lifecycle requirement attached to an issue, or null for bare issues
 * that never opted into the Raven track (ADR-0006).
 */
export function issueRequirementOptions(wsId: string, issueId: string) {
  return queryOptions<RavenRequirement | null>({
    queryKey: ravenKeys.issueRequirement(wsId, issueId),
    queryFn: () => api.getRavenRequirementForIssue(issueId),
    staleTime: 15_000,
  });
}

export function ravenRequirementOptions(wsId: string, requirementId: string) {
  return queryOptions<RavenRequirement>({
    queryKey: ravenKeys.requirement(wsId, requirementId),
    queryFn: () => api.getRavenRequirement(requirementId),
    staleTime: 15_000,
  });
}

export function requirementEvidenceOptions(wsId: string, requirementId: string) {
  return queryOptions<RavenEvidence[]>({
    queryKey: ravenKeys.requirementEvidence(wsId, requirementId),
    queryFn: async () => (await api.listRavenEvidence(requirementId)).evidence,
    staleTime: 15_000,
  });
}

/**
 * Workspace-wide execution self-report stream, newest first (issue #22) —
 * feeds the learning stream (沉淀流) page.
 */
export function ravenLearningsOptions(wsId: string) {
  return queryOptions<RavenLearning[]>({
    queryKey: ravenKeys.learnings(wsId),
    queryFn: async () => (await api.listRavenLearnings()).learnings,
    staleTime: 15_000,
  });
}

/**
 * Learnings reported by one run, optionally narrowed to one stage — for the
 * S3 node drawer ("what did this node self-report") and any per-run view.
 */
export function runLearningsOptions(wsId: string, runId: string, stage?: string) {
  return queryOptions<RavenLearning[]>({
    queryKey: ravenKeys.runLearnings(wsId, runId),
    queryFn: async () => (await api.listRavenLearnings({ runId })).learnings,
    // Stage narrowing is client-side: one cache entry per run serves every
    // stage of the S3 drawer.
    select: stage === undefined ? undefined : (all) => all.filter((l) => l.stage === stage),
    staleTime: 15_000,
  });
}

export function gateOptions(wsId: string, gateId: string) {
  return queryOptions<RavenGateReview>({
    queryKey: ravenKeys.gate(wsId, gateId),
    queryFn: () => api.getRavenGate(gateId),
    staleTime: 15_000,
  });
}

export function clarificationOptions(wsId: string, clarificationId: string) {
  return queryOptions<RavenClarification>({
    queryKey: ravenKeys.clarification(wsId, clarificationId),
    queryFn: () => api.getRavenClarification(clarificationId),
    staleTime: 15_000,
  });
}

/**
 * The workspace's unified pending decision queue (issue #19): gate reviews
 * and clarifications merged, each with node position, context, and response
 * form. Polls while visible — this is the "待我拍板" surface.
 */
export function pendingDecisionPointsOptions(wsId: string) {
  return queryOptions<RavenDecisionPoint[]>({
    queryKey: ravenKeys.pendingDecisionPoints(wsId),
    queryFn: async () => (await api.listRavenDecisionPoints()).items,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

/**
 * Per-gate review policy + live zero-reject streak for one workflow
 * (issue #25): trust section on the detail page, revoke button.
 */
export function ravenGatePoliciesOptions(wsId: string, workflowId: string) {
  return queryOptions<RavenGatePolicy[]>({
    queryKey: ravenKeys.gatePolicies(wsId, workflowId),
    queryFn: async () => (await api.listRavenGatePolicies(workflowId)).policies,
    staleTime: 15_000,
  });
}

/** One promotion application letter (decision point detail). */
export function ravenPromotionOptions(wsId: string, promotionId: string) {
  return queryOptions<RavenPromotion>({
    queryKey: ravenKeys.promotion(wsId, promotionId),
    queryFn: () => api.getRavenPromotion(promotionId),
    staleTime: 15_000,
  });
}

/** The workspace's pending gate review queue. */
export function pendingGatesOptions(wsId: string) {
  return queryOptions<RavenGateReview[]>({
    queryKey: ravenKeys.pendingGates(wsId),
    queryFn: async () => (await api.listRavenGates()).gates,
    staleTime: 15_000,
  });
}
