import { test, expect, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { getBody, getSystemGroup, type BodyId } from "../src/solar-system";

const detailAttributes = ["kind", "body", "family", "resolution", "tile-resolution", "tiles", "status"] as const;
const representatives = ["mars", "europa", "jupiter", "venus", "sun", "ceres", "naiad", "proxima-b", "betelgeuse"] as const;
const screenshotStyle = ".control-panel, .altitude, .toast, .viewport-tools, .mobile-settings, .destination-selectors { visibility: hidden !important; }";

async function selectBody(page: Page, id: BodyId) {
  const group = getSystemGroup(id);
  const selector = page.locator("#star-system");
  if (await selector.inputValue() !== group) await selector.selectOption(group);
  const button = page.locator(`button[data-body="${id}"]`);
  if (await button.count()) await button.click();
  else await page.locator("#satellite-target").selectOption(id);
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-body", id);
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
}

async function quality(page: Page, value: "standard" | "ultra") {
  const selector = page.locator("#quality");
  const hidden = !await selector.isVisible();
  if (hidden) await page.getByRole("button", { name: "观测设置", exact: true }).click();
  await selector.selectOption(value);
  if (hidden) await page.getByRole("button", { name: "观测设置", exact: true }).click();
}

async function closeView(page: Page) {
  const panelButton = page.locator('#control-panel button[data-view="close"]');
  if (await panelButton.isVisible()) await panelButton.click();
  else await page.locator('.primary-button[data-view="close"]').click();
}

async function freezeCloseView(page: Page, id: BodyId) {
  await closeView(page);
  const targetAltitude = (Math.hypot(.14, 1.85) - 1) * getBody(id).radiusKm;
  await expect.poll(async () => Math.abs(Number((await page.locator("#altitude").innerText()).replace(/[^0-9]/g, "")) - targetAltitude))
    .toBeLessThan(Math.max(1, getBody(id).radiusKm * .006));
  let previous = "", stable = 0;
  await expect.poll(async () => {
    const altitude = await page.locator("#altitude").innerText();
    stable = altitude === previous ? stable + 1 : 0;
    previous = altitude;
    return stable;
  }).toBeGreaterThanOrEqual(2);
  await expect(page.locator("canvas")).toHaveAttribute("data-render-scale", "1.00");
}

async function expectTiles(page: Page, id: BodyId, kind: "native" | "enhanced") {
  const canvas = page.locator("canvas");
  await expect(canvas).toHaveAttribute("data-surface-detail-status", "ready", { timeout: 60_000 });
  await expect(canvas).toHaveAttribute("data-surface-detail-tiles", "4");
  await expect(canvas).toHaveAttribute("data-surface-detail-body", id);
  await expect(canvas).toHaveAttribute("data-surface-detail-kind", kind);
  await expect(canvas).toHaveAttribute("data-surface-detail-resolution", "16384x8192");
  await expect(canvas).toHaveAttribute("data-surface-detail-tile-resolution", "2064x2064");
}

function surfaceDifference(before: PNG, after: PNG) {
  expect([after.width, after.height], "比较地表细节时画布分辨率必须相同").toEqual([before.width, before.height]);
  let changed = 0, sampled = 0;
  for (let y = Math.round(before.height * .3); y < before.height * .65; y++) {
    for (let x = Math.round(before.width * .4); x < before.width * .7; x++) {
      const i = (y * before.width + x) * 4;
      const delta = Math.abs(before.data[i] - after.data[i]) + Math.abs(before.data[i + 1] - after.data[i + 1]) + Math.abs(before.data[i + 2] - after.data[i + 2]);
      sampled++;
      if (delta > 3) changed++;
    }
  }
  return { changed, sampled };
}

test("岩石、冰壳、云层、气态、恒星与程序世界的 16K 合成分块实际改变地表像素", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "完整 16K 合成仅在桌面启用");
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 900, height: 650 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/#planet=mars");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
  const canvas = page.locator("canvas");
  for (const id of representatives) {
    await quality(page, "standard");
    await selectBody(page, id);
    await freezeCloseView(page, id);
    await expect(canvas).toHaveAttribute("data-surface-detail-status", "disabled");
    await expect(canvas).toHaveAttribute("data-surface-detail-tiles", "0");
    const before = PNG.sync.read(await canvas.screenshot({ style: screenshotStyle }));
    await quality(page, "ultra");
    await expectTiles(page, id, "enhanced");
    await expect(canvas).toHaveAttribute("data-render-scale", "1.00");
    // Fade completion precedes comparison; the source view and rotation remain frozen.
    await page.waitForTimeout(700);
    const after = PNG.sync.read(await canvas.screenshot({ path: info.outputPath(`${id}-enhanced-16k.png`), style: screenshotStyle }));
    const difference = surfaceDifference(before, after);
    expect(difference.changed, `${id}必须显示实际 16K 合成细节，不能仅改变标签`).toBeGreaterThan(difference.sampled * .01);
    await quality(page, "standard");
    await expect(canvas).toHaveAttribute("data-surface-detail-tiles", "0");
    expect(await canvas.getAttribute("data-surface-detail-resolution"), "关闭合成细节应释放分块").toBeNull();
    const restored = PNG.sync.read(await canvas.screenshot({ style: screenshotStyle }));
    expect(surfaceDifference(before, restored).changed, `${id}关闭细节应恢复同一冻结视图，排除镜头移动造成差异`)
      .toBeLessThan(Math.max(40, difference.changed * .1));
  }
  await selectBody(page, "earth-station");
  for (const attribute of detailAttributes) expect(await canvas.getAttribute(`data-surface-detail-${attribute}`)).toBeNull();
  expect(errors).toEqual([]);
});

