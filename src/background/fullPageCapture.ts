import { scrollStep } from './browserToolAdapter';

// Full-page capture: screenshot the viewport, scroll, repeat to the bottom.
// captureVisibleTab is viewport-only and rate-limited (~2/s), so this is a
// timed loop. Runs against the active tab of the current window.

const MAX_FRAMES_CEILING = 20;
const FRAME_WIDTH = 1280;
const STEP_DELAY_MS = 600;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

// Downscale a JPEG data URL to FRAME_WIDTH using OffscreenCanvas (worker-safe).
async function downscale(dataUrl: string): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width <= FRAME_WIDTH) return dataUrl;
  const scale = FRAME_WIDTH / bitmap.width;
  const canvas = new OffscreenCanvas(FRAME_WIDTH, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return blobToDataUrl(out);
}

export interface FullPageCapture {
  frames: string[];
  error?: string;
}

export async function captureFullPage(tabId: number, maxFrames = 12): Promise<FullPageCapture> {
  const cap = Math.min(MAX_FRAMES_CEILING, Math.max(1, maxFrames));
  const frames: string[] = [];
  let prev = '';
  for (let i = 0; i < cap; i++) {
    let shot: string;
    try {
      shot = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 80 });
    } catch (err) {
      if (frames.length === 0) {
        return { frames, error: `Could not capture this tab (${String(err)}). Browser-internal pages can't be captured.` };
      }
      break;
    }
    const scaled = await downscale(shot);
    // Identical frame ⇒ the last scroll changed nothing (bottom, or unscrollable).
    if (scaled === prev) break;
    frames.push(scaled);
    prev = scaled;

    let step: { scrolled: boolean; atBottom: boolean };
    try {
      step = await scrollStep(tabId);
    } catch {
      break; // can't scroll (e.g. content script blocked) — keep what we have
    }
    if (step.atBottom) break;
    await delay(STEP_DELAY_MS);
  }
  return { frames };
}
