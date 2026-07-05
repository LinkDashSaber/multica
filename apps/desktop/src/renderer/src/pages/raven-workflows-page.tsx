import { useParams } from "react-router-dom";
import { WorkflowListPage, WorkflowDetailPage, LearningStreamPage, RunRoomPage, DecisionQueuePage } from "@multica/views/raven";

export function RavenWorkflowsPage() {
  return <WorkflowListPage />;
}

export function RavenDecisionsPage() {
  return <DecisionQueuePage />;
}

export function RavenWorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <WorkflowDetailPage workflowId={id} />;
}

export function RavenLearningsPage() {
  return <LearningStreamPage />;
}

export function RavenRunRoomPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <RunRoomPage runId={id} />;
}
