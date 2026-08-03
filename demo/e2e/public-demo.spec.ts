import { expect, test, type BrowserContext, type Page } from "@playwright/test";

interface BrowserSignals {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  failedResponses: string[];
  webSockets: number;
}

function observe(page: Page): BrowserSignals {
  const signals: BrowserSignals = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    failedResponses: [],
    webSockets: 0,
  };
  page.on("console", (message) => {
    if (message.type() === "error") signals.consoleErrors.push(message.text().slice(0, 300));
  });
  page.on("pageerror", (error) => signals.pageErrors.push(error.message.slice(0, 300)));
  page.on("requestfailed", (request) => signals.failedRequests.push(new URL(request.url()).origin));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      signals.failedResponses.push(`${response.status()} ${new URL(response.url()).origin}`);
    }
  });
  page.on("websocket", () => {
    signals.webSockets += 1;
  });
  return signals;
}

async function waitForWorkspace(page: Page) {
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect(page.getByText("Record the demo", { exact: true })).toBeVisible();
  await expect(page.getByText("Get groceries", { exact: true })).toBeVisible();
}

function hasSafeCapabilityShape(value: string | null): value is string {
  return (
    typeof value === "string" &&
    /^demo_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{27}$/u.test(value)
  );
}

test("UI-I-002 proves two-session Convex reactivity, shared agent actions, reset, and clean browser signals", async ({
  browser,
  page,
}, testInfo) => {
  const firstSignals = observe(page);
  await page.goto("./");
  await waitForWorkspace(page);

  const capability = await page.evaluate(() =>
    sessionStorage.getItem("convex-agent-native.demo-capability.v1"),
  );
  const capabilityHasSafeShape = hasSafeCapabilityShape(capability);
  expect(capabilityHasSafeShape).toBe(true);
  if (!capabilityHasSafeShape) {
    throw new Error("Demo bootstrap returned an invalid capability shape");
  }

  const secondContextOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: testInfo.outputPath("second-session-video") },
  };
  const secondContext: BrowserContext = await browser.newContext(secondContextOptions);
  await secondContext.addInitScript(
    (value) => sessionStorage.setItem("convex-agent-native.demo-capability.v1", value),
    capability,
  );
  const secondPage = await secondContext.newPage();
  const secondSignals = observe(secondPage);

  try {
    await secondPage.goto("./");
    await waitForWorkspace(secondPage);

    const createdTitle = `Browser shared ${Date.now()}`;
    const renamedTitle = `${createdTitle} renamed`;
    await page.getByPlaceholder("What needs doing?").fill(createdTitle);
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(secondPage.getByText(createdTitle, { exact: true })).toBeVisible();

    await secondPage.getByRole("button", { name: `Edit ${createdTitle}` }).click();
    await secondPage.getByRole("textbox", { name: `Edit ${createdTitle}` }).fill(renamedTitle);
    await secondPage.getByRole("button", { name: "Save edit" }).click();
    await expect(page.getByText(renamedTitle, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: `Complete ${renamedTitle}` }).click();
    await page.getByRole("checkbox", { name: "Show completed" }).check();
    await secondPage.getByRole("checkbox", { name: "Show completed" }).check();
    await expect(
      secondPage.getByRole("button", { name: `Reopen ${renamedTitle}` }),
    ).toHaveAttribute("aria-pressed", "true");

    await secondPage
      .getByRole("textbox", { name: "Message the built-in agent" })
      .fill("add Agent shared task");
    await secondPage.getByRole("button", { name: "Send to agent" }).click();
    await expect(page.getByText("Agent shared task", { exact: true })).toBeVisible();
    await expect(page.getByText("tool", { exact: true }).first()).toBeVisible();

    await secondPage.getByRole("button", { name: "Delete Agent shared task" }).click();
    await secondPage.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByText("Agent shared task", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Reset demo" }).click();
    await page.getByRole("button", { name: "Reset tasks" }).click();
    await expect(secondPage.getByText("Record the demo", { exact: true })).toBeVisible();
    await expect(secondPage.getByText("Get groceries", { exact: true })).toBeVisible();
    await expect(secondPage.getByText(renamedTitle, { exact: true })).toHaveCount(0);
    await expect(
      secondPage.getByText("Receipts will appear after your first change."),
    ).toBeVisible();
    await expect(secondPage.getByText("Try “list tasks” or “add Buy oat milk”.")).toBeVisible();

    await expect(page.getByText("Independent Convex port.", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Not affiliated with or endorsed by Builder.io.", { exact: false }),
    ).toBeVisible();

    for (const signals of [firstSignals, secondSignals]) {
      expect(signals.consoleErrors).toEqual([]);
      expect(signals.pageErrors).toEqual([]);
      expect(signals.failedRequests).toEqual([]);
      expect(signals.failedResponses).toEqual([]);
      expect(signals.webSockets).toBeGreaterThan(0);
    }
  } finally {
    await secondContext.close();
  }
});
