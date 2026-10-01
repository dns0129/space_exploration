import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { createServer } from "node:http";

const html = await readFile(
  new URL("../dist-standalone/voyager-flight.html", import.meta.url),
  "utf8",
);
// Give the offline document an ordinary origin so browser local storage can be tested.
const origin = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end('<link rel="icon" href="data:,">');
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
  ],
});
try {
  const context = await browser.newContext({
    offline: false,
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${origin.address().port}`);
  await context.setOffline(true);
  await new Promise((resolve) => origin.close(resolve));
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  // This environment blocks file:// through browser policy. Executing the exact
  // exported document in an offline context verifies it without bypassing that policy.
  await page.setContent(html, { waitUntil: "load", timeout: 60_000 });
  for (const id of [
    "earth",
    "mercury",
    "venus",
    "mars",
    "jupiter",
    "saturn",
    "uranus",
    "neptune",
    "sun",
  ]) {
    if (id !== "earth") await page.locator(`button[data-body="${id}"]`).click();
    await page.waitForFunction(
      (body) => document.querySelector("#canvas-host")?.dataset.body === body,
      id,
      { timeout: 30_000 },
    );
    const shot = PNG.sync.read(await page.locator("canvas").screenshot());
    let surface = 0;
    for (let i = 0; i < shot.data.length; i += 4) {
      if (shot.data[i] + shot.data[i + 1] + shot.data[i + 2] > 240) surface++;
    }
    assert(surface > 6000, `${id}: rendered surface is missing`);
    console.log(`Offline ${id}: ${surface} rendered surface pixels`);
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
      ) > 700,
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
  await page.getByRole("button", { name: "跃迁至目标" }).click();
  await page.waitForFunction(
    () => document.querySelector("#flight-nearest")?.textContent === "土星",
  );
  await page.getByRole("button", { name: "恢复存档", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#flight-nearest")?.textContent === "地球",
  );
  await page.getByRole("button", { name: "切换外部视角" }).click();
  assert.equal(await page.locator("canvas").count(), 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    "PASS: nine models, free flight, thrust, warp, camera and local save/restore; zero HTTP requests or browser errors.",
  );
} finally {
  await browser.close();
  if (origin.listening) await new Promise((resolve) => origin.close(resolve));
}
