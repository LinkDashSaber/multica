package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// mergedFixture: workflow issue advanced running → needs_review → merged.
func mergedFixture(t *testing.T) RavenRequirementResponse {
	t.Helper()
	requirement, _ := gateFixture(t)
	for _, to := range []string{"needs_review", "merged"} {
		if w := transitionRaven(t, requirement.ID, to, ""); w.Code != http.StatusOK {
			t.Fatalf("advance to %s: %d %s", to, w.Code, w.Body.String())
		}
	}
	return requirement
}

func requirementState(t *testing.T, id string) string {
	t.Helper()
	var state string
	if err := testPool.QueryRow(t.Context(),
		`SELECT state FROM raven_requirement WHERE id = $1`, id).Scan(&state); err != nil {
		t.Fatalf("load state: %v", err)
	}
	return state
}

func countDeepDiveLearnings(t *testing.T, requirementID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM raven_learning l
		 JOIN raven_run r ON r.id = l.run_id
		 WHERE r.requirement_id = $1 AND l.stage = 'deep_dive'`, requirementID).Scan(&n); err != nil {
		t.Fatalf("count deep-dive learnings: %v", err)
	}
	return n
}

// TestRavenMergedSettlesToLearned: the settle sweeper walks a merged
// requirement Merged → Observed → Learned, leaves both transitions in the
// timeline, writes the zero-cost archive, and — with no strong signal —
// produces no deep-dive candidate. The observation window is respected.
func TestRavenMergedSettlesToLearned(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement := mergedFixture(t)
	svc := testHandler.ravenService()

	// Cutoff in the past: the freshly merged requirement is still inside its
	// observation window and must not settle.
	svc.SettleOverdueMerged(t.Context(), time.Now().Add(-time.Minute))
	if state := requirementState(t, requirement.ID); state != "merged" {
		t.Fatalf("state before window elapsed: want merged, got %s", state)
	}

	// Window elapsed → full Merged → Observed → Learned chain.
	svc.SettleOverdueMerged(t.Context(), time.Now())
	if state := requirementState(t, requirement.ID); state != "learned" {
		t.Fatalf("state after settle: want learned, got %s", state)
	}

	var hops int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM raven_requirement_transition
		 WHERE requirement_id = $1 AND to_state IN ('observed', 'learned') AND actor_type = 'system'`,
		requirement.ID).Scan(&hops); err != nil {
		t.Fatalf("count transitions: %v", err)
	}
	if hops != 2 {
		t.Fatalf("settle transitions: want 2, got %d", hops)
	}

	// Zero-cost archive captured trajectory features.
	var stageSeq string
	var keywords []string
	if err := testPool.QueryRow(t.Context(),
		`SELECT stage_sequence, keywords FROM raven_requirement_archive WHERE requirement_id = $1`,
		requirement.ID).Scan(&stageSeq, &keywords); err != nil {
		t.Fatalf("load archive: %v", err)
	}
	if stageSeq == "" || len(keywords) == 0 {
		t.Fatalf("archive incomplete: stage_sequence=%q keywords=%v", stageSeq, keywords)
	}

	// Clean trajectory: no gate rejects, no rework, no self-reports → no
	// deep-dive candidate.
	if n := countDeepDiveLearnings(t, requirement.ID); n != 0 {
		t.Fatalf("deep-dive candidates without signal: want 0, got %d", n)
	}

	// Isomorph count is queryable on the requirement detail.
	getW := httptest.NewRecorder()
	testHandler.GetRavenRequirement(getW, withURLParam(
		newRequest("GET", "/api/raven/requirements/"+requirement.ID, nil), "id", requirement.ID))
	var detail RavenRequirementResponse
	json.NewDecoder(getW.Body).Decode(&detail)
	if detail.IsomorphCount < 1 {
		t.Fatalf("isomorph_count: want >= 1 (self), got %d", detail.IsomorphCount)
	}
}

