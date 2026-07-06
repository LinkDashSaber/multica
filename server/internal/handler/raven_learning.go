package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Execution self-reported learnings (issue #22, ADR-0008 主进料口).
// The SDK writes via ctx.learning(); the 沉淀流 page reads and triages.

// RavenLearningAsset is the reusable asset a promotion produced (issue #28).
// skill_id links to a minted skill draft; workflow_id links to the workflow
// whose trust promotion this evidence supports. Absent (null) on fresh /
// expired rows.
type RavenLearningAsset struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	SkillID    string `json:"skill_id,omitempty"`
	WorkflowID string `json:"workflow_id,omitempty"`
}

type RavenLearningResponse struct {
	ID          string              `json:"id"`
	WorkspaceID string              `json:"workspace_id"`
	RunID       string              `json:"run_id"`
	Stage       string              `json:"stage"`
	Content     string              `json:"content"`
	Status      string              `json:"status"`
	PromotedTo  string              `json:"promoted_to"`
	IssueID     string              `json:"issue_id,omitempty"`
	Asset       *RavenLearningAsset `json:"asset,omitempty"`
	CreatedAt   string              `json:"created_at"`
	UpdatedAt   string              `json:"updated_at"`
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

func ravenAssetToLearningAsset(a db.RavenAsset) *RavenLearningAsset {
	return &RavenLearningAsset{
		ID:         uuidToString(a.ID),
		Kind:       a.Kind,
		Title:      a.Title,
		SkillID:    uuidToString(a.SkillID),
		WorkflowID: uuidToString(a.WorkflowID),
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
		item := RavenLearningResponse{
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
		// LEFT JOIN: only promoted rows carry an asset.
		if row.AssetID.Valid {
			item.Asset = &RavenLearningAsset{
				ID:         uuidToString(row.AssetID),
				Kind:       row.AssetKind.String,
				Title:      row.AssetTitle.String,
				SkillID:    uuidToString(row.AssetSkillID),
				WorkflowID: uuidToString(row.AssetWorkflowID),
			}
		}
		resp[i] = item
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

	// Promotion produces a reusable asset (issue #28) and flips status in one
	// transaction; expiry is a plain status write.
	var (
		learning db.RavenLearning
		asset    *db.RavenAsset
		err      error
	)
	if req.Status == "promoted" {
		learning, asset, err = h.promoteRavenLearning(r, idUUID, wsUUID, req.PromotedTo)
	} else {
		learning, err = h.Queries.UpdateRavenLearningStatus(r.Context(), db.UpdateRavenLearningStatusParams{
			ID:          idUUID,
			WorkspaceID: wsUUID,
			Status:      req.Status,
			PromotedTo:  req.PromotedTo,
		})
	}
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
	resp := ravenLearningToResponse(learning)
	if asset != nil {
		resp.Asset = ravenAssetToLearningAsset(*asset)
	}
	writeJSON(w, http.StatusOK, resp)
}

// promoteRavenLearning flips a fresh learning to promoted and produces the
// reusable asset for its destination in one transaction (issue #28). The
// status flip (WHERE status='fresh') is the idempotency guard: a concurrent
// re-promote loses the UPDATE race, gets pgx.ErrNoRows, and creates no asset —
// so no duplicate assets. Callers map ErrNoRows to 409/404.
func (h *Handler) promoteRavenLearning(r *http.Request, learningID, wsID pgtype.UUID, dest string) (db.RavenLearning, *db.RavenAsset, error) {
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return db.RavenLearning{}, nil, err
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)

	learning, err := qtx.UpdateRavenLearningStatus(ctx, db.UpdateRavenLearningStatusParams{
		ID:          learningID,
		WorkspaceID: wsID,
		Status:      "promoted",
		PromotedTo:  dest,
	})
	if err != nil {
		return db.RavenLearning{}, nil, err
	}

	asset, err := h.buildLearningAsset(ctx, qtx, r, learning)
	if err != nil {
		return db.RavenLearning{}, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return db.RavenLearning{}, nil, err
	}
	return learning, &asset, nil
}

// buildLearningAsset materializes the reusable asset for a promoted learning.
// skill_proposal additionally mints a real skill draft; uptrack_evidence links
// to the run's workflow when one is known. All writes share the caller's tx.
func (h *Handler) buildLearningAsset(ctx context.Context, qtx *db.Queries, r *http.Request, learning db.RavenLearning) (db.RavenAsset, error) {
	title := learningAssetTitle(learning.Content)
	params := db.CreateRavenAssetParams{
		WorkspaceID: learning.WorkspaceID,
		LearningID:  learning.ID,
		Kind:        learning.PromotedTo,
		Title:       title,
		Content:     learning.Content,
	}

	switch learning.PromotedTo {
	case "skill_proposal":
		name := title
		if name == "" {
			name = "沉淀技能提议"
		}
		// Skill name is UNIQUE per workspace; suffix with the learning's short
		// id so distinct self-reports never collide. Reads as a draft the user
		// renames when accepting the proposal.
		name = name + " · " + uuidToString(learning.ID)[:8]
		skill, err := createSkillWithFilesInTx(ctx, qtx, skillCreateInput{
			WorkspaceID: learning.WorkspaceID,
			CreatorID:   requestUserUUID(r),
			Name:        name,
			Description: "沉淀自执行自报（issue #28）",
			Content:     learning.Content,
			Config: map[string]any{
				"origin":             "raven_learning",
				"source_learning_id": uuidToString(learning.ID),
				"status":             "proposed",
			},
		})
		if err != nil {
			return db.RavenAsset{}, err
		}
		params.SkillID = parseUUID(skill.ID) // trusted round-trip from our own insert
	case "uptrack_evidence":
		// Tie the evidence to the workflow whose trust promotion it supports.
		// Bare-track runs carry no workflow; the evidence still stands alone.
		if run, err := qtx.GetRavenRun(ctx, db.GetRavenRunParams{ID: learning.RunID, WorkspaceID: learning.WorkspaceID}); err == nil && run.WorkflowID.Valid {
			params.WorkflowID = run.WorkflowID
		}
	case "fact":
		// The asset row itself is the confirmed 事实与口径 record.
	}

	return qtx.CreateRavenAsset(ctx, params)
}

// learningAssetTitle derives a short human title from a freeform self-report:
// its first non-empty line, trimmed to 80 runes.
func learningAssetTitle(content string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		runes := []rune(line)
		if len(runes) > 80 {
			return string(runes[:80]) + "…"
		}
		return line
	}
	return ""
}

// requestUserUUID resolves the human actor for created_by, or a null UUID when
// the caller is an agent or unauthenticated (created_by is nullable).
func requestUserUUID(r *http.Request) pgtype.UUID {
	if s := requestUserID(r); s != "" {
		if id, err := util.ParseUUID(s); err == nil {
			return id
		}
	}
	return pgtype.UUID{}
}
