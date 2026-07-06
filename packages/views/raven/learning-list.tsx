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

/**
 * Labels and one-line purposes for the three compounding destinations (#29).
 * Shared by the promote menu, the promoted-row link, and the page legend so
 * every surface names a destination the same way and explains what it does.
 */
export function useLearningDestinations() {
  const { t } = useT("raven");
  const label: Record<LearningPromoteDestination, string> = {
    skill_proposal: t(($) => $.learnings.promote_to.skill_proposal),
    fact: t(($) => $.learnings.promote_to.fact),
    uptrack_evidence: t(($) => $.learnings.promote_to.uptrack_evidence),
  };
  const purpose: Record<LearningPromoteDestination, string> = {
    skill_proposal: t(($) => $.learnings.purpose.skill_proposal),
    fact: t(($) => $.learnings.purpose.fact),
    uptrack_evidence: t(($) => $.learnings.purpose.uptrack_evidence),
  };
  const labelFor = (dest: string): string =>
    label[dest as LearningPromoteDestination] ?? dest;
  return { label, purpose, labelFor };
}

/**
 * The three destinations with their one-line purposes — the inline mechanism
 * guidance (#29). Rendered above the stream so first-run (empty) and every
 * later visit explain what each promote choice compounds into.
 */
export function LearningDestinationsLegend() {
  const { t } = useT("raven");
  const { label, purpose } = useLearningDestinations();
  return (
    <div data-testid="learnings-destinations">
      <p className="text-xs font-medium text-muted-foreground">
        {t(($) => $.learnings.about.destinations_title)}
      </p>
      <ul className="mt-1 space-y-1">
        {PROMOTE_DESTINATIONS.map((dest) => (
          <li key={dest} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="shrink-0 font-medium text-foreground">{label[dest]}</span>
            <span className="text-muted-foreground">{purpose[dest]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
 * Reusable self-report list (issue #22, structured for #29): each entry leads
 * with the self-report, then a labeled evidence block (source run, stage,
 * requirement, recorded-at) built from the real fields we have — no invented
 * signals. Used by the learning stream page today and the S3 node drawer
 * later — pass `onPromote`/`onExpire` to enable triage on fresh entries.
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
  const { label: destLabel, purpose: destPurpose, labelFor } = useLearningDestinations();

  if (learnings.length === 0) {
    return <p className="text-sm text-muted-foreground">{t(($) => $.learnings.empty)}</p>;
  }

  return (
    <ul className="divide-y rounded-md border">
      {learnings.map((l) => (
        <li key={l.id} data-testid="learning-item" className="flex flex-col gap-3 p-3">
          {/* The self-report is the signal worth compounding. */}
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t(($) => $.learnings.evidence.report)}
            </p>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{l.content}</p>
          </div>

          {/* Structured provenance: labeled real fields, not a raw string (#29). */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t(($) => $.learnings.evidence.source_run)}</dt>
            <dd>
              <AppLink
                href={wsPaths.ravenRunDetail(l.run_id)}
                className="font-mono text-foreground/80 hover:underline"
              >
                {t(($) => $.learnings.source_run, { run: l.run_id.slice(0, 8) })}
              </AppLink>
            </dd>

            <dt className="text-muted-foreground">{t(($) => $.learnings.evidence.stage)}</dt>
            <dd>{l.stage !== "" ? l.stage : t(($) => $.learnings.no_stage)}</dd>

            {l.issue_id !== "" && (
              <>
                <dt className="text-muted-foreground">
                  {t(($) => $.learnings.evidence.requirement)}
                </dt>
                <dd>
                  <AppLink
                    href={wsPaths.issueDetail(l.issue_id)}
                    className="text-foreground/80 hover:underline"
                  >
                    {t(($) => $.learnings.view_issue)}
                  </AppLink>
                </dd>
              </>
            )}

            {l.created_at !== "" && (
              <>
                <dt className="text-muted-foreground">
                  {t(($) => $.learnings.evidence.recorded_at)}
                </dt>
                <dd className="tabular-nums">{new Date(l.created_at).toLocaleString()}</dd>
              </>
            )}
          </dl>

          {/* Triage state, produced asset link, and fresh-row actions. */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge status={l.status} />
            {l.status === "promoted" && l.promoted_to !== "" && (
              <span data-testid="learning-promoted-to">
                {t(($) => $.learnings.promoted_to_label, {
                  dest: labelFor(l.promoted_to),
                })}
              </span>
            )}
            {/* Link back to the reusable asset the promotion produced (#28). */}
            {l.status === "promoted" &&
              l.asset?.kind === "skill_proposal" &&
              l.asset.skill_id !== "" && (
                <AppLink
                  data-testid="learning-asset-link"
                  href={wsPaths.skillDetail(l.asset.skill_id)}
                  className="text-foreground/80 hover:underline"
                >
                  {t(($) => $.learnings.asset.view_skill)}
                </AppLink>
              )}
            {l.status === "promoted" &&
              l.asset?.kind === "uptrack_evidence" &&
              l.asset.workflow_id !== "" && (
                <AppLink
                  data-testid="learning-asset-link"
                  href={wsPaths.ravenWorkflowDetail(l.asset.workflow_id)}
                  className="text-foreground/80 hover:underline"
                >
                  {t(($) => $.learnings.asset.view_workflow)}
                </AppLink>
              )}
            {l.status === "fresh" && (onPromote || onExpire) && (
              <span className="ml-auto flex items-center gap-1">
                {onPromote && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button variant="outline" size="sm" data-testid="learning-promote">
                          {t(($) => $.learnings.promote)}
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end" className="max-w-xs">
                      {PROMOTE_DESTINATIONS.map((dest) => (
                        <DropdownMenuItem
                          key={dest}
                          data-testid={`learning-promote-${dest}`}
                          onClick={() => onPromote(l, dest)}
                        >
                          {/* Destination carries its purpose (#29). */}
                          <div className="flex flex-col gap-0.5">
                            <span className="text-sm">{destLabel[dest]}</span>
                            <span className="text-xs text-muted-foreground">
                              {destPurpose[dest]}
                            </span>
                          </div>
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
