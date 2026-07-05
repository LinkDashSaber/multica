-- name: CreateRavenLearning :one
INSERT INTO raven_learning (workspace_id, run_id, stage, content)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetRavenLearning :one
SELECT * FROM raven_learning
WHERE id = $1 AND workspace_id = $2;

-- name: ListRavenLearnings :many
-- Workspace learning stream, newest first, with provenance for linking:
-- the requirement's issue. Optional run filter.
SELECT l.*, req.issue_id
FROM raven_learning l
JOIN raven_run r ON r.id = l.run_id
JOIN raven_requirement req ON req.id = r.requirement_id
WHERE l.workspace_id = $1
  AND (sqlc.narg('run_id')::uuid IS NULL OR l.run_id = sqlc.narg('run_id'))
ORDER BY l.created_at DESC;

-- name: UpdateRavenLearningStatus :one
-- Triage transition: only fresh entries may be promoted or expired.
UPDATE raven_learning SET
    status = $3,
    promoted_to = $4,
    updated_at = now()
WHERE id = $1 AND workspace_id = $2 AND status = 'fresh'
RETURNING *;
