-- Raven requirement lifecycle (ADR-0006: opt-in via workflow assignment).
--
-- Raven-owned tables live in the 900+ migration range to avoid colliding
-- with upstream multica migration numbers. The multica issue table is NOT
-- modified: a requirement attaches to an issue via issue_id, and the issue's
-- board status is a one-way projection of the lifecycle state.

-- One requirement per issue. The nine-state machine is defined and enforced
-- in server/internal/raven; the CHECK constraint only guards vocabulary.
CREATE TABLE raven_requirement (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL UNIQUE REFERENCES issue(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'idea' CHECK (state IN (
        'idea', 'spec', 'ready', 'running',
        'needs_review', 'needs_human', 'merged', 'observed', 'learned'
    )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_raven_requirement_ws_state ON raven_requirement(workspace_id, state);

-- Append-only transition history — the audit spine for the requirement
-- timeline. from_state '' marks the creation event.
CREATE TABLE raven_requirement_transition (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requirement_id UUID NOT NULL REFERENCES raven_requirement(id) ON DELETE CASCADE,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
    actor_id TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_raven_transition_req ON raven_requirement_transition(requirement_id, created_at);
