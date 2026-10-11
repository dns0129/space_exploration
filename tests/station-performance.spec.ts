import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

test("舰内窗景裁剪保留完整画面，远处仪表停止重绘", async ({ page }, info) => {
  test.setTimeout(240000);
  await page.setViewportSize(info.project.name === "mobile" ? { width: 393, height: 700 } : { width: 960, height: 640 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/#planet=earth-station");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
  await page.locator("#quality").selectOption("standard", { force: true });
  await page.locator("#flight-quality").selectOption("standard", { force: true });
  await page.evaluate(async () => {
    const { SolarScene } = await import("/src/planet-scene.ts");
    const render = SolarScene.prototype["renderFlightWorld"];
    SolarScene.prototype["renderFlightWorld"] = function () {
      (window as any).stationPerformance = this;
      return render.call(this);
    };
  });
  await page.locator("#mode-flight").click();
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await expect.poll(() => page.evaluate(() => !!(window as any).stationPerformance)).toBe(true);
  await page.locator("#flight-land").click();
  await expect(page.locator("canvas")).toHaveAttribute("data-render-mode", "station");
  await page.locator("#flight-pause").click();
  const checkpoint = await page.evaluate(() => (window as any).stationPerformance.flightState());
  const results = [];
  for (const pose of [
    { name: "hangar", positionM: [0, 0, 24], yaw: 0, pitch: 0, camera: "first" },
    { name: "hangar-rear", positionM: [0, 0, 24], yaw: Math.PI, pitch: 0.3, camera: "third" },
    { name: "corridor", positionM: [0, 0, -2], yaw: 0, pitch: 0, camera: "first" },
    { name: "bridge", positionM: [5, 0, -24], yaw: 0, pitch: 0.2, camera: "third" },
    { name: "window", positionM: [26, 0, -2], yaw: -Math.PI / 2, pitch: 0, camera: "first" },
    { name: "helm", positionM: [0, 0, -36], yaw: 0, pitch: 0, camera: "first", piloting: true },
  ]) {
    const images = await page.evaluate(({ checkpoint, pose }) => {
      const app = (window as any).stationPerformance;
      if (!app.restoreFlight({ ...checkpoint, stationVisit: { ...checkpoint.stationVisit, piloting: false, ...pose } }))
        throw new Error("Invalid station pose");
      // Compare exactly the same physical resolution, orbital resources, clock
      // and camera; only the orbital scissor differs between the two pictures.
      app.renderer.setPixelRatio(0.5);
      const interior = app.stationInterior;
      const scissor = interior.windowScissor;
      const rectangle = scissor.call(interior, app.flightWidth, app.flightHeight);
      let full: string;
      try {
        interior.windowScissor = () => ({ x: 0, y: 0, width: app.flightWidth, height: app.flightHeight });
        app.renderFlightWorld();
        full = app.renderer.domElement.toDataURL("image/png");
      } finally { interior.windowScissor = scissor; }
      app.renderFlightWorld();
      const cropped = app.renderer.domElement.toDataURL("image/png");
      return { full, cropped, area: rectangle ? rectangle.width * rectangle.height / (app.flightWidth * app.flightHeight) : 0,
        scissorRestored: !app.renderer.getScissorTest() };
    }, { checkpoint, pose });
    const full = PNG.sync.read(Buffer.from(images.full.split(",")[1], "base64"));
    const cropped = PNG.sync.read(Buffer.from(images.cropped.split(",")[1], "base64"));
    let changed = 0, lit = 0;
    for (let i = 0; i < full.data.length; i += 4) {
      if (Math.max(...[0, 1, 2].map(channel => Math.abs(full.data[i + channel] - cropped.data[i + channel]))) > 3) changed++;
      if (Math.max(full.data[i], full.data[i + 1], full.data[i + 2]) > 35) lit++;
    }
    const pixels = full.width * full.height;
    expect(lit / pixels).toBeGreaterThan(0.1);
    expect(changed / pixels, `${pose.name}: window scissor must preserve actual WebGL pixels`).toBeLessThan(0.001);
    expect(images.scissorRestored).toBe(true);
    if (pose.name === "hangar" || pose.name === "corridor") expect(images.area).toBeLessThan(0.35);
    results.push({ name: pose.name, orbitalArea: images.area, changedPixels: changed });
  }
  const updates = await page.evaluate(checkpoint => {
    const app = (window as any).stationPerformance, interior = app.stationInterior;
    app.restoreFlight({ ...checkpoint, stationVisit: { ...checkpoint.stationVisit, positionM: [0, 0, 24], piloting: false } });
    const versions = () => interior.instruments.panels.map((panel: any) => panel.texture.version);
    const before = versions();
    app.dynamics.elapsed += 20;
    interior.updateInstruments(app.dynamics, app.flightControls.read(), performance.now() + 1000);
    const hidden = versions();
    interior.takeHelm();
    interior.updateInstruments(app.dynamics, app.flightControls.read(), performance.now() + 2000);
    return { before, hidden, visible: versions() };
  }, checkpoint);
  expect(updates.hidden).toEqual(updates.before);
  expect(updates.visible.every((version: number, index: number) => version > updates.hidden[index])).toBe(true);
  expect(errors).toEqual([]);
  await info.attach("station-window-pixels", { body: JSON.stringify({ results, updates }), contentType: "application/json" });
});
