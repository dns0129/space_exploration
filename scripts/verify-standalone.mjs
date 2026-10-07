import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { verifyBetelgeuseFlight } from "./verify-betelgeuse.mjs";
import { verifySurfaceFlight } from "./verify-surface.mjs";
import { verifyWalkingFlight } from "./verify-walking.mjs";
import { terrainHeightField, TERRAIN_VERSION } from "../shared/surface.mjs";
import { createServer } from "node:http";

const html = await readFile(
  new URL("../dist-standalone/voyager-warp.html", import.meta.url),
  "utf8",
);
// Give the offline document an ordinary origin so browser local storage can be tested.
const origin = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(html);
});
await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
        "--disable-gpu-compositing",
  ],
});
try {
  const context = await browser.newContext({
    offline: false,
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const documentUrl = `http://127.0.0.1:${origin.address().port}/`;
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && request.url() !== documentUrl) requests.push(request.url());
  });
  // Stream the exact exported document through an ordinary origin, then disconnect.
  // This avoids duplicating a 100+ MiB document through CDP's setContent payload.
  // Only the document request is allowed; every image, script and style is embedded.
  await page.goto(documentUrl, { waitUntil: "load", timeout: 60_000 });
  await context.setOffline(true);
  await new Promise((resolve) => origin.close(resolve));
  for (const id of [
    "earth",
    "mercury",
    "venus",
    "mars",
    "jupiter",
    "saturn",
    "uranus",
    "neptune",
    "sun", "ceres", "earth-station",
    "moon", "io", "europa", "ganymede", "callisto",
    "mimas", "enceladus", "tethys", "dione", "rhea", "titan", "hyperion", "iapetus",
    "miranda", "ariel", "umbriel", "titania", "oberon",
    "naiad", "thalassa", "despina", "galatea", "larissa", "proteus", "triton", "nereid",
    "alpha-centauri-a", "alpha-centauri-b", "proxima-centauri", "proxima-b", "proxima-c", "proxima-d", "betelgeuse",
  ]) {
    if (id === "betelgeuse") await page.locator("#star-system").selectOption("betelgeuse");
    if (id === "alpha-centauri-a") await page.locator("#star-system").selectOption("alpha-centauri");
    if (await page.locator(`button[data-body="${id}"]`).count()) {
      if (id !== "earth") await page.locator(`button[data-body="${id}"]`).click();
    } else await page.locator("#satellite-target").selectOption(id);
    await page.waitForFunction(
      (body) => document.querySelector("#canvas-host")?.dataset.body === body,
      id,
      { timeout: 30_000 },
    );
    if (id !== "earth-station") {
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-content-id", `${id}:surface-v${TERRAIN_VERSION}:16k`);
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-height-source", terrainHeightField(id)?.sourceId ?? "none");
    }
    if (id === "earth") {
      await page.locator("#quality").selectOption("ultra");
      await expect(page.locator("canvas")).toHaveAttribute("data-earth-maps", "8k", { timeout: 60_000 });
      await page.locator('#control-panel button[data-view="close"]').click();
      await expect(page.locator("canvas")).toHaveAttribute("data-earth-detail-tiles", "4", { timeout: 60_000 });
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-detail-kind", "native");
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-detail-body", "earth");
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-detail-resolution", "16384x8192");
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-detail-tile-resolution", "2064x2064");
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-detail-total-tiles", "4");
      const detail = PNG.sync.read(await page.locator("canvas").screenshot());
      assert(detail.data.some((value, index) => index % 4 !== 3 && value > 120), "Offline ultra Earth must render actual pixels");
      await page.locator("#quality").selectOption("standard");
      await expect(page.locator("canvas")).toHaveAttribute("data-earth-detail-tiles", "0");
      await page.getByRole("button", { name: "重置视角" }).click();
      console.log("Offline Earth: embedded 8K maps and native 16K tiles rendered without network requests");
    }
    if (id === "mars" || id === "moon") {
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-map", `${id}-real-8k.jpg`);
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-resolution", "8192x4096");
      console.log(`Offline ${id}: native 8K imagery loaded without network requests`);
    }
    if (id !== "earth" && id !== "earth-station") {
      await page.locator("#quality").selectOption("ultra");
      await page.locator('#control-panel button[data-view="close"]').click();
      const canvas = page.locator("canvas");
      await expect(canvas).toHaveAttribute("data-surface-detail-status", "ready", { timeout: 60_000 });
      await expect(canvas).toHaveAttribute("data-surface-detail-body", id);
      await expect(canvas).toHaveAttribute("data-surface-detail-kind", "enhanced");
      await expect(canvas).toHaveAttribute("data-surface-detail-resolution", "16384x8192");
      await expect(canvas).toHaveAttribute("data-surface-detail-tile-resolution", "2064x2064");
      await expect(canvas).toHaveAttribute("data-surface-detail-tiles", "4");
      await expect(canvas).toHaveAttribute("data-surface-detail-total-tiles", "4");
      assert.equal(new Set(JSON.parse(await canvas.getAttribute("data-surface-detail-tile-ids"))).size, 4,
        "All enhanced bodies must have four distinct physical textures");
      console.log(`Offline ${id}: enhanced 16K composite with four physical 2064x2064 tiles`);
    } else if (id === "earth-station") {
      for (const attribute of ["kind", "body", "family", "resolution", "tile-resolution", "tile-ids", "tiles", "status"])
        assert.equal(await page.locator("canvas").getAttribute(`data-surface-detail-${attribute}`), null, "Station must not retain the previous body's 16K diagnostics");
      for (const attribute of ["content-id", "content-source", "height-source", "normal", "height-km"])
        assert.equal(await page.locator("canvas").getAttribute(`data-surface-${attribute}`), null, "Station must not retain a planetary surface");
    }
    const shot = PNG.sync.read(await page.locator("canvas").screenshot());
    let surface = 0;
    for (let i = 0; i < shot.data.length; i += 4) {
      if (shot.data[i] + shot.data[i + 1] + shot.data[i + 2] > 240) surface++;
    }
    assert(surface > 6000, `${id}: rendered surface is missing`);
    console.log(`Offline ${id}: ${surface} rendered surface pixels`);
    if (id !== "earth" && id !== "earth-station") {
      await page.locator("#quality").selectOption("standard");
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-detail-tiles", "0");
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-detail-total-tiles", "0");
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-content-id", `${id}:surface-v${TERRAIN_VERSION}:16k`);
      assert.equal(await page.locator("canvas").getAttribute("data-surface-detail-resolution"), null, "Disabling enhanced detail must release its resident tiles");
    }
  }
  await page.locator(".brand").click();
  await page.waitForFunction(
    () => document.querySelector("#canvas-host")?.dataset.body === "earth",
  );
  await page.getByRole("button", { name: "自由航行", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#canvas-host")?.dataset.mode === "flight",
  );
  await page.keyboard.down("w");
  await page.waitForFunction(
    () =>
      Number(
        document
          .querySelector("#flight-speed")
          ?.textContent.replaceAll(",", ""),
      ) > 5,
  );
  await page.keyboard.up("w");
  await page.getByRole("button", { name: "暂停航行", exact: true }).click();
  await page.getByRole("button", { name: "保存航行", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("#flight-storage")?.textContent ===
      "已保存 · 本机",
  );
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("voyager-flight-v1")),
  );
  assert(saved.elapsed > 0 && Math.hypot(...saved.velocity) > 0);
  await page.locator('button[data-body="saturn"]').click();
  await page.locator("#flight-jump").click();
  await page.locator('#warp-engine[data-phase="transit"]').waitFor();
  await page.locator('#warp-engine[data-phase="ready"]').waitFor({timeout:45000});
  await page.waitForFunction(
    () => document.querySelector("#flight-nearest")?.textContent === "土星",
  );
  await page.getByRole("button", { name: "恢复存档", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#flight-nearest")?.textContent === "地球",
  );
  await page.getByRole("button", { name: "切换外部视角" }).click();
  await page.locator("#star-system").selectOption("alpha-centauri");
  assert.equal((await page.locator("canvas").getAttribute("data-system")), "solar");
  await page.locator('button[data-body="proxima-b"]').click();
  await page.locator("#flight-jump").click();
  await page.locator('#warp-engine[data-phase="transit"]').waitFor();
  await page.locator('#warp-engine[data-phase="ready"]').waitFor({ timeout: 45000 });
  await page.waitForFunction(() => document.querySelector("#flight-nearest")?.textContent === "比邻星 b");
  assert.equal(await page.locator("canvas").getAttribute("data-background"), "milky-way-4k.jpg");
  assert.equal(await page.locator("canvas").getAttribute("data-system"), "proxima-centauri");
  await page.locator("#flight-pause").click();
  await page.locator("#flight-save").click();
  await page.waitForFunction(() => document.querySelector("#flight-storage")?.textContent === "已保存 · 本机");
  const proximaSave = await page.evaluate(() => JSON.parse(localStorage.getItem("voyager-flight-v1")));
  assert.equal(proximaSave.systemId, "proxima-centauri");
  await page.locator("#star-system").selectOption("solar");
  await page.locator("#flight-jump").click();
  await page.locator('#warp-engine[data-phase="transit"]').waitFor();
  await page.locator('#warp-engine[data-phase="ready"]').waitFor({ timeout: 45000 });
  assert.equal(await page.locator("canvas").getAttribute("data-background"), "milky-way-4k.jpg");
  await page.locator("#flight-resume").click();
  await page.waitForFunction(() => document.querySelector("canvas")?.dataset.system === "proxima-centauri");
  assert.equal(await page.locator("canvas").count(), 1);
  await verifyBetelgeuseFlight(page);
  await verifySurfaceFlight(page);
  await verifyWalkingFlight(page);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    "PASS: all 44 destinations, two sky panoramas, interstellar warp, free flight, thrust, warp, camera, terrain landing, takeoff and local save/restore; zero HTTP requests or browser errors.",
  );
} finally {
  await browser.close();
  if (origin.listening) await new Promise((resolve) => origin.close(resolve));
}
