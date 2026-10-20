import { expect } from "@playwright/test";

/** Exercise the same published / fully disconnected build through visible controls. */
export async function verifyStarMap(page) {
  await page.locator("#mode-observe").click();
  await expect(page.locator("#star-map")).toBeVisible();
  await page.locator('[data-map-system="solar"]').click();
  await page.locator('#map-dossier [data-map-pick="jupiter"]').click();
  await expect(page.locator(".map-object-list > button")).toHaveCount(4);
  await page.locator('[data-map-projection="2d"]').click();
  await expect(page.locator("#canvas-host canvas")).toHaveAttribute("data-map-projection", "2d");
  await page.locator('[data-map-projection="3d"]').click();
  await expect(page.locator("#canvas-host canvas")).toHaveAttribute("data-map-projection", "3d");
  await page.locator('#map-dossier [data-map-pick="io"]').click();
  await expect(page.locator("#map-observe")).toContainText("木卫一");
  await page.locator("#map-observe").click();
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-body", "io");
  await page.locator("#return-star-map").click();
  await expect(page.locator("#star-map")).toHaveAttribute("data-parent", "jupiter");
  await page.locator('[data-map-system="echo-rift"]').click();
  await expect(page.locator("#map-dossier")).toContainText("虚构");
  await page.locator('#map-dossier [data-map-pick="veyl"]').click();
  await expect(page.locator(".map-object-list > button")).toHaveCount(2);
  await page.locator('[data-map-system="solar"]').click();
  await page.locator('#map-dossier [data-map-pick="earth"]').click();
  await page.locator("#map-travel").click();
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-mode", "flight");
  await expect(page.locator("#canvas-host canvas")).toHaveCount(1);
}
