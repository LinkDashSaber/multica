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
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Execution self-reported learnings (issue #22, ADR-0008 主进料口).
// The SDK writes via ctx.learning(); the 沉淀流 page reads and triages.

type RavenLearningResponse struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	RunID       string `json:"run_id"`
	Stage       string `json:"stage"`
	Content     string `json:"content"`
	Status      string `json:"status"`
	PromotedTo  string `json:"promoted_to"`
	IssueID     string `json:"issue_id,omitempty"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

func ravenLearningToResponse(l db.RavenLearning) RavenLearningResponse {
	return RavenLearningResponse{
		ID:          uuidToString(l.ID),
		WorkspaceID: uuidToString(l.WorkspaceID),
		RunID:       uuidToString(l.RunID),
		Stage:       l.Stage,
		Content:     l.Content,
		Status:      l.Status,
		PromotedTo:  l.PromotedTo,
		CreatedAt:   timestampToString(l.CreatedAt),
		UpdatedAt:   timestampToString(l.UpdatedAt),
	}
}

// promoted_to values a learning may be promoted into (ADR-0008 三类去向).
var ravenLearningPromotedTo = map[string]bool{
	"skill_proposal": true, "fact": true, "uptrack_evidence": true,
}

// CreateRavenLearning records one self-reported learning from a run. When
// stage is omitted, it snapshots the run's current stage so provenance is
// zero-config for the SDK.
func (h *Handler) CreateRavenLearning(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	var req struct {
		RunID   string `json:"run_id"`
		Stage   string `json:"stage"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}
	runUUID, ok := parseUUIDOrBadRequest(w, req.RunID, "run_id")
	if !ok {
		return
	}
	// Tenant guard: the run must live in this workspace. Also the source of
	// the default stage.
	run, err := h.Queries.GetRavenRun(r.Context(), db.GetRavenRunParams{ID: runUUID, WorkspaceID: wsUUID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "run not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load run")
		return
	}
	stage := req.Stage
	if stage == "" {
		stage = run.CurrentStage
	}

	learning, err := h.Queries.CreateRavenLearning(r.Context(), db.CreateRavenLearningParams{
		WorkspaceID: wsUUID,
		RunID:       run.ID,
		Stage:       stage,
		Content:     req.Content,
	})
	if err != nil {
		slog.Warn("CreateRavenLearning failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create learning")
		return
	}
	writeJSON(w, http.StatusCreated, ravenLearningToResponse(learning))
}

// ListRavenLearnings returns the workspace learning stream, newest first,
// optionally filtered by run (?run_id=). Each row carries the requirement's
// issue_id for linking back to the origin.
func (h *Handler) ListRavenLearnings(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	var runUUID pgtype.UUID
	if s := r.URL.Query().Get("run_id"); s != "" {
		id, ok := parseUUIDOrBadRequest(w, s, "run_id")
		if !ok {
			return
		}
		runUUID = id
	}
	list, err := h.Queries.ListRavenLearnings(r.Context(), db.ListRavenLearningsParams{
		WorkspaceID: wsUUID,
		RunID:       runUUID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list learnings")
		return
	}
	resp := make([]RavenLearningResponse, len(list))
	for i, row := range list {
		resp[i] = RavenLearningResponse{
			ID:          uuidToString(row.ID),
			WorkspaceID: uuidToString(row.WorkspaceID),
			RunID:       uuidToString(row.RunID),
			Stage:       row.Stage,
			Content:     row.Content,
			Status:      row.Status,
			PromotedTo:  row.PromotedTo,
			IssueID:     uuidToString(row.IssueID),
			CreatedAt:   timestampToString(row.CreatedAt),
			UpdatedAt:   timestampToString(row.UpdatedAt),
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"learnings": resp, "total": len(resp)})
}

// UpdateRavenLearningStatus triages a fresh learning: promote it (with a
// destination) or expire it. Non-fresh entries return 409 — triage is
// one-shot by design (S9 consumes promoted entries).
func (h *Handler) UpdateRavenLearningStatus(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "learning id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	var req struct {
		Status     string `json:"status"`
		PromotedTo string `json:"promoted_to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	switch req.Status {
	case "promoted":
		if !ravenLearningPromotedTo[req.PromotedTo] {
			writeError(w, http.StatusBadRequest, `promoted_to must be "skill_proposal", "fact" or "uptrack_evidence"`)
			return
		}
	case "expired":
		req.PromotedTo = ""
	default:
		writeError(w, http.StatusBadRequest, `status must be "promoted" or "expired"`)
		return
	}

	learning, err := h.Queries.UpdateRavenLearningStatus(r.Context(), db.UpdateRavenLearningStatusParams{
		ID:          idUUID,
		WorkspaceID: wsUUID,
		Status:      req.Status,
		PromotedTo:  req.PromotedTo,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Either it doesn't exist in this workspace, or it was already
			// triaged. Distinguish for a useful status code.
			if _, getErr := h.Queries.GetRavenLearning(r.Context(), db.GetRavenLearningParams{ID: idUUID, WorkspaceID: wsUUID}); getErr == nil {
				writeError(w, http.StatusConflict, "learning already triaged")
				return
			}
			writeError(w, http.StatusNotFound, "learning not found")
			return
		}
		slog.Warn("UpdateRavenLearningStatus failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update learning")
		return
	}
	writeJSON(w, http.StatusOK, ravenLearningToResponse(learning))
}
