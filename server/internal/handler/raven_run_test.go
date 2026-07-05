package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestRavenRunAndEvidenceFlow exercises run creation, SDK-style status/spend
// updates, evidence writes, and their query endpoints.
func TestRavenRunAndEvidenceFlow(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	issueID := createTestIssue(t, "raven run flow", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })
	requirement := createRavenRequirement(t, issueID)

	// Create a run.
	w := httptest.NewRecorder()
	req := withURLParam(newRequest("POST", "/api/raven/requirements/"+requirement.ID+"/runs", nil), "id", requirement.ID)
	testHandler.CreateRavenRun(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateRavenRun: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var run RavenRunResponse
	json.NewDecoder(w.Body).Decode(&run)
	if run.Status != "pending" {
		t.Fatalf("fresh run status: want pending, got %s", run.Status)
	}

	// SDK reports running, then terminated on budget with spend.
	patch := func(body map[string]any) RavenRunResponse {
		t.Helper()
		w := httptest.NewRecorder()
		req := withURLParam(newRequest("PATCH", "/api/raven/runs/"+run.ID, body), "id", run.ID)
		testHandler.UpdateRavenRun(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("UpdateRavenRun %v: expected 200, got %d: %s", body, w.Code, w.Body.String())
		}
		var resp RavenRunResponse
		json.NewDecoder(w.Body).Decode(&resp)
		return resp
	}
	if got := patch(map[string]any{"status": "running", "trigger_run_id": "run_test123"}); got.Status != "running" || got.TriggerRunID != "run_test123" {
		t.Fatalf("run after running patch: %+v", got)
	}
	got := patch(map[string]any{
		"status": "terminated", "termination_reason": "budget exceeded: 2000000 tokens",
		"tokens_spent": 2000001, "usd_spent": 12.5,
	})
	if got.Status != "terminated" || got.TerminationReason == "" || got.TokensSpent != 2000001 {
		t.Fatalf("run after termination patch: %+v", got)
	}

	// A later successful attempt must clear the failure residue: completed
	// runs never carry termination_reason from earlier failed attempts.
	if got := patch(map[string]any{"status": "completed"}); got.Status != "completed" || got.TerminationReason != "" {
		t.Fatalf("completed run must clear termination_reason: %+v", got)
	}

	// Unknown status rejected.
	wBad := httptest.NewRecorder()
	reqBad := withURLParam(newRequest("PATCH", "/api/raven/runs/"+run.ID, map[string]any{"status": "paused"}), "id", run.ID)
	testHandler.UpdateRavenRun(wBad, reqBad)
	if wBad.Code != http.StatusBadRequest {
		t.Fatalf("unknown run status: expected 400, got %d", wBad.Code)
	}

	// Evidence writes: one bound to the run, one requirement-level.
	postEvidence := func(body map[string]any) RavenEvidenceResponse {
		t.Helper()
		w := httptest.NewRecorder()
		testHandler.CreateRavenEvidence(w, newRequest("POST", "/api/raven/evidence", body))
		if w.Code != http.StatusCreated {
			t.Fatalf("CreateRavenEvidence %v: expected 201, got %d: %s", body, w.Code, w.Body.String())
		}
		var resp RavenEvidenceResponse
		json.NewDecoder(w.Body).Decode(&resp)
		return resp
	}
	postEvidence(map[string]any{
		"requirement_id": requirement.ID, "run_id": run.ID,
		"kind": "agent_output", "source": "agent()",
		"summary": "did the thing", "payload": map[string]any{"tokens": 123},
	})
	postEvidence(map[string]any{
		"requirement_id": requirement.ID,
		"kind":           "note", "source": "evidence()", "summary": "manual note",
	})

	// Kind required.
	wNoKind := httptest.NewRecorder()
	testHandler.CreateRavenEvidence(wNoKind, newRequest("POST", "/api/raven/evidence", map[string]any{
		"requirement_id": requirement.ID, "summary": "missing kind",
	}))
	if wNoKind.Code != http.StatusBadRequest {
		t.Fatalf("evidence without kind: expected 400, got %d", wNoKind.Code)
	}

	// Query back: evidence list oldest-first, runs list contains the run.
	wList := httptest.NewRecorder()
	testHandler.ListRavenEvidence(wList, withURLParam(newRequest("GET", "/api/raven/requirements/"+requirement.ID+"/evidence", nil), "id", requirement.ID))
	if wList.Code != http.StatusOK {
		t.Fatalf("ListRavenEvidence: expected 200, got %d: %s", wList.Code, wList.Body.String())
	}
	var evList struct {
		Evidence []RavenEvidenceResponse `json:"evidence"`
		Total    int                     `json:"total"`
	}
	json.NewDecoder(wList.Body).Decode(&evList)
	if evList.Total != 2 || evList.Evidence[0].Kind != "agent_output" || evList.Evidence[1].Kind != "note" {
		t.Fatalf("evidence list: %+v", evList)
	}
	if evList.Evidence[0].RunID == nil || *evList.Evidence[0].RunID != run.ID {
		t.Fatalf("evidence run binding: %+v", evList.Evidence[0])
	}

	wRuns := httptest.NewRecorder()
	testHandler.ListRavenRuns(wRuns, withURLParam(newRequest("GET", "/api/raven/requirements/"+requirement.ID+"/runs", nil), "id", requirement.ID))
	var runList struct {
		Runs  []RavenRunResponse `json:"runs"`
		Total int                `json:"total"`
	}
	json.NewDecoder(wRuns.Body).Decode(&runList)
	// The workflow-assign dispatch may have created a run too; ours must be present.
	found := false
	for _, item := range runList.Runs {
		if item.ID == run.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("run list missing created run: %+v", runList)
	}
}

