-- Compounded assets produced by promoting a learning (issue #28, ADR-0008
-- 三类去向). Promoting a self-report used to only flip a status string and
-- store a destination name — it produced nothing the user could see or reuse.
-- This ledger is the tangible product: one row per promoted learning.
--   skill_proposal   — also mints a real skill draft (skill_id links to it)
--   fact             — the confirmed 事实与口径 record (content is the asset)
--   uptrack_evidence — durable evidence for a workflow's trust promotion
--                      (workflow_id links to the workflow when known)
-- UNIQUE(learning_id) makes promotion idempotent: one asset per learning.

CREATE TABLE raven_asset (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    learning_id UUID NOT NULL UNIQUE REFERENCES raven_learning(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('skill_proposal', 'fact', 'uptrack_evidence')),
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    skill_id UUID REFERENCES skill(id) ON DELETE SET NULL,
    workflow_id UUID REFERENCES raven_workflow(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_raven_asset_workspace ON raven_asset(workspace_id, created_at DESC);
