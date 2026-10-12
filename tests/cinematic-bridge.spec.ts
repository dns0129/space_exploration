import { test, expect } from "@playwright/test";
import * as THREE from "three";
import { PNG } from "pngjs";
import { writeFile } from "node:fs/promises";
import { world } from "../shared/flight-state.mjs";
import { Earthshine, bridgeEarthState } from "../src/bridge-lighting";

test("地球反照随距离及相位衰减，使用地球的受光而非观察者的遮光", () => {
  const earth = world.bodies.find(body => body.id === "earth")!;
  const sun = world.bodies.find(body => body.id === "sun")!;
  const moon = world.bodies.find(body => body.id === "moon")!;
  const config = { ...world, bodies: [{ ...earth, position: [0, 0, 0], radius: 1 },
    { ...sun, position: [0, 0, 100], radius: 1 }] };
  const model = new Earthshine();
  const full = model.sample(config, new THREE.Vector3(0, 0, 4))!;
  const distant = model.sample(config, new THREE.Vector3(0, 0, 8))!;
  const dark = model.sample(config, new THREE.Vector3(0, 0, -4))!;
  expect(full.irradiance).toBeGreaterThan(0);
  expect(distant.irradiance / full.irradiance).toBeCloseTo(0.25, 6);
  expect(dark.irradiance).toBeCloseTo(0, 8);
  expect(model.sample(config, new THREE.Vector3())).toBeUndefined();
  const eclipsed = { ...config, bodies: [...config.bodies,
    { ...moon, position: [0, 0, 10], radius: 0.2 }] };
  expect(model.sample(eclipsed, new THREE.Vector3(0, 0, 4))!.irradiance).toBe(0);
  // An observer-side blocker doesn't extinguish the illuminated planet.
  const observer = new THREE.Vector3(3, 0, 3);
  const blockedObserver = { ...config, bodies: [...config.bodies,
    { ...moon, position: [3, 0, 4], radius: 0.2 }] };
  expect(model.sample(blockedObserver, observer)!.irradiance).toBeGreaterThan(0);
});

