"use client";

import { use } from "react";
import { RunRoomPage } from "@multica/views/raven";

export default function RavenRunRoomRoute({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = use(params);
  return <RunRoomPage runId={runId} />;
}
