-- name: CreateRavenWorkflow :one
INSERT INTO raven_workflow (workspace_id, name, description, contract)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetRavenWorkflow :one
-- Workspace_id is a SQL-layer tenant guard.
SELECT * FROM raven_workflow
WHERE id = $1 AND workspace_id = $2;

-- name: GetRavenWorkflowByName :one
-- Name lookup for the merge-registration hook (ADR-0010): decides
-- create-vs-update so re-registering the same name never duplicates.
SELECT * FROM raven_workflow
WHERE workspace_id = $1 AND name = $2;

-- name: ListRavenWorkflows :many
SELECT * FROM raven_workflow
WHERE workspace_id = $1
ORDER BY created_at ASC;

-- name: ListRavenWorkflowStats :many
-- Per-workflow run/gate aggregates for the workflow list page. Duration is
-- created_at → updated_at of finished runs (raven_run has no started/ended
-- columns; the SDK PATCHes terminal status, so updated_at is the end time).
SELECT
    w.id AS workflow_id,
    COALESCE(rs.run_count, 0)::bigint AS run_count,
    COALESCE(rs.active_runs, 0)::bigint AS active_runs,
    COALESCE(rs.avg_run_seconds, 0)::double precision AS avg_run_seconds,
    COALESCE(gs.approved_gates, 0)::bigint AS approved_gates,
    COALESCE(gs.rejected_gates, 0)::bigint AS rejected_gates
FROM raven_workflow w
LEFT JOIN (
    SELECT rr.workflow_id,
           count(*) AS run_count,
           count(*) FILTER (WHERE rr.status IN ('pending', 'running')) AS active_runs,
           avg(EXTRACT(EPOCH FROM rr.updated_at - rr.created_at))
               FILTER (WHERE rr.status IN ('completed', 'failed', 'terminated')) AS avg_run_seconds
    FROM raven_run rr
    WHERE rr.workspace_id = $1 AND rr.workflow_id IS NOT NULL
    GROUP BY rr.workflow_id
) rs ON rs.workflow_id = w.id
LEFT JOIN (
    SELECT r.workflow_id,
           count(*) FILTER (WHERE g.status = 'approved') AS approved_gates,
           count(*) FILTER (WHERE g.status = 'rejected') AS rejected_gates
    FROM raven_gate_review g
    JOIN raven_run r ON r.id = g.run_id
    WHERE g.workspace_id = $1 AND r.workflow_id IS NOT NULL
    GROUP BY r.workflow_id
) gs ON gs.workflow_id = w.id
WHERE w.workspace_id = $1;

-- name: UpdateRavenWorkflow :one
UPDATE raven_workflow SET
    description = COALESCE(sqlc.narg('description'), description),
    contract = COALESCE(sqlc.narg('contract'), contract),
    enabled = COALESCE(sqlc.narg('enabled'), enabled),
    version = version + 1,
    updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING *;
