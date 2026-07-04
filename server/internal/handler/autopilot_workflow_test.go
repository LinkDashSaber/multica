package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func postAutopilot(t *testing.T, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.CreateAutopilot(w, newRequest("POST", "/api/autopilots?workspace_id="+testWorkspaceID, body))
	return w
}

// TestAutopilotWorkflowAssignee: autopilots accept an enabled workflow as
// assignee in create_issue mode, and reject run_only, disabled workflows,
// and unknown workflow ids.
func TestAutopilotWorkflowAssignee(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	wf := createRavenWorkflow(t, "autopilot-wf-"+t.Name())

	// run_only + workflow → 400: a workflow only acts on issue-backed requirements.
	if w := postAutopilot(t, map[string]any{
		"title": "ap run_only", "assignee_type": "workflow", "assignee_id": wf.ID,
		"execution_mode": "run_only",
	}); w.Code != http.StatusBadRequest {
		t.Fatalf("run_only workflow: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	// Unknown workflow id → 400.
	if w := postAutopilot(t, map[string]any{
		"title": "ap bad id", "assignee_type": "workflow",
		"assignee_id": "00000000-0000-0000-0000-000000000009", "execution_mode": "create_issue",
	}); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown workflow: expected 400, got %d: %s", w.Code, w.Body.String())
	}

	// Valid: enabled workflow + create_issue.
	w := postAutopilot(t, map[string]any{
		"title": "ap workflow ok", "assignee_type": "workflow", "assignee_id": wf.ID,
		"execution_mode": "create_issue",
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create workflow autopilot: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var ap AutopilotResponse
	json.NewDecoder(w.Body).Decode(&ap)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM autopilot_trigger WHERE autopilot_id = $1`, ap.ID)
		testPool.Exec(context.Background(), `DELETE FROM autopilot WHERE id = $1`, ap.ID)
	})
	if ap.AssigneeType != "workflow" || ap.AssigneeID != wf.ID {
		t.Fatalf("autopilot assignee: %s/%s", ap.AssigneeType, ap.AssigneeID)
	}

	// Flipping the saved autopilot to run_only → 400 (post-update combination).
	updW := httptest.NewRecorder()
	testHandler.UpdateAutopilot(updW, withURLParam(newRequest("PATCH", "/api/autopilots/"+ap.ID+"?workspace_id="+testWorkspaceID, map[string]any{
		"execution_mode": "run_only",
	}), "id", ap.ID))
	if updW.Code != http.StatusBadRequest {
		t.Fatalf("patch to run_only: expected 400, got %d: %s", updW.Code, updW.Body.String())
	}

	// Disabled workflow cannot be picked.
	if _, err := testPool.Exec(t.Context(), `UPDATE raven_workflow SET enabled = false WHERE id = $1`, wf.ID); err != nil {
		t.Fatalf("disable workflow: %v", err)
	}
	if w := postAutopilot(t, map[string]any{
		"title": "ap disabled wf", "assignee_type": "workflow", "assignee_id": wf.ID,
		"execution_mode": "create_issue",
	}); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("disabled workflow: expected 422, got %d: %s", w.Code, w.Body.String())
	}
}
