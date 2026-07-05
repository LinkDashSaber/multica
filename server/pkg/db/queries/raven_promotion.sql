-- Trust promotion (issue #25, ADR-0009): consecutive zero-reject streaks,
-- gate policies (full | sampled), and promotion application letters.

-- The streak boundary is the later of: the last human rejection of this
-- workflow × gate, and the last time the policy was reverted to full
-- (policy.updated_at with mode='full'). Only human approvals after that
-- boundary count — auto-approved sampling rows have decided_by NULL and
-- never count.
-- ponytail: correlated subqueries, O(n²) over gate reviews; fine at raven
-- scale, switch to a window-function CTE if review volume ever matters.

-- name: GetRavenGateStreak :one
SELECT count(*)::bigint AS streak
FROM raven_gate_review g
JOIN raven_requirement rq ON rq.id = g.requirement_id
WHERE g.workspace_id = $1 AND rq.workflow_id = $2 AND g.gate_name = $3
  AND g.status = 'approved' AND g.decided_by IS NOT NULL
  AND g.decided_at > GREATEST(
    COALESCE((
        SELECT max(g2.decided_at) FROM raven_gate_review g2
        JOIN raven_requirement rq2 ON rq2.id = g2.requirement_id
        WHERE g2.workspace_id = $1 AND rq2.workflow_id = $2
          AND g2.gate_name = $3 AND g2.status = 'rejected'
    ), '-infinity'::timestamptz),
    COALESCE((
        SELECT p.updated_at FROM raven_gate_policy p
        WHERE p.workflow_id = $2 AND p.gate_name = $3 AND p.mode = 'full'
    ), '-infinity'::timestamptz)
  );

-- name: ListRavenGateStreaks :many
-- Streak per workflow × gate for the whole workspace (stats endpoint).
SELECT rq.workflow_id, g.gate_name, count(*)::bigint AS streak
FROM raven_gate_review g
JOIN raven_requirement rq ON rq.id = g.requirement_id
WHERE g.workspace_id = $1 AND rq.workflow_id IS NOT NULL
  AND g.status = 'approved' AND g.decided_by IS NOT NULL
  AND g.decided_at > GREATEST(
    COALESCE((
        SELECT max(g2.decided_at) FROM raven_gate_review g2
        JOIN raven_requirement rq2 ON rq2.id = g2.requirement_id
        WHERE g2.workspace_id = $1 AND rq2.workflow_id = rq.workflow_id
          AND g2.gate_name = g.gate_name AND g2.status = 'rejected'
    ), '-infinity'::timestamptz),
    COALESCE((
        SELECT p.updated_at FROM raven_gate_policy p
        WHERE p.workflow_id = rq.workflow_id AND p.gate_name = g.gate_name AND p.mode = 'full'
    ), '-infinity'::timestamptz)
  )
GROUP BY rq.workflow_id, g.gate_name;

-- name: ListRavenGateStreakReviews :many
-- The most recent human-approved reviews of the current streak, newest
-- first — the evidence attached to a promotion letter.
SELECT g.* FROM raven_gate_review g
JOIN raven_requirement rq ON rq.id = g.requirement_id
WHERE g.workspace_id = $1 AND rq.workflow_id = $2 AND g.gate_name = $3
  AND g.status = 'approved' AND g.decided_by IS NOT NULL
ORDER BY g.decided_at DESC
LIMIT $4;

-- name: GetRavenGatePolicy :one
SELECT * FROM raven_gate_policy
WHERE workflow_id = $1 AND gate_name = $2 AND workspace_id = $3;

-- name: ListRavenGatePolicies :many
SELECT * FROM raven_gate_policy WHERE workspace_id = $1;

-- name: ListRavenGatePoliciesByWorkflow :many
SELECT * FROM raven_gate_policy
WHERE workflow_id = $1 AND workspace_id = $2
ORDER BY gate_name;

-- name: UpsertRavenGatePolicy :one
-- Approve → mode 'sampled'; revert (spot-check miss or manual revoke) →
-- mode 'full'. updated_at is the streak boundary after a revert.
INSERT INTO raven_gate_policy (workspace_id, workflow_id, gate_name, mode, approved_by)
VALUES ($1, $2, $3, $4, sqlc.narg('approved_by'))
ON CONFLICT (workflow_id, gate_name) DO UPDATE SET
    mode = EXCLUDED.mode,
    approved_by = COALESCE(EXCLUDED.approved_by, raven_gate_policy.approved_by),
    updated_at = now()
RETURNING *;

-- name: CreateRavenPromotion :one
-- No rows returned when a pending letter already exists (idempotent).
INSERT INTO raven_promotion (workspace_id, workflow_id, gate_name, evidence)
VALUES ($1, $2, $3, $4)
ON CONFLICT (workflow_id, gate_name) WHERE status = 'pending' DO NOTHING
RETURNING *;

-- name: GetRavenPromotion :one
SELECT * FROM raven_promotion WHERE id = $1 AND workspace_id = $2;

-- name: ListPendingRavenPromotions :many
SELECT * FROM raven_promotion
WHERE workspace_id = $1 AND status = 'pending'
ORDER BY created_at ASC;

-- name: DecideRavenPromotion :one
-- Only pending letters can be decided; deciding twice returns no rows.
UPDATE raven_promotion SET
    status = $3,
    decided_by = $4,
    decision_reason = $5,
    decided_at = now()
WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
RETURNING *;
