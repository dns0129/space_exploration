import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { readFile } from "node:fs/promises";

test("星图逐层探索、真实卫星、2D/3D 和近观往返", async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#star-map")).toBeVisible();
  await expect(page.locator("#star-map")).toHaveAttribute("data-level", "system");
  await expect(page.locator("#map-dossier .map-title")).toContainText("太阳系");
  const canvas = page.locator("#canvas-host canvas");
  await expect(canvas).toHaveAttribute("data-render-mode", "star-map");
  await expect(page.locator('#star-map-labels [data-loading="true"]')).toHaveCount(0, { timeout: 60000 });
  expect(await page.locator("#star-map-labels .map-node:visible").count()).toBe(10);
  await page.screenshot({ path: `test-results/star-map/${info.project.name}-system.png` });
  // Use the projected label over the actual rendered planet, not only the catalogue.
  await page.locator('#star-map-labels [data-map-body="jupiter"]').click();
  await expect(page.locator("#star-map")).toHaveAttribute("data-parent", "jupiter");
  await expect(page.locator(".map-object-list > button")).toHaveCount(4);
  await expect(page.locator('#star-map-labels [data-loading="true"]')).toHaveCount(0, { timeout: 60000 });
  for (const id of ["io", "europa", "ganymede", "callisto"])
    await expect(page.locator(`#star-map-labels [data-map-body="${id}"]`)).toBeVisible();
  await page.getByRole("button", { name: "2D", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-map-projection", "2d");
  await expect(canvas).toHaveAttribute("data-map-moving", "false");
  const topPosition = await page.locator('#star-map-labels [data-map-body="europa"]').getAttribute("style");
  await page.screenshot({ path: `test-results/star-map/${info.project.name}-orbit-2d.png` });
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-map-projection", "3d");
  await expect.poll(() => page.locator('#star-map-labels [data-map-body="europa"]').getAttribute("style")).not.toBe(topPosition);
  await page.locator('#map-dossier [data-map-pick="io"]').click();
  await expect(page.locator("#map-dossier .map-title")).toContainText("木卫一");
  await page.screenshot({ path: `test-results/star-map/${info.project.name}-orbit-3d.png` });
  const pixels = PNG.sync.read(await canvas.screenshot());
  let lit = 0;
  for (let i = 0; i < pixels.data.length; i += 4)
    if (pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2] > 220) lit++;
  expect(lit).toBeGreaterThan(600);
  await page.locator("#map-observe").click();
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-body", "io");
  await expect(canvas).toHaveAttribute("data-render-mode", "observation");
  await expect(page.locator("#star-map")).toBeHidden();
  await page.locator("#return-star-map").click();
  await expect(page.locator("#star-map")).toHaveAttribute("data-parent", "jupiter");
  await expect(page.locator("#map-observe")).toContainText("木卫一");
  await page.locator('#star-map-labels [data-map-body="io"]').focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#star-map")).toHaveAttribute("data-level", "system");
  await page.locator('#map-dossier [data-map-pick="mercury"]').click();
  await expect(page.locator(".map-empty")).toContainText("没有收录");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
    && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  expect(errors).toEqual([]);
});

test("航区总览、虚构标注、深链接和航行目标保留", async ({ page }) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#map=galaxy");
  await expect(page.locator("#star-map")).toHaveAttribute("data-level", "galaxy");
  await expect(page.locator('#star-map-labels [data-loading="true"]')).toHaveCount(0, { timeout: 60000 });
  await page.locator('#star-map-labels [data-map-body="echo-pulsar"]').click();
  await expect(page.locator("#map-dossier")).toContainText("虚构");
  await page.locator('#map-dossier [data-map-pick="veyl"]').click();
  await expect(page.locator(".map-object-list > button")).toHaveCount(2);
  await expect(page.locator("#star-map")).toHaveAttribute("data-parent", "veyl");
  await page.reload();
  await expect(page.locator("#star-map")).toHaveAttribute("data-parent", "veyl");
  await expect(page.locator("#map-dossier .map-title")).toContainText("维尔");
  await page.locator('[data-map-system="solar"]').click();
  await page.locator('#map-dossier [data-map-pick="earth"]').click();
  await expect(page.locator('.map-object-list [data-map-pick="moon"]')).toBeVisible();
  await expect(page.locator('.map-object-list [data-map-pick="earth-station"]')).toBeVisible();
  await page.locator("#map-travel").click();
  await expect(page.locator("#flight-ui")).toBeVisible();
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-mode", "flight");
  await page.locator("#mode-observe").click();
  await expect(page.locator("#star-map")).toBeVisible();
  await expect(page.locator("#map-observe")).toContainText("地球");
  expect(await page.locator("#canvas-host canvas").count()).toBe(1);
});

test("连续切换维度时保留画布并平滑抵达最终视角", async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/#map=solar&orbit=jupiter");
  const canvas = page.locator("#canvas-host canvas");
  await expect(page.locator("#star-map")).toBeVisible();
  await expect(canvas).toHaveAttribute("data-map-moving", "false");
  await page.getByRole("button", { name: "2D", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-map-moving", "true");
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.getByRole("button", { name: "2D", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-map-projection", "2d");
  await expect(canvas).toHaveAttribute("data-map-moving", "false");
  await expect(page.locator('#star-map-labels [data-loading="true"]')).toHaveCount(0, { timeout: 60000 });
  await page.locator("#map-motion").click();
  await expect(page.locator("#map-motion")).toHaveAttribute("aria-pressed", "true");
  expect(await canvas.count()).toBe(1);
});

test("暂停的卫星星图可拍照，关闭画质面板保留轨道层级", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#map=solar&orbit=jupiter");
  await expect(page.locator("#star-map")).toHaveAttribute("data-parent", "jupiter");
  await expect(page.locator('#star-map-labels [data-loading="true"]')).toHaveCount(0);
  await page.locator(".header-tools [data-open-graphics]").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#graphics-dialog")).toBeHidden();
  await expect(page.locator("#star-map")).toHaveAttribute("data-parent", "jupiter");
  await page.keyboard.press("p");
  const canvas = page.locator("#canvas-host canvas");
  const screen = PNG.sync.read(await canvas.screenshot());
  const download = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const photo = PNG.sync.read(await readFile((await (await download).path())!));
  const litFraction = (image: PNG) => {
    let count = 0;
    for (let i = 0; i < image.data.length; i += 4)
      if (image.data[i] + image.data[i + 1] + image.data[i + 2] > 20) count++;
    return count / (image.width * image.height);
  };
  expect(litFraction(photo)).toBeGreaterThan(0.002);
  expect(Math.abs(litFraction(photo) - litFraction(screen))).toBeLessThan(0.05);
});
