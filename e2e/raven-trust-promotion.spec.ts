import { test, expect } from "@playwright/test";
import { loginAsDefault, createTestApi, waitForPageText } from "./helpers";
import type { TestApiClient } from "./fixtures";

const ROUTE_CHANGE_TIMEOUT = 30000;

/**
 * Trust promotion smoke (issue #25, ADR-0009): 8 consecutive zero-reject
 * gate approvals issue a promotion decision point; approving it downgrades
 * the gate to spot checks ("production line" in the workflow list); the
 * detail page can manually revoke back to full review.
 */
test.describe("Raven trust promotion", () => {
  let api: TestApiClient;

  test.afterEach(async () => {
    await api?.cleanup();
  });

  test("streak → promotion letter → production line → manual revoke", async ({ page }) => {
    api = await createTestApi();

    // Workflow + Raven-opted issue, requirement advanced to running.
    const name = `e2e-trust-${Date.now().toString(36)}`;
    const wfRes = await api.apiFetch("/api/raven/workflows", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: "E2E trust promotion workflow",
        contract: {
          stages: [{ name: "implement" }, { name: "self-check" }],
          gates: [{ name: "human-review", after_stage: "self-check" }],
          budget: { max_tokens: 1_000_000 },
        },
      }),
    });
    expect(wfRes.status).toBe(201);
    const workflow = (await wfRes.json()) as { id: string };
    const issue = await api.createIssue(`raven trust e2e ${name}`, {
      status: "backlog",
      priority: "medium",
      assignee_type: "workflow",
      assignee_id: workflow.id,
    });
    const reqRes = await api.apiFetch(`/api/raven/issues/${issue.id}/requirement`);
    const requirement = (await reqRes.json()) as { id: string };
    for (const toState of ["spec", "ready", "running"]) {
      const t = await api.apiFetch(`/api/raven/requirements/${requirement.id}/transition`, {
        method: "POST",
        body: JSON.stringify({ to_state: toState, reason: "" }),
      });
      expect(t.status).toBe(200);
    }

    // 8 consecutive human approvals of the same gate.
    for (let i = 0; i < 8; i++) {
      const gateRes = await api.apiFetch("/api/raven/gates", {
        method: "POST",
        body: JSON.stringify({
          requirement_id: requirement.id,
          gate_name: "human-review",
          review_package: { summary: `pass ${i + 1}` },
        }),
      });
      expect(gateRes.status).toBe(201);
      const gate = (await gateRes.json()) as { id: string; status: string };
      expect(gate.status).toBe("pending"); // behavior unchanged pre-promotion
      const decideRes = await api.apiFetch(`/api/raven/gates/${gate.id}/decision`, {
        method: "POST",
        body: JSON.stringify({ approve: true, reason: "" }),
      });
      expect(decideRes.status).toBe(200);
    }

    // The 8th approval issued exactly one promotion decision point.
    const dpRes = await api.apiFetch("/api/raven/decision-points?status=pending");
    const dp = (await dpRes.json()) as {
      items: Array<{ kind: string; id: string; title: string }>;
    };
    const promotions = dp.items.filter(
      (item) => item.kind === "promotion" && item.title === "human-review",
    );
    expect(promotions).toHaveLength(1);

    // Approve the letter → gate policy becomes sampled.
    const promoDecide = await api.apiFetch(
      `/api/raven/promotions/${promotions[0].id}/decision`,
      { method: "POST", body: JSON.stringify({ approve: true, reason: "" }) },
    );
    expect(promoDecide.status).toBe(200);

    const slug = await loginAsDefault(page);

    // Workflow list shows the production-line badge for this workflow.
    await page.goto(`/${slug}/raven/workflows`, { waitUntil: "domcontentloaded" });
    await waitForPageText(page, name);
    const row = page.getByTestId("workflow-row").filter({ hasText: name });
    await expect(row.getByTestId("workflow-production-line")).toBeVisible();

    // Detail page: trust section with the sampled gate and a revoke button.
    await page.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/raven/workflows/${workflow.id}`), {
      timeout: ROUTE_CHANGE_TIMEOUT,
    });
    const policyRow = page
      .getByTestId("workflow-gate-policy-row")
      .filter({ hasText: "human-review" });
    await expect(policyRow).toBeVisible();
    await expect(policyRow.getByTestId("revoke-gate-policy")).toBeVisible();

    // Manual revoke → back to full review, button disappears.
    await policyRow.getByTestId("revoke-gate-policy").click();
    await expect(policyRow.getByTestId("revoke-gate-policy")).toHaveCount(0, {
      timeout: ROUTE_CHANGE_TIMEOUT,
    });

    // Server agrees: policy mode is full again.
    const policiesRes = await api.apiFetch(
      `/api/raven/workflows/${workflow.id}/gate-policies`,
    );
    const policies = (await policiesRes.json()) as {
      policies: Array<{ gate_name: string; mode: string }>;
    };
    expect(
      policies.policies.find((p) => p.gate_name === "human-review")?.mode,
    ).toBe("full");
  });
});
