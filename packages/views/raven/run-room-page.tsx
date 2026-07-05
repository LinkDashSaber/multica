"use client";

// Run room (issue #18): the full-page mission control of one run. Three
// zones answer "现在怎么样了" on a single screen — the live run graph (with
// clarification overlays wired in), the merged execution timeline, and the
// budget telemetry against the contract ceiling.

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  ravenRequirementOptions,
  ravenRunOptions,
  ravenWorkflowOptions,
  requirementClarificationsOptions,
  requirementEvidenceOptions,
  requirementGatesOptions,
  runStageEventsOptions,
} from "@multica/core/raven";
import { issueTimelineOptions } from "@multica/core/issues/queries";
import { useActorName } from "@multica/core/workspace/hooks";
import { Badge } from "@multica/ui/components/ui/badge";
import { Progress } from "@multica/ui/components/ui/progress";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { AppLink } from "../navigation";
import { BreadcrumbHeader } from "../layout/breadcrumb-header";
import { CollapsibleMarkdown } from "../common/collapsible-markdown";
import { useT } from "../i18n";
import { formatRunDuration } from "./workflow-list-page";
import { RunFailureSummary } from "./run-failure-summary";
import { RunGraph } from "./run-graph";
import {
  clarificationsToGraphInput,
  contractMaxTokens,
  mergeRunTimeline,
  runDurationSeconds,
  type RunTimelineItem,
} from "./run-room-model";

