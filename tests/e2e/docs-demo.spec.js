/**
 * GitHub Pages Demo E2E Tests
 *
 * Verifies that the static demo built into docs/ (npm run build:docs)
 * works when served as plain static files from a sub-path — exactly how
 * GitHub Pages project sites are served
 * (https://<user>.github.io/<repo>/ or a custom domain path):
 *   - main.min.js and the worker are loaded with relative URLs
 *   - model-path="./models/" and ort-path="./ort/" resolve against the
 *     sub-path and are served same-origin from the committed docs/models/
 *     and docs/ort/ directories
 *   - the demo makes ZERO cross-origin requests: no CDN, no Hugging Face
 *     hub, so CORS can never interfere
 *
 * The demo page itself is tested: live embedding, cosine similarity,
 * semantic search, and the persisted-markup display.
 */

import { test, expect } from '@playwright/test';
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

/** Static file server port (distinct from the dev-server E2E port 3737). */
const DOCS_PORT = 3838;
const BASE_URL = `http://127.0.0.1:${DOCS_PORT}`;

/** Timeout for wasm-model-dependent assertions (model load + first inference). */
const MODEL_TIMEOUT_MS = 30 * 1000;

/** Minimal MIME map for the static server. */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Resolve a URL path to a repo file.
 *
 * @param {string} urlPath - Decoded URL path (no query string)
 * @returns {string|null} Absolute file path, or null when not found
 */
function resolveRepoFile(urlPath) {
  let relative = decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (relative === '' || relative.endsWith('/')) {
    relative += 'index.html';
  }
  const candidate = path.join(repoRoot, relative);
  if (!candidate.startsWith(repoRoot) || !existsSync(candidate) || !statSync(candidate).isFile()) {
    return null;
  }
  return candidate;
}

/**
 * Origins allowed to receive cross-origin requests. Only the theme's
 * Google Fonts (cosmetic, loaded via CSS @import) — never the embedding
 * pipeline, which is fully self-hosted.
 *
 * @type {RegExp[]}
 */
const FONT_ORIGINS = [
  /^https:\/\/fonts\.googleapis\.com\//,
  /^https:\/\/fonts\.gstatic\.com\//,
];

/** @type {http.Server|null} Static server serving the repo root */
let server;

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, BASE_URL);
    const file = resolveRepoFile(url.pathname);
    if (file === null) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(file)] ?? 'application/octet-stream',
    });
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(DOCS_PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/**
 * Cross-origin requests attempted by the page during the current test.
 * The self-hosted demo must never make any; afterEach fails if it did.
 *
 * @type {string[]}
 */
let crossOriginRequests;

test.beforeEach(async ({ page }) => {
  crossOriginRequests = [];

  // Abort and record every request that leaves the test origin, except the
  // theme webfonts. Any pipeline hit here means an accidental dependency on
  // a CDN or the Hugging Face hub slipped back in.
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (new URL(url).origin !== BASE_URL && !FONT_ORIGINS.some((pattern) => pattern.test(url))) {
      crossOriginRequests.push(url);
      route.abort();
      return;
    }
    route.continue();
  });

  await page.goto(`${BASE_URL}/docs/?embedBackend=wasm`);
});

test.afterEach(async () => {
  expect(crossOriginRequests, 'demo must not make cross-origin requests').toEqual([]);
});

test.describe('GitHub Pages demo (docs/)', () => {
  test('embeds the live element when served from a sub-path', async ({ page }) => {
    // The live output reports dims + duration once the first embedding lands.
    await expect(page.locator('#live-output')).toContainText('384 dims', {
      timeout: MODEL_TIMEOUT_MS,
    });

    // Status line reports the (forced) wasm backend.
    await expect(page.locator('#status-backend')).toContainText('Model ready');
    await expect(page.locator('#status-backend')).toContainText('wasm');

    // The vector attribute holds a valid 384-dim normalized vector.
    const raw = await page.locator('#live-demo').getAttribute('vector');
    expect(raw).not.toBeNull();
    const vector = JSON.parse(raw);
    expect(vector).toHaveLength(384);
    const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
    expect(norm).toBeCloseTo(1, 3);

    // A successful embed marks the element as generated (persisted markup).
    expect(await page.locator('#live-demo').getAttribute('generated')).not.toBeNull();
    await expect(page.locator('#live-markup')).toContainText('generated');
  });

  test('re-embeds when the live element is edited', async ({ page }) => {
    await expect(page.locator('#live-output')).toContainText('384 dims', {
      timeout: MODEL_TIMEOUT_MS,
    });
    const previousVector = await page.locator('#live-demo').getAttribute('vector');

    await page.evaluate(() => {
      document.getElementById('live-demo').innerText = 'Quantum computers factor large integers efficiently.';
    });

    await expect(async () => {
      const raw = await page.locator('#live-demo').getAttribute('vector');
      expect(raw).not.toBeNull();
      expect(raw).not.toBe(previousVector);
    }).toPass({ timeout: MODEL_TIMEOUT_MS });

    await expect(page.locator('#live-output')).toContainText('384 dims');
  });

  test('shows a cosine similarity score for the two sentences', async ({ page }) => {
    await expect(page.locator('#sim-score')).toContainText(/^Similarity: 0\.\d{3}$/, {
      timeout: MODEL_TIMEOUT_MS,
    });

    const score = parseFloat((await page.locator('#sim-score').innerText()).split(':')[1]);
    // "A cat naps in the afternoon sun." vs "A kitten sleeps in the
    // sunshine." are near-paraphrases; MiniLM should score them well apart
    // from unrelated pairs.
    expect(score).toBeGreaterThan(0.3);
  });

  test('ranks the semantic search corpus by similarity', async ({ page }) => {
    // Wait for the corpus to be embedded before searching.
    await expect(page.locator('#sim-score')).toContainText(/Similarity:/, {
      timeout: MODEL_TIMEOUT_MS,
    });

    await page.fill('#query-input', 'kitten sleeping');
    await page.click('#search-button');

    const results = page.locator('#search-results li');
    await expect(results.first()).toContainText('A cat naps in the sun.', {
      timeout: MODEL_TIMEOUT_MS,
    });

    // Five ranked results, each carrying a numeric score.
    expect(await results.count()).toBe(5);
    const bestScore = parseFloat(await results.first().locator('.result-score').innerText());
    expect(bestScore).toBeGreaterThan(0);
  });
});
