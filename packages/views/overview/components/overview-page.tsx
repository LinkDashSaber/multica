"use client";

import { useMemo, type ComponentType, type ReactNode } from "react";
import {
  Activity,
  BarChart3,
  Bot,
  CheckCircle2,
  Clock3,
  FolderKanban,
  Gauge,
  ListTodo,
  TrendingUp,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@multica/ui/lib/utils";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@multica/ui/components/ui/card";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@multica/ui/components/ui/tabs";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { issueListOptions } from "@multica/core/issues/queries";
import { projectListOptions } from "@multica/core/projects/queries";
import { agentListOptions } from "@multica/core/workspace/queries";
import {
  dashboardAgentRunTimeOptions,
  dashboardUsageByAgentOptions,
  dashboardUsageDailyOptions,
} from "@multica/core/dashboard";
import { useCustomPricingStore } from "@multica/core/runtimes/custom-pricing-store";
import type { Agent, Issue, Project } from "@multica/core/types";
import { AppLink } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import { PageHeader } from "../../layout/page-header";
import { StatusIcon } from "../../issues/components/status-icon";
import { ProjectIcon } from "../../projects/components/project-icon";
import { useViewingTimezone } from "../../common/use-viewing-timezone";
import {
  aggregateAgentTokens,
  computeDailyTotals,
  formatDuration,
  mergeAgentDashboardRows,
} from "../../dashboard/utils";
import { formatTokens } from "../../runtimes/utils";

const USAGE_DAYS = 30;
const EMPTY_ISSUES: Issue[] = [];
const EMPTY_PROJECTS: Project[] = [];
const EMPTY_AGENTS: Agent[] = [];
const EMPTY_DAILY: import("@multica/core/types").DashboardUsageDaily[] = [];
const EMPTY_BY_AGENT: import("@multica/core/types").DashboardUsageByAgent[] = [];
const EMPTY_RUNTIME: import("@multica/core/types").DashboardAgentRunTime[] = [];

type IconComponent = ComponentType<{ className?: string }>;
type ActivityKind = "issue" | "project" | "agent";
type OverviewT = ReturnType<typeof useT<"overview">>["t"];

interface ActivityItem {
  id: string;
  kind: ActivityKind;
  href: string;
  title: string;
  action: string;
  context: string | null;
  timestamp: string;
  icon: IconComponent;
  node?: ReactNode;
}

interface RuntimeTotals {
  seconds: number;
  taskCount: number;
  failedCount: number;
}

interface ProjectWrapRow {
  id: string;
  project: Project | null;
  issues: Issue[];
  latestAt: string;
  issueCount: number;
  doneCount: number;
  resourceCount: number;
}

function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

function formatCount(n: number): string {
  return n.toLocaleString();
}

function isOpenIssue(issue: Issue): boolean {
  return issue.status !== "done" && issue.status !== "cancelled";
}

function nearSameTimestamp(a: string, b: string): boolean {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 2_000;
}

function startOfLocalDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function dayLabel(timestamp: string, todayLabel: string, yesterdayLabel: string): string {
  const date = new Date(timestamp);
  const today = startOfLocalDay(new Date());
  const day = startOfLocalDay(date);
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diffDays === 0) return todayLabel;
  if (diffDays === 1) return yesterdayLabel;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function activityTone(kind: ActivityKind): string {
  switch (kind) {
    case "issue":
      return "bg-brand/10 text-brand ring-brand/20";
    case "project":
      return "bg-success/10 text-success ring-success/20";
    case "agent":
      return "bg-muted text-muted-foreground ring-border";
  }
}

export function OverviewPage() {
  const { t } = useT("overview");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const viewTZ = useViewingTimezone();

  useCustomPricingStore((s) => s.pricings);

  const issuesQuery = useQuery(issueListOptions(wsId));
  const projectsQuery = useQuery(projectListOptions(wsId));
  const agentsQuery = useQuery(agentListOptions(wsId));
  const dailyQuery = useQuery(
    dashboardUsageDailyOptions(wsId, USAGE_DAYS, null, viewTZ),
  );
  const byAgentQuery = useQuery(
    dashboardUsageByAgentOptions(wsId, USAGE_DAYS, null, viewTZ),
  );
  const runTimeQuery = useQuery(
    dashboardAgentRunTimeOptions(wsId, USAGE_DAYS, null, viewTZ),
  );

  const issues = issuesQuery.data ?? EMPTY_ISSUES;
  const projects = projectsQuery.data ?? EMPTY_PROJECTS;
  const agents = agentsQuery.data ?? EMPTY_AGENTS;
  const dailyUsage = dailyQuery.data ?? EMPTY_DAILY;
  const byAgentUsage = byAgentQuery.data ?? EMPTY_BY_AGENT;
  const runTimeRows = runTimeQuery.data ?? EMPTY_RUNTIME;

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent] as const)),
    [agents],
  );

  const tokenTotals = useMemo(
    () => computeDailyTotals(dailyUsage),
    [dailyUsage],
  );
  const runtimeTotals = useMemo(
    () =>
      runTimeRows.reduce<RuntimeTotals>(
        (acc, row) => ({
          seconds: acc.seconds + row.total_seconds,
          taskCount: acc.taskCount + row.task_count,
          failedCount: acc.failedCount + row.failed_count,
        }),
        { seconds: 0, taskCount: 0, failedCount: 0 },
      ),
    [runTimeRows],
  );
  const agentRows = useMemo(
    () => mergeAgentDashboardRows(aggregateAgentTokens(byAgentUsage), runTimeRows),
    [byAgentUsage, runTimeRows],
  );

  const activityItems = useMemo(() => {
    const issueItems: ActivityItem[] = issues.map((issue) => {
      const project = issue.project_id ? projectById.get(issue.project_id) : null;
      const created = nearSameTimestamp(issue.created_at, issue.updated_at);
      const action =
        issue.status === "done"
          ? t(($) => $.activity.actions.issue_done)
          : issue.status === "blocked"
            ? t(($) => $.activity.actions.issue_blocked)
            : created
              ? t(($) => $.activity.actions.issue_created)
              : t(($) => $.activity.actions.issue_updated);
      return {
        id: `issue:${issue.id}`,
        kind: "issue" as const,
        href: paths.issueDetail(issue.id),
        title: issue.identifier
          ? `${issue.identifier} ${issue.title}`
          : issue.title,
        action,
        context: project?.title ?? null,
        timestamp: issue.updated_at,
        icon: ListTodo,
        node: <StatusIcon status={issue.status} className="size-3.5" />,
      };
    });

    const projectItems: ActivityItem[] = projects.map((project) => ({
      id: `project:${project.id}`,
      kind: "project" as const,
      href: paths.projectDetail(project.id),
      title: project.title,
      action: nearSameTimestamp(project.created_at, project.updated_at)
        ? t(($) => $.activity.actions.project_created)
        : t(($) => $.activity.actions.project_updated),
      context:
        project.issue_count > 0
          ? t(($) => $.activity.issue_count, { count: project.issue_count })
          : null,
      timestamp: project.updated_at,
      icon: FolderKanban,
      node: <ProjectIcon project={project} size="sm" />,
    }));

    const agentItems: ActivityItem[] = agents.map((agent) => ({
      id: `agent:${agent.id}`,
      kind: "agent" as const,
      href: paths.agentDetail(agent.id),
      title: agent.name,
      action: agent.archived_at
        ? t(($) => $.activity.actions.agent_archived)
        : nearSameTimestamp(agent.created_at, agent.updated_at)
          ? t(($) => $.activity.actions.agent_created)
          : t(($) => $.activity.actions.agent_updated),
      context: t(($) => $.status.agent[agent.status]),
      timestamp: agent.archived_at ?? agent.updated_at,
      icon: Bot,
    }));

    return [...issueItems, ...projectItems, ...agentItems]
      .toSorted((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 18);
  }, [agents, issues, paths, projectById, projects, t]);

  const activityGroups = useMemo(() => {
    const groups = new Map<string, { label: string; items: ActivityItem[] }>();
    for (const item of activityItems) {
      const date = startOfLocalDay(new Date(item.timestamp));
      const key = date.toISOString();
      const label = dayLabel(
        item.timestamp,
        t(($) => $.dates.today),
        t(($) => $.dates.yesterday),
      );
      const group = groups.get(key) ?? { label, items: [] };
      group.items.push(item);
      groups.set(key, group);
    }
    return Array.from(groups.values());
  }, [activityItems, t]);

  const projectWrap = useMemo<ProjectWrapRow[]>(() => {
    const rows = new Map<string, ProjectWrapRow>();
    for (const project of projects) {
      rows.set(project.id, {
        id: project.id,
        project,
        issues: [],
        latestAt: project.updated_at,
        issueCount: project.issue_count,
        doneCount: project.done_count,
        resourceCount: project.resource_count,
      });
    }

    const unassignedId = "__unassigned__";
    for (const issue of issues) {
      const id = issue.project_id ?? unassignedId;
      const project = issue.project_id ? projectById.get(issue.project_id) ?? null : null;
      const current =
        rows.get(id) ??
        ({
          id,
          project,
          issues: [],
          latestAt: issue.updated_at,
          issueCount: 0,
          doneCount: 0,
          resourceCount: 0,
        } satisfies ProjectWrapRow);
      current.issues.push(issue);
      current.latestAt =
        new Date(issue.updated_at).getTime() > new Date(current.latestAt).getTime()
          ? issue.updated_at
          : current.latestAt;
      if (!project) {
        current.issueCount += 1;
        if (issue.status === "done") current.doneCount += 1;
      }
      rows.set(id, current);
    }

    return Array.from(rows.values())
      .filter((row) => row.project || row.issues.length > 0)
      .toSorted((a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime())
      .slice(0, 8);
  }, [issues, projectById, projects]);

  const openIssueCount = issues.filter(isOpenIssue).length;
  const workingAgentCount = agents.filter((agent) => agent.status === "working").length;
  const usageLoading =
    dailyQuery.isLoading || byAgentQuery.isLoading || runTimeQuery.isLoading;
  const activityLoading =
    issuesQuery.isLoading || projectsQuery.isLoading || agentsQuery.isLoading;
  const totalTokens =
    tokenTotals.input +
    tokenTotals.output +
    tokenTotals.cacheRead +
    tokenTotals.cacheWrite;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader>
        <div className="flex min-w-0 items-center gap-2">
          <BarChart3 className="size-4 text-muted-foreground" />
          <h1 className="truncate font-heading text-sm font-semibold">
            {t(($) => $.title)}
          </h1>
        </div>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-4 md:p-6">
          <div className="flex flex-col gap-1">
            <h2 className="font-heading text-xl font-semibold leading-tight">
              {t(($) => $.heading)}
            </h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t(($) => $.subtitle)}
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              icon={TrendingUp}
              label={t(($) => $.summary.cost_label, { days: USAGE_DAYS })}
              value={
                usageLoading ? (
                  <Skeleton className="h-8 w-20" />
                ) : (
                  formatMoney(tokenTotals.cost)
                )
              }
              hint={t(($) => $.summary.runtime_hint, {
                duration: formatDuration(
                  runtimeTotals.seconds,
                  t(($) => $.duration.less_than_minute),
                ),
              })}
              tone="brand"
            />
            <MetricCard
              icon={Gauge}
              label={t(($) => $.summary.tokens_label, { days: USAGE_DAYS })}
              value={usageLoading ? <Skeleton className="h-8 w-20" /> : formatTokens(totalTokens)}
              hint={t(($) => $.summary.tokens_hint, {
                input: formatTokens(tokenTotals.input),
                output: formatTokens(tokenTotals.output),
              })}
              tone="default"
            />
            <MetricCard
              icon={CheckCircle2}
              label={t(($) => $.summary.tasks_label, { days: USAGE_DAYS })}
              value={
                usageLoading ? (
                  <Skeleton className="h-8 w-16" />
                ) : (
                  formatCount(runtimeTotals.taskCount || tokenTotals.taskCount)
                )
              }
              hint={t(($) => $.summary.failed_hint, {
                count: runtimeTotals.failedCount,
              })}
              tone="success"
            />
            <MetricCard
              icon={ListTodo}
              label={t(($) => $.summary.open_work_label)}
              value={
                activityLoading ? (
                  <Skeleton className="h-8 w-16" />
                ) : (
                  formatCount(openIssueCount)
                )
              }
              hint={t(($) => $.summary.open_work_hint, {
                count: workingAgentCount,
              })}
              tone="warning"
            />
          </div>

          <Tabs defaultValue="activity" className="gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <TabsList>
                <TabsTrigger value="activity">
                  <Activity className="size-3.5" />
                  {t(($) => $.tabs.activity)}
                </TabsTrigger>
                <TabsTrigger value="wrapup">
                  <FolderKanban className="size-3.5" />
                  {t(($) => $.tabs.wrapup)}
                </TabsTrigger>
                <TabsTrigger value="usage">
                  <BarChart3 className="size-3.5" />
                  {t(($) => $.tabs.usage)}
                </TabsTrigger>
              </TabsList>
              <div className="text-xs text-muted-foreground">
                {t(($) => $.window_label, { days: USAGE_DAYS })}
              </div>
            </div>

            <TabsContent value="activity" className="mt-0">
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.9fr)]">
                <ActivityCard
                  groups={activityGroups}
                  loading={activityLoading}
                  timeAgo={timeAgo}
                  t={t}
                />
                <ProjectWrapCard
                  rows={projectWrap}
                  loading={projectsQuery.isLoading || issuesQuery.isLoading}
                  timeAgo={timeAgo}
                  paths={paths}
                  t={t}
                />
              </div>
            </TabsContent>

            <TabsContent value="wrapup" className="mt-0">
              <ProjectWrapCard
                rows={projectWrap}
                loading={projectsQuery.isLoading || issuesQuery.isLoading}
                timeAgo={timeAgo}
                paths={paths}
                t={t}
                expanded
              />
            </TabsContent>

            <TabsContent value="usage" className="mt-0">
              <UsageSnapshot
                rows={agentRows}
                agentById={agentById}
                totals={tokenTotals}
                runtimeTotals={runtimeTotals}
                loading={usageLoading}
                t={t}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: IconComponent;
  label: string;
  value: ReactNode;
  hint: ReactNode;
  tone: "brand" | "success" | "warning" | "default";
}) {
  const toneClass =
    tone === "brand"
      ? "bg-brand/10 text-brand"
      : tone === "success"
        ? "bg-success/10 text-success"
        : tone === "warning"
          ? "bg-warning/10 text-warning"
          : "bg-muted text-muted-foreground";
  return (
    <Card size="sm" className="rounded-lg">
      <CardContent className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="mt-2 flex h-8 items-center text-2xl font-semibold leading-none tabular-nums">
            {value}
          </div>
          <div className="mt-2 truncate text-xs text-muted-foreground">
            {hint}
          </div>
        </div>
        <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-md", toneClass)}>
          <Icon className="size-4" />
        </div>
      </CardContent>
    </Card>
  );
}

