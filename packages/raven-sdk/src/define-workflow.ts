import { validateContract, type Contract } from "./contract";
import { ControlPlaneClient } from "./control-client";
import { BudgetExceededError, RunContext, type RunPayload } from "./run-context";

export interface WorkflowDefinition {
  name: string;
  description?: string;
  contract: Contract;
  run: (ctx: RunContext) => Promise<unknown>;
}

export interface Workflow extends WorkflowDefinition {
  handler: (payload: RunPayload, client?: ControlPlaneClient) => Promise<unknown>;
}

export function defineWorkflow(def: WorkflowDefinition): Workflow {
  // Throws at module load so a bad contract fails the deploy.
  validateContract(def.contract);

  const handler = async (payload: RunPayload, client?: ControlPlaneClient): Promise<unknown> => {
    const c = client ?? ControlPlaneClient.fromEnv(payload.workspace_id);
    const ctx = new RunContext({ payload, contract: def.contract, client: c });
    await c.updateRun(payload.run_id, { status: "running" });
    try {
      const result = await def.run(ctx);
      await c.updateRun(payload.run_id, {
        status: "completed",
        tokens_spent: ctx.spentTokens,
        usd_spent: ctx.spentUsd,
      });
      return result;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        // RunContext already PATCHed the run to terminated.
        throw err;
      }
      await c.updateRun(payload.run_id, {
        status: "failed",
        termination_reason: String(err),
        tokens_spent: ctx.spentTokens,
        usd_spent: ctx.spentUsd,
      });
      throw err;
    }
  };

  return { ...def, handler };
}
