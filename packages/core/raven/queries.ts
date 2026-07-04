import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { RavenRequirement, RavenWorkflow } from "../api/schemas";

export type { RavenRequirement, RavenWorkflow };

export const ravenKeys = {
  all: (wsId: string) => ["raven", wsId] as const,
  issueRequirement: (wsId: string, issueId: string) =>
    [...ravenKeys.all(wsId), "issue-requirement", issueId] as const,
  workflows: (wsId: string) => [...ravenKeys.all(wsId), "workflows"] as const,
};

/** Workflows registered in this workspace (enabled and disabled). */
export function ravenWorkflowListOptions(wsId: string) {
  return queryOptions<RavenWorkflow[]>({
    queryKey: ravenKeys.workflows(wsId),
    queryFn: async () => (await api.listRavenWorkflows()).workflows,
    staleTime: 60_000,
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
