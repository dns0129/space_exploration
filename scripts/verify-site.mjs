import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium, expect, devices } from "@playwright/test";
import { PNG } from "pngjs";
import { verifyBetelgeuseFlight } from "./verify-betelgeuse.mjs";
import { verifySurfaceFlight } from "./verify-surface.mjs";
import { verifyWalkingFlight } from "./verify-walking.mjs";

const root = fileURLToPath(new URL("../dist-site/", import.meta.url));
const output = fileURLToPath(new URL("../test-results/site/", import.meta.url));
const base = process.env.VOYAGER_SITE_BASE || "/space_exploration/";
const version = JSON.parse(
  await readFile(resolve(root, "version.json"), "utf8"),
);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    if (!pathname.startsWith(base)) {
      res.writeHead(404).end();
      return;
    }
    const file = resolve(root, pathname.slice(base.length) || "index.html");
    if (!file.startsWith(resolve(root) + sep)) {
      res.writeHead(404).end();
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await mkdir(output, { recursive: true });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium",
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
        "--disable-gpu-compositing",
  ],
});
try {
  for (const mobile of process.argv.includes("--mobile") ? [true] : [false, true]) {
    const name = mobile ? "mobile" : "desktop";
    const context = await browser.newContext({
      ...(mobile
        ? devices["Pixel 7"]
        : { viewport: { width: 1440, height: 1000 } }),
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors = [],
      requests = [],
      failed = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("request", (request) => requests.push(request.url()));
    page.on("response", (response) => {
      if (response.status() >= 400)
        failed.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(origin + base);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "去看更远的",
    );
    const image = await page
      .locator(".hero-planet img")
      .evaluate(async (image) => {
        await image.decode();
        return image.naturalWidth;
      });
    assert.equal(image, 900, "Home must show the actual rendered Earth poster");
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Home must fit the viewport",
    );
    if (mobile) {
      await page.getByRole("button", { name: "打开导航" }).click();
      await expect(
        page.getByRole("navigation", { name: "网站导航" }),
      ).toBeVisible();
      await page
        .locator(".site-nav")
        .getByRole("link", { name: "驾驶指南" })
        .click();
      await expect(
        page.getByRole("button", { name: "打开导航" }),
      ).toHaveAttribute("aria-expanded", "false");
    }
    await page.getByRole("button", { name: "海王星", exact: true }).click();
    await expect(page.locator("#destination-name")).toHaveText("海王星");
    await expect(page.locator("#destination-link")).toHaveAttribute(
      "href",
      new RegExp("game.html.*#planet=neptune$"),
    );
    await page.screenshot({
      path: resolve(output, `home-${name}.png`),
      // Full-page capture resets touch emulation in system Chromium; retain it before opening the game.
      fullPage: !mobile,
    });
    await page.getByRole("link", { name: "观测海王星", exact: true }).click();
    await expect(page.locator("#canvas-host")).toHaveAttribute(
      "data-body",
      "neptune",
      { timeout: 45000 },
    );
    const shot = PNG.sync.read(await page.locator("canvas").screenshot());
    let pixels = 0;
    for (let i = 0; i < shot.data.length; i += 4)
      if (shot.data[i] + shot.data[i + 1] + shot.data[i + 2] > 240) pixels++;
    assert(pixels > 5000, "Online game must render actual planetary pixels");
    for (const id of ["mars", "moon"]) {
      if (id === "mars") await page.locator('button[data-body="mars"]').click();
      else await page.locator("#satellite-target").selectOption(id);
      await expect(page.locator("#canvas-host")).toHaveAttribute("data-body", id, { timeout: 45000 });
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-map", `${id}-real${mobile ? "" : "-8k"}.jpg`);
      await expect(page.locator("canvas")).toHaveAttribute("data-surface-resolution", mobile ? "4096x2048" : "8192x4096");
      await page.locator('.primary-button[data-view="close"]').click();
      const canvas = page.locator("canvas");
      if (mobile) {
        await expect(canvas).toHaveAttribute("data-surface-detail-status", "disabled");
        await expect(canvas).toHaveAttribute("data-surface-detail-tiles", "0");
        assert.equal(await canvas.getAttribute("data-surface-detail-resolution"), null, "Phone must keep its complete base image without 16K composite tiles");
      } else {
        await page.locator("#quality").selectOption("ultra");
        await expect(canvas).toHaveAttribute("data-surface-detail-status", "ready", { timeout: 60000 });
        await expect(canvas).toHaveAttribute("data-surface-detail-body", id);
        await expect(canvas).toHaveAttribute("data-surface-detail-kind", "enhanced");
        await expect(canvas).toHaveAttribute("data-surface-detail-resolution", "16384x8192");
        await expect(canvas).toHaveAttribute("data-surface-detail-tile-resolution", "2064x2064");
        await expect(canvas).toHaveAttribute("data-surface-detail-tiles", "4");
      }
    }
    if (!mobile) {
      await page.locator('button[data-body="earth"]').click();
      await expect(page.locator("#canvas-host")).toHaveAttribute("data-body", "earth", { timeout: 45000 });
      await expect(page.locator("#loading-overlay")).toBeHidden();
      await page.locator('.primary-button[data-view="close"]').click();
      const canvas = page.locator("canvas");
      await expect(canvas).toHaveAttribute("data-surface-detail-tiles", "4", { timeout: 60000 });
      await expect(canvas).toHaveAttribute("data-surface-detail-kind", "native");
      await expect(canvas).toHaveAttribute("data-surface-detail-body", "earth");
      await expect(canvas).toHaveAttribute("data-surface-detail-resolution", "16384x8192");
      await expect(canvas).toHaveAttribute("data-surface-detail-tile-resolution", "2064x2064");
    }
    await page.getByRole("link", { name: "星际探索首页", exact: true }).click();
    await page.getByRole("link", { name: "立即启航", exact: true }).click();
    await expect(page.locator("#canvas-host")).toHaveAttribute(
      "data-mode",
      "flight",
      { timeout: 45000 },
    );
    await page
      .getByRole("combobox", { name: "航行画质" })
      .selectOption("standard");
    await expect(page.locator("#flight-storage")).toHaveText("本机存档");
    await page.keyboard.down("w");
    await page.waitForFunction(
      () =>
        Number(
          document
            .querySelector("#flight-speed")
            .textContent.replaceAll(",", ""),
        ) > 5,
    );
    await page.keyboard.up("w");
    await page.getByRole("button", { name: "暂停航行", exact: true }).click();
    await page.getByRole("button", { name: "保存航行", exact: true }).click();
    await expect(page.locator("#flight-storage")).toHaveText("已保存 · 本机");
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("voyager-flight-v1")),
    );
    assert(
      Math.hypot(...saved.velocity) > 0,
      "Saved flight must include actual movement",
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await expect(page.locator("#canvas-host")).toHaveAttribute(
      "data-mode",
      "flight",
      { timeout: 45000 },
    );
    await expect(
      page.getByRole("button", { name: "恢复存档", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "恢复存档", exact: true }).click();
    await expect(page.locator("#flight-nearest")).toHaveText("地球");
    await expect(page.locator("#toast")).toHaveText("已恢复航行存档");
    await page
      .getByRole("combobox", { name: "航行画质" })
      .selectOption("standard");
    await page.locator('button[data-body="mars"]').click();
    await page.keyboard.press("j");
    await expect(page.locator("#warp-engine")).toHaveAttribute(
      "data-phase",
      "transit",
      { timeout: 30000 },
    );
    await page.screenshot({ path: resolve(output, `flight-${name}.png`) });
    await expect(page.locator("#warp-engine")).toHaveAttribute(
      "data-phase",
      "ready",
      { timeout: 60000 },
    );
    await expect(page.locator("#flight-nearest")).toHaveText("火星");
    await page.getByRole("combobox", { name: "恒星系统", exact: true }).selectOption("alpha-centauri");
    await expect(page.locator("#flight-distance-unit")).toHaveText("光年");
    await expect(page.locator("canvas")).toHaveAttribute("data-system", "solar");
    await page.locator('button[data-body="proxima-b"]').click();
    await page.locator("#flight-jump").click();
    await expect(page.locator("#warp-engine")).toHaveAttribute("data-phase", "transit", { timeout: 30000 });
    await expect(page.locator("#warp-engine")).toHaveAttribute("data-phase", "ready", { timeout: 60000 });
    await expect(page.locator("canvas")).toHaveAttribute("data-system", "proxima-centauri");
    await expect(page.locator("canvas")).toHaveAttribute("data-background", "milky-way-4k.jpg");
    await expect(page.locator("#flight-nearest")).toHaveText("比邻星 b");
    await page.locator("#flight-pause").click();
    await page.locator("#flight-save").click();
    await expect(page.locator("#flight-storage")).toHaveText("已保存 · 本机");
    const interstellarSave = await page.evaluate(() => JSON.parse(localStorage.getItem("voyager-flight-v1")));
    assert.equal(interstellarSave.systemId, "proxima-centauri");
    assert.equal(interstellarSave.target, "proxima-b");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await expect(page.locator("#flight-resume")).toBeEnabled({ timeout: 45000 });
    await page.locator("#flight-resume").click();
    await expect(page.locator("canvas")).toHaveAttribute("data-system", "proxima-centauri");
    await expect(page.locator("canvas")).toHaveAttribute("data-background", "milky-way-4k.jpg");
    await expect(page.locator("#flight-target")).toHaveText("比邻星 b");
    await page.screenshot({ path: resolve(output, `centauri-${name}.png`) });
    await verifyBetelgeuseFlight(page);
    await verifySurfaceFlight(page);
    await verifyWalkingFlight(page);
    await page.screenshot({ path: resolve(output, `landed-${name}.png`) });
    // A changed deployment offers refresh and leaves the current flight intact.
    await page.route("**/version.json?*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          revision: "f".repeat(40),
          builtAt: version.builtAt,
        }),
      }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator(".site-update")).toContainText("新版本已上线");
    await expect(page.locator("#canvas-host")).toHaveAttribute(
      "data-mode",
      "flight",
    );
    const update = page.waitForURL(
      (url) => url.searchParams.get("build") === "f".repeat(40),
    );
    await page.locator(".site-update button").click();
    await update;
    await expect(page.locator("#canvas-host")).toHaveAttribute(
      "data-mode",
      "flight",
      { timeout: 45000 },
    );
    assert(
      requests.every((url) => url.startsWith(origin + base)),
      "All online assets must remain under the project base path",
    );
    assert(
      !requests.some((url) => new URL(url).pathname.includes("/api/")),
      "Static website must never request a backend API",
    );
    assert.deepEqual(failed, [], "All deployed paths must return successfully");
    assert.deepEqual(errors, [], "Online website must have no browser errors");
    console.log(
      `${name}: homepage, planet links, rendered game, direct flight, local save after refresh, warp and deployment update passed`,
    );
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
