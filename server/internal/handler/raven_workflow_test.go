package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

var validContract = map[string]any{
	"stages": []map[string]any{
		{"name": "clarify"}, {"name": "implement"}, {"name": "self-check"},
	},
	"gates": []map[string]any{
		{"name": "human-review", "after_stage": "self-check"},
	},
	"budget": map[string]any{"max_tokens": 1_000_000},
}

func createRavenWorkflow(t *testing.T, name string) RavenWorkflowResponse {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/raven/workflows", map[string]any{
		"name":        name,
		"description": "test workflow",
		"contract":    validContract,
	})
	testHandler.CreateRavenWorkflow(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateRavenWorkflow: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var resp RavenWorkflowResponse
	json.NewDecoder(w.Body).Decode(&resp)
	t.Cleanup(func() {
		testPool.Exec(t.Context(), `DELETE FROM raven_workflow WHERE id = $1`, resp.ID)
	})
	return resp
}

// TestRavenWorkflowContractValidation: stages/gates/budget are mandatory and
// malformed contracts are rejected at the door.
func TestRavenWorkflowContractValidation(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	post := func(contract map[string]any) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/raven/workflows", map[string]any{
			"name": "invalid-contract-wf", "contract": contract,
		})
		testHandler.CreateRavenWorkflow(w, req)
		return w
	}

	cases := []struct {
		name     string
		contract map[string]any
	}{
		{"no stages", map[string]any{
			"gates":  []map[string]any{{"name": "g", "after_stage": "x"}},
			"budget": map[string]any{"max_tokens": 1},
		}},
		{"no gates", map[string]any{
			"stages": []map[string]any{{"name": "s"}},
			"budget": map[string]any{"max_tokens": 1},
		}},
		{"no budget", map[string]any{
			"stages": []map[string]any{{"name": "s"}},
			"gates":  []map[string]any{{"name": "g", "after_stage": "s"}},
		}},
		{"gate references unknown stage", map[string]any{
			"stages": []map[string]any{{"name": "s"}},
			"gates":  []map[string]any{{"name": "g", "after_stage": "nope"}},
			"budget": map[string]any{"max_usd": 5},
		}},
		{"zero budget", map[string]any{
			"stages": []map[string]any{{"name": "s"}},
			"gates":  []map[string]any{{"name": "g", "after_stage": "s"}},
			"budget": map[string]any{},
		}},
	}
	for _, tc := range cases {
		if w := post(tc.contract); w.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d: %s", tc.name, w.Code, w.Body.String())
		}
	}

	// Valid contract registers, duplicate name conflicts.
	wf := createRavenWorkflow(t, "contract-validation-ok")
	if wf.Version != 1 || !wf.Enabled {
		t.Fatalf("fresh workflow: want version 1 enabled, got %+v", wf)
	}
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/raven/workflows", map[string]any{
		"name": "contract-validation-ok", "contract": validContract,
	})
	testHandler.CreateRavenWorkflow(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate name: expected 409, got %d: %s", w.Code, w.Body.String())
	}
}

