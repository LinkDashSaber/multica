"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { useCreateIssue } from "@multica/core/issues/mutations";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { agentListOptions } from "@multica/core/workspace/queries";
import type { Agent } from "@multica/core/types";
import {
  ApiError,
  DuplicateIssueErrorBodySchema,
  type DuplicateIssueErrorBody,
  parseWithFallback,
} from "@multica/core/api";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { ActorAvatar } from "../common/actor-avatar";
import {
  ActorPicker,
  type ActorSelection,
} from "../issues/components/pickers/actor-picker";
import {
  PropertyPicker,
  PickerItem,
  PickerEmpty,
} from "../issues/components/pickers/property-picker";
import { SkillMultiSelect } from "../agents/components/skill-multi-select";
import { matchesPinyin } from "../editor/extensions/pinyin-match";
import { useNavigation } from "../navigation";
import { useT } from "../i18n";

type CreateMode = "auto" | "manual";

/**
 * 「新建交付策略」(ADR-0010 / issue #26): a title + intent form that now adopts
 * the same 智能/手动 dual-mode as creating an issue.
 *
 * - 智能 (auto): the user designates ONE creator agent; that agent picks the
 *   skills + squad while drafting the strategy during the authoring run.
 * - 手动 (manual): the user selects the strategy's composition directly — one
 *   or more agents AND some skills — which is persisted as part of the contract.
 *
 * Either way the chosen agent (agent_ids[0]) is threaded into the authoring
 * run's dispatch via `raven_composition`, so the run uses this workspace's
 * agent instead of a global env agent.
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
  const wsId = useWorkspaceId();
  const wsPaths = useWorkspacePaths();
  const { push } = useNavigation();
  const createIssue = useCreateIssue();

  const [mode, setMode] = useState<CreateMode>("auto");
  const [title, setTitle] = useState("");
  const [intent, setIntent] = useState("");
  // 智能 mode: single creator agent.
  const [creator, setCreator] = useState<ActorSelection | null>(null);
  // 手动 mode: composition of agents + skills.
  const [agentIds, setAgentIds] = useState<Set<string>>(new Set());
  const [skillIds, setSkillIds] = useState<Set<string>>(new Set());

  const { data: agentsRaw = [] } = useQuery(agentListOptions(wsId));
  // ponytail: workspace agents minus archived; run-time invocation permission
  // is enforced server-side when the authoring run dispatches to the agent.
  const agents = useMemo<Agent[]>(
    () => agentsRaw.filter((a) => !a.archived_at),
    [agentsRaw],
  );
  const selectedCreator = useMemo<Agent | undefined>(
    () => (creator ? agents.find((a) => a.id === creator.id) : undefined),
    [creator, agents],
  );

  const reset = () => {
    setMode("auto");
    setTitle("");
    setIntent("");
    setCreator(null);
    setAgentIds(new Set());
    setSkillIds(new Set());
  };

  // agent_ids[0] is the agent the authoring run dispatches to.
  const composedAgentIds =
    mode === "auto"
      ? creator
        ? [creator.id]
        : []
      : [...agentIds];

  const canSubmit =
    title.trim() !== "" && composedAgentIds.length > 0 && !createIssue.isPending;

  const runCreate = (allowDuplicate: boolean) => {
    createIssue.mutate(
      {
        title: title.trim(),
        description: intent.trim(),
        assignee_type: "workflow",
        assignee_id: authoringWorkflowId,
        allow_duplicate: allowDuplicate,
        raven_composition: {
          mode,
          agent_ids: composedAgentIds,
          skill_ids: mode === "manual" ? [...skillIds] : [],
        },
      },
      {
        onSuccess: (issue) => {
          onOpenChange(false);
          reset();
          push(wsPaths.issueDetail(issue.id));
        },
        onError: (err) => {
          // The only structured 409 this endpoint returns is an active issue
          // with the same title. Surface the real reason — with a jump to the
          // existing strategy and a "create anyway" escape — instead of an
          // opaque failure toast. Schema-guard the body so a server-side rename
          // degrades to the generic toast rather than throwing in the renderer.
          if (err instanceof ApiError && err.status === 409) {
            const dup = parseWithFallback<DuplicateIssueErrorBody | null>(
              err.body,
              DuplicateIssueErrorBodySchema,
              null,
              { endpoint: "POST /api/issues (active_duplicate_issue)" },
            );
            if (dup) {
              toast.custom(
                (toastId) => (
                  <div className="w-[360px] rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg">
                    <div className="mb-2 flex items-center gap-2">
                      <div className="flex size-5 items-center justify-center rounded-full bg-amber-500/15 text-amber-500">
                        <AlertTriangle className="size-3" />
                      </div>
                      <span className="text-sm font-medium">
                        {t(($) => $.workflows.create.duplicate_title)}
                      </span>
                    </div>
                    <p className="ml-7 truncate text-sm text-muted-foreground">
                      {dup.issue.identifier} – {dup.issue.title}
                    </p>
                    <div className="ml-7 mt-2 flex items-center gap-4">
                      <button
                        type="button"
                        className="cursor-pointer text-sm text-primary hover:underline"
                        onClick={() => {
                          toast.dismiss(toastId);
                          onOpenChange(false);
                          reset();
                          push(wsPaths.issueDetail(dup.issue.id));
                        }}
                      >
                        {t(($) => $.workflows.create.duplicate_view)}
                      </button>
                      <button
                        type="button"
                        className="cursor-pointer text-sm text-muted-foreground hover:text-foreground hover:underline"
                        onClick={() => {
                          toast.dismiss(toastId);
                          runCreate(true);
                        }}
                      >
                        {t(($) => $.workflows.create.duplicate_anyway)}
                      </button>
                    </div>
                  </div>
                ),
                { duration: 8000 },
              );
              return;
            }
          }
          toast.error(t(($) => $.workflows.create.failed));
        },
      },
    );
  };

  const submit = () => {
    if (!canSubmit) return;
    runCreate(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.workflows.create.title)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.workflows.create.description)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* 智能/手动 toggle — same choice as creating an issue. */}
          <div
            role="tablist"
            aria-label={t(($) => $.workflows.create.mode_label)}
            className="inline-flex rounded-md border bg-muted/40 p-0.5"
          >
            {(["auto", "manual"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                data-testid={`create-strategy-mode-${m}`}
                onClick={() => setMode(m)}
                className={cn(
                  "rounded-[5px] px-3 py-1 text-xs font-medium transition-colors",
                  mode === m
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "auto"
                  ? t(($) => $.workflows.create.mode_smart)
                  : t(($) => $.workflows.create.mode_manual)}
              </button>
            ))}
          </div>

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

          {mode === "auto" ? (
            <div className="space-y-1.5 rounded-md border p-3" data-testid="create-strategy-auto">
              <ActorPicker
                actor={creator}
                visibleAgents={agents}
                visibleSquads={[]}
                selectedAgent={selectedCreator}
                selectedSquad={undefined}
                onPick={setCreator}
                labels={{
                  createdBy: t(($) => $.workflows.create.creator_label),
                  pickAnAgent: t(($) => $.workflows.create.pick_agent),
                  searchPlaceholder: t(($) => $.workflows.create.search_agents),
                  noAgents: t(($) => $.workflows.create.no_agents),
                  agentsGroup: t(($) => $.workflows.create.agents_group),
                  squadsGroup: t(($) => $.workflows.create.squads_group),
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t(($) => $.workflows.create.mode_smart_hint)}
              </p>
            </div>
          ) : (
            <div className="space-y-3 rounded-md border p-3" data-testid="create-strategy-manual">
              <AgentMultiSelect
                agents={agents}
                selectedIds={agentIds}
                onChange={setAgentIds}
                label={t(($) => $.workflows.create.agents_label)}
                placeholder={t(($) => $.workflows.create.agents_placeholder)}
                selectedText={(count) =>
                  t(($) => $.workflows.create.agents_selected, { count })
                }
                searchPlaceholder={t(($) => $.workflows.create.search_agents)}
                noAgents={t(($) => $.workflows.create.no_agents)}
              />
              <SkillMultiSelect selectedIds={skillIds} onChange={setSkillIds} />
              <p className="text-xs text-muted-foreground">
                {t(($) => $.workflows.create.mode_manual_hint)}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t(($) => $.workflows.create.cancel)}
          </Button>
          <Button
            onClick={submit}
            disabled={!canSubmit}
            title={
              composedAgentIds.length === 0
                ? t(($) => $.workflows.create.need_agent)
                : undefined
            }
            data-testid="create-strategy-submit"
          >
            {t(($) => $.workflows.create.submit)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Compact multi-select of the workspace's agents for 手动 mode. Uses the same
 * searchable PropertyPicker primitive as the single-actor picker, toggling a
 * selection set instead of closing on pick.
 */
function AgentMultiSelect({
  agents,
  selectedIds,
  onChange,
  label,
  placeholder,
  selectedText,
  searchPlaceholder,
  noAgents,
}: {
  agents: Agent[];
  selectedIds: Set<string>;
  onChange: (next: Set<string>) => void;
  label: string;
  placeholder: string;
  selectedText: (count: number) => string;
  searchPlaceholder: string;
  noAgents: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();

  const filtered = useMemo(
    () =>
      agents.filter(
        (a) => a.name.toLowerCase().includes(query) || matchesPinyin(a.name, query),
      ),
    [agents, query],
  );

  const toggle = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        {selectedIds.size > 0 ? (
          <span className="ml-2 text-foreground/60">({selectedIds.size})</span>
        ) : null}
      </div>
      <div className="mt-1.5">
        <PropertyPicker
          open={open}
          onOpenChange={(v: boolean) => {
            setOpen(v);
            if (!v) setFilter("");
          }}
          width="w-64"
          align="start"
          searchable
          searchPlaceholder={searchPlaceholder}
          onSearchChange={setFilter}
          trigger={
            <button
              type="button"
              data-testid="create-strategy-agents-trigger"
              className="flex w-full items-center gap-2 rounded-md border bg-card px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent/40"
            >
              <span className="min-w-0 flex-1 truncate">
                {selectedIds.size > 0 ? selectedText(selectedIds.size) : placeholder}
              </span>
            </button>
          }
        >
          {filtered.length === 0 ? (
            query ? (
              <PickerEmpty />
            ) : (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{noAgents}</div>
            )
          ) : (
            filtered.map((a) => (
              <PickerItem
                key={a.id}
                selected={selectedIds.has(a.id)}
                onClick={() => toggle(a.id)}
              >
                <ActorAvatar actorType="agent" actorId={a.id} size={18} />
                <span className="truncate">{a.name}</span>
              </PickerItem>
            ))
          )}
        </PropertyPicker>
      </div>
    </div>
  );
}
