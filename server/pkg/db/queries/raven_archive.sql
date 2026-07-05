-- name: UpsertRavenArchive :one
-- Idempotent per issue: reopen→done cycles and repeated settles refresh the
-- row instead of duplicating it.
INSERT INTO raven_requirement_archive (
    workspace_id, requirement_id, issue_id, issue_title, stage_sequence,
    rework_count, gate_reject_count, learning_count, tokens_spent, keywords
)
VALUES ($1, sqlc.narg('requirement_id'), $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (issue_id) DO UPDATE SET
    requirement_id = EXCLUDED.requirement_id,
    issue_title = EXCLUDED.issue_title,
    stage_sequence = EXCLUDED.stage_sequence,
    rework_count = EXCLUDED.rework_count,
    gate_reject_count = EXCLUDED.gate_reject_count,
    learning_count = EXCLUDED.learning_count,
    tokens_spent = EXCLUDED.tokens_spent,
    keywords = EXCLUDED.keywords
RETURNING *;

-- name: GetRavenArchiveByRequirement :one
SELECT * FROM raven_requirement_archive
WHERE requirement_id = $1 AND workspace_id = $2;

-- name: ListRavenArchives :many
SELECT * FROM raven_requirement_archive
WHERE workspace_id = $1
ORDER BY created_at DESC;
