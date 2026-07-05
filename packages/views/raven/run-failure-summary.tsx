"use client";

import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";

const KIND_KEYS = ["error_type", "type", "name", "code"] as const;
const MESSAGE_KEYS = [
  "message",
  "error",
  "reason",
  "detail",
  "details",
  "summary",
] as const;
const MAX_MESSAGE_CHARS = 200;

export interface TerminationSummary {
  /** Error type / code when the reason is a structured blob; "" otherwise. */
  kind: string;
  /** One-line human-readable summary. */
  message: string;
  /** Full original payload for the collapsed raw layer; "" when message covers it. */
  raw: string;
}

function firstLine(s: string): string {
  const line = (s.split("\n", 1)[0] ?? "").trim();
  return line.length > MAX_MESSAGE_CHARS
    ? `${line.slice(0, MAX_MESSAGE_CHARS)}…`
    : line;
}

/**
 * Extract a structured summary (error kind + message) from a run's
 * termination_reason, which may be plain text or a raw JSON error blob.
 * Never throws; malformed input degrades to a truncated plain-text summary.
 */
export function parseTerminationReason(reason: string): TerminationSummary {
  const trimmed = reason.trim();
  if (!trimmed) return { kind: "", message: "", raw: "" };

  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        let kind = "";
        for (const key of KIND_KEYS) {
          if (typeof obj[key] === "string" && obj[key]) {
            kind = obj[key] as string;
            break;
          }
        }
        let message = "";
        for (const key of MESSAGE_KEYS) {
          const value = obj[key];
          if (typeof value === "string" && value && value !== kind) {
            message = firstLine(value);
            break;
          }
        }
        return {
          kind,
          message,
          raw: JSON.stringify(parsed, null, 2),
        };
      }
    } catch {
      // Fall through to plain-text handling.
    }
  }

  const message = firstLine(trimmed);
  return { kind: "", message, raw: message === trimmed ? "" : trimmed };
}

/**
 * Structured error summary for a failed / terminated run. Shows the error
 * kind and message; the raw payload stays behind a default-collapsed layer
 * instead of being rendered verbatim.
 */
export function RunFailureSummary({
  reason,
  className,
}: {
  reason: string;
  className?: string;
}) {
  const { t } = useT("raven");
  const { kind, message, raw } = parseTerminationReason(reason);
  if (!kind && !message && !raw) return null;

  return (
    <div className={cn("space-y-1", className)} data-testid="run-failure-summary">
      <p className="text-xs">
        <span className="font-medium text-destructive">
          {t(($) => $.workflows.run_failure.title)}
        </span>
        {kind && (
          <span className="ml-1.5 font-medium text-foreground/90">{kind}</span>
        )}
        {message && <span className="ml-1.5 text-muted-foreground">{message}</span>}
      </p>
      {raw && (
        <details className="rounded-md border bg-muted/30" data-testid="run-failure-raw">
          <summary className="cursor-pointer select-none px-2 py-1 text-xs font-medium text-muted-foreground">
            {t(($) => $.workflows.run_failure.raw)}
          </summary>
          <pre className="overflow-x-auto whitespace-pre-wrap border-t px-2 py-1.5 text-xs leading-relaxed">
            {raw}
          </pre>
        </details>
      )}
    </div>
  );
}
