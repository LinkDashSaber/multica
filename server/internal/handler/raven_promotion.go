package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/raven"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Trust promotion (issue #25, ADR-0009): after 8 consecutive human approvals
// of the same workflow × gate, the platform issues a promotion letter
// (decision point). Human approval downgrades the gate to 1/5 spot checks;
// one spot-check rejection reverts to full review and resets the streak.

const (
	// ravenPromotionThreshold is the consecutive zero-reject count that
	// triggers a promotion letter. Fixed by ADR-0009, not configurable.
	ravenPromotionThreshold = 8
	// ravenSampleRate: 1-in-N gates are spot-checked under a sampled policy.
	ravenSampleRate = 5
)

// ravenSampleIntN rolls the spot-check die; tests inject RavenSampleIntN.
func (h *Handler) ravenSampleIntN(n int) int {
	if h.RavenSampleIntN != nil {
		return h.RavenSampleIntN(n)
	}
	return rand.IntN(n)
}

type RavenPromotionResponse struct {
	ID             string          `json:"id"`
	WorkspaceID    string          `json:"workspace_id"`
	WorkflowID     string          `json:"workflow_id"`
	GateName       string          `json:"gate_name"`
	Status         string          `json:"status"`
	Evidence       json.RawMessage `json:"evidence"`
	DecidedBy      *string         `json:"decided_by"`
	DecisionReason string          `json:"decision_reason"`
	CreatedAt      string          `json:"created_at"`
	DecidedAt      *string         `json:"decided_at"`
}

func ravenPromotionToResponse(p db.RavenPromotion) RavenPromotionResponse {
	resp := RavenPromotionResponse{
		ID:             uuidToString(p.ID),
		WorkspaceID:    uuidToString(p.WorkspaceID),
		WorkflowID:     uuidToString(p.WorkflowID),
		GateName:       p.GateName,
		Status:         p.Status,
		Evidence:       json.RawMessage(p.Evidence),
		DecidedBy:      uuidToPtr(p.DecidedBy),
		DecisionReason: p.DecisionReason,
		CreatedAt:      timestampToString(p.CreatedAt),
	}
	if p.DecidedAt.Valid {
		s := timestampToString(p.DecidedAt)
		resp.DecidedAt = &s
	}
	return resp
}

type RavenGatePolicyResponse struct {
	GateName   string  `json:"gate_name"`
	Mode       string  `json:"mode"`
	Streak     int64   `json:"streak"`
	ApprovedBy *string `json:"approved_by"`
	UpdatedAt  string  `json:"updated_at"`
}

// GetRavenPromotion returns one promotion letter (decision point detail).
func (h *Handler) GetRavenPromotion(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "promotion id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	promotion, err := h.Queries.GetRavenPromotion(r.Context(), db.GetRavenPromotionParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "promotion not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to get promotion")
		return
	}
	writeJSON(w, http.StatusOK, ravenPromotionToResponse(promotion))
}

// DecideRavenPromotion records the human verdict on a promotion letter.
// Approval flips the gate policy to sampled (1/5 spot checks); rejection
// leaves the gate on full review. Humans only, mirroring DecideRavenGate.
func (h *Handler) DecideRavenPromotion(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "promotion id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	if _, isAgent := agentActorFromRequest(r); isAgent {
		writeError(w, http.StatusForbidden, "promotion decisions require a human reviewer")
		return
	}
	userID := requestUserID(r)
	if userID == "" {
		writeError(w, http.StatusForbidden, "promotion decisions require a human reviewer")
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

	promotion, err := h.Queries.DecideRavenPromotion(r.Context(), db.DecideRavenPromotionParams{
		ID: idUUID, WorkspaceID: wsUUID,
		Status:         status,
		DecidedBy:      userUUID,
		DecisionReason: req.Reason,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if _, gerr := h.Queries.GetRavenPromotion(r.Context(), db.GetRavenPromotionParams{ID: idUUID, WorkspaceID: wsUUID}); gerr == nil {
				writeError(w, http.StatusConflict, "promotion already decided")
				return
			}
			writeError(w, http.StatusNotFound, "promotion not found")
			return
		}
		slog.Warn("DecideRavenPromotion failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to decide promotion")
		return
	}

	if status == "approved" {
		if _, err := h.Queries.UpsertRavenGatePolicy(r.Context(), db.UpsertRavenGatePolicyParams{
			WorkspaceID: wsUUID,
			WorkflowID:  promotion.WorkflowID,
			GateName:    promotion.GateName,
			Mode:        "sampled",
			ApprovedBy:  userUUID,
		}); err != nil {
			slog.Warn("DecideRavenPromotion: policy upsert failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to apply gate policy")
			return
		}
	}

	writeJSON(w, http.StatusOK, ravenPromotionToResponse(promotion))
}

