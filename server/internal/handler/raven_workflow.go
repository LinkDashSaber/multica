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

// RavenWorkflowStatsResponse carries per-workflow run/gate aggregates. Rates
// are computed client-side from the counts so the API stays additive.
type RavenWorkflowStatsResponse struct {
	WorkflowID    string  `json:"workflow_id"`
	RunCount      int64   `json:"run_count"`
	ActiveRuns    int64   `json:"active_runs"`
	AvgRunSeconds float64 `json:"avg_run_seconds"`
	ApprovedGates int64   `json:"approved_gates"`
	RejectedGates int64   `json:"rejected_gates"`
	// Trust promotion (issue #25): number of gates downgraded to spot
	// checks, and the best live zero-reject streak among non-promoted
	// gates ("N more to the production line").
	PromotedGates int64 `json:"promoted_gates"`
	MaxGateStreak int64 `json:"max_gate_streak"`
}

// ListRavenWorkflowStats returns aggregates for every workflow in the
// workspace (workflow list page: run count, pass/rejection rate, avg duration).
func (h *Handler) ListRavenWorkflowStats(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	list, err := h.Queries.ListRavenWorkflowStats(r.Context(), wsUUID)
	if err != nil {
		slog.Warn("ListRavenWorkflowStats failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list workflow stats")
		return
	}
	// Trust promotion aggregates (issue #25): sampled-gate count per
	// workflow and the best streak among gates still under full review.
	policies, err := h.Queries.ListRavenGatePolicies(r.Context(), wsUUID)
	if err != nil {
		slog.Warn("ListRavenWorkflowStats policies failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list workflow stats")
		return
	}
	streaks, err := h.Queries.ListRavenGateStreaks(r.Context(), wsUUID)
	if err != nil {
		slog.Warn("ListRavenWorkflowStats streaks failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list workflow stats")
		return
	}
	promotedByWorkflow := map[string]int64{}
	sampledGate := map[string]bool{} // workflowID + "\x00" + gateName
	for _, p := range policies {
		if p.Mode == "sampled" {
			wfID := uuidToString(p.WorkflowID)
			promotedByWorkflow[wfID]++
			sampledGate[wfID+"\x00"+p.GateName] = true
		}
	}
	maxStreakByWorkflow := map[string]int64{}
	for _, st := range streaks {
		wfID := uuidToString(st.WorkflowID)
		if sampledGate[wfID+"\x00"+st.GateName] {
			continue // already promoted; its streak is not progress
		}
		if st.Streak > maxStreakByWorkflow[wfID] {
			maxStreakByWorkflow[wfID] = st.Streak
		}
	}

	resp := make([]RavenWorkflowStatsResponse, len(list))
	for i, s := range list {
		wfID := uuidToString(s.WorkflowID)
		resp[i] = RavenWorkflowStatsResponse{
			WorkflowID:    wfID,
			RunCount:      s.RunCount,
			ActiveRuns:    s.ActiveRuns,
			AvgRunSeconds: s.AvgRunSeconds,
			ApprovedGates: s.ApprovedGates,
			RejectedGates: s.RejectedGates,
			PromotedGates: promotedByWorkflow[wfID],
			MaxGateStreak: maxStreakByWorkflow[wfID],
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"stats": resp, "total": len(resp)})
}

// RavenWorkflowRunResponse is a run in a workflow's history, enriched with
// the requirement's issue for linking and the gate decisions of that run.
type RavenWorkflowRunResponse struct {
	RavenRunResponse
	IssueID string                    `json:"issue_id"`
	Gates   []RavenGateReviewResponse `json:"gates"`
}

// ListRavenWorkflowRuns returns a workflow's run history (newest first) with
// each run's gate decisions attached.
func (h *Handler) ListRavenWorkflowRuns(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workflow id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	runs, err := h.Queries.ListRavenRunsByWorkflow(r.Context(), db.ListRavenRunsByWorkflowParams{
		WorkflowID: idUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		slog.Warn("ListRavenWorkflowRuns failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list workflow runs")
		return
	}
	gates, err := h.Queries.ListRavenGateReviewsByWorkflow(r.Context(), db.ListRavenGateReviewsByWorkflowParams{
		WorkflowID: idUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		slog.Warn("ListRavenWorkflowRuns gates failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list workflow runs")
		return
	}
	gatesByRun := make(map[string][]RavenGateReviewResponse)
	for _, g := range gates {
		key := uuidToString(g.RunID)
		gatesByRun[key] = append(gatesByRun[key], ravenGateToResponse(g))
	}
	resp := make([]RavenWorkflowRunResponse, len(runs))
	for i, run := range runs {
		item := RavenWorkflowRunResponse{
			RavenRunResponse: ravenRunToResponse(db.RavenRun{
				ID:                run.ID,
				WorkspaceID:       run.WorkspaceID,
				RequirementID:     run.RequirementID,
				WorkflowID:        run.WorkflowID,
				TriggerRunID:      run.TriggerRunID,
				Status:            run.Status,
				TerminationReason: run.TerminationReason,
				TokensSpent:       run.TokensSpent,
				UsdSpent:          run.UsdSpent,
				CreatedAt:         run.CreatedAt,
				UpdatedAt:         run.UpdatedAt,
			}),
			IssueID: uuidToString(run.IssueID),
			Gates:   gatesByRun[uuidToString(run.ID)],
		}
		if item.Gates == nil {
			item.Gates = []RavenGateReviewResponse{}
		}
		resp[i] = item
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": resp, "total": len(resp)})
}

// ensureRavenRequirementForWorkflowAssign is the opt-in hook (ADR-0006) —
// thin wrapper deriving the actor from the request; logic lives in
// raven.Service so the GitHub webhook and autopilot paths share it.
func (h *Handler) ensureRavenRequirementForWorkflowAssign(r *http.Request, issue db.Issue, comp *raven.WorkflowComposition) {
	actorType, actorID := ravenActor(r)
	h.ravenService().EnsureRequirementForWorkflowAssign(r.Context(), issue, raven.Actor{Type: actorType, ID: actorID}, comp)
}
