package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func openClarification(t *testing.T, requirementID string, questions any) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.CreateRavenClarification(w, newRequest("POST", "/api/raven/clarifications", map[string]any{
		"requirement_id": requirementID,
		"stage":          "clarify",
		"questions":      questions,
	}))
	return w
}

var testQuestions = []map[string]any{
	{"question": "用哪个鉴权方案？", "options": []string{"JWT", "session"}, "recommended": "JWT"},
	{"question": "要不要兼容旧客户端？", "recommended": "不要"},
}

func listDecisionPoints(t *testing.T) []RavenDecisionPointResponse {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.ListRavenDecisionPoints(w, newRequest("GET", "/api/raven/decision-points?status=pending", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("ListRavenDecisionPoints: %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		Items []RavenDecisionPointResponse `json:"items"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	return resp.Items
}

// TestRavenClarificationFlow: open → inbox item → unified pending queue with
// node position + context + response form → answer → 409 on double answer.
func TestRavenClarificationFlow(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, _ := gateFixture(t)

	w := openClarification(t, requirement.ID, testQuestions)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateRavenClarification: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var c RavenClarificationResponse
	json.NewDecoder(w.Body).Decode(&c)
	if c.Status != "pending" || c.Stage != "clarify" {
		t.Fatalf("fresh clarification: %+v", c)
	}

	// Inbox notification for the issue creator.
	var inboxCount int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM inbox_item WHERE type = 'raven_clarify_pending' AND recipient_id = $1 AND details->>'clarification_id' = $2`,
		testUserID, c.ID).Scan(&inboxCount); err != nil {
		t.Fatalf("count inbox: %v", err)
	}
	if inboxCount != 1 {
		t.Fatalf("clarify inbox notification: want 1, got %d", inboxCount)
	}

	// A pending gate too, so the queue mixes both kinds.
	gw := openGate(t, requirement.ID, "human-review")
	if gw.Code != http.StatusCreated {
		t.Fatalf("open gate: %d %s", gw.Code, gw.Body.String())
	}
	var gate RavenGateReviewResponse
	json.NewDecoder(gw.Body).Decode(&gate)

	// The unified queue carries both, each with the three essentials.
	var clarifyItem, gateItem *RavenDecisionPointResponse
	items := listDecisionPoints(t)
	for i := range items {
		switch items[i].ID {
		case c.ID:
			clarifyItem = &items[i]
		case gate.ID:
			gateItem = &items[i]
		}
	}
	if clarifyItem == nil || gateItem == nil {
		t.Fatalf("decision points missing clarify or gate entry")
	}
	if clarifyItem.Kind != "clarify" || clarifyItem.Stage != "clarify" || clarifyItem.ResponseKind != "answer" {
		t.Fatalf("clarify item essentials: %+v", clarifyItem)
	}
	var clarifyContext struct {
		Questions []struct {
			Question    string `json:"question"`
			Recommended string `json:"recommended"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(clarifyItem.Context, &clarifyContext); err != nil || len(clarifyContext.Questions) != 2 {
		t.Fatalf("clarify item context: %s (%v)", string(clarifyItem.Context), err)
	}
	if clarifyContext.Questions[0].Recommended != "JWT" {
		t.Fatalf("clarify context lost recommended answer: %+v", clarifyContext)
	}
	// Gate item: node position resolved from the contract's after_stage.
	if gateItem.Kind != "gate" || gateItem.Stage != "self-check" || gateItem.Title != "human-review" || gateItem.ResponseKind != "approve_reject" {
		t.Fatalf("gate item essentials: %+v", gateItem)
	}

	// Answer.
	ansW := httptest.NewRecorder()
	testHandler.AnswerRavenClarification(ansW, withURLParam(newRequest("POST", "/api/raven/clarifications/"+c.ID+"/answer", map[string]any{
		"answer": "JWT；不兼容旧客户端",
	}), "id", c.ID))
	if ansW.Code != http.StatusOK {
		t.Fatalf("answer: expected 200, got %d: %s", ansW.Code, ansW.Body.String())
	}
	var answered RavenClarificationResponse
	json.NewDecoder(ansW.Body).Decode(&answered)
	if answered.Status != "answered" || answered.Answer == "" || answered.AnsweredBy == nil || *answered.AnsweredBy != testUserID || answered.AnsweredAt == nil {
		t.Fatalf("answered record incomplete: %+v", answered)
	}

	// SDK poll surface: GET reflects the answer.
	getW := httptest.NewRecorder()
	testHandler.GetRavenClarification(getW, withURLParam(newRequest("GET", "/api/raven/clarifications/"+c.ID, nil), "id", c.ID))
	var got RavenClarificationResponse
	json.NewDecoder(getW.Body).Decode(&got)
	if got.Status != "answered" || got.Answer != "JWT；不兼容旧客户端" {
		t.Fatalf("get after answer: %+v", got)
	}

	// Answered clarifications leave the pending queue.
	for _, item := range listDecisionPoints(t) {
		if item.ID == c.ID {
			t.Fatalf("answered clarification still in pending queue")
		}
	}

	// Second answer → 409.
	againW := httptest.NewRecorder()
	testHandler.AnswerRavenClarification(againW, withURLParam(newRequest("POST", "/api/raven/clarifications/"+c.ID+"/answer", map[string]any{
		"answer": "改主意了",
	}), "id", c.ID))
	if againW.Code != http.StatusConflict {
		t.Fatalf("double answer: expected 409, got %d: %s", againW.Code, againW.Body.String())
	}
}

// TestRavenClarificationRules: validation and actor rules.
func TestRavenClarificationRules(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, _ := gateFixture(t)

	// Empty / malformed question lists → 400.
	if w := openClarification(t, requirement.ID, []map[string]any{}); w.Code != http.StatusBadRequest {
		t.Fatalf("empty questions: expected 400, got %d", w.Code)
	}
	if w := openClarification(t, requirement.ID, "not an array"); w.Code != http.StatusBadRequest {
		t.Fatalf("non-array questions: expected 400, got %d", w.Code)
	}
	if w := openClarification(t, requirement.ID, []map[string]any{{"recommended": "x"}}); w.Code != http.StatusBadRequest {
		t.Fatalf("question without text: expected 400, got %d", w.Code)
	}

	// Unknown requirement → 404.
	if w := openClarification(t, "00000000-0000-0000-0000-000000000009", testQuestions); w.Code != http.StatusNotFound {
		t.Fatalf("unknown requirement: expected 404, got %d", w.Code)
	}

	w := openClarification(t, requirement.ID, testQuestions)
	if w.Code != http.StatusCreated {
		t.Fatalf("open clarification: %d %s", w.Code, w.Body.String())
	}
	var c RavenClarificationResponse
	json.NewDecoder(w.Body).Decode(&c)

	// Answer without content → 400.
	noAnsW := httptest.NewRecorder()
	testHandler.AnswerRavenClarification(noAnsW, withURLParam(newRequest("POST", "/api/raven/clarifications/"+c.ID+"/answer", map[string]any{}), "id", c.ID))
	if noAnsW.Code != http.StatusBadRequest {
		t.Fatalf("empty answer: expected 400, got %d", noAnsW.Code)
	}

	// Agent caller → 403.
	agentReq := withURLParam(newRequest("POST", "/api/raven/clarifications/"+c.ID+"/answer", map[string]any{
		"answer": "agent tries to self-answer",
	}), "id", c.ID)
	agentReq.Header.Set("X-Actor-Source", "task_token")
	agentReq.Header.Set("X-Agent-ID", "00000000-0000-0000-0000-000000000002")
	agentW := httptest.NewRecorder()
	testHandler.AnswerRavenClarification(agentW, agentReq)
	if agentW.Code != http.StatusForbidden {
		t.Fatalf("agent answer: expected 403, got %d", agentW.Code)
	}

	// Unsupported status filter → 400.
	filterW := httptest.NewRecorder()
	testHandler.ListRavenDecisionPoints(filterW, newRequest("GET", "/api/raven/decision-points?status=answered", nil))
	if filterW.Code != http.StatusBadRequest {
		t.Fatalf("status=answered: expected 400, got %d", filterW.Code)
	}
}

// TestListRavenClarificationsByRequirement: the run room (issue #18) lists a
// requirement's clarification history, any status, oldest first.
func TestListRavenClarificationsByRequirement(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, _ := gateFixture(t)

	first := openClarification(t, requirement.ID, testQuestions)
	if first.Code != http.StatusCreated {
		t.Fatalf("open first clarification: %d %s", first.Code, first.Body.String())
	}
	var c1 RavenClarificationResponse
	json.NewDecoder(first.Body).Decode(&c1)
	// Answer the first so the list mixes answered and pending records.
	ansW := httptest.NewRecorder()
	testHandler.AnswerRavenClarification(ansW, withURLParam(newRequest("POST", "/api/raven/clarifications/"+c1.ID+"/answer", map[string]any{
		"answer": "JWT",
	}), "id", c1.ID))
	if ansW.Code != http.StatusOK {
		t.Fatalf("answer: %d %s", ansW.Code, ansW.Body.String())
	}
	second := openClarification(t, requirement.ID, []map[string]any{{"question": "второй вопрос?"}})
	if second.Code != http.StatusCreated {
		t.Fatalf("open second clarification: %d %s", second.Code, second.Body.String())
	}

	listW := httptest.NewRecorder()
	testHandler.ListRavenClarifications(listW, withURLParam(newRequest("GET", "/api/raven/requirements/"+requirement.ID+"/clarifications", nil), "id", requirement.ID))
	if listW.Code != http.StatusOK {
		t.Fatalf("ListRavenClarifications: expected 200, got %d: %s", listW.Code, listW.Body.String())
	}
	var resp struct {
		Clarifications []RavenClarificationResponse `json:"clarifications"`
		Total          int                          `json:"total"`
	}
	json.NewDecoder(listW.Body).Decode(&resp)
	if resp.Total != 2 || len(resp.Clarifications) != 2 {
		t.Fatalf("clarification list size: %+v", resp)
	}
	if resp.Clarifications[0].ID != c1.ID || resp.Clarifications[0].Status != "answered" || resp.Clarifications[1].Status != "pending" {
		t.Fatalf("clarification list order/status: %+v", resp.Clarifications)
	}
}
