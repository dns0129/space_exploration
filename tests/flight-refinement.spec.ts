import { test, expect } from "@playwright/test";

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

test("大气层内恢复高速存档会限为最低档，切换目标和 J 都不能绕过跃迁限制", async ({ page }, info) => {
  test.setTimeout(120000);
  const world = await (await page.request.get("/api/world")).json();
  const earth = world.bodies.find((body: any) => body.id === "earth");
  await page.request.get("/api/flight/save");
  const response = await page.request.post("/api/flight/save", { data: {
    version: 2, position: [earth.position[0], earth.position[1], earth.position[2] + earth.radius + 50 / world.unitsKm],
    velocity: [50000 / world.unitsKm, 0, 0], orientation: [0, 0, 0, 1],
    target: "earth", camera: "cockpit", assist: false, elapsed: 0,
  } });
  expect(response.ok()).toBe(true);
  await launch(page);
  await page.locator("#flight-resume").click();
  await page.getByRole("button", { name: "暂停航行", exact: true }).click();
  await expect(page.locator("#flight-ui")).toHaveAttribute("data-environment", "atmosphere");
  await expect(page.locator("#flight-engine")).toHaveText("近地轨道引擎 · 大气层");
  await expect(page.locator("#flight-jump")).toBeDisabled();
  await expect(page.locator("#warp-hint")).toContainText("1000 km 内禁止跃迁");
  await page.locator('button[data-body="mars"]').click();
  await page.keyboard.press("j");
  await expect(page.locator("#warp-engine")).toHaveAttribute("data-phase", "ready");
  await expect(page.locator("#flight-jump")).toBeDisabled();
  await page.locator("#flight-save").click();
  await expect(page.locator("#flight-storage")).toHaveText("已保存 · 服务端");
  const saved = await (await page.request.get("/api/flight/save")).json();
  expect(Math.hypot(...saved.state.velocity) * world.unitsKm).toBeLessThanOrEqual(100.00001);
  expect(saved.state.target).toBe("mars");
  await page.screenshot({ path: info.outputPath("atmosphere-restriction.png") });
});
