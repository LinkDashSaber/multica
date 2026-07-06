// Mirrors server/internal/raven/contract.go (plus `retry`, which the Go side
// is gaining separately). Keep validation messages descriptive: they surface
// at deploy time when defineWorkflow() runs at module load.

export interface ContractStage {
  name: string;
  description?: string;
}

/** Stages accept the object form or the legacy bare-string form (issue #15). */
export type ContractStageInput = string | ContractStage;

export function stageName(s: ContractStageInput): string {
  return typeof s === "string" ? s : s.name;
}

export interface ContractGate {
  name: string;
  after_stage: string;
}

export interface ContractBudget {
  max_tokens?: number;
  max_usd?: number;
}

export interface ContractRetry {
  max_attempts?: number;
  timeout_seconds?: number;
}

/**
 * Who runs a 交付策略 and with what (issue #26). Mirrors the Go
 * raven.WorkflowComposition / ContractComposition. Mode "manual": the user
 * picked agents + skills directly. Mode "auto" (智能): a single creator agent
 * (agent_ids[0]) picks skills + squad during the run, so skill_ids is empty.
 */
export interface WorkflowComposition {
  mode: string;
  agent_ids: string[];
  skill_ids: string[];
}

export interface Contract {
  stages: ContractStageInput[];
  gates: ContractGate[];
  budget: ContractBudget;
  retry?: ContractRetry;
  permissions?: Record<string, unknown>;
  /** Present when a strategy was authored with a manual composition (issue #26). */
  composition?: WorkflowComposition;
}

export function validateContract(c: Contract): void {
  if (!c.stages || c.stages.length === 0) {
    throw new Error("contract.stages must declare at least one stage");
  }
  const stageNames = new Set<string>();
  c.stages.forEach((s, i) => {
    const name = stageName(s);
    if (!name) {
      throw new Error(`contract.stages[${i}].name is required`);
    }
    if (stageNames.has(name)) {
      throw new Error(`contract.stages has duplicate name "${name}"`);
    }
    stageNames.add(name);
  });

  if (!c.gates || c.gates.length === 0) {
    throw new Error(
      "contract.gates must declare at least one gate — ungated workflows are not registrable",
    );
  }
  c.gates.forEach((g, i) => {
    if (!g.name) {
      throw new Error(`contract.gates[${i}].name is required`);
    }
    if (!stageNames.has(g.after_stage)) {
      throw new Error(
        `contract.gates[${i}].after_stage "${g.after_stage}" does not reference a declared stage`,
      );
    }
  });

  const maxTokens = c.budget?.max_tokens ?? 0;
  const maxUsd = c.budget?.max_usd ?? 0;
  if (maxTokens <= 0 && maxUsd <= 0) {
    throw new Error("contract.budget must set max_tokens or max_usd");
  }
}
