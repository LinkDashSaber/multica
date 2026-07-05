package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/raven"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Raven gate reviews (产品定义 §5): gate() suspends a run, a human decides.

type RavenGateReviewResponse struct {
	ID             string          `json:"id"`
	WorkspaceID    string          `json:"workspace_id"`
	RequirementID  string          `json:"requirement_id"`
	RunID          *string         `json:"run_id"`
	GateName       string          `json:"gate_name"`
	Status         string          `json:"status"`
	ReviewPackage  json.RawMessage `json:"review_package"`
	DecidedBy      *string         `json:"decided_by"`
	DecisionReason string          `json:"decision_reason"`
	// SampleResult: "" (full review), "selected" (spot check hit), or
	// "auto_approved" (spot check miss, issue #25).
	SampleResult string  `json:"sample_result"`
	CreatedAt    string  `json:"created_at"`
	DecidedAt    *string `json:"decided_at"`
}

func ravenGateToResponse(g db.RavenGateReview) RavenGateReviewResponse {
	resp := RavenGateReviewResponse{
		ID:             uuidToString(g.ID),
		WorkspaceID:    uuidToString(g.WorkspaceID),
		RequirementID:  uuidToString(g.RequirementID),
		RunID:          uuidToPtr(g.RunID),
		GateName:       g.GateName,
		Status:         g.Status,
		ReviewPackage:  json.RawMessage(g.ReviewPackage),
		DecidedBy:      uuidToPtr(g.DecidedBy),
		DecisionReason: g.DecisionReason,
		SampleResult:   g.SampleResult,
		CreatedAt:      timestampToString(g.CreatedAt),
	}
	if g.DecidedAt.Valid {
		s := timestampToString(g.DecidedAt)
		resp.DecidedAt = &s
	}
	return resp
}