function ActivityCard({
  groups,
  loading,
  timeAgo,
  t,
}: {
  groups: { label: string; items: ActivityItem[] }[];
  loading: boolean;
  timeAgo: (dateStr: string) => string;
  t: OverviewT;
}) {
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle>{t(($) => $.activity.title)}</CardTitle>
        <CardDescription>{t(($) => $.activity.description)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <ListSkeleton />
        ) : groups.length === 0 ? (
          <EmptyState
            icon={Clock3}
            title={t(($) => $.activity.empty_title)}
            body={t(($) => $.activity.empty_body)}
          />
        ) : (
          groups.map((group) => (
            <div key={group.label} className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.label}
              </div>
              <div className="divide-y rounded-lg border">
                {group.items.map((item) => (
                  <ActivityRow key={item.id} item={item} timeAgo={timeAgo} t={t} />
                ))}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function ActivityRow({
  item,
  timeAgo,
  t,
}: {
  item: ActivityItem;
  timeAgo: (dateStr: string) => string;
  t: OverviewT;
}) {
  const Icon = item.icon;
  return (
    <div className="flex min-h-16 items-center gap-3 px-3 py-2.5">
      <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-md ring-1", activityTone(item.kind))}>
        {item.node ?? <Icon className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm text-muted-foreground">{item.action}</span>
          <AppLink
            href={item.href}
            className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
          >
            {item.title}
          </AppLink>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{timeAgo(item.timestamp)}</span>
          {item.context && (
            <>
              <span className="text-muted-foreground/60">/</span>
              <span className="truncate">{item.context}</span>
            </>
          )}
        </div>
      </div>
      <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
        {t(($) => $.activity.kind[item.kind])}
      </span>
    </div>
  );
}

function ProjectWrapCard({
  rows,
  loading,
  timeAgo,
  paths,
  t,
  expanded = false,
}: {
  rows: ProjectWrapRow[];
  loading: boolean;
  timeAgo: (dateStr: string) => string;
  paths: ReturnType<typeof useWorkspacePaths>;
  t: OverviewT;
  expanded?: boolean;
}) {
  const visibleRows = expanded ? rows : rows.slice(0, 5);
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle>{t(($) => $.wrapup.title)}</CardTitle>
        <CardDescription>{t(($) => $.wrapup.description)}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton />
        ) : visibleRows.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title={t(($) => $.wrapup.empty_title)}
            body={t(($) => $.wrapup.empty_body)}
          />
        ) : (
          <div className="divide-y rounded-lg border">
            {visibleRows.map((row) => (
              <ProjectWrapRowItem
                key={row.id}
                row={row}
                timeAgo={timeAgo}
                paths={paths}
                t={t}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProjectWrapRowItem({
  row,
  timeAgo,
  paths,
  t,
}: {
  row: ProjectWrapRow;
  timeAgo: (dateStr: string) => string;
  paths: ReturnType<typeof useWorkspacePaths>;
  t: OverviewT;
}) {
  const openCount = row.project
    ? Math.max(0, row.issueCount - row.doneCount)
    : row.issues.filter(isOpenIssue).length;
  const recentIssues = row.issues
    .toSorted((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 3);
  const title = row.project?.title ?? t(($) => $.wrapup.no_project);
  const href = row.project ? paths.projectDetail(row.project.id) : paths.issues();

  return (
    <div className="flex gap-3 px-3 py-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        {row.project ? (
          <ProjectIcon project={row.project} size="sm" />
        ) : (
          <FolderKanban className="size-4 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <AppLink href={href} className="truncate text-sm font-medium hover:underline">
            {title}
          </AppLink>
          <span className="text-xs text-muted-foreground">
            {timeAgo(row.latestAt)}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge variant="outline" className="rounded-md">
            {t(($) => $.wrapup.open_issues, { count: openCount })}
          </Badge>
          <Badge variant="outline" className="rounded-md">
            {t(($) => $.wrapup.done_issues, { count: row.doneCount })}
          </Badge>
          {row.resourceCount > 0 && (
            <Badge variant="outline" className="rounded-md">
              {t(($) => $.wrapup.resources, { count: row.resourceCount })}
            </Badge>
          )}
        </div>
        {recentIssues.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {recentIssues.map((issue) => (
              <AppLink
                key={issue.id}
                href={paths.issueDetail(issue.id)}
                className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <StatusIcon status={issue.status} className="size-3 shrink-0" />
                <span className="truncate">
                  {issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title}
                </span>
              </AppLink>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function UsageSnapshot({
  rows,
  agentById,
  totals,
  runtimeTotals,
  loading,
  t,
}: {
  rows: ReturnType<typeof mergeAgentDashboardRows>;
  agentById: Map<string, Agent>;
  totals: ReturnType<typeof computeDailyTotals>;
  runtimeTotals: RuntimeTotals;
  loading: boolean;
  t: OverviewT;
}) {
  const totalTokens =
    totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle>{t(($) => $.usage.title)}</CardTitle>
        <CardDescription>
          {t(($) => $.usage.description, { days: USAGE_DAYS })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <UsageMiniStat
            label={t(($) => $.usage.cost)}
            value={loading ? <Skeleton className="h-6 w-16" /> : formatMoney(totals.cost)}
          />
          <UsageMiniStat
            label={t(($) => $.usage.tokens)}
            value={loading ? <Skeleton className="h-6 w-16" /> : formatTokens(totalTokens)}
          />
          <UsageMiniStat
            label={t(($) => $.usage.run_time)}
            value={
              loading ? (
                <Skeleton className="h-6 w-16" />
              ) : (
                formatDuration(
                  runtimeTotals.seconds,
                  t(($) => $.duration.less_than_minute),
                )
              )
            }
          />
        </div>

        {loading ? (
          <ListSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Bot}
            title={t(($) => $.usage.empty_title)}
            body={t(($) => $.usage.empty_body)}
          />
        ) : (
          <div className="divide-y rounded-lg border">
            {rows.slice(0, 8).map((row) => {
              const agent = agentById.get(row.agentId);
              return (
                <div key={row.agentId} className="grid gap-3 px-3 py-3 md:grid-cols-[minmax(0,1fr)_120px_120px_120px] md:items-center">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Bot className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {agent?.name ?? t(($) => $.usage.unknown_agent)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t(($) => $.usage.tasks, { count: row.taskCount })}
                      </div>
                    </div>
                  </div>
                  <UsageCell label={t(($) => $.usage.cost)} value={formatMoney(row.cost)} />
                  <UsageCell label={t(($) => $.usage.tokens)} value={formatTokens(row.tokens)} />
                  <UsageCell
                    label={t(($) => $.usage.run_time)}
                    value={formatDuration(row.seconds, t(($) => $.duration.less_than_minute))}
                  />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UsageMiniStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex h-6 items-center text-lg font-semibold tabular-nums">
        {value}
      </div>
    </div>
  );
}

function UsageCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground md:hidden">
        {label}
      </div>
      <div className="text-sm font-medium tabular-nums md:text-right">{value}</div>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: IconComponent;
  title: string;
  body: string;
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed px-4 py-8 text-center">
      <Icon className="size-5 text-muted-foreground" />
      <div className="mt-3 text-sm font-medium">{title}</div>
      <div className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-lg border px-3 py-3">
          <Skeleton className="size-8 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
