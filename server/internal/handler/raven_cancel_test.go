package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// cancelRaven POSTs /api/raven/requirements/{id}/cancel with an optional reason.
func cancelRaven(t *testing.T, reqID, reason string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	body := map[string]any{}
	if reason != "" {
		body["reason"] = reason
	}
	req := withURLParam(newRequest("POST", "/api/raven/requirements/"+reqID+"/cancel", body), "id", reqID)
	testHandler.CancelRavenRequirement(w, req)
	return w
}

// TestRavenCancelAbortsRequirement (issue #32): 中断创建 moves the requirement to
// the terminal cancelled state, terminates its in-progress run, cancels its
// pending gate + clarification (dropping them from the decision queue), projects
// the issue to cancelled, and clears the decision inbox items.
func TestRavenCancelAbortsRequirement(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, _ := gateFixture(t) // workflow-assigned → running, with a pending run

	// A pending gate + a pending clarification both awaiting a human.
	if w := openGate(t, requirement.ID, "human-review"); w.Code != http.StatusCreated {
		t.Fatalf("openGate: %d %s", w.Code, w.Body.String())
	}
	if w := openClarification(t, requirement.ID, testQuestions); w.Code != http.StatusCreated {
		t.Fatalf("openClarification: %d %s", w.Code, w.Body.String())
	}

	// Both sit in the pending decision queue before the abort.
	before := 0
	for _, dp := range listDecisionPoints(t) {
		if dp.RequirementID == requirement.ID {
			before++
		}
	}
	if before != 2 {
		t.Fatalf("want 2 pending decision points for the requirement, got %d", before)
	}

	// Abort.
	w := cancelRaven(t, requirement.ID, "需求本身搞错了")
	if w.Code != http.StatusOK {
		t.Fatalf("cancel: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp RavenRequirementResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.State != "cancelled" {
		t.Fatalf("state after cancel: want cancelled, got %s", resp.State)
	}
	if len(resp.NextStates) != 0 {
		t.Fatalf("cancelled must be terminal, got next states %v", resp.NextStates)
	}

	// Issue projected to cancelled.
	if got := issueStatus(t, requirement.IssueID); got != "cancelled" {
		t.Fatalf("issue status after cancel: want cancelled, got %s", got)
	}

	// The decision points left the pending queue.
	for _, dp := range listDecisionPoints(t) {
		if dp.RequirementID == requirement.ID {
			t.Fatalf("decision point %s/%s still pending after cancel", dp.Kind, dp.ID)
		}
	}

	// The in-progress run was terminated (the dispatch created one, pending).
	var terminated, total int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FILTER (WHERE status = 'terminated'), count(*) FROM raven_run WHERE requirement_id = $1`,
		requirement.ID).Scan(&terminated, &total); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	if total == 0 || terminated != total {
		t.Fatalf("runs after cancel: want all %d terminated, got %d terminated", total, terminated)
	}

	// Decision inbox items archived.
	var openInbox int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM inbox_item WHERE issue_id = $1 AND type IN ('raven_gate_pending','raven_clarify_pending') AND archived = false`,
		requirement.IssueID).Scan(&openInbox); err != nil {
		t.Fatalf("count inbox: %v", err)
	}
	if openInbox != 0 {
		t.Fatalf("decision inbox items after cancel: want 0 open, got %d", openInbox)
	}

	// Cancelled is terminal: a second cancel is an illegal transition → 409.
	if again := cancelRaven(t, requirement.ID, ""); again.Code != http.StatusConflict {
		t.Fatalf("double cancel: expected 409, got %d: %s", again.Code, again.Body.String())
	}
}

// TestRavenCancelRejectsDeliveredRequirement (issue #32): a merged requirement
// is already delivered and cannot be aborted.
func TestRavenCancelRejectsDeliveredRequirement(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	issueID := createTestIssue(t, "raven cancel delivered", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })

	created := createRavenRequirement(t, issueID)
	for _, to := range []string{"spec", "ready", "running", "needs_review", "merged"} {
		if w := transitionRaven(t, created.ID, to, ""); w.Code != http.StatusOK {
			t.Fatalf("advance to %s: %d %s", to, w.Code, w.Body.String())
		}
	}

	if w := cancelRaven(t, created.ID, "太晚了"); w.Code != http.StatusConflict {
		t.Fatalf("cancel of merged requirement: expected 409, got %d: %s", w.Code, w.Body.String())
	}
	// State untouched.
	getW := httptest.NewRecorder()
	testHandler.GetRavenRequirement(getW, withURLParam(newRequest("GET", "/api/raven/requirements/"+created.ID, nil), "id", created.ID))
	var reqNow RavenRequirementResponse
	json.NewDecoder(getW.Body).Decode(&reqNow)
	if reqNow.State != "merged" {
		t.Fatalf("state after rejected cancel: want merged, got %s", reqNow.State)
	}
}
