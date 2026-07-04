-- Raven gate reviews (产品定义 §5): a workflow run suspends at a contract-
-- declared gate and hands the human a review package; the verdict (approve /
-- reject + reason) is recorded permanently — the data floor for future
-- trust levels.

CREATE TABLE raven_gate_review (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    requirement_id UUID NOT NULL REFERENCES raven_requirement(id) ON DELETE CASCADE,
    run_id UUID REFERENCES raven_run(id) ON DELETE SET NULL,
    -- Must name a gate declared in the workflow contract.
    gate_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    -- One-screen review package assembled by the SDK: diff summary, test
    -- results, CI status, agent self-check, risk notes.
    review_package JSONB NOT NULL DEFAULT '{}',
    decided_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
    decision_reason TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ
);

CREATE INDEX idx_raven_gate_requirement ON raven_gate_review(requirement_id, created_at);
CREATE INDEX idx_raven_gate_ws_pending ON raven_gate_review(workspace_id, status);
