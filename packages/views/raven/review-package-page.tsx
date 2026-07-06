"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { gateOptions } from "@multica/core/raven";
import { Badge } from "@multica/ui/components/ui/badge";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { BreadcrumbHeader } from "../layout/breadcrumb-header";
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
 * Human review page for one Raven gate. The decision letter (issue #20/#27) is
 * self-contained — it carries the requirement (original ask), exit links,
 * evidence, and verdict — so this page is a thin frame around it: breadcrumb +
 * card + the full audit timeline the card does not show.
 */
export function ReviewPackagePage({ gateId }: { gateId: string }) {
  const { t } = useT("raven");
  const wsId = useWorkspaceId();

  const { data: gate, isLoading } = useQuery(gateOptions(wsId, gateId));
  const requirementId = gate?.requirement_id ?? "";

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

          {requirementId && (
            <RequirementTimeline wsId={wsId} requirementId={requirementId} />
          )}
        </div>
      </div>
    </div>
  );
}