// TestRavenRunStageEvents: SDK-style stage progress reporting — entered/exited
// events append to the stream and mirror onto the run's current_stage.
func TestRavenRunStageEvents(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	issueID := createTestIssue(t, "raven stage events", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })
	requirement := createRavenRequirement(t, issueID)

	w := httptest.NewRecorder()
	req := withURLParam(newRequest("POST", "/api/raven/requirements/"+requirement.ID+"/runs", nil), "id", requirement.ID)
	testHandler.CreateRavenRun(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateRavenRun: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var run RavenRunResponse
	json.NewDecoder(w.Body).Decode(&run)
	if run.CurrentStage != "" {
		t.Fatalf("fresh run current_stage: want empty, got %q", run.CurrentStage)
	}

	postEvent := func(body map[string]any) (int, RavenRunStageEventResponse) {
		t.Helper()
		w := httptest.NewRecorder()
		req := withURLParam(newRequest("POST", "/api/raven/runs/"+run.ID+"/stage-events", body), "id", run.ID)
		testHandler.CreateRavenRunStageEvent(w, req)
		var resp RavenRunStageEventResponse
		json.NewDecoder(w.Body).Decode(&resp)
		return w.Code, resp
	}
	currentStage := func() string {
		t.Helper()
		w := httptest.NewRecorder()
		testHandler.ListRavenRuns(w, withURLParam(newRequest("GET", "/api/raven/requirements/"+requirement.ID+"/runs", nil), "id", requirement.ID))
		var list struct {
			Runs []RavenRunResponse `json:"runs"`
		}
		json.NewDecoder(w.Body).Decode(&list)
		for _, item := range list.Runs {
			if item.ID == run.ID {
				return item.CurrentStage
			}
		}
		t.Fatalf("run %s missing from list", run.ID)
		return ""
	}

	// entered → current_stage mirrors the stage.
	if code, ev := postEvent(map[string]any{"stage": "clarify", "event": "entered"}); code != http.StatusCreated || ev.Stage != "clarify" || ev.Event != "entered" || ev.CreatedAt == "" {
		t.Fatalf("entered event: code=%d ev=%+v", code, ev)
	}
	if got := currentStage(); got != "clarify" {
		t.Fatalf("current_stage after entered: want clarify, got %q", got)
	}

	// exited the current stage → current_stage clears.
	if code, _ := postEvent(map[string]any{"stage": "clarify", "event": "exited"}); code != http.StatusCreated {
		t.Fatalf("exited event: code=%d", code)
	}
	if got := currentStage(); got != "" {
		t.Fatalf("current_stage after exited: want empty, got %q", got)
	}

	// next stage entered.
	postEvent(map[string]any{"stage": "plan", "event": "entered"})
	if got := currentStage(); got != "plan" {
		t.Fatalf("current_stage after second entered: want plan, got %q", got)
	}

	// Validation: unknown event type and missing stage are rejected.
	if code, _ := postEvent(map[string]any{"stage": "plan", "event": "paused"}); code != http.StatusBadRequest {
		t.Fatalf("unknown event type: expected 400, got %d", code)
	}
	if code, _ := postEvent(map[string]any{"event": "entered"}); code != http.StatusBadRequest {
		t.Fatalf("missing stage: expected 400, got %d", code)
	}

	// Unknown run → 404.
	wMissing := httptest.NewRecorder()
	missingID := "00000000-0000-0000-0000-000000000001"
	reqMissing := withURLParam(newRequest("POST", "/api/raven/runs/"+missingID+"/stage-events", map[string]any{"stage": "s", "event": "entered"}), "id", missingID)
	testHandler.CreateRavenRunStageEvent(wMissing, reqMissing)
	if wMissing.Code != http.StatusNotFound {
		t.Fatalf("stage event on unknown run: expected 404, got %d", wMissing.Code)
	}

	// Event stream reads back oldest-first with timestamps.
	wList := httptest.NewRecorder()
	testHandler.ListRavenRunStageEvents(wList, withURLParam(newRequest("GET", "/api/raven/runs/"+run.ID+"/stage-events", nil), "id", run.ID))
	if wList.Code != http.StatusOK {
		t.Fatalf("ListRavenRunStageEvents: expected 200, got %d: %s", wList.Code, wList.Body.String())
	}
	var events struct {
		Events []RavenRunStageEventResponse `json:"events"`
		Total  int                          `json:"total"`
	}
	json.NewDecoder(wList.Body).Decode(&events)
	if events.Total != 3 {
		t.Fatalf("event stream: %+v", events)
	}
	want := [][2]string{{"clarify", "entered"}, {"clarify", "exited"}, {"plan", "entered"}}
	for i, exp := range want {
		got := events.Events[i]
		if got.Stage != exp[0] || got.Event != exp[1] || got.CreatedAt == "" {
			t.Fatalf("event[%d]: want %v, got %+v", i, exp, got)
		}
	}
}

// TestRavenContractRetryDeclaration: retry/timeout parse from the contract
// declaration (the only place execution layers may read them from).
func TestRavenContractRetryDeclaration(t *testing.T) {
	contract := map[string]any{
		"stages": []map[string]any{{"name": "s"}},
		"gates":  []map[string]any{{"name": "g", "after_stage": "s"}},
		"budget": map[string]any{"max_tokens": 100},
		"retry":  map[string]any{"max_attempts": 3, "timeout_seconds": 600},
	}
	raw, _ := json.Marshal(contract)
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/raven/workflows", map[string]any{
		"name": "retry-declaration-wf", "contract": json.RawMessage(raw),
	})
	if testHandler == nil {
		t.Skip("database not available")
	}
	testHandler.CreateRavenWorkflow(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("workflow with retry declaration: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var wf RavenWorkflowResponse
	json.NewDecoder(w.Body).Decode(&wf)
	t.Cleanup(func() {
		testPool.Exec(t.Context(), `DELETE FROM raven_workflow WHERE id = $1`, wf.ID)
	})
}
