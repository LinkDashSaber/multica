package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func createTestRavenRun(t *testing.T, requirementID string) RavenRunResponse {
	t.Helper()
	w := httptest.NewRecorder()
	req := withURLParam(newRequest("POST", "/api/raven/requirements/"+requirementID+"/runs", nil), "id", requirementID)
	testHandler.CreateRavenRun(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateRavenRun: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var run RavenRunResponse
	json.NewDecoder(w.Body).Decode(&run)
	return run
}

func postLearning(t *testing.T, body map[string]any) (int, RavenLearningResponse) {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.CreateRavenLearning(w, newRequest("POST", "/api/raven/learnings", body))
	var resp RavenLearningResponse
	json.NewDecoder(w.Body).Decode(&resp)
	return w.Code, resp
}

func patchLearning(t *testing.T, id string, body map[string]any) (int, RavenLearningResponse) {
	t.Helper()
	w := httptest.NewRecorder()
	req := withURLParam(newRequest("PATCH", "/api/raven/learnings/"+id, body), "id", id)
	testHandler.UpdateRavenLearningStatus(w, req)
	var resp RavenLearningResponse
	json.NewDecoder(w.Body).Decode(&resp)
	return w.Code, resp
}

// TestRavenLearningWriteAndRead: ctx.learning()-style writes land with run +
// stage provenance and read back newest-first with the origin issue attached.
func TestRavenLearningWriteAndRead(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	issueID := createTestIssue(t, "raven learning flow", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })
	requirement := createRavenRequirement(t, issueID)
	run := createTestRavenRun(t, requirement.ID)

	// Move the run into a stage so the default-stage snapshot has a source.
	wEv := httptest.NewRecorder()
	reqEv := withURLParam(newRequest("POST", "/api/raven/runs/"+run.ID+"/stage-events",
		map[string]any{"stage": "execute", "event": "entered"}), "id", run.ID)
	testHandler.CreateRavenRunStageEvent(wEv, reqEv)
	if wEv.Code != http.StatusCreated {
		t.Fatalf("stage event: expected 201, got %d: %s", wEv.Code, wEv.Body.String())
	}

	// Explicit stage wins.
	code, explicit := postLearning(t, map[string]any{
		"run_id": run.ID, "stage": "plan", "content": "计划阶段应先读现有测试",
	})
	if code != http.StatusCreated || explicit.Stage != "plan" || explicit.Status != "fresh" || explicit.PromotedTo != "" {
		t.Fatalf("explicit-stage learning: code=%d resp=%+v", code, explicit)
	}

	// Omitted stage snapshots the run's current stage.
	code, defaulted := postLearning(t, map[string]any{
		"run_id": run.ID, "content": "self-check 前必须重跑 typecheck",
	})
	if code != http.StatusCreated || defaulted.Stage != "execute" {
		t.Fatalf("default-stage learning: code=%d resp=%+v", code, defaulted)
	}

	// Validation: content required, run must exist.
	if code, _ := postLearning(t, map[string]any{"run_id": run.ID}); code != http.StatusBadRequest {
		t.Fatalf("missing content: expected 400, got %d", code)
	}
	if code, _ := postLearning(t, map[string]any{
		"run_id": "00000000-0000-0000-0000-000000000001", "content": "x",
	}); code != http.StatusNotFound {
		t.Fatalf("unknown run: expected 404, got %d", code)
	}

	// List: newest first, run filter, issue provenance.
	wList := httptest.NewRecorder()
	testHandler.ListRavenLearnings(wList, newRequest("GET", "/api/raven/learnings?run_id="+run.ID, nil))
	if wList.Code != http.StatusOK {
		t.Fatalf("ListRavenLearnings: expected 200, got %d: %s", wList.Code, wList.Body.String())
	}
	var list struct {
		Learnings []RavenLearningResponse `json:"learnings"`
		Total     int                     `json:"total"`
	}
	json.NewDecoder(wList.Body).Decode(&list)
	if list.Total != 2 || list.Learnings[0].ID != defaulted.ID || list.Learnings[1].ID != explicit.ID {
		t.Fatalf("learning list order: %+v", list)
	}
	for _, l := range list.Learnings {
		if l.IssueID != issueID {
			t.Fatalf("learning issue provenance: want %s, got %+v", issueID, l)
		}
	}

	// Bad run filter rejected.
	wBad := httptest.NewRecorder()
	testHandler.ListRavenLearnings(wBad, newRequest("GET", "/api/raven/learnings?run_id=not-a-uuid", nil))
	if wBad.Code != http.StatusBadRequest {
		t.Fatalf("bad run filter: expected 400, got %d", wBad.Code)
	}
}