// TestRavenSettleSignalTriggersDeepDive: a trajectory with a gate rejection
// and a rework loop produces a fresh deep-dive learning candidate at settle
// time — the S8 pipeline entry point.
func TestRavenSettleSignalTriggersDeepDive(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, _ := gateFixture(t) // at running

	// Open a gate and reject it: strong signal #1.
	w := openGate(t, requirement.ID, "human-review")
	if w.Code != http.StatusCreated {
		t.Fatalf("open gate: %d %s", w.Code, w.Body.String())
	}
	var gate RavenGateReviewResponse
	json.NewDecoder(w.Body).Decode(&gate)
	rejW := httptest.NewRecorder()
	testHandler.DecideRavenGate(rejW, withURLParam(newRequest("POST", "/api/raven/gates/"+gate.ID+"/decision", map[string]any{
		"approve": false, "reason": "missing tests",
	}), "id", gate.ID))
	if rejW.Code != http.StatusOK {
		t.Fatalf("reject gate: %d %s", rejW.Code, rejW.Body.String())
	}

	// Rework loop back through running, then merge: strong signal #2.
	for _, to := range []string{"running", "needs_review", "merged"} {
		if w := transitionRaven(t, requirement.ID, to, ""); w.Code != http.StatusOK {
			t.Fatalf("advance to %s: %d %s", to, w.Code, w.Body.String())
		}
	}

	svc := testHandler.ravenService()
	svc.SettleOverdueMerged(t.Context(), time.Now())

	if state := requirementState(t, requirement.ID); state != "learned" {
		t.Fatalf("state after settle: want learned, got %s", state)
	}
	if n := countDeepDiveLearnings(t, requirement.ID); n != 1 {
		t.Fatalf("deep-dive candidates: want 1, got %d", n)
	}
	// Candidate is a fresh learning row with the archive's signal summary.
	var status, content string
	if err := testPool.QueryRow(t.Context(),
		`SELECT l.status, l.content FROM raven_learning l
		 JOIN raven_run r ON r.id = l.run_id
		 WHERE r.requirement_id = $1 AND l.stage = 'deep_dive'`, requirement.ID).Scan(&status, &content); err != nil {
		t.Fatalf("load deep-dive learning: %v", err)
	}
	if status != "fresh" || content == "" {
		t.Fatalf("deep-dive candidate malformed: status=%s content=%q", status, content)
	}

	// Archive recorded the signals.
	var rejects, rework int
	if err := testPool.QueryRow(t.Context(),
		`SELECT gate_reject_count, rework_count FROM raven_requirement_archive WHERE requirement_id = $1`,
		requirement.ID).Scan(&rejects, &rework); err != nil {
		t.Fatalf("load archive: %v", err)
	}
	if rejects != 1 || rework != 1 {
		t.Fatalf("archive signals: want 1 reject / 1 rework, got %d / %d", rejects, rework)
	}
}

// TestRavenManualDeepDive: POST /deep-dive forces a candidate regardless of
// trajectory signals — the user-driven 沉淀这条 trigger.
func TestRavenManualDeepDive(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement := mergedFixture(t)

	w := httptest.NewRecorder()
	testHandler.DeepDiveRavenRequirement(w, withURLParam(
		newRequest("POST", "/api/raven/requirements/"+requirement.ID+"/deep-dive", nil), "id", requirement.ID))
	if w.Code != http.StatusCreated {
		t.Fatalf("manual deep-dive: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var learning RavenLearningResponse
	json.NewDecoder(w.Body).Decode(&learning)
	if learning.Stage != "deep_dive" || learning.Status != "fresh" {
		t.Fatalf("manual candidate malformed: %+v", learning)
	}
	if n := countDeepDiveLearnings(t, requirement.ID); n != 1 {
		t.Fatalf("deep-dive candidates: want 1, got %d", n)
	}
}

// TestRavenCISignalSettles: a terminal CI conclusion arriving after merge is
// the delivery-verification signal — it settles the requirement immediately,
// without waiting for the observation window.
func TestRavenCISignalSettles(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement := mergedFixture(t)
	req, err := testHandler.Queries.GetRavenRequirement(t.Context(), db.GetRavenRequirementParams{
		ID: parseUUID(requirement.ID), WorkspaceID: parseUUID(testWorkspaceID),
	})
	if err != nil {
		t.Fatalf("load requirement: %v", err)
	}
	testHandler.ravenService().SettleToLearned(t.Context(), req, "CI success on PR #7 after merge")
	if state := requirementState(t, requirement.ID); state != "learned" {
		t.Fatalf("state after CI signal: want learned, got %s", state)
	}
	var reason string
	if err := testPool.QueryRow(t.Context(),
		`SELECT reason FROM raven_requirement_transition
		 WHERE requirement_id = $1 AND to_state = 'observed'`, requirement.ID).Scan(&reason); err != nil {
		t.Fatalf("load observed transition: %v", err)
	}
	if reason == "" {
		t.Fatal("observed transition must carry the verification reason")
	}
}
