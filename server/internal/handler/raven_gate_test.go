package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// gateFixture: workflow-assigned issue advanced to running, ready to gate.
func gateFixture(t *testing.T) (requirement RavenRequirementResponse, wf RavenWorkflowResponse) {
	t.Helper()
	wf = createRavenWorkflow(t, "gate-test-wf-"+t.Name())
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues", map[string]any{
		"title": "gate test " + t.Name(), "status": "backlog", "priority": "medium",
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
	json.NewDecoder(getW.Body).Decode(&requirement)

	for _, to := range []string{"spec", "ready", "running"} {
		if w := transitionRaven(t, requirement.ID, to, ""); w.Code != http.StatusOK {
			t.Fatalf("advance to %s: %d %s", to, w.Code, w.Body.String())
		}
	}
	return requirement, wf
}

func openGate(t *testing.T, requirementID, gateName string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.CreateRavenGate(w, newRequest("POST", "/api/raven/gates", map[string]any{
		"requirement_id": requirementID,
		"gate_name":      gateName,
		"review_package": map[string]any{"summary": "all tests green", "diff": "+42 -7"},
	}))
	return w
}

// TestRavenGateFlow: open → lifecycle needs_review + inbox item → decide.
func TestRavenGateFlow(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, _ := gateFixture(t)

	w := openGate(t, requirement.ID, "human-review")
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateRavenGate: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var gate RavenGateReviewResponse
	json.NewDecoder(w.Body).Decode(&gate)
	if gate.Status != "pending" {
		t.Fatalf("fresh gate status: %s", gate.Status)
	}

	// Lifecycle moved to needs_review.
	getW := httptest.NewRecorder()
	testHandler.GetRavenRequirement(getW, withURLParam(newRequest("GET", "/api/raven/requirements/"+requirement.ID, nil), "id", requirement.ID))
	var reqNow RavenRequirementResponse
	json.NewDecoder(getW.Body).Decode(&reqNow)
	if reqNow.State != "needs_review" {
		t.Fatalf("state after gate open: want needs_review, got %s", reqNow.State)
	}

	// Inbox notification for the issue creator.
	var inboxCount int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM inbox_item WHERE type = 'raven_gate_pending' AND recipient_id = $1 AND details->>'gate_id' = $2`,
		testUserID, gate.ID).Scan(&inboxCount); err != nil {
		t.Fatalf("count inbox: %v", err)
	}
	if inboxCount != 1 {
		t.Fatalf("gate inbox notification: want 1, got %d", inboxCount)
	}

	// Pending queue contains it.
	listW := httptest.NewRecorder()
	testHandler.ListRavenGates(listW, newRequest("GET", "/api/raven/gates", nil))
	var listResp struct {
		Gates []RavenGateReviewResponse `json:"gates"`
	}
	json.NewDecoder(listW.Body).Decode(&listResp)
	found := false
	for _, g := range listResp.Gates {
		if g.ID == gate.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("pending gate queue missing gate")
	}

	// Approve.
	decW := httptest.NewRecorder()
	testHandler.DecideRavenGate(decW, withURLParam(newRequest("POST", "/api/raven/gates/"+gate.ID+"/decision", map[string]any{
		"approve": true,
	}), "id", gate.ID))
	if decW.Code != http.StatusOK {
		t.Fatalf("approve: expected 200, got %d: %s", decW.Code, decW.Body.String())
	}
	var decided RavenGateReviewResponse
	json.NewDecoder(decW.Body).Decode(&decided)
	if decided.Status != "approved" || decided.DecidedBy == nil || *decided.DecidedBy != testUserID || decided.DecidedAt == nil {
		t.Fatalf("approved gate record incomplete: %+v", decided)
	}

	// Second decision → 409.
	againW := httptest.NewRecorder()
	testHandler.DecideRavenGate(againW, withURLParam(newRequest("POST", "/api/raven/gates/"+gate.ID+"/decision", map[string]any{
		"approve": false, "reason": "changed my mind",
	}), "id", gate.ID))
	if againW.Code != http.StatusConflict {
		t.Fatalf("double decision: expected 409, got %d: %s", againW.Code, againW.Body.String())
	}
}

// TestRavenGateRejectRules: rejection requires a reason; verdict persisted;
// agents cannot decide; undeclared gates cannot open.
func TestRavenGateRejectRules(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, _ := gateFixture(t)

	// Undeclared gate name → 400.
	if w := openGate(t, requirement.ID, "not-in-contract"); w.Code != http.StatusBadRequest {
		t.Fatalf("undeclared gate: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	w := openGate(t, requirement.ID, "human-review")
	if w.Code != http.StatusCreated {
		t.Fatalf("open gate: %d %s", w.Code, w.Body.String())
	}
	var gate RavenGateReviewResponse
	json.NewDecoder(w.Body).Decode(&gate)

	// Reject without reason → 400.
	noReasonW := httptest.NewRecorder()
	testHandler.DecideRavenGate(noReasonW, withURLParam(newRequest("POST", "/api/raven/gates/"+gate.ID+"/decision", map[string]any{
		"approve": false,
	}), "id", gate.ID))
	if noReasonW.Code != http.StatusBadRequest {
		t.Fatalf("reject without reason: expected 400, got %d", noReasonW.Code)
	}

	// Agent caller → 403.
	agentReq := withURLParam(newRequest("POST", "/api/raven/gates/"+gate.ID+"/decision", map[string]any{
		"approve": true,
	}), "id", gate.ID)
	agentReq.Header.Set("X-Actor-Source", "task_token")
	agentReq.Header.Set("X-Agent-ID", "00000000-0000-0000-0000-000000000002")
	agentW := httptest.NewRecorder()
	testHandler.DecideRavenGate(agentW, agentReq)
	if agentW.Code != http.StatusForbidden {
		t.Fatalf("agent decision: expected 403, got %d", agentW.Code)
	}

	// Reject with reason persists everything.
	rejW := httptest.NewRecorder()
	testHandler.DecideRavenGate(rejW, withURLParam(newRequest("POST", "/api/raven/gates/"+gate.ID+"/decision", map[string]any{
		"approve": false, "reason": "tests are missing for the error path",
	}), "id", gate.ID))
	if rejW.Code != http.StatusOK {
		t.Fatalf("reject: expected 200, got %d: %s", rejW.Code, rejW.Body.String())
	}
	var rejected RavenGateReviewResponse
	json.NewDecoder(rejW.Body).Decode(&rejected)
	if rejected.Status != "rejected" || rejected.DecisionReason == "" || rejected.DecidedBy == nil {
		t.Fatalf("rejected gate record incomplete: %+v", rejected)
	}
}
