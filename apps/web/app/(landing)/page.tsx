import type { Metadata } from "next";
import { Loader2 } from "lucide-react";
import { RedirectIfAuthenticated } from "@/features/landing/components/redirect-if-authenticated";

export const metadata: Metadata = {
  title: {
    absolute: "Multica",
  },
  robots: { index: false },
};

// Internal deployment: no marketing landing. The proxy sends logged-out
// visitors to /login and cookie-carrying users to their last workspace;
// this page only covers the gap where the session cookie exists but no
// workspace cookie does yet (first login) — RedirectIfAuthenticated picks
// the destination client-side.
export default function RootPage() {
  return (
    <>
      <RedirectIfAuthenticated />
      <div className="flex min-h-svh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    </>
  );
}
