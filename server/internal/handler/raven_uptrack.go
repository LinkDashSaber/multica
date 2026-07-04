package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// 沉淀钩子 ①（issue #10）: when a bare agent/squad issue reaches done without
// ever being on the Raven track, propose "沉淀为交付策略" via a dismissible
// inbox item. Accepting is UI-driven: the item's details carry a ready-made
// draft-issue prompt; the client creates a normal agent issue from it, and
// that agent opens the workflow-draft PR (same agent+PR path the bootstrap
// proved). No new accept endpoint — the inbox item itself is the proposal
// record.

const uptrackProposalType = "raven_uptrack_proposal"

func (h *Handler) ravenProposeUptrackOnDone(ctx context.Context, prev, issue db.Issue) {
	if issue.Status != "done" || prev.Status == "done" {
		return
	}
	at := issue.AssigneeType.String
	if at != "agent" && at != "squad" {
		return
	}
	// Already on the Raven track → nothing to uptrack.
	if _, err := h.Queries.GetRavenRequirementByIssue(ctx, db.GetRavenRequirementByIssueParams{
		IssueID: issue.ID, WorkspaceID: issue.WorkspaceID,
	}); err == nil {
		return
	}
	if issue.CreatorType != "member" && issue.CreatorType != "user" {
		return // no obvious human to propose to
	}
	// One proposal per issue: reopen→done cycles must not spam the inbox.
	if n, err := h.Queries.CountInboxItemsByTypeAndIssue(ctx, db.CountInboxItemsByTypeAndIssueParams{
		Type: uptrackProposalType, IssueID: issue.ID,
	}); err != nil || n > 0 {
		return
	}

	prompt := fmt.Sprintf(
		"你在为一次已完成的交付做沉淀。源 issue ID：%s（标题：%s）。\n"+
			"1. 读取该 issue 的时间线、评论与关联 PR，梳理这次交付实际经过了哪些阶段、哪里需要人拍板。\n"+
			"2. 在仓库 https://github.com/LinkDashSaber/multica 的 packages/raven-workflows/src/trigger/ 下起草一个新的 workflow 文件："+
			"用 defineWorkflow 声明合同（stages 对应梳理出的阶段、需要人确认的点声明为 gates、给出合理 budget/retry），run 骨架用注释标注每阶段意图，参考同目录 feature-delivery.ts 的写法。\n"+
			"3. 建分支提交并创建草稿 PR，标题注明「workflow 草稿：沉淀自 %s」，正文引用源 issue 与本 issue 的 identifier。\n"+
			"完成后回复 PR 链接。",
		uuidToString(issue.ID), issue.Title, uuidToString(issue.ID),
	)
	// Flat string values only: the client types details as Record<string,string>.
	details, _ := json.Marshal(map[string]string{
		"source_issue_id":         uuidToString(issue.ID),
		"suggested_assignee_type": at,
		"suggested_assignee_id":   uuidToString(issue.AssigneeID),
		"draft_issue_title":       "workflow 草稿：沉淀自 " + issue.Title,
		"draft_issue_prompt":      prompt,
	})
	if _, err := h.Queries.CreateInboxItem(ctx, db.CreateInboxItemParams{
		WorkspaceID:   issue.WorkspaceID,
		RecipientType: "member",
		RecipientID:   issue.CreatorID,
		Type:          uptrackProposalType,
		Severity:      "info",
		IssueID:       issue.ID,
		Title:         issue.Title,
		Body:          pgtype.Text{String: "这次交付可以沉淀为交付策略，生成草稿 PR 供审阅", Valid: true},
		ActorType:     pgtype.Text{String: "system", Valid: true},
		ActorID:       pgtype.UUID{},
		Details:       details,
	}); err != nil {
		slog.Warn("raven: uptrack proposal inbox write failed", "error", err)
	}
}