test("地球保持原生 16K 影像分块并与合成细节分别标注", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  test.setTimeout(150_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
  await quality(page, "ultra");
  await closeView(page);
  await expectTiles(page, "earth", "native");
  await expect(page.locator("canvas")).toHaveAttribute("data-earth-detail-tiles", "4");
  await quality(page, "standard");
  await expect(page.locator("canvas")).toHaveAttribute("data-surface-detail-tiles", "0");
  expect(await page.locator("canvas").getAttribute("data-surface-detail-resolution")).toBeNull();
});

test("手机保留完整 4K 或 2K 基础影像，不分配桌面 16K 合成分块", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile");
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#planet=mars");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
  await quality(page, "ultra");
  for (const [id, resolution] of [["mars", "4096x2048"], ["moon", "4096x2048"], ["umbriel", "2048x1024"]] as const) {
    await selectBody(page, id);
    await closeView(page);
    const canvas = page.locator("canvas");
    await expect(canvas).toHaveAttribute("data-surface-resolution", resolution);
    await expect(canvas).toHaveAttribute("data-surface-detail-status", "disabled");
    await expect(canvas).toHaveAttribute("data-surface-detail-tiles", "0");
    expect(await canvas.getAttribute("data-surface-detail-resolution")).toBeNull();
    expect(await canvas.getAttribute("data-surface-detail-tile-resolution")).toBeNull();
  }
});

test("4096 纹理上限仍可显示分块 16K，低于物理分块尺寸时保留基础表面", async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== "desktop");
  test.setTimeout(150_000);
  for (const maximum of [4096, 2048]) {
    const context = await browser.newContext({ baseURL, viewport: { width: 900, height: 650 }, reducedMotion: "reduce" });
    try {
      await context.addInitScript(maximum => {
        const getParameter = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function (parameter: number) {
          return parameter === this.MAX_TEXTURE_SIZE ? maximum : getParameter.call(this, parameter);
        };
      }, maximum);
      const page = await context.newPage();
      await page.goto("/#planet=mars");
      await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
      await quality(page, "ultra");
      await closeView(page);
      const canvas = page.locator("canvas");
      await expect(canvas).toHaveAttribute("data-surface-map", "mars-real.jpg");
      await expect(canvas).toHaveAttribute("data-surface-resolution", `${maximum}x${maximum / 2}`);
      if (maximum === 4096) {
        await expectTiles(page, "mars", "enhanced");
        await selectBody(page, "earth");
        await closeView(page);
        await expectTiles(page, "earth", "native");
        await expect(canvas).toHaveAttribute("data-earth-maps", "4k");
      }
      else {
        await expect(canvas).toHaveAttribute("data-surface-detail-status", "disabled");
        await expect(canvas).toHaveAttribute("data-surface-detail-tiles", "0");
        expect(await canvas.getAttribute("data-surface-detail-resolution")).toBeNull();
      }
      await expect(page.getByRole("alert")).toBeHidden();
    } finally {
      await context.close();
    }
  }
});

test("AI 素材下载失败保留基础表面，切换空间站清除待生成地表诊断", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/textures/surface-material-atlas.jpg", route => route.abort());
  await page.goto("/#planet=mars");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
  await quality(page, "ultra");
  await closeView(page);
  const canvas = page.locator("canvas");
  await expect(canvas).toHaveAttribute("data-surface-detail-status", "pending");
  await expect(canvas).toHaveAttribute("data-surface-detail-tiles", "0");
  await expect(canvas).toHaveAttribute("data-surface-map", "mars-real-8k.jpg");
  await expect(page.getByRole("alert")).toBeHidden();
  const image = PNG.sync.read(await canvas.screenshot({ style: screenshotStyle }));
  let warm = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if (image.data[i] > 70 && image.data[i] > image.data[i + 1] * 1.15) warm++;
  expect(warm, "增强素材不可用时火星基础影像仍须可见").toBeGreaterThan(1500);
  await selectBody(page, "earth-station");
  for (const attribute of detailAttributes) expect(await canvas.getAttribute(`data-surface-detail-${attribute}`)).toBeNull();
  expect(errors).toEqual([]);
});
