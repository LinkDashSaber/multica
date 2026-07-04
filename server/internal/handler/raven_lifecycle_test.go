package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/raven"
)

// createRavenRequirement opts an issue into the lifecycle and returns the
// requirement response.
func createRavenRequirement(t *testing.T, issueID string) RavenRequirementResponse {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/raven/requirements", map[string]any{"issue_id": issueID})
	testHandler.CreateRavenRequirement(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateRavenRequirement: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var resp RavenRequirementResponse
	json.NewDecoder(w.Body).Decode(&resp)
	return resp
}

func transitionRaven(t *testing.T, reqID, toState, reason string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/raven/requirements/"+reqID+"/transition", map[string]any{
		"to_state": toState,
		"reason":   reason,
	})
	req = withURLParam(req, "id", reqID)
	testHandler.TransitionRavenRequirement(w, req)
	return w
}

func issueStatus(t *testing.T, issueID string) string {
	t.Helper()
	var status string
	if err := testPool.QueryRow(context.Background(),
		`SELECT status FROM issue WHERE id = $1`, issueID).Scan(&status); err != nil {
		t.Fatalf("read issue status: %v", err)
	}
	return status
}

// TestRavenLifecycleHappyPath walks the full v1 active path Idea → Merged and
// asserts the one-way board projection at each step.
func TestRavenLifecycleHappyPath(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	issueID := createTestIssue(t, "raven lifecycle happy path", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })

	created := createRavenRequirement(t, issueID)
	if created.State != "idea" {
		t.Fatalf("initial state: want idea, got %s", created.State)
	}
	if got := issueStatus(t, issueID); got != "backlog" {
		t.Fatalf("projection after create: want backlog, got %s", got)
	}

	steps := []struct {
		to         string
		wantStatus string
	}{
		{"spec", "todo"},
		{"ready", "todo"},
		{"running", "in_progress"},
		{"needs_review", "in_review"},
		{"merged", "done"},
	}
	for _, step := range steps {
		w := transitionRaven(t, created.ID, step.to, "")
		if w.Code != http.StatusOK {
			t.Fatalf("transition to %s: expected 200, got %d: %s", step.to, w.Code, w.Body.String())
		}
		var resp RavenRequirementResponse
		json.NewDecoder(w.Body).Decode(&resp)
		if resp.State != step.to {
			t.Fatalf("transition to %s: state in response is %s", step.to, resp.State)
		}
		if got := issueStatus(t, issueID); got != step.wantStatus {
			t.Fatalf("projection at %s: want %s, got %s", step.to, step.wantStatus, got)
		}
	}

	// History: creation event + five transitions, oldest first.
	w := httptest.NewRecorder()
	req := withURLParam(newRequest("GET", "/api/raven/requirements/"+created.ID+"/transitions", nil), "id", created.ID)
	testHandler.ListRavenTransitions(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ListRavenTransitions: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var hist struct {
		Transitions []RavenTransitionResponse `json:"transitions"`
		Total       int                       `json:"total"`
	}
	json.NewDecoder(w.Body).Decode(&hist)
	if hist.Total != 6 {
		t.Fatalf("transition history: want 6 entries, got %d", hist.Total)
	}
	if hist.Transitions[0].FromState != "" || hist.Transitions[0].ToState != "idea" {
		t.Fatalf("first history entry should be creation, got %+v", hist.Transitions[0])
	}
	if last := hist.Transitions[5]; last.FromState != "needs_review" || last.ToState != "merged" {
		t.Fatalf("last history entry: want needs_review→merged, got %+v", last)
	}
}

// TestRavenLifecycleIllegalTransitions verifies rejects with 409 and that
// state and projection stay untouched.
func TestRavenLifecycleIllegalTransitions(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	issueID := createTestIssue(t, "raven illegal transitions", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })
	created := createRavenRequirement(t, issueID)

	for _, illegal := range []string{"running", "merged", "learned", "needs_review"} {
		w := transitionRaven(t, created.ID, illegal, "")
		if w.Code != http.StatusConflict {
			t.Fatalf("idea → %s: expected 409, got %d: %s", illegal, w.Code, w.Body.String())
		}
	}

	// Unknown vocabulary → 400, not 409.
	w := transitionRaven(t, created.ID, "half-done", "")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown state: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	// Still in idea, projection untouched.
	getW := httptest.NewRecorder()
	getReq := withURLParam(newRequest("GET", "/api/raven/requirements/"+created.ID, nil), "id", created.ID)
	testHandler.GetRavenRequirement(getW, getReq)
	var resp RavenRequirementResponse
	json.NewDecoder(getW.Body).Decode(&resp)
	if resp.State != "idea" {
		t.Fatalf("state after rejected transitions: want idea, got %s", resp.State)
	}
	if got := issueStatus(t, issueID); got != "backlog" {
		t.Fatalf("projection after rejected transitions: want backlog, got %s", got)
	}
}

