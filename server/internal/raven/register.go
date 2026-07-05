package raven

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Merge-time workflow registration (ADR-0010): "新建交付策略" and uptrack
// drafts converge on one pipeline — a requirement whose run recorded a
// contract draft gets its workflow registered when the requirement reaches
// Merged. The hook keys on the evidence record, not on repository content:
// the draft stage of the authoring workflow (and any uptrack draft run)
// stores the contract JSON as evidence, so the control plane never needs to
// read the merged PR's files.

// EvidenceKindContractDraft is the evidence kind the authoring/uptrack draft
// stage writes; its payload is a WorkflowContractDraft.
const EvidenceKindContractDraft = "workflow_contract_draft"

// WorkflowContractDraft is the evidence payload shape the registration hook
// consumes. Name doubles as the registry slug (unique per workspace).
type WorkflowContractDraft struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Contract    json.RawMessage `json:"contract"`
}

// registerWorkflowFromContractDraft runs on every transition into Merged.
// No contract-draft evidence → not an authoring requirement → no-op.
// Best-effort: registration failures are logged, never block the lifecycle.
func (s *Service) registerWorkflowFromContractDraft(ctx context.Context, requirement db.RavenRequirement) {
	evidence, err := s.Q.ListRavenEvidenceByRequirement(ctx, db.ListRavenEvidenceByRequirementParams{
		RequirementID: requirement.ID, WorkspaceID: requirement.WorkspaceID,
	})
	if err != nil {
		slog.Warn("raven: register-on-merge: list evidence failed", "error", err)
		return
	}
	// Latest draft wins: spec-confirm rejection loops re-record the evidence.
	var draft *WorkflowContractDraft
	for _, e := range evidence {
		if e.Kind != EvidenceKindContractDraft {
			continue
		}
		var d WorkflowContractDraft
		if err := json.Unmarshal(e.Payload, &d); err != nil {
			slog.Warn("raven: register-on-merge: malformed draft payload", "error", err,
				"evidence_id", util.UUIDToString(e.ID))
			continue
		}
		draft = &d
	}
	if draft == nil {
		return // not an authoring requirement
	}

	reqID := util.UUIDToString(requirement.ID)
	if draft.Name == "" {
		slog.Warn("raven: register-on-merge: draft has no name", "requirement_id", reqID)
		return
	}
	if _, err := ParseContract(draft.Contract); err != nil {
		slog.Warn("raven: register-on-merge: draft contract invalid", "error", err, "requirement_id", reqID)
		return
	}

	existing, err := s.Q.GetRavenWorkflowByName(ctx, db.GetRavenWorkflowByNameParams{
		WorkspaceID: requirement.WorkspaceID, Name: draft.Name,
	})
	switch {
	case err == nil:
		if contractsEqual(existing.Contract, draft.Contract) && existing.Description == draft.Description {
			return // re-entrant Merged with the same draft: nothing to do
		}
		if _, err := s.Q.UpdateRavenWorkflow(ctx, db.UpdateRavenWorkflowParams{
			ID:          existing.ID,
			WorkspaceID: requirement.WorkspaceID,
			Description: pgtype.Text{String: draft.Description, Valid: true},
			Contract:    []byte(draft.Contract),
		}); err != nil {
			slog.Warn("raven: register-on-merge: update workflow failed", "error", err, "name", draft.Name)
			return
		}
		slog.Info("raven: workflow updated from merged draft", "name", draft.Name, "requirement_id", reqID)
	case errors.Is(err, pgx.ErrNoRows):
		if _, err := s.Q.CreateRavenWorkflow(ctx, db.CreateRavenWorkflowParams{
			WorkspaceID: requirement.WorkspaceID,
			Name:        draft.Name,
			Description: draft.Description,
			Contract:    []byte(draft.Contract),
		}); err != nil {
			slog.Warn("raven: register-on-merge: create workflow failed", "error", err, "name", draft.Name)
			return
		}
		slog.Info("raven: workflow registered from merged draft", "name", draft.Name, "requirement_id", reqID)
	default:
		slog.Warn("raven: register-on-merge: lookup workflow failed", "error", err, "name", draft.Name)
	}
}

// contractsEqual compares contract JSON semantically — JSONB storage
// normalizes key order, so byte comparison would false-negative.
func contractsEqual(a, b json.RawMessage) bool {
	var av, bv any
	if json.Unmarshal(a, &av) != nil || json.Unmarshal(b, &bv) != nil {
		return false
	}
	return reflect.DeepEqual(av, bv)
}
