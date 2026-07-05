"use client";

import type { RavenLearning } from "@multica/core/raven";
import { useWorkspacePaths } from "@multica/core/paths";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@multica/ui/components/ui/dropdown-menu";
import { AppLink } from "../navigation";
import { useT } from "../i18n";

export type LearningPromoteDestination = "skill_proposal" | "fact" | "uptrack_evidence";

const PROMOTE_DESTINATIONS: LearningPromoteDestination[] = [
  "skill_proposal",
  "fact",
  "uptrack_evidence",
];

function StatusBadge({ status }: { status: string }) {
  const { t } = useT("raven");
  // Server-driven enum: default branch renders the raw value.
  switch (status) {
    case "fresh":
      return (
        <Badge variant="secondary" className="bg-blue-500/15 text-blue-600 dark:text-blue-400">
          {t(($) => $.learnings.status.fresh)}
        </Badge>
      );
    case "promoted":
      return (
        <Badge variant="secondary" className="bg-green-500/15 text-green-600 dark:text-green-400">
          {t(($) => $.learnings.status.promoted)}
        </Badge>
      );
    case "expired":
      return (
        <Badge variant="secondary" className="bg-muted text-muted-foreground">
          {t(($) => $.learnings.status.expired)}
        </Badge>
      );
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

/**
 * Reusable self-report list (issue #22): each entry shows content, provenance
 * (run + stage, linking back to the origin issue) and triage state. Used by
 * the learning stream page today and the S3 node drawer later — pass
 * `onPromote`/`onExpire` to enable triage actions on fresh entries.
 */
export function LearningList({
  learnings,
  onPromote,
  onExpire,
}: {
  learnings: RavenLearning[];
  onPromote?: (learning: RavenLearning, destination: LearningPromoteDestination) => void;
  onExpire?: (learning: RavenLearning) => void;
}) {
  const { t } = useT("raven");
  const wsPaths = useWorkspacePaths();

  const destLabel: Record<LearningPromoteDestination, string> = {
    skill_proposal: t(($) => $.learnings.promote_to.skill_proposal),
    fact: t(($) => $.learnings.promote_to.fact),
    uptrack_evidence: t(($) => $.learnings.promote_to.uptrack_evidence),
  };
  const promotedToLabel = (dest: string): string =>
    destLabel[dest as LearningPromoteDestination] ?? dest;

  if (learnings.length === 0) {
    return <p className="text-sm text-muted-foreground">{t(($) => $.learnings.empty)}</p>;
  }

  return (
    <ul className="divide-y rounded-md border">
      {learnings.map((l) => (
        <li key={l.id} data-testid="learning-item" className="flex flex-col gap-2 p-3">
          <p className="whitespace-pre-wrap break-words text-sm">{l.content}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge status={l.status} />
            {l.status === "promoted" && l.promoted_to !== "" && (
              <span data-testid="learning-promoted-to">
                {t(($) => $.learnings.promoted_to_label, {
                  dest: promotedToLabel(l.promoted_to),
                })}
              </span>
            )}
            <span className="font-mono">
              {t(($) => $.learnings.source_run, { run: l.run_id.slice(0, 8) })}
            </span>
            <span>· {l.stage !== "" ? l.stage : t(($) => $.learnings.no_stage)}</span>
            {l.issue_id !== "" && (
              <AppLink
                href={wsPaths.issueDetail(l.issue_id)}
                className="hover:underline text-foreground/80"
              >
                {t(($) => $.learnings.view_issue)}
              </AppLink>
            )}
            {l.created_at !== "" && (
              <span className="ml-auto tabular-nums">
                {new Date(l.created_at).toLocaleString()}
              </span>
            )}
            {l.status === "fresh" && (onPromote || onExpire) && (
              <span className="flex items-center gap-1">
                {onPromote && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button variant="outline" size="sm" data-testid="learning-promote">
                          {t(($) => $.learnings.promote)}
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      {PROMOTE_DESTINATIONS.map((dest) => (
                        <DropdownMenuItem
                          key={dest}
                          data-testid={`learning-promote-${dest}`}
                          onClick={() => onPromote(l, dest)}
                        >
                          {destLabel[dest]}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {onExpire && (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="learning-expire"
                    onClick={() => onExpire(l)}
                  >
                    {t(($) => $.learnings.expire)}
                  </Button>
                )}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
