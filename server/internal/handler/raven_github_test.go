package handler

import (
	"testing"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// TestRavenPullRequestMergedClosesLoop: a merged PR webhook event records
// "pr" evidence and walks the lifecycle running → needs_review → merged,
// projecting the issue to done — the issue #6 closed loop.
func TestRavenPullRequestMergedClosesLoop(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, _ := gateFixture(t) // workflow issue advanced to running

	issue, err := testHandler.Queries.GetIssue(t.Context(), parseUUID(requirement.IssueID))
	if err != nil {
		t.Fatalf("load issue: %v", err)
	}

	pr := db.GithubPullRequest{
		WorkspaceID:  issue.WorkspaceID,
		PrNumber:     101,
		Title:        "feat: close the loop",
		HtmlUrl:      "https://github.com/example/repo/pull/101",
		HeadSha:      "abc123",
		Additions:    42,
		Deletions:    7,
		ChangedFiles: 3,
	}
	testHandler.ravenOnPullRequestEvent(t.Context(), []db.Issue{issue}, pr, "closed", "merged")

	var evidenceCount int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM raven_evidence WHERE requirement_id = $1 AND kind = 'pr' AND source = 'github'`,
		requirement.ID).Scan(&evidenceCount); err != nil {
		t.Fatalf("count evidence: %v", err)
	}
	if evidenceCount != 1 {
		t.Fatalf("pr evidence rows: want 1, got %d", evidenceCount)
	}

	var state string
	if err := testPool.QueryRow(t.Context(),
		`SELECT state FROM raven_requirement WHERE id = $1`, requirement.ID).Scan(&state); err != nil {
		t.Fatalf("load state: %v", err)
	}
	if state != "merged" {
		t.Fatalf("state after merge: want merged, got %s", state)
	}

	// Corridor walked through needs_review — both hops are in the audit trail.
	var hops int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM raven_requirement_transition WHERE requirement_id = $1 AND to_state IN ('needs_review', 'merged') AND actor_type = 'system'`,
		requirement.ID).Scan(&hops); err != nil {
		t.Fatalf("count transitions: %v", err)
	}
	if hops != 2 {
		t.Fatalf("merge corridor transitions: want 2, got %d", hops)
	}

	// Board projection followed the lifecycle.
	updated, err := testHandler.Queries.GetIssue(t.Context(), issue.ID)
	if err != nil {
		t.Fatalf("reload issue: %v", err)
	}
	if updated.Status != "done" {
		t.Fatalf("issue status: want done, got %s", updated.Status)
	}
}

// TestRavenPullRequestNonMergedRecordsEvidenceOnly: an opened PR is evidence
// but never advances the lifecycle; bare issues are ignored entirely.
func TestRavenPullRequestNonMergedRecordsEvidenceOnly(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	requirement, _ := gateFixture(t)
	issue, err := testHandler.Queries.GetIssue(t.Context(), parseUUID(requirement.IssueID))
	if err != nil {
		t.Fatalf("load issue: %v", err)
	}

	pr := db.GithubPullRequest{WorkspaceID: issue.WorkspaceID, PrNumber: 102, Title: "wip", HeadSha: "def456"}
	testHandler.ravenOnPullRequestEvent(t.Context(), []db.Issue{issue}, pr, "opened", "open")

	var state string
	if err := testPool.QueryRow(t.Context(),
		`SELECT state FROM raven_requirement WHERE id = $1`, requirement.ID).Scan(&state); err != nil {
		t.Fatalf("load state: %v", err)
	}
	if state != "running" {
		t.Fatalf("state after opened PR: want running, got %s", state)
	}

	var evidenceCount int
	if err := testPool.QueryRow(t.Context(),
		`SELECT count(*) FROM raven_evidence WHERE requirement_id = $1 AND kind = 'pr'`,
		requirement.ID).Scan(&evidenceCount); err != nil {
		t.Fatalf("count evidence: %v", err)
	}
	if evidenceCount != 1 {
		t.Fatalf("pr evidence rows: want 1, got %d", evidenceCount)
	}
}
