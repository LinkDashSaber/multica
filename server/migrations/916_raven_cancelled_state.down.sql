-- Revert issue #32: narrow the vocabulary CHECKs back to their pre-cancel sets.
-- Rows already carrying 'cancelled' must be resolved before this can apply.

ALTER TABLE raven_gate_review DROP CONSTRAINT raven_gate_review_status_check;
ALTER TABLE raven_gate_review ADD CONSTRAINT raven_gate_review_status_check
    CHECK (status IN ('pending', 'approved', 'rejected'));

ALTER TABLE raven_clarification DROP CONSTRAINT raven_clarification_status_check;
ALTER TABLE raven_clarification ADD CONSTRAINT raven_clarification_status_check
    CHECK (status IN ('pending', 'answered'));

ALTER TABLE raven_requirement DROP CONSTRAINT raven_requirement_state_check;
ALTER TABLE raven_requirement ADD CONSTRAINT raven_requirement_state_check CHECK (state IN (
    'idea', 'spec', 'ready', 'running',
    'needs_review', 'needs_human', 'merged', 'observed', 'learned'
));
