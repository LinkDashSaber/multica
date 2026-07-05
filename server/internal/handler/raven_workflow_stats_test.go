package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestRavenWorkflowStatsAndRuns: run/gate aggregates per workflow and the
// workflow run history endpoint with nested gate decisions.
func TestRavenWorkflowStatsAndRuns(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, wf := gateFixture(t)

	// One run, driven to a terminal state.
	runW := httptest.NewRecorder()
	testHandler.CreateRavenRun(runW, withURLParam(newRequest("POST", "/api/raven/requirements/"+requirement.ID+"/runs", nil), "id", requirement.ID))
	if runW.Code != http.StatusCreated {
		t.Fatalf("CreateRavenRun: expected 201, got %d: %s", runW.Code, runW.Body.String())
	}
	var run RavenRunResponse
	json.NewDecoder(runW.Body).Decode(&run)

	patchW := httptest.NewRecorder()
	testHandler.UpdateRavenRun(patchW, withURLParam(newRequest("PATCH", "/api/raven/runs/"+run.ID, map[string]any{
		"status": "completed",
	}), "id", run.ID))
	if patchW.Code != http.StatusOK {
		t.Fatalf("complete run: expected 200, got %d: %s", patchW.Code, patchW.Body.String())
	}

	// Two gates on that run: one approved, one rejected.
	openGateOnRun := func() RavenGateReviewResponse {
		t.Helper()
		w := httptest.NewRecorder()
		testHandler.CreateRavenGate(w, newRequest("POST", "/api/raven/gates", map[string]any{
			"requirement_id": requirement.ID,
			"run_id":         run.ID,
			"gate_name":      "human-review",
			"review_package": map[string]any{"summary": "stats test"},
		}))
		if w.Code != http.StatusCreated {
			t.Fatalf("open gate: expected 201, got %d: %s", w.Code, w.Body.String())
		}
		var gate RavenGateReviewResponse
		json.NewDecoder(w.Body).Decode(&gate)
		return gate
	}
	decide := func(gateID string, approve bool, reason string) {
		t.Helper()
		w := httptest.NewRecorder()
		testHandler.DecideRavenGate(w, withURLParam(newRequest("POST", "/api/raven/gates/"+gateID+"/decision", map[string]any{
			"approve": approve, "reason": reason,
		}), "id", gateID))
		if w.Code != http.StatusOK {
			t.Fatalf("decide gate: expected 200, got %d: %s", w.Code, w.Body.String())
		}
	}
	g1 := openGateOnRun()
	decide(g1.ID, true, "")
	g2 := openGateOnRun()
	decide(g2.ID, false, "not good enough")

	// Stats endpoint aggregates the run and both decided gates.
	statsW := httptest.NewRecorder()
	testHandler.ListRavenWorkflowStats(statsW, newRequest("GET", "/api/raven/workflows/stats", nil))
	if statsW.Code != http.StatusOK {
		t.Fatalf("ListRavenWorkflowStats: expected 200, got %d: %s", statsW.Code, statsW.Body.String())
	}
	var statsResp struct {
		Stats []RavenWorkflowStatsResponse `json:"stats"`
	}
	json.NewDecoder(statsW.Body).Decode(&statsResp)
	var stats *RavenWorkflowStatsResponse
	for i := range statsResp.Stats {
		if statsResp.Stats[i].WorkflowID == wf.ID {
			stats = &statsResp.Stats[i]
		}
	}
	if stats == nil {
		t.Fatalf("stats missing workflow %s", wf.ID)
	}
	// gateFixture's ready→running transition auto-dispatches one pending run,
	// plus the explicit run above.
	if stats.RunCount != 2 {
		t.Fatalf("run_count: want 2, got %d", stats.RunCount)
	}
	// The auto-dispatched run stays pending; the explicit run completed.
	if stats.ActiveRuns != 1 {
		t.Fatalf("active_runs: want 1, got %d", stats.ActiveRuns)
	}
	if stats.ApprovedGates != 1 || stats.RejectedGates != 1 {
		t.Fatalf("gate counts: want 1/1, got %d/%d", stats.ApprovedGates, stats.RejectedGates)
	}
	if stats.AvgRunSeconds < 0 {
		t.Fatalf("avg_run_seconds negative: %f", stats.AvgRunSeconds)
	}

	// Run history endpoint: the run with issue link and its two gates.
	runsW := httptest.NewRecorder()
	testHandler.ListRavenWorkflowRuns(runsW, withURLParam(newRequest("GET", "/api/raven/workflows/"+wf.ID+"/runs", nil), "id", wf.ID))
	if runsW.Code != http.StatusOK {
		t.Fatalf("ListRavenWorkflowRuns: expected 200, got %d: %s", runsW.Code, runsW.Body.String())
	}
	var runsResp struct {
		Runs  []RavenWorkflowRunResponse `json:"runs"`
		Total int                        `json:"total"`
	}
	json.NewDecoder(runsW.Body).Decode(&runsResp)
	if runsResp.Total != 2 || len(runsResp.Runs) != 2 {
		t.Fatalf("runs: want 2 (auto-dispatched + explicit), got %d", runsResp.Total)
	}
	var got *RavenWorkflowRunResponse
	for i := range runsResp.Runs {
		if runsResp.Runs[i].ID == run.ID {
			got = &runsResp.Runs[i]
		}
	}
	if got == nil || got.Status != "completed" {
		t.Fatalf("explicit run missing from history: %+v", runsResp.Runs)
	}
	if got.IssueID == "" {
		t.Fatalf("run row missing issue_id")
	}
	if len(got.Gates) != 2 {
		t.Fatalf("run gates: want 2, got %d", len(got.Gates))
	}

	// Unknown workflow id → empty list, not an error.
	emptyW := httptest.NewRecorder()
	testHandler.ListRavenWorkflowRuns(emptyW, withURLParam(newRequest("GET", "/api/raven/workflows/00000000-0000-0000-0000-000000000001/runs", nil), "id", "00000000-0000-0000-0000-000000000001"))
	if emptyW.Code != http.StatusOK {
		t.Fatalf("empty runs: expected 200, got %d: %s", emptyW.Code, emptyW.Body.String())
	}
}
