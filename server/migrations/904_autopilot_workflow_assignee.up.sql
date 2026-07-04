-- Allow autopilot rules to assign created issues to a Raven workflow,
-- mirroring how 096 widened the same CHECK for squads.
ALTER TABLE autopilot DROP CONSTRAINT IF EXISTS autopilot_assignee_type_check;
ALTER TABLE autopilot ADD CONSTRAINT autopilot_assignee_type_check
    CHECK (assignee_type IN ('agent', 'squad', 'workflow'));
