"use client";

import { use } from "react";
import { WorkflowDetailPage } from "@multica/views/raven";

export default function RavenWorkflowDetailRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <WorkflowDetailPage workflowId={id} />;
}
