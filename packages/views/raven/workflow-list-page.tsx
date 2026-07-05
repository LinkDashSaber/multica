"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  RAVEN_PROMOTION_THRESHOLD,
  ravenWorkflowListOptions,
  ravenWorkflowStatsOptions,
  type RavenWorkflowStats,
} from "@multica/core/raven";
import { Badge } from "@multica/ui/components/ui/badge";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { AppLink, useNavigation } from "../navigation";
import { BreadcrumbHeader } from "../layout/breadcrumb-header";
import { useT } from "../i18n";

/** "3m 20s" style compact duration; em dash when there is nothing to show. */
export function formatRunDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** approved / decided as a percentage string; em dash before any decision. */
export function formatRate(numerator: number, decided: number): string {
  if (decided <= 0) return "—";
  return `${Math.round((numerator / decided) * 100)}%`;
}

export function WorkflowEnabledBadge({ enabled }: { enabled: boolean }) {
  const { t } = useT("raven");
  return (
    <Badge
      variant="secondary"
      className={
        enabled === true
          ? "bg-green-500/15 text-green-600 dark:text-green-400"
          : "bg-muted text-muted-foreground"
      }
      data-testid="workflow-enabled-badge"
    >
      {enabled === true
        ? t(($) => $.workflows.enabled)
        : t(($) => $.workflows.disabled)}
    </Badge>
  );
}

/**
 * Trust promotion progress (issue #25): "production line" once any gate is
 * downgraded to spot checks, otherwise "N more zero-reject reviews".
 */
export function WorkflowTrustCell({ stats }: { stats?: RavenWorkflowStats }) {
  const { t } = useT("raven");
  if ((stats?.promoted_gates ?? 0) > 0) {
    return (
      <Badge
        variant="secondary"
        className="bg-green-500/15 text-green-600 dark:text-green-400"
        data-testid="workflow-production-line"
      >
        {t(($) => $.workflows.trust.production_line)}
      </Badge>
    );
  }
  const streak = stats?.max_gate_streak ?? 0;
  if (streak <= 0) return <span className="text-muted-foreground">—</span>;
  const remaining = Math.max(0, RAVEN_PROMOTION_THRESHOLD - streak);
  return (
    <span className="text-xs text-muted-foreground" data-testid="workflow-trust-progress">
      {t(($) => $.workflows.trust.remaining, { count: remaining })}
    </span>
  );
}

/**
 * Workflow registry list: one row per workflow with run/gate aggregates
 * (run count, pass rate, rejection rate, average run duration).
 */
export function WorkflowListPage() {
  const { t } = useT("raven");
  const wsId = useWorkspaceId();
  const wsPaths = useWorkspacePaths();
  const { push } = useNavigation();

  const pageTitle = t(($) => $.workflows.title);
  // Browser tab / desktop tab title must match the sidebar naming.
  useEffect(() => {
    if (pageTitle) document.title = pageTitle;
  }, [pageTitle]);

  const { data: workflows = [], isLoading } = useQuery(
    ravenWorkflowListOptions(wsId),
  );
  const { data: stats = [] } = useQuery(ravenWorkflowStatsOptions(wsId));
  const statsById = new Map<string, RavenWorkflowStats>(
    stats.map((s) => [s.workflow_id, s]),
  );

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <BreadcrumbHeader
        segments={[]}
        leaf={
          <span className="truncate text-sm font-semibold">
            {t(($) => $.workflows.title)}
          </span>
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-6">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : workflows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t(($) => $.workflows.empty)}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              {/* Stat columns are nowrap and the name cell absorbs the slack
                  (w-full + max-w-0 + truncate), so stats stay fully visible. */}
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="w-full px-3 py-2 font-medium">
                      {t(($) => $.workflows.columns.name)}
                    </th>
                    <th className="whitespace-nowrap px-3 py-2 font-medium">
                      {t(($) => $.workflows.columns.status)}
                    </th>
                    <th className="whitespace-nowrap px-3 py-2 font-medium text-right">
                      {t(($) => $.workflows.columns.runs)}
                    </th>
                    <th className="whitespace-nowrap px-3 py-2 font-medium text-right">
                      {t(($) => $.workflows.columns.active_runs)}
                    </th>
                    <th className="whitespace-nowrap px-3 py-2 font-medium text-right">
                      {t(($) => $.workflows.columns.pass_rate)}
                    </th>
                    <th className="whitespace-nowrap px-3 py-2 font-medium text-right">
                      {t(($) => $.workflows.columns.rejection_rate)}
                    </th>
                    <th className="whitespace-nowrap px-3 py-2 font-medium text-right">
                      {t(($) => $.workflows.columns.avg_duration)}
                    </th>
                    <th className="whitespace-nowrap px-3 py-2 font-medium">
                      {t(($) => $.workflows.trust.column)}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {workflows.map((wf) => {
                    const s = statsById.get(wf.id);
                    const decided =
                      (s?.approved_gates ?? 0) + (s?.rejected_gates ?? 0);
                    return (
                      <tr
                        key={wf.id}
                        data-testid="workflow-row"
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => push(wsPaths.ravenWorkflowDetail(wf.id))}
                      >
                        <td className="w-full max-w-0 px-3 py-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <AppLink
                              href={wsPaths.ravenWorkflowDetail(wf.id)}
                              className="truncate font-medium hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {wf.name}
                            </AppLink>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {t(($) => $.workflows.version, {
                                version: wf.version ?? 1,
                              })}
                            </span>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <WorkflowEnabledBadge enabled={wf.enabled === true} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                          {s?.run_count ?? 0}
                        </td>
                        <td
                          className="whitespace-nowrap px-3 py-2 text-right tabular-nums"
                          data-testid="workflow-active-runs"
                        >
                          {s?.active_runs ?? 0}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                          {formatRate(s?.approved_gates ?? 0, decided)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                          {formatRate(s?.rejected_gates ?? 0, decided)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                          {formatRunDuration(s?.avg_run_seconds ?? 0)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <WorkflowTrustCell stats={s} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
