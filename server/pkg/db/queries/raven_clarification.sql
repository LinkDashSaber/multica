-- name: CreateRavenClarification :one
INSERT INTO raven_clarification (workspace_id, requirement_id, run_id, stage, questions)
VALUES ($1, $2, sqlc.narg('run_id'), $3, $4)
RETURNING *;

-- name: GetRavenClarification :one
-- Workspace_id is a SQL-layer tenant guard.
SELECT * FROM raven_clarification
WHERE id = $1 AND workspace_id = $2;

-- name: ListRavenClarificationsByRequirement :many
-- All clarifications of a requirement (any status), oldest first — feeds the
-- run room's graph overlay and timeline (issue #18).
SELECT * FROM raven_clarification
WHERE requirement_id = $1 AND workspace_id = $2
ORDER BY created_at ASC;

-- name: ListPendingRavenClarifications :many
SELECT * FROM raven_clarification
WHERE workspace_id = $1 AND status = 'pending'
ORDER BY created_at ASC;

-- name: AnswerRavenClarification :one
-- Only pending clarifications can be answered; answering twice returns no rows.
UPDATE raven_clarification SET
    status = 'answered',
    answer = $3,
    answered_by = $4,
    answered_at = now()
WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
RETURNING *;

-- name: ListPendingRavenGateReviewsWithContract :many
-- Pending gates joined to their workflow contract so the decision-points API
-- can resolve each gate's after_stage (node position) in one query.
SELECT sqlc.embed(g), w.contract
FROM raven_gate_review g
JOIN raven_requirement rq ON rq.id = g.requirement_id
LEFT JOIN raven_workflow w ON w.id = rq.workflow_id
WHERE g.workspace_id = $1 AND g.status = 'pending'
ORDER BY g.created_at ASC;
