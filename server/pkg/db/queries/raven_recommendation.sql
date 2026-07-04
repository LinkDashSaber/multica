-- name: CreateRavenRecommendation :one
INSERT INTO raven_workflow_recommendation (workspace_id, issue_id, workflow_id, score, reason)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: UpdateRavenRecommendationOutcome :one
-- Workspace_id is a SQL-layer tenant guard.
UPDATE raven_workflow_recommendation
SET outcome = $3, decided_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING *;
