-- Raven workflow runs and evidence chain (ADR-0002 / 产品定义 §5).
-- issue : run = 1 : N — gate rejections loop inside a run; starting over
-- creates a new run.

CREATE TABLE raven_run (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    requirement_id UUID NOT NULL REFERENCES raven_requirement(id) ON DELETE CASCADE,
    workflow_id UUID REFERENCES raven_workflow(id) ON DELETE SET NULL,
    -- trigger.dev run handle; empty until (or unless) the dispatch succeeded.
    trigger_run_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'running', 'completed', 'failed', 'terminated'
    )),
    -- Human-readable cause for failed/terminated runs (e.g. budget exceeded).
    termination_reason TEXT NOT NULL DEFAULT '',
    tokens_spent BIGINT NOT NULL DEFAULT 0,
    usd_spent DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_raven_run_requirement ON raven_run(requirement_id, created_at);

-- Structured evidence: every claim a workflow makes must be backed by a row
-- here. multica comments only ever carry summaries + backlinks.
CREATE TABLE raven_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    requirement_id UUID NOT NULL REFERENCES raven_requirement(id) ON DELETE CASCADE,
    run_id UUID REFERENCES raven_run(id) ON DELETE SET NULL,
    -- Producer-defined kind: 'agent_output', 'note', 'pr', 'ci', 'diff', ...
    kind TEXT NOT NULL,
    -- Which primitive/integration wrote it: 'agent()', 'evidence()', 'github'.
    source TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_raven_evidence_requirement ON raven_evidence(requirement_id, created_at);
CREATE INDEX idx_raven_evidence_run ON raven_evidence(run_id);
