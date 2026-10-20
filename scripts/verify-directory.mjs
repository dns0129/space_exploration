import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { createVoyagerServer } from '../dist-directory/server/server.mjs';
import { world } from '../dist-directory/shared/flight-state.mjs';
import { terrainHeightKm, LANDING_CLEARANCE_KM, TERRAIN_VERSION } from '../dist-directory/shared/surface.mjs';

const dataDir = await mkdtemp(join(tmpdir(),'voyager-directory-'));
const server = createVoyagerServer({ staticRoot: resolve('dist-directory/game'), dataDir });
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-compositing'] });
const errors = [], external = [], requests = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror',error => errors.push(error.message));
  page.on('console',message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request',request => requests.push(request.url()));
  await page.route('**/*',route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && !url.startsWith(origin + '/')) { external.push(url); return route.abort(); }
    return route.continue();
  });
  await page.goto(origin + '/#planet=earth');
  await page.locator('#canvas-host[data-ready="true"]').waitFor({ timeout: 60000 });
  assert.equal(requests.filter(url=>url.includes('/terrain/')).length,1);
  assert(!requests.some(url=>/\/rapier-[^/]+\.js/.test(url)));
  await page.locator('#quality').selectOption('standard');
  await expect(page.locator('canvas')).toHaveAttribute('data-earth-maps','2k',{timeout:60000});
  await page.getByRole('button',{name:'自由航行',exact:true}).click();
  await page.locator('#canvas-host[data-mode="flight"]').waitFor({timeout:60000});
  await page.locator('#loading-overlay').waitFor({state:'hidden',timeout:60000});
  await expect(page.locator('#flight-storage')).toHaveText('服务端存档');
  assert(!requests.some(url=>/\/rapier-[^/]+\.js/.test(url)));
  await page.locator('#flight-save').click();
  await expect(page.locator('#flight-storage')).toHaveText('已保存 · 服务端');
  const beforeExit = await (await page.request.get(origin+'/api/flight/save')).json();
  await page.locator("#mode-observe").click().then(() => page.locator("#map-observe").click());
  await page.locator('#canvas-host[data-mode="observe"]').waitFor();
  await expect.poll(async()=> (await (await page.request.get(origin+'/api/flight/save')).json()).savedAt).not.toBe(beforeExit.savedAt);
  const earth = world.bodies.find(body=>body.id === 'earth');
  const landed = { version: 2, worldLayoutVersion: world.layoutVersion, terrainVersion: TERRAIN_VERSION,
    systemId: 'solar', target: 'earth', landedBody: 'earth',
    position: [earth.position[0], earth.position[1], earth.position[2] - earth.radius - (terrainHeightKm('earth',[0,0,-1]) + LANDING_CLEARANCE_KM)/world.unitsKm],
    velocity:[0,0,0], orientation:[0,0,0,1], camera:'cockpit', assist:true, elapsed:0 };
  const response = await page.request.post(origin+'/api/flight/save',{data:landed});
  assert.equal(response.status(),200);
  await page.goto(origin+'/?mode=flight');
  await page.locator('#canvas-host[data-ready="true"][data-mode="flight"]').waitFor({timeout:60000});
  await expect(page.locator('#flight-resume')).toBeEnabled({timeout:60000});
  await page.locator('#flight-resume').click();
  await expect(page.locator('#flight-ui')).toHaveAttribute('data-landed','true',{timeout:60000});
  await page.locator('#flight-exit').click();
  await expect(page.locator('#flight-ui')).toHaveAttribute('data-exploration','walking',{timeout:60000});
  await expect(page.locator('canvas')).toHaveAttribute('data-physics-engine','rapier');
  await page.locator('#flight-save').click();
  await expect(page.locator('#flight-storage')).toHaveText('已保存 · 服务端');
  const checkpoint = await (await page.request.get(origin+'/api/flight/save')).json();
  assert.equal(checkpoint.state.walking.bodyId,'earth');
  await page.reload();
  await expect(page.locator('#flight-resume')).toBeEnabled({timeout:60000});
  await page.locator('#flight-resume').click();
  await expect(page.locator('#flight-ui')).toHaveAttribute('data-exploration','walking',{timeout:60000});
  assert(requests.some(url=>/\/rapier-[^/]+\.js/.test(url)),'First surface walking must load the separate Rapier module');
  assert.deepEqual(external,[]); assert.deepEqual(errors,[]);
  await mkdir('test-results/directory',{recursive:true});
  await writeFile('test-results/directory/verification.json',JSON.stringify({ external, errors, requests, result:'passed' },null,2)+'\n');
  console.log('PASS resource-directory package: local assets only, lazy terrain and Rapier, server saves and surface walking/restoration.');
} finally {
  await browser.close(); await new Promise(resolve=>server.close(resolve)); await rm(dataDir,{recursive:true,force:true});
}