const RUN_STATUS_CLASSES: Record<string, string> = {
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  completed: "bg-green-500/15 text-green-600 dark:text-green-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
  terminated: "bg-red-500/15 text-red-600 dark:text-red-400",
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

const TIMELINE_DOT_CLASSES: Record<RunTimelineItem["kind"], string> = {
  stage: "bg-blue-500",
  evidence: "bg-green-500",
  gate_opened: "bg-amber-500",
  gate_decided: "bg-amber-500",
  clarification_asked: "bg-amber-500",
  clarification_answered: "bg-amber-500",
  comment: "bg-muted-foreground/50",
};

function TimelineItemRow({ item }: { item: RunTimelineItem }) {
  const { t } = useT("raven");
  const { getActorName } = useActorName();

  let title: string;
  let body: string | null = null;
  switch (item.kind) {
    case "stage":
      title =
        item.event === "entered"
          ? t(($) => $.run_room.timeline.stage_entered, { stage: item.stage })
          : item.event === "exited"
            ? t(($) => $.run_room.timeline.stage_exited, { stage: item.stage })
            : `${item.stage} · ${item.event}`;
      break;
    case "evidence":
      title = t(($) => $.run_room.timeline.evidence, { kind: item.evidenceKind });
      body = item.summary || null;
      break;
    case "gate_opened":
      title = t(($) => $.run_room.timeline.gate_opened, { name: item.gateName });
      break;
    case "gate_decided":
      title =
        item.status === "approved"
          ? t(($) => $.run_room.timeline.gate_approved, { name: item.gateName })
          : item.status === "rejected"
            ? t(($) => $.run_room.timeline.gate_rejected, { name: item.gateName })
            : `${item.gateName} · ${item.status}`;
      body = item.reason || null;
      break;
    case "clarification_asked":
      title = t(($) => $.run_room.timeline.clarification_asked);
      body = item.question;
      break;
    case "clarification_answered":
      title = t(($) => $.run_room.timeline.clarification_answered);
      body = item.answer;
      break;
    case "comment":
      title = t(($) => $.run_room.timeline.comment, {
        name: getActorName(item.actorType, item.actorId),
      });
      body = item.content;
      break;
    default:
      return null;
  }

  return (
    <li
      data-testid="run-room-timeline-item"
      data-kind={item.kind}
      className="relative pb-4 pl-5 last:pb-0"
    >
      <span
        className={cn(
          "absolute left-0 top-1.5 size-2 rounded-full",
          TIMELINE_DOT_CLASSES[item.kind],
        )}
        aria-hidden
      />
      <span className="absolute bottom-0 left-[3.5px] top-4 w-px bg-border" aria-hidden />
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {new Date(item.at).toLocaleString()}
        </span>
      </div>
      {body && <CollapsibleMarkdown content={body} className="mt-1" />}
    </li>
  );
}

/** Run room (运行室): the mission-control page of one run. */
export function RunRoomPage({ runId }: { runId: string }) {
  const { t } = useT("raven");
  const wsId = useWorkspaceId();
  const wsPaths = useWorkspacePaths();

  const { data: run, isLoading } = useQuery(ravenRunOptions(wsId, runId));
  const requirementId = run?.requirement_id ?? "";
  const workflowId = run?.workflow_id ?? "";

  const { data: requirement } = useQuery({
    ...ravenRequirementOptions(wsId, requirementId),
    enabled: requirementId !== "",
  });
  const { data: workflow } = useQuery({
    ...ravenWorkflowOptions(wsId, workflowId),
    enabled: workflowId !== "",
  });
  const { data: events = [] } = useQuery({
    ...runStageEventsOptions(wsId, runId),
    enabled: run !== undefined,
  });
  const { data: gateReviews = [] } = useQuery({
    ...requirementGatesOptions(wsId, requirementId),
    enabled: requirementId !== "",
  });
  const { data: evidence = [] } = useQuery({
    ...requirementEvidenceOptions(wsId, requirementId),
    enabled: requirementId !== "",
  });
  const { data: clarifications = [] } = useQuery({
    ...requirementClarificationsOptions(wsId, requirementId),
    enabled: requirementId !== "",
  });
  const issueId = requirement?.issue_id ?? "";
  const { data: comments = [] } = useQuery({
    ...issueTimelineOptions(issueId),
    enabled: issueId !== "",
  });

  const pageTitle = t(($) => $.run_room.title);
  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  if (isLoading) {
    return (
      <div className="flex flex-1 flex-col min-h-0">
        <div className="flex h-12 shrink-0 items-center border-b px-4">
          <Skeleton className="h-5 w-40" />
        </div>
        <div className="space-y-4 p-6">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  if (!run || !run.id) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {t(($) => $.run_room.not_found)}
      </div>
    );
  }

  const statusLabel =
    run.status === "pending"
      ? t(($) => $.workflows.run_status.pending)
      : run.status === "running"
        ? t(($) => $.workflows.run_status.running)
        : run.status === "completed"
          ? t(($) => $.workflows.run_status.completed)
          : run.status === "failed"
            ? t(($) => $.workflows.run_status.failed)
            : run.status === "terminated"
              ? t(($) => $.workflows.run_status.terminated)
              : run.status;

  const timeline = mergeRunTimeline({
    run,
    events,
    evidence,
    gateReviews,
    clarifications,
    comments,
  });

  const now = new Date().toISOString();
  const maxTokens = contractMaxTokens(workflow?.contract);
  const spent = run.tokens_spent ?? 0;
  const pct = maxTokens ? Math.min(100, (spent / maxTokens) * 100) : null;
  const duration = runDurationSeconds(run, now);

  return (
    <div className="flex flex-1 flex-col min-h-0" data-testid="run-room">
      <BreadcrumbHeader
        segments={
          workflow && workflow.id
            ? [
                { href: wsPaths.ravenWorkflows(), label: t(($) => $.workflows.title) },
                { href: wsPaths.ravenWorkflowDetail(workflow.id), label: workflow.name },
              ]
            : []
        }
        leaf={
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold">
              {t(($) => $.run_room.title)}
            </span>
            <Badge variant="secondary" className={RUN_STATUS_CLASSES[run.status] ?? ""}>
              {statusLabel}
            </Badge>
            {issueId && (
              <AppLink
                href={wsPaths.issueDetail(issueId)}
                className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                {t(($) => $.workflows.detail.view_issue)}
              </AppLink>
            )}
          </div>
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
          {run.termination_reason &&
            (run.status === "failed" || run.status === "terminated") && (
              <RunFailureSummary reason={run.termination_reason} />
            )}

          {/* Zone 1: the live run graph, clarification overlay wired in. */}
          <section data-testid="run-room-graph">
            <h2 className="text-sm font-semibold">{t(($) => $.graph.title)}</h2>
            {workflow && workflow.id ? (
              <RunGraph
                wsId={wsId}
                contract={workflow.contract}
                run={run}
                issueId={issueId || undefined}
                clarifications={clarificationsToGraphInput(clarifications, run.id)}
                className="mt-2"
              />
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                {t(($) => $.run_room.no_contract)}
              </p>
            )}
          </section>

          {/* Zone 3 first in DOM order after the graph: budget telemetry. */}
          <section data-testid="run-room-budget">
            <h2 className="text-sm font-semibold">{t(($) => $.run_room.budget.title)}</h2>
            <div className="mt-2 space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  {t(($) => $.run_room.budget.tokens)}
                </span>
                <span className="tabular-nums" data-testid="budget-tokens">
                  {maxTokens
                    ? `${spent.toLocaleString()} / ${maxTokens.toLocaleString()}`
                    : spent.toLocaleString()}
                </span>
              </div>
              {pct !== null && <Progress value={pct} data-testid="budget-progress" />}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                {duration !== null && (
                  <div className="contents">
                    <dt className="text-muted-foreground">
                      {t(($) => $.run_room.budget.duration)}
                    </dt>
                    <dd className="tabular-nums">{formatRunDuration(duration)}</dd>
                  </div>
                )}
                {(run.usd_spent ?? 0) > 0 && (
                  <div className="contents">
                    <dt className="text-muted-foreground">
                      {t(($) => $.run_room.budget.usd)}
                    </dt>
                    <dd className="tabular-nums">${(run.usd_spent ?? 0).toFixed(2)}</dd>
                  </div>
                )}
              </dl>
            </div>
          </section>

          {/* Zone 2: the merged execution timeline. */}
          <section data-testid="run-room-timeline">
            <h2 className="text-sm font-semibold">{t(($) => $.run_room.timeline.title)}</h2>
            {timeline.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {t(($) => $.run_room.timeline.empty)}
              </p>
            ) : (
              <ol className="mt-3">
                {timeline.map((item) => (
                  <TimelineItemRow key={item.id} item={item} />
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
