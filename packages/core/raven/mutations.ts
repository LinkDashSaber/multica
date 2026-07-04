import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ravenKeys } from "./queries";

export interface DecideGateInput {
  gateId: string;
  approve: boolean;
  reason: string;
}

/**
 * Record a human verdict on a gate review. Not optimistic — the server is
 * the arbiter of "already decided" (409), so we settle by invalidating the
 * gate and the pending queue instead of guessing.
 */
export function useDecideRavenGate(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ gateId, approve, reason }: DecideGateInput) =>
      api.decideRavenGate(gateId, { approve, reason }),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ravenKeys.gate(wsId, vars.gateId) });
      qc.invalidateQueries({ queryKey: ravenKeys.pendingGates(wsId) });
    },
  });
}
