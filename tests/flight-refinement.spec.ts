import { test, expect } from "@playwright/test";
import { terrainHeightKm, LANDING_CLEARANCE_KM } from "../shared/surface.mjs";

async function launch(page: any) {
  await page.goto("/");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "自由航行", exact: true }).click();
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-mode", "flight");
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await page.getByRole("combobox", { name: "航行画质" }).selectOption("standard");
}

test("锁定标识居中对齐天体，转向逐帧跟随，鼠标不转向、触屏持续操纵后释放", async ({ page }, info) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await launch(page);
  await page.locator("#flight-align").click();
  await expect(page.locator("#flight-marker")).not.toHaveClass(/offscreen/);
  const offset = await page.evaluate(() => {
    const marker = document.querySelector("#flight-marker")!.getBoundingClientRect();
    const canvas = document.querySelector("canvas")!.getBoundingClientRect();
    return [marker.x + marker.width / 2 - canvas.x - canvas.width / 2,
      marker.y + marker.height / 2 - canvas.y - canvas.height / 2];
  });
  expect(Math.abs(offset[0])).toBeLessThan(2);
  expect(Math.abs(offset[1])).toBeLessThan(2);
  await expect(page.locator("#flight-jump")).toBeEnabled();
  await page.keyboard.down("ArrowRight");
  const frames = await page.evaluate(async () => {
    const positions: string[] = [];
    for (let i = 0; i < 12; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      positions.push((document.querySelector("#flight-marker") as HTMLElement).style.transform);
    }
    return new Set(positions).size;
  });
  await page.keyboard.up("ArrowRight");
  expect(frames, "锁定标识应跟随每个渲染帧，而不是慢速仪表刷新").toBeGreaterThanOrEqual(10);
  const box = (await page.locator("canvas").boundingBox())!;
  if (info.project.name === "mobile") {
    const cdp = await page.context().newCDPSession(page);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 0 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, x: point.x + 60 }] });
    await expect(page.locator("#flight-aim")).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(box.x + box.width * 0.72, box.y + box.height / 2);
    await expect(page.locator("#flight-aim")).toBeHidden();
    await page.locator("#flight-align").click();
    await expect.poll(async () => {
      const marker = await page.locator("#flight-marker").boundingBox();
      return Math.abs(marker!.x + marker!.width / 2 - box.x - box.width / 2);
    }).toBeLessThan(2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8);
    await page.mouse.up();
    await expect(page.locator("#flight-aim")).toBeHidden();
    const transforms = await page.evaluate(async () => {
      const values: string[] = [];
      for (let i = 0; i < 8; i++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        values.push((document.querySelector("#flight-marker") as HTMLElement).style.transform);
      }
      return values;
    });
    expect(new Set(transforms).size).toBe(1);
  }
  await expect(page.locator("#flight-aim")).toBeHidden();
  await page.locator("#flight-align").click();
  await page.getByRole("button", { name: "切换外部视角" }).click();
  await page.screenshot({ path: info.outputPath("explorer-chase.png") });
  expect(errors).toEqual([]);
});

test("大气内手动引擎与超过二十万千米每秒的航速保存恢复，不按高度自动换档限速", async ({ page }, info) => {
  test.setTimeout(120000);
  const world = await (await page.request.get("/api/world")).json();
  const earth = world.bodies.find((body: any) => body.id === "earth");
  const cruiseSpeedKm = 300001.5;
  await page.request.get("/api/flight/save");
  const response = await page.request.post("/api/flight/save", { data: {
    version: 2, worldLayoutVersion: world.layoutVersion,
    position: [earth.position[0], earth.position[1], earth.position[2] + earth.radius + 50 / world.unitsKm],
    velocity: [cruiseSpeedKm / world.unitsKm, 0, 0], orientation: [0, 0, 0, 1],
    target: "earth", camera: "cockpit", assist: false, elapsed: 0,
    engineMode: "atmospheric", cruiseSpeedKm,
  } });
  expect(response.ok()).toBe(true);
  await launch(page);
  await page.locator("#flight-pause").click();
  await page.locator("#flight-resume").click();
  await expect(page.locator("#flight-ui")).toHaveAttribute("data-environment", "atmosphere");
  await expect(page.locator("#flight-engine")).toHaveText("极低大气引擎 · 手动选择");
  await expect(page.locator("#flight-speed-unit")).toHaveText("km/s");
  await expect(page.locator("#flight-speed")).toHaveText("300,001.5");
  await page.locator("#flight-propulsion summary").click();
  await page.locator("#flight-engine-mode").selectOption("interstellar");
  await expect(page.locator("#flight-engine-mode")).toHaveValue("interstellar");
  await expect(page.locator("#flight-engine-range")).toHaveText("设定航速 300,001.5 km/s · 最低 100 km/s");
  await expect(page.locator("#flight-speed")).toHaveText("300,001.5");
  await page.locator("#flight-save").click();
  await expect(page.locator("#flight-storage")).toHaveText("已保存 · 服务端");
  const saved = (await (await page.request.get("/api/flight/save")).json()).state;
  expect(saved.engineMode).toBe("interstellar");
  expect(saved.cruiseSpeedKm).toBe(cruiseSpeedKm);
  expect(Math.hypot(...saved.velocity) * world.unitsKm).toBeCloseTo(cruiseSpeedKm, 5);
  await page.locator('[data-cruise-speed="100"]').click();
  await page.locator("#flight-engine-mode").selectOption("orbital");
  await page.locator("#flight-resume").click();
  await expect(page.locator("#flight-engine-mode")).toHaveValue("interstellar");
  await expect(page.locator("#flight-cruise-speed")).toHaveValue(String(cruiseSpeedKm));
  await expect(page.locator("#flight-speed")).toHaveText("300,001.5");
  await page.screenshot({ path: info.outputPath("atmosphere-manual-speed.png") });
});

