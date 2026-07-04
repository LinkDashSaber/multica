package handler

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/multica-ai/multica/server/internal/raven"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Raven hooks into the GitHub webhook pipeline (issue #6): PR and CI events
// become structured evidence on the linked requirement, and a merged PR
// drives the lifecycle to Merged without human bookkeeping. All best-effort:
// a bare issue (no requirement) is simply skipped.

// ravenOnPullRequestEvent records PR evidence for every linked issue on the
// Raven track and advances the lifecycle when the PR merged.
func (h *Handler) ravenOnPullRequestEvent(ctx context.Context, issues []db.Issue, pr db.GithubPullRequest, action, state string) {
	svc := h.ravenService()
	for _, issue := range issues {
		requirement, err := h.Queries.GetRavenRequirementByIssue(ctx, db.GetRavenRequirementByIssueParams{
			IssueID: issue.ID, WorkspaceID: issue.WorkspaceID,
		})
		if err != nil {
			continue // not on the Raven track
		}
		svc.RecordEvidence(ctx, requirement, "pr", "github",
			fmt.Sprintf("PR #%d %s（%s）：%s", pr.PrNumber, action, state, pr.Title),
			map[string]any{
				"pr_number":     pr.PrNumber,
				"action":        action,
				"state":         state,
				"title":         pr.Title,
				"html_url":      pr.HtmlUrl,
				"head_sha":      pr.HeadSha,
				"additions":     pr.Additions,
				"deletions":     pr.Deletions,
				"changed_files": pr.ChangedFiles,
			})
		if state == "merged" {
			if _, err := svc.AdvanceTo(ctx, requirement, raven.StateMerged, raven.SystemActor,
				fmt.Sprintf("PR #%d merged", pr.PrNumber)); err != nil {
				slog.Warn("raven: advance to merged failed", "error", err,
					"requirement_id", uuidToString(requirement.ID), "state", requirement.State)
			}
		}
	}
}

// ravenOnCheckSuiteEvent records a CI conclusion as evidence for every
// linked issue on the Raven track.
func (h *Handler) ravenOnCheckSuiteEvent(ctx context.Context, pr db.GithubPullRequest, status, conclusion string) {
	if status != "completed" {
		return // only terminal CI states are evidence-worthy
	}
	issueIDs, err := h.Queries.ListIssueIDsForPullRequest(ctx, pr.ID)
	if err != nil {
		return
	}
	svc := h.ravenService()
	for _, issueID := range issueIDs {
		requirement, err := h.Queries.GetRavenRequirementByIssue(ctx, db.GetRavenRequirementByIssueParams{
			IssueID: issueID, WorkspaceID: pr.WorkspaceID,
		})
		if err != nil {
			continue
		}
		svc.RecordEvidence(ctx, requirement, "ci", "github",
			fmt.Sprintf("CI %s：PR #%d（%s）", conclusion, pr.PrNumber, pr.HeadSha),
			map[string]any{
				"pr_number":  pr.PrNumber,
				"head_sha":   pr.HeadSha,
				"status":     status,
				"conclusion": conclusion,
				"html_url":   pr.HtmlUrl,
			})
	}
}
