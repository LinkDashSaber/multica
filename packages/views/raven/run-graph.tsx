"use client";

// Live run graph (issue #17, ADR-0007): a viewer, never an editor. Design
// mode renders the contract topology as a ghost skeleton; selecting a run
// overlays the real path — states, rework back-edges, clarification Q&A,
// live token spend — on the same picture. All derivation lives in the pure
// run-graph-model; this file is layout + chrome only.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, MessageCircleQuestion, X } from "lucide-react";
import {
  parseContractGates,
  parseContractStages,
  requirementEvidenceOptions,
  requirementGatesOptions,
  runStageEventsOptions,
  useDecideRavenGate,
  type RavenRun,
} from "@multica/core/raven";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { useActorName } from "@multica/core/workspace/hooks";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@multica/ui/components/ui/sheet";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { CollapsibleMarkdown } from "../common/collapsible-markdown";
import { useT } from "../i18n";
import { formatRunDuration } from "./workflow-list-page";
import {
  deriveRunGraph,
  type RunGraph as RunGraphModel,
  type RunGraphClarificationInput,
  type RunGraphGateNode,
  type RunGraphNode,
  type RunGraphStageNode,
} from "./run-graph-model";

// ---------------------------------------------------------------------------
// Fixed-grid layout: every trunk node occupies one column of COL_W pixels, so
// node centers and SVG edge geometry are computable without measuring DOM.
// ---------------------------------------------------------------------------

const COL_W = 168;
const TRUNK_Y = 88; // vertical center of the trunk
const STAGE_W = 144;
const STAGE_H = 60;
const GATE_R = 17; // gate circle radius
const CLARIFY_Y = 14; // clarification chip row center
const REWORK_DEPTH = 46; // how far rework arcs dip below the trunk
const GRAPH_H = 188;

function centerX(column: number): number {
  return column * COL_W + COL_W / 2;
}

function nodeHalfWidth(node: RunGraphNode): number {
  return node.kind === "gate" ? GATE_R : STAGE_W / 2;
}

export interface RunGraphProps {
  wsId: string;
  /** The workflow's untyped contract JSON. */
  contract: unknown;
  /** Selected run, or null for the design-mode ghost skeleton. */
  run?: RavenRun | null;
  /** Issue backing the run — resolves the working agent's avatar. */
  issueId?: string;
  /**
   * Clarification Q&A to overlay as temporary nodes. The 澄清拍板点 table is
   * still in flight (S5); callers adapt comments / gate data into this shape.
   */
  clarifications?: RunGraphClarificationInput[];
  className?: string;
}

/**
 * The live run graph. Self-contained on data: given a run it fetches the
 * stage events, gate reviews and evidence itself (all already-polled query
 * options), so the workflow detail page and the future run room (S4) mount
 * it the same way.
 */
