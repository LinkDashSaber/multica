-- name: CreateRavenRun :one
INSERT INTO raven_run (workspace_id, requirement_id, workflow_id, status)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetRavenRun :one
-- Workspace_id is a SQL-layer tenant guard.
SELECT * FROM raven_run
WHERE id = $1 AND workspace_id = $2;

-- name: ListRavenRunsByRequirement :many
SELECT * FROM raven_run
WHERE requirement_id = $1 AND workspace_id = $2
ORDER BY created_at DESC;

-- name: ListRavenRunsByWorkflow :many
-- Run history for one workflow, with the requirement's issue for linking.
SELECT r.*, req.issue_id
FROM raven_run r
JOIN raven_requirement req ON req.id = r.requirement_id
WHERE r.workflow_id = $1 AND r.workspace_id = $2
ORDER BY r.created_at DESC;

-- name: UpdateRavenRun :one
UPDATE raven_run SET
    trigger_run_id = COALESCE(sqlc.narg('trigger_run_id'), trigger_run_id),
    status = COALESCE(sqlc.narg('status'), status),
    -- Completed runs carry no failure residue: earlier failed attempts may
    -- have written termination_reason, and a later success must clear it.
    termination_reason = CASE
        WHEN COALESCE(sqlc.narg('status'), status) = 'completed' THEN ''
        ELSE COALESCE(sqlc.narg('termination_reason'), termination_reason)
    END,
    tokens_spent = COALESCE(sqlc.narg('tokens_spent'), tokens_spent),
    usd_spent = COALESCE(sqlc.narg('usd_spent'), usd_spent),
    updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: CreateRavenEvidence :one
INSERT INTO raven_evidence (workspace_id, requirement_id, run_id, kind, source, summary, payload)
VALUES ($1, $2, sqlc.narg('run_id'), $3, $4, $5, $6)
RETURNING *;

-- name: ListRavenEvidenceByRequirement :many
SELECT * FROM raven_evidence
WHERE requirement_id = $1 AND workspace_id = $2
ORDER BY created_at ASC;
