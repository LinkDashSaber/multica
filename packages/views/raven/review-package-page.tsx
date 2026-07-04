"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import {
  gateOptions,
  ravenRequirementOptions,
  requirementEvidenceOptions,
  useDecideRavenGate,
  type RavenGateReview,
} from "@multica/core/raven";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { AppLink } from "../navigation";
import { BreadcrumbHeader } from "../layout/breadcrumb-header";
import { STATE_LABELS, STATE_CLASSES } from "../issues/components/raven-lifecycle-badge";
import { RequirementTimeline } from "./requirement-timeline";
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
 * Split a freeform review_package into keys we can render nicely (string /
 * number / boolean scalars, with `summary` promoted to a paragraph) and the
 * remainder, which goes into a collapsible pretty-printed JSON block.
 */
function splitReviewPackage(pkg: unknown): {
  summary: string;
  scalars: Array<[string, string]>;
  rest: unknown;
} {
  if (pkg === null || pkg === undefined) return { summary: "", scalars: [], rest: undefined };
  if (typeof pkg !== "object" || Array.isArray(pkg)) {
    return { summary: "", scalars: [], rest: pkg };
  }
  const obj = pkg as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  const scalars: Array<[string, string]> = [];
  const restEntries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "summary" && summary) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      scalars.push([key, String(value)]);
    } else if (value !== null && value !== undefined) {
      restEntries[key] = value;
    }
  }
  return {
    summary,
    scalars,
    rest: Object.keys(restEntries).length > 0 ? restEntries : undefined,
  };
}

function ReviewPackageSection({ pkg }: { pkg: unknown }) {
  const { t } = useT("raven");
  const { summary, scalars, rest } = splitReviewPackage(pkg);
  const empty = !summary && scalars.length === 0 && rest === undefined;

  return (
    <section>
      <h2 className="text-sm font-semibold">{t(($) => $.gate.package.title)}</h2>
      {empty ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t(($) => $.gate.package.empty)}
        </p>
      ) : (
        <div className="mt-2 space-y-3">
          {summary && (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {summary}
            </p>
          )}
          {scalars.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {scalars.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 break-words">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {rest !== undefined && (
            <details className="rounded-md border bg-muted/30">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
                {t(($) => $.gate.package.raw)}
              </summary>
              <pre className="overflow-x-auto border-t px-3 py-2 text-xs leading-relaxed">
                {JSON.stringify(rest, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function DecisionSection({
  gate,
  wsId,
}: {
  gate: RavenGateReview;
  wsId: string;
}) {
  const { t } = useT("raven");
  const { getActorName } = useActorName();
  const decideMutation = useDecideRavenGate(wsId);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");

  if (gate.status !== "pending") {
    const decidedAt = gate.decided_at
      ? new Date(gate.decided_at).toLocaleString()
      : "";
    return (
      <section data-testid="gate-decided">
        <h2 className="text-sm font-semibold">{t(($) => $.gate.decision.title)}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {gate.decided_by
            ? t(($) => $.gate.decision.decided_by, {
                name: getActorName("member", gate.decided_by),
              })
            : null}
          {decidedAt ? ` · ${decidedAt}` : null}
        </p>
        {gate.decision_reason && (
          <div className="mt-2 rounded-md border bg-muted/40 p-3">
            <p className="text-xs font-medium text-muted-foreground">
              {t(($) => $.gate.decision.reason_title)}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{gate.decision_reason}</p>
          </div>
        )}
      </section>
    );
  }

  const submit = (approve: boolean) => {
    const trimmed = reason.trim();
    if (!approve && !trimmed) {
      setReasonError(t(($) => $.gate.decision.reason_required));
      return;
    }
    decideMutation.mutate(
      { gateId: gate.id, approve, reason: approve ? "" : trimmed },
      {
        onError: (err) =>
          toast.error(
            err instanceof Error && err.message
              ? err.message
              : t(($) => $.gate.decision.failed),
          ),
      },
    );
  };

  return (
    <section>
      <h2 className="text-sm font-semibold">{t(($) => $.gate.decision.title)}</h2>
      {rejecting ? (
        <div className="mt-2 space-y-2">
          <Textarea
            autoFocus
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setReasonError("");
            }}
            placeholder={t(($) => $.gate.decision.reason_placeholder)}
            aria-label={t(($) => $.gate.decision.reason_label)}
          />
          {reasonError && (
            <p className="text-xs text-destructive">{reasonError}</p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={decideMutation.isPending}
              onClick={() => submit(false)}
            >
              {decideMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              {t(($) => $.gate.decision.confirm_reject)}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decideMutation.isPending}
              onClick={() => {
                setRejecting(false);
                setReasonError("");
              }}
            >
              {t(($) => $.gate.decision.cancel)}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            disabled={decideMutation.isPending}
            onClick={() => submit(true)}
          >
            {decideMutation.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            {t(($) => $.gate.decision.approve)}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={decideMutation.isPending}
            onClick={() => setRejecting(true)}
          >
            {t(($) => $.gate.decision.reject)}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * Human review page for one Raven gate: the review package produced by the
 * workflow run, the requirement it belongs to, its evidence trail, and the
 * approve / reject verdict controls.
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
          <ReviewPackageSection pkg={gate.review_package} />

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
                      <p className="mt-1 whitespace-pre-wrap text-sm">
                        {item.summary}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <DecisionSection gate={gate} wsId={wsId} />

          {requirementId && (
            <RequirementTimeline wsId={wsId} requirementId={requirementId} />
          )}
        </div>
      </div>
    </div>
  );
}
