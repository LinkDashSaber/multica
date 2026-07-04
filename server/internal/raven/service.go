package raven

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Actor identifies who caused a lifecycle change.
type Actor struct {
	Type string // user | agent | system
	ID   string
}

var SystemActor = Actor{Type: "system"}

var ErrIllegalTransition = errors.New("illegal raven transition")

// Service is the Raven domain service shared by the HTTP handlers, the
// GitHub webhook pipeline, and the autopilot dispatcher — every path that
// can move a requirement through the lifecycle.
type Service struct {
	Q          *db.Queries
	Dispatcher *Dispatcher
}

func NewService(q *db.Queries, d *Dispatcher) *Service {
	return &Service{Q: q, Dispatcher: d}
}

// EnsureRequirementForWorkflowAssign is the opt-in hook (ADR-0006): called
// after an issue is created with — or reassigned to — a workflow assignee.
// Creates the lifecycle record in Idea bound to that workflow, records the
// creation transition, projects the board column, and dispatches a run.
// Idempotent and best-effort: failures are logged, never propagated.
func (s *Service) EnsureRequirementForWorkflowAssign(ctx context.Context, issue db.Issue, actor Actor) {
	if issue.AssigneeType.String != "workflow" || !issue.AssigneeID.Valid {
		return
	}
	if _, err := s.Q.GetRavenRequirementByIssue(ctx, db.GetRavenRequirementByIssueParams{
		IssueID: issue.ID, WorkspaceID: issue.WorkspaceID,
	}); err == nil {
		return // already on the track
	}

	requirement, err := s.Q.CreateRavenRequirement(ctx, db.CreateRavenRequirementParams{
		WorkspaceID: issue.WorkspaceID,
		IssueID:     issue.ID,
		State:       string(StateIdea),
		WorkflowID:  issue.AssigneeID,
	})
	if err != nil {
		slog.Warn("raven: opt-in requirement create failed", "error", err, "issue_id", util.UUIDToString(issue.ID))
		return
	}
	if _, err := s.Q.InsertRavenTransition(ctx, db.InsertRavenTransitionParams{
		RequirementID: requirement.ID,
		FromState:     "",
		ToState:       string(StateIdea),
		ActorType:     actor.Type,
		ActorID:       actor.ID,
		Reason:        "assigned to workflow",
	}); err != nil {
		slog.Warn("raven: opt-in creation transition failed", "error", err)
	}
	s.ProjectStateToIssue(ctx, requirement)
	s.DispatchRun(ctx, requirement)
}

// ApplyTransition performs one legality-checked state change: update state,
// append history, project the board column.
func (s *Service) ApplyTransition(ctx context.Context, requirement db.RavenRequirement, to State, actor Actor, reason string) (db.RavenRequirement, error) {
	from := State(requirement.State)
	if !CanTransition(from, to) {
		return db.RavenRequirement{}, ErrIllegalTransition
	}

	updated, err := s.Q.UpdateRavenRequirementState(ctx, db.UpdateRavenRequirementStateParams{
		ID: requirement.ID, State: string(to), WorkspaceID: requirement.WorkspaceID,
	})
	if err != nil {
		return db.RavenRequirement{}, err
	}

	if _, err := s.Q.InsertRavenTransition(ctx, db.InsertRavenTransitionParams{
		RequirementID: requirement.ID,
		FromState:     string(from),
		ToState:       string(to),
		ActorType:     actor.Type,
		ActorID:       actor.ID,
		Reason:        reason,
	}); err != nil {
		slog.Warn("raven: record transition failed", "error", err)
	}

	s.ProjectStateToIssue(ctx, updated)
	return updated, nil
}

// AdvanceTo walks the requirement toward `target` through legal single
// steps along a fixed corridor (e.g. running → needs_review → merged when a
// PR merges). It only ever moves forward via CanTransition; if no legal
// path exists the requirement is left untouched.
func (s *Service) AdvanceTo(ctx context.Context, requirement db.RavenRequirement, target State, actor Actor, reason string) (db.RavenRequirement, error) {
	current := requirement
	for i := 0; i < 4; i++ { // corridor is short; hard bound against loops
		if State(current.State) == target {
			return current, nil
		}
		if CanTransition(State(current.State), target) {
			return s.ApplyTransition(ctx, current, target, actor, reason)
		}
		// One intermediate hop toward the target, if unambiguous.
		var hop State
		found := false
		for _, next := range NextStates(State(current.State)) {
			if CanTransition(next, target) {
				if found {
					return current, ErrIllegalTransition // ambiguous, refuse to guess
				}
				hop = next
				found = true
			}
		}
		if !found {
			return current, ErrIllegalTransition
		}
		next, err := s.ApplyTransition(ctx, current, hop, actor, reason)
		if err != nil {
			return current, err
		}
		current = next
	}
	return current, ErrIllegalTransition
}

