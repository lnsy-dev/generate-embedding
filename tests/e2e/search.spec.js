/**
 * Tiny Semantic Search Engine E2E Tests
 *
 * End-to-end tests for the search demo on `index.html`.
 * Forces the WASM backend (`?embedBackend=wasm`) so it does not depend on
 * headless WebGPU support.
 */

import { test, expect } from '@playwright/test';

/** Timeout for wasm-model-dependent assertions (model load + first inference). */
const MODEL_TIMEOUT_MS = 30 * 1000;

test.beforeEach(async ({ page }) => {
  await page.goto('/?embedBackend=wasm');
});

test.describe('tiny semantic search engine', () => {
  test('returns ranked results for a query', async ({ page }) => {
    // Wait for the corpus elements to finish their initial embeddings.
    await expect(async () => {
      const vectors = await page.evaluate(() => {
        return [...document.querySelectorAll('#corpus generate-embedding')]
          .map((el) => el.getAttribute('vector'));
      });
      expect(vectors).toHaveLength(3);
      expect(vectors.every((v) => v !== null)).toBe(true);
    }).toPass({ timeout: MODEL_TIMEOUT_MS });

    // Type a query and run the search.
    await page.locator('#search-query').fill('kitten sleeping');
    await page.locator('#search-button').click();

    // Assert results render without an error and contain the expected corpus text.
    const results = page.locator('#search-results li');
    await expect(results.first()).toBeVisible();
    await expect(results).toHaveCount(3);

    const firstText = await results.first().textContent();
    expect(firstText).toContain('A cat naps in the sun.');

    // All scores should be present and sorted highest-first.
    const scores = await results.evaluateAll((items) =>
      items.map((item) => parseFloat(item.querySelector('strong')?.textContent ?? 'NaN')),
    );
    expect(scores).toHaveLength(3);
    expect(scores.every((n) => Number.isFinite(n))).toBe(true);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1]);
    expect(scores[1]).toBeGreaterThanOrEqual(scores[2]);
  });

  test('does not show a "Search failed" error', async ({ page }) => {
    await expect(async () => {
      const vectors = await page.evaluate(() => {
        return [...document.querySelectorAll('#corpus generate-embedding')]
          .map((el) => el.getAttribute('vector'));
      });
      expect(vectors.every((v) => v !== null)).toBe(true);
    }).toPass({ timeout: MODEL_TIMEOUT_MS });

    await page.locator('#search-query').fill('cat');
    await page.locator('#search-button').click();

    await expect(page.locator('#search-results li.error')).not.toBeVisible();
    await expect(page.locator('#search-results')).not.toContainText(/Search failed/i);
  });
});