test("地球舷窗样板渲染实际光照、保留原存档，退出摄影可继续驾驶", async ({ page }, info) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.setViewportSize(info.project.name === "mobile" ? { width: 393, height: 720 } : { width: 1280, height: 800 });
  const saved = { ...bridgeEarthState(world), target: "mars", elapsed: 123,
    stationVisit: { ...bridgeEarthState(world).stationVisit!, positionM: [0, 0, 24] } };
  const serialized = JSON.stringify(saved);
  await page.addInitScript(value => localStorage.setItem("voyager-flight-v1", value), serialized);
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify(route.request().url().endsWith("/world") ? world : null) }));
  await page.goto("/?scene=bridge-earth");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true", { timeout: 90000 });
  await expect(page.locator("body")).toHaveClass(/photo-mode/, { timeout: 90000 });
  const canvas = page.locator("#canvas-host canvas");
  await expect(canvas).toHaveAttribute("data-render-mode", "station");
  await expect(canvas).toHaveAttribute("data-surface-frame-idle", "true");
  expect(await page.evaluate(() => localStorage.getItem("voyager-flight-v1"))).toBe(serialized);
  await page.evaluate(async () => {
    const { SolarScene } = await import("/src/planet-scene.ts");
    const render = SolarScene.prototype["renderFlightWorld"];
    SolarScene.prototype["renderFlightWorld"] = function () {
      (window as any).cinematicScene = this;
      return render.call(this);
    };
  });
  await page.keyboard.press("p");
  await expect.poll(() => page.evaluate(() => !!(window as any).cinematicScene)).toBe(true);
  await page.keyboard.press("p");
  await expect(canvas).toHaveAttribute("data-surface-frame-idle", "true");
  const capture = await page.evaluate(() => {
    const app = (window as any).cinematicScene, interior = app.stationInterior;
    app.renderer.setPixelRatio(0.6);
    const shot = () => { app.renderFlightWorld(); return app.renderer.domElement.toDataURL("image/png"); };
    const lit = shot(), calls = Number(app.renderer.domElement.dataset.drawCalls);
    const target = app.hdr.target;
    const pixels = new Uint16Array(target.width * target.height * 4);
    app.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels);
    let invalid = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if ([0, 1, 2].some(channel => (pixels[i + channel] & 0x7c00) === 0x7c00)) invalid++;
    const windowVisible = interior.windowBounce.visible, consoleVisible = interior.consoleFill.visible;
    interior.windowBounce.visible = interior.consoleFill.visible = false;
    const unfilled = shot(), unfilledCalls = Number(app.renderer.domElement.dataset.drawCalls);
    interior.windowBounce.visible = windowVisible; interior.consoleFill.visible = consoleVisible;
    shot();
    return { lit, unfilled, calls, unfilledCalls, invalid, state: app.flightState(),
      exposure: app.renderer.toneMappingExposure, earthshine: Number(app.renderer.domElement.dataset.earthshine),
      cameraFov: interior.camera.fov, glError: app.renderer.getContext().getError() };
  });
  const lit = PNG.sync.read(Buffer.from(capture.lit.split(",")[1], "base64"));
  const unfilled = PNG.sync.read(Buffer.from(capture.unfilled.split(",")[1], "base64"));
  let worldPixels = 0, bouncePixels = 0, cabinPixels = 0;
  for (let y = 0; y < lit.height; y++) for (let x = 0; x < lit.width; x++) {
    const i = (y * lit.width + x) * 4;
    if (y < lit.height * 0.55 && lit.data[i + 2] > 50 && lit.data[i + 2] > lit.data[i] * 1.1) worldPixels++;
    if (y > lit.height * 0.5) {
      if (lit.data[i] + lit.data[i + 1] + lit.data[i + 2] > 70) cabinPixels++;
      if (lit.data[i + 1] + lit.data[i + 2] - unfilled.data[i + 1] - unfilled.data[i + 2] > 5) bouncePixels++;
    }
  }
  expect(capture.invalid, "HDR 和房间反射探针不得传播 NaN/Infinity").toBe(0);
  expect(capture.glError).toBe(0);
  expect(capture.earthshine).toBeGreaterThan(0.1);
  expect(worldPixels).toBeGreaterThan(lit.width * lit.height * 0.08);
  expect(cabinPixels).toBeGreaterThan(lit.width * lit.height * 0.03);
  expect(bouncePixels, "关闭实际窗边/仪表补光必须改变前景像素").toBeGreaterThan(100);
  expect(capture.calls).toBe(capture.unfilledCalls);
  expect(capture.exposure).toBe(1.1);
  expect(capture.cameraFov).toBe(58);
  expect(capture.state.velocity).toEqual([0, 0, 0]);
  await writeFile(info.outputPath(`bridge-earth-${info.project.name}.png`), Buffer.from(capture.lit.split(",")[1], "base64"));
  await info.attach("bridge-lighting-pixels", { body: JSON.stringify({ worldPixels, cabinPixels, bouncePixels,
    calls: capture.calls, invalid: capture.invalid, earthshine: capture.earthshine }), contentType: "application/json" });
  await page.keyboard.press("p");
  await expect(page.locator("body")).not.toHaveClass(/photo-mode/);
  expect(await page.evaluate(() => (window as any).cinematicScene.stationInterior.camera.fov)).toBe(68);
  await page.locator("#flight-pause").click();
  await page.locator("#starship-helm").click();
  await expect(canvas).toHaveAttribute("data-exploration", "starship");
  await page.keyboard.down("w");
  await expect.poll(() => page.evaluate(() => (window as any).cinematicScene.dynamics.velocity.length())).toBeGreaterThan(0.00000001);
  await page.keyboard.up("w");
  await page.locator("#flight-pause").click();
  await page.locator("#flight-resume").click();
  await expect.poll(() => page.evaluate(() => (window as any).cinematicScene.dynamics.target)).toBe("mars");
  expect(await page.evaluate(() => localStorage.getItem("voyager-flight-v1"))).toBe(serialized);
  expect(await page.evaluate(() => (window as any).cinematicScene.bridgeEarthShot)).toBe(false);
  const restored = await page.evaluate(() => (window as any).cinematicScene.flightState());
  await page.locator("#bridge-earth-shot").click();
  await expect(page.locator("body")).toHaveClass(/photo-mode/);
  await expect(canvas).toHaveAttribute("data-surface-frame-idle", "true");
  await page.keyboard.press("p");
  await expect.poll(() => page.evaluate(() => (window as any).cinematicScene.dynamics.target)).toBe("mars");
  const returned = await page.evaluate(() => (window as any).cinematicScene.flightState());
  expect(returned.position).toEqual(restored.position);
  returned.orientation.forEach((value: number, index: number) => expect(value).toBeCloseTo(restored.orientation[index], 12));
  expect(returned.stationVisit).toEqual(restored.stationVisit);
  expect(await page.evaluate(() => localStorage.getItem("voyager-flight-v1"))).toBe(serialized);
  await page.locator("#bridge-earth-shot").click();
  await expect(page.locator("body")).toHaveClass(/photo-mode/);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  expect(await page.evaluate(() => localStorage.getItem("voyager-flight-v1")), "关闭样板不能自动保存临时镜头").toBe(serialized);
  expect(errors).toEqual([]);
});
