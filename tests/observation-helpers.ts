import { expect, type Page } from "@playwright/test";

/** Work with the unified disclosure state instead of assuming a closed drawer. */
export async function setObservationSettings(page: Page, expanded: boolean) {
  const panel = page.locator("#control-panel");
  if ((await panel.getAttribute("data-collapsed") !== "true") !== expanded)
    await panel.locator(":scope > .ui-panel-toggle").click();
  await expect(panel).toHaveAttribute("data-collapsed", String(!expanded));
}
