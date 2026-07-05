-- Zero-cost trajectory archive (issue #23, ADR-0008 分级触发成本模型).
-- One row per delivered issue, written by pure code at Learned time (on-track
-- requirements) or at bare-delivery done time (uptrack counting). Isomorphism
-- counting is a query over this table — no separate system.

CREATE TABLE raven_requirement_archive (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    -- NULL for bare deliveries that never joined the Raven track: they are
    -- archived too, so the workflow uptrack threshold (N=3 isomorphic
    -- deliveries) can count them.
    requirement_id UUID REFERENCES raven_requirement(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL UNIQUE REFERENCES issue(id) ON DELETE CASCADE,
    issue_title TEXT NOT NULL DEFAULT '',
    -- Comma-joined lifecycle to_state sequence ('' for bare deliveries).
    stage_sequence TEXT NOT NULL DEFAULT '',
    rework_count INT NOT NULL DEFAULT 0,
    gate_reject_count INT NOT NULL DEFAULT 0,
    learning_count INT NOT NULL DEFAULT 0,
    tokens_spent BIGINT NOT NULL DEFAULT 0,
    -- Keyword fingerprint extracted from the issue title/description.
    keywords TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_raven_archive_ws ON raven_requirement_archive(workspace_id, created_at DESC);