export function RunGraph({
  wsId,
  contract,
  run = null,
  issueId,
  clarifications,
  className,
}: RunGraphProps) {
  const { t } = useT("raven");
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);

  const runId = run?.id ?? "";
  const requirementId = run?.requirement_id ?? "";
  const { data: events = [] } = useQuery({
    ...runStageEventsOptions(wsId, runId),
    enabled: runId !== "",
  });
  const { data: gateReviews = [] } = useQuery({
    ...requirementGatesOptions(wsId, requirementId),
    enabled: requirementId !== "",
  });
  const { data: evidence = [] } = useQuery({
    ...requirementEvidenceOptions(wsId, requirementId),
    enabled: requirementId !== "",
  });
  const { data: issue } = useQuery({
    ...issueDetailOptions(wsId, issueId ?? ""),
    enabled: !!issueId && run !== null,
  });

  const stages = parseContractStages(contract);
  const gates = parseContractGates(contract);
  if (stages.length === 0) return null;

  const graph = deriveRunGraph({
    stages,
    gates,
    run,
    events,
    gateReviews,
    evidence,
    clarifications,
    now: new Date().toISOString(),
  });

  const openNode = graph.nodes.find((n) => n.id === openNodeId) ?? null;
  const width = graph.columns * COL_W;

  return (
    <div data-testid="run-graph" data-mode={graph.mode} className={className}>
      <div className="overflow-x-auto rounded-md border bg-muted/20">
        <div
          className="relative"
          style={{ width, height: GRAPH_H, minWidth: "100%" }}
        >
          <EdgeLayer graph={graph} width={width} />
          {graph.nodes.map((node) =>
            node.kind === "clarification" ? (
              <ClarificationChip
                key={node.id}
                node={node}
                onOpen={() => setOpenNodeId(node.id)}
              />
            ) : node.kind === "gate" ? (
              <GateNode
                key={node.id}
                wsId={wsId}
                node={node}
                onOpen={() => setOpenNodeId(node.id)}
              />
            ) : (
              <StageNode
                key={node.id}
                node={node}
                run={run}
                agent={
                  issue?.assignee_type && issue?.assignee_id
                    ? { type: issue.assignee_type, id: issue.assignee_id }
                    : null
                }
                onOpen={() => setOpenNodeId(node.id)}
              />
            ),
          )}
          {graph.edges
            .filter((e) => e.kind === "rework")
            .map((edge) => {
              const from = graph.nodes.find((n) => n.id === edge.from);
              const to = graph.nodes.find((n) => n.id === edge.to);
              if (!from || !to) return null;
              const mid = (centerX(from.column) + centerX(to.column)) / 2;
              return (
                <span
                  key={edge.id}
                  data-testid="rework-badge"
                  title={edge.reworkReason}
                  className="absolute flex max-w-56 -translate-x-1/2 items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] text-red-600 dark:text-red-400"
                  style={{
                    left: mid,
                    top: TRUNK_Y + STAGE_H / 2 + REWORK_DEPTH - 12,
                  }}
                >
                  <span className="shrink-0 font-medium">
                    {t(($) => $.graph.rework, { count: edge.reworkCount ?? 1 })}
                  </span>
                  {edge.reworkReason && (
                    <span className="truncate">{edge.reworkReason}</span>
                  )}
                </span>
              );
            })}
        </div>
      </div>
      {graph.mode === "design" && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t(($) => $.graph.design_hint)}
        </p>
      )}
      <NodeDrawer
        wsId={wsId}
        node={openNode}
        run={run}
        onClose={() => setOpenNodeId(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edges — one SVG under the node layer. Ghost/pending edges are static;
// completed edges get a particle-flow overlay (CSS dash animation).
// ---------------------------------------------------------------------------

function EdgeLayer({ graph, width }: { graph: RunGraphModel; width: number }) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return (
    <svg
      className="absolute inset-0"
      width={width}
      height={GRAPH_H}
      aria-hidden
    >
      <defs>
        <marker
          id="raven-rework-arrow"
          viewBox="0 0 8 8"
          refX="6"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 z" className="fill-red-500/70" />
        </marker>
      </defs>
      {graph.edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to || from.kind === "clarification" || to.kind === "clarification") {
          return null;
        }
        if (edge.kind === "rework") {
          // Arc dipping below the trunk, pointing back to the reworked stage.
          const x1 = centerX(from.column);
          const x2 = centerX(to.column);
          const y = TRUNK_Y + (from.kind === "gate" ? GATE_R : STAGE_H / 2) + 4;
          const yTo = TRUNK_Y + STAGE_H / 2 + 4;
          const dip = TRUNK_Y + STAGE_H / 2 + REWORK_DEPTH;
          return (
            <path
              key={edge.id}
              data-testid="graph-edge"
              data-edge-kind="rework"
              d={`M ${x1} ${y} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${yTo}`}
              fill="none"
              strokeWidth={1.5}
              className="stroke-red-500/60"
              markerEnd="url(#raven-rework-arrow)"
            />
          );
        }
        const x1 = centerX(from.column) + nodeHalfWidth(from) + 4;
        const x2 = centerX(to.column) - nodeHalfWidth(to) - 4;
        const d = `M ${x1} ${TRUNK_Y} L ${x2} ${TRUNK_Y}`;
        return (
          <g key={edge.id} data-testid="graph-edge" data-edge-state={edge.state}>
            <path
              d={d}
              fill="none"
              strokeWidth={1.5}
              strokeDasharray={edge.state === "ghost" ? "4 4" : undefined}
              className={cn(
                "stroke-border",
                edge.state === "done" && "stroke-primary/25",
              )}
            />
            {edge.state === "done" && (
              <path
                d={d}
                fill="none"
                strokeWidth={2.5}
                strokeLinecap="round"
                className="animate-raven-edge-flow stroke-primary"
              />
            )}
          </g>
        );
      })}
      {/* ×N rework badges live in HTML (RunGraph body) for text rendering. */}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const STAGE_CARD_CLASSES: Record<RunGraphStageNode["state"], string> = {
  ghost: "border-dashed border-border/70 bg-background/60 text-muted-foreground",
  done: "border-border bg-background",
  active: "border-primary/60 bg-background animate-raven-node-breathe",
  pending: "border-border/60 bg-background/60 text-muted-foreground/70",
};