// TestRavenWorkflowAssignOptIn: assigning an issue to a workflow creates the
// lifecycle record in Idea bound to that workflow; bare assignment doesn't.
func TestRavenWorkflowAssignOptIn(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	wf := createRavenWorkflow(t, "assign-opt-in-wf")

	// Reassignment path: existing bare issue → assign to workflow.
	issueID := createTestIssue(t, "raven assign opt-in", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })

	w := httptest.NewRecorder()
	req := withURLParam(newRequest("PUT", "/api/issues/"+issueID, map[string]any{
		"assignee_type": "workflow",
		"assignee_id":   wf.ID,
	}), "id", issueID)
	testHandler.UpdateIssue(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("assign to workflow: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	getW := httptest.NewRecorder()
	getReq := withURLParam(newRequest("GET", "/api/raven/issues/"+issueID+"/requirement", nil), "issueId", issueID)
	testHandler.GetRavenRequirementForIssue(getW, getReq)
	if getW.Code != http.StatusOK {
		t.Fatalf("requirement after workflow assign: expected 200, got %d: %s", getW.Code, getW.Body.String())
	}
	var requirement RavenRequirementResponse
	json.NewDecoder(getW.Body).Decode(&requirement)
	if requirement.State != "idea" {
		t.Fatalf("requirement state: want idea, got %s", requirement.State)
	}
	if requirement.WorkflowID == nil || *requirement.WorkflowID != wf.ID {
		t.Fatalf("requirement workflow binding: want %s, got %v", wf.ID, requirement.WorkflowID)
	}

	// Creation path: issue born assigned to the workflow.
	w2 := httptest.NewRecorder()
	req2 := newRequest("POST", "/api/issues", map[string]any{
		"title":         "raven born on workflow",
		"status":        "backlog",
		"priority":      "medium",
		"assignee_type": "workflow",
		"assignee_id":   wf.ID,
	})
	testHandler.CreateIssue(w2, req2)
	if w2.Code != http.StatusCreated {
		t.Fatalf("create issue with workflow assignee: expected 201, got %d: %s", w2.Code, w2.Body.String())
	}
	var born IssueResponse
	json.NewDecoder(w2.Body).Decode(&born)
	t.Cleanup(func() { deleteTestIssue(t, born.ID) })

	getW2 := httptest.NewRecorder()
	getReq2 := withURLParam(newRequest("GET", "/api/raven/issues/"+born.ID+"/requirement", nil), "issueId", born.ID)
	testHandler.GetRavenRequirementForIssue(getW2, getReq2)
	if getW2.Code != http.StatusOK {
		t.Fatalf("requirement for born-on-workflow issue: expected 200, got %d: %s", getW2.Code, getW2.Body.String())
	}
}

// TestRavenWorkflowBareAssignNoLifecycle: assigning to a member or agent
// never creates Raven records (ADR-0006 boundary).
func TestRavenWorkflowBareAssignNoLifecycle(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	issueID := createTestIssue(t, "raven bare assign boundary", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })

	w := httptest.NewRecorder()
	req := withURLParam(newRequest("PUT", "/api/issues/"+issueID, map[string]any{
		"assignee_type": "member",
		"assignee_id":   testUserID,
	}), "id", issueID)
	testHandler.UpdateIssue(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("assign to member: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var count int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM raven_requirement WHERE issue_id = $1`, issueID).Scan(&count); err != nil {
		t.Fatalf("count requirements: %v", err)
	}
	if count != 0 {
		t.Fatalf("bare member assignment must not create lifecycle records, got %d", count)
	}
}

// TestRavenWorkflowAssignValidation: unknown and disabled workflows are not
// assignable.
func TestRavenWorkflowAssignValidation(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	issueID := createTestIssue(t, "raven assign validation", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })

	// Unknown workflow id.
	w := httptest.NewRecorder()
	req := withURLParam(newRequest("PUT", "/api/issues/"+issueID, map[string]any{
		"assignee_type": "workflow",
		"assignee_id":   "00000000-0000-0000-0000-000000000001",
	}), "id", issueID)
	testHandler.UpdateIssue(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("assign to unknown workflow: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	// Disabled workflow.
	wf := createRavenWorkflow(t, "assign-validation-disabled")
	updW := httptest.NewRecorder()
	updReq := withURLParam(newRequest("PUT", "/api/raven/workflows/"+wf.ID, map[string]any{
		"enabled": false,
	}), "id", wf.ID)
	testHandler.UpdateRavenWorkflow(updW, updReq)
	if updW.Code != http.StatusOK {
		t.Fatalf("disable workflow: expected 200, got %d: %s", updW.Code, updW.Body.String())
	}

	w2 := httptest.NewRecorder()
	req2 := withURLParam(newRequest("PUT", "/api/issues/"+issueID, map[string]any{
		"assignee_type": "workflow",
		"assignee_id":   wf.ID,
	}), "id", issueID)
	testHandler.UpdateIssue(w2, req2)
	if w2.Code != http.StatusBadRequest {
		t.Fatalf("assign to disabled workflow: expected 400, got %d: %s", w2.Code, w2.Body.String())
	}
}
