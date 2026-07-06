package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/raven"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Merged-registration hook tests (issue #24 / ADR-0010): a requirement that
// recorded a workflow contract draft as evidence gets the workflow
// registered (or updated, idempotently) when it reaches Merged. The trigger
// is the evidence record, not the bound workflow — so the built-in
// authoring strategy and uptrack draft requirements converge on one path.

// authoredContract is a draft distinct from validContract so tests can tell
// registered-from-draft apart from fixture workflows.
func authoredContract(maxTokens int) map[string]any {
	return map[string]any{
		"stages": []map[string]any{
			{"name": "clarify", "description": "澄清需求类型与阶段划分"},
			{"name": "build", "description": "执行交付"},
		},
		"gates":  []map[string]any{{"name": "spec-confirm", "after_stage": "clarify"}},
		"budget": map[string]any{"max_tokens": maxTokens},
	}
}

// recordContractDraft writes the draft evidence the authoring workflow's
// draft stage would record.
func recordContractDraft(t *testing.T, requirement RavenRequirementResponse, name, description string, contract map[string]any) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"name":        name,
		"description": description,
		"contract":    contract,
	})
	if err != nil {
		t.Fatalf("marshal draft payload: %v", err)
	}
	if _, err := testHandler.Queries.CreateRavenEvidence(t.Context(), db.CreateRavenEvidenceParams{
		WorkspaceID:   parseUUID(requirement.WorkspaceID),
		RequirementID: parseUUID(requirement.ID),
		Kind:          raven.EvidenceKindContractDraft,
		Source:        "evidence()",
		Summary:       "workflow 合同草稿",
		Payload:       payload,
	}); err != nil {
		t.Fatalf("create draft evidence: %v", err)
	}
}

// mergeRequirement drives running → needs_review → merged via the public
// transition API — the same choke point the GitHub webhook uses.
func mergeRequirement(t *testing.T, reqID string) {
	t.Helper()
	for _, to := range []string{"needs_review", "merged"} {
		if w := transitionRaven(t, reqID, to, "test merge"); w.Code != http.StatusOK {
			t.Fatalf("advance to %s: %d %s", to, w.Code, w.Body.String())
		}
	}
}

// requirementOnWorkflow opts one more issue into the Raven track on an
// existing workflow and advances it to running (gateFixture creates the
// workflow itself, whose name is unique per test).
func requirementOnWorkflow(t *testing.T, wf RavenWorkflowResponse, title string) RavenRequirementResponse {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues", map[string]any{
		"title": title, "status": "backlog", "priority": "medium",
		"assignee_type": "workflow", "assignee_id": wf.ID,
	})
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create issue: %d %s", w.Code, w.Body.String())
	}
	var issue IssueResponse
	json.NewDecoder(w.Body).Decode(&issue)
	t.Cleanup(func() { deleteTestIssue(t, issue.ID) })

	getW := httptest.NewRecorder()
	testHandler.GetRavenRequirementForIssue(getW, withURLParam(newRequest("GET", "/api/raven/issues/"+issue.ID+"/requirement", nil), "issueId", issue.ID))
	var requirement RavenRequirementResponse
	json.NewDecoder(getW.Body).Decode(&requirement)

	for _, to := range []string{"spec", "ready", "running"} {
		if w := transitionRaven(t, requirement.ID, to, ""); w.Code != http.StatusOK {
			t.Fatalf("advance to %s: %d %s", to, w.Code, w.Body.String())
		}
	}
	return requirement
}

func loadWorkflowByName(t *testing.T, wsID, name string) (db.RavenWorkflow, bool) {
	t.Helper()
	wf, err := testHandler.Queries.GetRavenWorkflowByName(t.Context(), db.GetRavenWorkflowByNameParams{
		WorkspaceID: parseUUID(wsID), Name: name,
	})
	if err != nil {
		return db.RavenWorkflow{}, false
	}
	return wf, true
}

