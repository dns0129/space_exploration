import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import * as THREE from "three";

function average(image: PNG) {
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = Math.floor(image.height * 0.2); y < image.height * 0.65; y++)
    for (let x = Math.floor(image.width * 0.25); x < image.width * 0.75; x++) {
      const index = (y * image.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) sum[channel] += image.data[index + channel];
      count++;
    }
  return sum.map(value => value / count);
}

test("100 km 大气可见、随高度连续变浓，越过边界不跳变，夜面与无大气卫星保留暗空", async ({ page }, info) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const world = await (await page.request.get("/api/world")).json();
  let state: any;
  await page.route("**/api/flight/save", route => route.fulfill({ json: { state } }));
  const images = new Map<string, number[]>();
  for (const [name, id, altitude, side, view] of [
    ["space", "earth", 500, -1, "outward"],
    ["edge-out", "earth", 160.1, -1, "outward"],
    ["edge-in", "earth", 159.9, -1, "outward"],
    ["entry", "earth", 100, -1, "outward"],
    ["low", "earth", 20, -1, "outward"],
    ["night", "earth", 100, 1, "outward"],
    ["moon", "moon", 20, -1, "outward"],
    ["horizon", "earth", 100, -1, "horizon"],
    ["entry-down", "earth", 100, -1, "down"],
  ] as const) {
    const body = world.bodies.find((body: any) => body.id === id);
    const up = new THREE.Vector3(0, 0, side);
    const forward = view === "horizon" ? new THREE.Vector3(1, 0, 0) : view === "down" ? up.clone().negate() : up;
    const cameraUp = view === "horizon" ? up : new THREE.Vector3(0, 1, 0);
    const orientation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), forward, cameraUp));
    state = { version: 2, systemId: "solar", position: new THREE.Vector3().fromArray(body.position)
      .addScaledVector(up, body.radius + altitude / world.unitsKm).toArray(), velocity: [0,0,0],
      orientation: orientation.toArray(), target: id, camera: "cockpit", assist: true, elapsed: 0 };
    if (!images.size) await page.goto("/");
    else await page.getByRole("button", { name: "行星观测", exact: true }).click();
    await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
    await page.getByRole("button", { name: "自由航行", exact: true }).click();
    await expect(page.locator("#loading-overlay")).toBeHidden();
    await page.locator("#flight-quality").selectOption("standard");
    await expect(page.locator("#flight-resume")).toBeEnabled();
    await page.locator("#flight-resume").click();
    await expect(page.locator("#flight-altitude")).toHaveText(`${altitude.toLocaleString("en-US", { maximumFractionDigits: 0 })} km 高度`);
    if (id === "earth" && altitude < 160) await expect(page.locator("#flight-ui")).toHaveAttribute("data-environment", "atmosphere");
    else await expect(page.locator("#flight-atmosphere")).toHaveText("真空环境 · 无大气阻力");
    const image = PNG.sync.read(await page.locator("canvas").screenshot({ style: ".flight-ui, .destination-selectors { visibility: hidden !important; }" }));
    images.set(name, average(image));
    await page.screenshot({ path: info.outputPath(`atmosphere-${name}.png`) });
    if (name === "entry" || name === "horizon" || name === "entry-down") {
      await page.locator("#flight-camera").click();
      await expect(page.locator("#flight-ui")).toHaveAttribute("data-environment", "atmosphere");
      const chase = PNG.sync.read(await page.locator("canvas").screenshot({ style: ".flight-ui, .destination-selectors { visibility: hidden !important; }" }));
      expect(average(chase)[2], "外部镜头在 100 km 仍应看到大气").toBeGreaterThan(35);
      await page.screenshot({ path: info.outputPath(`atmosphere-${name}-chase.png`) });
    }
  }
  const blue = (name: string) => images.get(name)![2];
  expect(blue("entry") - blue("space"), "100 km 时朝外的视野应有可见散射").toBeGreaterThan(25);
  expect(blue("low") - blue("entry"), "向下飞行时天空应逐渐变浓").toBeGreaterThan(25);
  expect(Math.abs(blue("edge-out") - blue("edge-in")), "大气边界两侧应连续").toBeLessThan(8);
  expect(blue("entry") - blue("night"), "夜面不能出现白昼的蓝天").toBeGreaterThan(25);
  expect(blue("low") - blue("moon"), "无大气天体不应产生蓝色天空").toBeGreaterThan(50);
  expect(images.get("entry-down")![1], "独立星球场景在100km俯视必须保留完整地表与云层，不能形成黑洞").toBeGreaterThan(35);
  expect(errors).toEqual([]);
});

test("俯冲时外部镜头保持飞船在画内，并以行星地平线稳定构图", async ({ page }, info) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const world = await (await page.request.get("/api/world")).json();
  const earth = world.bodies.find((body: any) => body.id === "earth");
  const state = { version: 2, systemId: "solar",
    position: [earth.position[0], earth.position[1], earth.position[2] - earth.radius - 100 / world.unitsKm],
    velocity: [0,0,0], orientation: [0,1,0,0], target: "earth", camera: "chase", assist: true, elapsed: 0 };
  await page.route("**/api/flight/save", route => route.fulfill({ json: { state } }));
  await page.goto("/");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "自由航行", exact: true }).click();
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await page.locator("#flight-quality").selectOption("standard");
  await expect(page.locator("#flight-resume")).toBeEnabled();
  await page.locator("#flight-resume").click();
  await expect(page.locator("#flight-altitude")).toHaveText("100 km 高度");
  await expect(page.locator("#flight-ui")).toHaveAttribute("data-environment", "atmosphere");
  const image = PNG.sync.read(await page.locator("canvas").screenshot({ style: ".flight-ui, .destination-selectors { visibility: hidden !important; }" }));
  let trim = 0;
  for (let y = Math.floor(image.height * 0.2); y < image.height * 0.8; y++)
    for (let x = Math.floor(image.width * 0.25); x < image.width * 0.75; x++) {
      const i = (y * image.width + x) * 4;
      const [r,g,b] = image.data.subarray(i, i + 3);
      if (r > 35 && r > g * 1.25 && g > b * 1.25) trim++;
    }
  await page.screenshot({ path: info.outputPath("earth-atmospheric-dive.png") });
  expect(trim, "俯冲镜头应保留飞船的棕色装甲，而非把船移到视野外").toBeGreaterThan(3);
  expect(errors).toEqual([]);
});
