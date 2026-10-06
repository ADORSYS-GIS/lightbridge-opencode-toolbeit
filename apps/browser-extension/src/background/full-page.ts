import type { ScreenshotData } from "./executor";
import { runInPage } from "./page-actions";
import { tabsApi } from "../lib/browser-apis";

/**
 * Full-page screenshot for the content-script executor (Firefox / forced
 * `content`), where `tabs.captureVisibleTab` can only grab the viewport. We
 * scroll the page one viewport at a time, capture each slice, and stitch them
 * onto an `OffscreenCanvas` (available in both the Chrome MV3 service worker and
 * the Firefox background) — the CDP backend gets this natively via
 * `captureBeyondViewport`.
 *
 * Known limitation vs CDP: `position: fixed` elements repeat in every slice
 * (inherent to scroll-stitch). Pages taller than the canvas/​slice caps are
 * captured up to the cap and flagged `partial`.
 */

/** Page geometry read from the target tab. */
export interface PageMetrics {
  scrollX: number;
  scrollY: number;
  viewportW: number;
  viewportH: number;
  fullH: number;
  dpr: number;
}

export interface CapturePlan {
  /** Number of viewport slices to capture. */
  slices: number;
  /** Output canvas size, in device pixels. */
  canvasW: number;
  canvasH: number;
  /** CSS-pixel page height actually covered by the plan. */
  capturedCssHeight: number;
  /** True when the page is taller than the plan could cover. */
  partial: boolean;
}

export interface CaptureLimits {
  /** Hard cap on slices (bounds wall-clock against the rate limit). */
  maxSlices: number;
  /** Hard cap on canvas height in device px (browsers cap canvas dimensions). */
  maxDeviceHeight: number;
}

export const DEFAULT_LIMITS: CaptureLimits = { maxSlices: 20, maxDeviceHeight: 16_384 };

/**
 * Decide how many viewport slices to stitch and the resulting canvas size.
 * Pure and total — unit-tested. Bounded by both a slice count and a device-pixel
 * height budget; whichever is smaller wins, and the page is marked `partial` if
 * it exceeds what the plan covers.
 */
export function planFullPageCapture(metrics: PageMetrics, limits: CaptureLimits): CapturePlan {
  const dpr = metrics.dpr > 0 ? metrics.dpr : 1;
  const viewportH = Math.max(1, metrics.viewportH);
  const neededSlices = Math.max(1, Math.ceil(metrics.fullH / viewportH));
  const sliceDeviceH = viewportH * dpr;
  const slicesByHeight = Math.max(1, Math.floor(limits.maxDeviceHeight / sliceDeviceH));
  const slices = Math.min(neededSlices, limits.maxSlices, slicesByHeight);
  const capturedCssHeight = Math.min(metrics.fullH, slices * viewportH);
  return {
    slices,
    canvasW: Math.round(metrics.viewportW * dpr),
    canvasH: Math.round(capturedCssHeight * dpr),
    capturedCssHeight,
    partial: slices < neededSlices
  };
}

/** Encode raw bytes as base64 without blowing the call stack on large buffers. */
export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const CAPTURE_THROTTLE_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** captureVisibleTab, retrying through the per-second rate limit. */
async function captureThrottled(windowId: number): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await tabsApi().captureVisibleTab(windowId, { format: "png" });
    } catch (err) {
      if (/max_?capture|too many|rate/i.test(String(err))) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw new Error("captureVisibleTab was rate-limited");
}

async function dataUrlToBitmap(dataUrl: string): Promise<ImageBitmap> {
  const blob = await fetch(dataUrl).then((r) => r.blob());
  return createImageBitmap(blob);
}

/** Capture and stitch the full scrollable page. Restores the original scroll. */
export async function captureFullPage(
  tabId: number,
  windowId: number,
  limits: CaptureLimits = DEFAULT_LIMITS
): Promise<ScreenshotData> {
  const metrics = await runInPage(
    tabId,
    () => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      fullH: Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      ),
      dpr: window.devicePixelRatio || 1
    }),
    []
  );

  const plan = planFullPageCapture(metrics, limits);
  const canvas = new OffscreenCanvas(plan.canvasW, plan.canvasH);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("could not create an OffscreenCanvas context for full-page capture");
  }

  const dpr = metrics.dpr > 0 ? metrics.dpr : 1;
  try {
    for (let i = 0; i < plan.slices; i++) {
      // scrollTo clamps at the bottom — read back the actual position so the
      // final (overlapping) slice lands in the right place.
      const actualY = await runInPage(
        tabId,
        (y: number) => {
          window.scrollTo(0, y);
          return window.scrollY;
        },
        [i * metrics.viewportH]
      );
      await sleep(CAPTURE_THROTTLE_MS); // let it paint + stay under the capture rate limit
      const bitmap = await dataUrlToBitmap(await captureThrottled(windowId));
      ctx.drawImage(bitmap, 0, Math.round(actualY * dpr));
      bitmap.close();
    }
  } finally {
    await runInPage(tabId, (y: number) => window.scrollTo(0, y), [metrics.scrollY]).catch(() => {});
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const base64 = uint8ToBase64(new Uint8Array(await blob.arrayBuffer()));
  return { base64, width: plan.canvasW, height: plan.canvasH, partial: plan.partial };
}
