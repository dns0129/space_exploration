import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { PNG } from "pngjs";

/** The same real shortcut works in the published game and without networking. */
export async function verifyBridgeEarthShot(page) {
  const saved = await page.evaluate(() => localStorage.getItem("voyager-flight-v1"));
  await page.getByRole("button", { name: "地球舷窗镜头", exact: true }).click();
  await expect(page.locator("body")).toHaveClass(/photo-mode/);
  const canvas = page.locator("#canvas-host canvas");
  await expect(canvas).toHaveAttribute("data-station-zone", "驾驶室");
  await expect(canvas).toHaveAttribute("data-surface-frame-idle", "true", { timeout: 60000 });
  await expect.poll(async () => Number(await canvas.getAttribute("data-earthshine"))).toBeGreaterThan(0.1);
  const image = PNG.sync.read(await canvas.screenshot({ timeout: 90000 }));
  let lit = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if (image.data[i] + image.data[i + 1] + image.data[i + 2] > 140) lit++;
  assert(lit > image.width * image.height * 0.08, "Earth window shot must contain real rendered pixels");
  assert.equal(await page.evaluate(() => localStorage.getItem("voyager-flight-v1")), saved, "The shot must not overwrite the existing save");
  await page.keyboard.press("p");
  await expect(page.locator("body")).not.toHaveClass(/photo-mode/);
}
