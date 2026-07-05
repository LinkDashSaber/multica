"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  pendingDecisionPointsOptions,
  type RavenDecisionPoint,
} from "@multica/core/raven";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { BreadcrumbHeader } from "../layout/breadcrumb-header";
import { useT } from "../i18n";
import { DecisionLetterCard, formatPendingDuration } from "./decision-letter-card";

/**
 * Oldest-pending-first ordering for the "待我处理" queue: whichever decision
 * point has waited longest for a human sits at the top. Unparsable timestamps
 * sort last; ties break by id so the order stays stable across refetches.
 */
export function sortDecisionQueue(items: RavenDecisionPoint[]): RavenDecisionPoint[] {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.created_at);
    const tb = Date.parse(b.created_at);
    const va = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY;
    const vb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
    if (va !== vb) return va - vb;
    return a.id.localeCompare(b.id);
  });
}

const EMPTY_ITEMS: RavenDecisionPoint[] = [];

/**
 * 待我处理队列 (issue #21): every decision point still waiting on the current
 * user — gates and clarifications merged — oldest first. Each row shows the
 * three-at-a-glance facts (requirement, stuck stage, pending age) then the
 * full S6 拍板信 card for the response. A resolved card invalidates the query;
 * the row leaves the list and the focus cursor snaps to the next item so
 * continuous triage never loses its place.
 */
export function DecisionQueuePage() {
  const { t } = useT("raven");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();

  const { data: items = EMPTY_ITEMS, isLoading } = useQuery(
    pendingDecisionPointsOptions(wsId),
  );
  const sorted = useMemo(() => sortDecisionQueue(items), [items]);

  // Minute-resolution clock so the pending-age chips stay fresh without a
  // timer per row.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const prevCount = useRef(sorted.length);

  const scrollTo = (id: string | undefined) => {
    if (id) itemRefs.current.get(id)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };

  // Keep the focus cursor valid as the queue shrinks under us. When an item
  // resolves (list shrank), snap onto the new item now sitting at that slot
  // and scroll it into view — the "下一个 / 回队列" 动线 without a click.
  useEffect(() => {
    if (sorted.length === 0) {
      prevCount.current = 0;
      return;
    }
    const shrank = sorted.length < prevCount.current;
    prevCount.current = sorted.length;
    setActiveIndex((i) => {
      const next = Math.min(i, sorted.length - 1);
      if (shrank) scrollTo(sorted[next]?.id);
      return next;
    });
  }, [sorted]);

  const focusItem = (index: number) => {
    const clamped = Math.max(0, Math.min(index, sorted.length - 1));
    setActiveIndex(clamped);
    scrollTo(sorted[clamped]?.id);
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <BreadcrumbHeader
        segments={[]}
        leaf={
          <span className="truncate text-sm font-semibold">
            {t(($) => $.queue.title)}
          </span>
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl p-6">
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : sorted.length === 0 ? (
            <div
              data-testid="queue-empty"
              className="rounded-lg border border-dashed py-16 text-center"
            >
              <p className="text-sm font-medium">{t(($) => $.queue.empty_title)}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t(($) => $.queue.empty_hint)}
              </p>
            </div>
          ) : (
            <>
              {/* Continuous-triage toolbar: remaining count + next/back 动线. */}
              <div
                data-testid="queue-toolbar"
                className="sticky top-0 z-10 -mx-2 mb-4 flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 backdrop-blur"
              >
                <span className="text-sm font-medium">
                  {t(($) => $.queue.remaining, { count: sorted.length })}
                </span>
                <div className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={activeIndex === 0}
                    onClick={() => focusItem(0)}
                  >
                    {t(($) => $.queue.back_to_queue)}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={activeIndex >= sorted.length - 1}
                    onClick={() => focusItem(activeIndex + 1)}
                  >
                    {t(($) => $.queue.next)}
                  </Button>
                </div>
              </div>

              <ol data-testid="queue-list" className="space-y-6">
                {sorted.map((item, index) => {
                  const age = formatPendingDuration(item.created_at, now);
                  return (
                    <li
                      key={`${item.kind}:${item.id}`}
                      data-testid="queue-item"
                      data-kind={item.kind}
                      data-id={item.id}
                      aria-current={index === activeIndex ? "true" : undefined}
                      ref={(el) => {
                        if (el) itemRefs.current.set(item.id, el);
                        else itemRefs.current.delete(item.id);
                      }}
                      className={cn(
                        "scroll-mt-16 rounded-lg border p-4",
                        index === activeIndex && "ring-2 ring-ring/40",
                      )}
                    >
                      {/* Three-at-a-glance: requirement/title, stuck stage, age. */}
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">
                          {item.title || t(($) => $.queue.untitled)}
                        </span>
                        {item.stage && (
                          <Badge variant="outline" data-testid="queue-item-stage">
                            {item.stage}
                          </Badge>
                        )}
                        {age && (
                          <Badge
                            variant="secondary"
                            data-testid="queue-item-age"
                            className="bg-amber-500/15 text-amber-600 dark:text-amber-400"
                          >
                            {t(($) => $.letter.pending_for, { duration: age })}
                          </Badge>
                        )}
                      </div>
                      <DecisionLetterCard
                        wsId={wsId}
                        kind={item.kind}
                        id={item.id}
                        detailHref={
                          item.kind === "gate" ? p.ravenGateDetail(item.id) : undefined
                        }
                      />
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
