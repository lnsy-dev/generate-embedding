/**
 * Memory Profiling E2E Tests
 *
 * Verifies that repeatedly adding and removing <generate-embedding>
 * elements does not leak the embedding runtime: every removal must
 * terminate the web worker, and the JS heap (which in Chromium includes
 * WebAssembly memory — the ONNX Runtime arena and model weights) must
 * return to baseline after garbage collection.
 *
 * Method:
 *   1. Load the page with the demo element, wait for the first embedding
 *      (so any one-time module/class allocations are behind us).
 *   2. Remove the demo element, wait for the worker to terminate, force
 *      GC, and record the heap baseline.
 *   3. Cycle N times: append a fresh element, wait for its embedding,
 *      remove it, assert the worker count is back to 0, force GC.
 *   4. Assert the final heap is within a threshold of the baseline.
 *
 * The threshold (20 MB) is deliberately generous to avoid flake from
 * allocator noise, while still catching a leaked worker: a single leaked
 * ORT/wasm runtime holds tens of MB of wasm memory alone, and a leaked
 * model pipeline holds the ~23 MB quantized weights on top.
 *
 * Requires the Chromium launch flags configured in playwright.config.js
 * (--enable-precise-memory-info, --js-flags=--expose-gc).
 */

import { test, expect } from '@playwright/test';

/** Timeout for a single add/embed/remove cycle (model load + inference). */
const CYCLE_TIMEOUT_MS = 30 * 1000;

/** Number of add/remove cycles to profile. */
const CYCLES = 10;

/** Maximum allowed heap growth over baseline, in bytes. */
const HEAP_GROWTH_THRESHOLD_BYTES = 20 * 1024 * 1024;

/**
 * Force garbage collection and read the current JS heap size.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<number>} usedJSHeapSize in bytes
 */
async function measureHeap(page) {
  return page.evaluate(async () => {
    // Two GC passes: the first collects, the second collects objects
    // whose finalizers were scheduled by the first.
    window.gc();
    await new Promise((resolve) => setTimeout(resolve, 50));
    window.gc();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return performance.memory.usedJSHeapSize;
  });
}

/**
 * Read the number of live embedding workers.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<number>}
 */
function workerCount(page) {
  return page.evaluate(() => window.embeddings.getActiveWorkerCount());
}

/**
 * Append a <generate-embedding> element, wait for its vector attribute,
 * then remove it and wait for the worker to terminate.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} index - Cycle index (used to vary the text)
 * @returns {Promise<void>}
 */
async function addEmbedRemove(page, index) {
  await page.evaluate((i) => {
    const element = document.createElement('generate-embedding');
    element.id = `cycle_embedding_${i}`;
    element.textContent = `Memory profiling cycle ${i}: the embedding runtime must not leak.`;
    document.body.appendChild(element);
  }, index);

  const locator = page.locator(`#cycle_embedding_${index}`);
  await expect(async () => {
    const raw = await locator.getAttribute('vector');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw)).toHaveLength(384);
  }).toPass({ timeout: CYCLE_TIMEOUT_MS });

  await page.evaluate((i) => {
    document.querySelector(`#cycle_embedding_${i}`).remove();
  }, index);

  await expect(async () => {
    expect(await workerCount(page)).toBe(0);
  }).toPass({ timeout: 5000 });
}

test.describe('memory profiling', () => {
  test('adding and removing <generate-embedding> does not leak memory', async ({ page }) => {
    test.setTimeout(5 * 60 * 1000);

    await page.goto('/?embedBackend=wasm');

    // Warm-up: let the demo element complete its first embedding so
    // one-time allocations (module init, tokenizer caches) precede the
    // baseline measurement.
    await expect(async () => {
      const raw = await page.locator('#generate_embedding').getAttribute('vector');
      expect(raw).not.toBeNull();
    }).toPass({ timeout: CYCLE_TIMEOUT_MS });

    // Remove the demo element and confirm its worker is gone.
    await page.evaluate(() => {
      document.querySelector('#generate_embedding').remove();
    });
    await expect(async () => {
      expect(await workerCount(page)).toBe(0);
    }).toPass({ timeout: 5000 });

    const baseline = await measureHeap(page);

    const heapAfterCycles = [];
    for (let i = 0; i < CYCLES; i++) {
      await addEmbedRemove(page, i);
      heapAfterCycles.push(await measureHeap(page));
    }

    const finalHeap = heapAfterCycles[heapAfterCycles.length - 1];
    const growth = finalHeap - baseline;

    console.log(`[memory] baseline: ${(baseline / 1024 / 1024).toFixed(1)} MB`);
    heapAfterCycles.forEach((heap, i) => {
      console.log(`[memory] after cycle ${i + 1}: ${(heap / 1024 / 1024).toFixed(1)} MB`);
    });
    console.log(`[memory] growth over ${CYCLES} cycles: ${(growth / 1024 / 1024).toFixed(1)} MB`);

    expect(growth).toBeLessThan(HEAP_GROWTH_THRESHOLD_BYTES);
    expect(await workerCount(page)).toBe(0);
  });
});
