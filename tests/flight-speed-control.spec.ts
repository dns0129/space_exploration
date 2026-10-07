import { test, expect } from "@playwright/test";
import { terrainHeightKm, LANDING_CLEARANCE_KM } from "../shared/surface.mjs";

test("低空四种引擎共享无上限手动航速，快捷与自定义预设保存恢复，最低100且刹车可停稳", async ({ page }, info) => {
  test.setTimeout(120000);
  const world = await (await page.request.get("/api/world")).json();
  const earth = world.bodies.find((body: any) => body.id === "earth");
  const altitudeKm = terrainHeightKm("earth", [0, 0, 1]) + LANDING_CLEARANCE_KM + 5;
  await page.request.get("/api/flight/save");
  const response = await page.request.post("/api/flight/save", { data: {
    version: 2, worldLayoutVersion: world.layoutVersion,
    position: [earth.position[0], earth.position[1], earth.position[2] + earth.radius + altitudeKm / world.unitsKm],
    velocity: [0, 0, 0], orientation: [0, 1, 0, 0],
    target: "earth", camera: "cockpit", assist: true, elapsed: 0,
    engineMode: "planetary", cruiseSpeedKm: 100,
  } });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "自由航行", exact: true }).click();
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await page.getByRole("combobox", { name: "航行画质" }).selectOption("standard");
  await page.locator("#flight-pause").click();
  await page.locator("#flight-resume").click();
  await expect(page.locator("#flight-ui")).toHaveAttribute("data-environment", "atmosphere");
  await expect(page.locator("#flight-speed-unit")).toHaveText("km/s");
  await expect(page.locator("#flight-orbital")).toBeEnabled();
  await page.locator("#flight-propulsion summary").click();
  const cruise = page.locator("#flight-cruise-speed");
  await expect(cruise).toHaveAttribute("min", "100");
  expect(await cruise.getAttribute("max")).toBeNull();
  for (const preset of [100, 1000, 10000, 100000]) {
    await page.locator(`[data-cruise-speed="${preset}"]`).click();
    await expect(cruise).toHaveValue(String(preset));
    await expect(page.locator(`[data-cruise-speed="${preset}"]`)).toHaveAttribute("aria-pressed", "true");
  }
  await cruise.fill("50");
  await cruise.press("Tab");
  await expect(cruise).toHaveValue("100000");
  const customSpeed = 250001.5;
  await cruise.fill(String(customSpeed));
  await cruise.press("Tab");
  for (const mode of ["atmospheric", "orbital", "planetary", "interstellar"]) {
    await page.locator("#flight-engine-mode").selectOption(mode);
    await expect(page.locator("#flight-engine")).toHaveAttribute("data-engine", mode);
    await expect(cruise).toHaveValue(String(customSpeed));
    await expect(page.locator("#flight-engine-range")).toHaveText("设定航速 250,001.5 km/s · 最低 100 km/s");
  }
  await page.locator("#flight-save").click();
  await expect(page.locator("#flight-storage")).toHaveText("已保存 · 服务端");
  const custom = (await (await page.request.get("/api/flight/save")).json()).state;
  expect(custom.cruiseSpeedKm).toBe(customSpeed);
  expect(custom.engineMode).toBe("interstellar");
  await page.locator('[data-cruise-speed="100"]').click();
  await page.locator("#flight-resume").click();
  await expect(cruise).toHaveValue(String(customSpeed));
  await expect(page.locator("#flight-engine-mode")).toHaveValue("interstellar");
  await page.locator("#flight-engine-mode").selectOption("atmospheric");
  await page.locator('[data-cruise-speed="100"]').click();
  await page.locator("#flight-propulsion summary").click();
  await page.locator("#flight-pause").click();
  let release: () => Promise<void>;
  if (info.project.name === "mobile") {
    const box = (await page.locator('[data-flight-input="KeyW"]').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 0 }] });
    release = async () => { await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach(); };
  } else {
    await page.keyboard.down("w");
    release = () => page.keyboard.up("w");
  }
  try {
    await expect(page.locator("#flight-speed")).toHaveText("100");
    await expect(page.locator("#flight-engine")).toHaveAttribute("data-engine", "atmospheric");
    await page.locator("#flight-pause").click();
  } finally { await release(); }
  await page.locator("#flight-save").click();
  await expect(page.locator("#flight-storage")).toHaveText("已保存 · 服务端");
  const powered = (await (await page.request.get("/api/flight/save")).json()).state;
  expect(Math.hypot(...powered.velocity) * world.unitsKm).toBeCloseTo(100, 4);
  expect(powered.cruiseSpeedKm).toBe(100);
  expect(powered.engineMode).toBe("atmospheric");
  await page.locator("#flight-pause").click();
  await page.keyboard.down("Space");
  try { await expect(page.locator("#flight-speed")).toHaveText("0"); }
  finally { await page.keyboard.up("Space"); }
  await page.locator("#flight-pause").click();
  await page.locator("#flight-save").click();
  await expect(page.locator("#flight-storage")).toHaveText("已保存 · 服务端");
  const stopped = (await (await page.request.get("/api/flight/save")).json()).state;
  expect(Math.hypot(...stopped.velocity) * world.unitsKm).toBeLessThan(0.05);
  expect(stopped.engineMode).toBe("atmospheric");
  expect(stopped.cruiseSpeedKm).toBe(100);
  await page.locator("#flight-resume").click();
  await page.locator("#flight-propulsion summary").click();
  await expect(cruise).toHaveValue("100");
  await expect(page.locator("#flight-engine-mode")).toHaveValue("atmospheric");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
