-- Raven workflow recommendation log (issue #9): every recommendation the
-- server makes at issue create/assign time is persisted with the user's
-- final decision, so recommendation quality can be evaluated later.

CREATE TABLE raven_workflow_recommendation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    -- Nullable: create-flow recommendations are requested from the new-issue
    -- form before the issue row exists.
    issue_id UUID REFERENCES issue(id) ON DELETE CASCADE,
    -- NULL means "no confident match" — the UI offers the Squad fallback.
    workflow_id UUID REFERENCES raven_workflow(id) ON DELETE SET NULL,
    score REAL NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT 'pending'
        CHECK (outcome IN ('pending', 'accepted', 'ignored', 'fallback_squad')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ
);

CREATE INDEX idx_raven_reco_ws_created
    ON raven_workflow_recommendation(workspace_id, created_at);
