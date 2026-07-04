package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/raven"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Raven workflow registry (ADR-0005). v1: workflows are registered by the
// platform team via API; contract validation is mandatory at the door.

type RavenWorkflowResponse struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspace_id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Contract    json.RawMessage `json:"contract"`
	Version     int32           `json:"version"`
	Enabled     bool            `json:"enabled"`
	CreatedAt   string          `json:"created_at"`
	UpdatedAt   string          `json:"updated_at"`
}

func ravenWorkflowToResponse(wf db.RavenWorkflow) RavenWorkflowResponse {
	return RavenWorkflowResponse{
		ID:          uuidToString(wf.ID),
		WorkspaceID: uuidToString(wf.WorkspaceID),
		Name:        wf.Name,
		Description: wf.Description,
		Contract:    json.RawMessage(wf.Contract),
		Version:     wf.Version,
		Enabled:     wf.Enabled,
		CreatedAt:   timestampToString(wf.CreatedAt),
		UpdatedAt:   timestampToString(wf.UpdatedAt),
	}
}

// CreateRavenWorkflow registers a workflow. The contract must pass
// raven.ParseContract — stages, gates and budget are mandatory.
func (h *Handler) CreateRavenWorkflow(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Contract    json.RawMessage `json:"contract"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if len(req.Contract) == 0 {
		writeError(w, http.StatusBadRequest, "contract is required")
		return
	}
	if _, err := raven.ParseContract(req.Contract); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}

	wf, err := h.Queries.CreateRavenWorkflow(r.Context(), db.CreateRavenWorkflowParams{
		WorkspaceID: wsUUID,
		Name:        req.Name,
		Description: req.Description,
		Contract:    []byte(req.Contract),
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a workflow with this name already exists")
			return
		}
		slog.Warn("CreateRavenWorkflow failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create workflow")
		return
	}
	writeJSON(w, http.StatusCreated, ravenWorkflowToResponse(wf))
}

// ListRavenWorkflows returns every workflow in the workspace.
func (h *Handler) ListRavenWorkflows(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	list, err := h.Queries.ListRavenWorkflows(r.Context(), wsUUID)
	if err != nil {
		slog.Warn("ListRavenWorkflows failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list workflows")
		return
	}
	resp := make([]RavenWorkflowResponse, len(list))
	for i, wf := range list {
		resp[i] = ravenWorkflowToResponse(wf)
	}
	writeJSON(w, http.StatusOK, map[string]any{"workflows": resp, "total": len(resp)})
}

// GetRavenWorkflow returns one workflow.
func (h *Handler) GetRavenWorkflow(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workflow id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	wf, err := h.Queries.GetRavenWorkflow(r.Context(), db.GetRavenWorkflowParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "workflow not found")
			return
		}
		slog.Warn("GetRavenWorkflow failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to get workflow")
		return
	}
	writeJSON(w, http.StatusOK, ravenWorkflowToResponse(wf))
}

// UpdateRavenWorkflow updates description/contract/enabled and bumps the
// version. Contract, when provided, must validate.
func (h *Handler) UpdateRavenWorkflow(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workflow id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	var req struct {
		Description *string         `json:"description"`
		Contract    json.RawMessage `json:"contract"`
		Enabled     *bool           `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Contract) > 0 {
		if _, err := raven.ParseContract(req.Contract); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	params := db.UpdateRavenWorkflowParams{ID: idUUID, WorkspaceID: wsUUID}
	if req.Description != nil {
		params.Description = ptrToText(req.Description)
	}
	if len(req.Contract) > 0 {
		params.Contract = []byte(req.Contract)
	}
	if req.Enabled != nil {
		params.Enabled = pgtype.Bool{Bool: *req.Enabled, Valid: true}
	}

	wf, err := h.Queries.UpdateRavenWorkflow(r.Context(), params)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "workflow not found")
			return
		}
		slog.Warn("UpdateRavenWorkflow failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update workflow")
		return
	}
	writeJSON(w, http.StatusOK, ravenWorkflowToResponse(wf))
}

// ensureRavenRequirementForWorkflowAssign is the opt-in hook (ADR-0006):
// called after an issue is created with — or reassigned to — a workflow
// assignee. Creates the lifecycle record in Idea state bound to that
// workflow, projects the board column, and records the creation transition.
// Idempotent: an issue that already has a requirement keeps it (the workflow
// binding is not rewritten mid-flight). Best-effort: failures are logged,
// never fail the issue write.
func (h *Handler) ensureRavenRequirementForWorkflowAssign(r *http.Request, issue db.Issue) {
	if issue.AssigneeType.String != "workflow" || !issue.AssigneeID.Valid {
		return
	}
	ctx := r.Context()
	if _, err := h.Queries.GetRavenRequirementByIssue(ctx, db.GetRavenRequirementByIssueParams{
		IssueID: issue.ID, WorkspaceID: issue.WorkspaceID,
	}); err == nil {
		return // already on the track
	}

	requirement, err := h.Queries.CreateRavenRequirement(ctx, db.CreateRavenRequirementParams{
		WorkspaceID: issue.WorkspaceID,
		IssueID:     issue.ID,
		State:       string(raven.StateIdea),
		WorkflowID:  issue.AssigneeID,
	})
	if err != nil {
		slog.Warn("raven: opt-in requirement create failed", append(logger.RequestAttrs(r), "error", err, "issue_id", uuidToString(issue.ID))...)
		return
	}
	actorType, actorID := ravenActor(r)
	if _, err := h.Queries.InsertRavenTransition(ctx, db.InsertRavenTransitionParams{
		RequirementID: requirement.ID,
		FromState:     "",
		ToState:       string(raven.StateIdea),
		ActorType:     actorType,
		ActorID:       actorID,
		Reason:        "assigned to workflow",
	}); err != nil {
		slog.Warn("raven: opt-in creation transition failed", append(logger.RequestAttrs(r), "error", err)...)
	}
	h.projectRavenStateToIssue(r, requirement)
	h.dispatchRavenRun(r, requirement)
}
