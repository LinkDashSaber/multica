package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/raven"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// DeepDiveRavenRequirement is the manual 沉淀这条 trigger (issue #23,
// ADR-0008): the user forces a deep-dive candidate for a requirement
// regardless of trajectory signals. The candidate is a fresh raven_learning
// row (stage "deep_dive") feeding the S8 learning pipeline.
func (h *Handler) DeepDiveRavenRequirement(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "requirement id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	requirement, err := h.Queries.GetRavenRequirement(r.Context(), db.GetRavenRequirementParams{
		ID: idUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "requirement not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load requirement")
		return
	}
	learning, err := h.ravenService().CreateDeepDiveCandidate(r.Context(), requirement, "manual")
	if err != nil {
		if errors.Is(err, raven.ErrNoRunForDeepDive) {
			writeError(w, http.StatusConflict, "requirement has no run to deep-dive")
			return
		}
		slog.Warn("DeepDiveRavenRequirement failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create deep-dive candidate")
		return
	}
	writeJSON(w, http.StatusCreated, ravenLearningToResponse(learning))
}
