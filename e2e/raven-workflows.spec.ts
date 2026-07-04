import { test, expect } from "@playwright/test";
import { loginAsDefault, createTestApi, waitForPageText } from "./helpers";
import type { TestApiClient } from "./fixtures";

const ROUTE_CHANGE_TIMEOUT = 30000;

/**
 * Raven workflow smoke: sidebar → workflow list → workflow detail, plus the
 * requirement audit timeline on an issue that opted into the Raven track.
 */
test.describe("Raven workflows", () => {
  let api: TestApiClient;

  test.afterEach(async () => {
    await api?.cleanup();
  });

  test("workflow list, detail, and issue audit timeline", async ({ page }) => {
    api = await createTestApi();

    // Register a workflow and an issue assigned to it (Raven opt-in).
    const name = `e2e-wf-${Date.now().toString(36)}`;
    const res = await api.apiFetch("/api/raven/workflows", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: "E2E smoke workflow",
        contract: {
          stages: [{ name: "implement" }, { name: "self-check" }],
          gates: [{ name: "human-review", after_stage: "self-check" }],
          budget: { max_tokens: 1_000_000 },
        },
      }),
    });
    expect(res.status).toBe(201);
    const workflow = (await res.json()) as { id: string };
    const issue = await api.createIssue(`raven e2e ${name}`, {
      status: "backlog",
      priority: "medium",
      assignee_type: "workflow",
      assignee_id: workflow.id,
    });

    const slug = await loginAsDefault(page);

    // Sidebar entry → workflow list.
    await page.getByRole("link", { name: "Workflows" }).click();
    await expect(page).toHaveURL(/\/raven\/workflows/, {
      timeout: ROUTE_CHANGE_TIMEOUT,
    });
    await waitForPageText(page, name);

    // Row link → detail with contract + run history sections.
    await page.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/raven/workflows/${workflow.id}`), {
      timeout: ROUTE_CHANGE_TIMEOUT,
    });
    await waitForPageText(page, "Run history");
    await waitForPageText(page, "human-review");

    // Issue detail shows the collapsible audit timeline for Raven issues.
    await page.goto(`/${slug}/issues/${issue.id}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForPageText(page, "Audit timeline");
    await page.getByText("Audit timeline").click();
    await expect(page.getByTestId("requirement-timeline")).toBeVisible();
  });
});
