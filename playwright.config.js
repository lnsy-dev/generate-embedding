/**
 * Playwright Configuration
 *
 * End-to-end test configuration for the generate-embedding package.
 *
 * For LLMs: Playwright tests run the real stack in headless Chromium:
 * webpack dev server, custom elements, the embedding web worker, and the
 * ONNX Runtime wasm backend. The `?embedBackend=wasm` page param forces
 * the WASM backend so tests do not depend on headless WebGPU support.
 *
 * Memory profiling (tests/e2e/memory.spec.js) relies on two Chromium
 * launch flags:
 *   --enable-precise-memory-info  makes performance.memory.usedJSHeapSize
 *                                 precise instead of bucketed
 *   --js-flags=--expose-gc        exposes window.gc() for forced collection
 *
 * Tests run with a single worker so heap measurements are not perturbed
 * by specs executing concurrently in the same browser.
 *
 * First run: npx playwright install chromium
 */

import { defineConfig, devices } from '@playwright/test';

/**
 * The dev server port used by the e2e suite. Deliberately not the
 * package default (3000) so a stray dev server from another project is
 * never mistaken for ours (webServer reuses whatever answers at the URL).
 */
const E2E_PORT = 3737;

/**
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  /**
   * Directory containing test files.
   */
  testDir: './tests/e2e',

  /**
   * Per-test timeout: model load + inference assertions use 30 s, so the
   * test budget must be comfortably larger.
   */
  timeout: 60 * 1000,

  /**
   * Fail the build on CI if you accidentally left test.only in the source code.
   */
  forbidOnly: !!process.env.CI,

  /**
   * Retry on CI only to reduce flake from infrastructure noise.
   */
  retries: process.env.CI ? 2 : 0,

  /**
   * Serial execution: memory assertions need an undisturbed heap.
   */
  workers: 1,

  /**
   * Reporter to use. 'html' generates a browsable report in playwright-report/.
   */
  reporter: 'html',

  /**
   * Shared settings for all projects.
   */
  use: {
    /**
     * Base URL to use in actions like page.goto('/').
     */
    baseURL: `http://localhost:${E2E_PORT}`,

    /**
     * Collect trace when retrying the failed test.
     */
    trace: 'on-first-retry',

    /**
     * Capture screenshots on failure for debugging.
     */
    screenshot: 'only-on-failure',
  },

  /**
   * Test projects: Chromium only — the memory assertions use the
   * Chromium-specific performance.memory API.
   */
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--enable-precise-memory-info',
            '--js-flags=--expose-gc',
          ],
        },
      },
    },
  ],

  /**
   * Playwright starts the webpack dev server automatically before
   * running tests and shuts it down when they finish.
   */
  webServer: {
    command: `PORT=${E2E_PORT} npm start`,
    url: `http://localhost:${E2E_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