test("低于十公里且朝向地表时O直接选择轨道引擎，可向其他天体跃迁并预设手动航速", async ({ page }, info) => {
  test.setTimeout(120000);
  const world = await (await page.request.get("/api/world")).json();
  const earth = world.bodies.find((body: any) => body.id === "earth");
  const altitudeKm = terrainHeightKm("earth", [0, 0, 1]) + LANDING_CLEARANCE_KM + 5;
  await page.request.get("/api/flight/save");
  const response = await page.request.post("/api/flight/save", { data: {
    version: 2, worldLayoutVersion: world.layoutVersion,
    position: [earth.position[0], earth.position[1], earth.position[2] + earth.radius + altitudeKm / world.unitsKm],
    velocity: [0, 0, 0], orientation: [0, 0, 0, 1], target: "earth", camera: "cockpit", assist: true, elapsed: 0,
    engineMode: "planetary", cruiseSpeedKm: 100,
  } });
  expect(response.ok()).toBe(true);
  await launch(page);
  await page.locator("#flight-pause").click();
  await page.locator("#flight-resume").click();
  await expect(page.locator("#flight-ui")).toHaveAttribute("data-environment", "atmosphere");
  await expect(page.locator("#flight-orbital")).toBeEnabled();
  if (info.project.name === "mobile") await page.locator("#flight-orbital").click();
  else await page.keyboard.press("o");
  await expect(page.locator("#flight-engine")).toHaveText("近地轨道引擎 · 手动选择");
  await expect(page.locator("#flight-orbital")).toBeEnabled();
  await expect(page.locator("#flight-pause")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#flight-speed-unit")).toHaveText("km/s");
  await expect(page.locator("#flight-engine-range")).toHaveText("设定航速 100 km/s · 最低 100 km/s");
  await page.locator('button[data-body="mars"]').click();
  await page.locator("#flight-align").click();
  await expect(page.locator("#flight-jump")).toBeEnabled();
  await page.locator("#flight-jump").click();
  await expect(page.locator("#warp-engine")).toHaveAttribute("data-phase", "charging");
  await page.locator("#flight-propulsion summary").click();
  await expect(page.locator("#flight-engine-mode")).toBeEnabled();
  await expect(page.locator("#flight-cruise-speed")).toBeEnabled();
  await page.locator("#flight-engine-mode").selectOption("atmospheric");
  await page.locator('[data-cruise-speed="1000"]').click();
  await expect(page.locator("#flight-cruise-speed")).toHaveValue("1000");
  await page.locator("#warp-cancel").click();
  await expect(page.locator("#warp-engine")).toHaveAttribute("data-phase", "ready");
  await page.locator("#flight-pause").click();
  await expect(page.locator("#flight-engine")).toHaveAttribute("data-engine", "atmospheric");
  await page.locator("#flight-save").click();
  await expect(page.locator("#flight-storage")).toHaveText("已保存 · 服务端");
  const saved = (await (await page.request.get("/api/flight/save")).json()).state;
  expect(saved.engineMode).toBe("atmospheric");
  expect(saved.cruiseSpeedKm).toBe(1000);
  expect(saved.target).toBe("mars");
});
