"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  RAVEN_PROMOTION_THRESHOLD,
  parseContractGates,
  parseContractStages,
  ravenGatePoliciesOptions,
  ravenWorkflowOptions,
  ravenWorkflowRunsOptions,
  useRevokeRavenGatePolicy,
  type RavenWorkflowRun,
} from "@multica/core/raven";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { AppLink } from "../navigation";
import { BreadcrumbHeader } from "../layout/breadcrumb-header";
import { CollapsibleMarkdown } from "../common/collapsible-markdown";
import { useT } from "../i18n";
import { WorkflowEnabledBadge, formatRunDuration } from "./workflow-list-page";
import { RunFailureSummary } from "./run-failure-summary";
import { RunGraph } from "./run-graph";

const RUN_STATUS_CLASSES: Record<string, string> = {
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  completed: "bg-green-500/15 text-green-600 dark:text-green-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
  terminated: "bg-red-500/15 text-red-600 dark:text-red-400",
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

function RunStatusBadge({ status }: { status: string }) {
  const { t } = useT("raven");
  // Server-driven enum — unknown statuses render as-is (API compatibility).
  const label =
    status === "pending"
      ? t(($) => $.workflows.run_status.pending)
      : status === "running"
        ? t(($) => $.workflows.run_status.running)
        : status === "completed"
          ? t(($) => $.workflows.run_status.completed)
          : status === "failed"
            ? t(($) => $.workflows.run_status.failed)
            : status === "terminated"
              ? t(($) => $.workflows.run_status.terminated)
              : status;
  return (
    <Badge variant="secondary" className={RUN_STATUS_CLASSES[status] ?? ""}>
      {label}
    </Badge>
  );
}

// Defensive view of the untyped contract JSON. Anything malformed simply
// renders as an empty section rather than crashing the page.
interface ContractView {
  stages: Array<{ name: string; description?: string }>;
  gates: Array<{ name: string; after_stage?: string }>;
  budget: Array<[string, string]>;
  retry: Array<[string, string]>;
}

function parseContractView(
  contract: unknown,
  labels: { maxTokens: string; maxUsd: string; maxAttempts: string; timeoutSeconds: string },
): ContractView {
  const view: ContractView = { stages: [], gates: [], budget: [], retry: [] };
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return view;
  }
  const obj = contract as Record<string, unknown>;
  // Shared readers handle both stage forms (object / bare string, issue #15).
  view.stages = parseContractStages(contract);
  view.gates = parseContractGates(contract);
  const budget = obj.budget as Record<string, unknown> | undefined;
  if (budget && typeof budget === "object") {
    if (typeof budget.max_tokens === "number" && budget.max_tokens > 0) {
      view.budget.push([labels.maxTokens, budget.max_tokens.toLocaleString()]);
    }
    if (typeof budget.max_usd === "number" && budget.max_usd > 0) {
      view.budget.push([labels.maxUsd, `$${budget.max_usd}`]);
    }
  }
  const retry = obj.retry as Record<string, unknown> | undefined;
  if (retry && typeof retry === "object") {
    if (typeof retry.max_attempts === "number" && retry.max_attempts > 0) {
      view.retry.push([labels.maxAttempts, String(retry.max_attempts)]);
    }
    if (typeof retry.timeout_seconds === "number" && retry.timeout_seconds > 0) {
      view.retry.push([labels.timeoutSeconds, String(retry.timeout_seconds)]);
    }
  }
  return view;
}

const GATE_STATUS_CLASSES: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  approved: "bg-green-500/15 text-green-600 dark:text-green-400",
  rejected: "bg-red-500/15 text-red-600 dark:text-red-400",
};

/**
 * Trust section (issue #25): one row per contract gate with its review mode
 * (full | spot check), the live zero-reject streak, and — for promoted
 * gates — a manual "revert to full review" button.
 */
