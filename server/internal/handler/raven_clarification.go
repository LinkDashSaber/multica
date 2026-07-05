package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/raven"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Raven clarification decision points (issue #19): a run suspends with a
// question list until a human answers. Gate reviews and clarifications keep
// separate tables; ListRavenDecisionPoints unifies them at the API layer.

type RavenClarificationResponse struct {
	ID            string          `json:"id"`
	WorkspaceID   string          `json:"workspace_id"`
	RequirementID string          `json:"requirement_id"`
	RunID         *string         `json:"run_id"`
	Stage         string          `json:"stage"`
	Questions     json.RawMessage `json:"questions"`
	Status        string          `json:"status"`
	Answer        string          `json:"answer"`
	AnsweredBy    *string         `json:"answered_by"`
	CreatedAt     string          `json:"created_at"`
	AnsweredAt    *string         `json:"answered_at"`
}

func ravenClarificationToResponse(c db.RavenClarification) RavenClarificationResponse {
	resp := RavenClarificationResponse{
		ID:            uuidToString(c.ID),
		WorkspaceID:   uuidToString(c.WorkspaceID),
		RequirementID: uuidToString(c.RequirementID),
		RunID:         uuidToPtr(c.RunID),
		Stage:         c.Stage,
		Questions:     json.RawMessage(c.Questions),
		Status:        c.Status,
		Answer:        c.Answer,
		AnsweredBy:    uuidToPtr(c.AnsweredBy),
		CreatedAt:     timestampToString(c.CreatedAt),
	}
	if c.AnsweredAt.Valid {
		s := timestampToString(c.AnsweredAt)
		resp.AnsweredAt = &s
	}
	return resp
}

// CreateRavenClarification opens a pending clarification for a requirement.
// Questions must be a non-empty JSON array of {question, options?, recommended?}.
func (h *Handler) CreateRavenClarification(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	var req struct {
		RequirementID string          `json:"requirement_id"`
		RunID         *string         `json:"run_id"`
		Stage         string          `json:"stage"`
		Questions     json.RawMessage `json:"questions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var questions []struct {
		Question string `json:"question"`
	}
	if err := json.Unmarshal(req.Questions, &questions); err != nil || len(questions) == 0 {
		writeError(w, http.StatusBadRequest, "questions must be a non-empty JSON array")
		return
	}
	for _, q := range questions {
		if q.Question == "" {
			writeError(w, http.StatusBadRequest, "every question needs a non-empty question field")
			return
		}
	}
	reqUUID, ok := parseUUIDOrBadRequest(w, req.RequirementID, "requirement_id")
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
	var runUUID pgtype.UUID
	if req.RunID != nil && *req.RunID != "" {
		id, ok := parseUUIDOrBadRequest(w, *req.RunID, "run_id")
		if !ok {
			return
		}
		runUUID = id
	}

	clarification, err := h.Queries.CreateRavenClarification(r.Context(), db.CreateRavenClarificationParams{
		WorkspaceID:   wsUUID,
		RequirementID: requirement.ID,
		RunID:         runUUID,
		Stage:         req.Stage,
		Questions:     []byte(req.Questions),
	})
	if err != nil {
		slog.Warn("CreateRavenClarification failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create clarification")
		return
	}

	h.notifyRavenClarification(r, requirement, clarification)

	writeJSON(w, http.StatusCreated, ravenClarificationToResponse(clarification))
}

// GetRavenClarification returns one clarification (SDK poll).
func (h *Handler) GetRavenClarification(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "clarification id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	clarification, err := h.Queries.GetRavenClarification(r.Context(), db.GetRavenClarificationParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "clarification not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to get clarification")
		return
	}
	writeJSON(w, http.StatusOK, ravenClarificationToResponse(clarification))
}

// ListRavenClarifications returns every clarification of a requirement (any
// status), oldest first — the run room (issue #18) overlays them on the run
// graph and merges them into the execution timeline.
func (h *Handler) ListRavenClarifications(w http.ResponseWriter, r *http.Request) {
	reqUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "requirement id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	list, err := h.Queries.ListRavenClarificationsByRequirement(r.Context(), db.ListRavenClarificationsByRequirementParams{
		RequirementID: reqUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list clarifications")
		return
	}
	resp := make([]RavenClarificationResponse, len(list))
	for i, c := range list {
		resp[i] = ravenClarificationToResponse(c)
	}
	writeJSON(w, http.StatusOK, map[string]any{"clarifications": resp, "total": len(resp)})
}

// AnswerRavenClarification records the human answer (free text or a chosen
// recommended option, verbatim). Humans only; answering twice is a conflict.
func (h *Handler) AnswerRavenClarification(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "clarification id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	if _, isAgent := agentActorFromRequest(r); isAgent {
		writeError(w, http.StatusForbidden, "clarification answers require a human")
		return
	}
	userID := requestUserID(r)
	if userID == "" {
		writeError(w, http.StatusForbidden, "clarification answers require a human")
		return
	}
	userUUID, ok := parseUUIDOrBadRequest(w, userID, "user id")
	if !ok {
		return
	}

	var req struct {
		Answer string `json:"answer"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Answer == "" {
		writeError(w, http.StatusBadRequest, "answer is required")
		return
	}

	clarification, err := h.Queries.AnswerRavenClarification(r.Context(), db.AnswerRavenClarificationParams{
		ID: idUUID, WorkspaceID: wsUUID,
		Answer:     req.Answer,
		AnsweredBy: userUUID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Either unknown or already answered — disambiguate for the caller.
			if _, gerr := h.Queries.GetRavenClarification(r.Context(), db.GetRavenClarificationParams{ID: idUUID, WorkspaceID: wsUUID}); gerr == nil {
				writeError(w, http.StatusConflict, "clarification already answered")
				return
			}
			writeError(w, http.StatusNotFound, "clarification not found")
			return
		}
		slog.Warn("AnswerRavenClarification failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to answer clarification")
		return
	}
	writeJSON(w, http.StatusOK, ravenClarificationToResponse(clarification))
}

// notifyRavenClarification drops an action-required inbox item on the issue
// creator when a clarification opens. Best-effort, mirrors notifyRavenGate.
func (h *Handler) notifyRavenClarification(r *http.Request, requirement db.RavenRequirement, c db.RavenClarification) {
	ctx := r.Context()
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{
		ID: requirement.IssueID, WorkspaceID: requirement.WorkspaceID,
	})
	if err != nil {
		slog.Warn("raven: clarification notify: load issue failed", "error", err)
		return
	}
	if issue.CreatorType != "member" && issue.CreatorType != "user" {
		return // agent-created issues have no obvious human approver yet
	}
	details, _ := json.Marshal(map[string]any{
		"clarification_id": uuidToString(c.ID),
		"stage":            c.Stage,
		"requirement_id":   uuidToString(requirement.ID),
	})
	if _, err := h.Queries.CreateInboxItem(ctx, db.CreateInboxItemParams{
		WorkspaceID:   requirement.WorkspaceID,
		RecipientType: "member",
		RecipientID:   issue.CreatorID,
		Type:          "raven_clarify_pending",
		Severity:      "action_required",
		IssueID:       issue.ID,
		Title:         issue.Title,
		Body:          pgtype.Text{String: "澄清问题等待拍板", Valid: true},
		ActorType:     pgtype.Text{String: "system", Valid: true},
		ActorID:       pgtype.UUID{},
		Details:       details,
	}); err != nil {
		slog.Warn("raven: clarification inbox write failed", "error", err)
	}
}

