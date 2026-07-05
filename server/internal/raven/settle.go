package raven

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Learned-stage settlement (issue #23, ADR-0008): a merged requirement is
// advanced Merged → Observed → Learned in one pure-code pass. Observed is
// entered on a delivery-verification signal (CI conclusion) or, lacking one,
// after ObserveWindow elapses (background sweeper). Learned means the
// trajectory has been archived at zero agent cost; strong signals then spawn
// a deep-dive candidate into the S8 learning pipeline.

// ObserveWindow is how long a requirement may sit in Merged without a CI
// signal before the sweeper settles it anyway.
const ObserveWindow = 10 * time.Minute

// deepDiveStage marks learning rows produced by the deep-dive trigger
// rather than by ctx.learning() during a run.
const deepDiveStage = "deep_dive"

var ErrNoRunForDeepDive = errors.New("requirement has no run to attach a deep-dive candidate to")

// SettleOverdueMerged advances every requirement that has been sitting in
// Merged since before cutoff. Called by the background sweeper on a ticker;
// tests call it directly with cutoff = now for synchronous settlement.
func (s *Service) SettleOverdueMerged(ctx context.Context, cutoff time.Time) {
	list, err := s.Q.ListMergedRavenRequirementsBefore(ctx, pgtype.Timestamptz{Time: cutoff, Valid: true})
	if err != nil {
		slog.Warn("raven: list overdue merged requirements failed", "error", err)
		return
	}
	for _, requirement := range list {
		s.SettleToLearned(ctx, requirement, "observation window elapsed without regression signal")
	}
}

// SettleToLearned walks one merged requirement to Learned: transition to
// Observed (with the verification reason), archive the trajectory, transition
// to Learned, and — when the trajectory carries strong signals (gate
// rejection, rework, or self-reported learnings) — insert a deep-dive
// candidate. Best-effort: failures are logged, never propagated.
func (s *Service) SettleToLearned(ctx context.Context, requirement db.RavenRequirement, observedReason string) {
	if State(requirement.State) != StateMerged {
		return
	}
	observed, err := s.ApplyTransition(ctx, requirement, StateObserved, SystemActor, observedReason)
	if err != nil {
		slog.Warn("raven: settle: advance to observed failed", "error", err,
			"requirement_id", util.UUIDToString(requirement.ID))
		return
	}

	archive, archived := s.archiveTrajectory(ctx, observed)

	if _, err := s.ApplyTransition(ctx, observed, StateLearned, SystemActor,
		"trajectory archived (zero-cost)"); err != nil {
		slog.Warn("raven: settle: advance to learned failed", "error", err,
			"requirement_id", util.UUIDToString(requirement.ID))
		return
	}

	if archived && (archive.GateRejectCount > 0 || archive.ReworkCount > 0 || archive.LearningCount > 0) {
		trigger := fmt.Sprintf("signal: 门禁驳回 %d 次 / 返工 %d 次 / 执行自报 %d 条",
			archive.GateRejectCount, archive.ReworkCount, archive.LearningCount)
		if _, err := s.CreateDeepDiveCandidate(ctx, observed, trigger); err != nil {
			slog.Warn("raven: settle: deep-dive candidate failed", "error", err,
				"requirement_id", util.UUIDToString(requirement.ID))
		}
	}
}

// archiveTrajectory extracts the trajectory features of a requirement with
// pure code (no agent) and upserts the archive row: stage sequence, rework
// and gate-reject counts, self-reported learning count, token spend, and the
// keyword fingerprint of the issue.
func (s *Service) archiveTrajectory(ctx context.Context, requirement db.RavenRequirement) (db.RavenRequirementArchive, bool) {
	issue, err := s.Q.GetIssue(ctx, requirement.IssueID)
	if err != nil {
		slog.Warn("raven: archive: load issue failed", "error", err)
		return db.RavenRequirementArchive{}, false
	}
	transitions, err := s.Q.ListRavenTransitions(ctx, db.ListRavenTransitionsParams{
		RequirementID: requirement.ID, WorkspaceID: requirement.WorkspaceID,
	})
	if err != nil {
		slog.Warn("raven: archive: load transitions failed", "error", err)
		return db.RavenRequirementArchive{}, false
	}
	states := make([]string, len(transitions))
	rework := 0
	for i, t := range transitions {
		states[i] = t.ToState
		if t.ToState == string(StateRunning) {
			rework++
		}
	}
	if rework > 0 {
		rework-- // first entry into running is not rework
	}

	// Best-effort side counts: a failure degrades the archive, not the settle.
	gateRejects, err := s.Q.CountRejectedRavenGateReviews(ctx, requirement.ID)
	if err != nil {
		slog.Warn("raven: archive: count gate rejects failed", "error", err)
	}
	learningCount, err := s.Q.CountRavenLearningsByRequirement(ctx, requirement.ID)
	if err != nil {
		slog.Warn("raven: archive: count learnings failed", "error", err)
	}
	var tokens int64
	if runs, err := s.Q.ListRavenRunsByRequirement(ctx, db.ListRavenRunsByRequirementParams{
		RequirementID: requirement.ID, WorkspaceID: requirement.WorkspaceID,
	}); err == nil {
		for _, run := range runs {
			tokens += run.TokensSpent
		}
	}

	archive, err := s.Q.UpsertRavenArchive(ctx, db.UpsertRavenArchiveParams{
		WorkspaceID:     requirement.WorkspaceID,
		RequirementID:   requirement.ID,
		IssueID:         requirement.IssueID,
		IssueTitle:      issue.Title,
		StageSequence:   strings.Join(states, ","),
		ReworkCount:     int32(rework),
		GateRejectCount: int32(gateRejects),
		LearningCount:   int32(learningCount),
		TokensSpent:     tokens,
		Keywords:        ExtractKeywords(issue.Title, issue.Description.String),
	})
	if err != nil {
		slog.Warn("raven: archive: upsert failed", "error", err)
		return db.RavenRequirementArchive{}, false
	}
	return archive, true
}

// CreateDeepDiveCandidate produces the deep-dive output for a requirement:
// a fresh raven_learning row (stage "deep_dive") attached to the latest run,
// which drops it into the S8 沉淀流 pipeline for triage. v1 keeps this
// zero-agent — the candidate is a structured prompt for human/agent triage,
// not an autonomous review task.
func (s *Service) CreateDeepDiveCandidate(ctx context.Context, requirement db.RavenRequirement, trigger string) (db.RavenLearning, error) {
	runs, err := s.Q.ListRavenRunsByRequirement(ctx, db.ListRavenRunsByRequirementParams{
		RequirementID: requirement.ID, WorkspaceID: requirement.WorkspaceID,
	})
	if err != nil {
		return db.RavenLearning{}, err
	}
	if len(runs) == 0 {
		return db.RavenLearning{}, ErrNoRunForDeepDive
	}
	content := fmt.Sprintf("深挖候选（%s）：本次交付轨迹存在值得复盘的信号。建议回看 run 轨迹、门禁记录与执行自报，提炼可沉淀的 skill、事实或口径。", trigger)
	if archive, err := s.Q.GetRavenArchiveByRequirement(ctx, db.GetRavenArchiveByRequirementParams{
		RequirementID: requirement.ID, WorkspaceID: requirement.WorkspaceID,
	}); err == nil {
		content += fmt.Sprintf("轨迹：%s；门禁驳回 %d 次，返工 %d 次，执行自报 %d 条。",
			archive.StageSequence, archive.GateRejectCount, archive.ReworkCount, archive.LearningCount)
	}
	return s.Q.CreateRavenLearning(ctx, db.CreateRavenLearningParams{
		WorkspaceID: requirement.WorkspaceID,
		RunID:       runs[0].ID, // latest run (created_at DESC)
		Stage:       deepDiveStage,
		Content:     content,
	})
}
