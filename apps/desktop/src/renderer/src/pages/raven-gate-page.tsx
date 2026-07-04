import { useParams } from "react-router-dom";
import { ReviewPackagePage } from "@multica/views/raven";

export function RavenGatePage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <ReviewPackagePage gateId={id} />;
}
