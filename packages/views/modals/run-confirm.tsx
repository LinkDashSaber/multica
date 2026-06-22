"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import type { IssueAssigneeType, IssueStatus, UpdateIssueRequest } from "@multica/core/types";
import { useUpdateIssue, useBatchUpdateIssues } from "@multica/core/issues/mutations";
import { useActorName } from "@multica/core/workspace/hooks";
import { useIssueTriggerPreview } from "../issues/hooks/use-issue-trigger-preview";
import { useT } from "../i18n";

const MAX_HANDOFF_NOTE = 2000;

interface RunConfirmData {
  issueIds?: string[];
  mode?: "assign" | "status";
  assigneeType?: IssueAssigneeType;
  assigneeId?: string;
  assigneeName?: string;
  status?: IssueStatus;
}

/**
 * Pre-trigger confirmation for issue writes that may start agent runs
 * (MUL-3375 §4). Shows what the unified backend predicate says will start (via
 * the preview endpoint — never a frontend guess), lets the user attach a
 * handoff note (assign only) and choose "暂不启动", then applies the change.
 * Shared by single assign (1 id) and batch assign / batch status (N ids).
 */
export function RunConfirmModal({
  onClose,
  data,
}: {
  onClose: () => void;
  data: Record<string, unknown> | null;
}) {
  const { t } = useT("modals");
  const { getActorName } = useActorName();
  const d = (data ?? {}) as RunConfirmData;
  const issueIds = d.issueIds ?? [];
  const mode = d.mode ?? "assign";

  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const updateIssue = useUpdateIssue();
  const batchUpdate = useBatchUpdateIssues();

  const preview = useIssueTriggerPreview({
    issueIds,
    assigneeType: d.assigneeType ?? null,
    assigneeId: d.assigneeId ?? null,
    status: d.status,
    enabled: issueIds.length > 0,
  });

  const willStart = preview.totalCount > 0;
  const canNote = mode === "assign" && willStart;
  // Soft gate: an old runtime can't render the note. Disable the box but let
  // the assignment proceed (MUL-3375 §6.3).
  const noteDisabled = canNote && !preview.handoffSupported;

  const applyTo = (extra: Partial<UpdateIssueRequest>) => {
    const base: UpdateIssueRequest =
      mode === "assign"
        ? { assignee_type: d.assigneeType ?? null, assignee_id: d.assigneeId ?? null }
        : { status: d.status };
    return { ...base, ...extra };
  };

  const submit = async (suppressRun: boolean) => {
    if (issueIds.length === 0 || submitting) return;
    setSubmitting(true);
    const payload = applyTo({
      ...(suppressRun ? { suppress_run: true } : {}),
      ...(!suppressRun && canNote && !noteDisabled && note.trim()
        ? { handoff_note: note.trim() }
        : {}),
    });
    try {
      if (issueIds.length === 1) {
        await updateIssue.mutateAsync({ id: issueIds[0]!, ...payload });
      } else {
        await batchUpdate.mutateAsync({ ids: issueIds, updates: payload });
      }
      onClose();
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t(($) => $.run_confirm.toast_failed));
      setSubmitting(false);
    }
  };

  const headline = (() => {
    if (!willStart) {
      return mode === "assign"
        ? t(($) => $.run_confirm.nothing_assign)
        : t(($) => $.run_confirm.nothing_status);
    }
    // Single trigger → name the agent ("将启动 @X"), resolved from the preview's
    // runnable agent (squad leader for squads). Batch → count.
    if (preview.triggers.length === 1) {
      const name = d.assigneeName ?? getActorName("agent", preview.triggers[0]!.agent_id);
      return t(($) => $.run_confirm.will_start_named, { name });
    }
    return t(($) => $.run_confirm.will_start, { count: preview.totalCount });
  })();

  return (
    <AlertDialog open onOpenChange={(v) => { if (!v && !submitting) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {mode === "assign" ? t(($) => $.run_confirm.title_assign) : t(($) => $.run_confirm.title_status)}
          </AlertDialogTitle>
          <AlertDialogDescription>{headline}</AlertDialogDescription>
        </AlertDialogHeader>

        {canNote ? (
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="handoff-note">
              {t(($) => $.run_confirm.note_label)}
            </label>
            <Textarea
              id="handoff-note"
              value={note}
              maxLength={MAX_HANDOFF_NOTE}
              disabled={noteDisabled || submitting}
              placeholder={t(($) => $.run_confirm.note_placeholder)}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />
            {noteDisabled ? (
              <p className="text-xs text-muted-foreground">{t(($) => $.run_confirm.note_unsupported)}</p>
            ) : null}
          </div>
        ) : null}

        <AlertDialogFooter>
          {willStart ? (
            <>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => submit(true)}>
                {t(($) => $.run_confirm.dont_start)}
              </Button>
              <Button type="button" disabled={submitting} onClick={() => submit(false)}>
                {t(($) => $.run_confirm.start)}
              </Button>
            </>
          ) : (
            <Button type="button" disabled={submitting} onClick={() => submit(false)}>
              {t(($) => $.run_confirm.apply)}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
