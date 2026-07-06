// Defensive readers for the untyped workflow contract JSON (issue #15).
// Stages accept both the object form {name, description} and the legacy
// bare-string form; anything malformed is simply skipped.

// Raven payload parsers that go through zod (issues #26/#30) live with the
// other schemas; re-exported here so consumers import them from the raven
// domain module alongside the contract readers.
export {
  COMPOSITION_EVIDENCE_KIND,
  EMPTY_RAVEN_CLARIFY_QUESTIONS,
  RavenClarifyQuestionsSchema,
  findComposition,
  parseClarifyQuestions,
  type ClarifyQuestionView,
} from "../api/schemas";

/**
 * Registry name of the built-in authoring strategy (ADR-0010). The "新建交付
 * 策略" entry creates a requirement assigned to this workflow.
 */
export const AUTHORING_WORKFLOW_NAME = "workflow-authoring";

/**
 * Consecutive zero-reject reviews required before a gate may apply for
 * promotion to spot checks (issue #25, ADR-0009). Fixed, not configurable.
 */
export const RAVEN_PROMOTION_THRESHOLD = 8;

export interface ContractStageView {
  name: string;
  description?: string;
}

export interface ContractGateView {
  name: string;
  after_stage?: string;
}

export function parseContractStages(contract: unknown): ContractStageView[] {
  const stages: ContractStageView[] = [];
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return stages;
  const raw = (contract as Record<string, unknown>).stages;
  if (!Array.isArray(raw)) return stages;
  for (const s of raw) {
    if (typeof s === "string" && s !== "") {
      stages.push({ name: s });
    } else if (s && typeof s === "object" && typeof (s as Record<string, unknown>).name === "string") {
      const stage = s as { name: string; description?: unknown };
      stages.push({
        name: stage.name,
        description: typeof stage.description === "string" ? stage.description : undefined,
      });
    }
  }
  return stages;
}

export function parseContractGates(contract: unknown): ContractGateView[] {
  const gates: ContractGateView[] = [];
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return gates;
  const raw = (contract as Record<string, unknown>).gates;
  if (!Array.isArray(raw)) return gates;
  for (const g of raw) {
    if (g && typeof g === "object" && typeof (g as Record<string, unknown>).name === "string") {
      const gate = g as { name: string; after_stage?: unknown };
      gates.push({
        name: gate.name,
        after_stage: typeof gate.after_stage === "string" ? gate.after_stage : undefined,
      });
    }
  }
  return gates;
}
