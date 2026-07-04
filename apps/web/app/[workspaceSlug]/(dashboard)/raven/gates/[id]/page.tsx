"use client";

import { use } from "react";
import { ReviewPackagePage } from "@multica/views/raven";

export default function RavenGateRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <ReviewPackagePage gateId={id} />;
}