// --- Unified pending decision points (issue #19) -----------------------------

// RavenDecisionPointResponse is one pending decision point, gate or clarify,
// carrying the three essentials: node position (stage), decision context, and
// response form. Underlying tables stay separate; this is assembly only.
type RavenDecisionPointResponse struct {
	// Kind is "gate" or "clarify".
	Kind          string  `json:"kind"`
	ID            string  `json:"id"`
	WorkspaceID   string  `json:"workspace_id"`
	RequirementID string  `json:"requirement_id"`
	RunID         *string `json:"run_id"`
	// Stage is the contract stage the run is suspended at: the gate's
	// after_stage, or the clarification's recorded stage.
	Stage string `json:"stage"`
	// Title: the gate name for gates; empty for clarifications.
	Title string `json:"title"`
	// Context: the gate's review_package, or {"questions": [...]} for clarify.
	Context json.RawMessage `json:"context"`
	// ResponseKind is "approve_reject" (gate) or "answer" (clarify).
	ResponseKind string `json:"response_kind"`
	Status       string `json:"status"`
	CreatedAt    string `json:"created_at"`
}

// ListRavenDecisionPoints returns the workspace's pending decision queue:
// gate reviews and clarifications merged, oldest first.
func (h *Handler) ListRavenDecisionPoints(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	// ponytail: only the pending queue exists today; history views can add
	// status filters when a consumer needs them.
	if s := r.URL.Query().Get("status"); s != "" && s != "pending" {
		writeError(w, http.StatusBadRequest, `only status=pending is supported`)
		return
	}

	gates, err := h.Queries.ListPendingRavenGateReviewsWithContract(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list pending gates")
		return
	}
	clarifications, err := h.Queries.ListPendingRavenClarifications(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list pending clarifications")
		return
	}

	items := make([]RavenDecisionPointResponse, 0, len(gates)+len(clarifications))
	contractStages := map[string]map[string]string{} // workflow contract JSON → gate name → after_stage
	for _, row := range gates {
		g := row.RavenGateReview
		stage := ""
		if len(row.Contract) > 0 {
			key := string(row.Contract)
			if contractStages[key] == nil {
				m := map[string]string{}
				if contract, err := raven.ParseContract(row.Contract); err == nil {
					for _, cg := range contract.Gates {
						m[cg.Name] = cg.AfterStage
					}
				}
				contractStages[key] = m
			}
			stage = contractStages[key][g.GateName]
		}
		items = append(items, RavenDecisionPointResponse{
			Kind:          "gate",
			ID:            uuidToString(g.ID),
			WorkspaceID:   uuidToString(g.WorkspaceID),
			RequirementID: uuidToString(g.RequirementID),
			RunID:         uuidToPtr(g.RunID),
			Stage:         stage,
			Title:         g.GateName,
			Context:       json.RawMessage(g.ReviewPackage),
			ResponseKind:  "approve_reject",
			Status:        g.Status,
			CreatedAt:     timestampToString(g.CreatedAt),
		})
	}
	for _, c := range clarifications {
		context, _ := json.Marshal(map[string]json.RawMessage{"questions": json.RawMessage(c.Questions)})
		items = append(items, RavenDecisionPointResponse{
			Kind:          "clarify",
			ID:            uuidToString(c.ID),
			WorkspaceID:   uuidToString(c.WorkspaceID),
			RequirementID: uuidToString(c.RequirementID),
			RunID:         uuidToPtr(c.RunID),
			Stage:         c.Stage,
			Title:         "",
			Context:       json.RawMessage(context),
			ResponseKind:  "answer",
			Status:        c.Status,
			CreatedAt:     timestampToString(c.CreatedAt),
		})
	}
	// Oldest first across both kinds; RFC3339 strings sort chronologically.
	sort.SliceStable(items, func(i, j int) bool { return items[i].CreatedAt < items[j].CreatedAt })

	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}
