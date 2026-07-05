// Pure derivations for the run room (issue #18): the merged execution
// timeline and the clarification → run-graph adapter. No React, no i18n —
// items carry raw structured facts and the page renders the labels, so
// everything here is vitest-assertable without a DOM.

import type {
  RavenClarification,
  RavenEvidence,
  RavenGateReview,
  RavenRun,
  RavenRunStageEvent,
} from "@multica/core/raven";
import type { TimelineEntry } from "@multica/core/types";
import type { RunGraphClarificationInput } from "./run-graph-model";

// ---------------------------------------------------------------------------
// Clarification adapters
// ---------------------------------------------------------------------------

/** Defensive reader for the untyped `questions` JSON: [{question, ...}] or [string]. */
export function clarificationQuestions(questions: unknown): string[] {
  if (!Array.isArray(questions)) return [];
  const out: string[] = [];
  for (const q of questions) {
    if (typeof q === "string" && q !== "") {
      out.push(q);
    } else if (q && typeof q === "object" && typeof (q as Record<string, unknown>).question === "string") {
      const text = (q as { question: string }).question;
      if (text !== "") out.push(text);
    }
  }
  return out;
}

/**
 * Adapt a requirement's clarification records into the run graph's temporary
 * node shape, keeping only the ones belonging to `runId` (records without a
 * run binding stay visible — they still block the same requirement).
 */
