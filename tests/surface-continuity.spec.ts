import { test, expect, type Page } from "@playwright/test";
import * as THREE from "three";
import { PNG } from "pngjs";
import { world } from "../shared/flight-state.mjs";
import { terrainHeightKm, terrainMapNormal, LANDING_CLEARANCE_KM, TERRAIN_VERSION } from "../shared/surface.mjs";

// Herschel is a visible landmark in the actual Mimas mosaic, not an arbitrary
// procedural point. These source-map coordinates remain fixed at every LOD.
const craterUv = [.155, .5];
const craterAngularRadius = .335;
const sourceId = "mimas:surface-v2:16k";
const pictureStyle = ".flight-ui, .destination-selectors, .toast { visibility: hidden !important; }";

function checkpoint(normal: number[], clearanceKm: number, velocityKm = 0, landed = false) {
  const body = world.bodies.find(candidate => candidate.id === "mimas")!;
  const radial = new THREE.Vector3().fromArray(normal).normalize();
  const tangent = new THREE.Vector3(0, 1, 0).cross(radial).normalize();
  const up = radial.clone().cross(tangent).normalize();
  const orientation = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(new THREE.Vector3(), radial.clone().negate(), up));
  const altitude = terrainHeightKm("mimas", radial.toArray()) + LANDING_CLEARANCE_KM + clearanceKm;
  return { version: 2, worldLayoutVersion: world.layoutVersion, terrainVersion: TERRAIN_VERSION,
    systemId: "solar", target: "mimas", camera: "cockpit", assist: false, elapsed: 0,
    position: new THREE.Vector3().fromArray(body.position).addScaledVector(radial, body.radius + altitude / world.unitsKm).toArray(),
    velocity: radial.clone().multiplyScalar(-velocityKm / world.unitsKm).toArray(),
    orientation: orientation.toArray(), ...(landed ? { landedBody: "mimas" } : {}) };
}

async function launchSaved(page: Page, state: ReturnType<typeof checkpoint>, quality: "standard" | "ultra") {
  // Supply a normal user save through the existing storage API. Tests never
  // invoke scene internals or inject shader uniforms into the application.
  await page.route("**/api/flight/save", route => route.fulfill({ json: { state } }));
  await page.goto("/#planet=mimas");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "自由航行", exact: true }).click();
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await page.locator("#flight-quality").selectOption(quality);
  await page.locator("#flight-pause").click();
  await expect(page.locator("#flight-resume")).toBeEnabled();
  await page.locator("#flight-resume").click();
  await expect(page.locator("#flight-nearest")).toHaveText("土卫一");
  await expect(page.locator("canvas")).toHaveAttribute("data-surface-content-id", sourceId);
}

async function actualTerrainSample(page: Page) {
  const canvas = page.locator("canvas");
  await expect.poll(() => canvas.getAttribute("data-surface-normal")).not.toBeNull();
  const normal = JSON.parse((await canvas.getAttribute("data-surface-normal"))!) as number[];
  const height = Number(await canvas.getAttribute("data-surface-height-km"));
  expect(normal).toHaveLength(3);
  expect(Math.hypot(...normal)).toBeCloseTo(1, 6);
  expect(Number.isFinite(height)).toBe(true);
  // This diagnostic comes from the displaced Float32 vertex, not from calling
  // the height function again. One metre allows local geometry round-off.
  expect(Math.abs(height - terrainHeightKm("mimas", normal)), "实际地面顶点必须使用与碰撞相同的地貌").toBeLessThan(.001);
  return { normal, height };
}

function macroCorrelation(before: PNG, after: PNG) {
  expect([after.width, after.height]).toEqual([before.width, before.height]);
  const sample = (image: PNG) => {
    const values: number[] = [], size = 12;
    for (let y = Math.floor(image.height * .32); y < image.height * .68 - size; y += size) {
      for (let x = Math.floor(image.width * .32); x < image.width * .68 - size; x += size) {
        let light = 0;
        for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
          const i = ((y + dy) * image.width + x + dx) * 4;
          light += image.data[i] * .2126 + image.data[i + 1] * .7152 + image.data[i + 2] * .0722;
        }
        values.push(light / (size * size));
      }
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return values.map(value => value - mean);
  };
  const a = sample(before), b = sample(after);
  const squared = (values: number[]) => values.reduce((sum, value) => sum + value * value, 0);
  expect(Math.sqrt(squared(a) / a.length), "必须比较真实可见的陨石坑纹理").toBeGreaterThan(.7);
  return a.reduce((sum, value, i) => sum + value * b[i], 0) / Math.sqrt(squared(a) * squared(b));
}

