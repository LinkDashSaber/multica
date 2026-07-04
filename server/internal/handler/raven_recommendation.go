package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/raven"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Raven workflow recommendation (issue #9): at issue create/assign time the
// server suggests the best-matching enabled workflow via deterministic
// keyword overlap. Recommendation ≠ dispatch — the user must confirm; every
// recommendation and its outcome is persisted for quality evaluation.

// ravenRecommendationThreshold: below this the recommendation carries a NULL
// workflow_id and the UI offers the Squad fallback instead.
const ravenRecommendationThreshold = 0.2

type RavenRecommendationResponse struct {
	ID           string  `json:"id"`
	WorkflowID   *string `json:"workflow_id"`
	WorkflowName string  `json:"workflow_name"`
	Score        float64 `json:"score"`
	Reason       string  `json:"reason"`
	Outcome      string  `json:"outcome"`
}

func ravenRecommendationToResponse(rec db.RavenWorkflowRecommendation, workflowName string) RavenRecommendationResponse {
	return RavenRecommendationResponse{
		ID:           uuidToString(rec.ID),
		WorkflowID:   uuidToPtr(rec.WorkflowID),
		WorkflowName: workflowName,
		Score:        float64(rec.Score),
		Reason:       rec.Reason,
		Outcome:      rec.Outcome,
	}
}

// CreateRavenRecommendation scores enabled workflows against the issue text.
// The create-issue form calls it with title/description before the issue row
// exists; the assign path may pass issue_id instead to score an existing
// issue's text.
func (h *Handler) CreateRavenRecommendation(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IssueID     string `json:"issue_id"`
		Title       string `json:"title"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}

	issueUUID := pgtype.UUID{}
	text := strings.TrimSpace(req.Title + " " + req.Description)
	if req.IssueID != "" {
		issueUUID, ok = parseUUIDOrBadRequest(w, req.IssueID, "issue id")
		if !ok {
			return
		}
		issue, err := h.Queries.GetIssueInWorkspace(r.Context(), db.GetIssueInWorkspaceParams{
			ID: issueUUID, WorkspaceID: wsUUID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusNotFound, "issue not found")
				return
			}
			slog.Warn("CreateRavenRecommendation get issue failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to create recommendation")
			return
		}
		text = strings.TrimSpace(issue.Title + " " + issue.Description.String)
	}
	if text == "" {
		writeError(w, http.StatusBadRequest, "issue_id or title is required")
		return
	}

	workflows, err := h.Queries.ListRavenWorkflows(r.Context(), wsUUID)
	if err != nil {
		slog.Warn("CreateRavenRecommendation list workflows failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create recommendation")
		return
	}

	var (
		bestScore   float64
		bestMatched []string
		bestWf      *db.RavenWorkflow
	)
	for i, wf := range workflows {
		if !wf.Enabled {
			continue
		}
		score, matched := raven.ScoreWorkflowMatch(text, wf.Name+" "+wf.Description)
		if score > bestScore {
			bestScore, bestMatched, bestWf = score, matched, &workflows[i]
		}
	}

	params := db.CreateRavenRecommendationParams{
		WorkspaceID: wsUUID,
		IssueID:     issueUUID,
		Reason:      "no confident match",
	}
	workflowName := ""
	if bestWf != nil && bestScore >= ravenRecommendationThreshold {
		params.WorkflowID = bestWf.ID
		params.Score = float32(bestScore)
		params.Reason = "matched: " + strings.Join(bestMatched, ", ")
		workflowName = bestWf.Name
	}

	rec, err := h.Queries.CreateRavenRecommendation(r.Context(), params)
	if err != nil {
		slog.Warn("CreateRavenRecommendation insert failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create recommendation")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"recommendation": ravenRecommendationToResponse(rec, workflowName),
	})
}

// UpdateRavenRecommendationOutcome records the user's decision on a
// recommendation: accepted / ignored / fallback_squad.
func (h *Handler) UpdateRavenRecommendationOutcome(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "recommendation id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	var req struct {
		Outcome string `json:"outcome"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	switch req.Outcome {
	case "accepted", "ignored", "fallback_squad":
	default:
		writeError(w, http.StatusBadRequest, "outcome must be one of: accepted, ignored, fallback_squad")
		return
	}

	rec, err := h.Queries.UpdateRavenRecommendationOutcome(r.Context(), db.UpdateRavenRecommendationOutcomeParams{
		ID: idUUID, WorkspaceID: wsUUID, Outcome: req.Outcome,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "recommendation not found")
			return
		}
		slog.Warn("UpdateRavenRecommendationOutcome failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update recommendation")
		return
	}
	// Name lookup skipped on the outcome path — the client already has it.
	writeJSON(w, http.StatusOK, map[string]any{
		"recommendation": ravenRecommendationToResponse(rec, ""),
	})
}
