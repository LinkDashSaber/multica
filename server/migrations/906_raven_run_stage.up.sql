-- Stage-level run progress (issue #15, ADR-0007 运行态画布 depends on it).
-- current_stage mirrors the latest 'entered' stage; the event table is the
-- append-only stage timeline.

ALTER TABLE raven_run ADD COLUMN current_stage TEXT NOT NULL DEFAULT '';

CREATE TABLE raven_run_stage_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    run_id UUID NOT NULL REFERENCES raven_run(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    event TEXT NOT NULL CHECK (event IN ('entered', 'exited')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_raven_run_stage_event_run ON raven_run_stage_event(run_id, created_at);