export function clarificationsToGraphInput(
  clarifications: RavenClarification[],
  runId: string,
): RunGraphClarificationInput[] {
  const out: RunGraphClarificationInput[] = [];
  for (const c of clarifications) {
    if (c.run_id && c.run_id !== runId) continue;
    const questions = clarificationQuestions(c.questions);
    if (questions.length === 0) continue;
    out.push({
      id: c.id,
      // The graph chip is one node per decision point; join multi-question
      // records so nothing silently disappears.
      question: questions.join(" / "),
      answer: c.status === "answered" && c.answer !== "" ? c.answer : undefined,
      stage: c.stage || undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merged execution timeline
// ---------------------------------------------------------------------------

export type RunTimelineItem =
  | { kind: "stage"; id: string; at: string; stage: string; event: string }
  | { kind: "evidence"; id: string; at: string; evidenceKind: string; source: string; summary: string }
  | { kind: "gate_opened"; id: string; at: string; gateName: string }
  | { kind: "gate_decided"; id: string; at: string; gateName: string; status: string; reason: string }
  | { kind: "clarification_asked"; id: string; at: string; question: string }
  | { kind: "clarification_answered"; id: string; at: string; question: string; answer: string }
  | { kind: "comment"; id: string; at: string; actorType: string; actorId: string; content: string };

export interface MergeRunTimelineInput {
  run: RavenRun;
  /** Stage event stream, any order — filtered to the run internally. */
  events?: RavenRunStageEvent[];
  /** Requirement evidence — filtered to the run internally. */
  evidence?: RavenEvidence[];
  /** Gate reviews — filtered to the run internally. */
  gateReviews?: RavenGateReview[];
  /** Clarifications — filtered to the run internally (unbound ones kept). */
  clarifications?: RavenClarification[];
  /** The issue's timeline entries; only comments inside the run window merge in. */
  comments?: TimelineEntry[];
}

function validTime(s: string | null | undefined): s is string {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

/**
 * Merge one run's stage events, evidence, decision records (gate verdicts +
 * clarification Q&A), and issue comments into a single chronological stream,
 * oldest first. Decisions expand to two items when both halves happened
 * (opened/decided, asked/answered) so the timeline reads as lived history.
 */
export function mergeRunTimeline(input: MergeRunTimelineInput): RunTimelineItem[] {
  const { run } = input;
  const items: RunTimelineItem[] = [];

  for (const e of input.events ?? []) {
    if (e.run_id !== run.id && e.run_id !== "") continue;
    if (!validTime(e.created_at)) continue;
    items.push({ kind: "stage", id: `stage:${e.id}`, at: e.created_at, stage: e.stage, event: e.event });
  }

  for (const ev of input.evidence ?? []) {
    if (ev.run_id !== run.id) continue;
    if (!validTime(ev.created_at)) continue;
    items.push({
      kind: "evidence",
      id: `evidence:${ev.id}`,
      at: ev.created_at,
      evidenceKind: ev.kind,
      source: ev.source ?? "",
      summary: ev.summary ?? "",
    });
  }

  for (const g of input.gateReviews ?? []) {
    if (g.run_id !== run.id) continue;
    if (validTime(g.created_at)) {
      items.push({ kind: "gate_opened", id: `gate-open:${g.id}`, at: g.created_at, gateName: g.gate_name });
    }
    if (g.status !== "pending" && validTime(g.decided_at)) {
      items.push({
        kind: "gate_decided",
        id: `gate-decided:${g.id}`,
        at: g.decided_at,
        gateName: g.gate_name,
        status: g.status,
        reason: g.decision_reason ?? "",
      });
    }
  }

  for (const c of input.clarifications ?? []) {
    if (c.run_id && c.run_id !== run.id) continue;
    const question = clarificationQuestions(c.questions).join(" / ");
    if (question === "") continue;
    if (validTime(c.created_at)) {
      items.push({ kind: "clarification_asked", id: `clarify-asked:${c.id}`, at: c.created_at, question });
    }
    if (c.status === "answered" && c.answer !== "" && validTime(c.answered_at)) {
      items.push({
        kind: "clarification_answered",
        id: `clarify-answered:${c.id}`,
        at: c.answered_at,
        question,
        answer: c.answer,
      });
    }
  }

  // Comments live on the issue, not the run — keep the ones inside the run's
  // time window so retrospective chatter on old runs doesn't bleed in.
  const windowStart = validTime(run.created_at) ? Date.parse(run.created_at) : null;
  const terminal = run.status === "completed" || run.status === "failed" || run.status === "terminated";
  const windowEnd = terminal && validTime(run.updated_at) ? Date.parse(run.updated_at) : null;
  for (const entry of input.comments ?? []) {
    if (entry.type !== "comment") continue;
    if (!validTime(entry.created_at)) continue;
    const t = Date.parse(entry.created_at);
    if (windowStart !== null && t < windowStart) continue;
    if (windowEnd !== null && t > windowEnd) continue;
    const content = typeof entry.content === "string" ? entry.content : "";
    if (content === "") continue;
    items.push({
      kind: "comment",
      id: `comment:${entry.id}`,
      at: entry.created_at,
      actorType: entry.actor_type,
      actorId: entry.actor_id,
      content,
    });
  }

  return items.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** Seconds from run start to its terminal update, or to `now` while live. */
export function runDurationSeconds(run: RavenRun, now: string): number | null {
  if (!validTime(run.created_at)) return null;
  const terminal = run.status === "completed" || run.status === "failed" || run.status === "terminated";
  const end = terminal && validTime(run.updated_at) ? Date.parse(run.updated_at) : Date.parse(now);
  if (Number.isNaN(end)) return null;
  const seconds = (end - Date.parse(run.created_at)) / 1000;
  return seconds >= 0 ? seconds : null;
}

/** Defensive read of the contract's token ceiling (max_tokens, 合同预算). */
export function contractMaxTokens(contract: unknown): number | null {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return null;
  const budget = (contract as Record<string, unknown>).budget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) return null;
  const b = budget as Record<string, unknown>;
  // The contract validator requires max_tokens; max_total_tokens is accepted
  // defensively for older drafts of the field name.
  const value = typeof b.max_tokens === "number" ? b.max_tokens
    : typeof b.max_total_tokens === "number" ? b.max_total_tokens
    : null;
  return value !== null && value > 0 ? value : null;
}
