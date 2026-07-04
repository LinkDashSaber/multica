-- Raven workflow registry (ADR-0005): a workflow is a versioned, contract-
-- carrying delivery strategy that issues can be assigned to.

CREATE TABLE raven_workflow (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    -- Static contract declaration: stages / gates / budget (validated by
    -- server/internal/raven before insert; JSONB here is storage only).
    contract JSONB NOT NULL,
    version INT NOT NULL DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name)
);

-- Which workflow a requirement runs under. NULL for requirements created
-- before workflows existed; SET NULL keeps the lifecycle record when a
-- workflow is deleted.
ALTER TABLE raven_requirement
    ADD COLUMN workflow_id UUID REFERENCES raven_workflow(id) ON DELETE SET NULL;

-- Widen the issue assignee vocabulary with 'workflow', following the
-- upstream precedent set by migration 084 for 'squad'. This is the single
-- multica-table touch that makes workflows first-class assignees.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_assignee_type_check;
ALTER TABLE issue ADD CONSTRAINT issue_assignee_type_check
    CHECK (assignee_type IN ('member', 'agent', 'squad', 'workflow'));