const STAGE_DOT_CLASSES: Record<RunGraphStageNode["state"], string> = {
  ghost: "bg-muted-foreground/30",
  done: "bg-green-500",
  active: "bg-blue-500 animate-pulse",
  pending: "bg-muted-foreground/30",
};

function StageNode({
  node,
  run,
  agent,
  onOpen,
}: {
  node: RunGraphStageNode;
  run: RavenRun | null;
  agent: { type: string; id: string } | null;
  onOpen: () => void;
}) {
  const { t } = useT("raven");
  const { getActorName, getActorInitials, getActorAvatarUrl } = useActorName();

  return (
    <button
      type="button"
      data-testid="graph-node"
      data-node-id={node.id}
      data-state={node.state}
      title={node.description ?? node.name}
      onClick={onOpen}
      className={cn(
        "absolute flex flex-col justify-center gap-1 rounded-lg border px-3 py-2 text-left text-xs shadow-sm transition-colors hover:border-primary/50",
        STAGE_CARD_CLASSES[node.state],
      )}
      style={
        {
          left: centerX(node.column) - STAGE_W / 2,
          top: TRUNK_Y - STAGE_H / 2,
          width: STAGE_W,
          height: STAGE_H,
          "--raven-breathe-color":
            "color-mix(in oklab, var(--primary) 35%, transparent)",
        } as React.CSSProperties
      }
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span
          className={cn("size-2 shrink-0 rounded-full", STAGE_DOT_CLASSES[node.state])}
          aria-hidden
        />
        <span className="truncate font-medium">{node.name}</span>
      </span>
      {node.state === "active" && run ? (
        <span className="flex w-full items-center gap-1.5 text-[10px] text-muted-foreground">
          {agent && (
            <ActorAvatar
              name={getActorName(agent.type, agent.id)}
              initials={getActorInitials(agent.type, agent.id)}
              avatarUrl={getActorAvatarUrl(agent.type, agent.id)}
              isAgent={agent.type === "agent"}
              size={16}
            />
          )}
          <span data-testid="active-tokens" className="tabular-nums transition-all">
            {t(($) => $.graph.tokens, { count: run.tokens_spent ?? 0 })}
          </span>
        </span>
      ) : node.state === "done" ? (
        <span className="flex w-full items-center gap-2 text-[10px] text-muted-foreground">
          {node.durationSeconds !== null && (
            <span className="tabular-nums">
              {formatRunDuration(node.durationSeconds)}
            </span>
          )}
          {node.evidence.length > 0 && (
            <span>
              {t(($) => $.graph.evidence_count, { count: node.evidence.length })}
            </span>
          )}
        </span>
      ) : null}
    </button>
  );
}

const GATE_CIRCLE_CLASSES: Record<RunGraphGateNode["state"], string> = {
  ghost: "border-dashed border-border/70 bg-background/60 text-muted-foreground/60",
  idle: "border-border/60 bg-background/60 text-muted-foreground/60",
  waiting:
    "border-amber-500 bg-amber-500/15 text-amber-600 dark:text-amber-400 animate-raven-node-breathe",
  approved: "border-green-500/50 bg-green-500/10 text-green-600 dark:text-green-400",
  rejected: "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400",
};

