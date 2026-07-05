// @vitest-environment jsdom

import { type ReactNode } from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enRaven from "../locales/en/raven.json";
import { RunFailureSummary, parseTerminationReason } from "./run-failure-summary";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={{ en: { raven: enRaven } }}>
      {children}
    </I18nProvider>
  );
}

describe("parseTerminationReason", () => {
  it("extracts kind and message from a JSON error blob", () => {
    const blob = JSON.stringify({
      error_type: "BudgetExceeded",
      message: "token budget exceeded: 2000000",
      attempt: 3,
      stack: "at run()...",
    });
    const parsed = parseTerminationReason(blob);
    expect(parsed.kind).toBe("BudgetExceeded");
    expect(parsed.message).toBe("token budget exceeded: 2000000");
    expect(parsed.raw).toContain('"attempt": 3');
  });

  it("falls back through message-like keys", () => {
    expect(parseTerminationReason('{"error": "boom"}').message).toBe("boom");
    expect(parseTerminationReason('{"code": "E42", "reason": "bad"}')).toMatchObject({
      kind: "E42",
      message: "bad",
    });
  });

  it("treats malformed JSON and plain text as plain text", () => {
    expect(parseTerminationReason("{not json")).toMatchObject({
      kind: "",
      message: "{not json",
      raw: "",
    });
    const multi = parseTerminationReason("first line\nsecond line");
    expect(multi.message).toBe("first line");
    expect(multi.raw).toBe("first line\nsecond line");
  });

  it("truncates very long single-line messages", () => {
    const long = "x".repeat(500);
    const parsed = parseTerminationReason(long);
    expect(parsed.message.length).toBeLessThanOrEqual(201);
    expect(parsed.raw).toBe(long);
  });

  it("returns empties for blank input", () => {
    expect(parseTerminationReason("  ")).toEqual({ kind: "", message: "", raw: "" });
  });
});

describe("RunFailureSummary", () => {
  it("shows a structured summary and keeps the raw blob collapsed by default", () => {
    const blob = JSON.stringify({
      error_type: "DispatchError",
      message: "trigger.dev unreachable",
      trace_id: "tr-123",
    });
    render(<RunFailureSummary reason={blob} />, { wrapper: Wrapper });

    expect(screen.getByText("DispatchError")).toBeInTheDocument();
    expect(screen.getByText("trigger.dev unreachable")).toBeInTheDocument();

    // Raw JSON lives inside a <details> that is not open by default.
    const details = screen.getByTestId("run-failure-raw") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("tr-123");
  });

  it("renders plain-text reasons without a raw layer", () => {
    render(<RunFailureSummary reason="budget exceeded" />, { wrapper: Wrapper });
    expect(screen.getByText("budget exceeded")).toBeInTheDocument();
    expect(screen.queryByTestId("run-failure-raw")).toBeNull();
  });

  it("renders nothing for an empty reason", () => {
    const { container } = render(<RunFailureSummary reason="" />, {
      wrapper: Wrapper,
    });
    expect(container.firstChild).toBeNull();
  });
});