// TestCreateStrategyPersistsComposition (issue #26): creating an issue
// assigned to a workflow with a raven_composition records the chosen
// agent/skill composition as evidence, so dispatch and the clarify letter can
// read who runs the strategy.
func TestCreateStrategyPersistsComposition(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	wf := createRavenWorkflow(t, "compose-wf-"+t.Name())

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues", map[string]any{
		"title": "compose strategy " + t.Name(), "status": "backlog", "priority": "medium",
		"assignee_type": "workflow", "assignee_id": wf.ID,
		"raven_composition": map[string]any{
			"mode":      "manual",
			"agent_ids": []string{"11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"},
			"skill_ids": []string{"33333333-3333-3333-3333-333333333333"},
		},
	})
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create issue: %d %s", w.Code, w.Body.String())
	}
	var issue IssueResponse
	json.NewDecoder(w.Body).Decode(&issue)
	t.Cleanup(func() { deleteTestIssue(t, issue.ID) })

	getW := httptest.NewRecorder()
	testHandler.GetRavenRequirementForIssue(getW, withURLParam(newRequest("GET", "/api/raven/issues/"+issue.ID+"/requirement", nil), "issueId", issue.ID))
	var requirement RavenRequirementResponse
	json.NewDecoder(getW.Body).Decode(&requirement)

	evidence, err := testHandler.Queries.ListRavenEvidenceByRequirement(t.Context(), db.ListRavenEvidenceByRequirementParams{
		RequirementID: parseUUID(requirement.ID), WorkspaceID: parseUUID(requirement.WorkspaceID),
	})
	if err != nil {
		t.Fatalf("list evidence: %v", err)
	}
	var found *raven.WorkflowComposition
	for _, e := range evidence {
		if e.Kind != raven.EvidenceKindComposition {
			continue
		}
		var comp raven.WorkflowComposition
		if err := json.Unmarshal(e.Payload, &comp); err != nil {
			t.Fatalf("unmarshal composition evidence: %v", err)
		}
		found = &comp
	}
	if found == nil {
		t.Fatal("workflow_composition evidence was not recorded")
	}
	if found.Mode != "manual" {
		t.Fatalf("mode: got %q", found.Mode)
	}
	if len(found.AgentIDs) != 2 || found.AgentIDs[0] != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("agent_ids not persisted: %+v", found.AgentIDs)
	}
	if len(found.SkillIDs) != 1 {
		t.Fatalf("skill_ids not persisted: %+v", found.SkillIDs)
	}
}

// TestCreateIssueWithoutCompositionRecordsNone: a plain workflow assignment (no
// raven_composition) records no composition evidence — the field is opt-in.
func TestCreateIssueWithoutCompositionRecordsNone(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	wf := createRavenWorkflow(t, "nocompose-wf-"+t.Name())

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues", map[string]any{
		"title": "plain workflow " + t.Name(), "status": "backlog", "priority": "medium",
		"assignee_type": "workflow", "assignee_id": wf.ID,
	})
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create issue: %d %s", w.Code, w.Body.String())
	}
	var issue IssueResponse
	json.NewDecoder(w.Body).Decode(&issue)
	t.Cleanup(func() { deleteTestIssue(t, issue.ID) })

	getW := httptest.NewRecorder()
	testHandler.GetRavenRequirementForIssue(getW, withURLParam(newRequest("GET", "/api/raven/issues/"+issue.ID+"/requirement", nil), "issueId", issue.ID))
	var requirement RavenRequirementResponse
	json.NewDecoder(getW.Body).Decode(&requirement)

	evidence, err := testHandler.Queries.ListRavenEvidenceByRequirement(t.Context(), db.ListRavenEvidenceByRequirementParams{
		RequirementID: parseUUID(requirement.ID), WorkspaceID: parseUUID(requirement.WorkspaceID),
	})
	if err != nil {
		t.Fatalf("list evidence: %v", err)
	}
	for _, e := range evidence {
		if e.Kind == raven.EvidenceKindComposition {
			t.Fatal("composition evidence recorded without a raven_composition")
		}
	}
}

// TestRavenMergedRegistersAuthoredWorkflow: authoring requirement with a
// contract draft reaches Merged → the workflow appears in the registry.
func TestRavenMergedRegistersAuthoredWorkflow(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, _ := gateFixture(t) // at running, bound to a workflow
	draftName := "authored-" + t.Name()
	t.Cleanup(func() {
		testPool.Exec(t.Context(), `DELETE FROM raven_workflow WHERE workspace_id = $1 AND name = $2`,
			requirement.WorkspaceID, draftName)
	})

	recordContractDraft(t, requirement, draftName, "澄清 → 交付的定制策略", authoredContract(2_000_000))
	mergeRequirement(t, requirement.ID)

	wf, ok := loadWorkflowByName(t, requirement.WorkspaceID, draftName)
	if !ok {
		t.Fatalf("workflow %q not registered after Merged", draftName)
	}
	if wf.Version != 1 {
		t.Fatalf("fresh registration version: want 1, got %d", wf.Version)
	}
	if wf.Description != "澄清 → 交付的定制策略" {
		t.Fatalf("description: got %q", wf.Description)
	}
	contract, err := raven.ParseContract(wf.Contract)
	if err != nil {
		t.Fatalf("registered contract invalid: %v", err)
	}
	if len(contract.Stages) != 2 || contract.Gates[0].Name != "spec-confirm" {
		t.Fatalf("registered contract mismatch: %+v", contract)
	}
}