// TestRavenLearningTriage: fresh → promoted/expired transitions, destination
// validation, and one-shot triage (409 on re-triage).
func TestRavenLearningTriage(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	issueID := createTestIssue(t, "raven learning triage", "backlog", "medium")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })
	requirement := createRavenRequirement(t, issueID)
	run := createTestRavenRun(t, requirement.ID)

	newFresh := func(content string) RavenLearningResponse {
		t.Helper()
		code, l := postLearning(t, map[string]any{"run_id": run.ID, "stage": "s", "content": content})
		if code != http.StatusCreated {
			t.Fatalf("seed learning: expected 201, got %d", code)
		}
		return l
	}

	// Promote to each destination now produces a reusable asset (issue #28).
	for _, dest := range []string{"skill_proposal", "fact", "uptrack_evidence"} {
		l := newFresh("promote to " + dest + "\nsecond line detail")
		code, got := patchLearning(t, l.ID, map[string]any{"status": "promoted", "promoted_to": dest})
		if code != http.StatusOK || got.Status != "promoted" || got.PromotedTo != dest {
			t.Fatalf("promote to %s: code=%d resp=%+v", dest, code, got)
		}
		if got.Asset == nil || got.Asset.Kind != dest || got.Asset.ID == "" {
			t.Fatalf("promote to %s: expected produced asset, got %+v", dest, got.Asset)
		}
		// Title is the self-report's first line, not the raw multi-line string.
		if got.Asset.Title != "promote to "+dest {
			t.Fatalf("promote to %s: asset title = %q", dest, got.Asset.Title)
		}
		switch dest {
		case "skill_proposal":
			if got.Asset.SkillID == "" {
				t.Fatalf("skill_proposal: expected a minted skill draft, got %+v", got.Asset)
			}
			// The minted skill is a real, reusable skill carrying the self-report.
			skill, err := testHandler.Queries.GetSkillInWorkspace(context.Background(), db.GetSkillInWorkspaceParams{
				ID: parseUUID(got.Asset.SkillID), WorkspaceID: parseUUID(testWorkspaceID),
			})
			if err != nil || skill.Content != "promote to skill_proposal\nsecond line detail" {
				t.Fatalf("skill_proposal: minted skill missing/mismatched: err=%v skill=%+v", err, skill)
			}
		default:
			if got.Asset.SkillID != "" {
				t.Fatalf("%s: unexpected skill_id %q", dest, got.Asset.SkillID)
			}
		}
		// Re-triage is rejected and produces no second asset (idempotent).
		if code, _ := patchLearning(t, l.ID, map[string]any{"status": "expired"}); code != http.StatusConflict {
			t.Fatalf("re-triage promoted: expected 409, got %d", code)
		}
	}

	// The workspace stream surfaces each produced asset for link-back.
	wAssets := httptest.NewRecorder()
	testHandler.ListRavenLearnings(wAssets, newRequest("GET", "/api/raven/learnings?run_id="+run.ID, nil))
	var withAssets struct {
		Learnings []RavenLearningResponse `json:"learnings"`
	}
	json.NewDecoder(wAssets.Body).Decode(&withAssets)
	promotedWithAsset := 0
	for _, l := range withAssets.Learnings {
		if l.Status != "promoted" {
			continue
		}
		if l.Asset == nil || l.Asset.Kind != l.PromotedTo {
			t.Fatalf("promoted list row missing asset: %+v", l)
		}
		promotedWithAsset++
	}
	if promotedWithAsset != 3 {
		t.Fatalf("expected 3 promoted rows with assets, got %d", promotedWithAsset)
	}

	// Expire clears any destination and is also one-shot.
	l := newFresh("expire me")
	code, got := patchLearning(t, l.ID, map[string]any{"status": "expired", "promoted_to": "fact"})
	if code != http.StatusOK || got.Status != "expired" || got.PromotedTo != "" {
		t.Fatalf("expire: code=%d resp=%+v", code, got)
	}
	if code, _ := patchLearning(t, l.ID, map[string]any{"status": "promoted", "promoted_to": "fact"}); code != http.StatusConflict {
		t.Fatalf("re-triage expired: expected 409, got %d", code)
	}

	// Validation: unknown status, promote without destination, unknown id.
	fresh := newFresh("still fresh")
	if code, _ := patchLearning(t, fresh.ID, map[string]any{"status": "archived"}); code != http.StatusBadRequest {
		t.Fatalf("unknown status: expected 400, got %d", code)
	}
	if code, _ := patchLearning(t, fresh.ID, map[string]any{"status": "promoted"}); code != http.StatusBadRequest {
		t.Fatalf("promote without destination: expected 400, got %d", code)
	}
	if code, _ := patchLearning(t, fresh.ID, map[string]any{"status": "promoted", "promoted_to": "workflow"}); code != http.StatusBadRequest {
		t.Fatalf("unknown destination: expected 400, got %d", code)
	}
	missing := "00000000-0000-0000-0000-000000000002"
	if code, _ := patchLearning(t, missing, map[string]any{"status": "expired"}); code != http.StatusNotFound {
		t.Fatalf("unknown learning: expected 404, got %d", code)
	}
}
