/**
 * Generate Embedding Component E2E Tests
 *
 * End-to-end tests for <generate-embedding> against `demo.html`:
 *   - initial innerText is embedded into a 384-dim `vector` attribute
 *   - EMBEDDING-RESULT events fire with the vector
 *   - editing the text re-embeds (debounced)
 *   - removing the element terminates the embedding worker
 *
 * The suite forces the WASM backend (`?embedBackend=wasm`) so it does not
 * depend on headless WebGPU support. Model files are served locally from
 * models/ (downloaded by the package's postinstall script), so first-load
 * assertions still get generous timeouts for ORT wasm compilation.
 */

import { test, expect } from '@playwright/test';

/** Timeout for wasm-model-dependent assertions (model load + first inference). */
const MODEL_TIMEOUT_MS = 30 * 1000;

/**
 * Wait for the demo element to publish a fresh embedding.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string|null} [previousVector] - Wait until the attribute differs from this value
 * @returns {Promise<number[]>} The parsed 384-dim vector
 */
async function waitForVector(page, previousVector = null) {
  const element = page.locator('#generate_embedding');
  await expect(async () => {
    const raw = await element.getAttribute('vector');
    expect(raw).not.toBeNull();
    if (previousVector !== null) {
      expect(raw).not.toBe(previousVector);
    }
  }).toPass({ timeout: MODEL_TIMEOUT_MS });

  const raw = await element.getAttribute('vector');
  return JSON.parse(raw);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/demo.html?embedBackend=wasm');
});

test.describe('generate-embedding component', () => {
  test('embeds its initial innerText into the vector attribute', async ({ page }) => {
    const vector = await waitForVector(page);

    expect(vector).toHaveLength(384);
    expect(vector.every((n) => typeof n === 'number' && Number.isFinite(n))).toBe(true);

    // Vectors are L2-normalized: the norm must be ~1.
    const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
    expect(norm).toBeCloseTo(1, 3);

    // A successful embed marks the element as generated.
    expect(await page.locator('#generate_embedding').getAttribute('generated')).not.toBeNull();
  });

  test('emits EMBEDDING-RESULT with text, vector, and duration', async ({ page }) => {
    await waitForVector(page); // initial embed settled

    const result = await page.evaluate((timeoutMs) => new Promise((resolve, reject) => {
      const element = document.querySelector('#generate_embedding');
      element.addEventListener('EMBEDDING-RESULT', (event) => resolve(event.detail), { once: true });
      element.innerText = 'A brand new sentence to embed.';
      setTimeout(() => reject(new Error('EMBEDDING-RESULT never fired')), timeoutMs);
    }), MODEL_TIMEOUT_MS);

    expect(result.text).toBe('A brand new sentence to embed.');
    expect(result.vector).toHaveLength(384);
    expect(typeof result.duration).toBe('number');
  });

  test('re-embeds when innerText changes', async ({ page }) => {
    const first = await waitForVector(page);

    await page.evaluate(() => {
      document.querySelector('#generate_embedding').innerText = 'Completely different content about oranges.';
    });

    const second = await waitForVector(page, JSON.stringify(first));
    expect(second).toHaveLength(384);
    expect(second).not.toEqual(first);
  });

  test('skips re-embedding when the text is unchanged', async ({ page }) => {
    const first = await waitForVector(page);

    // Force a MutationObserver pass without changing the text content.
    await page.evaluate(() => {
      const element = document.querySelector('#generate_embedding');
      element.innerText = element.innerText;
    });

    // The debounce window plus slack: no new vector may appear.
    await page.waitForTimeout(1000);
    const raw = await page.locator('#generate_embedding').getAttribute('vector');
    expect(raw).toBe(JSON.stringify(first));
  });

  test('removing the element terminates the embedding worker', async ({ page }) => {
    await waitForVector(page);
    expect(await page.evaluate(() => window.embeddings.getActiveWorkerCount())).toBe(1);

    await page.evaluate(() => {
      document.querySelector('#generate_embedding').remove();
    });

    await expect(async () => {
      expect(await page.evaluate(() => window.embeddings.getActiveWorkerCount())).toBe(0);
    }).toPass({ timeout: 5000 });
  });

  test('a fresh element after removal re-acquires the worker and embeds', async ({ page }) => {
    await waitForVector(page);

    // Remove the demo element, then add a new one elsewhere in the page.
    await page.evaluate(() => {
      document.querySelector('#generate_embedding').remove();
    });
    await expect(async () => {
      expect(await page.evaluate(() => window.embeddings.getActiveWorkerCount())).toBe(0);
    }).toPass({ timeout: 5000 });

    await page.evaluate(() => {
      const element = document.createElement('generate-embedding');
      element.id = 'readded_embedding';
      element.textContent = 'Reincarnation works for custom elements too.';
      document.body.appendChild(element);
    });

    const readded = page.locator('#readded_embedding');
    await expect(async () => {
      const raw = await readded.getAttribute('vector');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw)).toHaveLength(384);
    }).toPass({ timeout: MODEL_TIMEOUT_MS });

    expect(await page.evaluate(() => window.embeddings.getActiveWorkerCount())).toBe(1);
  });
});

