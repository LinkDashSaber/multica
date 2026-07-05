package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Trust promotion tests (issue #25, ADR-0009): streak accumulation and
// reset, promotion letter issuance + idempotency, spot-check sampling with
// an injected random source, revert on rejection, manual revocation.

func decideGate(t *testing.T, gateID string, approve bool, reason string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.DecideRavenGate(w, withURLParam(newRequest("POST", "/api/raven/gates/"+gateID+"/decision", map[string]any{
		"approve": approve, "reason": reason,
	}), "id", gateID))
	return w
}

// openAndDecideGate opens a "human-review" gate and records a human verdict.
func openAndDecideGate(t *testing.T, requirementID string, approve bool, reason string) RavenGateReviewResponse {
	t.Helper()
	w := openGate(t, requirementID, "human-review")
	if w.Code != http.StatusCreated {
		t.Fatalf("open gate: %d %s", w.Code, w.Body.String())
	}
	var gate RavenGateReviewResponse
	json.NewDecoder(w.Body).Decode(&gate)
	if dw := decideGate(t, gate.ID, approve, reason); dw.Code != http.StatusOK {
		t.Fatalf("decide gate: %d %s", dw.Code, dw.Body.String())
	}
	return gate
}

func gatePolicies(t *testing.T, workflowID string) []RavenGatePolicyResponse {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.ListRavenWorkflowGatePolicies(w, withURLParam(newRequest("GET", "/api/raven/workflows/"+workflowID+"/gate-policies", nil), "id", workflowID))
	if w.Code != http.StatusOK {
		t.Fatalf("gate-policies: %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		Policies []RavenGatePolicyResponse `json:"policies"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	return resp.Policies
}

func humanReviewPolicy(t *testing.T, workflowID string) RavenGatePolicyResponse {
	t.Helper()
	for _, p := range gatePolicies(t, workflowID) {
		if p.GateName == "human-review" {
			return p
		}
	}
	t.Fatalf("human-review gate missing from policies")
	return RavenGatePolicyResponse{}
}

func pendingPromotionCount(t *testing.T, workflowID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM raven_promotion WHERE workflow_id = $1 AND status = 'pending'`,
		workflowID).Scan(&n); err != nil {
		t.Fatalf("count promotions: %v", err)
	}
	return n
}

// TestRavenTrustStreak: consecutive human approvals accumulate, a rejection
// resets to zero, the 8th consecutive approval issues exactly one promotion
// letter with 8 reviews as evidence, and further approvals do not re-issue.
func TestRavenTrustStreak(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, wf := gateFixture(t)

	// 3 approvals → streak 3, no letter yet.
	for range 3 {
		openAndDecideGate(t, requirement.ID, true, "")
	}
	if p := humanReviewPolicy(t, wf.ID); p.Streak != 3 || p.Mode != "full" {
		t.Fatalf("after 3 approvals: want streak 3 mode full, got %+v", p)
	}

	// A rejection clears the count.
	openAndDecideGate(t, requirement.ID, false, "missing tests")
	if p := humanReviewPolicy(t, wf.ID); p.Streak != 0 {
		t.Fatalf("after rejection: want streak 0, got %d", p.Streak)
	}

	// 8 consecutive approvals → exactly one pending promotion letter.
	for i := range 8 {
		openAndDecideGate(t, requirement.ID, true, "")
		if n := pendingPromotionCount(t, wf.ID); (i < 7 && n != 0) || (i == 7 && n != 1) {
			t.Fatalf("approval %d: pending promotions = %d", i+1, n)
		}
	}
	if p := humanReviewPolicy(t, wf.ID); p.Streak != 8 {
		t.Fatalf("after 8 approvals: want streak 8, got %d", p.Streak)
	}

	// Evidence carries the 8 review records.
	var evidence []byte
	if err := testPool.QueryRow(t.Context(),
		`SELECT evidence FROM raven_promotion WHERE workflow_id = $1 AND status = 'pending'`,
		wf.ID).Scan(&evidence); err != nil {
		t.Fatalf("load promotion: %v", err)
	}
	var reviews []RavenGateReviewResponse
	if err := json.Unmarshal(evidence, &reviews); err != nil || len(reviews) != 8 {
		t.Fatalf("promotion evidence: want 8 reviews, got %d (err %v)", len(reviews), err)
	}

	// Inbox letter for the reviewer.
	var inboxCount int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM inbox_item WHERE type = 'raven_promotion_pending' AND recipient_id = $1 AND details->>'workflow_id' = $2`,
		testUserID, wf.ID).Scan(&inboxCount); err != nil {
		t.Fatalf("count inbox: %v", err)
	}
	if inboxCount != 1 {
		t.Fatalf("promotion inbox: want 1, got %d", inboxCount)
	}

	// The unified queue shows the promotion decision point.
	dpW := httptest.NewRecorder()
	testHandler.ListRavenDecisionPoints(dpW, newRequest("GET", "/api/raven/decision-points?status=pending", nil))
	var dpResp struct {
		Items []RavenDecisionPointResponse `json:"items"`
	}
	json.NewDecoder(dpW.Body).Decode(&dpResp)
	foundPromotion := false
	for _, item := range dpResp.Items {
		if item.Kind == "promotion" && item.Title == "human-review" && item.ResponseKind == "approve_reject" {
			foundPromotion = true
		}
	}
	if !foundPromotion {
		t.Fatalf("decision points missing promotion kind: %+v", dpResp.Items)
	}

	// A 9th approval must not issue a second letter (idempotent).
	openAndDecideGate(t, requirement.ID, true, "")
	if n := pendingPromotionCount(t, wf.ID); n != 1 {
		t.Fatalf("after 9th approval: pending promotions = %d", n)
	}

	// Before approval the gate behaves unchanged: still opens as pending.
	w := openGate(t, requirement.ID, "human-review")
	var g RavenGateReviewResponse
	json.NewDecoder(w.Body).Decode(&g)
	if g.Status != "pending" || g.SampleResult != "" {
		t.Fatalf("gate before promotion approval: %+v", g)
	}

	// Stats expose the streak for the list page.
	statsW := httptest.NewRecorder()
	testHandler.ListRavenWorkflowStats(statsW, newRequest("GET", "/api/raven/workflows/stats", nil))
	var statsResp struct {
		Stats []RavenWorkflowStatsResponse `json:"stats"`
	}
	json.NewDecoder(statsW.Body).Decode(&statsResp)
	for _, s := range statsResp.Stats {
		if s.WorkflowID == wf.ID && (s.MaxGateStreak != 9 || s.PromotedGates != 0) {
			t.Fatalf("stats: want max_gate_streak 9 promoted 0, got %+v", s)
		}
	}
}

// TestRavenPromotionApprovalAndSampling: approving the letter downgrades the
// gate to 1/5 spot checks (deterministic injected sampler), a spot-check
// rejection reverts to full review, and manual revocation works.
func TestRavenPromotionApprovalAndSampling(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, wf := gateFixture(t)

	for range 8 {
		openAndDecideGate(t, requirement.ID, true, "")
	}
	var promotionID string
	if err := testPool.QueryRow(t.Context(),
		`SELECT id FROM raven_promotion WHERE workflow_id = $1 AND status = 'pending'`,
		wf.ID).Scan(&promotionID); err != nil {
		t.Fatalf("load promotion: %v", err)
	}

	// Agents cannot decide promotions.
	agentReq := withURLParam(newRequest("POST", "/api/raven/promotions/"+promotionID+"/decision", map[string]any{
		"approve": true,
	}), "id", promotionID)
	agentReq.Header.Set("X-Actor-Source", "task_token")
	agentReq.Header.Set("X-Agent-ID", "00000000-0000-0000-0000-000000000002")
	agentW := httptest.NewRecorder()
	testHandler.DecideRavenPromotion(agentW, agentReq)
	if agentW.Code != http.StatusForbidden {
		t.Fatalf("agent promotion decision: expected 403, got %d", agentW.Code)
	}

	// Approve → policy sampled.
	decW := httptest.NewRecorder()
	testHandler.DecideRavenPromotion(decW, withURLParam(newRequest("POST", "/api/raven/promotions/"+promotionID+"/decision", map[string]any{
		"approve": true,
	}), "id", promotionID))
	if decW.Code != http.StatusOK {
		t.Fatalf("approve promotion: %d %s", decW.Code, decW.Body.String())
	}
	var promo RavenPromotionResponse
	json.NewDecoder(decW.Body).Decode(&promo)
	if promo.Status != "approved" || promo.DecidedBy == nil {
		t.Fatalf("approved promotion incomplete: %+v", promo)
	}
	if p := humanReviewPolicy(t, wf.ID); p.Mode != "sampled" {
		t.Fatalf("policy after approval: want sampled, got %+v", p)
	}

	// Double decision → 409.
	againW := httptest.NewRecorder()
	testHandler.DecideRavenPromotion(againW, withURLParam(newRequest("POST", "/api/raven/promotions/"+promotionID+"/decision", map[string]any{
		"approve": false, "reason": "changed my mind",
	}), "id", promotionID))
	if againW.Code != http.StatusConflict {
		t.Fatalf("double promotion decision: expected 409, got %d", againW.Code)
	}

	// Stats now report the production line.
	statsW := httptest.NewRecorder()
	testHandler.ListRavenWorkflowStats(statsW, newRequest("GET", "/api/raven/workflows/stats", nil))
	var statsResp struct {
		Stats []RavenWorkflowStatsResponse `json:"stats"`
	}
	json.NewDecoder(statsW.Body).Decode(&statsResp)
	for _, s := range statsResp.Stats {
		if s.WorkflowID == wf.ID && s.PromotedGates != 1 {
			t.Fatalf("stats: want promoted_gates 1, got %+v", s)
		}
	}

	// Deterministic sampler: miss (non-zero) → auto-approved with a trace,
	// no inbox item, run not suspended.
	testHandler.RavenSampleIntN = func(n int) int { return 1 }
	t.Cleanup(func() { testHandler.RavenSampleIntN = nil })

	missW := openGate(t, requirement.ID, "human-review")
	if missW.Code != http.StatusCreated {
		t.Fatalf("sampled miss gate: %d %s", missW.Code, missW.Body.String())
	}
	var missGate RavenGateReviewResponse
	json.NewDecoder(missW.Body).Decode(&missGate)
	if missGate.Status != "approved" || missGate.SampleResult != "auto_approved" || missGate.DecidedBy != nil {
		t.Fatalf("auto-approved gate: %+v", missGate)
	}
	var missInbox int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM inbox_item WHERE type = 'raven_gate_pending' AND details->>'gate_id' = $1`,
		missGate.ID).Scan(&missInbox); err != nil {
		t.Fatalf("count inbox: %v", err)
	}
	if missInbox != 0 {
		t.Fatalf("auto-approved gate must not notify, got %d inbox items", missInbox)
	}

	// Hit (zero) → normal pending human review, marked 'selected'.
	testHandler.RavenSampleIntN = func(n int) int { return 0 }
	hitW := openGate(t, requirement.ID, "human-review")
	var hitGate RavenGateReviewResponse
	json.NewDecoder(hitW.Body).Decode(&hitGate)
	if hitGate.Status != "pending" || hitGate.SampleResult != "selected" {
		t.Fatalf("spot-check hit gate: %+v", hitGate)
	}

	// Spot-check rejection → immediate revert to full review, streak 0.
	if dw := decideGate(t, hitGate.ID, false, "spot check found a regression"); dw.Code != http.StatusOK {
		t.Fatalf("reject spot check: %d %s", dw.Code, dw.Body.String())
	}
	if p := humanReviewPolicy(t, wf.ID); p.Mode != "full" || p.Streak != 0 {
		t.Fatalf("policy after spot-check rejection: want full/0, got %+v", p)
	}

	// Gates open as pending again (back to full review).
	fullW := openGate(t, requirement.ID, "human-review")
	var fullGate RavenGateReviewResponse
	json.NewDecoder(fullW.Body).Decode(&fullGate)
	if fullGate.Status != "pending" || fullGate.SampleResult != "" {
		t.Fatalf("gate after revert: %+v", fullGate)
	}

	// Manual revocation: force the policy back to sampled, then revoke.
	if _, err := testPool.Exec(t.Context(),
		`UPDATE raven_gate_policy SET mode = 'sampled' WHERE workflow_id = $1 AND gate_name = 'human-review'`,
		wf.ID); err != nil {
		t.Fatalf("force sampled: %v", err)
	}
	revokeW := httptest.NewRecorder()
	testHandler.RevokeRavenGatePolicy(revokeW, withURLParams(
		newRequest("POST", "/api/raven/workflows/"+wf.ID+"/gate-policies/human-review/revoke", nil),
		"id", wf.ID, "gateName", "human-review"))
	if revokeW.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", revokeW.Code, revokeW.Body.String())
	}
	if p := humanReviewPolicy(t, wf.ID); p.Mode != "full" {
		t.Fatalf("policy after revoke: want full, got %+v", p)
	}
}
