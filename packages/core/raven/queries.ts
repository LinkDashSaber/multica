import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { RavenRequirement } from "../api/schemas";

export type { RavenRequirement };

export const ravenKeys = {
  all: (wsId: string) => ["raven", wsId] as const,
  issueRequirement: (wsId: string, issueId: string) =>
    [...ravenKeys.all(wsId), "issue-requirement", issueId] as const,
};

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