function WorkflowTrustSection({ wsId, workflowId }: { wsId: string; workflowId: string }) {
  const { t } = useT("raven");
  const { data: policies = [] } = useQuery(ravenGatePoliciesOptions(wsId, workflowId));
  const revokeMutation = useRevokeRavenGatePolicy(wsId);

  if (policies.length === 0) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold">{t(($) => $.workflows.trust.title)}</h2>
      <ul className="mt-2 divide-y rounded-md border">
        {policies.map((policy) => {
          const sampled = policy.mode === "sampled";
          return (
            <li
              key={policy.gate_name}
              className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
              data-testid="workflow-gate-policy-row"
            >
              <span className="font-medium">{policy.gate_name}</span>
              <Badge
                variant="secondary"
                className={
                  sampled
                    ? "bg-green-500/15 text-green-600 dark:text-green-400"
                    : "bg-muted text-muted-foreground"
                }
              >
                {sampled
                  ? t(($) => $.workflows.trust.mode_sampled)
                  : t(($) => $.workflows.trust.mode_full)}
              </Badge>
              {!sampled && (
                <span className="text-xs text-muted-foreground">
                  {t(($) => $.workflows.trust.streak, { count: policy.streak ?? 0 })}
                  {" · "}
                  {t(($) => $.workflows.trust.remaining, {
                    count: Math.max(0, RAVEN_PROMOTION_THRESHOLD - (policy.streak ?? 0)),
                  })}
                </span>
              )}
              {sampled && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={revokeMutation.isPending}
                  onClick={() =>
                    revokeMutation.mutate({ workflowId, gateName: policy.gate_name })
                  }
                  data-testid="revoke-gate-policy"
                >
                  {t(($) => $.workflows.trust.revoke)}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {revokeMutation.isError && (
        <p className="mt-1 text-xs text-destructive">
          {t(($) => $.workflows.trust.revoke_failed)}
        </p>
      )}
    </section>
  );
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: RavenWorkflowRun;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useT("raven");
  const wsPaths = useWorkspacePaths();
  const started = run.created_at ? new Date(run.created_at).toLocaleString() : "";
  const isTerminal =
    run.status === "completed" || run.status === "failed" || run.status === "terminated";
  const ended = isTerminal && run.updated_at ? new Date(run.updated_at).toLocaleString() : "";

  return (
    // Selecting a run drives the run graph above (issue #17). The row itself
    // is the click target; inner links keep their own navigation.
    <li
      className={cn(
        "cursor-pointer px-3 py-2 transition-colors",
        selected ? "bg-accent/60" : "hover:bg-accent/30",
      )}
      data-testid="workflow-run-row"
      data-selected={selected || undefined}
      onClick={onSelect}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <RunStatusBadge status={run.status} />
        <span>{started}</span>
        {ended && <span>→ {ended}</span>}
        {isTerminal && run.created_at && run.updated_at && (
          <span className="tabular-nums">
            {formatRunDuration(
              (new Date(run.updated_at).getTime() - new Date(run.created_at).getTime()) / 1000,
            )}
          </span>
        )}
        {/* Entry to the run room (issue #18). */}
        <AppLink
          href={wsPaths.ravenRunDetail(run.id)}
          data-testid="open-run-room"
          className="ml-auto shrink-0 underline-offset-4 hover:text-foreground hover:underline"
        >
          {t(($) => $.run_room.open)}
        </AppLink>
        {run.issue_id && (
          <AppLink
            href={wsPaths.issueDetail(run.issue_id)}
            className="shrink-0 underline-offset-4 hover:text-foreground hover:underline"
          >
            {t(($) => $.workflows.detail.view_issue)}
          </AppLink>
        )}
      </div>
      {/* Completed runs never show failure residue; the server clears it,
          and the guard keeps older backends from leaking it (API compat). */}
      {run.termination_reason &&
        (run.status === "failed" || run.status === "terminated") && (
          <RunFailureSummary reason={run.termination_reason} className="mt-1" />
        )}
      {(run.gates ?? []).length > 0 && (
        <ul className="mt-2 space-y-1">
          {(run.gates ?? []).map((gate) => (
            <li key={gate.id} className="flex flex-wrap items-center gap-2 text-xs">
              <Badge
                variant="secondary"
                className={GATE_STATUS_CLASSES[gate.status] ?? ""}
              >
                {gate.status}
              </Badge>
              <span className="font-medium">{gate.gate_name}</span>
              {gate.decision_reason && (
                <span className="text-muted-foreground">{gate.decision_reason}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Workflow detail: description, the contract (stages / gates / budget /
 * retry), and the run history with each run's gate decisions.
 */
export function WorkflowDetailPage({ workflowId }: { workflowId: string }) {
  const { t } = useT("raven");
  const wsId = useWorkspaceId();
  const wsPaths = useWorkspacePaths();

  const { data: workflow, isLoading } = useQuery(
    ravenWorkflowOptions(wsId, workflowId),
  );
  const { data: runs = [] } = useQuery(ravenWorkflowRunsOptions(wsId, workflowId));

  // Run selection drives the run graph. Default to the newest run so the
  // page opens "alive"; with no runs the graph shows the design skeleton.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selectedRun =
    runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null;

  const sectionTitle = t(($) => $.workflows.title);
  const pageTitle = workflow?.name
    ? `${workflow.name} · ${sectionTitle}`
    : sectionTitle;
  // Browser tab / desktop tab title must match the sidebar naming.
  useEffect(() => {
    if (pageTitle) document.title = pageTitle;
  }, [pageTitle]);

  if (isLoading) {
    return (
      <div className="flex flex-1 flex-col min-h-0">
        <div className="flex h-12 shrink-0 items-center border-b px-4">
          <Skeleton className="h-5 w-40" />
        </div>
        <div className="space-y-4 p-6">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  if (!workflow || !workflow.id) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {t(($) => $.workflows.not_found)}
      </div>
    );
  }

  const contract = parseContractView(workflow.contract, {
    maxTokens: t(($) => $.workflows.detail.max_tokens),
    maxUsd: t(($) => $.workflows.detail.max_usd),
    maxAttempts: t(($) => $.workflows.detail.max_attempts),
    timeoutSeconds: t(($) => $.workflows.detail.timeout_seconds),
  });

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <BreadcrumbHeader
        segments={[
          { href: wsPaths.ravenWorkflows(), label: t(($) => $.workflows.title) },
        ]}
        leaf={
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold">{workflow.name}</span>
            <WorkflowEnabledBadge enabled={workflow.enabled === true} />
            <span className="shrink-0 text-xs text-muted-foreground">
              {t(($) => $.workflows.version, { version: workflow.version ?? 1 })}
            </span>
          </div>
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
          {workflow.description && (
            <section>
              <h2 className="text-sm font-semibold">
                {t(($) => $.workflows.detail.description)}
              </h2>
              <CollapsibleMarkdown
                content={workflow.description}
                className="mt-2 text-foreground/90"
              />
            </section>
          )}

          <section>
            <h2 className="text-sm font-semibold">
              {t(($) => $.graph.title)}
            </h2>
            <RunGraph
              wsId={wsId}
              contract={workflow.contract}
              run={selectedRun}
              issueId={selectedRun?.issue_id || undefined}
              className="mt-2"
            />
          </section>

          <section>
            <h2 className="text-sm font-semibold">
              {t(($) => $.workflows.detail.contract)}
            </h2>
            <div className="mt-2 space-y-4">
              {contract.stages.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    {t(($) => $.workflows.detail.stages)}
                  </p>
                  <ol className="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
                    {contract.stages.map((stage, i) => (
                      <li key={stage.name} className="flex items-center gap-1.5">
                        {i > 0 && <span className="text-muted-foreground">→</span>}
                        <Badge variant="outline" title={stage.description}>
                          {stage.name}
                        </Badge>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {contract.gates.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    {t(($) => $.workflows.detail.gates)}
                  </p>
                  <ul className="mt-1 space-y-1 text-sm">
                    {contract.gates.map((gate) => (
                      <li key={gate.name} className="flex items-center gap-2">
                        <span className="font-medium">{gate.name}</span>
                        {gate.after_stage && (
                          <span className="text-xs text-muted-foreground">
                            {t(($) => $.workflows.detail.gate_after, {
                              stage: gate.after_stage,
                            })}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {contract.budget.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    {t(($) => $.workflows.detail.budget)}
                  </p>
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    {contract.budget.map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="text-muted-foreground">{key}</dt>
                        <dd className="tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
              {contract.retry.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    {t(($) => $.workflows.detail.retry)}
                  </p>
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    {contract.retry.map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="text-muted-foreground">{key}</dt>
                        <dd className="tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>
          </section>

          <WorkflowTrustSection wsId={wsId} workflowId={workflowId} />

          <section>
            <h2 className="text-sm font-semibold">
              {t(($) => $.workflows.detail.runs)}
            </h2>
            {runs.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {t(($) => $.workflows.detail.runs_empty)}
              </p>
            ) : (
              <ul className="mt-2 divide-y rounded-md border">
                {runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    selected={selectedRun?.id === run.id}
                    onSelect={() => setSelectedRunId(run.id)}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
