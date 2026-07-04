"use client";

import { useEffect, useRef, useState } from "react";
import {
  useRequestRavenRecommendation,
  useRecordRavenRecommendationOutcome,
} from "@multica/core/raven";
import type { RavenRecommendation } from "@multica/core/api/schemas";
import { Button } from "@multica/ui/components/ui/button";
import { Sparkles, X } from "lucide-react";
import { useT } from "../i18n";

// Workflow recommendation on issue create (issue #9). Recommendation ≠
// auto-dispatch: the user must confirm before the issue goes on the Raven
// track. A null workflow in the response means "no confident match" — offer
// the Squad fallback instead. Every decision is recorded server-side for
// recommendation-quality evaluation.
export function WorkflowRecommendationBanner({
  title,
  hasAssignee,
  onUseWorkflow,
  onFallbackSquad,
}: {
  title: string;
  hasAssignee: boolean;
  /** Apply the recommended workflow as the issue assignee. */
  onUseWorkflow: (workflowId: string) => void;
  /** Open the assignee picker so the user grabs a squad instead. */
  onFallbackSquad: () => void;
}) {
  const { t } = useT("raven");
  const [rec, setRec] = useState<RavenRecommendation | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // One recommendation per distinct title: re-asking on every keystroke would
  // both spam the API and churn the stored outcome records.
  const askedFor = useRef("");

  const request = useRequestRavenRecommendation();
  const recordOutcome = useRecordRavenRecommendationOutcome();

  const trimmed = title.trim();
  useEffect(() => {
    if (dismissed || hasAssignee || trimmed.length < 4) return;
    if (askedFor.current === trimmed) return;
    const timer = setTimeout(() => {
      askedFor.current = trimmed;
      request.mutate(
        { title: trimmed },
        {
          onSuccess: (res) => setRec(res.recommendation),
          // Recommendation is a nicety; never block issue creation on it.
          onError: () => {},
        },
      );
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- request.mutate is stable
  }, [trimmed, dismissed, hasAssignee]);

  if (dismissed || hasAssignee || !rec) return null;

  const record = (outcome: "accepted" | "ignored" | "fallback_squad") => {
    recordOutcome.mutate({ id: rec.id, outcome });
  };

  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2"
      data-testid="workflow-recommendation-banner"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
        {rec.workflow_id ? (
          <span className="truncate text-muted-foreground">
            {t(($) => $.recommendation.suggest, { name: rec.workflow_name })}
            {rec.reason ? `（${rec.reason}）` : null}
          </span>
        ) : (
          <span className="truncate text-muted-foreground">
            {t(($) => $.recommendation.no_match)}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {rec.workflow_id ? (
          <Button
            size="sm"
            onClick={() => {
              record("accepted");
              onUseWorkflow(rec.workflow_id as string);
              setDismissed(true);
            }}
          >
            {t(($) => $.recommendation.use)}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              record("fallback_squad");
              onFallbackSquad();
              setDismissed(true);
            }}
          >
            {t(($) => $.recommendation.fallback_squad)}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="px-2"
          aria-label={t(($) => $.recommendation.ignore)}
          onClick={() => {
            record("ignored");
            setDismissed(true);
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
