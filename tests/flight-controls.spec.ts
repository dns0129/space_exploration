import { test, expect } from "@playwright/test";

test("键盘激活按钮不会刹车，焦点转移后的按键仍能释放", async ({ page }) => {
  // Exercise real DOM keyboard defaults and the production input controller
  // without loading a GPU scene; these events must work on both devices.
  await page.route("**/__flight-controls", route => route.fulfill({
    contentType: "text/html",
    body: `<section id="flight-ui"><button id="action">操作</button></section><input id="speed" type="range"><canvas tabindex="0"></canvas>
      <script type="module">
        import { FlightControls } from "/src/flight-controls.ts";
        window.controls = new FlightControls(document.querySelector("canvas"));
        window.clicks = 0;
        const button = document.querySelector("button");
        button.onclick = () => window.clicks++;
        button.addEventListener("keyup", event => event.stopPropagation());
      </script>`,
  }));
  await page.goto("/__flight-controls");
  await page.waitForFunction(() => !!(window as any).controls);
  const input = () => page.evaluate(() => (window as any).controls.read());
  const button = page.locator("#action");
  await button.focus();
  await page.keyboard.down("Space");
  expect((await input()).brake).toBe(false);
  await page.keyboard.up("Space");
  expect(await page.evaluate(() => (window as any).clicks)).toBe(1);
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as any).clicks)).toBe(2);
  // Clicking a toolbar button must still allow letter-key flight controls.
  await page.keyboard.down("KeyW");
  expect((await input()).throttle).toBe(1);
  await page.keyboard.up("KeyW");
  expect((await input()).throttle).toBe(0);
  // Start braking in the scene, move focus to a disclosure, then release.
  await page.locator("canvas").focus();
  await page.keyboard.down("Space");
  expect((await input()).brake).toBe(true);
  await button.focus();
  await page.keyboard.up("Space");
  expect((await input()).brake).toBe(false);
  // Pointer clicks return to gameplay: the next Space is a brake/jump input.
  await button.click();
  expect(await button.evaluate(element => element === document.activeElement)).toBe(false);
  const clicks = await page.evaluate(() => (window as any).clicks);
  await page.keyboard.down("Space");
  expect((await input()).brake).toBe(true);
  await page.keyboard.up("Space");
  expect(await page.evaluate(() => (window as any).clicks)).toBe(clicks);
  await page.locator("#speed").focus();
  await page.keyboard.press("ArrowRight");
  expect((await input()).yaw).toBe(0);
  await page.evaluate(() => (window as any).controls.dispose());
  await page.locator("canvas").focus();
  await page.keyboard.press("KeyW");
  expect((await input()).throttle).toBe(0);
});
