-- name: CreateRavenWorkflow :one
INSERT INTO raven_workflow (workspace_id, name, description, contract)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetRavenWorkflow :one
-- Workspace_id is a SQL-layer tenant guard.
SELECT * FROM raven_workflow
WHERE id = $1 AND workspace_id = $2;

-- name: ListRavenWorkflows :many
SELECT * FROM raven_workflow
WHERE workspace_id = $1
ORDER BY created_at ASC;

-- name: UpdateRavenWorkflow :one
UPDATE raven_workflow SET
    description = COALESCE(sqlc.narg('description'), description),
    contract = COALESCE(sqlc.narg('contract'), contract),
    enabled = COALESCE(sqlc.narg('enabled'), enabled),
    version = version + 1,
    updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING *;
