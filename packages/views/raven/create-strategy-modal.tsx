"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useCreateIssue } from "@multica/core/issues/mutations";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { useNavigation } from "../navigation";
import { useT } from "../i18n";

/**
 * 「新建交付策略」(ADR-0010): a minimal title + intent form. Submitting
 * creates an issue assigned to the built-in workflow-authoring strategy —
 * the server-side opt-in hook puts it on the Raven track and dispatches the
 * authoring run; clarification and contract confirmation happen as decision
 * points, and the merged PR registers the workflow automatically.
 */
export function CreateStrategyModal({
  open,
  onOpenChange,
  authoringWorkflowId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  authoringWorkflowId: string;
}) {
  const { t } = useT("raven");
  const wsPaths = useWorkspacePaths();
  const { push } = useNavigation();
  const createIssue = useCreateIssue();
  const [title, setTitle] = useState("");
  const [intent, setIntent] = useState("");

  const submit = () => {
    if (title.trim() === "" || createIssue.isPending) return;
    createIssue.mutate(
      {
        title: title.trim(),
        description: intent.trim(),
        assignee_type: "workflow",
        assignee_id: authoringWorkflowId,
      },
      {
        onSuccess: (issue) => {
          onOpenChange(false);
          setTitle("");
          setIntent("");
          push(wsPaths.issueDetail(issue.id));
        },
        onError: () => {
          toast.error(t(($) => $.workflows.create.failed));
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.workflows.create.title)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.workflows.create.description)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t(($) => $.workflows.create.title_placeholder)}
            autoFocus
            data-testid="create-strategy-title"
          />
          <Textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder={t(($) => $.workflows.create.intent_placeholder)}
            rows={3}
            data-testid="create-strategy-intent"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t(($) => $.workflows.create.cancel)}
          </Button>
          <Button
            onClick={submit}
            disabled={title.trim() === "" || createIssue.isPending}
            data-testid="create-strategy-submit"
          >
            {t(($) => $.workflows.create.submit)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
