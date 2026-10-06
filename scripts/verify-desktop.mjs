import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { validateFlightState } from "../shared/flight-state.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const output = join(project, "test-results/desktop");
const isolated = await mkdtemp(join(tmpdir(), "voyager-native-"));
await mkdir(output, { recursive: true });
let application;
const errors = [];
const requests = [];

async function launch() {
  application = await electron.launch({
    ...(process.env.VOYAGER_DESKTOP_EXECUTABLE
      ? { executablePath: process.env.VOYAGER_DESKTOP_EXECUTABLE }
      : {}),
    args: [...(process.env.VOYAGER_DESKTOP_EXECUTABLE ? [] : [project]), `--voyager-user-data=${isolated}`],
    timeout: 60_000,
  });
  const page = await application.firstWindow();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", request => requests.push(request.url()));
  page.on("response", response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-mode", "flight", { timeout: 120_000 });
  await expect(page.locator("#loading-overlay")).toBeHidden({ timeout: 120_000 });
  assert.equal(new URL(page.url()).protocol, "voyager:");
  assert.equal(await application.evaluate(({ app }) => app.getPath("userData")), isolated);
  const isolation = await page.evaluate(() => ({
    require: typeof window.require, process: typeof window.process,
    bridge: window.voyagerDesktop?.version,
  }));
  assert.deepEqual(isolation, { require: "undefined", process: "undefined", bridge: 1 });
  return page;
}

async function closeWindow() {
  const exited = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Native save and close did not finish.")), 30_000);
    application.process().once("exit", () => { clearTimeout(timeout); resolve(); });
  });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await exited;
  application = undefined;
}

try {
  let page = await launch();
  await expect(page.locator("#flight-storage")).toHaveText("本机存档");
  await page.getByRole("combobox", { name: "航行画质" }).selectOption("standard");
  await page.locator("#canvas-host").click();
  await page.keyboard.down("w");
  try {
    await expect.poll(async () => Number((await page.locator("#flight-speed").textContent()).replaceAll(",", "")),
      { timeout: 30_000 }).toBeGreaterThan(5);
  } finally { await page.keyboard.up("w"); }
  await page.getByRole("button", { name: "切换外部视角", exact: false }).click();
  await expect(page.locator("#flight-camera")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "暂停航行", exact: true }).click();
  await page.getByRole("button", { name: "保存航行", exact: true }).click();
  await expect(page.locator("#flight-storage")).toHaveText("已保存 · 本机");
  const manual = validateFlightState(JSON.parse(await readFile(join(isolated, "flight.json"), "utf8")));
  assert(manual && manual.elapsed > 0 && manual.camera === "chase");
  assert.equal(await page.evaluate(() => localStorage.getItem("voyager-flight-v1")), null);

  // Adaptive resolution can change the canvas's intrinsic size between frames.
  // Capture its visible viewport without waiting for intrinsic geometry stability.
  const bounds = await page.locator("canvas").boundingBox();
  assert(bounds && bounds.width > 0 && bounds.height > 0);
  const pixels = PNG.sync.read(await page.screenshot({ clip: bounds }));
  let bright = 0;
  for (let i = 0; i < pixels.data.length; i += 4)
    if (pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2] > 240) bright++;
  assert(bright > 5000, "Desktop window must render the actual ship and planet.");
  await page.screenshot({ path: join(output, process.env.VOYAGER_DESKTOP_EXECUTABLE ? "packaged-client.png" : "native-client.png") });

  // Change flight state after the explicit save. Closing must persist this latest state.
  await page.getByRole("button", { name: "切换座舱视角", exact: false }).click();
  await expect(page.locator("#flight-camera")).toHaveAttribute("aria-pressed", "false");
  await closeWindow();
  const closing = validateFlightState(JSON.parse(await readFile(join(isolated, "flight.json"), "utf8")));
  assert(closing && closing.camera === "cockpit", "Native close must await the fresh checkpoint.");

  page = await launch();
  await expect(page.locator("#flight-resume")).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: "暂停航行", exact: true }).click();
  await page.getByRole("button", { name: "恢复存档", exact: true }).click();
  await expect(page.locator("#toast")).toHaveText("已恢复航行存档");
  await page.getByRole("button", { name: "保存航行", exact: true }).click();
  await expect(page.locator("#flight-storage")).toHaveText("已保存 · 本机");
  const restored = validateFlightState(JSON.parse(await readFile(join(isolated, "flight.json"), "utf8")));
  assert.deepEqual(restored, closing);
  await closeWindow();
  assert.equal(requests.filter(url => /^https?:/.test(url)).length, 0, "Native play must require no HTTP requests.");
  assert.deepEqual(errors, []);
  console.log("Desktop passed: native launch, real planet/ship pixels, keyboard thrust, camera, file save, awaited close, restart/restore, isolated renderer, zero HTTP requests.");
} finally {
  if (application) await application.close().catch(() => application.process().kill());
  await rm(isolated, { recursive: true, force: true });
}
