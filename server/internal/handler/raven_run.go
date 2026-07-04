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

// Raven runs and evidence (ADR-0002). issue : run = 1 : N.

type RavenRunResponse struct {
	ID                string  `json:"id"`
	WorkspaceID       string  `json:"workspace_id"`
	RequirementID     string  `json:"requirement_id"`
	WorkflowID        *string `json:"workflow_id"`
	TriggerRunID      string  `json:"trigger_run_id"`
	Status            string  `json:"status"`
	CurrentStage      string  `json:"current_stage"`
	TerminationReason string  `json:"termination_reason"`
	TokensSpent       int64   `json:"tokens_spent"`
	UsdSpent          float64 `json:"usd_spent"`
	CreatedAt         string  `json:"created_at"`
	UpdatedAt         string  `json:"updated_at"`
}

type RavenEvidenceResponse struct {
	ID            string          `json:"id"`
	RequirementID string          `json:"requirement_id"`
	RunID         *string         `json:"run_id"`
	Kind          string          `json:"kind"`
	Source        string          `json:"source"`
	Summary       string          `json:"summary"`
	Payload       json.RawMessage `json:"payload"`
	CreatedAt     string          `json:"created_at"`
}

func ravenRunToResponse(run db.RavenRun) RavenRunResponse {
	return RavenRunResponse{
		ID:                uuidToString(run.ID),
		WorkspaceID:       uuidToString(run.WorkspaceID),
		RequirementID:     uuidToString(run.RequirementID),
		WorkflowID:        uuidToPtr(run.WorkflowID),
		TriggerRunID:      run.TriggerRunID,
		Status:            run.Status,
		CurrentStage:      run.CurrentStage,
		TerminationReason: run.TerminationReason,
		TokensSpent:       run.TokensSpent,
		UsdSpent:          run.UsdSpent,
		CreatedAt:         timestampToString(run.CreatedAt),
		UpdatedAt:         timestampToString(run.UpdatedAt),
	}
}

func ravenEvidenceToResponse(e db.RavenEvidence) RavenEvidenceResponse {
	return RavenEvidenceResponse{
		ID:            uuidToString(e.ID),
		RequirementID: uuidToString(e.RequirementID),
		RunID:         uuidToPtr(e.RunID),
		Kind:          e.Kind,
		Source:        e.Source,
		Summary:       e.Summary,
		Payload:       json.RawMessage(e.Payload),
		CreatedAt:     timestampToString(e.CreatedAt),
	}
}

var ravenRunStatuses = map[string]bool{
	"pending": true, "running": true, "completed": true, "failed": true, "terminated": true,
}

// CreateRavenRun starts a new run record for a requirement. The run inherits
// the requirement's workflow binding.
func (h *Handler) CreateRavenRun(w http.ResponseWriter, r *http.Request) {
	reqUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "requirement id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	requirement, err := h.Queries.GetRavenRequirement(r.Context(), db.GetRavenRequirementParams{ID: reqUUID, WorkspaceID: wsUUID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "requirement not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load requirement")
		return
	}
	run, err := h.Queries.CreateRavenRun(r.Context(), db.CreateRavenRunParams{
		WorkspaceID:   wsUUID,
		RequirementID: requirement.ID,
		WorkflowID:    requirement.WorkflowID,
		Status:        "pending",
	})
	if err != nil {
		slog.Warn("CreateRavenRun failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create run")
		return
	}
	writeJSON(w, http.StatusCreated, ravenRunToResponse(run))
}

// ListRavenRuns lists a requirement's runs, newest first.
func (h *Handler) ListRavenRuns(w http.ResponseWriter, r *http.Request) {
	reqUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "requirement id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	list, err := h.Queries.ListRavenRunsByRequirement(r.Context(), db.ListRavenRunsByRequirementParams{
		RequirementID: reqUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list runs")
		return
	}
	resp := make([]RavenRunResponse, len(list))
	for i, run := range list {
		resp[i] = ravenRunToResponse(run)
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": resp, "total": len(resp)})
}

// UpdateRavenRun lets the SDK report status / spend / termination reason.
func (h *Handler) UpdateRavenRun(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "run id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	var req struct {
		TriggerRunID      *string  `json:"trigger_run_id"`
		Status            *string  `json:"status"`
		TerminationReason *string  `json:"termination_reason"`
		TokensSpent       *int64   `json:"tokens_spent"`
		UsdSpent          *float64 `json:"usd_spent"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Status != nil && !ravenRunStatuses[*req.Status] {
		writeError(w, http.StatusBadRequest, "unknown run status")
		return
	}

	params := db.UpdateRavenRunParams{ID: idUUID, WorkspaceID: wsUUID}
	params.TriggerRunID = ptrToText(req.TriggerRunID)
	params.Status = ptrToText(req.Status)
	params.TerminationReason = ptrToText(req.TerminationReason)
	if req.TokensSpent != nil {
		params.TokensSpent = pgtype.Int8{Int64: *req.TokensSpent, Valid: true}
	}
	if req.UsdSpent != nil {
		params.UsdSpent = pgtype.Float8{Float64: *req.UsdSpent, Valid: true}
	}

	run, err := h.Queries.UpdateRavenRun(r.Context(), params)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "run not found")
			return
		}
		slog.Warn("UpdateRavenRun failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update run")
		return
	}
	writeJSON(w, http.StatusOK, ravenRunToResponse(run))
}

// CreateRavenEvidence writes one structured evidence record.
func (h *Handler) CreateRavenEvidence(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	var req struct {
		RequirementID string          `json:"requirement_id"`
		RunID         *string         `json:"run_id"`
		Kind          string          `json:"kind"`
		Source        string          `json:"source"`
		Summary       string          `json:"summary"`
		Payload       json.RawMessage `json:"payload"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Kind == "" {
		writeError(w, http.StatusBadRequest, "kind is required")
		return
	}
	reqUUID, ok := parseUUIDOrBadRequest(w, req.RequirementID, "requirement_id")
	if !ok {
		return
	}
	// Tenant guard: the requirement must live in this workspace.
	if _, err := h.Queries.GetRavenRequirement(r.Context(), db.GetRavenRequirementParams{ID: reqUUID, WorkspaceID: wsUUID}); err != nil {
		writeError(w, http.StatusNotFound, "requirement not found")
		return
	}
	var runUUID pgtype.UUID
	if req.RunID != nil && *req.RunID != "" {
		id, ok := parseUUIDOrBadRequest(w, *req.RunID, "run_id")
		if !ok {
			return
		}
		runUUID = id
	}
	payload := req.Payload
	if len(payload) == 0 {
		payload = json.RawMessage("{}")
	}

	evidence, err := h.Queries.CreateRavenEvidence(r.Context(), db.CreateRavenEvidenceParams{
		WorkspaceID:   wsUUID,
		RequirementID: reqUUID,
		RunID:         runUUID,
		Kind:          req.Kind,
		Source:        req.Source,
		Summary:       req.Summary,
		Payload:       []byte(payload),
	})
	if err != nil {
		slog.Warn("CreateRavenEvidence failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create evidence")
		return
	}
	writeJSON(w, http.StatusCreated, ravenEvidenceToResponse(evidence))
}

