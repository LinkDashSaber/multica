"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useActorName } from "@multica/core/workspace/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { skillListOptions } from "@multica/core/workspace/queries";
import {
  clarificationOptions,
  findComposition,
  gateOptions,
  parseClarifyQuestions,
  parseContractGates,
  parseContractStages,
  ravenPromotionOptions,
  ravenRequirementOptions,
  ravenWorkflowOptions,
  ravenWorkflowStatsOptions,
  requirementEvidenceOptions,
  requirementRunsOptions,
  useAnswerRavenClarification,
  useCancelRavenRequirement,
  useDecideRavenGate,
  useDecideRavenPromotion,
  type ClarifyQuestionView,
  type ContractStageView,
  type RavenClarification,
  type RavenGateReview,
} from "@multica/core/raven";

// parseClarifyQuestions + ClarifyQuestionView now live in @multica/core (zod-
// validated, issue #30); re-exported so the views index and existing tests
// keep importing them from here.
export { parseClarifyQuestions };
export type { ClarifyQuestionView };
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { AppLink } from "../navigation";
import { CollapsibleMarkdown } from "../common/collapsible-markdown";
import { STATE_CLASSES, STATE_LABELS } from "../issues/components/raven-lifecycle-badge";
import { formatRunDuration } from "./workflow-list-page";
import { DOT_CLASSES, LABEL_CLASSES, type StageNodeState } from "./run-stage-strip";
import { useT } from "../i18n";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Minute-resolution "pending since" duration: "2h37m", "37m", "3d2h".
 * Empty string when created_at is missing or unparsable — never invent time.
 */
export function formatPendingDuration(createdAt: string, nowMs: number): string {
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) return "";
  const totalMin = Math.max(0, Math.floor((nowMs - ts) / 60_000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

/** Ticks once a minute so the pending chip stays fresh while the letter is open. */
function usePendingDuration(createdAt: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return formatPendingDuration(createdAt, now);
}

/**
 * The clarification answer API accepts a single string, so multi-question
 * answers are flattened into a numbered list. One question submits its bare
 * answer. `answerPrefix` is the localized "答：" / "A: " label.
 */
export function composeClarifyAnswer(
  questions: ClarifyQuestionView[],
  answers: string[],
  answerPrefix: string,
): string {
  if (questions.length <= 1) return (answers[0] ?? "").trim();
  return questions
    .map((q, i) => `${i + 1}. ${q.question}\n${answerPrefix}${(answers[i] ?? "").trim()}`)
    .join("\n\n");
}

/**
 * Split a freeform review_package into keys we can render nicely (string /
 * number / boolean scalars, with `summary` promoted to a paragraph) and the
 * remainder, which goes into a collapsible pretty-printed JSON block.
 */
export function splitReviewPackage(pkg: unknown): {
  summary: string;
  scalars: Array<[string, string]>;
  rest: unknown;
} {
  if (pkg === null || pkg === undefined) return { summary: "", scalars: [], rest: undefined };
  if (typeof pkg !== "object" || Array.isArray(pkg)) {
    return { summary: "", scalars: [], rest: pkg };
  }
  const obj = pkg as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  const scalars: Array<[string, string]> = [];
  const restEntries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "summary" && summary) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      scalars.push([key, String(value)]);
    } else if (value !== null && value !== undefined) {
      restEntries[key] = value;
    }
  }
  return {
    summary,
    scalars,
    rest: Object.keys(restEntries).length > 0 ? restEntries : undefined,
  };
}

export interface PromotionReviewView {
  id: string;
  gate_name: string;
  status: string;
  decided_by: string | null;
  decided_at: string;
  created_at: string;
  decision_reason: string;
}

/**
 * Defensive reader for a promotion letter's untyped `evidence` JSON: the
 * server stores the streak's gate-review records as an array. Non-array input
 * and malformed items are skipped so a promotion card never crashes on drift.
 */
