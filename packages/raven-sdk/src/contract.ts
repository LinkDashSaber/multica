// Mirrors server/internal/raven/contract.go (plus `retry`, which the Go side
// is gaining separately). Keep validation messages descriptive: they surface
// at deploy time when defineWorkflow() runs at module load.

export interface ContractStage {
  name: string;
  description?: string;
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

export interface Contract {
  stages: ContractStage[];
  gates: ContractGate[];
  budget: ContractBudget;
  retry?: ContractRetry;
  permissions?: Record<string, unknown>;
}

export function validateContract(c: Contract): void {
  if (!c.stages || c.stages.length === 0) {
    throw new Error("contract.stages must declare at least one stage");
  }
  const stageNames = new Set<string>();
  c.stages.forEach((s, i) => {
    if (!s.name) {
      throw new Error(`contract.stages[${i}].name is required`);
    }
    if (stageNames.has(s.name)) {
      throw new Error(`contract.stages has duplicate name "${s.name}"`);
    }
    stageNames.add(s.name);
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
