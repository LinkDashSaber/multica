"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useActorName } from "@multica/core/workspace/hooks";
import {
  issueRequirementOptions,
  requirementEvidenceOptions,
  requirementGatesOptions,
  requirementTransitionsOptions,
  type RavenEvidence,
  type RavenGateReview,
  type RavenTransition,
} from "@multica/core/raven";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@multica/ui/components/ui/collapsible";
import { STATE_LABELS, STATE_CLASSES } from "../issues/components/raven-lifecycle-badge";
import { CollapsibleMarkdown } from "../common/collapsible-markdown";
import { useT } from "../i18n";

interface TimelineEvent {
  key: string;
  /** ISO timestamp used for the chronological merge. */
  at: string;
  node: ReactNode;
}

const GATE_VERDICT_CLASSES: Record<string, string> = {
  approved: "bg-green-500/15 text-green-600 dark:text-green-400",
  rejected: "bg-red-500/15 text-red-600 dark:text-red-400",
};

/**
 * Merge transitions + evidence + gate reviews into one chronological list.
 * Exported for tests; the component below feeds it from queries.
 */
export function mergeTimelineEvents(
  transitions: RavenTransition[],
  evidence: RavenEvidence[],
  gates: RavenGateReview[],
  render: {
    transition: (t: RavenTransition) => ReactNode;
    evidence: (e: RavenEvidence) => ReactNode;
    gateOpened: (g: RavenGateReview) => ReactNode;
    gateDecided: (g: RavenGateReview) => ReactNode;
  },
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const t of transitions) {
    events.push({ key: `t-${t.id}`, at: t.created_at, node: render.transition(t) });
  }
  for (const e of evidence) {
    events.push({ key: `e-${e.id}`, at: e.created_at, node: render.evidence(e) });
  }
  for (const g of gates) {
    events.push({ key: `g-${g.id}-open`, at: g.created_at, node: render.gateOpened(g) });
    if (g.decided_at) {
      events.push({ key: `g-${g.id}-decide`, at: g.decided_at, node: render.gateDecided(g) });
    }
  }
  // Stable chronological sort; ISO-8601 strings compare lexicographically.
  return events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Full audit trail of one requirement: state changes (actor + reason),
 * evidence records, and gate open/decide events, merged chronologically.
 */
export function RequirementTimeline({
  wsId,
  requirementId,
  hideTitle,
}: {
  wsId: string;
  requirementId: string;
  /** The collapsible issue section already renders the title in its trigger. */
  hideTitle?: boolean;
}) {
  const { t } = useT("raven");
  const { getActorName } = useActorName();

  const { data: transitions = [] } = useQuery(
    requirementTransitionsOptions(wsId, requirementId),
  );
  const { data: evidence = [] } = useQuery(
    requirementEvidenceOptions(wsId, requirementId),
  );
  const { data: gates = [] } = useQuery(
    requirementGatesOptions(wsId, requirementId),
  );

  const actorLabel = (actorType: string, actorId: string): string => {
    if (!actorType || actorType === "system" || !actorId) {
      return t(($) => $.timeline.system);
    }
    // Transition actor "user" maps onto the member directory.
    return getActorName(actorType === "user" ? "member" : actorType, actorId);
  };

  const when = (iso: string) => (iso ? new Date(iso).toLocaleString() : "");

  const events = mergeTimelineEvents(transitions, evidence, gates, {
    transition: (tr) => (
      <div data-testid="timeline-transition">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className={STATE_CLASSES[tr.to_state] ?? ""}>
            {STATE_LABELS[tr.to_state] ?? tr.to_state}
          </Badge>
          <span>
            {t(($) => $.timeline.state_change, {
              state: STATE_LABELS[tr.to_state] ?? tr.to_state,
            })}
          </span>
          <span>
            {t(($) => $.timeline.by_actor, {
              name: actorLabel(tr.actor_type, tr.actor_id),
            })}
          </span>
          <span className="ml-auto shrink-0">{when(tr.created_at)}</span>
        </div>
        {tr.reason && (
          <p className="mt-1 whitespace-pre-wrap text-sm">{tr.reason}</p>
        )}
      </div>
    ),
    evidence: (ev) => (
      <div data-testid="timeline-evidence">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">
            {t(($) => $.timeline.evidence)}
          </span>
          <span>{ev.kind}</span>
          {ev.source && <span>{ev.source}</span>}
          <span className="ml-auto shrink-0">{when(ev.created_at)}</span>
        </div>
        {ev.summary && (
          <CollapsibleMarkdown content={ev.summary} className="mt-1" />
        )}
      </div>
    ),
    gateOpened: (g) => (
      <div
        data-testid="timeline-gate-opened"
        className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      >
        <span className="font-medium text-foreground/80">
          {t(($) => $.timeline.gate_opened, { name: g.gate_name })}
        </span>
        <span className="ml-auto shrink-0">{when(g.created_at)}</span>
      </div>
    ),
    gateDecided: (g) => (
      <div data-testid="timeline-gate-decided">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className={GATE_VERDICT_CLASSES[g.status] ?? ""}>
            {g.status}
          </Badge>
          <span className="font-medium text-foreground/80">
            {g.status === "rejected"
              ? t(($) => $.timeline.gate_rejected, { name: g.gate_name })
              : t(($) => $.timeline.gate_approved, { name: g.gate_name })}
          </span>
          {g.decided_by && (
            <span>
              {t(($) => $.timeline.by_actor, {
                name: getActorName("member", g.decided_by),
              })}
            </span>
          )}
          <span className="ml-auto shrink-0">{g.decided_at ? when(g.decided_at) : ""}</span>
        </div>
        {g.decision_reason && (
          <p className="mt-1 whitespace-pre-wrap text-sm">{g.decision_reason}</p>
        )}
      </div>
    ),
  });

  return (
    <section data-testid="requirement-timeline">
      {hideTitle !== true && (
        <h2 className="text-sm font-semibold">{t(($) => $.timeline.title)}</h2>
      )}
      {events.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t(($) => $.timeline.empty)}
        </p>
      ) : (
        <ol className="mt-2 divide-y rounded-md border">
          {events.map((event) => (
            <li key={event.key} className="px-3 py-2">
              {event.node}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Collapsible audit timeline for an issue's requirement. Renders nothing for
 * bare issues that never opted into the Raven track (ADR-0006).
 */
export function IssueRequirementTimeline({
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
  if (!requirement) return null;

  return (
    <Collapsible defaultOpen={false} className={className}>
      <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-semibold">
        <ChevronRight className="size-3.5 transition-transform duration-200 group-data-[panel-open]:rotate-90" />
        {t(($) => $.timeline.title)}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <RequirementTimeline wsId={wsId} requirementId={requirement.id} hideTitle />
      </CollapsibleContent>
    </Collapsible>
  );
}
