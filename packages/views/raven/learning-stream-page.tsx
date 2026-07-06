"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  ravenLearningsOptions,
  useTriageRavenLearning,
} from "@multica/core/raven";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { BreadcrumbHeader } from "../layout/breadcrumb-header";
import { useT } from "../i18n";
import { LearningList, LearningDestinationsLegend } from "./learning-list";

/**
 * Learning stream (沉淀流, issue #22): every execution self-report in the
 * workspace, newest first, with triage actions — promote towards one of the
 * three compounding destinations or mark expired.
 */
export function LearningStreamPage() {
  const { t } = useT("raven");
  const wsId = useWorkspaceId();

  const { data: learnings = [], isLoading } = useQuery(ravenLearningsOptions(wsId));
  const triage = useTriageRavenLearning(wsId);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <BreadcrumbHeader
        segments={[]}
        leaf={
          <span className="truncate text-sm font-semibold">
            {t(($) => $.learnings.title)}
          </span>
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
          {/* Inline guidance (#29): what 沉淀 is and what each destination does.
              Always visible, so the empty first-run explains the mechanism. */}
          <section
            data-testid="learnings-about"
            className="rounded-md border bg-muted/30 p-4"
          >
            <p className="text-sm text-muted-foreground">
              {t(($) => $.learnings.about.body)}
            </p>
            <div className="mt-3">
              <LearningDestinationsLegend />
            </div>
          </section>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <LearningList
              learnings={learnings}
              onPromote={(l, destination) =>
                triage.mutate({ learningId: l.id, status: "promoted", promotedTo: destination })
              }
              onExpire={(l) => triage.mutate({ learningId: l.id, status: "expired" })}
            />
          )}
          {triage.isError && (
            <p className="mt-2 text-sm text-destructive">
              {t(($) => $.learnings.action_failed)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
