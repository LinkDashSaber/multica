package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/raven"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// 沉淀钩子 ①（issue #10, threshold reworked by issue #23 / ADR-0008）: bare
// agent/squad deliveries reaching done are archived (keyword fingerprint,
// zero agent cost); only when >= uptrackThreshold isomorphic deliveries have
// accumulated does the workflow uptrack proposal fire — 宁缺毋滥. The
// proposal is a dismissible inbox item whose details carry a ready-made
// draft-issue prompt plus the isomorphic deliveries as evidence; the client
// creates a normal agent issue from it, and that agent opens the
// workflow-draft PR. No new accept endpoint — the inbox item itself is the
// proposal record.

const uptrackProposalType = "raven_uptrack_proposal"

// uptrackThreshold: ADR-0008 三档门槛 — workflow proposals require N=3
// isomorphic deliveries.
const uptrackThreshold = 3

func (h *Handler) ravenProposeUptrackOnDone(ctx context.Context, prev, issue db.Issue) {
	if issue.Status != "done" || prev.Status == "done" {
		return
	}
	at := issue.AssigneeType.String
	if at != "agent" && at != "squad" {
		return
	}
	// Already on the Raven track → archived at Learned time instead.
	if _, err := h.Queries.GetRavenRequirementByIssue(ctx, db.GetRavenRequirementByIssueParams{
		IssueID: issue.ID, WorkspaceID: issue.WorkspaceID,
	}); err == nil {
		return
	}
	if issue.CreatorType != "member" && issue.CreatorType != "user" {
		return // no obvious human to propose to
	}

	// Zero-cost archive of the bare delivery: this is what makes it count
	// toward the isomorphism threshold. Idempotent per issue.
	archive, err := h.Queries.UpsertRavenArchive(ctx, db.UpsertRavenArchiveParams{
		WorkspaceID: issue.WorkspaceID,
		IssueID:     issue.ID,
		IssueTitle:  issue.Title,
		Keywords:    raven.ExtractKeywords(issue.Title, issue.Description.String),
	})
	if err != nil {
		slog.Warn("raven: uptrack archive write failed", "error", err)
		return
	}
	all, err := h.Queries.ListRavenArchives(ctx, issue.WorkspaceID)
	if err != nil {
		slog.Warn("raven: uptrack archive list failed", "error", err)
		return
	}
	cohort := raven.IsomorphicArchives(archive, all)
	if len(cohort) < uptrackThreshold {
		return // one-off or not-yet-repeated delivery: no proposal
	}

	// One proposal per issue: reopen→done cycles must not spam the inbox.
	if n, err := h.Queries.CountInboxItemsByTypeAndIssue(ctx, db.CountInboxItemsByTypeAndIssueParams{
		Type: uptrackProposalType, IssueID: issue.ID,
	}); err != nil || n > 0 {
		return
	}

	evidence := cohort[:uptrackThreshold] // newest first, includes this delivery
	evidenceLines := ""
	for _, e := range evidence {
		evidenceLines += fmt.Sprintf("- %s（issue ID：%s）\n", e.IssueTitle, uuidToString(e.IssueID))
	}
	prompt := fmt.Sprintf(
		"同一类交付已同构完成 %d 次，你在为它沉淀一个可复用的交付策略。同构交付证据：\n%s"+
			"1. 读取上述 issue 的时间线、评论与关联 PR，梳理这类交付共同经过的阶段、哪里需要人拍板。\n"+
			"2. 在仓库 https://github.com/LinkDashSaber/multica 的 packages/raven-workflows/src/trigger/ 下起草一个新的 workflow 文件："+
			"用 defineWorkflow 声明合同（stages 对应梳理出的阶段、需要人确认的点声明为 gates、给出合理 budget/retry），run 骨架用注释标注每阶段意图，参考同目录 feature-delivery.ts 的写法。\n"+
			"3. 建分支提交并创建草稿 PR，标题注明「workflow 草稿：沉淀自 %s」，正文引用上述 issue 与本 issue 的 identifier。\n"+
			"完成后回复 PR 链接。",
		len(cohort), evidenceLines, issue.Title,
	)
	// Flat string values only: the client types details as Record<string,string>.
	detailMap := map[string]string{
		"source_issue_id":         uuidToString(issue.ID),
		"suggested_assignee_type": at,
		"suggested_assignee_id":   uuidToString(issue.AssigneeID),
		"draft_issue_title":       "workflow 草稿：沉淀自 " + issue.Title,
		"draft_issue_prompt":      prompt,
		"isomorph_count":          strconv.Itoa(len(cohort)),
	}
	for i, e := range evidence {
		n := strconv.Itoa(i + 1)
		detailMap["evidence_issue_id_"+n] = uuidToString(e.IssueID)
		detailMap["evidence_title_"+n] = e.IssueTitle
	}
	details, _ := json.Marshal(detailMap)
	if _, err := h.Queries.CreateInboxItem(ctx, db.CreateInboxItemParams{
		WorkspaceID:   issue.WorkspaceID,
		RecipientType: "member",
		RecipientID:   issue.CreatorID,
		Type:          uptrackProposalType,
		Severity:      "info",
		IssueID:       issue.ID,
		Title:         issue.Title,
		Body:          pgtype.Text{String: fmt.Sprintf("同类交付已同构完成 %d 次，可以沉淀为交付策略，生成草稿 PR 供审阅", len(cohort)), Valid: true},
		ActorType:     pgtype.Text{String: "system", Valid: true},
		ActorID:       pgtype.UUID{},
		Details:       details,
	}); err != nil {
		slog.Warn("raven: uptrack proposal inbox write failed", "error", err)
	}
}
