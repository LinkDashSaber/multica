package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func updateIssueStatus(t *testing.T, issueID, status string) {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.UpdateIssue(w, withURLParam(newRequest("PUT", "/api/issues/"+issueID, map[string]any{
		"status": status,
	}), "id", issueID))
	if w.Code != http.StatusOK {
		t.Fatalf("update status to %s: %d %s", status, w.Code, w.Body.String())
	}
}

func countUptrackProposals(t *testing.T, issueID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM inbox_item WHERE type = 'raven_uptrack_proposal' AND issue_id = $1`,
		issueID).Scan(&n); err != nil {
		t.Fatalf("count proposals: %v", err)
	}
	return n
}

// bareDoneIssue creates a bare agent issue with the given title and drives
// it to done, firing the uptrack hook.
func bareDoneIssue(t *testing.T, agentID, title string) IssueResponse {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.CreateIssue(w, newRequest("POST", "/api/issues", map[string]any{
		"title": title, "status": "in_progress", "priority": "medium",
		"assignee_type": "agent", "assignee_id": agentID,
	}))
	if w.Code != http.StatusCreated {
		t.Fatalf("create issue: %d %s", w.Code, w.Body.String())
	}
	var issue IssueResponse
	json.NewDecoder(w.Body).Decode(&issue)
	t.Cleanup(func() { deleteTestIssue(t, issue.ID) })
	updateIssueStatus(t, issue.ID, "done")
	return issue
}

// TestRavenUptrackThreshold (issue #23, ADR-0008 三档门槛): one-off bare
// deliveries earn no proposal; the third isomorphic completion earns exactly
// one proposal carrying all three deliveries as evidence; reopen→done does
// not spam.
func TestRavenUptrackThreshold(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	agentID := createHandlerTestAgent(t, "uptrack-agent-"+t.Name(), nil)

	// Deliveries share a keyword fingerprint (marketo/leads/sync/batch) —
	// isomorphic by the archive heuristic.
	first := bareDoneIssue(t, agentID, "marketo leads sync batch alpha zq1")
	if n := countUptrackProposals(t, first.ID); n != 0 {
		t.Fatalf("one-off delivery proposals: want 0, got %d", n)
	}

	second := bareDoneIssue(t, agentID, "marketo leads sync batch beta zq1")
	if n := countUptrackProposals(t, first.ID) + countUptrackProposals(t, second.ID); n != 0 {
		t.Fatalf("second delivery proposals: want 0, got %d", n)
	}

	third := bareDoneIssue(t, agentID, "marketo leads sync batch gamma zq1")
	if n := countUptrackProposals(t, third.ID); n != 1 {
		t.Fatalf("third isomorphic delivery proposals: want 1, got %d", n)
	}

	// Details carry the draft-issue material plus all three evidence entries.
	var details []byte
	if err := testPool.QueryRow(t.Context(),
		`SELECT details FROM inbox_item WHERE type = 'raven_uptrack_proposal' AND issue_id = $1`,
		third.ID).Scan(&details); err != nil {
		t.Fatalf("load details: %v", err)
	}
	var d map[string]string
	json.Unmarshal(details, &d)
	if d["draft_issue_title"] == "" || d["draft_issue_prompt"] == "" {
		t.Fatalf("draft material missing: %v", d)
	}
	if d["isomorph_count"] != "3" {
		t.Fatalf("isomorph_count: want 3, got %q", d["isomorph_count"])
	}
	evidenceIDs := map[string]bool{}
	for _, k := range []string{"evidence_issue_id_1", "evidence_issue_id_2", "evidence_issue_id_3"} {
		if d[k] == "" {
			t.Fatalf("missing %s in details: %v", k, d)
		}
		evidenceIDs[d[k]] = true
	}
	for _, issue := range []IssueResponse{first, second, third} {
		if !evidenceIDs[issue.ID] {
			t.Fatalf("evidence missing delivery %s: %v", issue.ID, d)
		}
	}

	// Reopen → done again must not create a second proposal.
	updateIssueStatus(t, third.ID, "in_progress")
	updateIssueStatus(t, third.ID, "done")
	if n := countUptrackProposals(t, third.ID); n != 1 {
		t.Fatalf("proposals after reopen cycle: want 1, got %d", n)
	}
}

// TestRavenUptrackSkipsWorkflowIssues: an issue already on the Raven track
// gets no uptrack proposal (and no bare-delivery archive) when it reaches done.
func TestRavenUptrackSkipsWorkflowIssues(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, _ := gateFixture(t) // workflow issue at running
	updateIssueStatus(t, requirement.IssueID, "done")
	if n := countUptrackProposals(t, requirement.IssueID); n != 0 {
		t.Fatalf("workflow issue proposals: want 0, got %d", n)
	}
}
