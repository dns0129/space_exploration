import { test, expect } from '@playwright/test';
import { FrameLimiter, graphicsPreset, normalizeGraphics, textureWidth } from '../src/graphics-settings';
import { RenderBudget } from '../src/render-budget';

test('帧率上限稳定计时，30 FPS 不被画质预算当作持续掉帧', () => {
  const limiter = new FrameLimiter();
  let frames = 0;
  for (let i = 0; i < 360; i++) if (limiter.accepts(i * 1000 / 60, 30)) frames++;
  expect(frames).toBeGreaterThanOrEqual(179);
  expect(frames).toBeLessThanOrEqual(181);
  const graphics = { ...graphicsPreset('high'), maxFps: 30 as const };
  const budget = new RenderBudget();
  budget.configure('high', 1, 800, 600, .5, graphics);
  for (let i = 0; i < 300; i++) budget.sample(1 / 30);
  expect(budget.effectLevel).toBe(1);
  expect(budget.ratio).toBe(1);
});

test('失效设置回退，关闭自动调整保留所选分辨率', () => {
  const invalid = normalizeGraphics({ antialias: 64, renderScale: Infinity, maxFps: -1, textures: 'invalid' });
  expect(invalid).toEqual(graphicsPreset('high'));
  expect(textureWidth(graphicsPreset('ultra'), true)).toBe(4096);
  const settings = { ...graphicsPreset('high'), adaptive: false, renderScale: .75 };
  const budget = new RenderBudget(); budget.configure('high', 1, 800, 600, .5, settings);
  for (let i = 0; i < 300; i++) budget.sample(.1);
  expect(budget.ratio).toBe(.75);
  expect(budget.effectLevel).toBe(1);
});

test('实际地形 Worker 预生成网格，原点移动后仍与碰撞地表一致', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/site.html');
  const report = await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const { world } = await import('/shared/flight-state.mjs');
    const { prepareTerrainFields } = await import('/shared/terrain-fields.mjs');
    const { surfaceRadiusM } = await import('/shared/spatial-frame.mjs');
    const { initializeWalkingPhysics, WalkingPhysics } = await import('/src/walking-physics.ts');
    await prepareTerrainFields(['earth']); await initializeWalkingPhysics();
    const body = world.bodies.find((body: {id: string}) => body.id === 'earth');
    const up = new THREE.Vector3(0,0,-1);
    const radial = up.clone().multiplyScalar(surfaceRadiusM(world,body,up.toArray()));
    const physics = new WalkingPhysics(world,'earth');
    const wait = async (condition: () => boolean) => {
      const deadline = performance.now() + 15000;
      while (!condition()) { if (performance.now() > deadline) throw new Error('Worker did not prepare terrain'); await new Promise(resolve=>setTimeout(resolve,10)); }
    };
    try {
      physics.ensureTerrain(radial,radial,true);
      await wait(()=>physics.terrainWorkerState === 'ready');
      const first = physics.terrainPatch;
      const direction = first.right.clone();
      const approaching = radial.clone().addScaledVector(direction,10);
      const stayed = !physics.ensureTerrain(approaching,radial);
      const privatePhysics = physics as any;
      await wait(()=>!!privatePhysics.pendingBuild);
      const shift = direction.clone().multiplyScalar(12);
      physics.shiftOrigin(shift);
      const origin = radial.clone().add(shift);
      const crossing = radial.clone().addScaledVector(direction,17);
      const changed = physics.ensureTerrain(crossing,origin);
      const patch = physics.terrainPatch;
      let errorM = 0;
      for (const index of [0,1073,18224,37248]) {
        const point = new THREE.Vector3().fromArray(patch.vertices,index*3).add(origin);
        errorM = Math.max(errorM, Math.abs(point.length()-surfaceRadiusM(world,body,point.clone().normalize().toArray())));
      }
      return { stayed, changed, revision: patch.revision, errorM, triangles: patch.indices.length/3 };
    } finally { physics.dispose(); }
  });
  expect(report.stayed).toBe(true);
  expect(report.changed).toBe(true);
  expect(report.revision).toBe(3);
  expect(report.triangles).toBe(73728);
  expect(report.errorM).toBeLessThan(.02);
});

