"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@multica/ui/components/ui/badge";
import { issueRequirementOptions } from "@multica/core/raven";

// Lifecycle state names are canonical glossary terms (CONTEXT.md) and are
// displayed as-is in every locale, like "Merged" on a PR.
const STATE_LABELS: Record<string, string> = {
  idea: "Idea",
  spec: "Spec",
  ready: "Ready",
  running: "Running",
  needs_review: "Needs Review",
  needs_human: "Needs Human",
  merged: "Merged",
  observed: "Observed",
  learned: "Learned",
};

const STATE_CLASSES: Record<string, string> = {
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  needs_review: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  needs_human: "bg-red-500/15 text-red-600 dark:text-red-400",
  merged: "bg-green-500/15 text-green-600 dark:text-green-400",
};

/**
 * Lifecycle state badge for issues on the Raven track. Renders nothing for
 * bare issues (query resolves to null — the opt-in boundary, ADR-0006).
 */
export function RavenLifecycleBadge({
  wsId,
  issueId,
}: {
  wsId: string;
  issueId: string;
}) {
  const { data: requirement } = useQuery(issueRequirementOptions(wsId, issueId));
  if (!requirement) return null;

  const label = STATE_LABELS[requirement.state] ?? requirement.state;
  return (
    <Badge
      variant="secondary"
      className={STATE_CLASSES[requirement.state] ?? ""}
      data-testid="raven-lifecycle-badge"
    >
      {label}
    </Badge>
  );
}
