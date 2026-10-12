import { test, expect } from "@playwright/test";

test("底图加载后的实际地表材质接收方向投影，光线变化移动阴影", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/site.html");
  const result = await page.evaluate(async () => {
    const THREE = await import("/node_modules/.vite/deps/three.js");
    const { SurfaceScene } = await import("/src/surface-scene.ts");
    const { ShipDynamics } = await import("/src/ship-dynamics.ts");
    const { world } = await import("/shared/flight-state.mjs");
    const { terrainHeightKm, LANDING_CLEARANCE_KM } = await import("/shared/surface.mjs");
    const { HdrPipeline } = await import("/src/hdr-pipeline.ts");
    const { lightingQuality } = await import("/src/lighting-quality.ts");
    const body = world.bodies.find((body: any) => body.id === "moon")!;
    const sun = world.bodies.find((body: any) => body.id === "sun")!;
    const up = new THREE.Vector3().fromArray(sun.position).sub(new THREE.Vector3().fromArray(body.position)).normalize();
    const tangent = new THREE.Vector3(0, 1, 0).cross(up).normalize();
    const altitude = terrainHeightKm("moon", up.toArray()) + LANDING_CLEARANCE_KM;
    const ship = new ShipDynamics(world);
    if (!ship.restore({ version: 2, worldLayoutVersion: world.layoutVersion, systemId: "solar", target: "moon",
      position: new THREE.Vector3().fromArray(body.position).addScaledVector(up, body.radius + altitude / world.unitsKm).toArray(),
      velocity: [0, 0, 0], orientation: [0, 0, 0, 1], camera: "chase", assist: true, elapsed: 0, landedBody: "moon" }))
      throw new Error("Invalid physical lunar checkpoint");
    const renderer = new THREE.WebGLRenderer({ logarithmicDepthBuffer: true, antialias: false });
    renderer.setSize(128, 128); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const hdr = new HdrPipeline(renderer); hdr.configure(lightingQuality("standard"), true);
    const surface = new SurfaceScene(); surface.configureLighting(lightingQuality("standard"));
    const map = new THREE.DataTexture(new Uint8Array([160, 110, 75, 255]), 1, 1);
    map.colorSpace = THREE.SRGBColorSpace; map.needsUpdate = true;
    surface.setHorizonMap("moon", map, new THREE.Matrix3());
    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 1e8);
    camera.position.copy(ship.localPositionM).addScaledVector(up, 7).addScaledVector(tangent, 11);
    camera.up.copy(up); camera.lookAt(ship.localPositionM);
    const sunlight = new THREE.PointLight(0xffffff, 2.5, 0, 0);
    sunlight.position.fromArray(sun.position).sub(ship.position);
    surface.update(ship, camera, sunlight);
    const scene = new THREE.Scene(); scene.add(surface.group);
    const caster = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 12), new THREE.MeshStandardMaterial({ color: 0x444444 }));
    caster.position.copy(ship.localPositionM).addScaledVector(up, 2); caster.castShadow = true; scene.add(caster);
    const light = (surface as any).light;
    light.castShadow = true; light.intensity = 3.4;
    const capture = () => {
      hdr.begin(); renderer.render(scene, camera); hdr.finish();
      const pixels = new Uint8Array(128 * 128 * 4);
      renderer.getContext().readPixels(0, 0, 128, 128, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const shadowed = capture(); caster.castShadow = false; const clear = capture();
    caster.castShadow = true;
    light.position.addScaledVector(tangent, 100); const moved = capture();
    let darkened = 0, changed = 0;
    for (let i = 0; i < clear.length; i += 4) {
      if (clear[i] + clear[i + 1] + clear[i + 2] - shadowed[i] - shadowed[i + 1] - shadowed[i + 2] > 12) darkened++;
      if (Math.max(...[0, 1, 2].map(channel => Math.abs(moved[i + channel] - shadowed[i + channel]))) > 8) changed++;
    }
    const glError = renderer.getContext().getError();
    surface.dispose(); map.dispose(); caster.geometry.dispose(); caster.material.dispose(); hdr.dispose(); renderer.dispose();
    return { darkened, changed, glError };
  });
  expect(errors).toEqual([]);
  expect(result.glError).toBe(0);
  expect(result.darkened, "Loaded photographic albedo must not overwrite the physical shadow").toBeGreaterThan(25);
  expect(result.changed).toBeGreaterThan(25);
});
