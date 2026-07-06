"use client";

import { useMemo, useState } from "react";
import type { Agent, Squad } from "@multica/core/types";
import { ActorAvatar } from "../../../common/actor-avatar";
import { matchesPinyin } from "../../../editor/extensions/pinyin-match";
import {
  PropertyPicker,
  PickerItem,
  PickerSection,
  PickerEmpty,
} from "./property-picker";

/** A single agent-or-squad selection. */
export type ActorSelection =
  | { type: "agent"; id: string }
  | { type: "squad"; id: string };

/** Caller-supplied localized labels — kept out of the component so it can be
 *  reused across i18n namespaces (create-issue uses "modals"; create-strategy
 *  uses "raven"). */
export interface ActorPickerLabels {
  createdBy: string;
  pickAnAgent: string;
  searchPlaceholder: string;
  noAgents: string;
  agentsGroup: string;
  squadsGroup: string;
}

/**
 * ActorPicker — a "Created by" trigger + searchable popover listing the
 * workspace's agents and squads in one list. Extracted from the create-issue
 * agent panel (issue #26) so the create-strategy flow reuses the exact same
 * agent-or-squad search instead of cloning it. Squads route to their leader
 * agent on the backend; the caller decides how a squad pick is interpreted.
 */
export function ActorPicker({
  actor,
  visibleAgents,
  visibleSquads,
  selectedAgent,
  selectedSquad,
  onPick,
  labels,
}: {
  actor: ActorSelection | null;
  visibleAgents: Agent[];
  visibleSquads: Squad[];
  selectedAgent: Agent | undefined;
  selectedSquad: Squad | undefined;
  onPick: (next: ActorSelection) => void;
  labels: ActorPickerLabels;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();

  const filteredAgents = useMemo(
    () => visibleAgents.filter((a) => a.name.toLowerCase().includes(query) || matchesPinyin(a.name, query)),
    [visibleAgents, query],
  );
  const filteredSquads = useMemo(
    () => visibleSquads.filter((s) => s.name.toLowerCase().includes(query) || matchesPinyin(s.name, query)),
    [visibleSquads, query],
  );

  const displayLabel = selectedSquad?.name ?? selectedAgent?.name;
  const displayActor: ActorSelection | null = selectedSquad
    ? { type: "squad", id: selectedSquad.id }
    : selectedAgent
      ? { type: "agent", id: selectedAgent.id }
      : null;

  return (
    <PropertyPicker
      open={open}
      onOpenChange={(v: boolean) => {
        setOpen(v);
        if (!v) setFilter("");
      }}
      width="w-64"
      align="start"
      searchable
      searchPlaceholder={labels.searchPlaceholder}
      onSearchChange={setFilter}
      trigger={
        <span className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <span>{labels.createdBy}</span>
          {displayActor && displayLabel ? (
            <span className="flex items-center gap-1.5 text-foreground">
              <ActorAvatar
                actorType={displayActor.type}
                actorId={displayActor.id}
                size={16}
              />
              {displayLabel}
            </span>
          ) : (
            <span>{labels.pickAnAgent}</span>
          )}
        </span>
      }
    >
      {filteredAgents.length === 0 && filteredSquads.length === 0 ? (
        query ? (
          <PickerEmpty />
        ) : (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {labels.noAgents}
          </div>
        )
      ) : (
        <>
          {filteredAgents.length > 0 && (
            <PickerSection label={labels.agentsGroup}>
              {filteredAgents.map((a) => (
                <PickerItem
                  key={a.id}
                  selected={actor?.type === "agent" && actor.id === a.id}
                  onClick={() => {
                    onPick({ type: "agent", id: a.id });
                    setOpen(false);
                  }}
                >
                  <ActorAvatar actorType="agent" actorId={a.id} size={18} />
                  <span className="truncate">{a.name}</span>
                </PickerItem>
              ))}
            </PickerSection>
          )}
          {filteredSquads.length > 0 && (
            <PickerSection label={labels.squadsGroup}>
              {filteredSquads.map((s) => (
                <PickerItem
                  key={s.id}
                  selected={actor?.type === "squad" && actor.id === s.id}
                  onClick={() => {
                    onPick({ type: "squad", id: s.id });
                    setOpen(false);
                  }}
                >
                  <ActorAvatar actorType="squad" actorId={s.id} size={18} />
                  <span className="truncate">{s.name}</span>
                </PickerItem>
              ))}
            </PickerSection>
          )}
        </>
      )}
    </PropertyPicker>
  );
}
