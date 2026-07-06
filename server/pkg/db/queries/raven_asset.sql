-- Compounded assets produced by promoting a learning (issue #28).

-- name: CreateRavenAsset :one
INSERT INTO raven_asset (workspace_id, learning_id, kind, title, content, skill_id, workflow_id)
VALUES ($1, $2, $3, $4, $5, sqlc.narg('skill_id'), sqlc.narg('workflow_id'))
RETURNING *;

-- name: GetRavenAssetByLearning :one
SELECT * FROM raven_asset
WHERE learning_id = $1 AND workspace_id = $2;
