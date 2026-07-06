"use client";

import type { InboxItem } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { DecisionLetterCard } from "../../raven/decision-letter-card";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export type RavenDecisionKind = "gate" | "clarify" | "promotion";

// Inbox notification type → decision kind + the `details` field carrying its id.
const RAVEN_DECISION_TYPES: Record<
  string,
  { kind: RavenDecisionKind; idField: string }
> = {
  raven_gate_pending: { kind: "gate", idField: "gate_id" },
  raven_clarify_pending: { kind: "clarify", idField: "clarification_id" },
  raven_promotion_pending: { kind: "promotion", idField: "promotion_id" },
};

/**
 * Resolve an inbox item to the decision point it notifies about, or null when
 * it is not a Raven decision (or its id is missing). Pure — unit tested.
 */
export function ravenDecisionForItem(
  item: InboxItem,
): { kind: RavenDecisionKind; id: string } | null {
  const entry = RAVEN_DECISION_TYPES[item.type];
  if (!entry) return null;
  const id = item.details?.[entry.idField] ?? "";
  if (!id) return null;
  return { kind: entry.kind, id };
}

/**
 * 待我处理 alignment (#31): the inbox is a per-recipient *filtered view* of the
 * primary 待我处理 decision queue (RavenDecisionQueue). Every Raven decision it
 * surfaces — gate, clarify, or promotion — mounts the same self-contained
 * DecisionLetterCard and is actionable in place, exactly as in the queue. A
 * "view in 待我处理" link keeps the primary, complete surface one click away.
 *
 * Population rule: the queue is the complete, workspace-wide, authoritative
 * list of pending decisions. The inbox notifies the addressed human — the
 * issue creator for gate/clarify, the streak-completing reviewer for
 * promotion. Decisions with no human addressee (e.g. agent-created issues)
 * live only in the queue, so the inbox is always a subset of it — never a
 * superset, and no decision is ever lost.
 */
export function InboxDecisionCard({
  item,
  wsId,
}: {
  item: InboxItem;
  wsId: string;
}) {
  const { t } = useT("inbox");
  const wsPaths = useWorkspacePaths();
  const decision = ravenDecisionForItem(item);
  if (!decision) return null;

  return (
    <div
      data-testid="inbox-decision-card"
      className="max-h-[55%] shrink-0 overflow-y-auto border-b"
    >
      <DecisionLetterCard
        wsId={wsId}
        kind={decision.kind}
        id={decision.id}
        detailHref={
          decision.kind === "gate"
            ? wsPaths.ravenGateDetail(decision.id)
            : undefined
        }
        className="p-4"
      />
      <div className="px-4 pb-3">
        <AppLink
          href={wsPaths.ravenDecisions()}
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {t(($) => $.detail.view_in_decision_queue)}
        </AppLink>
      </div>
    </div>
  );
}
