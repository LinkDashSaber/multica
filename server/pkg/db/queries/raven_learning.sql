-- name: CreateRavenLearning :one
INSERT INTO raven_learning (workspace_id, run_id, stage, content)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetRavenLearning :one
SELECT * FROM raven_learning
WHERE id = $1 AND workspace_id = $2;

-- name: ListRavenLearnings :many
-- Workspace learning stream, newest first, with provenance for linking:
-- the requirement's issue. Each promoted row carries the produced asset
-- (issue #28) so the UI can link back to the reusable skill / fact / evidence.
-- Optional run filter.
SELECT l.*, req.issue_id,
       a.id AS asset_id,
       a.kind AS asset_kind,
       a.title AS asset_title,
       a.skill_id AS asset_skill_id,
       a.workflow_id AS asset_workflow_id
FROM raven_learning l
JOIN raven_run r ON r.id = l.run_id
JOIN raven_requirement req ON req.id = r.requirement_id
LEFT JOIN raven_asset a ON a.learning_id = l.id
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

-- name: CountRavenLearningsByRequirement :one
SELECT count(*) FROM raven_learning l
JOIN raven_run r ON r.id = l.run_id
WHERE r.requirement_id = $1;
