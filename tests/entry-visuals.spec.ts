import { test, expect } from "@playwright/test";
import * as THREE from "three";
import { PNG } from "pngjs";

function skyPixels(image: PNG) {
  const sum = [0, 0, 0];
  let neutral = 0, samples = 0;
  for (let y = Math.floor(image.height * 0.16); y < image.height * 0.42; y++) {
    for (let x = Math.floor(image.width * 0.2); x < image.width * 0.8; x++) {
      const i = (y * image.width + x) * 4;
      const [r, g, b] = image.data.subarray(i, i + 3);
      sum[0] += r; sum[1] += g; sum[2] += b;
      // Bright nearly neutral cloud light is distinct from blue molecular scattering.
      if (r > 65 && g > 80 && b > 90 && r > g * 0.77 && g > b * 0.77) neutral++;
      samples++;
    }
  }
  return { average: sum.map(value => value / samples), cloud: neutral / samples };
}

test("穿入立体云层时云光实际出现、米级高度变化连续，夜面和月球保持暗空", async ({ page }, info) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const world = await (await page.request.get("/api/world")).json();
  let state: unknown;
  await page.route("**/api/flight/save", route => route.fulfill({ json: { state } }));
  await page.goto("/");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
  const results = new Map<string, ReturnType<typeof skyPixels>>();
  for (const [name, id, altitude, side] of [
    ["above-clouds", "earth", 16.2, 1],
    ["within-clouds", "earth", 10.6, 1],
    ["within-clouds-nearby", "earth", 10.62, 1],
    ["night-clouds", "earth", 10.6, -1],
    ["moon-vacuum", "moon", 10.6, 1],
  ] as const) {
    const body = world.bodies.find((body: any) => body.id === id);
    const up = new THREE.Vector3(0.45, 0, -Math.sqrt(1 - 0.45 ** 2)).multiplyScalar(side);
    const forward = new THREE.Vector3(-up.z, 0, up.x);
    const orientation = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(new THREE.Vector3(), forward, up),
    );
    state = { version: 2, systemId: "solar", position: new THREE.Vector3().fromArray(body.position)
      .addScaledVector(up, body.radius + altitude / world.unitsKm).toArray(), velocity: [0, 0, 0],
      orientation: orientation.toArray(), target: id, camera: "cockpit", assist: true, elapsed: 0 };
    if (results.size) await page.getByRole("button", { name: "行星观测", exact: true }).click();
    await page.getByRole("button", { name: "自由航行", exact: true }).click();
    await expect(page.locator("#loading-overlay")).toBeHidden();
    await page.locator("#flight-quality").selectOption("standard");
    await expect(page.locator("#flight-resume")).toBeEnabled();
    await page.locator("#flight-resume").click();
    await expect(page.locator("#flight-altitude")).toHaveText(`${Math.round(altitude)} km 高度`);
    const image = PNG.sync.read(await page.locator("canvas").screenshot({ style: ".flight-ui { visibility: hidden !important; }" }));
    results.set(name, skyPixels(image));
    await page.screenshot({ path: info.outputPath(`entry-${name}.png`) });
  }
  const within = results.get("within-clouds")!;
  expect(within.cloud - results.get("above-clouds")!.cloud, "进入云层后应出现明亮的立体云光").toBeGreaterThan(0.04);
  const nearby = results.get("within-clouds-nearby")!;
  expect(Math.max(...within.average.map((value, channel) => Math.abs(value - nearby.average[channel]))),
    "云层内改变20米高度不能跳变").toBeLessThan(8);
  expect(results.get("night-clouds")!.average[2], "夜面云层没有白昼光照").toBeLessThan(within.average[2] * 0.6);
  expect(results.get("moon-vacuum")!.average[2], "月球不产生地球体积云或蓝色天空").toBeLessThan(within.average[2] * 0.6);
  expect(errors).toEqual([]);
});