export function parsePromotionReviews(raw: unknown): PromotionReviewView[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: PromotionReviewView[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    out.push({
      id: typeof o.id === "string" ? o.id : "",
      gate_name: typeof o.gate_name === "string" ? o.gate_name : "",
      status: typeof o.status === "string" ? o.status : "",
      decided_by: typeof o.decided_by === "string" ? o.decided_by : null,
      decided_at: typeof o.decided_at === "string" ? o.decided_at : "",
      created_at: typeof o.created_at === "string" ? o.created_at : "",
      decision_reason: typeof o.decision_reason === "string" ? o.decision_reason : "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 1 — mini stage strip (derived from the contract + stuck stage)
// ---------------------------------------------------------------------------

/**
 * Contract-only variant of the run stage strip: no run events needed — the
 * decision point pins the current position, which pulses while pending.
 */
function MiniStageStrip({
  stages,
  currentStage,
  resolved,
}: {
  stages: ContractStageView[];
  currentStage: string;
  resolved: boolean;
}) {
  const idx = stages.findIndex((s) => s.name === currentStage);
  if (stages.length === 0 || idx < 0) return null;
  return (
    <ol data-testid="letter-stage-strip" className="flex flex-wrap items-center gap-x-1 gap-y-2 rounded-md border px-3 py-2">
      {stages.map((stage, i) => {
        const state: StageNodeState = i < idx ? "done" : i === idx ? (resolved ? "done" : "waiting") : "pending";
        return (
          <li key={stage.name} className="flex items-center gap-1">
            {i > 0 && <span className="mx-1 h-px w-4 shrink-0 bg-border" aria-hidden />}
            <span
              data-testid="letter-stage-node"
              data-stage={stage.name}
              data-state={state}
              title={stage.description ?? stage.name}
              className={cn("flex items-center gap-1.5 text-xs", LABEL_CLASSES[state])}
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  DOT_CLASSES[state],
                  state === "waiting" && "animate-pulse",
                )}
                aria-hidden
              />
              {stage.name}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Section 3 — context (gate review package)
// ---------------------------------------------------------------------------

export function ReviewPackageSection({ pkg }: { pkg: unknown }) {
  const { t } = useT("raven");
  const { summary, scalars, rest } = splitReviewPackage(pkg);
  const empty = !summary && scalars.length === 0 && rest === undefined;

  return (
    <section>
      <h2 className="text-sm font-semibold">{t(($) => $.gate.package.title)}</h2>
      {empty ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t(($) => $.gate.package.empty)}
        </p>
      ) : (
        <div className="mt-2 space-y-3">
          {summary && (
            <CollapsibleMarkdown content={summary} className="text-foreground/90" />
          )}
          {scalars.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {scalars.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 break-words">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {rest !== undefined && (
            <details className="rounded-md border bg-muted/30">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
                {t(($) => $.gate.package.raw)}
              </summary>
              <pre className="overflow-x-auto border-t px-3 py-2 text-xs leading-relaxed">
                {JSON.stringify(rest, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section 2 — requirement context (the original ask) + exit links + evidence
// ---------------------------------------------------------------------------

/**
 * The original ask behind the decision: the issue title/description, the
 * requirement's lifecycle state, and exit links to the issue and — when the
 * decision belongs to a run — the run room (运行室). Makes the letter usable
 * from the inbox and 待我处理 without opening the review-package page.
 */
function RequirementContextSection({
  wsId,
  issueId,
  state,
  runId,
}: {
  wsId: string;
  issueId: string;
  state: string;
  runId: string | null;
}) {
  const { t } = useT("raven");
  const wsPaths = useWorkspacePaths();
  const { data: issue } = useQuery({
    ...issueDetailOptions(wsId, issueId),
    enabled: issueId !== "",
  });
  if (issueId === "") return null;

  return (
    <section data-testid="letter-requirement">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{t(($) => $.gate.requirement.title)}</h2>
        {state && (
          <Badge variant="secondary" className={STATE_CLASSES[state] ?? ""}>
            {STATE_LABELS[state] ?? state}
          </Badge>
        )}
      </div>
      {issue ? (
        <>
          <p className="mt-1 text-sm font-medium">{issue.title}</p>
          {issue.description && (
            <CollapsibleMarkdown content={issue.description} className="mt-1" maxLines={4} />
          )}
        </>
      ) : (
        <Skeleton className="mt-2 h-5 w-48" />
      )}
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        <AppLink
          href={wsPaths.issueDetail(issueId)}
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {t(($) => $.gate.requirement.view_issue)}
        </AppLink>
        {runId && (
          <AppLink
            href={wsPaths.ravenRunDetail(runId)}
            className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t(($) => $.letter.view_run_room)}
          </AppLink>
        )}
      </div>
    </section>
  );
}

/**
 * The requirement's evidence trail (证据), self-fetching so the letter carries
 * its own supporting proof in the inbox and 待我处理 queue — the same list the
 * review-package page used to render separately. Nothing until a requirement
 * is known.
 */
export function EvidenceSection({
  wsId,
  requirementId,
}: {
  wsId: string;
  requirementId: string;
}) {
  const { t } = useT("raven");
  const { data: evidence = [] } = useQuery({
    ...requirementEvidenceOptions(wsId, requirementId),
    enabled: requirementId !== "",
  });
  if (requirementId === "") return null;

  return (
    <section data-testid="letter-evidence">
      <h2 className="text-sm font-semibold">{t(($) => $.gate.evidence.title)}</h2>
      {evidence.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{t(($) => $.gate.evidence.empty)}</p>
      ) : (
        <ul className="mt-2 divide-y rounded-md border">
          {evidence.map((item) => (
            <li key={item.id} className="px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">{item.kind}</span>
                {item.source && <span>{item.source}</span>}
                {item.created_at && (
                  <span className="ml-auto shrink-0">
                    {new Date(item.created_at).toLocaleString()}
                  </span>
                )}
              </div>
              {item.summary && <CollapsibleMarkdown content={item.summary} className="mt-1" />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section 4 — responses
// ---------------------------------------------------------------------------

/** Approve / reject verdict controls for a gate; reject requires a reason. */
export function DecisionSection({
  gate,
  wsId,
}: {
  gate: RavenGateReview;
  wsId: string;
}) {
  const { t } = useT("raven");
  const { getActorName } = useActorName();
  const decideMutation = useDecideRavenGate(wsId);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");

  if (gate.status !== "pending") {
    const decidedAt = gate.decided_at
      ? new Date(gate.decided_at).toLocaleString()
      : "";
    return (
      <section data-testid="gate-decided">
        <h2 className="text-sm font-semibold">{t(($) => $.gate.decision.title)}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {gate.decided_by
            ? t(($) => $.gate.decision.decided_by, {
                name: getActorName("member", gate.decided_by),
              })
            : null}
          {decidedAt ? ` · ${decidedAt}` : null}
        </p>
        {gate.decision_reason && (
          <div className="mt-2 rounded-md border bg-muted/40 p-3">
            <p className="text-xs font-medium text-muted-foreground">
              {t(($) => $.gate.decision.reason_title)}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{gate.decision_reason}</p>
          </div>
        )}
      </section>
    );
  }

  const submit = (approve: boolean) => {
    const trimmed = reason.trim();
    if (!approve && !trimmed) {
      setReasonError(t(($) => $.gate.decision.reason_required));
      return;
    }
    decideMutation.mutate(
      { gateId: gate.id, approve, reason: approve ? "" : trimmed },
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
    <section>
      <h2 className="text-sm font-semibold">{t(($) => $.gate.decision.title)}</h2>
      {rejecting ? (
        <div className="mt-2 space-y-2">
          <Textarea
            autoFocus
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
              variant="destructive"
              disabled={decideMutation.isPending}
              onClick={() => submit(false)}
            >
              {decideMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              {t(($) => $.gate.decision.confirm_reject)}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decideMutation.isPending}
              onClick={() => {
                setRejecting(false);
                setReasonError("");
              }}
            >
              {t(($) => $.gate.decision.cancel)}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            data-testid="gate-approve"
            disabled={decideMutation.isPending}
            onClick={() => submit(true)}
          >
            {decideMutation.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            {t(($) => $.gate.decision.approve)}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={decideMutation.isPending}
            onClick={() => setRejecting(true)}
          >
            {t(($) => $.gate.decision.reject)}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * The 交付策略's chosen agent + skill composition (issue #30), read from the
 * `workflow_composition` evidence recorded when the strategy was created. Shown
 * on the authoring clarify letter so the human sees who will run this strategy
 * (the manual selection, or the 智能-mode creator agent). Renders nothing for
 * non-authoring clarifications, which have no composition evidence.
 */
function CompositionSection({ wsId, requirementId }: { wsId: string; requirementId: string }) {
  const { t } = useT("raven");
  const { getActorName } = useActorName();
  const { data: evidence = [] } = useQuery({
    ...requirementEvidenceOptions(wsId, requirementId),
    enabled: requirementId !== "",
  });
  const { data: skills = [] } = useQuery({
    ...skillListOptions(wsId),
    enabled: requirementId !== "",
  });
  const composition = useMemo(() => findComposition(evidence), [evidence]);
  if (!composition) return null;

  const isAuto = composition.mode === "auto";
  const agentNames = composition.agent_ids.map((id) => getActorName("agent", id));
  const skillNames = composition.skill_ids
    .map((id) => skills.find((s) => s.id === id)?.name)
    .filter((n): n is string => Boolean(n));

  return (
    <section data-testid="letter-composition">
      <h2 className="text-sm font-semibold">{t(($) => $.letter.composition.title)}</h2>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">
          {isAuto ? t(($) => $.letter.composition.creator) : t(($) => $.letter.composition.agents)}
        </dt>
        <dd className="min-w-0 break-words">
          {agentNames.length > 0 ? agentNames.join("、") : t(($) => $.letter.composition.none)}
        </dd>
        <dt className="text-muted-foreground">{t(($) => $.letter.composition.skills)}</dt>
        <dd className="min-w-0 break-words">
          {isAuto
            ? t(($) => $.letter.composition.auto_skills)
            : skillNames.length > 0
              ? skillNames.join("、")
              : t(($) => $.letter.composition.none)}
        </dd>
      </dl>
    </section>
  );
}

/**
 * Clarification response: one card per question, agent-recommended answer
 * preselected but editable as free text, "apply all recommended" submits
 * every recommendation in one shot.
 */
function ClarifyResponseSection({
  clarification,
  wsId,
}: {
  clarification: RavenClarification;
  wsId: string;
}) {
  const { t } = useT("raven");
  const { getActorName } = useActorName();
  const answerMutation = useAnswerRavenClarification(wsId);
  const questions = useMemo(
    () => parseClarifyQuestions(clarification.questions),
    [clarification.questions],
  );
  const [answers, setAnswers] = useState<string[]>(() =>
    questions.map((q) => q.recommended ?? ""),
  );
  const [error, setError] = useState("");

  if (clarification.status !== "pending") {
    const answeredAt = clarification.answered_at
      ? new Date(clarification.answered_at).toLocaleString()
      : "";
    return (
      <section data-testid="clarify-answered">
        <h2 className="text-sm font-semibold">{t(($) => $.letter.clarify.answered_title)}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {clarification.answered_by
            ? t(($) => $.letter.clarify.answered_by, {
                name: getActorName("member", clarification.answered_by),
              })
            : null}
          {answeredAt ? ` · ${answeredAt}` : null}
        </p>
        {clarification.answer && (
          <div className="mt-2 rounded-md border bg-muted/40 p-3">
            <p className="whitespace-pre-wrap text-sm">{clarification.answer}</p>
          </div>
        )}
      </section>
    );
  }

  const submit = (values: string[]) => {
    if (questions.length === 0) return;
    if (values.some((v) => v.trim() === "")) {
      setError(t(($) => $.letter.clarify.answer_required));
      return;
    }
    setError("");
    answerMutation.mutate(
      {
        clarificationId: clarification.id,
        answer: composeClarifyAnswer(
          questions,
          values,
          t(($) => $.letter.clarify.answer_prefix),
        ),
      },
      {
        onError: (err) =>
          toast.error(
            err instanceof Error && err.message
              ? err.message
              : t(($) => $.letter.clarify.submit_failed),
          ),
      },
    );
  };

  const allRecommended =
    questions.length > 0 && questions.every((q) => q.recommended !== undefined);

  return (
    <section data-testid="clarify-response">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t(($) => $.letter.clarify.title)}</h2>
        {allRecommended && (
          <Button
            size="sm"
            variant="secondary"
            disabled={answerMutation.isPending}
            onClick={() => {
              const recommended = questions.map((q) => q.recommended ?? "");
              setAnswers(recommended);
              submit(recommended);
            }}
          >
            {t(($) => $.letter.clarify.apply_all_recommended)}
          </Button>
        )}
      </div>
      <div className="mt-2 space-y-3">
        {questions.map((q, i) => (
          <div
            key={i}
            data-testid="clarify-question-card"
            className="space-y-2 rounded-md border p-3"
          >
            <CollapsibleMarkdown content={q.question} maxLines={6} />
            {q.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((opt) => (
                  <Button
                    key={opt}
                    size="sm"
                    variant={answers[i] === opt ? "default" : "outline"}
                    onClick={() =>
                      setAnswers((prev) => prev.map((a, j) => (j === i ? opt : a)))
                    }
                  >
                    {opt}
                    {q.recommended === opt && (
                      <span className="text-[10px] opacity-70">
                        {t(($) => $.letter.clarify.recommended)}
                      </span>
                    )}
                  </Button>
                ))}
              </div>
            )}
            <Textarea
              value={answers[i] ?? ""}
              onChange={(e) => {
                const value = e.target.value;
                setAnswers((prev) => prev.map((a, j) => (j === i ? value : a)));
                setError("");
              }}
              placeholder={t(($) => $.letter.clarify.answer_placeholder)}
              aria-label={t(($) => $.letter.clarify.answer_label, { index: i + 1 })}
            />
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <Button
        size="sm"
        className="mt-3"
        data-testid="clarify-submit"
        disabled={answerMutation.isPending || questions.length === 0}
        onClick={() => submit(answers)}
      >
        {answerMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {t(($) => $.letter.clarify.submit)}
      </Button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The letter itself
// ---------------------------------------------------------------------------

/**
 * Trust-promotion letter (issue #25): a workflow×gate applying to downgrade
 * from full review to spot checks after 8 consecutive zero-reject reviews.
 * Governance decision point, so no run/stage — just the streak evidence and an
 * approve/reject verdict (reject requires a reason), reusing the letter shell.
 */
function PromotionLetterCard({
  wsId,
  id,
  className,
}: {
  wsId: string;
  id: string;
  className?: string;
}) {
  const { t } = useT("raven");
  const { getActorName } = useActorName();
  const decideMutation = useDecideRavenPromotion(wsId);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");

  const { data: promotion, isLoading } = useQuery(ravenPromotionOptions(wsId, id));
  const pendingDuration = usePendingDuration(promotion?.created_at ?? "");

  if (isLoading) {
    return (
      <div className={cn("space-y-3", className)}>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  if (!promotion) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        {t(($) => $.letter.not_found)}
      </p>
    );
  }

  const reviews = parsePromotionReviews(promotion.evidence);
  const isPending = promotion.status === "pending";

  const submit = (approve: boolean) => {
    const trimmed = reason.trim();
    if (!approve && !trimmed) {
      setReasonError(t(($) => $.gate.decision.reason_required));
      return;
    }
    decideMutation.mutate(
      { promotionId: promotion.id, approve, reason: approve ? "" : trimmed },
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
    <section data-testid="promotion-letter-card" className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <p data-testid="letter-why" className="text-sm font-medium">
          {t(($) => $.letter.why_promotion, { gate: promotion.gate_name })}
        </p>
        {isPending && pendingDuration && (
          <Badge
            variant="secondary"
            className="bg-amber-500/15 text-amber-600 dark:text-amber-400"
          >
            {t(($) => $.letter.pending_for, { duration: pendingDuration })}
          </Badge>
        )}
      </div>

      {/* "为什么可以晋升" backed by the visible streak, not just a count. */}
      <section data-testid="promotion-evidence">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">
            {t(($) => $.letter.promotion.reviews_title)}
          </h2>
          <span className="text-sm text-muted-foreground">
            {t(($) => $.letter.promotion.evidence_count, { count: reviews.length })}
          </span>
        </div>
        {reviews.length > 0 && (
          <ul className="mt-2 divide-y rounded-md border">
            {reviews.map((rev, i) => {
              const when = rev.decided_at || rev.created_at;
              return (
                <li
                  key={rev.id || i}
                  data-testid="promotion-review"
                  className="px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium text-foreground/80">
                      {rev.gate_name || promotion.gate_name}
                    </span>
                    <Badge
                      variant="secondary"
                      className="bg-green-500/15 text-green-600 dark:text-green-400"
                    >
                      {t(($) => $.gate.status.approved)}
                    </Badge>
                    {rev.decided_by && (
                      <span className="text-muted-foreground">
                        {t(($) => $.gate.decision.decided_by, {
                          name: getActorName("member", rev.decided_by),
                        })}
                      </span>
                    )}
                    {when && (
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        {new Date(when).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {rev.decision_reason && (
                    <p className="mt-1 whitespace-pre-wrap text-sm">
                      {rev.decision_reason}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {!isPending ? (
        <section data-testid="promotion-decided">
          <h2 className="text-sm font-semibold">{t(($) => $.gate.decision.title)}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {promotion.decided_by
              ? t(($) => $.gate.decision.decided_by, {
                  name: getActorName("member", promotion.decided_by),
                })
              : null}
          </p>
          {promotion.decision_reason && (
            <p className="mt-1 whitespace-pre-wrap text-sm">{promotion.decision_reason}</p>
          )}
        </section>
      ) : (
        <section>
          <h2 className="text-sm font-semibold">{t(($) => $.gate.decision.title)}</h2>
          {rejecting ? (
            <div className="mt-2 space-y-2">
              <Textarea
                autoFocus
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonError("");
                }}
                placeholder={t(($) => $.gate.decision.reason_placeholder)}
                aria-label={t(($) => $.gate.decision.reason_label)}
              />
              {reasonError && <p className="text-xs text-destructive">{reasonError}</p>}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={decideMutation.isPending}
                  onClick={() => submit(false)}
                >
                  {decideMutation.isPending && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  {t(($) => $.gate.decision.confirm_reject)}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decideMutation.isPending}
                  onClick={() => {
                    setRejecting(false);
                    setReasonError("");
                  }}
                >
                  {t(($) => $.gate.decision.cancel)}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                data-testid="promotion-approve"
                disabled={decideMutation.isPending}
                onClick={() => submit(true)}
              >
                {decideMutation.isPending && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                {t(($) => $.gate.decision.approve)}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={decideMutation.isPending}
                onClick={() => setRejecting(true)}
              >
                {t(($) => $.gate.decision.reject)}
              </Button>
            </div>
          )}
        </section>
      )}
    </section>
  );
}

export interface DecisionLetterCardProps {
  wsId: string;
  /** "gate" | "clarify" | "promotion" — matches RavenDecisionPoint.kind and inbox item types. */
  kind: string;
  /** Gate review id (kind="gate") or clarification id (kind="clarify"). */
  id: string;
  /** Optional link to the full review page; omit when already on it. */
  detailHref?: string;
  className?: string;
}

/**
 * 拍板信 (issue #20): the constant four-part letter layout for a Raven
 * decision point — mini stage strip, one-line "why you", collapsed context,
 * consequence preview, and the response controls. Used verbatim in the inbox
 * detail pane, the gate review page, and (later, S7) the pending-queue page.
 */
export function DecisionLetterCard(props: DecisionLetterCardProps) {
  if (props.kind === "promotion") {
    return <PromotionLetterCard wsId={props.wsId} id={props.id} className={props.className} />;
  }
  return <GateOrClarifyLetterCard {...props} />;
}

/**
 * 中断创建 (issue #32): the requirement-level bail-out. When the human realizes
 * the original requirement was wrong, this abandons the requirement and its run
 * instead of forcing an answer/verdict — the letter then leaves 待我处理. A
 * destructive, confirmed action; only on gate/clarify letters (never promotion,
 * which is workspace governance, not a requirement).
 */
function AbortRequirementSection({
  wsId,
  requirementId,
}: {
  wsId: string;
  requirementId: string;
}) {
  const { t } = useT("raven");
  const cancelMutation = useCancelRavenRequirement(wsId);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const confirm = () => {
    cancelMutation.mutate(
      { requirementId, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          setOpen(false);
          toast.success(t(($) => $.letter.abort.success));
        },
        onError: (err) =>
          toast.error(
            err instanceof Error && err.message
              ? err.message
              : t(($) => $.letter.abort.failed),
          ),
      },
    );
  };

  return (
    <section
      data-testid="letter-abort"
      className="flex flex-wrap items-center justify-between gap-2 border-t pt-3"
    >
      <p className="text-xs text-muted-foreground">{t(($) => $.letter.abort.hint)}</p>
      <Button
        size="sm"
        variant="ghost"
        data-testid="letter-abort-open"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        {t(($) => $.letter.abort.button)}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(v) => {
          if (!cancelMutation.isPending) setOpen(v);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.letter.abort.confirm_title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.letter.abort.confirm_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t(($) => $.letter.abort.reason_placeholder)}
            aria-label={t(($) => $.letter.abort.reason_label)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>
              {t(($) => $.letter.abort.confirm_cancel)}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="letter-abort-confirm"
              disabled={cancelMutation.isPending}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => confirm()}
            >
              {cancelMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              {t(($) => $.letter.abort.confirm_action)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function GateOrClarifyLetterCard({
  wsId,
  kind,
  id,
  detailHref,
  className,
}: DecisionLetterCardProps) {
  const { t } = useT("raven");
  const isGate = kind === "gate";

  const { data: gate, isLoading: gateLoading } = useQuery({
    ...gateOptions(wsId, id),
    enabled: isGate,
  });
  const { data: clarification, isLoading: clarifyLoading } = useQuery({
    ...clarificationOptions(wsId, id),
    enabled: !isGate,
  });

  const requirementId = (isGate ? gate?.requirement_id : clarification?.requirement_id) ?? "";
  const runId = (isGate ? gate?.run_id : clarification?.run_id) ?? null;

  const { data: requirement } = useQuery({
    ...ravenRequirementOptions(wsId, requirementId),
    enabled: requirementId !== "",
  });
  const issueId = requirement?.issue_id ?? "";
  const workflowId = requirement?.workflow_id ?? "";
  const { data: workflow } = useQuery({
    ...ravenWorkflowOptions(wsId, workflowId),
    enabled: workflowId !== "",
  });
  const { data: stats = [] } = useQuery({
    ...ravenWorkflowStatsOptions(wsId),
    enabled: workflowId !== "",
  });
  const { data: runs = [] } = useQuery({
    ...requirementRunsOptions(wsId, requirementId),
    enabled: requirementId !== "" && runId !== null,
  });

  const createdAt = (isGate ? gate?.created_at : clarification?.created_at) ?? "";
  const pendingDuration = usePendingDuration(createdAt);

  if (isGate ? gateLoading : clarifyLoading) {
    return (
      <div className={cn("space-y-3", className)}>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  if (isGate ? !gate : !clarification) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        {t(($) => $.letter.not_found)}
      </p>
    );
  }

  const status = (isGate ? gate?.status : clarification?.status) ?? "pending";
  const isPending = status === "pending";
  const questions = parseClarifyQuestions(clarification?.questions);

  const stages = parseContractStages(workflow?.contract);
  const contractGates = parseContractGates(workflow?.contract);
  const currentStage = isGate
    ? contractGates.find((g) => g.name === gate?.gate_name)?.after_stage ?? ""
    : clarification?.stage ?? "";

  // -- Consequence preview: static parts from the contract; estimates only
  // when history exists — never invent numbers.
  const consequences: string[] = [];
  if (isPending) {
    if (isGate) {
      const idx = stages.findIndex((s) => s.name === currentStage);
      if (idx >= 0) {
        const next = stages[idx + 1]?.name;
        consequences.push(
          next
            ? t(($) => $.letter.consequence.approve_next, { stage: next })
            : t(($) => $.letter.consequence.approve_done),
        );
      }
      consequences.push(t(($) => $.letter.consequence.reject_redo));
    } else if (currentStage) {
      consequences.push(
        t(($) => $.letter.consequence.answer_resume, { stage: currentStage }),
      );
    }
    const avgSeconds = stats.find((s) => s.workflow_id === workflowId)?.avg_run_seconds ?? 0;
    if (avgSeconds > 0) {
      consequences.push(
        t(($) => $.letter.consequence.avg_duration, {
          duration: formatRunDuration(avgSeconds),
        }),
      );
    }
    const run = runs.find((r) => r.id === runId);
    if (run !== undefined && run.tokens_spent > 0) {
      consequences.push(
        t(($) => $.letter.consequence.tokens_spent, {
          tokens: run.tokens_spent.toLocaleString(),
        }),
      );
      if (run.usd_spent > 0) {
        consequences.push(
          t(($) => $.letter.consequence.usd_spent, {
            usd: run.usd_spent.toFixed(2),
          }),
        );
      }
    }
  }

  const why = isGate
    ? t(($) => $.letter.why_gate, { gate: gate?.gate_name || currentStage })
    : t(($) => $.letter.why_clarify, { num: questions.length });

  return (
    <section data-testid="decision-letter-card" className={cn("space-y-4", className)}>
      {/* 1. Mini stage strip — where the run is stuck, pulsing while pending. */}
      <MiniStageStrip stages={stages} currentStage={currentStage} resolved={!isPending} />

      {/* 2. One-line "why this letter found you" + pending timer. */}
      <div className="flex flex-wrap items-center gap-2">
        <p data-testid="letter-why" className="text-sm font-medium">
          {why}
        </p>
        {isPending && pendingDuration && (
          <Badge
            variant="secondary"
            data-testid="letter-pending"
            className="bg-amber-500/15 text-amber-600 dark:text-amber-400"
          >
            {t(($) => $.letter.pending_for, { duration: pendingDuration })}
          </Badge>
        )}
        {detailHref && (
          <AppLink
            href={detailHref}
            className="ml-auto text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t(($) => $.letter.open_detail)}
          </AppLink>
        )}
      </div>

      {/* 3. The original ask + exit links to the issue and run room. */}
      <RequirementContextSection
        wsId={wsId}
        issueId={issueId}
        state={requirement?.state ?? ""}
        runId={runId}
      />

      {/* 4. Context summary — collapsed markdown by default. Clarify also
          spells out where execution is stuck. */}
      {isGate ? (
        <ReviewPackageSection pkg={gate?.review_package} />
      ) : (
        currentStage && (
          <p className="text-sm text-muted-foreground">
            {t(($) => $.letter.clarify.stage_context, { stage: currentStage })}
          </p>
        )
      )}

      {/* 3b. Strategy composition (issue #30) — authoring clarify letters only. */}
      {!isGate && requirementId !== "" && (
        <CompositionSection wsId={wsId} requirementId={requirementId} />
      )}

      {/* 5. Evidence trail — the proof produced so far. */}
      <EvidenceSection wsId={wsId} requirementId={requirementId} />

      {/* 6. Consequence preview (pending only). */}
      {consequences.length > 0 && (
        <section data-testid="letter-consequence">
          <h2 className="text-sm font-semibold">
            {t(($) => $.letter.consequence.title)}
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {consequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      {/* 7. Response controls. */}
      {isGate
        ? gate && <DecisionSection gate={gate} wsId={wsId} />
        : clarification && (
            <ClarifyResponseSection clarification={clarification} wsId={wsId} />
          )}

      {/* 8. Requirement-level abort (issue #32) — only while still pending. */}
      {isPending && requirementId !== "" && (
        <AbortRequirementSection wsId={wsId} requirementId={requirementId} />
      )}
    </section>
  );
}
