package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/raven"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Raven requirement lifecycle endpoints (ADR-0006). A requirement is the
// lifecycle record attached to an issue that opted into the Raven track;
// issues without one keep native multica behavior untouched.

type RavenRequirementResponse struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspace_id"`
	IssueID     string   `json:"issue_id"`
	WorkflowID  *string  `json:"workflow_id"`
	State       string   `json:"state"`
	NextStates  []string `json:"next_states"`
	// IsomorphCount is how many archived deliveries (including this one)
	// look isomorphic to this requirement's Learned archive. 0 until the
	// requirement is archived; populated on the detail endpoint only.
	IsomorphCount int    `json:"isomorph_count"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

type RavenTransitionResponse struct {
	ID        string `json:"id"`
	FromState string `json:"from_state"`
	ToState   string `json:"to_state"`
	ActorType string `json:"actor_type"`
	ActorID   string `json:"actor_id"`
	Reason    string `json:"reason"`
	CreatedAt string `json:"created_at"`
}

func ravenRequirementToResponse(req db.RavenRequirement) RavenRequirementResponse {
	next := raven.NextStates(raven.State(req.State))
	nextStrs := make([]string, len(next))
	for i, s := range next {
		nextStrs[i] = string(s)
	}
	return RavenRequirementResponse{
		ID:          uuidToString(req.ID),
		WorkspaceID: uuidToString(req.WorkspaceID),
		IssueID:     uuidToString(req.IssueID),
		WorkflowID:  uuidToPtr(req.WorkflowID),
		State:       req.State,
		NextStates:  nextStrs,
		CreatedAt:   timestampToString(req.CreatedAt),
		UpdatedAt:   timestampToString(req.UpdatedAt),
	}
}

func ravenTransitionToResponse(t db.RavenRequirementTransition) RavenTransitionResponse {
	return RavenTransitionResponse{
		ID:        uuidToString(t.ID),
		FromState: t.FromState,
		ToState:   t.ToState,
		ActorType: t.ActorType,
		ActorID:   t.ActorID,
		Reason:    t.Reason,
		CreatedAt: timestampToString(t.CreatedAt),
	}
}

// ravenActor derives the transition actor from request identity. Task-token
// authenticated agents count as agents; anything with a user stamp is a
// user; internal calls without identity are system.
func ravenActor(r *http.Request) (actorType, actorID string) {
	if agent, ok := agentActorFromRequest(r); ok {
		return "agent", agent
	}
	if userID := requestUserID(r); userID != "" {
		return "user", userID
	}
	return "system", ""
}

// agentActorFromRequest reports the agent identity when the request came
// through a task-scoped token. Kept minimal: the X-Agent-ID header is set
// by auth middleware for task-token requests.
func agentActorFromRequest(r *http.Request) (string, bool) {
	if r.Header.Get("X-Actor-Source") == "task_token" {
		return r.Header.Get("X-Agent-ID"), true
	}
	return "", false
}

// CreateRavenRequirement opts an issue into the Raven lifecycle. The issue
// must exist in the caller's workspace; one requirement per issue.
func (h *Handler) CreateRavenRequirement(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IssueID string `json:"issue_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	issueUUID, ok := parseUUIDOrBadRequest(w, req.IssueID, "issue_id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
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
		slog.Warn("CreateRavenRequirement: load issue failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load issue")
		return
	}

	requirement, err := h.Queries.CreateRavenRequirement(r.Context(), db.CreateRavenRequirementParams{
		WorkspaceID: wsUUID,
		IssueID:     issue.ID,
		State:       string(raven.StateIdea),
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "issue already has a lifecycle requirement")
			return
		}
		slog.Warn("CreateRavenRequirement failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create requirement")
		return
	}

	actorType, actorID := ravenActor(r)
	if _, err := h.Queries.InsertRavenTransition(r.Context(), db.InsertRavenTransitionParams{
		RequirementID: requirement.ID,
		FromState:     "",
		ToState:       string(raven.StateIdea),
		ActorType:     actorType,
		ActorID:       actorID,
		Reason:        "requirement created",
	}); err != nil {
		slog.Warn("CreateRavenRequirement: record creation transition failed", append(logger.RequestAttrs(r), "error", err)...)
	}

	h.projectRavenStateToIssue(r, requirement)

	writeJSON(w, http.StatusCreated, ravenRequirementToResponse(requirement))
}

