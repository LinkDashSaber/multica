"use client";

import { useQuery } from "@tanstack/react-query";
import {
  issueRequirementOptions,
  parseContractGates,
  parseContractStages,
  ravenWorkflowOptions,
  requirementGatesOptions,
  requirementRunsOptions,
  runStageEventsOptions,
  type RavenGateReview,
  type RavenRun,
  type RavenRunStageEvent,
  type ContractStageView,
  type ContractGateView,
} from "@multica/core/raven";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";

export type StageNodeState = "done" | "active" | "waiting" | "pending";

/**
 * Derive each contract stage's node state from the run's stage event stream
 * and pending gate reviews. Exported for tests.
 *
 * - done: the stage reported an exited event (or the whole run completed);
 * - waiting: a pending gate suspends the run right after this stage (拍板点);
 * - active: entered without exited — the run is inside this stage;
 * - pending: not reached yet.
 */
export function deriveStageStates(
  stages: ContractStageView[],
  contractGates: ContractGateView[],
  run: RavenRun,
  events: RavenRunStageEvent[],
  gates: RavenGateReview[],
): Record<string, StageNodeState> {
  const entered = new Set<string>();
  const exited = new Set<string>();
  for (const e of events) {
    if (e.event === "entered") entered.add(e.stage);
    if (e.event === "exited") exited.add(e.stage);
  }
  const pendingGate = gates.find((g) => g.status === "pending" && g.run_id === run.id);
  const waitingStage = pendingGate
    ? contractGates.find((g) => g.name === pendingGate.gate_name)?.after_stage
    : undefined;

  const states: Record<string, StageNodeState> = {};
  for (const stage of stages) {
    if (waitingStage === stage.name) {
      states[stage.name] = "waiting";
    } else if (run.status === "completed" || exited.has(stage.name)) {
      states[stage.name] = "done";
    } else if (entered.has(stage.name) || run.current_stage === stage.name) {
      states[stage.name] = "active";
    } else {
      states[stage.name] = "pending";
    }
  }
  return states;
}

const DOT_CLASSES: Record<StageNodeState, string> = {
  done: "bg-green-500",
  active: "bg-blue-500 animate-pulse",
  waiting: "bg-amber-500",
  pending: "bg-muted-foreground/30",
};

const LABEL_CLASSES: Record<StageNodeState, string> = {
  done: "text-muted-foreground",
  active: "text-foreground font-medium",
  waiting: "text-amber-600 dark:text-amber-400 font-medium",
  pending: "text-muted-foreground/60",
};

/**
 * Compact delivery-progress strip for issues on the Raven track (issue #15):
 * one node per contract stage, in declaration order. Self-hides for bare
 * issues and for requirements without any run yet.
 */
export function IssueRunStageStrip({
  wsId,
  issueId,
  className,
}: {
  wsId: string;
  issueId: string;
  className?: string;
}) {
  const { t } = useT("raven");

  const { data: requirement } = useQuery(issueRequirementOptions(wsId, issueId));
  const requirementId = requirement?.id ?? "";
  const workflowId = requirement?.workflow_id ?? "";

  const { data: runs = [] } = useQuery({
    ...requirementRunsOptions(wsId, requirementId),
    enabled: requirementId !== "",
  });
  // Newest first — the strip always reflects the latest run.
  const run = runs[0];

  const { data: workflow } = useQuery({
    ...ravenWorkflowOptions(wsId, workflowId),
    enabled: workflowId !== "",
  });
  const { data: events = [] } = useQuery({
    ...runStageEventsOptions(wsId, run?.id ?? ""),
    enabled: run !== undefined,
  });
  const { data: gates = [] } = useQuery({
    ...requirementGatesOptions(wsId, requirementId),
    enabled: requirementId !== "",
  });

  if (!requirement || !run || !workflow) return null;
  const stages = parseContractStages(workflow.contract);
  if (stages.length === 0) return null;

  const states = deriveStageStates(
    stages,
    parseContractGates(workflow.contract),
    run,
    events,
    gates,
  );

  const stateLabel: Record<StageNodeState, string> = {
    done: t(($) => $.stage_strip.done),
    active: t(($) => $.stage_strip.running),
    waiting: t(($) => $.stage_strip.waiting_decision),
    pending: t(($) => $.stage_strip.pending),
  };

  return (
    <section data-testid="run-stage-strip" className={className}>
      <h2 className="text-sm font-semibold">{t(($) => $.stage_strip.title)}</h2>
      <ol className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-2 rounded-md border px-3 py-2">
        {stages.map((stage, i) => {
          const state = states[stage.name] ?? "pending";
          return (
            <li key={stage.name} className="flex items-center gap-1">
              {i > 0 && <span className="mx-1 h-px w-4 shrink-0 bg-border" aria-hidden />}
              <span
                data-testid="stage-node"
                data-stage={stage.name}
                data-state={state}
                title={stage.description ?? stage.name}
                className={cn("flex items-center gap-1.5 text-xs", LABEL_CLASSES[state])}
              >
                <span className={cn("size-2 shrink-0 rounded-full", DOT_CLASSES[state])} aria-hidden />
                {stage.name}
                {state === "waiting" && (
                  <span className="text-[10px]">· {stateLabel.waiting}</span>
                )}
                {state === "active" && (
                  <span className="text-[10px] text-muted-foreground">· {stateLabel.active}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
