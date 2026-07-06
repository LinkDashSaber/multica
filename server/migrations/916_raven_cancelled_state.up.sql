-- Raven requirement-level abort (issue #32, ADR-0011): 拍板信「中断创建」.
--
-- Adds the 10th, terminal lifecycle state `cancelled` (已中断) and lets a
-- requirement's decision points be cancelled out of the pending queue. These
-- CHECKs only guard vocabulary; the state machine itself lives in
-- server/internal/raven/lifecycle.go. The inline CHECKs were created unnamed,
-- so Postgres named them <table>_<column>_check — drop and re-add to widen.

ALTER TABLE raven_requirement DROP CONSTRAINT raven_requirement_state_check;
ALTER TABLE raven_requirement ADD CONSTRAINT raven_requirement_state_check CHECK (state IN (
    'idea', 'spec', 'ready', 'running',
    'needs_review', 'needs_human', 'merged', 'observed', 'learned', 'cancelled'
));

ALTER TABLE raven_clarification DROP CONSTRAINT raven_clarification_status_check;
ALTER TABLE raven_clarification ADD CONSTRAINT raven_clarification_status_check
    CHECK (status IN ('pending', 'answered', 'cancelled'));

ALTER TABLE raven_gate_review DROP CONSTRAINT raven_gate_review_status_check;
ALTER TABLE raven_gate_review ADD CONSTRAINT raven_gate_review_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'));
