package raven

import (
	"testing"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// TestBuildDispatchPayloadUsesSelectedAgent: a composition threads the chosen
// agent into the trigger.dev payload so the run dispatches to it instead of a
// global env agent (issue #26). AgentIDs[0] wins in both modes.
func TestBuildDispatchPayloadUsesSelectedAgent(t *testing.T) {
	requirement := db.RavenRequirement{}
	workflow := db.RavenWorkflow{Name: "workflow-authoring"}
	run := db.RavenRun{}

	comp := &WorkflowComposition{
		Mode:     "manual",
		AgentIDs: []string{"agent-primary", "agent-teammate"},
		SkillIDs: []string{"skill-1"},
	}
	payload := buildDispatchPayload(requirement, workflow, run, comp)

	if got := payload["agent_id"]; got != "agent-primary" {
		t.Fatalf("agent_id: want the first selected agent, got %v", got)
	}
	if payload["composition"] == nil {
		t.Fatal("composition must ride along in the payload")
	}
	if payload["workflow_name"] != "workflow-authoring" {
		t.Fatalf("workflow_name: got %v", payload["workflow_name"])
	}
}

// TestBuildDispatchPayloadNoComposition: a plain assignment (reassign /
// autopilot) carries no composition, so no agent_id is injected — the worker
// falls back to its own resolution for non-authoring workflows.
func TestBuildDispatchPayloadNoComposition(t *testing.T) {
	payload := buildDispatchPayload(db.RavenRequirement{}, db.RavenWorkflow{Name: "feature-delivery"}, db.RavenRun{}, nil)
	if _, ok := payload["agent_id"]; ok {
		t.Fatal("no composition must not inject an agent_id")
	}
	if _, ok := payload["composition"]; ok {
		t.Fatal("no composition must not inject a composition")
	}
}

// TestAuthoringAgentID: empty / nil compositions resolve to no agent.
func TestAuthoringAgentID(t *testing.T) {
	if (&WorkflowComposition{}).AuthoringAgentID() != "" {
		t.Fatal("empty agent list must resolve to no agent")
	}
	var nilComp *WorkflowComposition
	if nilComp.AuthoringAgentID() != "" {
		t.Fatal("nil composition must resolve to no agent")
	}
	if got := (&WorkflowComposition{AgentIDs: []string{"a", "b"}}).AuthoringAgentID(); got != "a" {
		t.Fatalf("want first agent, got %q", got)
	}
}
