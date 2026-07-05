import { test, expect } from "@playwright/test";
import { loginAsDefault, createTestApi } from "./helpers";
import type { TestApiClient } from "./fixtures";

const ROUTE_CHANGE_TIMEOUT = 30000;

/**
 * 待我处理队列 smoke (issue #21, 二期): trigger a clarification and a gate on
 * one requirement → both surface in the aggregate "待我处理" queue → resolve
 * each through its 拍板信 card → the queue drains to the empty state.
 */
test.describe("Raven decision queue", () => {
  let api: TestApiClient;

  test.afterEach(async () => {
    await api?.cleanup();
  });

  test("clarify + gate → queue shows two → resolve each → empty", async ({ page }) => {
    api = await createTestApi();

    const name = `e2e-queue-${Date.now().toString(36)}`;
    const wfRes = await api.apiFetch("/api/raven/workflows", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: "E2E decision queue workflow",
        contract: {
          stages: [{ name: "spec" }, { name: "implement" }, { name: "self-check" }],
          gates: [{ name: "human-review", after_stage: "self-check" }],
          budget: { max_tokens: 1_000_000 },
        },
      }),
    });
    expect(wfRes.status).toBe(201);
    const workflow = (await wfRes.json()) as { id: string };

    const issue = await api.createIssue(`raven decision queue ${name}`, {
      status: "backlog",
      priority: "medium",
      assignee_type: "workflow",
      assignee_id: workflow.id,
    });

    let reqRes = await api.apiFetch(`/api/raven/issues/${issue.id}/requirement`);
    if (reqRes.status === 404) {
      reqRes = await api.apiFetch("/api/raven/requirements", {
        method: "POST",
        body: JSON.stringify({ issue_id: issue.id }),
      });
    }
    expect([200, 201]).toContain(reqRes.status);
    const requirement = (await reqRes.json()) as { id: string };

    for (const toState of ["spec", "ready", "running"]) {
      const t = await api.apiFetch(`/api/raven/requirements/${requirement.id}/transition`, {
        method: "POST",
        body: JSON.stringify({ to_state: toState, reason: "" }),
      });
      expect(t.status).toBe(200);
    }

    // 1) A clarification (kind=clarify) — oldest, so it sorts to the top.
    const clarifyRes = await api.apiFetch("/api/raven/clarifications", {
      method: "POST",
      body: JSON.stringify({
        requirement_id: requirement.id,
        stage: "spec",
        questions: [{ question: "Which scope should we ship?" }],
      }),
    });
    expect(clarifyRes.status).toBe(201);

    // 2) A gate review (kind=gate) — pending on a fresh, untrusted workflow.
    const gateRes = await api.apiFetch("/api/raven/gates", {
      method: "POST",
      body: JSON.stringify({
        requirement_id: requirement.id,
        gate_name: "human-review",
        review_package: { summary: "Please review the delivery." },
      }),
    });
    expect(gateRes.status).toBe(201);

    const slug = await loginAsDefault(page);
    await page.goto(`/${slug}/raven/decisions`, { waitUntil: "domcontentloaded" });

    // Both decision points render, oldest-first, with the sidebar badge at 2.
    await expect(page.getByTestId("queue-list")).toBeVisible({ timeout: ROUTE_CHANGE_TIMEOUT });
    await expect(page.getByTestId("queue-item")).toHaveCount(2, { timeout: ROUTE_CHANGE_TIMEOUT });
    await expect(page.getByTestId("sidebar-decisions-count")).toHaveText("2");

    // Resolve the gate through its card → queue drops to one item.
    await page
      .locator('[data-testid="queue-item"][data-kind="gate"]')
      .getByTestId("gate-approve")
      .click();
    await expect(page.getByTestId("queue-item")).toHaveCount(1, { timeout: ROUTE_CHANGE_TIMEOUT });

    // Answer the clarification → queue empties.
    const clarifyItem = page.locator('[data-testid="queue-item"][data-kind="clarify"]');
    await clarifyItem.locator("textarea").first().fill("Ship the narrow scope.");
    await clarifyItem.getByTestId("clarify-submit").click();

    await expect(page.getByTestId("queue-empty")).toBeVisible({ timeout: ROUTE_CHANGE_TIMEOUT });
  });
});
