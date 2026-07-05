-- Raven clarification decision points (issue #19): a workflow run suspends
-- with a question list (each with an optional recommended answer) until a
-- human answers. First-class sibling of raven_gate_review; the two stay in
-- separate tables and are unified only at the decision-points API layer.

CREATE TABLE raven_clarification (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    requirement_id UUID NOT NULL REFERENCES raven_requirement(id) ON DELETE CASCADE,
    run_id UUID REFERENCES raven_run(id) ON DELETE SET NULL,
    -- Which contract stage the run is suspended at (node position on the canvas).
    stage TEXT NOT NULL DEFAULT '',
    -- [{"question": "...", "options": ["..."], "recommended": "..."}]
    questions JSONB NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered')),
    -- Free text or the chosen recommended option, verbatim.
    answer TEXT NOT NULL DEFAULT '',
    answered_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    answered_at TIMESTAMPTZ
);

CREATE INDEX idx_raven_clarification_requirement ON raven_clarification(requirement_id, created_at);
CREATE INDEX idx_raven_clarification_ws_pending ON raven_clarification(workspace_id, status);