test('从半人马座首次航行打开地球镜头，先准备太阳系地形并保留原航行', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', '跨系统资源契约相同；手机布局由实时设置与网站验证覆盖');
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(settings => localStorage.setItem('voyager-graphics-v1',JSON.stringify(settings)),graphicsPreset('standard'));
  await page.goto('/?mode=flight#planet=proxima-b');
  await page.locator('#canvas-host[data-mode="flight"][data-ready="true"]').waitFor({ timeout:60000 });
  await page.locator('#loading-overlay').waitFor({state:'hidden'});
  await expect(page.locator('canvas')).toHaveAttribute('data-system','proxima-centauri');
  await page.locator('#bridge-earth-shot').click();
  await expect(page.locator('.observatory')).toHaveClass(/photo-mode/,{timeout:60000});
  await expect(page.locator('canvas')).toHaveAttribute('data-system','solar');
  await page.keyboard.press('Escape');
  await expect(page.locator('canvas')).toHaveAttribute('data-system','proxima-centauri');
  expect(errors).toEqual([]);
});

test('首屏只读取当前地形，普通航行不加载 Rapier，画质设置实时生效并持久保存', async ({ page }, info) => {
  test.setTimeout(300_000);
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => requests.push(request.url()));
  await page.goto("/#planet=earth");
  await page.locator('#canvas-host[data-ready="true"]').waitFor();
  await page.locator('#pause').click();
  expect(requests.filter(url => /\/terrain\/[^/]+\.json/.test(url))).toHaveLength(1);
  expect(requests.some(url => /rapier3d|assets\/rapier-/.test(url))).toBe(false);
  const canvas = page.locator('#canvas-host canvas');
  await page.getByRole('button', { name: '画质设置', exact: true }).first().click();
  await expect(page.locator('#graphics-dialog')).toBeVisible();
  await expect(page.getByLabel('垂直同步', { exact: true })).toBeDisabled();
  await page.locator('#graphics-preset').selectOption('standard');
  await expect(canvas).toHaveAttribute('data-texture-loading', 'false');
  await expect(canvas).toHaveAttribute('data-earth-maps', '2k');
  await expect(canvas).toHaveAttribute('data-antialias', '0');
  await page.locator('#graphics-maxFps').selectOption('30');
  await page.locator('#graphics-shadows').selectOption('off');
  await page.locator('#graphics-reflections').selectOption('off');
  await page.locator('#graphics-renderScale').fill('50');
  await page.locator('#graphics-adaptive').uncheck();
  await expect(canvas).toHaveAttribute('data-max-fps', '30');
  await expect(canvas).toHaveAttribute('data-shadows-enabled', 'false');
  await expect(canvas).toHaveAttribute('data-reflections', '0');
  await expect(page.locator('#graphics-preset')).toHaveValue('custom');
  await page.screenshot({ path: `test-results/graphics/settings-${info.project.name}.png` });
  // Keep the software test driver responsive during the following navigation.
  await page.locator('#graphics-adaptive').check();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '自由航行', exact: true }).click();
  await page.locator('#canvas-host[data-mode="flight"]').waitFor();
  await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
  expect(requests.some(url => /rapier3d|assets\/rapier-/.test(url))).toBe(false);
  const draws = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas')!;
    const first = Number(canvas.dataset.worldRenderCount);
    await new Promise(resolve => setTimeout(resolve, 1800));
    return Number(canvas.dataset.worldRenderCount) - first;
  });
  expect(draws).toBeGreaterThan(0);
  expect(draws).toBeLessThanOrEqual(57);
  await page.reload();
  await page.locator('#canvas-host[data-ready="true"]').waitFor();
  await expect(canvas).toHaveAttribute('data-max-fps', '30');
  await expect(canvas).toHaveAttribute('data-earth-maps', '2k');
  await page.getByRole('button', { name: '画质设置', exact: true }).first().click();
  await expect(page.locator('#graphics-reflections')).toHaveValue('off');
  await page.locator('#graphics-textures').selectOption('medium');
  await expect(canvas).toHaveAttribute('data-texture-loading', 'false');
  await expect(canvas).toHaveAttribute('data-earth-maps', '4k');
  await page.locator('#graphics-textures').selectOption('low');
  await page.locator('#graphics-textures').selectOption('medium');
  await expect(canvas).toHaveAttribute('data-texture-loading', 'false');
  await expect(canvas).toHaveAttribute('data-earth-maps', '4k');
  expect(errors).toEqual([]);
});
