-- Trust promotion (issue #25, ADR-0009): a workflow × gate that earns 8
-- consecutive human approvals may apply — via a promotion decision point —
-- to downgrade the gate from pre-confirmation to 1/5 spot checks.

-- Sampling trace on individual reviews: '' (full mode), 'selected' (spot
-- check hit → normal human review), 'auto_approved' (spot check miss →
-- auto pass, no inbox noise).
ALTER TABLE raven_gate_review
    ADD COLUMN sample_result TEXT NOT NULL DEFAULT ''
    CHECK (sample_result IN ('', 'selected', 'auto_approved'));

-- Per workflow × gate policy. A row only exists once a promotion decision
-- touched the gate; absence means full review. updated_at doubles as the
-- streak boundary after a revert (approvals before it never re-count).
CREATE TABLE raven_gate_policy (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL REFERENCES raven_workflow(id) ON DELETE CASCADE,
    gate_name TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full', 'sampled')),
    approved_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workflow_id, gate_name)
);

-- The promotion application letter, decided like a gate. At most one
-- pending letter per workflow × gate (idempotent issuance).
CREATE TABLE raven_promotion (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL REFERENCES raven_workflow(id) ON DELETE CASCADE,
    gate_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    -- The 8 review records backing the application (evidence for the human).
    evidence JSONB NOT NULL DEFAULT '[]',
    decided_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
    decision_reason TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_raven_promotion_pending
    ON raven_promotion(workflow_id, gate_name) WHERE status = 'pending';
CREATE INDEX idx_raven_promotion_ws_status ON raven_promotion(workspace_id, status);
