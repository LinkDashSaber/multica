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

// TestRavenUptrackProposal: a bare agent issue reaching done earns exactly one
// uptrack proposal with a ready-made draft prompt; reopen→done does not spam;
// workflow-tracked issues never propose.
func TestRavenUptrackProposal(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	agentID := createHandlerTestAgent(t, "uptrack-agent-"+t.Name(), nil)

	w := httptest.NewRecorder()
	testHandler.CreateIssue(w, newRequest("POST", "/api/issues", map[string]any{
		"title": "uptrack candidate " + t.Name(), "status": "in_progress", "priority": "medium",
		"assignee_type": "agent", "assignee_id": agentID,
	}))
	if w.Code != http.StatusCreated {
		t.Fatalf("create issue: %d %s", w.Code, w.Body.String())
	}
	var issue IssueResponse
	json.NewDecoder(w.Body).Decode(&issue)
	t.Cleanup(func() { deleteTestIssue(t, issue.ID) })

	updateIssueStatus(t, issue.ID, "done")
	if n := countUptrackProposals(t, issue.ID); n != 1 {
		t.Fatalf("proposals after done: want 1, got %d", n)
	}

	// Details carry the draft-issue material the UI needs.
	var details []byte
	if err := testPool.QueryRow(t.Context(),
		`SELECT details FROM inbox_item WHERE type = 'raven_uptrack_proposal' AND issue_id = $1`,
		issue.ID).Scan(&details); err != nil {
		t.Fatalf("load details: %v", err)
	}
	var d struct {
		DraftIssueTitle  string `json:"draft_issue_title"`
		DraftIssuePrompt string `json:"draft_issue_prompt"`
	}
	json.Unmarshal(details, &d)
	if d.DraftIssueTitle == "" || d.DraftIssuePrompt == "" {
		t.Fatalf("draft material missing: %+v", d)
	}

	// Reopen → done again must not create a second proposal.
	updateIssueStatus(t, issue.ID, "in_progress")
	updateIssueStatus(t, issue.ID, "done")
	if n := countUptrackProposals(t, issue.ID); n != 1 {
		t.Fatalf("proposals after reopen cycle: want 1, got %d", n)
	}
}

// TestRavenUptrackSkipsWorkflowIssues: an issue already on the Raven track
// gets no uptrack proposal when it reaches done.
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