// TestRavenMergedRegistrationIdempotent: a second requirement merging the
// same draft name updates the existing row — never a duplicate. An
// identical draft is a no-op (version untouched); a changed draft bumps the
// version and rewrites contract/description.
func TestRavenMergedRegistrationIdempotent(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	draftName := "authored-" + t.Name()

	first, fixtureWf := gateFixture(t)
	t.Cleanup(func() {
		testPool.Exec(t.Context(), `DELETE FROM raven_workflow WHERE workspace_id = $1 AND name = $2`,
			first.WorkspaceID, draftName)
	})
	recordContractDraft(t, first, draftName, "v1 描述", authoredContract(2_000_000))
	mergeRequirement(t, first.ID)

	// Identical draft merged again (re-entry) → no version bump.
	second := requirementOnWorkflow(t, fixtureWf, "idempotent re-entry "+t.Name())
	recordContractDraft(t, second, draftName, "v1 描述", authoredContract(2_000_000))
	mergeRequirement(t, second.ID)

	wf, ok := loadWorkflowByName(t, first.WorkspaceID, draftName)
	if !ok {
		t.Fatal("workflow missing after first registration")
	}
	if wf.Version != 1 {
		t.Fatalf("identical re-registration must not bump version: got %d", wf.Version)
	}

	// Changed draft (uptrack-style improvement) → update in place.
	third := requirementOnWorkflow(t, fixtureWf, "uptrack update "+t.Name())
	recordContractDraft(t, third, draftName, "v2 描述", authoredContract(4_000_000))
	mergeRequirement(t, third.ID)

	updated, ok := loadWorkflowByName(t, first.WorkspaceID, draftName)
	if !ok {
		t.Fatal("workflow missing after update")
	}
	if updated.ID != wf.ID {
		t.Fatal("update created a new row instead of updating the existing one")
	}
	if updated.Version != 2 {
		t.Fatalf("changed draft must bump version: want 2, got %d", updated.Version)
	}
	if updated.Description != "v2 描述" {
		t.Fatalf("description not updated: got %q", updated.Description)
	}

	var count int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM raven_workflow WHERE workspace_id = $1 AND name = $2`,
		first.WorkspaceID, draftName).Scan(&count); err != nil {
		t.Fatalf("count workflows: %v", err)
	}
	if count != 1 {
		t.Fatalf("same name must stay one row: got %d", count)
	}
}

// TestRavenMergedWithoutDraftRegistersNothing: a plain delivery requirement
// (no contract-draft evidence) merging must not touch the registry, and a
// malformed draft is skipped rather than registered.
func TestRavenMergedWithoutDraftRegistersNothing(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, fixtureWf2 := gateFixture(t)
	var before int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM raven_workflow WHERE workspace_id = $1`,
		requirement.WorkspaceID).Scan(&before); err != nil {
		t.Fatalf("count workflows: %v", err)
	}

	mergeRequirement(t, requirement.ID)

	var after int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM raven_workflow WHERE workspace_id = $1`,
		requirement.WorkspaceID).Scan(&after); err != nil {
		t.Fatalf("count workflows: %v", err)
	}
	if after != before {
		t.Fatalf("no-draft merge changed the registry: %d → %d", before, after)
	}

	// Invalid contract draft → skipped, never registered.
	bad := requirementOnWorkflow(t, fixtureWf2, "bad draft "+t.Name())
	badName := "authored-bad-" + t.Name()
	recordContractDraft(t, bad, badName, "无门禁的非法合同", map[string]any{
		"stages": []map[string]any{{"name": "only"}},
		"gates":  []map[string]any{},
		"budget": map[string]any{"max_tokens": 1},
	})
	mergeRequirement(t, bad.ID)
	if _, ok := loadWorkflowByName(t, bad.WorkspaceID, badName); ok {
		t.Fatal("invalid draft contract must not be registered")
	}
}
