-- name: CreateRavenRequirement :one
INSERT INTO raven_requirement (workspace_id, issue_id, state, workflow_id)
VALUES ($1, $2, $3, sqlc.narg('workflow_id'))
RETURNING *;

-- name: GetRavenRequirement :one
-- Workspace_id is a SQL-layer tenant guard.
SELECT * FROM raven_requirement
WHERE id = $1 AND workspace_id = $2;

-- name: GetRavenRequirementByIssue :one
SELECT * FROM raven_requirement
WHERE issue_id = $1 AND workspace_id = $2;

-- name: ListRavenRequirements :many
SELECT * FROM raven_requirement
WHERE workspace_id = $1
ORDER BY created_at DESC;

-- name: UpdateRavenRequirementState :one
UPDATE raven_requirement SET
    state = $2,
    updated_at = now()
WHERE id = $1 AND workspace_id = $3
RETURNING *;

-- name: InsertRavenTransition :one
INSERT INTO raven_requirement_transition (requirement_id, from_state, to_state, actor_type, actor_id, reason)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: ListRavenTransitions :many
SELECT t.* FROM raven_requirement_transition t
JOIN raven_requirement r ON r.id = t.requirement_id
WHERE t.requirement_id = $1 AND r.workspace_id = $2
ORDER BY t.created_at ASC;

-- name: ListMergedRavenRequirementsBefore :many
-- Settle sweeper input: requirements that merged and sat past the
-- observation window without a CI signal advancing them.
SELECT * FROM raven_requirement
WHERE state = 'merged' AND updated_at < $1
ORDER BY updated_at ASC
LIMIT 100;