function GateNode({
  wsId,
  node,
  onOpen,
}: {
  wsId: string;
  node: RunGraphGateNode;
  onOpen: () => void;
}) {
  const { t } = useT("raven");
  const decideMutation = useDecideRavenGate(wsId);
  const cx = centerX(node.column);

  const approve = () => {
    if (!node.pendingReview) return;
    decideMutation.mutate(
      { gateId: node.pendingReview.id, approve: true, reason: "" },
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
    <>
      <button
        type="button"
        data-testid="graph-node"
        data-node-id={node.id}
        data-state={node.state}
        title={node.name}
        onClick={onOpen}
        className={cn(
          "absolute flex items-center justify-center rounded-full border shadow-sm transition-colors hover:border-primary/50",
          GATE_CIRCLE_CLASSES[node.state],
        )}
        style={
          {
            left: cx - GATE_R,
            top: TRUNK_Y - GATE_R,
            width: GATE_R * 2,
            height: GATE_R * 2,
            "--raven-breathe-color":
              "color-mix(in oklab, var(--color-amber-500) 45%, transparent)",
          } as React.CSSProperties
        }
      >
        {node.state === "approved" ? (
          <Check className="size-4" aria-hidden />
        ) : node.state === "rejected" ? (
          <X className="size-4" aria-hidden />
        ) : (
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
        )}
      </button>
      <span
        className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-muted-foreground"
        style={{ left: cx, top: TRUNK_Y + GATE_R + 4 }}
      >
        {node.name}
      </span>
      {node.state === "waiting" && node.pendingReview && (
        <span
          data-testid="gate-actions"
          className="absolute flex -translate-x-1/2 gap-1"
          style={{ left: cx, top: TRUNK_Y - GATE_R - 30 }}
        >
          <Button
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={decideMutation.isPending}
            onClick={approve}
          >
            {decideMutation.isPending && (
              <Loader2 className="size-3 animate-spin" />
            )}
            {t(($) => $.gate.decision.approve)}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            disabled={decideMutation.isPending}
            onClick={onOpen}
          >
            {t(($) => $.gate.decision.reject)}
          </Button>
        </span>
      )}
    </>
  );
}

function ClarificationChip({
  node,
  onOpen,
}: {
  node: Extract<RunGraphNode, { kind: "clarification" }>;
  onOpen: () => void;
}) {
  const cx = centerX(node.column);
  return (
    <>
      {/* Dashed drop line tying the temporary node to its stage. */}
      <span
        className="absolute w-px border-l border-dashed border-border"
        style={{ left: cx, top: CLARIFY_Y + 10, height: TRUNK_Y - STAGE_H / 2 - CLARIFY_Y - 10 }}
        aria-hidden
      />
      <button
        type="button"
        data-testid="graph-node"
        data-node-id={node.id}
        data-state={node.answer ? "answered" : "open"}
        title={node.question}
        onClick={onOpen}
        className={cn(
          "absolute flex max-w-40 -translate-x-1/2 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]",
          node.answer
            ? "border-border bg-background text-muted-foreground"
            : "border-amber-500/60 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        )}
        style={{ left: cx, top: CLARIFY_Y - 10 }}
      >
        <MessageCircleQuestion className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{node.question}</span>
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Node drawer — rendered stage output, evidence, cost. No raw JSON.
// ---------------------------------------------------------------------------

function NodeDrawer({
  wsId,
  node,
  run,
  onClose,
}: {
  wsId: string;
  node: RunGraphNode | null;
  run: RavenRun | null;
  onClose: () => void;
}) {
  const { t } = useT("raven");
  return (
    <Sheet open={node !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="overflow-y-auto">
        {node?.kind === "stage" && (
          <StageDrawerContent node={node} run={run} />
        )}
        {node?.kind === "gate" && <GateDrawerContent wsId={wsId} node={node} />}
        {node?.kind === "clarification" && (
          <SheetHeader>
            <SheetTitle>{t(($) => $.graph.drawer.clarification)}</SheetTitle>
            <SheetDescription className="sr-only">
              {node.question}
            </SheetDescription>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  {t(($) => $.graph.drawer.question)}
                </p>
                <CollapsibleMarkdown content={node.question} className="mt-1" />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  {t(($) => $.graph.drawer.answer)}
                </p>
                {node.answer ? (
                  <CollapsibleMarkdown content={node.answer} className="mt-1" />
                ) : (
                  <p className="mt-1 text-muted-foreground">
                    {t(($) => $.graph.drawer.unanswered)}
                  </p>
                )}
              </div>
            </div>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}

function StageDrawerContent({
  node,
  run,
}: {
  node: RunGraphStageNode;
  run: RavenRun | null;
}) {
  const { t } = useT("raven");
  const summaries = node.evidence
    .map((e) => e.summary)
    .filter((s) => s !== "");

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="stage-drawer">
      <SheetHeader className="p-0">
        <SheetTitle>{node.name}</SheetTitle>
        <SheetDescription>
          {node.description ?? t(($) => $.graph.drawer.stage)}
        </SheetDescription>
      </SheetHeader>

      <section>
        <h3 className="text-xs font-semibold text-muted-foreground">
          {t(($) => $.graph.drawer.output)}
        </h3>
        {summaries.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {t(($) => $.graph.drawer.no_output)}
          </p>
        ) : (
          <div className="mt-1 space-y-3">
            {summaries.map((summary, i) => (
              <CollapsibleMarkdown key={i} content={summary} />
            ))}
          </div>
        )}
      </section>

      {node.evidence.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground">
            {t(($) => $.graph.drawer.evidence)}
          </h3>
          <ul className="mt-1 divide-y rounded-md border">
            {node.evidence.map((item) => (
              <li key={item.id} className="px-3 py-2 text-xs">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="font-medium text-foreground/80">{item.kind}</span>
                  {item.source && <span>{item.source}</span>}
                  {item.created_at && (
                    <span className="ml-auto shrink-0">
                      {new Date(item.created_at).toLocaleString()}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="text-xs font-semibold text-muted-foreground">
          {t(($) => $.graph.drawer.cost)}
        </h3>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {node.durationSeconds !== null && (
            <div className="contents">
              <dt className="text-muted-foreground">
                {t(($) => $.graph.drawer.duration)}
              </dt>
              <dd className="tabular-nums">
                {formatRunDuration(node.durationSeconds)}
              </dd>
            </div>
          )}
          {run && (
            <div className="contents">
              <dt className="text-muted-foreground">
                {t(($) => $.graph.drawer.run_tokens)}
              </dt>
              <dd className="tabular-nums">
                {(run.tokens_spent ?? 0).toLocaleString()}
              </dd>
            </div>
          )}
        </dl>
      </section>
    </div>
  );
}

function GateDrawerContent({
  wsId,
  node,
}: {
  wsId: string;
  node: RunGraphGateNode;
}) {
  const { t } = useT("raven");
  const decideMutation = useDecideRavenGate(wsId);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");

  const pkg = node.pendingReview?.review_package;
  const pkgSummary =
    pkg && typeof pkg === "object" && !Array.isArray(pkg)
      ? typeof (pkg as Record<string, unknown>).summary === "string"
        ? ((pkg as Record<string, unknown>).summary as string)
        : ""
      : "";
  const decided = node.reviews.filter((r) => r.status !== "pending");

  const submit = (approve: boolean) => {
    if (!node.pendingReview) return;
    const trimmed = reason.trim();
    if (!approve && !trimmed) {
      setReasonError(t(($) => $.gate.decision.reason_required));
      return;
    }
    decideMutation.mutate(
      {
        gateId: node.pendingReview.id,
        approve,
        reason: approve ? "" : trimmed,
      },
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
    <div className="flex flex-col gap-4 p-4" data-testid="gate-drawer">
      <SheetHeader className="p-0">
        <SheetTitle>{node.name}</SheetTitle>
        <SheetDescription>{t(($) => $.graph.drawer.gate)}</SheetDescription>
      </SheetHeader>

      {pkgSummary && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground">
            {t(($) => $.gate.package.title)}
          </h3>
          <CollapsibleMarkdown content={pkgSummary} className="mt-1" />
        </section>
      )}

      {decided.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground">
            {t(($) => $.graph.drawer.past_decisions)}
          </h3>
          <ul className="mt-1 space-y-2">
            {decided.map((r) => (
              <li key={r.id} className="rounded-md border p-2 text-xs">
                <Badge
                  variant="secondary"
                  className={
                    r.status === "approved"
                      ? "bg-green-500/15 text-green-600 dark:text-green-400"
                      : "bg-red-500/15 text-red-600 dark:text-red-400"
                  }
                >
                  {r.status === "approved"
                    ? t(($) => $.gate.status.approved)
                    : t(($) => $.gate.status.rejected)}
                </Badge>
                {r.decision_reason && (
                  <p className="mt-1 whitespace-pre-wrap">{r.decision_reason}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {node.pendingReview && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground">
            {t(($) => $.gate.decision.title)}
          </h3>
          <div className="mt-2 space-y-2">
            <Textarea
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
                disabled={decideMutation.isPending}
                onClick={() => submit(true)}
              >
                {decideMutation.isPending && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                {t(($) => $.gate.decision.approve)}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={decideMutation.isPending}
                onClick={() => submit(false)}
              >
                {t(($) => $.gate.decision.confirm_reject)}
              </Button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
