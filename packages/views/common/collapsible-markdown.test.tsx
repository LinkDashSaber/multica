// @vitest-environment jsdom

import { type ReactNode } from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../locales/en/common.json";
import { CollapsibleMarkdown, isLongContent } from "./collapsible-markdown";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={{ en: { common: enCommon } }}>
      {children}
    </I18nProvider>
  );
}

describe("isLongContent", () => {
  it("is false for short content and true past the line/char budget", () => {
    expect(isLongContent("hello", 8)).toBe(false);
    expect(isLongContent(Array(20).fill("line").join("\n"), 8)).toBe(true);
    expect(isLongContent("x".repeat(2000), 8)).toBe(true);
  });
});

describe("CollapsibleMarkdown", () => {
  it("renders markdown without a toggle for short content", () => {
    render(<CollapsibleMarkdown content={"**bold** text"} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing for empty content", () => {
    const { container } = render(<CollapsibleMarkdown content="" />, {
      wrapper: Wrapper,
    });
    expect(container.firstChild).toBeNull();
  });

  it("collapses long content by default and expands on click", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n\n");
    render(<CollapsibleMarkdown content={long} maxLines={8} />, {
      wrapper: Wrapper,
    });

    // Collapsed: clamp is applied and the toggle reads "Expand".
    const toggle = screen.getByRole("button", { name: "Expand" });
    const box = screen.getByTestId("collapsible-markdown");
    const clamped = box.querySelector('[style*="max-height"]');
    expect(clamped).not.toBeNull();

    fireEvent.click(toggle);

    // Expanded: clamp removed, toggle flips to "Collapse".
    expect(box.querySelector('[style*="max-height"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument();
    expect(screen.getByText("line 29")).toBeInTheDocument();
  });
});
