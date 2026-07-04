-- name: CreateRavenGateReview :one
INSERT INTO raven_gate_review (workspace_id, requirement_id, run_id, gate_name, review_package)
VALUES ($1, $2, sqlc.narg('run_id'), $3, $4)
RETURNING *;

-- name: GetRavenGateReview :one
-- Workspace_id is a SQL-layer tenant guard.
SELECT * FROM raven_gate_review
WHERE id = $1 AND workspace_id = $2;

-- name: ListRavenGateReviewsByRequirement :many
SELECT * FROM raven_gate_review
WHERE requirement_id = $1 AND workspace_id = $2
ORDER BY created_at DESC;

-- name: ListPendingRavenGateReviews :many
SELECT * FROM raven_gate_review
WHERE workspace_id = $1 AND status = 'pending'
ORDER BY created_at ASC;

-- name: DecideRavenGateReview :one
-- Only pending reviews can be decided; deciding twice returns no rows.
UPDATE raven_gate_review SET
    status = $3,
    decided_by = $4,
    decision_reason = $5,
    decided_at = now()
WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
RETURNING *;
