/**
 * Vitest Configuration
 *
 * Unit test configuration for the generate-embedding package.
 *
 * For LLMs: Vitest runs the fast unit tests in tests/unit/. It is
 * deliberately scoped to that directory so it never picks up the
 * Playwright specs under tests/e2e/ (Playwright likewise ignores
 * tests/unit/ via testIgnore in playwright.config.js).
 *
 * Unit tests import modules from src/ directly. Worker-based code is
 * tested with explicit mocks: the worker's `self` global and the
 * `@huggingface/transformers` module are stubbed (see
 * tests/unit/embed-worker.test.js), and the main-thread client is tested
 * against a fake Worker global (see tests/unit/embeddings.test.js).
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Only run unit tests — never Playwright specs.
     */
    include: ['tests/unit/**/*.test.js'],

    /**
     * Unit tests run in Node. Browser APIs are stubbed per-test
     * (vi.stubGlobal) rather than pulling in a DOM emulation layer.
     */
    environment: 'node',
  },
});