// ListRavenEvidence lists a requirement's evidence, oldest first.
func (h *Handler) ListRavenEvidence(w http.ResponseWriter, r *http.Request) {
	reqUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "requirement id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	list, err := h.Queries.ListRavenEvidenceByRequirement(r.Context(), db.ListRavenEvidenceByRequirementParams{
		RequirementID: reqUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list evidence")
		return
	}
	resp := make([]RavenEvidenceResponse, len(list))
	for i, e := range list {
		resp[i] = ravenEvidenceToResponse(e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"evidence": resp, "total": len(resp)})
}

// --- Stage progress reporting (issue #15) -----------------------------------

type RavenRunStageEventResponse struct {
	ID        string `json:"id"`
	RunID     string `json:"run_id"`
	Stage     string `json:"stage"`
	Event     string `json:"event"`
	CreatedAt string `json:"created_at"`
}

func ravenRunStageEventToResponse(e db.RavenRunStageEvent) RavenRunStageEventResponse {
	return RavenRunStageEventResponse{
		ID:        uuidToString(e.ID),
		RunID:     uuidToString(e.RunID),
		Stage:     e.Stage,
		Event:     e.Event,
		CreatedAt: timestampToString(e.CreatedAt),
	}
}

// CreateRavenRunStageEvent records a stage entered/exited event from the SDK
// and mirrors it onto the run's current_stage.
func (h *Handler) CreateRavenRunStageEvent(w http.ResponseWriter, r *http.Request) {
	runUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "run id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	var req struct {
		Stage string `json:"stage"`
		Event string `json:"event"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Stage == "" {
		writeError(w, http.StatusBadRequest, "stage is required")
		return
	}
	if req.Event != "entered" && req.Event != "exited" {
		writeError(w, http.StatusBadRequest, `event must be "entered" or "exited"`)
		return
	}
	// Tenant guard: the run must live in this workspace.
	run, err := h.Queries.GetRavenRun(r.Context(), db.GetRavenRunParams{ID: runUUID, WorkspaceID: wsUUID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "run not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load run")
		return
	}

	event, err := h.Queries.CreateRavenRunStageEvent(r.Context(), db.CreateRavenRunStageEventParams{
		WorkspaceID: wsUUID,
		RunID:       run.ID,
		Stage:       req.Stage,
		Event:       req.Event,
	})
	if err != nil {
		slog.Warn("CreateRavenRunStageEvent failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create stage event")
		return
	}

	// current_stage mirrors the latest entered stage; exiting the current
	// stage clears it (the next entered event sets the new one).
	currentStage := ""
	switch {
	case req.Event == "entered":
		currentStage = req.Stage
	case req.Event == "exited" && run.CurrentStage != req.Stage:
		currentStage = run.CurrentStage
	}
	if currentStage != run.CurrentStage {
		if _, err := h.Queries.UpdateRavenRun(r.Context(), db.UpdateRavenRunParams{
			ID: run.ID, WorkspaceID: wsUUID,
			CurrentStage: pgtype.Text{String: currentStage, Valid: true},
		}); err != nil {
			slog.Warn("stage event current_stage update failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to update run stage")
			return
		}
	}
	writeJSON(w, http.StatusCreated, ravenRunStageEventToResponse(event))
}

// ListRavenRunStageEvents returns a run's stage event stream, oldest first.
func (h *Handler) ListRavenRunStageEvents(w http.ResponseWriter, r *http.Request) {
	runUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "run id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	list, err := h.Queries.ListRavenRunStageEventsByRun(r.Context(), db.ListRavenRunStageEventsByRunParams{
		RunID: runUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list stage events")
		return
	}
	resp := make([]RavenRunStageEventResponse, len(list))
	for i, e := range list {
		resp[i] = ravenRunStageEventToResponse(e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": resp, "total": len(resp)})
}

// ravenService returns the Raven domain service, created lazily so tests
// can swap h.Raven directly.
func (h *Handler) ravenService() *raven.Service {
	if h.Raven == nil {
		h.Raven = raven.NewService(h.Queries, raven.NewDispatcherFromEnv())
	}
	return h.Raven
}
