"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useActorName } from "@multica/core/workspace/hooks";
import {
  clarificationOptions,
  gateOptions,
  parseContractGates,
  parseContractStages,
  ravenRequirementOptions,
  ravenWorkflowOptions,
  ravenWorkflowStatsOptions,
  requirementRunsOptions,
  useAnswerRavenClarification,
  useDecideRavenGate,
  type ContractStageView,
  type RavenClarification,
  type RavenGateReview,
} from "@multica/core/raven";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { AppLink } from "../navigation";
import { CollapsibleMarkdown } from "../common/collapsible-markdown";
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

export interface ClarifyQuestionView {
  question: string;
  options: string[];
  recommended?: string;
}

/**
 * Defensive reader for the untyped clarification `questions` JSON. Accepts a
 * bare array or a `{questions: [...]}` wrapper; items may be bare strings or
 * `{question, options?, recommended?}` objects. Malformed items are skipped.
 */
export function parseClarifyQuestions(raw: unknown): ClarifyQuestionView[] {
  let arr: unknown[] = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw && typeof raw === "object") {
    const wrapped = (raw as Record<string, unknown>).questions;
    if (Array.isArray(wrapped)) arr = wrapped;
  }
  const out: ClarifyQuestionView[] = [];
  for (const item of arr) {
    if (typeof item === "string" && item !== "") {
      out.push({ question: item, options: [] });
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if (typeof obj.question !== "string" || obj.question === "") continue;
      const options = Array.isArray(obj.options)
        ? obj.options.filter((o): o is string => typeof o === "string" && o !== "")
        : [];
      out.push({
        question: obj.question,
        options,
        recommended: typeof obj.recommended === "string" && obj.recommended !== "" ? obj.recommended : undefined,
      });
    }
  }
  return out;
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

export interface DecisionLetterCardProps {
  wsId: string;
  /** "gate" | "clarify" — matches RavenDecisionPoint.kind and inbox item types. */
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
export function DecisionLetterCard({
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

      {/* 3. Context summary — collapsed markdown by default. */}
      {isGate ? (
        <ReviewPackageSection pkg={gate?.review_package} />
      ) : (
        currentStage && (
          <p className="text-sm text-muted-foreground">
            {t(($) => $.letter.clarify.stage_context, { stage: currentStage })}
          </p>
        )
      )}

      {/* 4. Consequence preview (pending only). */}
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

      {/* 5. Response controls. */}
      {isGate
        ? gate && <DecisionSection gate={gate} wsId={wsId} />
        : clarification && (
            <ClarifyResponseSection clarification={clarification} wsId={wsId} />
          )}
    </section>
  );
}
