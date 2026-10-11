import { test, expect } from "@playwright/test";

test("参考星舰的实体几何、实时仪表与斜顶存档兼容", async ({ page }, info) => {
  test.setTimeout(360000);
  await page.setViewportSize(info.project.name === "mobile" ? { width: 393, height: 700 } : { width: 960, height: 640 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/#planet=earth-station");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
  await page.locator("#quality").selectOption("standard", { force: true });
  await page.locator("#flight-quality").selectOption("standard", { force: true });
  // Inspect the application's actual renderer; no production test API.
  await page.evaluate(async () => {
    const { SolarScene } = await import("/src/planet-scene.ts");
    const render = SolarScene.prototype["renderFlightWorld"];
    SolarScene.prototype["renderFlightWorld"] = function () {
      (window as any).referenceScene = this;
      return render.call(this);
    };
  });
  await page.screenshot({ path: info.outputPath("reference-exterior-observation.png") });
  await page.locator("#mode-flight").click();
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await page.locator("#flight-land").click();
  const canvas = page.locator("#canvas-host canvas");
  await expect(canvas).toHaveAttribute("data-station-zone", "停泊区");
  await page.locator("#flight-pause").click();
  const hull = await page.evaluate(() => {
    const group = (window as any).referenceScene.flightModelById.get("earth-station").group;
    let radius = 0, triangles = 0, maps = 0, meshes = 0;
    group.traverse((object: any) => {
      if (!object.isMesh) return;
      meshes++;
      const position = object.geometry.attributes.position;
      triangles += position.count / 3;
      for (let i = 0; i < position.count; i++) radius = Math.max(radius, Math.hypot(position.getX(i), position.getY(i), position.getZ(i)));
      if (object.material.map) maps++;
    });
    return { radius, triangles, maps, meshes };
  });
  expect(hull.radius).toBeLessThanOrEqual(1);
  expect(hull.triangles).toBeLessThan(220000);
  expect(hull.maps).toBe(0);
  expect(hull.meshes).toBeLessThanOrEqual(10);
  // The retired orbital marker cannot shadow the vessel that replaced it.
  expect(await page.evaluate(() => (window as any).referenceScene.flightLight.illumination)).toBeGreaterThan(0.99);
  const readouts = await page.evaluate(async () => {
    const scene = (window as any).referenceScene;
    (window as any).referenceCheckpoint = scene.flightState();
    (window as any).referenceText = [];
    for (const panel of scene.stationInterior.instruments.panels) {
      const draw = panel.context.fillText;
      panel.context.fillText = function (value: string, ...args: any[]) {
        (window as any).referenceText.push(value);
        return draw.call(this, value, ...args);
      };
    }
    // Non-zero velocity and a new target must reach the physical display faces,
    // even while paused and without changing the HTML HUD or driving the clock.
    const quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const restored = scene.restoreFlight({ ...(window as any).referenceCheckpoint,
      velocity: [73.2 / scene.dynamics.config.unitsKm, 0, 0], orientation: quaternion,
      target: "moon", assist: false,
      stationVisit: { ...(window as any).referenceCheckpoint.stationVisit,
        vessel: true, piloting: true, positionM: [0, 0, -36] } });
    return { restored, sizes: scene.stationInterior.instruments.panels.map((p: any) => [p.texture.image.width, p.texture.image.height]) };
  });
  expect(readouts.restored).toBe(true);
  expect(readouts.sizes).toEqual(Array(3).fill([2048, 1024]));
  await expect.poll(() => page.evaluate(() => (window as any).referenceText)).toContain("73.2");
  await expect.poll(() => page.evaluate(() => (window as any).referenceText)).toContain("MOON");
  await expect.poll(() => page.evaluate(() => (window as any).referenceText)).toContain("HEADING  270.0°");
  await expect(canvas).toHaveAttribute("data-surface-frame-idle", "true");
  const versions = await page.evaluate(() => (window as any).referenceScene.stationInterior.instruments.panels.map((p: any) => p.texture.version));
  await page.waitForTimeout(1100);
  expect(await page.evaluate(() => (window as any).referenceScene.stationInterior.instruments.panels.map((p: any) => p.texture.version))).toEqual(versions);
  await page.screenshot({ path: info.outputPath("reference-live-bridge.png") });
  await page.locator("#flight-camera").click();
  await expect(canvas).toHaveAttribute("data-render-mode", "space");
  await page.screenshot({ path: info.outputPath("reference-exterior-chase.png") });
  await page.locator("#flight-camera").click();
  // A formerly legal high jump save below the new swept canopy keeps its X/Z
  // coordinates and is brought below the roof, rather than respawning elsewhere.
  const oldPose = await page.evaluate(() => {
    const scene = (window as any).referenceScene;
    const restored = scene.restoreFlight({ ...(window as any).referenceCheckpoint,
      stationVisit: { ...(window as any).referenceCheckpoint.stationVisit,
        vessel: true, piloting: false, positionM: [7, 2.4, -39.5], yaw: 0, pitch: 0 } });
    return { restored, pose: scene.stationInterior.snapshot().positionM, eye: scene.stationInterior.camera.position.y };
  });
  expect(oldPose.restored).toBe(true);
  expect(oldPose.pose[0]).toBe(7);
  expect(oldPose.pose[2]).toBe(-39.5);
  expect(oldPose.pose[1]).toBeLessThan(2);
  expect(oldPose.eye).toBeLessThan(3.61);
  const night = await page.evaluate(() => {
    const scene = (window as any).referenceScene, bodies = scene.dynamics.config.bodies;
    const earth = bodies.find((body: any) => body.id === "earth");
    const sun = bodies.find((body: any) => body.id === "sun");
    const sunward = earth.position.map((n: number, i: number) => sun.position[i] - n);
    const length = Math.hypot(...sunward), radius = earth.radius + 2000 / scene.dynamics.config.unitsKm;
    const restored = scene.restoreFlight({ ...(window as any).referenceCheckpoint,
      referenceFrame: { kind: "system" }, position: earth.position.map((n: number, i: number) => n - sunward[i] / length * radius),
      stationVisit: { ...(window as any).referenceCheckpoint.stationVisit, vessel: true, piloting: true, positionM: [0, 0, -36] } });
    return { restored, illumination: scene.flightLight.illumination };
  });
  expect(night.restored).toBe(true);
  expect(night.illumination).toBe(0);
  expect(errors).toEqual([]);
  await info.attach("reference-geometry-and-readouts", { body: JSON.stringify({ hull, readouts, oldPose, night }), contentType: "application/json" });
});
