import { test, expect } from "@playwright/test";

test("左右跃迁在原侧减速入轨，镜头沿地平线，存档保留落点", async ({ page }, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const world = await (await page.request.get("/api/world")).json();
  const earth = world.bodies.find((body: any) => body.id === "earth");
  await page.request.get("/api/flight/save");
  for (const side of [-1, 1]) {
    if (side === 1) {
      await Promise.all([page.waitForResponse(response=>response.url().endsWith("/api/flight/save") && response.request().method()==="POST"),
        page.getByRole("button",{name:"行星观测",exact:true}).click()]);
      await expect(page.locator("#canvas-host")).toHaveAttribute("data-mode","observe");
    }
    await page.request.post("/api/flight/save", { data: {
      version: 2, systemId: "solar", position: [earth.position[0] + side * 15, 0, earth.position[2]],
      velocity: [0,0,0], orientation: [0,0,0,1], target: "earth", camera: "cockpit", assist: true, elapsed: 0,
    } });
    await page.goto("/");
    await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready","true");
    await page.getByRole("button",{name:"自由航行",exact:true}).click();
    await expect(page.locator("#canvas-host")).toHaveAttribute("data-mode","flight");
    await page.locator("#flight-quality").selectOption("standard");
    await expect(page.locator("canvas")).toHaveAttribute("data-ship-length-km","150");
    await page.locator("#flight-resume").click();
    await page.keyboard.press("j");
    await expect(page.locator("#warp-engine")).toHaveAttribute("data-phase", "arrival", { timeout: 40_000 });
    await expect(page.locator("#warp-engine")).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(page.locator("#flight-altitude")).toHaveText("1,100 km 高度");
    await expect(page.locator("#flight-marker")).toHaveClass(/offscreen/);
    await page.locator("#flight-save").click();
    await expect(page.locator("#flight-storage")).toHaveText("已保存 · 服务端");
    const { state } = await (await page.request.get("/api/flight/save")).json();
    expect((state.position[0] - earth.position[0]) * side).toBeGreaterThan(1.17);
    expect(Math.abs(state.position[2] - earth.position[2])).toBeLessThan(0.00001);
    await page.screenshot({ path: info.outputPath(`orbit-${side < 0 ? "left" : "right"}.png`) });
  }
  expect(errors).toEqual([]);
});
