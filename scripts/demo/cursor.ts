// Fake cursor overlay for the demo recording. Playwright's real mouse is
// invisible in captured video, so we draw one: a dot that glides to each
// target (CSS transition) and pulses a ripple on click. Installed per page;
// all interaction in scenes.ts goes through moveClick() so the viewer can
// follow the pointer.

import type { Locator, Page } from '@playwright/test';

const CURSOR_ID = '__demo_cursor';

export async function installCursor(page: Page): Promise<void> {
  await page.evaluate((id) => {
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.textContent = `
      #${id} {
        position: fixed; left: 0; top: 0; width: 22px; height: 22px;
        margin: -11px 0 0 -11px; border-radius: 50%;
        background: rgba(110, 42, 140, 0.85);
        box-shadow: 0 0 0 3px rgba(255,255,255,0.9), 0 2px 8px rgba(0,0,0,0.35);
        z-index: 2147483647; pointer-events: none;
        transition: transform 0.55s cubic-bezier(0.22, 0.61, 0.36, 1);
        transform: translate(640px, 400px);
      }
      #${id}.ripple::after {
        content: ''; position: absolute; inset: -6px; border-radius: 50%;
        border: 3px solid rgba(192, 36, 158, 0.9);
        animation: __demo_ripple 0.45s ease-out forwards;
      }
      @keyframes __demo_ripple {
        from { transform: scale(0.6); opacity: 1; }
        to { transform: scale(1.9); opacity: 0; }
      }`;
    document.head.appendChild(style);
    const dot = document.createElement('div');
    dot.id = id;
    document.body.appendChild(dot);
  }, CURSOR_ID);
}

async function glideTo(page: Page, x: number, y: number): Promise<void> {
  await installCursor(page); // survive in-page navigations
  await page.evaluate(
    ({ id, x, y }) => {
      const dot = document.getElementById(id);
      if (dot) dot.style.transform = `translate(${x}px, ${y}px)`;
    },
    { id: CURSOR_ID, x, y },
  );
  await page.waitForTimeout(620); // let the glide finish before acting
}

async function ripple(page: Page): Promise<void> {
  await page.evaluate((id) => {
    const dot = document.getElementById(id);
    if (!dot) return;
    dot.classList.remove('ripple');
    void (dot as HTMLElement).offsetWidth; // restart the animation
    dot.classList.add('ripple');
  }, CURSOR_ID);
}

/** Glide the fake cursor to the locator, pulse, then really click it. */
export async function moveClick(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box) await glideTo(page, box.x + box.width / 2, box.y + box.height / 2);
  await ripple(page);
  await page.waitForTimeout(180);
  await target.click();
}

/** Glide to a point without clicking (for "look here" moments). */
export async function moveTo(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box) await glideTo(page, box.x + box.width / 2, box.y + box.height / 2);
}
