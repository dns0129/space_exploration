import { test, expect } from "@playwright/test";
import * as THREE from "three";
import { sampleStellarLighting, stellarVisibility } from "../src/stellar-light";
import { RenderBudget } from "../src/render-budget";

test("双星按辐射贡献选择主光，独立遮光且接收点不自遮挡", () => {
  const near = { id: "alpha-centauri-b", kind: "star", radius: 0.5, position: [0, 0, -10] };
  const bright = { id: "alpha-centauri-a", kind: "star", radius: 4, position: [20, 0, -20] };
  const blocker = { id: "moon", kind: "planet", radius: 1, position: [0, 0, -5] };
  const samples = sampleStellarLighting([near, bright, blocker], new THREE.Vector3(), 6371);
  expect(samples[0].body.id).toBe(bright.id);
  expect(samples[0].visibility).toBe(1);
  expect(samples[1].visibility).toBe(0);
  expect(samples[1].energy).toBeGreaterThan(0);
  expect(stellarVisibility([near, blocker], new THREE.Vector3().fromArray(blocker.position), near, "moon")).toBe(1);
});

test("先降低效果成本，持续超预算才降低画布分辨率，静止恢复清晰度", () => {
  const budget = new RenderBudget();
  budget.configure("ultra", 1, 800, 600);
  let frames = 0;
  while (budget.effectLevel === 2 && frames++ < 180) budget.sample(0.03);
  expect(budget.effectLevel).toBe(1);
  expect(budget.ratio).toBe(1);
  for (let i = 0; i < 180; i++) budget.sample(0.03);
  expect(budget.effectLevel).toBe(0);
  expect(budget.ratio).toBeLessThan(1);
  budget.rest();
  expect(budget.ratio).toBe(1);
  expect(budget.effectLevel).toBe(2);
  budget.sample(0.9);
  budget.sample(0.9);
  budget.sample(0.9);
  expect(budget.effectLevel).toBe(1);
  expect(budget.ratio).toBe(1);
});

test("透明光在线性 HDR 中合成，再映射一次；浮点目标保留超过 1 的辐射", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/site.html");
  const result = await page.evaluate(async () => {
    const THREE = await import("/node_modules/.vite/deps/three.js");
    const { HdrPipeline } = await import("/src/hdr-pipeline.ts");
    const { lightingQuality } = await import("/src/lighting-quality.ts");
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(16, 16);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    const pipeline = new HdrPipeline(renderer);
    pipeline.configure(lightingQuality("standard"), true);
    const scene = new THREE.Scene(), camera = new THREE.Camera();
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = (rgb: number[], opacity = 1) => new THREE.ShaderMaterial({
      vertexShader: "void main(){ gl_Position=vec4(position.xy,0.0,1.0); }",
      fragmentShader: `void main(){gl_FragColor=vec4(${rgb.map(n => n.toFixed(5)).join(",")},${opacity.toFixed(5)});
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`, transparent: opacity < 1, depthTest: false, depthWrite: false,
    });
    const back = new THREE.Mesh(geometry, material([2.4, 0.2, 0.1]));
    const front = new THREE.Mesh(geometry, material([0.1, 0.3, 2.2], 0.5));
    scene.add(back, front);
    const pixel = () => {
      const bytes = new Uint8Array(4);
      renderer.getContext().readPixels(8, 8, 1, 1, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, bytes);
      return [...bytes];
    };
    pipeline.begin(); renderer.render(scene, camera);
    const linear = new Uint16Array(16 * 16 * 4);
    renderer.readRenderTargetPixels(pipeline.target, 0, 0, 16, 16, linear);
    const center = 4 * (8 * 16 + 8);
    const radiance = [0, 1, 2].map(channel => THREE.DataUtils.fromHalfFloat(linear[center + channel]));
    pipeline.finish(); const composited = pixel();
    scene.remove(front); const old = back.material;
    back.material = material([1.25, 0.25, 1.15]);
    pipeline.begin(); renderer.render(scene, camera); pipeline.finish(); const premixed = pixel();
    back.material.dispose(); back.material = old; scene.add(front);
    renderer.render(scene, camera); const displayBlended = pixel();
    const supported = pipeline.supported, glError = renderer.getContext().getError();
    back.material.dispose(); front.material.dispose(); geometry.dispose(); pipeline.dispose(); renderer.dispose();
    return { supported, radiance, composited, premixed, displayBlended, glError };
  });
  expect(errors).toEqual([]);
  expect(result.supported).toBe(true);
  expect(result.glError).toBe(0);
  expect(result.radiance[0]).toBeCloseTo(1.25, 2);
  expect(result.radiance[2]).toBeCloseTo(1.15, 2);
  expect(Math.max(...result.composited.map((value, i) => Math.abs(value - result.premixed[i])))).toBeLessThanOrEqual(1);
  expect(Math.max(...result.composited.map((value, i) => Math.abs(value - result.displayBlended[i])))).toBeGreaterThan(10);
});
