package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type recommendationEnvelope struct {
	Recommendation RavenRecommendationResponse `json:"recommendation"`
}

func createRavenWorkflowWithDescription(t *testing.T, name, description string) RavenWorkflowResponse {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/raven/workflows", map[string]any{
		"name":        name,
		"description": description,
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

func requestRecommendation(t *testing.T, body map[string]any) recommendationEnvelope {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.CreateRavenRecommendation(w, newRequest("POST", "/api/raven/recommendations", body))
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateRavenRecommendation: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var env recommendationEnvelope
	json.NewDecoder(w.Body).Decode(&env)
	t.Cleanup(func() {
		testPool.Exec(t.Context(), `DELETE FROM raven_workflow_recommendation WHERE id = $1`, env.Recommendation.ID)
	})
	return env
}

// TestRavenRecommendationMatch: an issue whose text overlaps a workflow's
// name+description gets that workflow recommended with a persisted row.
func TestRavenRecommendationMatch(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	wf := createRavenWorkflowWithDescription(t, "hotfix-pipeline",
		"urgent production hotfix delivery with fast review")
	createRavenWorkflowWithDescription(t, "docs-pipeline",
		"documentation writing translation glossary updates")

	env := requestRecommendation(t, map[string]any{
		"title":       "Fix urgent production outage",
		"description": "needs a hotfix delivery with fast review today",
	})
	rec := env.Recommendation
	if rec.WorkflowID == nil || *rec.WorkflowID != wf.ID {
		t.Fatalf("recommendation: want workflow %s, got %+v", wf.ID, rec)
	}
	if rec.WorkflowName != "hotfix-pipeline" {
		t.Fatalf("workflow_name: want hotfix-pipeline, got %q", rec.WorkflowName)
	}
	if rec.Score < 0.2 {
		t.Fatalf("score: want >= 0.2, got %f", rec.Score)
	}
	if rec.Outcome != "pending" {
		t.Fatalf("outcome: want pending, got %q", rec.Outcome)
	}

	// Row persisted.
	var count int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM raven_workflow_recommendation WHERE id = $1 AND workflow_id = $2`,
		rec.ID, wf.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("persisted row: count=%d err=%v", count, err)
	}
}

// TestRavenRecommendationNoMatch: non-overlapping text (or only disabled
// workflows) yields a NULL workflow_id — the UI's Squad-fallback signal.
func TestRavenRecommendationNoMatch(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	wf := createRavenWorkflowWithDescription(t, "reco-nomatch-wf",
		"kubernetes cluster upgrade automation")

	env := requestRecommendation(t, map[string]any{
		"title": "翻译产品文案并校对术语表",
	})
	if env.Recommendation.WorkflowID != nil {
		t.Fatalf("no-match: want null workflow_id, got %+v", env.Recommendation)
	}
	if env.Recommendation.Reason != "no confident match" {
		t.Fatalf("no-match reason: got %q", env.Recommendation.Reason)
	}

	// Disabled workflows are never recommended, even on perfect overlap.
	updW := httptest.NewRecorder()
	updReq := withURLParam(newRequest("PUT", "/api/raven/workflows/"+wf.ID, map[string]any{
		"enabled": false,
	}), "id", wf.ID)
	testHandler.UpdateRavenWorkflow(updW, updReq)
	if updW.Code != http.StatusOK {
		t.Fatalf("disable workflow: expected 200, got %d", updW.Code)
	}
	env2 := requestRecommendation(t, map[string]any{
		"title": "kubernetes cluster upgrade automation",
	})
	if env2.Recommendation.WorkflowID != nil {
		t.Fatalf("disabled workflow must not be recommended, got %+v", env2.Recommendation)
	}
}

// TestRavenRecommendationIssueIDAndOutcome: issue_id input path + the outcome
// PATCH persists the decision and decided_at.
func TestRavenRecommendationIssueIDAndOutcome(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	wf := createRavenWorkflowWithDescription(t, "refactor-pipeline",
		"large refactor migration staged rollout")
	issueID := createTestIssue(t, "staged rollout of the large refactor migration", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })

	env := requestRecommendation(t, map[string]any{"issue_id": issueID})
	rec := env.Recommendation
	if rec.WorkflowID == nil || *rec.WorkflowID != wf.ID {
		t.Fatalf("issue_id path: want workflow %s, got %+v", wf.ID, rec)
	}

	// Record the outcome.
	w := httptest.NewRecorder()
	req := withURLParam(newRequest("PATCH", "/api/raven/recommendations/"+rec.ID, map[string]any{
		"outcome": "accepted",
	}), "id", rec.ID)
	testHandler.UpdateRavenRecommendationOutcome(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("outcome patch: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var decided recommendationEnvelope
	json.NewDecoder(w.Body).Decode(&decided)
	if decided.Recommendation.Outcome != "accepted" {
		t.Fatalf("outcome: want accepted, got %q", decided.Recommendation.Outcome)
	}
	var decidedAtSet bool
	if err := testPool.QueryRow(t.Context(),
		`SELECT decided_at IS NOT NULL FROM raven_workflow_recommendation WHERE id = $1`,
		rec.ID).Scan(&decidedAtSet); err != nil || !decidedAtSet {
		t.Fatalf("decided_at: set=%v err=%v", decidedAtSet, err)
	}

	// Invalid outcome rejected.
	w2 := httptest.NewRecorder()
	req2 := withURLParam(newRequest("PATCH", "/api/raven/recommendations/"+rec.ID, map[string]any{
		"outcome": "auto_dispatched",
	}), "id", rec.ID)
	testHandler.UpdateRavenRecommendationOutcome(w2, req2)
	if w2.Code != http.StatusBadRequest {
		t.Fatalf("invalid outcome: expected 400, got %d", w2.Code)
	}
}
