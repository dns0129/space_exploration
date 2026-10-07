import { test, expect } from "@playwright/test";
import { terrainHeightKm, LANDING_CLEARANCE_KM } from "../shared/surface.mjs";

test("离地十公里内手动250与1米每秒生效，朝外仍不能启动轨道，释放和刹车可停稳", async ({ page }) => {
  test.setTimeout(120000);
  const world = await (await page.request.get("/api/world")).json();
  const earth = world.bodies.find((body: any) => body.id === "earth");
  const altitudeKm = terrainHeightKm("earth", [0, 0, 1]) + LANDING_CLEARANCE_KM + 5;
  await page.request.get("/api/flight/save");
  const response = await page.request.post("/api/flight/save", { data: {
    version: 2, position: [earth.position[0], earth.position[1], earth.position[2] + earth.radius + altitudeKm / world.unitsKm],
    velocity: [1000 / world.unitsKm, 0, 0], orientation: [0, 1, 0, 0],
    target: "earth", camera: "cockpit", assist: true, elapsed: 0,
  } });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "自由航行", exact: true }).click();
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await page.getByRole("combobox", { name: "航行画质" }).selectOption("standard");
  await page.locator("#flight-pause").click();
  await page.locator("#flight-resume").click();
  await expect(page.locator("#flight-engine")).toHaveText("极低大气引擎 · 近地精细驾驶");
  await expect(page.locator("#flight-speed-unit")).toHaveText("m/s");
  await expect(page.locator("#flight-orbital")).toBeDisabled();
  await expect(page.locator("#flight-orbital")).toHaveAttribute("title", /离地超过 10,000 m/);
  await page.locator("#flight-propulsion summary").click();
  await page.locator("#flight-low-speed-number").fill("250");
  await page.locator("#flight-low-speed-number").press("Tab");
  await expect(page.locator("#flight-speed")).toHaveText("250");
  await expect(page.locator("#flight-engine-range")).toHaveText("1–1,000 m/s · 当前上限 250 m/s");
  await page.locator("#flight-save").click();
  await expect(page.locator("#flight-storage")).toHaveText("已保存 · 服务端");
  const preset250 = (await (await page.request.get("/api/flight/save")).json()).state;
  expect(Math.hypot(...preset250.velocity) * world.unitsKm * 1000).toBeCloseTo(250, 5);
  expect(preset250.atmosphericSpeedMps).toBe(250);
  await page.locator("#flight-low-speed-number").fill("1");
  await page.locator("#flight-low-speed-number").press("Tab");
  await expect(page.locator("#flight-low-speed")).toHaveValue("1");
  await expect(page.locator("#flight-engine-range")).toHaveText("1–1,000 m/s · 当前上限 1 m/s");
  await page.locator("#flight-propulsion summary").click();
  await page.locator("#flight-pause").click();
  await page.keyboard.down("w");
  try {
    await expect(page.locator("#flight-speed-unit")).toHaveText("m/s");
    await expect(page.locator("#flight-speed")).toHaveText("1");
    await page.locator("#flight-save").click();
    await expect(page.locator("#flight-storage")).toHaveText("已保存 · 服务端");
    const state = (await (await page.request.get("/api/flight/save")).json()).state;
    const speed = Math.hypot(...state.velocity) * world.unitsKm * 1000;
    expect(speed).toBeGreaterThan(0.999);
    expect(speed).toBeLessThanOrEqual(1.000001);
    expect(state.atmosphericSpeedMps).toBe(1);
  } finally {
    await page.keyboard.up("w");
  }
  await expect.poll(async () => Number((await page.locator("#flight-speed").innerText()).replaceAll(",", ""))).toBeLessThan(1);
  await page.keyboard.down("Space");
  try { await expect(page.locator("#flight-speed")).toHaveText("0"); }
  finally { await page.keyboard.up("Space"); }
  await page.locator("#flight-save").click();
  await expect(page.locator("#flight-storage")).toHaveText("已保存 · 服务端");
  const stopped = (await (await page.request.get("/api/flight/save")).json()).state;
  expect(Math.hypot(...stopped.velocity) * world.unitsKm * 1000).toBeLessThan(0.05);
  await page.locator("#flight-resume").click();
  await page.locator("#flight-propulsion summary").click();
  await expect(page.locator("#flight-low-speed-number")).toHaveValue("1");
});