test("Herschel 陨石坑从太空进入地表仍使用同一材质、同一分块和真实凹地形", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 900, height: 650 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") { errors.push(message.text()); console.error(message.text()); }
  });
  const normal = terrainMapNormal("mimas", craterUv);
  const rim = terrainMapNormal("mimas", [craterUv[0] + craterAngularRadius / (2 * Math.PI), craterUv[1]]);
  expect(terrainHeightKm("mimas", rim) - terrainHeightKm("mimas", normal), "摄影中的大坑须有实际低于坑缘的坑底").toBeGreaterThan(.25);
  await launchSaved(page, checkpoint(normal, 71.2, 1), "ultra");
  const canvas = page.locator("canvas");
  await expect(canvas).toHaveAttribute("data-render-mode", "space");
  await expect(canvas).toHaveAttribute("data-surface-detail-status", "ready", { timeout: 60_000 });
  await expect(canvas).toHaveAttribute("data-surface-detail-tiles", "4");
  await expect(canvas).toHaveAttribute("data-surface-detail-total-tiles", "4");
  await expect(canvas).toHaveAttribute("data-surface-detail-tile-resolution", "2064x2064");
  const tileIds = JSON.parse((await canvas.getAttribute("data-surface-detail-tile-ids"))!) as string[];
  expect(new Set(tileIds).size, "必须是四个实际驻留纹理，不是逻辑分辨率标签").toBe(4);
  const heightSource = await canvas.getAttribute("data-surface-height-source");
  expect(heightSource).toBeTruthy();
  await expect(canvas).toHaveAttribute("data-render-scale", "1.00");
  await page.waitForTimeout(700);
  const before = PNG.sync.read(await canvas.screenshot({ path: info.outputPath("mimas-shared-surface-space.png"), style: pictureStyle }));
  await page.evaluate(() => {
    const frames: Record<string, string | undefined>[] = [];
    (window as unknown as { continuityFrames: typeof frames }).continuityFrames = frames;
    const canvas = document.querySelector("canvas")!;
    new MutationObserver(() => {
      const { renderMode, surfaceContentId, surfaceDetailTiles, surfaceDetailTotalTiles } = canvas.dataset;
      frames.push({ renderMode, surfaceContentId, surfaceDetailTiles, surfaceDetailTotalTiles });
    }).observe(canvas, { attributes: true, attributeFilter: ["data-render-mode", "data-surface-content-id", "data-surface-detail-tiles", "data-surface-detail-total-tiles"] });
  });
  await page.locator("#flight-pause").click();
  await expect(canvas).toHaveAttribute("data-render-mode", "surface", { timeout: 60_000 });
  await page.locator("#flight-pause").click();
  await expect(canvas).toHaveAttribute("data-space-work-active", "false");
  await expect(canvas).toHaveAttribute("data-surface-content-id", sourceId);
  await expect(canvas).toHaveAttribute("data-surface-height-source", heightSource!);
  await expect(canvas).toHaveAttribute("data-surface-detail-tiles", "4");
  await expect(canvas).toHaveAttribute("data-surface-detail-total-tiles", "4");
  expect(JSON.parse((await canvas.getAttribute("data-surface-detail-tile-ids"))!), "进入局部地表须复用已驻留的四个纹理").toEqual(tileIds);
  const frames = await page.evaluate(() => (window as unknown as {
    continuityFrames: { renderMode?: string; surfaceContentId?: string; surfaceDetailTiles?: string; surfaceDetailTotalTiles?: string }[];
  }).continuityFrames);
  expect(frames.filter(frame => frame.renderMode === "surface").every(frame => frame.surfaceContentId === sourceId && frame.surfaceDetailTiles === "4"),
    "模式切换不能出现换图或清空整个纹理缓存的过渡帧").toBe(true);
  expect(frames.every(frame => Number(frame.surfaceDetailTotalTiles) <= 4), "所有世界与两种渲染模式共用至多四块 GPU 缓存").toBe(true);
  await actualTerrainSample(page);
  await expect(canvas).toHaveAttribute("data-render-scale", "1.00");
  const after = PNG.sync.read(await canvas.screenshot({ path: info.outputPath("mimas-shared-surface-entry.png"), style: pictureStyle }));
  expect(macroCorrelation(before, after), "越过渲染边界后仍须看见同一个大坑，允许透视比例轻微变化").toBeGreaterThan(.78);
  expect(errors).toEqual([]);
});

test("陨石坑底与坑缘落地都有一致的几何高度，手机降低采样精度仍保留同一坑", async ({ browser, baseURL }, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const center = terrainMapNormal("mimas", craterUv);
  const rim = terrainMapNormal("mimas", [craterUv[0] + craterAngularRadius / (2 * Math.PI), craterUv[1]]);
  const heights: number[] = [];
  for (const normal of [center, rim]) {
    const context = await browser.newContext({ baseURL, reducedMotion: "reduce", viewport: mobile ? { width: 393, height: 851 } : { width: 900, height: 650 },
      isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      await launchSaved(page, checkpoint(normal, 0, 0, true), "standard");
      const canvas = page.locator("canvas");
      await expect(canvas).toHaveAttribute("data-render-mode", "surface");
      await expect(canvas).toHaveAttribute("data-surface-detail-tiles", "0");
      await expect(canvas).toHaveAttribute("data-surface-detail-total-tiles", "0");
      await expect(page.locator("#flight-surface")).toHaveAttribute("data-phase", "landed");
      const sample = await actualTerrainSample(page);
      expect(new THREE.Vector3().fromArray(sample.normal).distanceTo(new THREE.Vector3().fromArray(normal))).toBeLessThan(1e-5);
      heights.push(sample.height);
      await page.locator("#flight-exit").click();
      await expect(page.locator("#walking-panel")).toHaveAttribute("data-grounded", "true");
      await expect(canvas).toHaveAttribute("data-surface-content-id", sourceId);
      await actualTerrainSample(page);
      await page.screenshot({ path: info.outputPath(`mimas-${heights.length === 1 ? "crater-floor" : "crater-rim"}-${mobile ? "mobile" : "desktop"}.png`) });
    } finally {
      await context.close();
    }
  }
  expect(heights[1] - heights[0], "大坑在实际落地几何中仍须为凹坑，不能变为平地").toBeGreaterThan(.25);
});