test.describe('generated attribute (persisted embeddings)', () => {
  /** A deterministic fake 384-dim vector standing in for a previously generated embedding. */
  const PERSISTED_VECTOR = Array.from({ length: 384 }, (_, i) => (i % 7) * 0.01 - 0.03);

  /**
   * Replace the demo element with one that carries generated + vector
   * attributes, simulating a page reload over persisted markup. Waits for
   * the demo element's worker to terminate first so worker counts in the
   * assertions are unambiguous.
   *
   * @param {import('@playwright/test').Page} page
   * @returns {Promise<void>}
   */
  async function mountPersistedElement(page) {
    await page.evaluate(() => {
      document.querySelector('#generate_embedding').remove();
    });
    await expect(async () => {
      expect(await page.evaluate(() => window.embeddings.getActiveWorkerCount())).toBe(0);
    }).toPass({ timeout: 5000 });

    await page.evaluate((vector) => {
      const element = document.createElement('generate-embedding');
      element.id = 'persisted_embedding';
      element.textContent = 'This text was embedded on a previous visit.';
      element.setAttribute('vector', JSON.stringify(vector));
      element.setAttribute('generated', '');
      document.body.appendChild(element);
    }, PERSISTED_VECTOR);
  }

  test('restores a persisted embedding without starting the worker', async ({ page }) => {
    await waitForVector(page);
    await mountPersistedElement(page);

    // The persisted vector is re-published as a cached EMBEDDING-RESULT.
    // (The element emitted it at connect; assert state directly.)
    const element = page.locator('#persisted_embedding');
    const raw = await element.getAttribute('vector');
    expect(JSON.parse(raw)).toEqual(PERSISTED_VECTOR);
    expect(await element.getAttribute('generated')).not.toBeNull();

    // No regeneration: the worker was never started for this element.
    await page.waitForTimeout(1000); // well past the debounce window
    expect(await page.evaluate(() => window.embeddings.getActiveWorkerCount())).toBe(0);
  });

  test('emits the restored embedding as EMBEDDING-RESULT with cached: true', async ({ page }) => {
    await waitForVector(page);
    await page.evaluate(() => {
      document.querySelector('#generate_embedding').remove();
    });
    await expect(async () => {
      expect(await page.evaluate(() => window.embeddings.getActiveWorkerCount())).toBe(0);
    }).toPass({ timeout: 5000 });

    // Attach the listener before the element connects, mirroring markup
    // that a host app renders on page load. (dataroom-js events do not
    // bubble, so the listener must live on the element itself.)
    const result = await page.evaluate((vector) => new Promise((resolve, reject) => {
      const element = document.createElement('generate-embedding');
      element.addEventListener('EMBEDDING-RESULT', (event) => resolve(event.detail), { once: true });
      element.textContent = 'This text was embedded on a previous visit.';
      element.setAttribute('vector', JSON.stringify(vector));
      element.setAttribute('generated', '');
      document.body.appendChild(element);
      setTimeout(() => reject(new Error('cached EMBEDDING-RESULT never fired')), 5000);
    }), PERSISTED_VECTOR);

    expect(result.cached).toBe(true);
    expect(result.vector).toEqual(PERSISTED_VECTOR);
    expect(await page.evaluate(() => window.embeddings.getActiveWorkerCount())).toBe(0);
  });

  test('ignores an invalid persisted vector and regenerates', async ({ page }) => {
    await waitForVector(page);
    await page.evaluate(() => {
      document.querySelector('#generate_embedding').remove();
    });
    await expect(async () => {
      expect(await page.evaluate(() => window.embeddings.getActiveWorkerCount())).toBe(0);
    }).toPass({ timeout: 5000 });

    await page.evaluate(() => {
      const element = document.createElement('generate-embedding');
      element.id = 'broken_embedding';
      element.textContent = 'Fresh text with a corrupt persisted vector.';
      element.setAttribute('vector', '[1, 2, 3]');
      element.setAttribute('generated', '');
      document.body.appendChild(element);
    });

    // The vector is invalid (3 dims), so the worker starts and a real
    // 384-dim embedding replaces it.
    const element = page.locator('#broken_embedding');
    await expect(async () => {
      const raw = await element.getAttribute('vector');
      expect(JSON.parse(raw)).toHaveLength(384);
    }).toPass({ timeout: MODEL_TIMEOUT_MS });
    expect(await page.evaluate(() => window.embeddings.getActiveWorkerCount())).toBe(1);
  });

  test('editing restored text clears generated and regenerates', async ({ page }) => {
    await waitForVector(page);
    await mountPersistedElement(page);

    await page.evaluate(() => {
      document.querySelector('#persisted_embedding').innerText = 'New content invalidates the persisted embedding.';
    });

    const element = page.locator('#persisted_embedding');
    await expect(async () => {
      const raw = await element.getAttribute('vector');
      const vector = JSON.parse(raw);
      expect(vector).toHaveLength(384);
      expect(vector).not.toEqual(PERSISTED_VECTOR);
      expect(await element.getAttribute('generated')).not.toBeNull();
    }).toPass({ timeout: MODEL_TIMEOUT_MS });

    expect(await page.evaluate(() => window.embeddings.getActiveWorkerCount())).toBe(1);
  });
});