// GetRavenRequirement returns one requirement with its legal next states.
func (h *Handler) GetRavenRequirement(w http.ResponseWriter, r *http.Request) {
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
		slog.Warn("GetRavenRequirement failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to get requirement")
		return
	}
	resp := ravenRequirementToResponse(requirement)
	// Isomorphism count is a query over the Learned archive (ADR-0008), not
	// a separate system. ponytail: O(n) workspace scan; fine at v1 scale.
	if archive, err := h.Queries.GetRavenArchiveByRequirement(r.Context(), db.GetRavenArchiveByRequirementParams{
		RequirementID: requirement.ID, WorkspaceID: wsUUID,
	}); err == nil {
		if all, err := h.Queries.ListRavenArchives(r.Context(), wsUUID); err == nil {
			resp.IsomorphCount = len(raven.IsomorphicArchives(archive, all))
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// GetRavenRequirementForIssue returns the requirement attached to an issue,
// or 404 when the issue never opted in — the boundary the UI badge keys on.
func (h *Handler) GetRavenRequirementForIssue(w http.ResponseWriter, r *http.Request) {
	issueUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "issueId"), "issue id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	requirement, err := h.Queries.GetRavenRequirementByIssue(r.Context(), db.GetRavenRequirementByIssueParams{
		IssueID: issueUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "issue has no lifecycle requirement")
			return
		}
		slog.Warn("GetRavenRequirementForIssue failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to get requirement")
		return
	}
	writeJSON(w, http.StatusOK, ravenRequirementToResponse(requirement))
}

// ListRavenRequirements returns every requirement in the workspace.
func (h *Handler) ListRavenRequirements(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	list, err := h.Queries.ListRavenRequirements(r.Context(), wsUUID)
	if err != nil {
		slog.Warn("ListRavenRequirements failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list requirements")
		return
	}
	resp := make([]RavenRequirementResponse, len(list))
	for i, item := range list {
		resp[i] = ravenRequirementToResponse(item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"requirements": resp, "total": len(resp)})
}

// ListRavenTransitions returns the append-only state history of a requirement.
func (h *Handler) ListRavenTransitions(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "requirement id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	list, err := h.Queries.ListRavenTransitions(r.Context(), db.ListRavenTransitionsParams{
		RequirementID: idUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		slog.Warn("ListRavenTransitions failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list transitions")
		return
	}
	resp := make([]RavenTransitionResponse, len(list))
	for i, item := range list {
		resp[i] = ravenTransitionToResponse(item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"transitions": resp, "total": len(resp)})
}

// TransitionRavenRequirement applies one lifecycle state change. Illegal
// transitions are rejected with 409 and the list of legal successors.
func (h *Handler) TransitionRavenRequirement(w http.ResponseWriter, r *http.Request) {
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "requirement id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}

	var req struct {
		ToState string `json:"to_state"`
		Reason  string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	to := raven.State(req.ToState)
	if !raven.ValidState(to) {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown state %q", req.ToState))
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
		slog.Warn("TransitionRavenRequirement: load failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load requirement")
		return
	}

	updated, err := h.applyRavenTransition(r, requirement, to, req.Reason)
	if err != nil {
		if errors.Is(err, errIllegalRavenTransition) {
			from := raven.State(requirement.State)
			writeError(w, http.StatusConflict, fmt.Sprintf(
				"illegal transition %s → %s; legal next states: %v", from, to, raven.NextStates(from)))
			return
		}
		slog.Warn("TransitionRavenRequirement: update failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update state")
		return
	}

	writeJSON(w, http.StatusOK, ravenRequirementToResponse(updated))
}

var errIllegalRavenTransition = raven.ErrIllegalTransition

// applyRavenTransition delegates to raven.Service with the request actor.
func (h *Handler) applyRavenTransition(r *http.Request, requirement db.RavenRequirement, to raven.State, reason string) (db.RavenRequirement, error) {
	actorType, actorID := ravenActor(r)
	return h.ravenService().ApplyTransition(r.Context(), requirement, to, raven.Actor{Type: actorType, ID: actorID}, reason)
}

// projectRavenStateToIssue delegates to raven.Service.
func (h *Handler) projectRavenStateToIssue(r *http.Request, requirement db.RavenRequirement) {
	h.ravenService().ProjectStateToIssue(r.Context(), requirement)
}