// CreateRavenGate opens a pending gate review for a requirement and moves the
// lifecycle to needs_review. The gate name must be declared in the workflow
// contract — undeclared gates cannot exist at runtime (ADR-0005).
func (h *Handler) CreateRavenGate(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	var req struct {
		RequirementID string          `json:"requirement_id"`
		RunID         *string         `json:"run_id"`
		GateName      string          `json:"gate_name"`
		ReviewPackage json.RawMessage `json:"review_package"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.GateName == "" {
		writeError(w, http.StatusBadRequest, "gate_name is required")
		return
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

	// The gate must exist in the bound workflow's contract.
	if !requirement.WorkflowID.Valid {
		writeError(w, http.StatusBadRequest, "requirement has no workflow binding")
		return
	}
	workflow, err := h.Queries.GetRavenWorkflow(r.Context(), db.GetRavenWorkflowParams{ID: requirement.WorkflowID, WorkspaceID: wsUUID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load workflow")
		return
	}
	contract, err := raven.ParseContract(workflow.Contract)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "stored workflow contract is invalid: "+err.Error())
		return
	}
	declared := false
	for _, g := range contract.Gates {
		if g.Name == req.GateName {
			declared = true
			break
		}
	}
	if !declared {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("gate %q is not declared in the workflow contract", req.GateName))
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
	reviewPackage := req.ReviewPackage
	if len(reviewPackage) == 0 {
		reviewPackage = json.RawMessage("{}")
	}

	// Trust promotion (issue #25): under a sampled policy only 1-in-N gates
	// go to a human; the rest auto-pass with a permanent trace.
	sampleResult := ""
	if policy, perr := h.Queries.GetRavenGatePolicy(r.Context(), db.GetRavenGatePolicyParams{
		WorkflowID: requirement.WorkflowID, GateName: req.GateName, WorkspaceID: wsUUID,
	}); perr == nil && policy.Mode == "sampled" {
		if h.ravenSampleIntN(ravenSampleRate) == 0 {
			sampleResult = "selected" // spot check hit → normal human review
		} else {
			gate, err := h.Queries.CreateAutoApprovedRavenGateReview(r.Context(), db.CreateAutoApprovedRavenGateReviewParams{
				WorkspaceID:    wsUUID,
				RequirementID:  requirement.ID,
				RunID:          runUUID,
				GateName:       req.GateName,
				ReviewPackage:  []byte(reviewPackage),
				DecisionReason: "抽查未命中，自动通过",
			})
			if err != nil {
				slog.Warn("CreateRavenGate auto-approve failed", append(logger.RequestAttrs(r), "error", err)...)
				writeError(w, http.StatusInternalServerError, "failed to create gate review")
				return
			}
			// No lifecycle suspension and no inbox noise: the run continues.
			writeJSON(w, http.StatusCreated, ravenGateToResponse(gate))
			return
		}
	}

	gate, err := h.Queries.CreateRavenGateReview(r.Context(), db.CreateRavenGateReviewParams{
		WorkspaceID:   wsUUID,
		RequirementID: requirement.ID,
		RunID:         runUUID,
		GateName:      req.GateName,
		ReviewPackage: []byte(reviewPackage),
		SampleResult:  sampleResult,
	})
	if err != nil {
		slog.Warn("CreateRavenGate failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create gate review")
		return
	}

	// Lifecycle: running → needs_review. A gate opened from another state is
	// tolerated (review still exists); the transition is just skipped.
	if _, err := h.applyRavenTransition(r, requirement, raven.StateNeedsReview,
		"gate "+req.GateName+" pending"); err != nil && !errors.Is(err, errIllegalRavenTransition) {
		slog.Warn("CreateRavenGate: transition failed", append(logger.RequestAttrs(r), "error", err)...)
	}

	h.notifyRavenGate(r, requirement, gate)

	writeJSON(w, http.StatusCreated, ravenGateToResponse(gate))
}

// GetRavenGate returns one gate review (SDK poll + review page).
func (h *Handler) GetRavenGate(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "gate id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	gate, err := h.Queries.GetRavenGateReview(r.Context(), db.GetRavenGateReviewParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "gate review not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to get gate review")
		return
	}
	writeJSON(w, http.StatusOK, ravenGateToResponse(gate))
}

// ListRavenGates lists gate reviews: all for a requirement (?requirement_id=)
// or the workspace's pending queue (default).
func (h *Handler) ListRavenGates(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	var list []db.RavenGateReview
	var err error
	if reqID := r.URL.Query().Get("requirement_id"); reqID != "" {
		reqUUID, okParse := parseUUIDOrBadRequest(w, reqID, "requirement_id")
		if !okParse {
			return
		}
		list, err = h.Queries.ListRavenGateReviewsByRequirement(r.Context(), db.ListRavenGateReviewsByRequirementParams{
			RequirementID: reqUUID, WorkspaceID: wsUUID,
		})
	} else {
		list, err = h.Queries.ListPendingRavenGateReviews(r.Context(), wsUUID)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list gate reviews")
		return
	}
	resp := make([]RavenGateReviewResponse, len(list))
	for i, g := range list {
		resp[i] = ravenGateToResponse(g)
	}
	writeJSON(w, http.StatusOK, map[string]any{"gates": resp, "total": len(resp)})
}

// DecideRavenGate records the human verdict. Only pending gates can be
// decided, only humans can decide, and rejection requires a reason.
func (h *Handler) DecideRavenGate(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "gate id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	// Gate verdicts are a human-only surface: task-token (agent) callers are
	// rejected outright.
	if _, isAgent := agentActorFromRequest(r); isAgent {
		writeError(w, http.StatusForbidden, "gate decisions require a human reviewer")
		return
	}
	userID := requestUserID(r)
	if userID == "" {
		writeError(w, http.StatusForbidden, "gate decisions require a human reviewer")
		return
	}
	userUUID, ok := parseUUIDOrBadRequest(w, userID, "user id")
	if !ok {
		return
	}

	var req struct {
		Approve bool   `json:"approve"`
		Reason  string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !req.Approve && req.Reason == "" {
		writeError(w, http.StatusBadRequest, "rejection requires a reason")
		return
	}
	status := "approved"
	if !req.Approve {
		status = "rejected"
	}

	gate, err := h.Queries.DecideRavenGateReview(r.Context(), db.DecideRavenGateReviewParams{
		ID: idUUID, WorkspaceID: wsUUID,
		Status:         status,
		DecidedBy:      userUUID,
		DecisionReason: req.Reason,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Either unknown or already decided — disambiguate for the caller.
			if _, gerr := h.Queries.GetRavenGateReview(r.Context(), db.GetRavenGateReviewParams{ID: idUUID, WorkspaceID: wsUUID}); gerr == nil {
				writeError(w, http.StatusConflict, "gate review already decided")
				return
			}
			writeError(w, http.StatusNotFound, "gate review not found")
			return
		}
		slog.Warn("DecideRavenGate failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to decide gate review")
		return
	}

	// Trust bookkeeping (issue #25): revert on sampled rejection, issue a
	// promotion letter on the Nth consecutive approval.
	h.ravenTrustAfterGateDecision(r, gate)

	writeJSON(w, http.StatusOK, ravenGateToResponse(gate))
}

// notifyRavenGate drops an action-required inbox item on the issue creator
// (v1's approver) when a gate opens. Best-effort.
func (h *Handler) notifyRavenGate(r *http.Request, requirement db.RavenRequirement, gate db.RavenGateReview) {
	ctx := r.Context()
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{
		ID: requirement.IssueID, WorkspaceID: requirement.WorkspaceID,
	})
	if err != nil {
		slog.Warn("raven: gate notify: load issue failed", "error", err)
		return
	}
	if issue.CreatorType != "member" && issue.CreatorType != "user" {
		return // agent-created issues have no obvious human approver yet
	}
	details, _ := json.Marshal(map[string]any{
		"gate_id":        uuidToString(gate.ID),
		"gate_name":      gate.GateName,
		"requirement_id": uuidToString(requirement.ID),
	})
	if _, err := h.Queries.CreateInboxItem(ctx, db.CreateInboxItemParams{
		WorkspaceID:   requirement.WorkspaceID,
		RecipientType: "member",
		RecipientID:   issue.CreatorID,
		Type:          "raven_gate_pending",
		Severity:      "action_required",
		IssueID:       issue.ID,
		Title:         issue.Title,
		Body:          pgtype.Text{String: "门禁 " + gate.GateName + " 等待审查", Valid: true},
		ActorType:     pgtype.Text{String: "system", Valid: true},
		ActorID:       pgtype.UUID{},
		Details:       details,
	}); err != nil {
		slog.Warn("raven: gate inbox write failed", "error", err)
	}
}