// ProjectStateToIssue writes the lifecycle state onto the multica issue
// board column. One-way projection; failures are logged, never surfaced.
func (s *Service) ProjectStateToIssue(ctx context.Context, requirement db.RavenRequirement) {
	status := IssueStatusFor(State(requirement.State))
	if _, err := s.Q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{
		ID:          requirement.IssueID,
		Status:      status,
		WorkspaceID: requirement.WorkspaceID,
	}); err != nil {
		slog.Warn("raven: issue status projection failed", "error", err)
	}
}

// RecordEvidence writes one structured evidence record. Best-effort.
func (s *Service) RecordEvidence(ctx context.Context, requirement db.RavenRequirement, kind, source, summary string, payload any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		raw = []byte("{}")
	}
	if _, err := s.Q.CreateRavenEvidence(ctx, db.CreateRavenEvidenceParams{
		WorkspaceID:   requirement.WorkspaceID,
		RequirementID: requirement.ID,
		RunID:         pgtype.UUID{},
		Kind:          kind,
		Source:        source,
		Summary:       summary,
		Payload:       raw,
	}); err != nil {
		slog.Warn("raven: record evidence failed", "error", err, "kind", kind)
	}
}

// DispatchRun creates a run row and fires the workflow's trigger.dev task.
// Unconfigured dispatcher leaves the run pending (local dev without
// trigger.dev).
func (s *Service) DispatchRun(ctx context.Context, requirement db.RavenRequirement) {
	if !requirement.WorkflowID.Valid {
		return
	}
	workflow, err := s.Q.GetRavenWorkflow(ctx, db.GetRavenWorkflowParams{
		ID: requirement.WorkflowID, WorkspaceID: requirement.WorkspaceID,
	})
	if err != nil {
		slog.Warn("raven: dispatch: load workflow failed", "error", err)
		return
	}
	run, err := s.Q.CreateRavenRun(ctx, db.CreateRavenRunParams{
		WorkspaceID:   requirement.WorkspaceID,
		RequirementID: requirement.ID,
		WorkflowID:    requirement.WorkflowID,
		Status:        "pending",
	})
	if err != nil {
		slog.Warn("raven: dispatch: create run failed", "error", err)
		return
	}

	if !s.Dispatcher.Configured() {
		slog.Warn("raven: trigger.dev dispatcher not configured; run stays pending",
			"run_id", util.UUIDToString(run.ID), "workflow", workflow.Name)
		return
	}

	// Detach: callers are HTTP handlers or webhook pipelines whose contexts
	// end with the request.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		triggerRunID, err := s.Dispatcher.TriggerRun(ctx, workflow.Name, map[string]any{
			"workspace_id":   util.UUIDToString(requirement.WorkspaceID),
			"issue_id":       util.UUIDToString(requirement.IssueID),
			"requirement_id": util.UUIDToString(requirement.ID),
			"run_id":         util.UUIDToString(run.ID),
			"workflow_name":  workflow.Name,
			"contract":       json.RawMessage(workflow.Contract),
		})
		if err != nil {
			slog.Warn("raven: trigger.dev dispatch failed", "error", err, "run_id", util.UUIDToString(run.ID), "workflow", workflow.Name)
			reason := "dispatch failed: " + err.Error()
			if _, uerr := s.Q.UpdateRavenRun(ctx, db.UpdateRavenRunParams{
				ID: run.ID, WorkspaceID: run.WorkspaceID,
				Status:            pgtype.Text{String: "failed", Valid: true},
				TerminationReason: pgtype.Text{String: reason, Valid: true},
			}); uerr != nil {
				slog.Warn("raven: record dispatch failure failed", "error", uerr)
			}
			return
		}
		if _, err := s.Q.UpdateRavenRun(ctx, db.UpdateRavenRunParams{
			ID: run.ID, WorkspaceID: run.WorkspaceID,
			TriggerRunID: pgtype.Text{String: triggerRunID, Valid: true},
		}); err != nil {
			slog.Warn("raven: record trigger run id failed", "error", err)
		}
	}()
}
