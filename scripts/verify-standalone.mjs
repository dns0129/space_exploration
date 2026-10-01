import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";

const html = await readFile(
  new URL("../dist-standalone/voyager-solar-system.html", import.meta.url),
  "utf8",
);
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
    offline: true,
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
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
  assert.equal(await page.locator("canvas").count(), 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    "PASS: nine celestial models and return to Earth, zero HTTP requests, zero browser errors.",
  );
} finally {
  await browser.close();
}