// ListRavenWorkflowGatePolicies returns one row per contract-declared gate
// of a workflow: current mode (full | sampled) and the live zero-reject
// streak. Drives the detail page's trust section and the revoke button.
func (h *Handler) ListRavenWorkflowGatePolicies(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workflow id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	workflow, err := h.Queries.GetRavenWorkflow(r.Context(), db.GetRavenWorkflowParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "workflow not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load workflow")
		return
	}
	contract, err := raven.ParseContract(workflow.Contract)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "stored workflow contract is invalid: "+err.Error())
		return
	}
	policies, err := h.Queries.ListRavenGatePoliciesByWorkflow(r.Context(), db.ListRavenGatePoliciesByWorkflowParams{
		WorkflowID: workflow.ID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list gate policies")
		return
	}
	policyByGate := make(map[string]db.RavenGatePolicy, len(policies))
	for _, p := range policies {
		policyByGate[p.GateName] = p
	}

	items := make([]RavenGatePolicyResponse, 0, len(contract.Gates))
	for _, g := range contract.Gates {
		streak, err := h.Queries.GetRavenGateStreak(r.Context(), db.GetRavenGateStreakParams{
			WorkspaceID: wsUUID, WorkflowID: workflow.ID, GateName: g.Name,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to compute gate streak")
			return
		}
		item := RavenGatePolicyResponse{GateName: g.Name, Mode: "full", Streak: streak}
		if p, okP := policyByGate[g.Name]; okP {
			item.Mode = p.Mode
			item.ApprovedBy = uuidToPtr(p.ApprovedBy)
			item.UpdatedAt = timestampToString(p.UpdatedAt)
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"policies": items, "total": len(items)})
}

// RevokeRavenGatePolicy manually reverts a gate to full review at any time.
// Also resets the streak clock: the policy's updated_at becomes the new
// streak boundary, so promotion must be re-earned from zero.
func (h *Handler) RevokeRavenGatePolicy(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workflow id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	if _, isAgent := agentActorFromRequest(r); isAgent {
		writeError(w, http.StatusForbidden, "policy revocation requires a human")
		return
	}
	gateName := chi.URLParam(r, "gateName")
	if gateName == "" {
		writeError(w, http.StatusBadRequest, "gate name is required")
		return
	}
	workflow, err := h.Queries.GetRavenWorkflow(r.Context(), db.GetRavenWorkflowParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "workflow not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load workflow")
		return
	}
	policy, err := h.Queries.UpsertRavenGatePolicy(r.Context(), db.UpsertRavenGatePolicyParams{
		WorkspaceID: wsUUID,
		WorkflowID:  workflow.ID,
		GateName:    gateName,
		Mode:        "full",
	})
	if err != nil {
		slog.Warn("RevokeRavenGatePolicy failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to revoke gate policy")
		return
	}
	writeJSON(w, http.StatusOK, RavenGatePolicyResponse{
		GateName:   policy.GateName,
		Mode:       policy.Mode,
		Streak:     0,
		ApprovedBy: uuidToPtr(policy.ApprovedBy),
		UpdatedAt:  timestampToString(policy.UpdatedAt),
	})
}

