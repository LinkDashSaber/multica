import { task } from "@trigger.dev/sdk";
import type { Workflow } from "./define-workflow";
import type { RunPayload } from "./run-context";

// The only file in this package that imports @trigger.dev/sdk.
export function toTriggerTask(workflow: Workflow) {
  return task({
    id: workflow.name,
    run: (payload: RunPayload) => workflow.handler(payload),
  });
}
