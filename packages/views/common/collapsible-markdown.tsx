"use client";

import { useState } from "react";
import { cn } from "@multica/ui/lib/utils";
import { Markdown, type MarkdownProps } from "./markdown";
import { useT } from "../i18n";

/**
 * Rough per-line character budget used only to decide whether the collapse
 * toggle shows; the actual clamp is a max-height on the container.
 */
const CHARS_PER_LINE = 100;

/** True when content is long enough to warrant default-collapsed rendering. */
export function isLongContent(content: string, maxLines: number): boolean {
  return (
    content.split("\n").length > maxLines ||
    content.length > maxLines * CHARS_PER_LINE
  );
}

export interface CollapsibleMarkdownProps {
  /** Markdown source; renders nothing when empty. */
  content: string;
  /** Visible line budget before collapsing. @default 8 */
  maxLines?: number;
  className?: string;
  /** Forwarded to the underlying Markdown renderer. @default "minimal" */
  mode?: MarkdownProps["mode"];
}

/**
 * Unified renderer for agent-produced text (evidence summaries, review
 * packages, workflow descriptions): markdown rendering with over-long
 * content collapsed by default behind an expand toggle.
 */
export function CollapsibleMarkdown({
  content,
  maxLines = 8,
  className,
  mode = "minimal",
}: CollapsibleMarkdownProps) {
  const { t } = useT("common");
  const [expanded, setExpanded] = useState(false);
  if (!content) return null;

  const collapsible = isLongContent(content, maxLines);
  const collapsed = collapsible && !expanded;

  return (
    <div className={cn("min-w-0", className)} data-testid="collapsible-markdown">
      <div
        className={cn("relative min-w-0 text-sm", collapsed && "overflow-hidden")}
        style={collapsed ? { maxHeight: `${maxLines * 1.5}em` } : undefined}
      >
        <Markdown mode={mode}>{content}</Markdown>
        {collapsed && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-background to-transparent" />
        )}
      </div>
      {collapsible && (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t(($) => $.collapse) : t(($) => $.expand)}
        </button>
      )}
    </div>
  );
}