// ravenTrustAfterGateDecision runs the trust bookkeeping after a human gate
// verdict: a rejection under a sampled policy reverts the gate to full
// review; the Nth consecutive approval issues a promotion letter. Best
// effort — the gate decision itself already succeeded.
func (h *Handler) ravenTrustAfterGateDecision(r *http.Request, gate db.RavenGateReview) {
	ctx := r.Context()
	requirement, err := h.Queries.GetRavenRequirement(ctx, db.GetRavenRequirementParams{
		ID: gate.RequirementID, WorkspaceID: gate.WorkspaceID,
	})
	if err != nil || !requirement.WorkflowID.Valid {
		return
	}
	workflowID := requirement.WorkflowID

	if gate.Status == "rejected" {
		// Spot-check miss (or any rejection under a sampled policy):
		// immediately back to full review. The rejection timestamp resets
		// the streak by definition of the streak query.
		policy, perr := h.Queries.GetRavenGatePolicy(ctx, db.GetRavenGatePolicyParams{
			WorkflowID: workflowID, GateName: gate.GateName, WorkspaceID: gate.WorkspaceID,
		})
		if perr == nil && policy.Mode == "sampled" {
			if _, err := h.Queries.UpsertRavenGatePolicy(ctx, db.UpsertRavenGatePolicyParams{
				WorkspaceID: gate.WorkspaceID, WorkflowID: workflowID,
				GateName: gate.GateName, Mode: "full",
			}); err != nil {
				slog.Warn("raven: trust revert failed", "error", err)
			}
		}
		return
	}
	if gate.Status != "approved" {
		return
	}

	// Already promoted gates don't apply again.
	if policy, perr := h.Queries.GetRavenGatePolicy(ctx, db.GetRavenGatePolicyParams{
		WorkflowID: workflowID, GateName: gate.GateName, WorkspaceID: gate.WorkspaceID,
	}); perr == nil && policy.Mode == "sampled" {
		return
	}

	streak, err := h.Queries.GetRavenGateStreak(ctx, db.GetRavenGateStreakParams{
		WorkspaceID: gate.WorkspaceID, WorkflowID: workflowID, GateName: gate.GateName,
	})
	if err != nil {
		slog.Warn("raven: streak query failed", "error", err)
		return
	}
	// Issue exactly at the threshold: each streak crosses it once, so a
	// rejected letter is not re-sent on every further approval.
	if streak != ravenPromotionThreshold {
		return
	}

	reviews, err := h.Queries.ListRavenGateStreakReviews(ctx, db.ListRavenGateStreakReviewsParams{
		WorkspaceID: gate.WorkspaceID, WorkflowID: workflowID,
		GateName: gate.GateName, Limit: ravenPromotionThreshold,
	})
	if err != nil {
		slog.Warn("raven: streak evidence query failed", "error", err)
		return
	}
	evidenceItems := make([]RavenGateReviewResponse, len(reviews))
	for i, rev := range reviews {
		evidenceItems[i] = ravenGateToResponse(rev)
	}
	evidence, _ := json.Marshal(evidenceItems)

	promotion, err := h.Queries.CreateRavenPromotion(ctx, db.CreateRavenPromotionParams{
		WorkspaceID: gate.WorkspaceID,
		WorkflowID:  workflowID,
		GateName:    gate.GateName,
		Evidence:    evidence,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return // a pending letter already exists (idempotent)
		}
		slog.Warn("raven: promotion create failed", "error", err)
		return
	}

	h.notifyRavenPromotion(r, requirement, gate, promotion)
}

// notifyRavenPromotion drops an action-required inbox item on the reviewer
// who completed the streak. Best-effort, mirrors notifyRavenGate.
func (h *Handler) notifyRavenPromotion(r *http.Request, requirement db.RavenRequirement, gate db.RavenGateReview, promotion db.RavenPromotion) {
	ctx := r.Context()
	if !gate.DecidedBy.Valid {
		return
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{
		ID: requirement.IssueID, WorkspaceID: requirement.WorkspaceID,
	})
	if err != nil {
		slog.Warn("raven: promotion notify: load issue failed", "error", err)
		return
	}
	details, _ := json.Marshal(map[string]any{
		"promotion_id": uuidToString(promotion.ID),
		"workflow_id":  uuidToString(promotion.WorkflowID),
		"gate_name":    promotion.GateName,
	})
	if _, err := h.Queries.CreateInboxItem(ctx, db.CreateInboxItemParams{
		WorkspaceID:   requirement.WorkspaceID,
		RecipientType: "member",
		RecipientID:   gate.DecidedBy,
		Type:          "raven_promotion_pending",
		Severity:      "action_required",
		IssueID:       issue.ID,
		Title:         issue.Title,
		Body:          pgtype.Text{String: "门禁 " + promotion.GateName + " 连续 8 次零驳回，申请晋升为抽查", Valid: true},
		ActorType:     pgtype.Text{String: "system", Valid: true},
		ActorID:       pgtype.UUID{},
		Details:       details,
	}); err != nil {
		slog.Warn("raven: promotion inbox write failed", "error", err)
	}
}
