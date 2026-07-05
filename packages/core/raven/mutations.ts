import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ravenKeys } from "./queries";

export interface DecideGateInput {
  gateId: string;
  approve: boolean;
  reason: string;
}

/**
 * Record a human verdict on a gate review. Not optimistic — the server is
 * the arbiter of "already decided" (409), so we settle by invalidating the
 * gate and the pending queue instead of guessing.
 */
export function useDecideRavenGate(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ gateId, approve, reason }: DecideGateInput) =>
      api.decideRavenGate(gateId, { approve, reason }),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ravenKeys.gate(wsId, vars.gateId) });
      qc.invalidateQueries({ queryKey: ravenKeys.pendingGates(wsId) });
      qc.invalidateQueries({ queryKey: ravenKeys.pendingDecisionPoints(wsId) });
    },
  });
}

export interface DecidePromotionInput {
  promotionId: string;
  approve: boolean;
  reason: string;
}

/**
 * Decide a trust promotion letter (issue #25). Same non-optimistic shape as
 * gate verdicts: the server arbitrates "already decided" (409).
 */
export function useDecideRavenPromotion(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ promotionId, approve, reason }: DecidePromotionInput) =>
      api.decideRavenPromotion(promotionId, { approve, reason }),
    onSettled: (data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ravenKeys.promotion(wsId, vars.promotionId) });
      qc.invalidateQueries({ queryKey: ravenKeys.pendingDecisionPoints(wsId) });
      qc.invalidateQueries({ queryKey: ravenKeys.workflowStats(wsId) });
      if (data?.workflow_id) {
        qc.invalidateQueries({ queryKey: ravenKeys.gatePolicies(wsId, data.workflow_id) });
      }
    },
  });
}

/** Manually revert a promoted gate to full review (issue #25). */
export function useRevokeRavenGatePolicy(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workflowId, gateName }: { workflowId: string; gateName: string }) =>
      api.revokeRavenGatePolicy(workflowId, gateName),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ravenKeys.gatePolicies(wsId, vars.workflowId) });
      qc.invalidateQueries({ queryKey: ravenKeys.workflowStats(wsId) });
    },
  });
}

export interface AnswerClarificationInput {
  clarificationId: string;
  /** Free text or a chosen recommended option, verbatim. */
  answer: string;
}

/**
 * Answer a clarification decision point (issue #19). Not optimistic for the
 * same reason as gate verdicts: the server arbitrates "already answered"
 * (409), so we settle by invalidating instead of guessing.
 */
export function useAnswerRavenClarification(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clarificationId, answer }: AnswerClarificationInput) =>
      api.answerRavenClarification(clarificationId, { answer }),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ravenKeys.clarification(wsId, vars.clarificationId) });
      qc.invalidateQueries({ queryKey: ravenKeys.pendingDecisionPoints(wsId) });
    },
  });
}

/**
 * Ask for a workflow recommendation from issue-create form text (issue #9).
 * Transient by design — the result drives a one-shot banner, so a mutation
 * (not a cached query) is the right shape.
 */
export function useRequestRavenRecommendation() {
  return useMutation({
    mutationFn: (data: { issue_id?: string; title?: string; description?: string }) =>
      api.requestRavenRecommendation(data),
  });
}

/** Record accepted / ignored / fallback_squad on a recommendation. */
export function useRecordRavenRecommendationOutcome() {
  return useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: "accepted" | "ignored" | "fallback_squad" }) =>
      api.recordRavenRecommendationOutcome(id, outcome),
  });
}
