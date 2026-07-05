"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  gateOptions,
  ravenRequirementOptions,
  requirementEvidenceOptions,
} from "@multica/core/raven";
import { Badge } from "@multica/ui/components/ui/badge";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { AppLink } from "../navigation";
import { BreadcrumbHeader } from "../layout/breadcrumb-header";
import { STATE_LABELS, STATE_CLASSES } from "../issues/components/raven-lifecycle-badge";
import { CollapsibleMarkdown } from "../common/collapsible-markdown";
import { RequirementTimeline } from "./requirement-timeline";
import { DecisionLetterCard } from "./decision-letter-card";
import { useT } from "../i18n";

const GATE_STATUS_CLASSES: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  approved: "bg-green-500/15 text-green-600 dark:text-green-400",
  rejected: "bg-red-500/15 text-red-600 dark:text-red-400",
};

function GateStatusBadge({ status }: { status: string }) {
  const { t } = useT("raven");
  // Server-driven enum — unknown statuses render as-is (API compatibility).
  const label =
    status === "pending"
      ? t(($) => $.gate.status.pending)
      : status === "approved"
        ? t(($) => $.gate.status.approved)
        : status === "rejected"
          ? t(($) => $.gate.status.rejected)
          : status;
  return (
    <Badge
      variant="secondary"
      className={GATE_STATUS_CLASSES[status] ?? ""}
      data-testid="gate-status-badge"
    >
      {label}
    </Badge>
  );
}

/**
 * Human review page for one Raven gate: the decision letter (issue #20 —
 * same card as the inbox), plus the requirement it belongs to, its evidence
 * trail, and the audit timeline.
 */
export function ReviewPackagePage({ gateId }: { gateId: string }) {
  const { t } = useT("raven");
  const wsId = useWorkspaceId();
  const wsPaths = useWorkspacePaths();

  const { data: gate, isLoading } = useQuery(gateOptions(wsId, gateId));
  const requirementId = gate?.requirement_id ?? "";
  const { data: requirement } = useQuery({
    ...ravenRequirementOptions(wsId, requirementId),
    enabled: !!requirementId,
  });
  const { data: evidence = [] } = useQuery({
    ...requirementEvidenceOptions(wsId, requirementId),
    enabled: !!requirementId,
  });

  if (isLoading) {
    return (
      <div className="flex flex-1 flex-col min-h-0">
        <div className="flex h-12 shrink-0 items-center border-b px-4">
          <Skeleton className="h-5 w-40" />
        </div>
        <div className="space-y-4 p-6">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    );
  }

  if (!gate) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {t(($) => $.gate.not_found)}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <BreadcrumbHeader
        segments={[]}
        leaf={
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold">
              {gate.gate_name || t(($) => $.gate.title)}
            </span>
            <GateStatusBadge status={gate.status} />
          </div>
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
          <DecisionLetterCard wsId={wsId} kind="gate" id={gateId} />

          <section>
            <h2 className="text-sm font-semibold">
              {t(($) => $.gate.requirement.title)}
            </h2>
            {requirement ? (
              <div className="mt-2 flex items-center gap-3">
                <Badge
                  variant="secondary"
                  className={STATE_CLASSES[requirement.state] ?? ""}
                >
                  {STATE_LABELS[requirement.state] ?? requirement.state}
                </Badge>
                {requirement.issue_id && (
                  <AppLink
                    href={wsPaths.issueDetail(requirement.issue_id)}
                    className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    {t(($) => $.gate.requirement.view_issue)}
                  </AppLink>
                )}
              </div>
            ) : (
              <Skeleton className="mt-2 h-5 w-32" />
            )}
          </section>

          <section>
            <h2 className="text-sm font-semibold">
              {t(($) => $.gate.evidence.title)}
            </h2>
            {evidence.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {t(($) => $.gate.evidence.empty)}
              </p>
            ) : (
              <ul className="mt-2 divide-y rounded-md border">
                {evidence.map((item) => (
                  <li key={item.id} className="px-3 py-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground/80">
                        {item.kind}
                      </span>
                      {item.source && <span>{item.source}</span>}
                      {item.created_at && (
                        <span className="ml-auto shrink-0">
                          {new Date(item.created_at).toLocaleString()}
                        </span>
                      )}
                    </div>
                    {item.summary && (
                      <CollapsibleMarkdown content={item.summary} className="mt-1" />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {requirementId && (
            <RequirementTimeline wsId={wsId} requirementId={requirementId} />
          )}
        </div>
      </div>
    </div>
  );
}
