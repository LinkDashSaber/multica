-- name: CreateRavenGateReview :one
-- sample_result: '' under full review, 'selected' when a sampled gate's
-- spot check hits (still a normal human review).
INSERT INTO raven_gate_review (workspace_id, requirement_id, run_id, gate_name, review_package, sample_result)
VALUES ($1, $2, sqlc.narg('run_id'), $3, $4, $5)
RETURNING *;

-- name: CreateAutoApprovedRavenGateReview :one
-- Spot check miss under a sampled policy: the gate auto-passes with a
-- permanent trace (sample_result) and no human in the loop.
INSERT INTO raven_gate_review (workspace_id, requirement_id, run_id, gate_name, review_package,
                               status, decision_reason, decided_at, sample_result)
VALUES ($1, $2, sqlc.narg('run_id'), $3, $4, 'approved', $5, now(), 'auto_approved')
RETURNING *;

-- name: GetRavenGateReview :one
-- Workspace_id is a SQL-layer tenant guard.
SELECT * FROM raven_gate_review
WHERE id = $1 AND workspace_id = $2;

-- name: ListRavenGateReviewsByRequirement :many
SELECT * FROM raven_gate_review
WHERE requirement_id = $1 AND workspace_id = $2
ORDER BY created_at DESC;

-- name: ListRavenGateReviewsByWorkflow :many
-- Gate decisions across all runs of a workflow (workflow detail page).
SELECT g.* FROM raven_gate_review g
JOIN raven_run r ON r.id = g.run_id
WHERE r.workflow_id = $1 AND g.workspace_id = $2
ORDER BY g.created_at DESC;

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

-- name: CountRejectedRavenGateReviews :one
SELECT count(*) FROM raven_gate_review
WHERE requirement_id = $1 AND status = 'rejected';
