import { test, expect } from "@playwright/test";
import { loginAsDefault, createTestApi, waitForPageText } from "./helpers";
import type { TestApiClient } from "./fixtures";

const ROUTE_CHANGE_TIMEOUT = 30000;

/**
 * Run room smoke (issue #18): an on-track issue shows the delivery-progress
 * strip → its entry link opens the run room → the three zones render → a
 * graph node opens the profile drawer.
 */
test.describe("Raven run room", () => {
  let api: TestApiClient;

  test.afterEach(async () => {
    await api?.cleanup();
  });

  test("issue strip → run room → node drawer", async ({ page }) => {
    api = await createTestApi();

    // Workflow + issue + requirement + a running run with stage progress.
    const name = `e2e-room-${Date.now().toString(36)}`;
    const wfRes = await api.apiFetch("/api/raven/workflows", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: "E2E run room workflow",
        contract: {
          stages: [{ name: "implement" }, { name: "self-check" }],
          gates: [{ name: "human-review", after_stage: "self-check" }],
          budget: { max_tokens: 1_000_000 },
        },
      }),
    });
    expect(wfRes.status).toBe(201);
    const workflow = (await wfRes.json()) as { id: string };

    const issue = await api.createIssue(`raven run room ${name}`, {
      status: "backlog",
      priority: "medium",
      assignee_type: "workflow",
      assignee_id: workflow.id,
    });

    // The workflow assignment opts the issue into the Raven track; fetch the
    // requirement it created (fall back to explicit creation for safety).
    let reqRes = await api.apiFetch(`/api/raven/issues/${issue.id}/requirement`);
    if (reqRes.status === 404) {
      reqRes = await api.apiFetch("/api/raven/requirements", {
        method: "POST",
        body: JSON.stringify({ issue_id: issue.id }),
      });
    }
    expect([200, 201]).toContain(reqRes.status);
    const requirement = (await reqRes.json()) as { id: string };

    const runRes = await api.apiFetch(`/api/raven/requirements/${requirement.id}/runs`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(runRes.status).toBe(201);
    const run = (await runRes.json()) as { id: string };

    await api.apiFetch(`/api/raven/runs/${run.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "running", tokens_spent: 1234 }),
    });
    await api.apiFetch(`/api/raven/runs/${run.id}/stage-events`, {
      method: "POST",
      body: JSON.stringify({ stage: "implement", event: "entered" }),
    });

    const slug = await loginAsDefault(page);

    // On-track issue shows the delivery-progress strip.
    await page.goto(`/${slug}/issues/${issue.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("run-stage-strip")).toBeVisible({
      timeout: ROUTE_CHANGE_TIMEOUT,
    });

    // Strip entry link → the run room.
    await page.getByTestId("open-run-room").click();
    await expect(page).toHaveURL(new RegExp(`/raven/runs/${run.id}`), {
      timeout: ROUTE_CHANGE_TIMEOUT,
    });
    await expect(page.getByTestId("run-room")).toBeVisible({
      timeout: ROUTE_CHANGE_TIMEOUT,
    });

    // The three zones are on screen.
    await expect(page.getByTestId("run-room-graph")).toBeVisible();
    await expect(page.getByTestId("run-room-timeline")).toBeVisible();
    await expect(page.getByTestId("run-room-budget")).toBeVisible();
    await waitForPageText(page, "1,234");

    // Clicking the active stage node opens the profile drawer.
    await page
      .locator('[data-testid="graph-node"][data-node-id="stage:implement"]')
      .click();
    await expect(page.getByTestId("stage-drawer")).toBeVisible({
      timeout: ROUTE_CHANGE_TIMEOUT,
    });
  });
});