// TestRavenLifecycleGateRejectLoop exercises the needs_review → running
// rework loop and the needs_human escape hatch.
func TestRavenLifecycleGateRejectLoop(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	issueID := createTestIssue(t, "raven gate reject loop", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })
	created := createRavenRequirement(t, issueID)

	for _, to := range []string{"spec", "ready", "running", "needs_review"} {
		if w := transitionRaven(t, created.ID, to, ""); w.Code != http.StatusOK {
			t.Fatalf("advance to %s: got %d: %s", to, w.Code, w.Body.String())
		}
	}

	// Gate rejection loops back into the same run.
	if w := transitionRaven(t, created.ID, "running", "tests failed"); w.Code != http.StatusOK {
		t.Fatalf("needs_review → running: got %d: %s", w.Code, w.Body.String())
	}
	// Run gets stuck on a human question.
	if w := transitionRaven(t, created.ID, "needs_human", "which auth provider?"); w.Code != http.StatusOK {
		t.Fatalf("running → needs_human: got %d: %s", w.Code, w.Body.String())
	}
	if got := issueStatus(t, issueID); got != "blocked" {
		t.Fatalf("projection at needs_human: want blocked, got %s", got)
	}
	// Human answers, run resumes, gate passes.
	for _, to := range []string{"running", "needs_review", "merged"} {
		if w := transitionRaven(t, created.ID, to, ""); w.Code != http.StatusOK {
			t.Fatalf("resume to %s: got %d: %s", to, w.Code, w.Body.String())
		}
	}
	if got := issueStatus(t, issueID); got != "done" {
		t.Fatalf("projection at merged: want done, got %s", got)
	}
}

// TestRavenLifecycleOptInBoundary: bare issues never grow lifecycle records,
// and the by-issue lookup 404s for them (ADR-0006).
func TestRavenLifecycleOptInBoundary(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	issueID := createTestIssue(t, "raven opt-in boundary", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })

	w := httptest.NewRecorder()
	req := withURLParam(newRequest("GET", "/api/raven/issues/"+issueID+"/requirement", nil), "issueId", issueID)
	testHandler.GetRavenRequirementForIssue(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("bare issue requirement lookup: expected 404, got %d: %s", w.Code, w.Body.String())
	}

	var count int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM raven_requirement WHERE issue_id = $1`, issueID).Scan(&count); err != nil {
		t.Fatalf("count requirements: %v", err)
	}
	if count != 0 {
		t.Fatalf("bare issue must have zero lifecycle records, got %d", count)
	}
}

// TestRavenRequirementCreateDuplicate: one requirement per issue.
func TestRavenRequirementCreateDuplicate(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	issueID := createTestIssue(t, "raven duplicate requirement", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })
	createRavenRequirement(t, issueID)

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/raven/requirements", map[string]any{"issue_id": issueID})
	testHandler.CreateRavenRequirement(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate requirement: expected 409, got %d: %s", w.Code, w.Body.String())
	}
}

// TestRavenStateMachineTable sanity-checks the pure transition table so a
// future edit can't silently open an illegal shortcut.
func TestRavenStateMachineTable(t *testing.T) {
	if raven.CanTransition(raven.StateIdea, raven.StateMerged) {
		t.Fatal("idea → merged must be illegal")
	}
	if !raven.CanTransition(raven.StateNeedsReview, raven.StateRunning) {
		t.Fatal("needs_review → running (gate reject) must be legal")
	}
	if raven.CanTransition(raven.StateLearned, raven.StateIdea) {
		t.Fatal("learned is terminal")
	}
	if raven.IssueStatusFor(raven.StateNeedsReview) != "in_review" {
		t.Fatal("needs_review must project to in_review")
	}
}
