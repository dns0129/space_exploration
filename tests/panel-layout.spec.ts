import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function assertNoOverlap(page: Page) {
  const problems = await page.evaluate(() => {
    const root = document.querySelector(".flight-mode") ? ".ui-workspace-flight" : ".ui-workspace-observe";
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const docks = [...document.querySelectorAll(`${root} .ui-dock`)].filter(visible);
    const header = document.querySelector(".header")!.getBoundingClientRect();
    const problems: string[] = [];
    const intersects = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    for (let i = 0; i < docks.length; i++) {
      const a = docks[i].getBoundingClientRect();
      if (a.left < 0 || a.right > innerWidth + 1 || a.top < 0 || a.bottom > innerHeight + 1)
        problems.push(`dock outside viewport: ${docks[i].className}`);
      if (intersects(a, header)) problems.push("dock covers main navigation");
      for (let j = i + 1; j < docks.length; j++)
        if (intersects(a, docks[j].getBoundingClientRect())) problems.push("docks overlap");
      const panels = [...docks[i].children].filter(visible);
      for (let j = 1; j < panels.length; j++)
        if (intersects(panels[j - 1].getBoundingClientRect(), panels[j].getBoundingClientRect()))
          problems.push(`panels overlap: ${(panels[j] as HTMLElement).dataset.panel}`);
    }
    if (document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight)
      problems.push("page overflow");
    return problems;
  });
  expect(problems).toEqual([]);
}

async function exercisePanels(page: Page, root: string) {
  const panels = page.locator(`${root} .ui-panel:visible`);
  const ids = await panels.evaluateAll(elements => elements.map(e => (e as HTMLElement).dataset.panel!));
  // Exercise the real disclosure handlers together, then check every resulting window.
  await panels.evaluateAll(elements => elements.forEach(e => {
    const toggle = e.querySelector<HTMLButtonElement>(":scope > .ui-panel-toggle")!;
    if (toggle.getAttribute("aria-expanded") === "true") toggle.click();
  }));
  const closed = await page.locator(root).evaluate((element, ids) => ids.map(id => {
    const panel = element.querySelector<HTMLElement>(`[data-panel="${id}"]`)!;
    return { id, height: panel.getBoundingClientRect().height,
      expanded: panel.querySelector(".ui-panel-toggle")!.getAttribute("aria-expanded"),
      inert: panel.querySelector<HTMLElement>(".ui-panel-body")!.inert };
  }), ids);
  for (const panel of closed) {
    expect(panel.height, panel.id).toBeLessThan(39);
    expect(panel.expanded, panel.id).toBe("false");
    expect(panel.inert, panel.id).toBe(true);
  }
  await assertNoOverlap(page);
  // A real keyboard activation must work without also issuing a flight command.
  const toggle = page.locator(`${root} [data-panel="${ids[0]}"] > .ui-panel-toggle`);
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await panels.evaluateAll(elements => elements.forEach(e => {
    const toggle = e.querySelector<HTMLButtonElement>(":scope > .ui-panel-toggle")!;
    if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
  }));
  await assertNoOverlap(page);
}

test("所有游戏窗口可收起，动画、窄屏和舰内布局互不遮挡", async ({ page }, info) => {
  test.setTimeout(300000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const mobile = info.project.name === "mobile";
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize(mobile ? { width: 393, height: 700 } : { width: 960, height: 640 });
  await page.goto("/#planet=earth-station");
  await expect(page.locator("#canvas-host")).toHaveAttribute("data-ready", "true");
  await page.locator("#quality").selectOption("standard", { force: true });
  await page.locator("#flight-quality").selectOption("standard", { force: true });
  await assertNoOverlap(page);
  await exercisePanels(page, ".ui-workspace-observe");
  // The transition is enabled normally, and honours reduced motion immediately.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await page.locator(".ui-panel-body").first().evaluate(e => getComputedStyle(e).transitionDuration)).toContain("0.28s");
  const settingsToggle = page.locator('[data-panel="settings"] > .ui-panel-toggle');
  await settingsToggle.click();
  await expect.poll(async () => (await page.locator('[data-panel="settings"]').boundingBox())!.height).toBeLessThan(39);
  await settingsToggle.click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: info.outputPath("observatory-panels.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#mode-flight").click();
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await page.locator("#flight-pause").click();
  await exercisePanels(page, ".ui-workspace-flight");
  if (mobile) {
    const thrust = page.locator('[data-flight-input="KeyW"]');
    const box = (await thrust.boundingBox())!;
    const touch = await page.context().newCDPSession(page);
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 0 }] });
    await expect(thrust).toHaveClass(/held/);
    await page.locator('[data-panel="touch"] > .ui-panel-toggle').evaluate((e: HTMLButtonElement) => e.click());
    await expect(thrust).not.toHaveClass(/held/);
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await touch.detach();
    await page.locator('[data-panel="touch"] > .ui-panel-toggle').click();
  }
  // Collapse several panels together; the engine and landing action stay independently usable.
  for (const id of ["bodies", "status", "warp", "surface"])
    await page.locator(`[data-panel="${id}"] > .ui-panel-toggle`).click();
  await page.locator("#flight-engine-slider").scrollIntoViewIfNeeded();
  await page.locator("#flight-engine-slider").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#flight-target-speed")).not.toHaveText("100");
  await assertNoOverlap(page);
  await page.screenshot({ path: info.outputPath("flight-panels.png") });
  await page.locator("#flight-pause").click();
  await page.locator("#flight-land").click();
  await expect(page.locator("#canvas-host canvas")).toHaveAttribute("data-exploration", "station");
  await page.locator("#flight-pause").click();
  await exercisePanels(page, ".ui-workspace-flight");
  await page.screenshot({ path: info.outputPath("station-panels.png") });
  for (const size of mobile ? [{ width: 320, height: 568 }, { width: 740, height: 393 }]
    : [{ width: 1440, height: 960 }, { width: 820, height: 560 }]) {
    await page.setViewportSize(size);
    await assertNoOverlap(page);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator(".ui-panel-body").first().evaluate(e => getComputedStyle(e).transitionDuration)).toBe("0s");
  // Photography still removes every panel and restores the same disclosure states.
  await page.locator("#photo-mode").click();
  await expect(page.locator(".ui-workspace:visible")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await assertNoOverlap(page);
  expect(errors).toEqual([]);
});
