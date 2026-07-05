-- Execution self-reported learnings (issue #22, ADR-0008 主进料口).
-- One row per ctx.learning() call: what an agent noticed mid-run, with its
-- provenance (run + stage). status tracks the 沉淀流 triage:
--   fresh    — recorded, awaiting triage
--   promoted — promoted; promoted_to names the destination
--              (skill_proposal / fact / uptrack_evidence)
--   expired  — marked as not worth keeping

CREATE TABLE raven_learning (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    run_id UUID NOT NULL REFERENCES raven_run(id) ON DELETE CASCADE,
    stage TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'fresh' CHECK (status IN ('fresh', 'promoted', 'expired')),
    promoted_to TEXT NOT NULL DEFAULT '' CHECK (promoted_to IN ('', 'skill_proposal', 'fact', 'uptrack_evidence')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_raven_learning_workspace ON raven_learning(workspace_id, created_at DESC);
CREATE INDEX idx_raven_learning_run ON raven_learning(run_id, created_at);
