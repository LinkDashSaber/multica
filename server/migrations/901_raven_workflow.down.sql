ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_assignee_type_check;
ALTER TABLE issue ADD CONSTRAINT issue_assignee_type_check
    CHECK (assignee_type IN ('member', 'agent', 'squad'));

ALTER TABLE raven_requirement DROP COLUMN IF EXISTS workflow_id;

DROP TABLE IF EXISTS raven_workflow;
