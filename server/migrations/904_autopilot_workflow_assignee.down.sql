DELETE FROM autopilot WHERE assignee_type = 'workflow';
ALTER TABLE autopilot DROP CONSTRAINT IF EXISTS autopilot_assignee_type_check;
ALTER TABLE autopilot ADD CONSTRAINT autopilot_assignee_type_check
    CHECK (assignee_type IN ('agent', 'squad'));
